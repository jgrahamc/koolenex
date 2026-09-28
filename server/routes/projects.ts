import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import * as db from '../db.ts';
import { parseKnxproj } from '../ets-parser.ts';
import type { ParsedProject } from '../ets-parser.ts';
import {
  insertCatalog,
  saveModelsAndMasterXml,
  clearMasterDataCaches,
  MAX_UPLOAD_BYTES,
} from './shared.ts';
import { invalidateGaDptCache } from './bus.ts';
import * as importJobs from './import-jobs.ts';
import type { ImportJob } from './import-jobs.ts';
import { logger, safeError } from '../log.ts';
import { validateBody, paramId } from '../validate.ts';
import type { Project, RunResult } from '../../shared/types.ts';

interface ParseError extends Error {
  code?: string;
}

export const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Shared insert logic used by both import and reimport. Exported for
// scripts to drive a real parse+insert without Express/multer.
/**
 * Every table keyed by project_id. Reimport and DELETE /projects/:id both
 * wipe a project's rows from this list; tests/project-tables.test.ts
 * asserts it against the live schema so a new project_id table can't be
 * forgotten here.
 *
 * com_objects leads: deleteProjectRows also sweeps it by device, which needs
 * the devices rows to still exist.
 */
export const PROJECT_TABLES = [
  'com_objects',
  'devices',
  'group_addresses',
  'ga_group_names',
  'topology',
  'catalog_sections',
  'catalog_items',
  'spaces',
  'bus_telegrams',
  'audit_log',
] as const;

export type ProjectTable = (typeof PROJECT_TABLES)[number];

/** Tables a reimport leaves alone: captured bus telegrams and the audit trail aren't part of the .knxproj. */
export const REIMPORT_KEEPS: readonly ProjectTable[] = [
  'bus_telegrams',
  'audit_log',
];

/**
 * Delete a project's rows from every per-project table except those named in
 * `keep`. Does not touch the `projects` row itself - the caller decides
 * whether the project survives.
 */
export function deleteProjectRows(
  run: db.TransactionHelpers['run'],
  projectId: number,
  keep: readonly ProjectTable[] = [],
): void {
  // Sweep com_objects by device too, before the loop deletes devices - a
  // row with a stale project_id would otherwise outlive its device.
  if (!keep.includes('com_objects'))
    run(
      'DELETE FROM com_objects WHERE device_id IN (SELECT id FROM devices WHERE project_id=?)',
      [projectId],
    );
  for (const table of PROJECT_TABLES) {
    if (keep.includes(table)) continue;
    run(`DELETE FROM ${table} WHERE project_id=?`, [projectId]);
  }
}

