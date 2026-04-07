import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { z } from 'zod';
import * as db from '../db.ts';
import { validateBody } from '../validate.ts';
import { DATA_DIR, APPS_DIR, makeUpdateBuilder } from './shared.ts';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Devices ───────────────────────────────────────────────────────────────────
router.get('/projects/:id/devices', (req: Request, res: Response): void => {
  res.json(
    db.all(
      `SELECT * FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
      [+req.params.id!],
    ),
  );
});

router.post('/projects/:id/devices', (req: Request, res: Response): void => {
  const b = validateBody(
    req,
    res,
    z.object({
      individual_address: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      comment: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      order_number: z.string().optional(),
      serial_number: z.string().optional(),
      product_ref: z.string().optional(),
      area: z.number().optional(),
      line: z.number().optional(),
      device_type: z.string().optional(),
      space_id: z.number().nullable().optional(),
      medium: z.string().optional(),
      area_name: z.string().optional(),
      line_name: z.string().optional(),
    }),
  );
  if (!b) return;
  const pid = +req.params.id!;
  const { lastInsertRowid } = db.run(
    `
    INSERT OR REPLACE INTO devices
    (project_id,individual_address,name,description,comment,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,area_name,line_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      pid,
      b.individual_address,
      b.name || b.individual_address,
      b.description || '',
      b.comment || '',
      b.manufacturer || '',
      b.model || '',
      b.order_number || '',
      b.serial_number || '',
      b.product_ref || '',
      b.area || 1,
      b.line || 1,
      b.device_type || 'generic',
      'unassigned',
      '',
      '',
      '',
      '',
      b.space_id || null,
      b.medium || 'TP',
      b.area_name || '',
      b.line_name || '',
    ],
  );
  db.audit(
    pid,
    'create',
    'device',
    b.individual_address,
    `Created device "${b.name || b.individual_address}"`,
  );
  db.scheduleSave();
  res.json(db.get('SELECT * FROM devices WHERE id=?', [lastInsertRowid]));
});

router.put(
  '/projects/:pid/devices/:did',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const did = req.params.did as string;
    const b = validateBody(
      req,
      res,
      z.object({
        name: z.string().min(1).optional(),
        device_type: z.string().optional(),
        description: z.string().optional(),
        comment: z.string().optional(),
        installation_hints: z.string().optional(),
        floor_x: z.number().optional(),
        floor_y: z.number().optional(),
      }),
    );
    if (!b) return;
    const old = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [+did, +pid],
    );
    if (!old) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { track, sets, vals, diffs } = makeUpdateBuilder(old);
    if (b.name !== undefined) track('name', b.name.trim());
    if (b.device_type !== undefined)
      track('device_type', b.device_type || 'generic');
    if (b.description !== undefined) track('description', b.description);
    if (b.comment !== undefined) track('comment', b.comment);
    if (b.installation_hints !== undefined)
      track('installation_hints', b.installation_hints);
    if (b.floor_x !== undefined) {
      sets.push('floor_x=?');
      vals.push(b.floor_x);
    }
    if (b.floor_y !== undefined) {
      sets.push('floor_y=?');
      vals.push(b.floor_y);
    }
    if (!sets.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    vals.push(+did);
    db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`, vals);
    db.audit(
      +pid,
      'update',
      'device',
      (old.individual_address as string) || did,
      diffs.join('; ') || 'Updated position',
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.post(
  '/projects/:pid/floor-plan/:spaceId',
  upload.single('file'),
  (req: Request, res: Response): void => {
    if (!req.file) {
      res.status(400).json({ error: 'No file' });
      return;
    }
    const pid = req.params.pid as string;
    const spaceId = req.params.spaceId as string;
    const dir = path.join(DATA_DIR, 'floorplans');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.png';
    const fname = `${pid}_${spaceId}${ext}`;
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    res.json({ ok: true, fileName: fname });
  },
);

router.get(
  '/projects/:pid/floor-plan/:spaceId',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const spaceId = req.params.spaceId as string;
    const dir = path.join(DATA_DIR, 'floorplans');
    if (!fs.existsSync(dir)) {
      res.status(404).json({ error: 'No floor plan' });
      return;
    }
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => f.startsWith(`${pid}_${spaceId}.`));
    if (!files.length) {
      res.status(404).json({ error: 'No floor plan' });
      return;
    }
    const filePath = path.join(dir, files[0]!);
    res.sendFile(filePath);
  },
);

router.delete(
  '/projects/:pid/floor-plan/:spaceId',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const spaceId = req.params.spaceId as string;
    const dir = path.join(DATA_DIR, 'floorplans');
    if (fs.existsSync(dir)) {
      for (const f of fs
        .readdirSync(dir)
        .filter((f: string) => f.startsWith(`${pid}_${spaceId}.`))) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
    res.json({ ok: true });
  },
);

router.patch(
  '/projects/:pid/devices/:did/status',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const did = req.params.did as string;
    const b = validateBody(
      req,
      res,
      z.object({
        status: z.string(),
      }),
    );
    if (!b) return;
    const devS = db.get<Record<string, unknown>>(
      'SELECT individual_address, name, status FROM devices WHERE id=?',
      [+did],
    );
    db.run('UPDATE devices SET status=? WHERE id=?', [b.status, +did]);
    db.audit(
      +pid,
      'update',
      'device',
      (devS?.individual_address as string) || did,
      `status: "${(devS?.status as string) ?? ''}" → "${b.status}" on "${(devS?.name as string) || did}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.delete(
  '/projects/:pid/devices/:did',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const did = +req.params.did!;
    const devD = db.get<Record<string, unknown>>(
      'SELECT individual_address, name FROM devices WHERE id=?',
      [did],
    );
    db.run('DELETE FROM com_objects WHERE device_id=?', [did]);
    db.run('DELETE FROM devices WHERE id=?', [did]);
    db.audit(
      +pid,
      'delete',
      'device',
      (devD?.individual_address as string) || String(did),
      `Deleted device "${(devD?.name as string) || String(did)}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.get(
  '/projects/:pid/devices/:did/param-model',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const did = req.params.did as string;
    const dev = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [+did, +pid],
    );
    if (!dev) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    if (!dev.app_ref) {
      res.status(404).json({
        error: 'no_model',
        message:
          'No param model available. Re-import the project to enable editing.',
      });
      return;
    }
    const safe = (dev.app_ref as string).replace(/[^a-zA-Z0-9_-]/g, '_');
    const modelPath = path.join(APPS_DIR, safe + '.json');
    if (!fs.existsSync(modelPath)) {
      res.status(404).json({
        error: 'no_model',
        message: 'Param model file not found. Re-import the project.',
      });
      return;
    }
    let model: unknown;
    try {
      model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    } catch (_e) {
      res.status(500).json({ error: 'Failed to read param model' });
      return;
    }
    let currentValues: Record<string, unknown> = {};
    try {
      currentValues = JSON.parse(
        (dev.param_values as string) || '{}',
      ) as Record<string, unknown>;
    } catch (_) {
      /* ignore */
    }
    res.json({ ...(model as Record<string, unknown>), currentValues });
  },
);

router.patch(
  '/projects/:pid/devices/:did/param-values',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const did = req.params.did as string;
    const devPV = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [+did, +pid],
    );
    if (!devPV) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    let oldVals: Record<string, unknown> = {};
    try {
      oldVals = JSON.parse((devPV.param_values as string) || '{}') as Record<
        string,
        unknown
      >;
    } catch (_) {
      /* ignore */
    }
    const newVals = validateBody(req, res, z.record(z.string(), z.unknown()));
    if (!newVals) return;
    const diffs: string[] = [];
    for (const k of Object.keys(newVals)) {
      const ov = oldVals[k];
      const nv = newVals[k];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        diffs.push(`${k}: "${ov ?? ''}" → "${nv}"`);
      }
    }
    db.run('UPDATE devices SET param_values=? WHERE id=?', [
      JSON.stringify(newVals),
      +did,
    ]);
    db.audit(
      +pid,
      'update',
      'param_values',
      (devPV.individual_address as string) || did,
      diffs.join('; ') ||
        `Updated parameters on "${(devPV.name as string) || did}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

export { router };
