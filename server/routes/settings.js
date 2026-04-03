'use strict';
const express = require('express');
const db = require('../db');
const { getDptInfo, readMasterXml, parseMasterXml, toArr, makeTracker,
        _spaceUsageCache, _translationCache, _mediumTypeCache, _maskVersionCache } = require('./shared');

const router = express.Router();

// ── RTF to HTML conversion ────────────────────────────────────────────────────
const rtfToHTML = require('@iarna/rtf-to-html');

router.post('/rtf-to-html', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  const rtf = req.body;
  if (!rtf || typeof rtf !== 'string') return res.status(400).json({ error: 'No RTF content' });
  // Decode XML entities that ETS embeds in RTF attributes
  const decoded = rtf.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  const stream = require('stream');
  const input = new stream.Readable();
  input.push(decoded);
  input.push(null);
  input.pipe(rtfToHTML((err, html) => {
    if (err) return res.status(400).json({ error: err.message });
    // Extract just the <body> content — the library produces a full HTML document
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    res.json({ html: bodyMatch ? bodyMatch[1].trim() : html });
  }));
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── DPT info ──────────────────────────────────────────────────────────────────
router.get('/dpt-info', (req, res) => res.json(getDptInfo(req.query.projectId)));

// ── SpaceUsage info ───────────────────────────────────────────────────────────
function getSpaceUsages(projectId) {
  if (_spaceUsageCache[projectId]) return _spaceUsageCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_spaceUsageCache[projectId] = []);
  const root = parseMasterXml(xml);
  const raw = root?.KNX?.MasterData?.SpaceUsages?.SpaceUsage || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  _spaceUsageCache[projectId] = arr.map(su => ({ id: su['@_Id'], number: Number(su['@_Number']), text: su['@_Text'] || '' }));
  return _spaceUsageCache[projectId];
}

router.get('/space-usages', (req, res) => res.json(getSpaceUsages(req.query.projectId)));

// ── Translations ─────────────────────────────────────────────────────────────
const LANG_NAMES = {
  'de-DE':'Deutsch','cs-CZ':'Čeština','da-DK':'Dansk','el-GR':'Ελληνικά',
  'es-ES':'Español','fi-FI':'Suomi','fr-FR':'Français','it-IT':'Italiano',
  'ja-JP':'日本語','nb-NO':'Norsk','nl-NL':'Nederlands','pl-PL':'Polski',
  'pt-PT':'Português','ru-RU':'Русский','sv-SE':'Svenska','tr-TR':'Türkçe',
  'zh-CN':'中文','uk-UA':'Українська'
};

function getTranslations(projectId) {
  if (_translationCache[projectId]) return _translationCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_translationCache[projectId] = { languages: [], translations: {} });
  const root = parseMasterXml(xml);
  const md = root?.KNX?.MasterData;

  const en = {};
  for (const dpt of toArr(md?.DatapointTypes?.DatapointType)) {
    if (dpt['@_Id'] && dpt['@_Text']) en[dpt['@_Id']] = dpt['@_Text'];
    for (const sub of toArr(dpt?.DatapointSubtypes?.DatapointSubtype)) {
      if (sub['@_Id'] && sub['@_Text']) en[sub['@_Id']] = sub['@_Text'];
    }
  }
  for (const su of toArr(md?.SpaceUsages?.SpaceUsage)) {
    if (su['@_Id'] && su['@_Text']) en[su['@_Id']] = su['@_Text'];
  }
  for (const mt of toArr(md?.MediumTypes?.MediumType)) {
    if (mt['@_Id'] && mt['@_Text']) en[mt['@_Id']] = mt['@_Text'];
  }
  for (const ft of toArr(md?.FunctionTypes?.FunctionType)) {
    if (ft['@_Id'] && ft['@_Text']) en[ft['@_Id']] = ft['@_Text'];
    for (const fp of toArr(ft?.FunctionPoint)) {
      if (fp['@_Id'] && fp['@_Text']) en[fp['@_Id']] = fp['@_Text'];
    }
  }

  const translations = { 'en-US': en };
  const languages = [{ id: 'en-US', name: 'English' }];
  for (const lang of toArr(md?.Languages?.Language)) {
    const langId = lang['@_Identifier'];
    if (!langId) continue;
    languages.push({ id: langId, name: LANG_NAMES[langId] || langId });
    const langTexts = {};
    for (const tu of toArr(lang?.TranslationUnit)) {
      for (const te of toArr(tu?.TranslationElement)) {
        const refId = te['@_RefId'];
        if (!refId) continue;
        for (const tr of toArr(te?.Translation)) {
          if (tr['@_AttributeName'] === 'Text' && tr['@_Text']) langTexts[refId] = tr['@_Text'];
        }
      }
    }
    translations[langId] = langTexts;
  }

  _translationCache[projectId] = { languages, translations };
  return _translationCache[projectId];
}

