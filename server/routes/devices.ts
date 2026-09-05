import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { z } from 'zod';
import * as db from '../db.ts';
import { validateBody, paramId } from '../validate.ts';
import {
  DATA_DIR,
  APPS_DIR,
  makeUpdateBuilder,
  MAX_UPLOAD_BYTES,
  markDeviceModifiedIfProgrammed,
  clearPendingChanges,
} from './shared.ts';
import type { PendingChangeInput } from './shared.ts';
import type { Device } from '../../shared/types.ts';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ── Devices ───────────────────────────────────────────────────────────────────
router.get('/projects/:id/devices', (req: Request, res: Response): void => {
  res.json(
    db.all(
      `SELECT * FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
      [paramId(req, 'id')],
    ),
  );
});

router.post('/projects/:id/devices', (req: Request, res: Response): void => {
  const b = validateBody(
    req,
    z.object({
      individual_address: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/, 'Must be in X.Y.Z format'),
      name: z.string().optional(),
      description: z.string().optional(),
      comment: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      order_number: z.string().optional(),
      serial_number: z.string().optional(),
      product_ref: z.string().optional(),
      area: z.number().int().min(0).max(15).optional(),
      line: z.number().int().min(0).max(15).optional(),
      device_type: z.string().optional(),
      space_id: z.number().nullable().optional(),
      medium: z.string().optional(),
      area_name: z.string().optional(),
      line_name: z.string().optional(),
    }),
  );
  const pid = paramId(req, 'id');
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
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const b = validateBody(
      req,
      z.object({
        name: z.string().min(1).optional(),
        device_type: z.string().optional(),
        description: z.string().optional(),
        comment: z.string().optional(),
        installation_hints: z.string().optional(),
        floor_x: z.number().optional(),
        floor_y: z.number().optional(),
        // Set after a real device-addressing write (see AddressDeviceModal
        // in the client, added 2026-08-30) to record the physical serial
        // number actually written to this address, for traceability -
        // separate from whatever value the imported project itself carried
        // (a canary template can arrive with a real prior villa's serial
        // baked in, which this overwrites once this villa's own device is
        // actually addressed).
        serial_number: z.string().optional(),
        // Assigns a real project address to a device imported with none
        // (has_address=0 - see ets-parser.ts's synthetic-address handling,
        // added 2026-08-30) - the first step before that device can go
        // through physical commissioning (AddressDeviceModal). Setting
        // this always also sets has_address=1: a human explicitly picking
        // a real X.Y.Z here is by definition no longer the synthetic
        // placeholder case, regardless of what the value happens to look
        // like.
        individual_address: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/, 'Must be in X.Y.Z format')
          .optional(),
      }),
    );
    const old = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [did, pid],
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
    // last_verify_match/last_verify_at cleared whenever either genuinely
    // changes - real request, 2026-09-01: "clear verify if... its
    // serial/device address changed". Deliberately checked against the
    // OLD value, not just "present in the request body" - serial_number
    // in particular is resent unchanged by some callers (e.g. the address
    // PUT alongside an unrelated field), which must not spuriously
    // invalidate a real, still-accurate verify result.
    let verifyInvalidated = false;
    if (b.serial_number !== undefined) {
      const trimmed = b.serial_number.trim();
      track('serial_number', trimmed);
      if (trimmed !== (old.serial_number ?? '')) verifyInvalidated = true;
    }
    if (
      b.individual_address !== undefined &&
      b.individual_address !== old.individual_address
    ) {
      verifyInvalidated = true;
      track('individual_address', b.individual_address);
      sets.push('has_address=1');
      // Real bug found live, 2026-08-31: the address badge went straight
      // to "blue" (has_address + a non-empty serial_number - see
      // DeviceAddr, primitives.tsx) the moment a project address was
      // assigned, even though nothing had been physically written yet.
      // Root cause: serial_number can carry a real, genuinely-captured
      // value from a PRIOR, unrelated address/session (this project's own
      // stated invariant on the write-side, see AddressDeviceModal's own
      // comment: "separate from whatever value the imported project
      // itself carried - a canary template can arrive with a real prior
      // villa's serial baked in") - that old serial is not evidence
      // anything was ever confirmed at THIS new address. Whenever the
      // project address genuinely changes, the previously-recorded serial
      // stops being trustworthy for it and must be cleared, not carried
      // forward silently.
      //
      // Real regression, found live the same day: this fired on EVERY
      // address change, including has_address 0->1 (a device's FIRST-EVER
      // project address, from the synthetic placeholder - see ets-
      // parser.ts) - not just a genuine reassignment between two real
      // addresses. A real operator workflow - enter a device's serial
      // manually (Serial Number tab), THEN assign it a project address -
      // silently lost the serial the moment the address was saved, purely
      // because that's a separate request that (correctly) doesn't resend
      // serial_number. The serial in that case is not stale at all - it's
      // the same value entered moments earlier for this same physical
      // unit, before it had a project address yet. Scoped to only clear
      // when the device already HAD a real address (old.has_address) -
      // a genuine "was at X, now at Y" reassignment, where an old serial
      // really could be stale. Also switched from a raw sets/vals push to
      // track() (was previously invisible in the audit log's own diff -
      // exactly what made this regression hard to find).
      if (!b.serial_number && old.has_address) {
        track('serial_number', '');
      }
    }
    if (b.floor_x !== undefined) {
      sets.push('floor_x=?');
      vals.push(b.floor_x);
    }
    if (b.floor_y !== undefined) {
      sets.push('floor_y=?');
      vals.push(b.floor_y);
    }
    if (verifyInvalidated) {
      sets.push('last_verify_match=NULL', 'last_verify_at=NULL');
    }
    if (!sets.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    vals.push(did);
    try {
      db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`, vals);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE constraint')) {
        res.status(409).json({
          error: 'address_in_use',
          message: `Address ${b.individual_address} is already used by another device in this project.`,
        });
        return;
      }
      throw e;
    }
    db.audit(
      pid,
      'update',
      'device',
      (old.individual_address as string) || String(did),
      diffs.join('; ') || 'Updated position',
    );
    db.scheduleSave();
    res.json(db.get('SELECT * FROM devices WHERE id=?', [did]));
  },
);

