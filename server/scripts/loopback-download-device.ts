/**
 * Drives a real Full Download for any device in the currently-loaded
 * project through the REAL `downloadDevice()` orchestration over
 * `KnxLoopbackConnection`, dumping the full frame log to `scratch/` for
 * manual inspection or diffing against a real capture. Nothing goes to a
 * physical device.
 *
 * Run:
 *   node server/scripts/loopback-download-device.ts \
 *     --project 23 --addr 1.1.10 --mask 0x07b0 --manufacturer 0x0004 \
 *     --ga-base 0xf000 --assoc-base 0xc0000 --obj3-base 0xc2000 --param-base 0xc3000
 *
 * All table-base addresses must be passed explicitly and are meant to come
 * from a real capture of this device/app (PropValueResp OX=N P=7) - this
 * script deliberately does not guess or default them, so a missing
 * --*-base surfaces as a real "unallocated, skipping write" log line rather
 * than a silently wrong address.
 */
import * as db from '../db.ts';
import { _buildDeviceProgramming } from '../routes/bus.ts';
import { KnxLoopbackConnection, delay } from '../knx-loopback-connection.ts';
import {
  parseProgramVersionFromAppId,
  programVersionToBuffer,
} from '../knx-connection.ts';
import type { Device } from '../../shared/types.ts';
import fs from 'fs';
import path from 'path';

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function argHex(name: string): number | undefined {
  const v = argVal(name);
  return v ? parseInt(v, 16) : undefined;
}

async function main() {
  await db.init();

  const PROJECT_ID = Number(argVal('project'));
  const ADDR = argVal('addr');
  const mask = argHex('mask') ?? 0x07b0;
  const manufacturerId = argHex('manufacturer') ?? 0x0004;
  const gaBase = argHex('ga-base');
  const assocBase = argHex('assoc-base');
  const obj3Base = argHex('obj3-base');
  const paramBaseArg = argHex('param-base');

  if (!PROJECT_ID || !ADDR) {
    console.error(
      'Usage: --project <id> --addr <individual address> [--mask 0x..] [--manufacturer 0x..] [--ga-base 0x..] [--assoc-base 0x..] [--obj3-base 0x..] [--param-base 0x..]',
    );
    process.exit(1);
  }

  const dev = db.get<Device>(
    'SELECT * FROM devices WHERE project_id=? AND individual_address=?',
    [PROJECT_ID, ADDR],
  );
  if (!dev)
    throw new Error(`Device ${ADDR} not found in project ${PROJECT_ID}`);

  console.log(
    `Device: ${dev.name} (${dev.individual_address}), app ${dev.app_ref}, serial ${dev.serial_number}`,
  );

  const built = _buildDeviceProgramming(dev);
  if (!built.ok) {
    throw new Error(
      `buildDeviceProgramming failed: ${JSON.stringify(built.body)}`,
    );
  }
  const {
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    paramMem,
    paramBase,
    paramMemBySegment,
    absSegData,
    appId,
    isSecureEnabled,
    supportsExtendedMemoryServices,
    cachedMaxApduLength,
  } = built;

  console.log(
    `Real artifacts: ${steps.length} load-procedure steps, gaTable=${gaTable?.length ?? 0}B, assocTable=${assocTable?.length ?? 0}B, groupObjectTable=${groupObjectTable?.length ?? 0}B, paramMem=${paramMem?.length ?? 0}B`,
  );

  const pv = parseProgramVersionFromAppId(appId ?? dev.app_ref);
  const tableBases: Record<number, number> = {};
  if (gaBase !== undefined) tableBases[1] = gaBase;
  if (assocBase !== undefined) tableBases[2] = assocBase;
  if (obj3Base !== undefined) tableBases[3] = obj3Base;
  if (paramBaseArg !== undefined) tableBases[4] = paramBaseArg;

  const conn = new KnxLoopbackConnection({
    deviceAddr: ADDR,
    mask,
    serial: (dev.serial_number || '000000000000').toLowerCase(),
    manufacturerId,
    ...(pv ? { programVersion: programVersionToBuffer(pv) } : {}),
    tableBases,
  });

  await delay(50);

  const result = await conn.downloadDevice(
    ADDR,
    steps,
    gaTable,
    assocTable,
    paramMem,
    (p) => console.log(p.debug ? `  [debug] ${p.msg}` : `${p.msg}`),
    {
      paramBase,
      paramMemBySegment,
      absSegData,
      appId,
      mode: 'full',
      groupObjectTable,
      isSecureEnabled,
      supportsExtendedMemoryServices,
      cachedMaxApduLength,
    },
  );

  console.log(`\ndownloadDevice() result: ${JSON.stringify(result, null, 2)}`);
  console.log(
    `\n${conn.frames.length} frames captured, ${conn.memoryWrites.length} memory writes recorded.`,
  );

  const safeAddr = ADDR.replace(/\./g, '');
  const outDir = path.join(process.cwd(), 'scratch');
  fs.mkdirSync(outDir, { recursive: true });

  // Full structured frame list - every frame, both directions, in order -
  // for a full-session diff against a real capture.
  fs.writeFileSync(
    path.join(outDir, `loopback-${safeAddr}-frames.json`),
    JSON.stringify(
      conn.frames.map((f, i) => ({
        index: i,
        direction: f.direction,
        decoded: f.decoded,
        cemiHex: f.cemi.toString('hex'),
        parsed: f.parsed
          ? {
              msgCode: f.parsed.msgCode,
              src: f.parsed.src,
              dst: f.parsed.dst,
              isGroup: f.parsed.isGroup,
              apciIdx: f.parsed.apciIdx,
              apciName: f.parsed.apciName,
              apduDataHex: f.parsed.apduData.toString('hex'),
              apduHex: f.parsed.apdu.toString('hex'),
              tpciType: f.parsed.tpciType,
            }
          : null,
      })),
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, `loopback-${safeAddr}-result.json`),
    JSON.stringify(
      {
        result,
        frameCount: conn.frames.length,
        memoryWriteCount: conn.memoryWrites.length,
      },
      null,
      2,
    ),
  );

  console.log(
    `\nWritten: ${outDir}/loopback-${safeAddr}-frames.json, loopback-${safeAddr}-result.json`,
  );
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