router.get('/translations', (req, res) => res.json(getTranslations(req.query.projectId)));

// ── MediumType info ──────────────────────────────────────────────────────────
function getMediumTypes(projectId) {
  if (_mediumTypeCache[projectId]) return _mediumTypeCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_mediumTypeCache[projectId] = {});
  const root = parseMasterXml(xml);
  const raw = root?.KNX?.MasterData?.MediumTypes?.MediumType || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const result = {};
  for (const mt of arr) result[mt['@_Name'] || ''] = mt['@_Text'] || '';
  return (_mediumTypeCache[projectId] = result);
}

router.get('/medium-types', (req, res) => res.json(getMediumTypes(req.query.projectId)));

// ── Mask version info ────────────────────────────────────────────────────────
function getMaskVersions(projectId) {
  if (_maskVersionCache[projectId]) return _maskVersionCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_maskVersionCache[projectId] = {});
  const root = parseMasterXml(xml);
  const raw = root?.KNX?.MasterData?.MaskVersions?.MaskVersion || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const result = {};
  for (const mv of arr) {
    const num = parseInt(mv['@_MaskVersion']);
    if (isNaN(num)) continue;
    const hex = num.toString(16).padStart(4, '0');
    if (!result[hex]) {
      result[hex] = {
        name: mv['@_Name'] || '',
        managementModel: mv['@_ManagementModel'] || '',
        medium: mv['@_MediumTypeRefId'] || '',
      };
    }
  }
  return (_maskVersionCache[projectId] = result);
}

router.get('/mask-versions', (req, res) => res.json(getMaskVersions(req.query.projectId)));

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const rows = db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

// rebuildDemoMap is injected after construction via setRebuildDemoMap
let _rebuildDemoMap = () => {};
function setRebuildDemoMap(fn) { _rebuildDemoMap = fn; }

router.patch('/settings', (req, res) => {
  const allowed = new Set(['knxip_host', 'knxip_port', 'active_project_id', 'demo_mode', 'demo_addr_map']);
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.has(k)) db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, String(v)]);
  }
  if (req.body.demo_mode !== undefined || req.body.demo_addr_map !== undefined) {
    _rebuildDemoMap();
  }
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Topology ─────────────────────────────────────────────────────────────────
router.get('/projects/:pid/topology', (req, res) => {
  res.json(db.all('SELECT * FROM topology WHERE project_id=? ORDER BY area, line', [+req.params.pid]));
});

router.post('/projects/:pid/topology', (req, res) => {
  const pid = +req.params.pid;
  const { area, line, name, medium } = req.body;
  if (area === undefined) return res.status(400).json({ error: 'area required' });
  const { lastInsertRowid } = db.run(
    'INSERT OR REPLACE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
    [pid, area, line ?? null, name || '', medium || 'TP']
  );
  const label = line != null ? `${area}.${line}` : `Area ${area}`;
  db.audit(pid, 'create', 'topology', label, `Created ${line != null ? 'line' : 'area'} "${name || label}"`);
  db.scheduleSave();
  res.json(db.get('SELECT * FROM topology WHERE id=?', [lastInsertRowid]));
});

