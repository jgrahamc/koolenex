'use strict';
const express = require('express');
const db      = require('../db');
const { makeTracker } = require('./shared');

const router = express.Router();

// ── Group Addresses ───────────────────────────────────────────────────────────
router.get('/projects/:id/gas', (req, res) => {
  const pid = +req.params.id;
  const gas = db.all('SELECT * FROM group_addresses WHERE project_id=? ORDER BY main_g,middle_g,sub_g', [pid]);
  // Derive device↔GA map from com_objects
  const cos = db.all(`SELECT co.ga_address, d.individual_address FROM com_objects co JOIN devices d ON co.device_id=d.id WHERE co.project_id=?`, [pid]);
  const gaDeviceMap = {};
  for (const co of cos) {
    for (const ga of (co.ga_address || '').split(/\s+/).filter(Boolean)) {
      if (!gaDeviceMap[ga]) gaDeviceMap[ga] = [];
      if (!gaDeviceMap[ga].includes(co.individual_address))
        gaDeviceMap[ga].push(co.individual_address);
    }
  }

  // Attach group names from dedicated table
  const groupNames = db.all('SELECT main_g, middle_g, name FROM ga_group_names WHERE project_id=?', [pid]);
  const mainNameMap = {}, midNameMap = {};
  for (const gn of groupNames) {
    if (gn.middle_g === -1) mainNameMap[gn.main_g] = gn.name;
    else midNameMap[`${gn.main_g}/${gn.middle_g}`] = gn.name;
  }

  res.json(gas.map(g => {
    const main = g.main_g || 0, middle = g.middle_g || 0;
    return {
      ...g, main, middle, sub: g.sub_g ?? null,
      main_group_name: mainNameMap[main] || '',
      middle_group_name: midNameMap[`${main}/${middle}`] || '',
      devices: gaDeviceMap[g.address] || [],
    };
  }));
});

router.post('/projects/:id/gas', (req, res) => {
  const b = req.body, pid = +req.params.id;
  const parts = (b.address||'').split('/');
  const is2level = parts.length === 2;
  const [m, mi, s] = is2level ? [+parts[0], +parts[1], null]
    : parts.length === 3 ? parts.map(Number) : [0, 0, 0];
  const { lastInsertRowid } = db.run(
    'INSERT OR REPLACE INTO group_addresses (project_id,address,name,dpt,main_g,middle_g,sub_g) VALUES (?,?,?,?,?,?,?)',
    [pid, b.address, b.name||b.address, b.dpt||'', m, mi, s]
  );
  // For 2-level addresses, store middle group name
  if (is2level) {
    db.run('INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
      [pid, m, mi, b.name || b.address]);
  }
  db.audit(pid, 'create', 'group_address', b.address, `Created group address "${b.name || b.address}"`);
  db.scheduleSave();
  res.json(db.get('SELECT * FROM group_addresses WHERE id=?', [lastInsertRowid]));
});

router.put('/projects/:pid/gas/:gid', (req, res) => {
  const { pid, gid } = req.params;
  const b = req.body;
  if (b.name !== undefined && !b.name?.trim()) return res.status(400).json({ error: 'name required' });
  const oldGA = db.get('SELECT * FROM group_addresses WHERE id=? AND project_id=?', [+gid, +pid]);
  if (!oldGA) return res.status(404).json({ error: 'Not found' });
  const { track, sets, vals, diffs } = makeTracker(oldGA);
  if (b.name !== undefined)       track('name', b.name.trim());
  if (b.dpt !== undefined)        track('dpt', b.dpt);
  if (b.description !== undefined) track('description', b.description);
  if (b.comment !== undefined)    track('comment', b.comment);
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(+gid);
  db.run(`UPDATE group_addresses SET ${sets.join(', ')} WHERE id=?`, vals);
  db.audit(+pid, 'update', 'group_address', oldGA.address || gid, diffs.join('; '));
  db.scheduleSave();
  res.json({ ok: true });
});

// Rename a main or middle group
router.patch('/projects/:pid/gas/group-name', (req, res) => {
  const pid = +req.params.pid;
  const { main, middle, name } = req.body;
  if (name === undefined) return res.status(400).json({ error: 'name required' });
  if (main === undefined) return res.status(400).json({ error: 'main required' });

  const midKey = (middle !== undefined && middle !== null) ? middle : -1;
  const old = db.get('SELECT name FROM ga_group_names WHERE project_id=? AND main_g=? AND middle_g=?', [pid, main, midKey]);
  db.run(
    'INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
    [pid, main, midKey, name]
  );
  const label = midKey === -1 ? `${main}` : `${main}/${middle}`;
  const field = midKey === -1 ? 'main_group_name' : 'middle_group_name';
  db.audit(pid, 'update', 'group_name', label, `${field}: "${old?.name ?? ''}" → "${name}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

router.delete('/projects/:pid/gas/:gid', (req, res) => {
  const gid = +req.params.gid;
  const gaD = db.get('SELECT address, name FROM group_addresses WHERE id=?', [gid]);
  db.run('DELETE FROM group_addresses WHERE id=?', [gid]);
  db.audit(+req.params.pid, 'delete', 'group_address', gaD?.address || gid, `Deleted group address "${gaD?.name || gid}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Com Objects ───────────────────────────────────────────────────────────────
router.get('/projects/:id/comobjects', (req, res) => {
  res.json(db.all(`
    SELECT co.*, d.individual_address as device_address, d.name as device_name
    FROM com_objects co JOIN devices d ON co.device_id=d.id
    WHERE co.project_id=? ORDER BY d.area, d.line, CAST(REPLACE(d.individual_address, d.area||'.'||d.line||'.', '') AS INTEGER), co.object_number
  `, [+req.params.id]));
});

// Update GA associations on a com object
router.patch('/projects/:pid/comobjects/:coid/gas', (req, res) => {
  const co = db.get('SELECT * FROM com_objects WHERE id=? AND project_id=?', [+req.params.coid, +req.params.pid]);
  if (!co) return res.status(404).json({ error: 'Not found' });
  const { add, remove, reorder, position } = req.body;
  let gaAddr = (co.ga_address || '').split(/\s+/).filter(Boolean);

  if (remove) {
    gaAddr = gaAddr.filter(a => a !== remove);
  }
  if (add && !gaAddr.includes(add)) {
    gaAddr.push(add);
  }
  if (reorder && gaAddr.includes(reorder) && position != null) {
    gaAddr = gaAddr.filter(a => a !== reorder);
    gaAddr.splice(position, 0, reorder);
  }

  // Rebuild send/receive from position: first GA = send+receive, rest = receive only
  const gaSend = gaAddr.length > 0 ? gaAddr[0] : '';
  const gaRecv = gaAddr.join(' ');

  db.run('UPDATE com_objects SET ga_address=?, ga_send=?, ga_receive=? WHERE id=?',
    [gaAddr.join(' '), gaSend, gaRecv, co.id]);
  const oldGAs = (co.ga_address || '').trim() || '(none)';
  const newGAs = gaAddr.join(' ') || '(none)';
  db.audit(+req.params.pid, 'update', 'com_object', `CO ${co.object_number}`,
    `ga_address: "${oldGAs}" → "${newGAs}" on "${co.name || co.object_number}"`);
  db.scheduleSave();
  res.json({ ...co, ga_address: gaAddr.join(' '), ga_send: gaSend, ga_receive: gaRecv });
});

module.exports = router;
