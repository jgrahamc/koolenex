/**
 * Coverage harness (analysis tool, not shipped in the request path).
 *
 * For every distinct application program in the imported project, builds the
 * full download artifacts exactly the way `buildDeviceProgramming` does, then
 * classifies which read-back verification mechanism proves the device is
 * theoretically programmable:
 *
 *   - relmem : legacy WriteRelMem path — verify reads paramMem at each offset.
 *   - absmem : AbsSegment (planDownload) path — verify reads each memWrite op.
 *   - prop   : property-only (CompareProp/WriteProp) — no memory image; verify
 *              must read interface-object properties.
 *
 * "Theoretically programmable" = the pipeline produces a concrete set of
 * expected bytes at concrete addresses/props that a read-back can diff.
 *
 * Run: NODE_OPTIONS="--experimental-strip-types --experimental-transform-types --no-warnings" node server/coverage-report.ts
 */
import path from 'path';
import fs from 'fs';
import * as db from './db.ts';
import {
  buildGATable,
  buildAssocTable,
  resolveParamSegment,
  buildParamMem,
} from './routes/knx-tables.ts';
import { planVerify } from './knx-download-plan.ts';
import type { PlanStep } from './knx-download-plan.ts';
import type { Device, GroupAddress } from '../shared/types.ts';

const APPS_DIR = path.join(process.cwd(), 'data', 'apps');

interface ComObject {
  object_number: number;
  ga_address: string;
}

interface Model {
  appId?: string;
  loadProcedures?: Array<Record<string, unknown>>;
  paramMemLayout?: Record<string, unknown>;
  dynTree?: unknown;
  params?: Record<string, unknown>;
  /**
   * ParamModel.paramRefValues - the declared value of every ParameterRef,
   * needed to evaluate <choose> elements controlled by a parameter that
   * has no memory and no UI presence. Optional: app models cached before
   * 2026-09-12 don't carry it.
   */
  paramRefValues?: Record<string, string>;
  absSegData?: Record<number, { size: number; hex?: string | null }>;
}

interface Region {
  what: string;
  addr?: number;
  len: number;
}

interface Row {
  app: string;
  devices: number;
  family: 'relmem' | 'abmem' | 'prop' | 'unknown';
  ok: boolean;
  regions: Region[];
  note: string;
}

