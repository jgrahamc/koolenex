'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { DATA_DIR, APPS_DIR, makeTracker } = require('./shared');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Devices ───────────────────────────────────────────────────────────────────
router.get('/projects/:id/devices', (req, res) => {
  res.json(
    db.all(
      `SELECT * FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
      [+req.params.id],
    ),
  );
});

router.post('/projects/:id/devices', (req, res) => {
  const b = req.body,
    pid = +req.params.id;
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

router.put('/projects/:pid/devices/:did', (req, res) => {
  const { pid, did } = req.params;
  const b = req.body;
  if (b.name !== undefined && !b.name?.trim())
    return res.status(400).json({ error: 'name required' });
  const old = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [
    +did,
    +pid,
  ]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { track, sets, vals, diffs } = makeTracker(old);
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
  if (!sets.length)
    return res.status(400).json({ error: 'No fields to update' });
  vals.push(+did);
  db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`, vals);
  db.audit(
    +pid,
    'update',
    'device',
    old.individual_address || did,
    diffs.join('; ') || 'Updated position',
  );
  db.scheduleSave();
  res.json({ ok: true });
});

router.post(
  '/projects/:pid/floor-plan/:spaceId',
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { pid, spaceId } = req.params;
    const dir = path.join(DATA_DIR, 'floorplans');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.png';
    const fname = `${pid}_${spaceId}${ext}`;
    fs.writeFileSync(path.join(dir, fname), req.file.buffer);
    res.json({ ok: true, fileName: fname });
  },
);

router.get('/projects/:pid/floor-plan/:spaceId', (req, res) => {
  const { pid, spaceId } = req.params;
  const dir = path.join(DATA_DIR, 'floorplans');
  if (!fs.existsSync(dir))
    return res.status(404).json({ error: 'No floor plan' });
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${pid}_${spaceId}.`));
  if (!files.length) return res.status(404).json({ error: 'No floor plan' });
  const filePath = path.join(dir, files[0]);
  res.sendFile(filePath);
});

router.delete('/projects/:pid/floor-plan/:spaceId', (req, res) => {
  const { pid, spaceId } = req.params;
  const dir = path.join(DATA_DIR, 'floorplans');
  if (fs.existsSync(dir)) {
    for (const f of fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${pid}_${spaceId}.`))) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  res.json({ ok: true });
});

router.patch('/projects/:pid/devices/:did/status', (req, res) => {
  const devS = db.get(
    'SELECT individual_address, name, status FROM devices WHERE id=?',
    [+req.params.did],
  );
  db.run('UPDATE devices SET status=? WHERE id=?', [
    req.body.status,
    +req.params.did,
  ]);
  db.audit(
    +req.params.pid,
    'update',
    'device',
    devS?.individual_address || req.params.did,
    `status: "${devS?.status ?? ''}" → "${req.body.status}" on "${devS?.name || req.params.did}"`,
  );
  db.scheduleSave();
  res.json({ ok: true });
});

router.delete('/projects/:pid/devices/:did', (req, res) => {
  const did = +req.params.did;
  const devD = db.get(
    'SELECT individual_address, name FROM devices WHERE id=?',
    [did],
  );
  db.run('DELETE FROM com_objects WHERE device_id=?', [did]);
  db.run('DELETE FROM devices WHERE id=?', [did]);
  db.audit(
    +req.params.pid,
    'delete',
    'device',
    devD?.individual_address || did,
    `Deleted device "${devD?.name || did}"`,
  );
  db.scheduleSave();
  res.json({ ok: true });
});

router.get('/projects/:pid/devices/:did/param-model', (req, res) => {
  const dev = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [
    +req.params.did,
    +req.params.pid,
  ]);
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  if (!dev.app_ref)
    return res.status(404).json({
      error: 'no_model',
      message:
        'No param model available. Re-import the project to enable editing.',
    });
  const safe = dev.app_ref.replace(/[^a-zA-Z0-9_-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath))
    return res.status(404).json({
      error: 'no_model',
      message: 'Param model file not found. Re-import the project.',
    });
  let model;
  try {
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch (_e) {
    return res.status(500).json({ error: 'Failed to read param model' });
  }
  let currentValues = {};
  try {
    currentValues = JSON.parse(dev.param_values || '{}');
  } catch (_) {}
  res.json({ ...model, currentValues });
});

router.patch('/projects/:pid/devices/:did/param-values', (req, res) => {
  const devPV = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [
    +req.params.did,
    +req.params.pid,
  ]);
  if (!devPV) return res.status(404).json({ error: 'Not found' });
  let oldVals = {};
  try {
    oldVals = JSON.parse(devPV.param_values || '{}');
  } catch (_) {}
  const newVals = req.body;
  const diffs = [];
  for (const k of Object.keys(newVals)) {
    const ov = oldVals[k],
      nv = newVals[k];
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      diffs.push(`${k}: "${ov ?? ''}" → "${nv}"`);
    }
  }
  db.run('UPDATE devices SET param_values=? WHERE id=?', [
    JSON.stringify(newVals),
    +req.params.did,
  ]);
  db.audit(
    +req.params.pid,
    'update',
    'param_values',
    devPV.individual_address || req.params.did,
    diffs.join('; ') ||
      `Updated parameters on "${devPV.name || req.params.did}"`,
  );
  db.scheduleSave();
  res.json({ ok: true });
});

module.exports = router;