// Reverts a device's project address back to "unassigned" - real user
// request, 2026-08-31, made explicit after live testing surfaced the gap:
// the address-assign route (above) can only ever set has_address=1, never
// back to 0, so a project address picked in error (or one you've simply
// changed your mind about before writing it anywhere) had no way back.
// Deliberately refuses to touch a device that's already been physically
// confirmed (a non-empty serial_number - see the address-change branch
// above for why that field is trustworthy evidence of a real write) -
// unassigning a device that's actually live on the bus at that address
// would silently orphan real commissioning data; that's a different,
// not-yet-built operation, not this one.
router.patch(
  '/projects/:pid/devices/:did/unassign',
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const dev = db.get<Device>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [did, pid],
    );
    if (!dev) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!dev.has_address) {
      res.status(400).json({
        error: 'not_assigned',
        message: 'This device has no project address to unassign.',
      });
      return;
    }
    if (dev.serial_number) {
      res.status(409).json({
        error: 'already_written',
        message:
          'This device has a physically-confirmed serial at this address - unassigning would orphan real commissioning data. Not supported here.',
      });
      return;
    }
    // Synthetic placeholder, same convention ets-parser.ts uses for a
    // device imported with no address at all (device number starting at
    // 256, past the real 0-255 KNX range, so it can never collide with a
    // real address) - reuses the device's own current area/line rather
    // than reconstructing wherever it originally lived in the topology,
    // and picks the first number in that range not already in use by any
    // OTHER device in the project (has_address=0 placeholders still
    // occupy the unique individual_address column, same as a real one).
    const used = new Set(
      db
        .all<{ individual_address: string }>(
          'SELECT individual_address FROM devices WHERE project_id=? AND area=? AND line=? AND id!=?',
          [pid, dev.area, dev.line, did],
        )
        .map((r) => r.individual_address),
    );
    let n = 256;
    while (used.has(`${dev.area}.${dev.line}.${n}`)) n++;
    const placeholder = `${dev.area}.${dev.line}.${n}`;

    // last_verify_match/last_verify_at cleared too - real request,
    // 2026-09-01: "clear verify if the device is unassigned" - whatever a
    // prior verify found was about a specific physical address this
    // device no longer occupies.
    db.run(
      'UPDATE devices SET has_address=0, individual_address=?, status=?, last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
      [placeholder, 'unassigned', did],
    );
    // Pending-change tracking cleared too, same reasoning as verify above -
    // an unassigned device has no address to program against, so whatever
    // edits were pending have nothing left to be "pending" for.
    clearPendingChanges(did);
    db.audit(
      pid,
      'update',
      'device',
      dev.individual_address,
      `unassigned (was "${dev.individual_address}") on "${dev.name || did}"`,
    );
    db.scheduleSave();
    res.json(db.get('SELECT * FROM devices WHERE id=?', [did]));
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
    const pid = paramId(req, 'pid');
    const spaceId = paramId(req, 'spaceId');
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
    const pid = paramId(req, 'pid');
    const spaceId = paramId(req, 'spaceId');
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
    const pid = paramId(req, 'pid');
    const spaceId = paramId(req, 'spaceId');
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
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const b = validateBody(
      req,
      z.object({
        status: z.string(),
      }),
    );
    const devS = db.get<Record<string, unknown>>(
      'SELECT individual_address, name, status FROM devices WHERE id=?',
      [did],
    );
    db.run('UPDATE devices SET status=? WHERE id=?', [b.status, did]);
    db.audit(
      pid,
      'update',
      'device',
      (devS?.individual_address as string) || String(did),
      `status: "${(devS?.status as string) ?? ''}" → "${b.status}" on "${(devS?.name as string) || String(did)}"`,
    );
    db.scheduleSave();
    res.json(db.get('SELECT * FROM devices WHERE id=?', [did]));
  },
);

