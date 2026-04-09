import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import * as db from '../db.ts';
import { parseKnxproj } from '../ets-parser.ts';
import type { ParsedProject } from '../ets-parser.ts';
import { saveModelsAndMasterXml, MAX_UPLOAD_BYTES } from './shared.ts';
import { logger } from '../log.ts';
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

// Shared insert logic used by both import and reimport
function insertParsedData(
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
      (project_id,individual_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,parameters,app_ref,param_values,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        pid,
        d.individual_address,
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
      (project_id,device_id,object_number,channel,name,function_text,dpt,object_size,flags,direction,ga_address,ga_send,ga_receive)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      ],
    );
  }

  // Insert topology
  for (const t of topologyEntries || []) {
    run(
      'INSERT OR REPLACE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
      [pid, t.area, t.line, t.name || '', t.medium || 'TP'],
    );
  }

  // Insert catalog sections and items
  for (const sec of catalogSections || []) {
    run(
      'INSERT OR REPLACE INTO catalog_sections (id,project_id,name,number,parent_id,mfr_id,manufacturer) VALUES (?,?,?,?,?,?,?)',
      [
        sec.id,
        pid,
        sec.name,
        sec.number || '',
        sec.parent_id || null,
        sec.mfr_id || '',
        sec.manufacturer || '',
      ],
    );
  }
  for (const item of catalogItems || []) {
    run(
      'INSERT OR REPLACE INTO catalog_items (id,project_id,name,number,description,section_id,product_ref,h2p_ref,order_number,manufacturer,mfr_id,model,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        item.id,
        pid,
        item.name,
        item.number || '',
        item.description || '',
        item.section_id || '',
        item.product_ref || '',
        item.h2p_ref || '',
        item.order_number || '',
        item.manufacturer || '',
        item.mfr_id || '',
        item.model || '',
        item.bus_current || 0,
        item.width_mm || 0,
        item.is_power_supply ? 1 : 0,
        item.is_coupler ? 1 : 0,
        item.is_rail_mounted ? 1 : 0,
      ],
    );
  }

  return { deviceIdMap, gaIdMap };
}

const importBodySchema = z.object({ password: z.string().optional() });

function parseUploadedKnxproj(
  req: Request,
  password: string | undefined,
): ParsedProject {
  const file = req.file as Express.Multer.File;
  return parseKnxproj(file.buffer, password || null);
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
  db.run("UPDATE projects SET name=?, updated_at=datetime('now') WHERE id=?", [
    name,
    id,
  ]);
  db.audit(
    id,
    'update',
    'project',
    name,
    `name: "${oldProj?.name ?? ''}" → "${name}"`,
  );
  db.scheduleSave();
  res.json(db.get<Project>('SELECT * FROM projects WHERE id=?', [id]));
});

router.delete('/projects/:id', (req: Request, res: Response) => {
  const pid = paramId(req, 'id');
  db.transaction(({ run }: db.TransactionHelpers) => {
    run(
      'DELETE FROM com_objects WHERE device_id IN (SELECT id FROM devices WHERE project_id=?)',
      [pid],
    );
    run('DELETE FROM devices WHERE project_id=?', [pid]);
    run('DELETE FROM group_addresses WHERE project_id=?', [pid]);
    run('DELETE FROM bus_telegrams WHERE project_id=?', [pid]);
    run('DELETE FROM ga_group_names WHERE project_id=?', [pid]);
    run('DELETE FROM topology WHERE project_id=?', [pid]);
    run('DELETE FROM catalog_sections WHERE project_id=?', [pid]);
    run('DELETE FROM catalog_items WHERE project_id=?', [pid]);
    run('DELETE FROM audit_log WHERE project_id=?', [pid]);
    run('DELETE FROM spaces WHERE project_id=?', [pid]);
    run('DELETE FROM projects WHERE id=?', [pid]);
  });
  res.json({ ok: true });
});