export function insertParsedData(
  run: (sql: string, params?: unknown[]) => RunResult,
  pid: number,
  parsed: ParsedProject,
): {
  deviceIdMap: Record<string, number | null>;
  gaIdMap: Record<string, number | null>;
} {
  const {
    devices,
    groupAddresses,
    comObjects,
    spaces,
    devSpaceMap,
    topologyEntries,
    catalogSections,
    catalogItems,
  } = parsed;

  // Insert spaces first so we can reference their DB ids for devices
  const spaceDbIds: (number | null)[] = [];
  for (const s of spaces) {
    const parentDbId =
      s.parent_idx != null ? (spaceDbIds[s.parent_idx] ?? null) : null;
    const { lastInsertRowid } = run(
      'INSERT INTO spaces (project_id,name,type,usage_id,parent_id,sort_order) VALUES (?,?,?,?,?,?)',
      [pid, s.name, s.type, s.usage_id || '', parentDbId, s.sort_order],
    );
    spaceDbIds.push(lastInsertRowid);
  }

  const deviceIdMap: Record<string, number | null> = {};
  for (const d of devices) {
    const spaceIdx = devSpaceMap[d.individual_address];
    const spaceId = spaceIdx != null ? (spaceDbIds[spaceIdx] ?? null) : null;
    const { lastInsertRowid } = run(
      `
      INSERT OR REPLACE INTO devices
      (project_id,individual_address,has_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,parameters,app_ref,param_values,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted,apdu_length)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pid,
        d.individual_address,
        d.has_address ? 1 : 0,
        d.name,
        d.description || '',
        d.comment || '',
        d.installation_hints || '',
        d.manufacturer || '',
        d.model || '',
        d.order_number || '',
        d.serial_number || '',
        d.product_ref || '',
        d.area,
        d.line,
        d.device_type,
        d.status || 'unassigned',
        d.last_modified || '',
        d.last_download || '',
        '',
        '',
        spaceId,
        d.medium || 'TP',
        JSON.stringify(d.parameters || []),
        d.app_ref || '',
        JSON.stringify(d.param_values || {}),
        JSON.stringify(d.model_translations || {}),
        d.bus_current || 0,
        d.width_mm || 0,
        d.is_power_supply ? 1 : 0,
        d.is_coupler ? 1 : 0,
        d.is_rail_mounted ? 1 : 0,
        // `LastUsedAPDULength` from `<DeviceInstance>` XML; matches a live
        // PID_MAX_APDULENGTH read, so used as a cached per-device chunk ceiling.
        d.apdu_length || '',
      ],
    );
    deviceIdMap[d.individual_address] = lastInsertRowid;
  }

  const gaIdMap: Record<string, number | null> = {};
  for (const g of groupAddresses) {
    const { lastInsertRowid } = run(
      `
      INSERT OR REPLACE INTO group_addresses
      (project_id,address,name,dpt,comment,description,main_g,middle_g,sub_g)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        pid,
        g.address,
        g.name,
        g.dpt || '',
        g.comment || '',
        g.description || '',
        g.main || 0,
        g.middle || 0,
        g.sub || 0,
      ],
    );
    gaIdMap[g.address] = lastInsertRowid;
    if (g.mainGroupName) {
      run(
        'INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,-1,?)',
        [pid, g.main || 0, g.mainGroupName],
      );
    }
    if (g.middleGroupName) {
      run(
        'INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
        [pid, g.main || 0, g.middle || 0, g.middleGroupName],
      );
    }
  }

  for (const co of comObjects) {
    const devId = deviceIdMap[co.device_address];
    if (!devId) continue;
    run(
      `INSERT INTO com_objects
      (project_id,device_id,object_number,channel,name,function_text,dpt,object_size,flags,direction,ga_address,ga_send,ga_receive,read_on_init,priority,read,write,comm,tx,upd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pid,
        devId,
        co.object_number || 0,
        co.channel || '',
        co.name || '',
        co.function_text || '',
        co.dpt || '',
        co.object_size || '',
        co.flags || 'CW',
        co.direction || 'both',
        co.ga_address || '',
        co.ga_send || '',
        co.ga_receive || '',
        co.read_on_init ? 1 : 0,
        co.priority || 'low',
        co.read ? 1 : 0,
        co.write ? 1 : 0,
        co.comm ? 1 : 0,
        co.tx ? 1 : 0,
        co.update ? 1 : 0, // column is `upd`, not `update` - see db.ts naming comment
      ],
    );
  }

  // Topology
  for (const t of topologyEntries || []) {
    run(
      'INSERT OR REPLACE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
      [pid, t.area, t.line, t.name || '', t.medium || 'TP'],
    );
  }

  insertCatalog(run, pid, catalogSections, catalogItems);

  return { deviceIdMap, gaIdMap };
}

const importBodySchema = z.object({ password: z.string().optional() });
const passwordBodySchema = z.object({ password: z.string().min(1) });

/**
 * Run a parse + DB-insert (or reimport) for an already-registered job.
 * Drives the job through password-required → parsing → done|failed transitions.
 * Called via setImmediate so the HTTP response has already been sent.
 */
async function runImportJob(job: ImportJob): Promise<void> {
  const buf = job.fileBuffer;
  if (!buf) {
    importJobs.setTerminal(job.importId, {
      status: 'failed',
      error: 'Upload buffer no longer available',
      code: 'INTERNAL',
    });
    return;
  }

  let parsed: ParsedProject;
  const tParse = Date.now();
  try {
    parsed = parseKnxproj(buf, job.password || null);
    logger.info('import', 'parse ok', {
      importId: job.importId,
      ms: Date.now() - tParse,
    });
  } catch (e) {
    const err = e as ParseError;
    logger.info('import', 'parse failed', {
      importId: job.importId,
      ms: Date.now() - tParse,
      code: err.code || null,
      error: err.message,
    });
    if (err.code === 'PASSWORD_REQUIRED' || err.code === 'PASSWORD_INCORRECT') {
      const j = importJobs.getJob(job.importId);
      if (j) j.passwordRetry = err.code === 'PASSWORD_INCORRECT';
      importJobs.setStatus(job.importId, { status: 'password-required' });
      return;
    }
    safeError('ets', `${job.mode} parse failed`, e);
    importJobs.setTerminal(job.importId, {
      status: 'failed',
      error: err.message || 'Parse failed',
      code: 'PARSE_FAILED',
    });
    return;
  }

  try {
    const {
      projectName,
      devices,
      groupAddresses,
      comObjects,
      links,
      paramModels,
      thumbnail,
      projectInfo,
      knxMasterXml,
    } = parsed;

    let projectId: number;
    if (job.mode === 'import') {
      projectId = db.transaction(({ run }: db.TransactionHelpers) => {
        const { lastInsertRowid: pid } = run(
          'INSERT INTO projects (name, file_name, thumbnail, project_info) VALUES (?,?,?,?)',
          [
            projectName,
            job.fileName,
            thumbnail || '',
            JSON.stringify(projectInfo || {}),
          ],
        );
        insertParsedData(run, pid as number, parsed);
        return pid as number;
      });
    } else {
      projectId = job.reimportProjectId!;
      db.transaction(({ run }: db.TransactionHelpers) => {
        deleteProjectRows(run, projectId, REIMPORT_KEEPS);
        run(
          "UPDATE projects SET name=?, file_name=?, thumbnail=?, project_info=?, updated_at=datetime('now') WHERE id=?",
          [
            projectName,
            job.fileName,
            thumbnail || '',
            JSON.stringify(projectInfo || {}),
            projectId,
          ],
        );
        insertParsedData(run, projectId, parsed);
      });
    }

    saveModelsAndMasterXml(paramModels, knxMasterXml, projectId);
    db.audit(
      projectId,
      job.mode,
      'project',
      job.fileName,
      `${job.mode === 'import' ? 'Imported' : 'Reimported'} ${devices.length} devices, ${groupAddresses.length} group addresses, ${comObjects.length} com objects`,
    );
    invalidateGaDptCache();

    importJobs.setTerminal(job.importId, {
      status: 'done',
      projectId,
      summary: {
        devices: devices.length,
        groupAddresses: groupAddresses.length,
        comObjects: comObjects.length,
        links: links.length,
      },
    });
  } catch (e) {
    safeError('ets', `${job.mode} failed`, e);
    importJobs.setTerminal(job.importId, {
      status: 'failed',
      error: (e as Error).message || `${job.mode} failed`,
      code: 'INTERNAL',
    });
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────
router.get('/projects', (_req: Request, res: Response) => {
  res.json(db.all<Project>('SELECT * FROM projects ORDER BY updated_at DESC'));
});

router.post('/projects', (req: Request, res: Response) => {
  const body = validateBody(req, z.object({ name: z.string().trim().min(1) }));
  const { name } = body;
  const { lastInsertRowid } = db.run('INSERT INTO projects (name) VALUES (?)', [
    name,
  ]);
  db.audit(
    lastInsertRowid as number,
    'create',
    'project',
    name,
    'Created project',
  );
  db.scheduleSave();
  res.json(
    db.get<Project>('SELECT * FROM projects WHERE id=?', [lastInsertRowid]),
  );
});

router.get('/projects/:id', (req: Request, res: Response) => {
  const data = db.getProjectFull(paramId(req, 'id'));
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

router.put('/projects/:id', (req: Request, res: Response) => {
  const body = validateBody(req, z.object({ name: z.string().min(1) }));
  const { name } = body;
  const id = paramId(req, 'id');
  const oldProj = db.get<{ name: string }>(
    'SELECT name FROM projects WHERE id=?',
    [id],
  );
  if (!oldProj) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  db.run("UPDATE projects SET name=?, updated_at=datetime('now') WHERE id=?", [
    name,
    id,
  ]);
  db.audit(
    id,
    'update',
    'project',
    name,
    `name: "${oldProj.name}" → "${name}"`,
  );
  db.scheduleSave();
  res.json(db.get<Project>('SELECT * FROM projects WHERE id=?', [id]));
});

router.delete('/projects/:id', (req: Request, res: Response) => {
  const pid = paramId(req, 'id');
  db.transaction(({ run }: db.TransactionHelpers) => {
    deleteProjectRows(run, pid);
    run('DELETE FROM projects WHERE id=?', [pid]);
  });
  invalidateGaDptCache();
  // knx_master_<id>.xml is left on disk (ids are AUTOINCREMENT, so nothing
  // reuses this id), but drop its cached parsed form from memory.
  clearMasterDataCaches(pid);
  res.json({ ok: true });
});

// ── ETS6 Import (async) ───────────────────────────────────────────────────────
// The HTTP response returns immediately with an importId. Parse + DB insert
// run in the background; the client tracks completion via WebSocket
// (`import:done` / `import:failed` / `import:password-required`) or by polling
// GET /projects/import/:importId/status.

/**
 * Shared upload handler for /projects/import and /projects/:id/reimport;
 * reimport additionally resolves/checks the project and passes its id into
 * the job. Check order: id resolution, then file/extension, then project
 * existence - a reimport with no file to a missing project still answers
 * "No file uploaded", not 404.
 */
function importRoute(mode: 'import' | 'reimport') {
  return (req: Request, res: Response): void => {
    const pid = mode === 'reimport' ? paramId(req, 'id') : null;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    if (!req.file.originalname.toLowerCase().endsWith('.knxproj')) {
      res.status(400).json({ error: 'File must be a .knxproj file' });
      return;
    }

    if (pid != null) {
      const project = db.get<Project>('SELECT * FROM projects WHERE id=?', [
        pid,
      ]);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
    }

    const body = validateBody(req, importBodySchema);

    // One at a time: a second parse would fight the first for memory on a
    // large project, and the job registry only tracks one active import.
    const activeId = importJobs.getActiveImportId();
    if (activeId) {
      res.status(409).json({
        error: 'An import is already in progress',
        code: 'IMPORT_BUSY',
        activeImportId: activeId,
      });
      return;
    }

    const job = importJobs.createJob({
      mode,
      ...(pid != null ? { reimportProjectId: pid } : {}),
      fileName: req.file.originalname,
      fileBuffer: req.file.buffer,
      password: body.password,
    });

    logger.info('api', `${mode}: received`, {
      importId: job.importId,
      ...(pid != null ? { pid } : {}),
      name: job.fileName,
      bytes: req.file.buffer.length,
      hasPassword: !!body.password,
    });

    res.json({ ok: true, importId: job.importId });
    setImmediate(() => {
      void runImportJob(job);
    });
  };
}

router.post('/projects/import', upload.single('file'), importRoute('import'));

router.post(
  '/projects/:id/reimport',
  upload.single('file'),
  importRoute('reimport'),
);

// ── Import job control (password retry, status polling) ────────────────────

router.post(
  '/projects/import/:importId/password',
  (req: Request, res: Response) => {
    const importId = String(req.params.importId);
    const job = importJobs.getJob(importId);
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    if (job.status !== 'password-required')
      return res.status(409).json({ error: 'Job not awaiting password' });
    if (!job.fileBuffer)
      return res
        .status(410)
        .json({ error: 'Upload expired, please re-upload' });

    const body = validateBody(req, passwordBodySchema);
    job.password = body.password;
    importJobs.setStatus(importId, { status: 'parsing' });

    logger.info('api', 'import: password submitted', { importId });

    res.json({ ok: true });
    setImmediate(() => {
      void runImportJob(job);
    });
  },
);

router.get(
  '/projects/import/:importId/status',
  (req: Request, res: Response) => {
    const importId = String(req.params.importId);
    const job = importJobs.getJob(importId);
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    res.json(importJobs.snapshot(job));
  },
);