router.put('/projects/:pid/topology/:tid', (req, res) => {
  const { pid, tid } = req.params;
  const b = req.body;
  const old = db.get('SELECT * FROM topology WHERE id=? AND project_id=?', [+tid, +pid]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { track, sets, vals, diffs } = makeTracker(old);
  if (b.name !== undefined) track('name', b.name);
  if (b.medium !== undefined) track('medium', b.medium);
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(+tid);
  db.run(`UPDATE topology SET ${sets.join(', ')} WHERE id=?`, vals);
  const label = old.line != null ? `${old.area}.${old.line}` : `Area ${old.area}`;
  db.audit(+pid, 'update', 'topology', label, diffs.join('; '));
  db.scheduleSave();
  res.json({ ok: true });
});

router.delete('/projects/:pid/topology/:tid', (req, res) => {
  const { pid, tid } = req.params;
  const old = db.get('SELECT * FROM topology WHERE id=? AND project_id=?', [+tid, +pid]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  db.run('DELETE FROM topology WHERE id=?', [+tid]);
  const label = old.line != null ? `${old.area}.${old.line}` : `Area ${old.area}`;
  db.audit(+pid, 'delete', 'topology', label, `Deleted ${old.line != null ? 'line' : 'area'} "${old.name || label}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Spaces ───────────────────────────────────────────────────────────────────
router.post('/projects/:pid/spaces', (req, res) => {
  const pid = +req.params.pid;
  const b = req.body;
  if (!b.name?.trim()) return res.status(400).json({ error: 'name required' });
  const { lastInsertRowid } = db.run(
    'INSERT INTO spaces (project_id, name, type, parent_id, sort_order, usage_id) VALUES (?,?,?,?,?,?)',
    [pid, b.name.trim(), b.type || 'Room', b.parent_id || null, b.sort_order ?? 0, b.usage_id || '']
  );
  const space = db.get('SELECT * FROM spaces WHERE id=?', [lastInsertRowid]);
  db.audit(pid, 'create', 'space', b.name.trim(), `Created ${b.type || 'Room'} "${b.name.trim()}"`);
  db.scheduleSave();
  res.json(space);
});

router.delete('/projects/:pid/spaces/:sid', (req, res) => {
  const { pid, sid } = req.params;
  const old = db.get('SELECT * FROM spaces WHERE id=? AND project_id=?', [+sid, +pid]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  // Unassign devices from this space
  db.run('UPDATE devices SET space_id=NULL WHERE space_id=? AND project_id=?', [+sid, +pid]);
  // Reparent child spaces to this space's parent
  db.run('UPDATE spaces SET parent_id=? WHERE parent_id=? AND project_id=?', [old.parent_id || null, +sid, +pid]);
  db.run('DELETE FROM spaces WHERE id=?', [+sid]);
  db.audit(+pid, 'delete', 'space', old.name || sid, `Deleted ${old.type} "${old.name}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

router.put('/projects/:pid/spaces/:sid', (req, res) => {
  const { pid, sid } = req.params;
  const b = req.body;
  const old = db.get('SELECT * FROM spaces WHERE id=? AND project_id=?', [+sid, +pid]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { track, sets, vals, diffs } = makeTracker(old);
  if (b.name !== undefined) track('name', b.name.trim());
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(+sid);
  db.run(`UPDATE spaces SET ${sets.join(', ')} WHERE id=?`, vals);
  db.audit(+pid, 'update', 'space', old.name || sid, diffs.join('; '));
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/projects/:id/audit-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  res.json(db.all(
    'SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?',
    [+req.params.id, limit]
  ));
});

router.get('/projects/:id/audit-log/csv', (req, res) => {
  const rows = db.all(
    'SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC',
    [+req.params.id]
  );
  const escape = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const header = 'timestamp,action,entity,entity_id,detail';
  const lines = rows.map(r =>
    [r.timestamp, r.action, r.entity, r.entity_id, r.detail].map(escape).join(',')
  );
  const csv = [header, ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${req.params.id}.csv"`);
  res.send(csv);
});

// ── Telegrams ─────────────────────────────────────────────────────────────────
router.get('/projects/:id/telegrams', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(db.all('SELECT * FROM bus_telegrams WHERE project_id=? ORDER BY id DESC LIMIT ?', [+req.params.id, limit]));
});

router.delete('/projects/:id/telegrams', (req, res) => {
  db.run('DELETE FROM bus_telegrams WHERE project_id=?', [+req.params.id]);
  db.scheduleSave();
  res.json({ ok: true });
});

module.exports = router;
module.exports.setRebuildDemoMap = setRebuildDemoMap;