router.delete(
  '/projects/:pid/devices/:did',
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const devD = db.get<Record<string, unknown>>(
      'SELECT individual_address, name FROM devices WHERE id=?',
      [did],
    );
    db.transaction(({ run }) => {
      run('DELETE FROM com_objects WHERE device_id=?', [did]);
      run('DELETE FROM devices WHERE id=?', [did]);
    });
    db.audit(
      pid,
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
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const dev = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [did, pid],
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
    const pid = paramId(req, 'pid');
    const did = paramId(req, 'did');
    const devPV = db.get<Record<string, unknown>>(
      'SELECT * FROM devices WHERE id=? AND project_id=?',
      [did, pid],
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
    const newVals = validateBody(req, z.record(z.string(), z.unknown()));
    const diffs: string[] = [];
    const pendingChanges: PendingChangeInput[] = [];
    for (const k of Object.keys(newVals)) {
      const ov = oldVals[k];
      const nv = newVals[k];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) {
        diffs.push(`${k}: "${ov ?? ''}" → "${nv}"`);
        pendingChanges.push({ kind: 'param_value', key: k, oldVal: ov, newVal: nv });
      }
    }
    // Merged into the existing values, not a full replace - real request
    // 2026-08-31: DeviceParameters.tsx (the only caller so far) always
    // sends its complete current value set anyway, so merging vs.
    // replacing produces the same result for it (a merge of the full set
    // is a superset-equal union, not a partial one) - but replace made
    // any FUTURE single-key caller (e.g. a compare-page inline edit)
    // unsafe by construction, silently wiping every other parameter's
    // value. Merging removes that trap without changing today's behavior,
    // with one genuine, deliberate difference: a key present in the OLD
    // blob but genuinely absent from a full resend (e.g. a parameter that
    // became inactive under a Dynamic condition since last save) no
    // longer gets garbage-collected on save - it stays in the JSON blob,
    // unused but harmless (nothing currently reads a key that isn't also
    // resolved as active).
    const mergedVals = { ...oldVals, ...newVals };
    db.run('UPDATE devices SET param_values=? WHERE id=?', [
      JSON.stringify(mergedVals),
      did,
    ]);
    db.audit(
      pid,
      'update',
      'param_values',
      (devPV.individual_address as string) || String(did),
      diffs.join('; ') ||
        `Updated parameters on "${(devPV.name as string) || String(did)}"`,
    );
    let deviceStatus: string | null = null;
    let verifyCleared = false;
    if (diffs.length) {
      ({ status: deviceStatus, verifyCleared } = markDeviceModifiedIfProgrammed(
        pid,
        did,
        pendingChanges,
      ));
    }
    db.scheduleSave();
    res.json({
      ok: true,
      ...(deviceStatus ? { device_status: deviceStatus } : {}),
      ...(verifyCleared
        ? { last_verify_match: null, last_verify_at: null }
        : {}),
    });
  },
);

export { router };