function buildFor(dev: Device): Row {
  const app = dev.app_ref || '(none)';
  const row: Row = {
    app,
    devices: 0,
    family: 'unknown',
    ok: false,
    regions: [],
    note: '',
  };
  const safe = app.replace(/[^a-zA-Z0-9_-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath)) {
    row.note = 'model file missing';
    return row;
  }
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as Model;
  const lps = model.loadProcedures ?? [];
  if (!lps.length) {
    row.note = 'no loadProcedures';
    return row;
  }

  // GA + association tables
  const coRows = db.all<ComObject>(
    'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
    [dev.id],
  );
  const used = new Set<string>();
  for (const co of coRows)
    for (const a of (co.ga_address || '').split(/\s+/).filter(Boolean))
      used.add(a);
  const gaLinks =
    used.size > 0
      ? db.all<GroupAddress>(
          `SELECT address, main_g, middle_g, sub_g FROM group_addresses WHERE project_id=? AND address IN (${[...used].map(() => '?').join(',')}) ORDER BY main_g, middle_g, sub_g`,
          [dev.project_id, ...used],
        )
      : [];
  const gaTable = buildGATable(gaLinks);
  const assocTable = buildAssocTable(coRows, gaLinks);

  const { paramSize, paramFill, relSegHex, paramBase } = resolveParamSegment(
    model as Parameters<typeof resolveParamSegment>[0],
  );
  let paramMem: Buffer | null = null;
  if (paramSize > 0 && model.paramMemLayout) {
    let vals: Record<string, unknown> = {};
    try {
      vals = JSON.parse(dev.param_values || '{}') as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    paramMem = buildParamMem(
      paramSize,
      model.paramMemLayout as Parameters<typeof buildParamMem>[1],
      vals,
      paramFill,
      relSegHex,
      model.dynTree as Parameters<typeof buildParamMem>[5],
      model.params as Parameters<typeof buildParamMem>[6],
      model.paramRefValues as Parameters<typeof buildParamMem>[7],
    );
  } else if (paramSize > 0) {
    paramMem = Buffer.alloc(paramSize, 0xff);
  }

  const steps = lps.map((s) => ({
    ...s,
    data: s.data ? Buffer.from(s.data as string, 'hex') : undefined,
  })) as PlanStep[];

  // Classify via the SAME planVerify the /bus/verify-device endpoint uses, so
  // this report is an authoritative statement of read-back verifiability.
  const plan = planVerify(
    steps,
    gaTable,
    assocTable,
    paramMem,
    paramBase,
    model.absSegData ?? {},
    model.appId ?? app,
  );

  if (plan.family === 'absmem') {
    row.family = 'abmem';
    for (const r of plan.mem)
      row.regions.push({ what: r.label, addr: r.addr, len: r.expected.length });
    row.ok = plan.mem.length > 0;
    row.note = `${plan.mem.length} memWrite regions read-back`;
    return row;
  }
  if (plan.family === 'relmem') {
    row.family = 'relmem';
    for (const r of plan.mem)
      row.regions.push({ what: r.label, addr: r.addr, len: r.expected.length });
    row.ok = plan.mem.length > 0;
    row.note = `${plan.mem.length} WriteRelMem segment(s), paramMem ${paramMem?.length ?? 0}B`;
    return row;
  }
  if (plan.family === 'prop') {
    row.family = 'prop';
    for (const p of plan.props)
      row.regions.push({ what: p.label, len: p.expected.length });
    row.ok = plan.props.length > 0;
    row.note = `${plan.props.length} identity prop(s) — no memory image, verify by property read`;
    return row;
  }

  row.family = 'unknown';
  row.note = 'planVerify produced no verifiable regions';
  row.ok = false;
  return row;
}

async function main(): Promise<void> {
  await db.init();
  const devs = db.all<Device>(
    'SELECT * FROM devices WHERE app_ref IS NOT NULL ORDER BY app_ref',
  );
  const byApp = new Map<string, Device[]>();
  for (const d of devs) {
    const k = d.app_ref || '(none)';
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k)!.push(d);
  }

  const rows: Row[] = [];
  for (const [app, list] of byApp) {
    const r = buildFor(list[0]!);
    r.devices = list.length;
    r.app = app;
    rows.push(r);
  }

  rows.sort((a, b) => b.devices - a.devices);

  const fam = { relmem: 0, abmem: 0, prop: 0, unknown: 0 };
  let devOk = 0;
  const totalDev = rows.reduce((n, r) => n + r.devices, 0);
  console.log(
    '\n=== KOOLENEX THEORETICAL-PROGRAMMABILITY COVERAGE ===============\n',
  );
  for (const r of rows) {
    fam[r.family] += r.devices;
    if (r.ok) devOk += r.devices;
    const status = r.ok ? 'OK ' : 'XX ';
    console.log(
      `${status} ${r.app.padEnd(30)} x${String(r.devices).padStart(2)}  ${r.family.padEnd(7)} ${r.note}`,
    );
    for (const reg of r.regions.slice(0, 8))
      console.log(`        ${reg.what.padEnd(20)} len=${reg.len}`);
    if (r.regions.length > 8)
      console.log(`        ... +${r.regions.length - 8} more regions`);
  }
  console.log('\n----------------------------------------------------------');
  console.log(
    `Apps: ${rows.length}   Devices: ${totalDev}   Programmable (verifiable): ${devOk}/${totalDev}`,
  );
  console.log(
    `By family (devices): relmem=${fam.relmem} abmem=${fam.abmem} prop=${fam.prop} unknown=${fam.unknown}`,
  );
  console.log('==========================================================\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