// ── ETS6 Import ───────────────────────────────────────────────────────────────
router.post(
  '/projects/import',
  upload.single('file'),
  (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.file.originalname.toLowerCase().endsWith('.knxproj'))
      return res.status(400).json({ error: 'File must be a .knxproj file' });

    const body = validateBody(req, importBodySchema);

    let parsed: ParsedProject;
    try {
      parsed = parseUploadedKnxproj(req, body.password);
    } catch (e) {
      const err = e as ParseError;
      if (err.code === 'PASSWORD_REQUIRED')
        return res.status(422).json({
          error: 'Project is password-protected',
          code: 'PASSWORD_REQUIRED',
        });
      if (err.code === 'PASSWORD_INCORRECT')
        return res
          .status(422)
          .json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
      logger.error('ets', 'ETS parse error', { error: err.message });
      return res.status(422).json({ error: `Parse failed: ${err.message}` });
    }

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

    try {
      const projectId = db.transaction(({ run }: db.TransactionHelpers) => {
        const { lastInsertRowid: pid } = run(
          'INSERT INTO projects (name, file_name, thumbnail, project_info) VALUES (?,?,?,?)',
          [
            projectName,
            req.file!.originalname,
            thumbnail || '',
            JSON.stringify(projectInfo || {}),
          ],
        );

        insertParsedData(run, pid as number, parsed);

        return pid as number;
      });

      const data = db.getProjectFull(projectId);

      saveModelsAndMasterXml(paramModels, knxMasterXml, projectId);

      db.audit(
        projectId,
        'import',
        'project',
        req.file!.originalname,
        `Imported ${devices.length} devices, ${groupAddresses.length} group addresses, ${comObjects.length} com objects`,
      );

      res.json({
        ok: true,
        projectId,
        summary: {
          devices: devices.length,
          groupAddresses: groupAddresses.length,
          comObjects: comObjects.length,
          links: links.length,
        },
        data,
      });
    } catch (e) {
      const err = e as Error;
      logger.error('ets', 'Import error', { error: (err as Error).message });
      res.status(500).json({ error: `Import failed: ${err.message}` });
    }
  },
);

// ── ETS6 Reimport (update existing project in-place) ──────────────────────────
router.post(
  '/projects/:id/reimport',
  upload.single('file'),
  (req: Request, res: Response) => {
    const pid = paramId(req, 'id');
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!req.file.originalname.toLowerCase().endsWith('.knxproj'))
      return res.status(400).json({ error: 'File must be a .knxproj file' });

    const project = db.get<Project>('SELECT * FROM projects WHERE id=?', [pid]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = validateBody(req, importBodySchema);

    let parsed: ParsedProject;
    try {
      parsed = parseUploadedKnxproj(req, body.password);
    } catch (e) {
      const err = e as ParseError;
      if (err.code === 'PASSWORD_REQUIRED')
        return res.status(422).json({
          error: 'Project is password-protected',
          code: 'PASSWORD_REQUIRED',
        });
      if (err.code === 'PASSWORD_INCORRECT')
        return res
          .status(422)
          .json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
      logger.error('ets', 'ETS reimport parse error', { error: err.message });
      return res.status(422).json({ error: `Parse failed: ${err.message}` });
    }

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

    try {
      db.transaction(({ run }: db.TransactionHelpers) => {
        // Clear existing data for this project
        run('DELETE FROM com_objects WHERE project_id=?', [pid]);
        run('DELETE FROM group_addresses WHERE project_id=?', [pid]);
        run('DELETE FROM ga_group_names WHERE project_id=?', [pid]);
        run('DELETE FROM devices WHERE project_id=?', [pid]);
        run('DELETE FROM topology WHERE project_id=?', [pid]);
        run('DELETE FROM catalog_sections WHERE project_id=?', [pid]);
        run('DELETE FROM catalog_items WHERE project_id=?', [pid]);
        run('DELETE FROM spaces WHERE project_id=?', [pid]);
        run(
          "UPDATE projects SET name=?, file_name=?, thumbnail=?, project_info=?, updated_at=datetime('now') WHERE id=?",
          [
            projectName,
            req.file!.originalname,
            thumbnail || '',
            JSON.stringify(projectInfo || {}),
            pid,
          ],
        );

        insertParsedData(run, pid, parsed);
      });

      const data = db.getProjectFull(pid);

      saveModelsAndMasterXml(paramModels, knxMasterXml, pid);

      db.audit(
        pid,
        'reimport',
        'project',
        req.file!.originalname,
        `Reimported ${devices.length} devices, ${groupAddresses.length} group addresses, ${comObjects.length} com objects`,
      );

      res.json({
        ok: true,
        projectId: pid,
        summary: {
          devices: devices.length,
          groupAddresses: groupAddresses.length,
          comObjects: comObjects.length,
          links: links.length,
        },
        data,
      });
    } catch (e) {
      const err = e as Error;
      logger.error('ets', 'Reimport error', { error: (err as Error).message });
      res.status(500).json({ error: `Reimport failed: ${err.message}` });
    }
  },
);
