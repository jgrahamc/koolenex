'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const { parseKnxproj } = require('./ets-parser');
const bus     = require('./knx-bus');
const { XMLParser } = require('fast-xml-parser');

// ── Per-project knx_master.xml ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const APPS_DIR = path.join(DATA_DIR, 'apps');
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

function masterXmlPath(projectId) {
  return path.join(DATA_DIR, `knx_master_${projectId}.xml`);
}

function saveMasterXml(projectId, xml) {
  if (!xml) return;
  fs.writeFileSync(masterXmlPath(projectId), xml);
}

function readMasterXml(projectId) {
  if (!projectId) return null;
  const p = masterXmlPath(projectId);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Caches keyed by projectId
const _dptInfoCache = {};
const _spaceUsageCache = {};
const _translationCache = {};
const _mediumTypeCache = {};
const _maskVersionCache = {};

const toArr = v => v == null ? [] : Array.isArray(v) ? v : [v];

function parseMasterXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: name => ['DatapointType','DatapointSubtype','Float','UnsignedInteger','SignedInteger',
      'Enumeration','EnumValue','Bit','MaskVersion','Language','TranslationUnit',
      'TranslationElement','Translation','SpaceUsage','MediumType','FunctionType','FunctionPoint'].includes(name),
  });
  return parser.parse(xml);
}

function getDptInfo(projectId) {
  if (_dptInfoCache[projectId]) return _dptInfoCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_dptInfoCache[projectId] = {});
  const root = parseMasterXml(xml);
  const dptTypes = root?.KNX?.MasterData?.DatapointTypes?.DatapointType || [];
  const result = {};
  for (const dpt of dptTypes) {
    const mainNum = dpt['@_Number'];
    const sizeInBit = parseInt(dpt['@_SizeInBit']) || 0;
    for (const sub of toArr(dpt?.DatapointSubtypes?.DatapointSubtype)) {
      const key = `${mainNum}.${String(sub['@_Number']).padStart(3, '0')}`;
      const fmt = sub?.Format || {};
      let unit = '', enums = null, coefficient = null;

      for (const tag of ['Float','UnsignedInteger','SignedInteger']) {
        const arr = toArr(fmt[tag]);
        if (arr.length) {
          unit = arr[0]['@_Unit'] || '';
          if (arr[0]['@_Coefficient']) coefficient = parseFloat(arr[0]['@_Coefficient']);
          break;
        }
      }

      const bits = toArr(fmt.Bit);
      if (bits.length) {
        const b = bits[0];
        enums = { 0: b['@_Cleared'] || '0', 1: b['@_Set'] || '1' };
      }

      const enumEl = toArr(fmt.Enumeration);
      if (enumEl.length) {
        enums = {};
        for (const ev of toArr(enumEl[0].EnumValue)) {
          enums[Number(ev['@_Value'])] = ev['@_Text'] || String(ev['@_Value']);
        }
      }

      result[key] = {
        name: sub['@_Name'] || '',
        text: sub['@_Text'] || '',
        unit, sizeInBit,
        ...(coefficient != null ? { coefficient } : {}),
        ...(enums ? { enums } : {}),
      };
    }
  }
  return (_dptInfoCache[projectId] = result);
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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


// ── Projects ──────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  res.json(db.all('SELECT * FROM projects ORDER BY updated_at DESC'));
});

router.post('/projects', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const { lastInsertRowid } = db.run('INSERT INTO projects (name) VALUES (?)', [name.trim()]);
  db.audit(lastInsertRowid, 'create', 'project', name.trim(), 'Created project');
  db.scheduleSave();
  res.json(db.get('SELECT * FROM projects WHERE id=?', [lastInsertRowid]));
});

router.get('/projects/:id', (req, res) => {
  const data = db.getProjectFull(+req.params.id);
  if (!data) return res.status(404).json({ error: 'not found' });
  res.json(data);
});

router.put('/projects/:id', (req, res) => {
  const { name } = req.body;
  const oldProj = db.get('SELECT name FROM projects WHERE id=?', [+req.params.id]);
  db.run("UPDATE projects SET name=?, updated_at=datetime('now') WHERE id=?", [name, +req.params.id]);
  db.audit(+req.params.id, 'update', 'project', name, `name: "${oldProj?.name ?? ''}" → "${name}"`);
  db.scheduleSave();
  res.json(db.get('SELECT * FROM projects WHERE id=?', [+req.params.id]));
});

router.delete('/projects/:id', (req, res) => {
  // Cascade manually (sql.js doesn't enforce FK by default in all cases)
  const pid = +req.params.id;
  db.transaction(({ run }) => {
    const devIds = db.all('SELECT id FROM devices WHERE project_id=?', [pid]).map(r => r.id);
    const gaIds  = db.all('SELECT id FROM group_addresses WHERE project_id=?', [pid]).map(r => r.id);
    if (devIds.length) {
      run(`DELETE FROM com_objects WHERE device_id IN (${devIds.join(',')})`, []);
      run(`DELETE FROM devices WHERE project_id=?`, [pid]);
    }
    if (gaIds.length) {
      run(`DELETE FROM group_addresses WHERE project_id=?`, [pid]);
    }
    run('DELETE FROM bus_telegrams WHERE project_id=?', [pid]);
    run('DELETE FROM ga_group_names WHERE project_id=?', [pid]);
    run('DELETE FROM catalog_sections WHERE project_id=?', [pid]);
    run('DELETE FROM catalog_items WHERE project_id=?', [pid]);
    run('DELETE FROM audit_log WHERE project_id=?', [pid]);
    run('DELETE FROM spaces WHERE project_id=?', [pid]);
    run('DELETE FROM projects WHERE id=?', [pid]);
  });
  res.json({ ok: true });
});

// ── ETS6 Import ───────────────────────────────────────────────────────────────
router.post('/projects/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.knxproj'))
    return res.status(400).json({ error: 'File must be a .knxproj file' });

  let parsed;
  try {
    parsed = parseKnxproj(req.file.buffer, req.body.password || null);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED')
      return res.status(422).json({ error: 'Project is password-protected', code: 'PASSWORD_REQUIRED' });
    if (err.code === 'PASSWORD_INCORRECT')
      return res.status(422).json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
    console.error('ETS parse error:', err);
    return res.status(422).json({ error: `Parse failed: ${err.message}` });
  }

  const { projectName, devices, groupAddresses, comObjects, links, spaces, devSpaceMap, paramModels, thumbnail, projectInfo, knxMasterXml, catalogSections, catalogItems } = parsed;

  try {
    const projectId = db.transaction(({ run, all }) => {
      const { lastInsertRowid: pid } = run(
        'INSERT INTO projects (name, file_name, thumbnail, project_info) VALUES (?,?,?,?)',
        [projectName, req.file.originalname, thumbnail || '', JSON.stringify(projectInfo || {})]
      );

      // Insert spaces first so we can reference their DB ids for devices
      const spaceDbIds = [];  // parallel array: parser index → DB id
      for (const s of spaces) {
        const parentDbId = s.parent_idx != null ? spaceDbIds[s.parent_idx] : null;
        const { lastInsertRowid } = run(
          'INSERT INTO spaces (project_id,name,type,usage_id,parent_id,sort_order) VALUES (?,?,?,?,?,?)',
          [pid, s.name, s.type, s.usage_id || '', parentDbId, s.sort_order]
        );
        spaceDbIds.push(lastInsertRowid);
      }

      const deviceIdMap = {};
      for (const d of devices) {
        const spaceIdx = devSpaceMap[d.individual_address];
        const spaceId  = spaceIdx != null ? spaceDbIds[spaceIdx] : null;
        const { lastInsertRowid } = run(`
          INSERT OR REPLACE INTO devices
          (project_id,individual_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,parameters,app_ref,param_values,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pid, d.individual_address, d.name, d.description||'', d.comment||'', d.installation_hints||'',
           d.manufacturer||'', d.model||'', d.order_number||'', d.serial_number||'',
           d.product_ref||'', d.area, d.line, d.device_type, d.status||'unassigned',
           d.last_modified||'', d.last_download||'', '', '', spaceId, d.medium||'TP',
           JSON.stringify(d.parameters || []), d.app_ref||'', JSON.stringify(d.param_values||{}),
           JSON.stringify(d.model_translations||{}),
           d.bus_current||0, d.width_mm||0, d.is_power_supply?1:0, d.is_coupler?1:0, d.is_rail_mounted?1:0]);
        deviceIdMap[d.individual_address] = lastInsertRowid;
      }

      const gaIdMap = {};
      for (const g of groupAddresses) {
        const { lastInsertRowid } = run(`
          INSERT OR REPLACE INTO group_addresses
          (project_id,address,name,dpt,comment,description,main_g,middle_g,sub_g)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [pid, g.address, g.name, g.dpt||'', g.comment||'', g.description||'',
           g.main||0, g.middle||0, g.sub||0]);
        gaIdMap[g.address] = lastInsertRowid;
        // Store group names in the dedicated table
        if (g.mainGroupName) {
          run('INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,-1,?)',
            [pid, g.main||0, g.mainGroupName]);
        }
        if (g.middleGroupName) {
          run('INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
            [pid, g.main||0, g.middle||0, g.middleGroupName]);
        }
      }

      for (const co of comObjects) {
        const devId = deviceIdMap[co.device_address];
        if (!devId) continue;
        run(`INSERT INTO com_objects
          (project_id,device_id,object_number,channel,name,function_text,dpt,object_size,flags,direction,ga_address,ga_send,ga_receive)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pid, devId, co.object_number||0, co.channel||'', co.name||'', co.function_text||'',
           co.dpt||'', co.object_size||'', co.flags||'CW', co.direction||'both', co.ga_address||'',
           co.ga_send||'', co.ga_receive||'']);
      }

      // Insert catalog sections and items
      for (const sec of (catalogSections || [])) {
        run('INSERT OR REPLACE INTO catalog_sections (id,project_id,name,number,parent_id,mfr_id,manufacturer) VALUES (?,?,?,?,?,?,?)',
          [sec.id, pid, sec.name, sec.number||'', sec.parent_id||null, sec.mfr_id||'', sec.manufacturer||'']);
      }
      for (const item of (catalogItems || [])) {
        run('INSERT OR REPLACE INTO catalog_items (id,project_id,name,number,description,section_id,product_ref,h2p_ref,order_number,manufacturer,mfr_id,model,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [item.id, pid, item.name, item.number||'', item.description||'', item.section_id||'', item.product_ref||'', item.h2p_ref||'', item.order_number||'', item.manufacturer||'', item.mfr_id||'', item.model||'', item.bus_current||0, item.width_mm||0, item.is_power_supply?1:0, item.is_coupler?1:0, item.is_rail_mounted?1:0]);
      }

      return pid;
    });

    const data = db.getProjectFull(projectId);

    // Save param models and master XML to disk
    if (paramModels) {
      for (const [appId, model] of Object.entries(paramModels)) {
        try {
          const safe = appId.replace(/[^a-zA-Z0-9_\-]/g, '_');
          fs.writeFileSync(path.join(APPS_DIR, safe + '.json'), JSON.stringify(model));
        } catch (_) {}
      }
    }
    if (knxMasterXml) saveMasterXml(projectId, knxMasterXml);

    db.audit(projectId, 'import', 'project', req.file.originalname,
      `Imported ${devices.length} devices, ${groupAddresses.length} group addresses, ${comObjects.length} com objects`);

    res.json({
      ok: true, projectId,
      summary: { devices: devices.length, groupAddresses: groupAddresses.length,
                 comObjects: comObjects.length, links: links.length },
      data,
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ── ETS6 Reimport (update existing project in-place) ──────────────────────────
router.post('/projects/:id/reimport', upload.single('file'), (req, res) => {
  const pid = +req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.knxproj'))
    return res.status(400).json({ error: 'File must be a .knxproj file' });

  const project = db.get('SELECT * FROM projects WHERE id=?', [pid]);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let parsed;
  try {
    parsed = parseKnxproj(req.file.buffer, req.body.password || null);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED')
      return res.status(422).json({ error: 'Project is password-protected', code: 'PASSWORD_REQUIRED' });
    if (err.code === 'PASSWORD_INCORRECT')
      return res.status(422).json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
    console.error('ETS reimport parse error:', err);
    return res.status(422).json({ error: `Parse failed: ${err.message}` });
  }

  const { projectName, devices, groupAddresses, comObjects, links, spaces, devSpaceMap, paramModels, thumbnail, projectInfo, knxMasterXml, catalogSections, catalogItems } = parsed;

  try {
    db.transaction(({ run, all }) => {
      // Clear existing data for this project
      const gaIds = all('SELECT id FROM group_addresses WHERE project_id=?', [pid]).map(r => r.id);
      run('DELETE FROM com_objects WHERE project_id=?', [pid]);
      run('DELETE FROM group_addresses WHERE project_id=?', [pid]);
      run('DELETE FROM devices WHERE project_id=?', [pid]);
      run('DELETE FROM catalog_sections WHERE project_id=?', [pid]);
      run('DELETE FROM catalog_items WHERE project_id=?', [pid]);
      run('DELETE FROM spaces WHERE project_id=?', [pid]);
      run('UPDATE projects SET name=?, file_name=?, thumbnail=?, project_info=?, updated_at=datetime(\'now\') WHERE id=?',
        [projectName, req.file.originalname, thumbnail || '', JSON.stringify(projectInfo || {}), pid]);

      // Re-insert spaces
      const spaceDbIds = [];
      for (const s of spaces) {
        const parentDbId = s.parent_idx != null ? spaceDbIds[s.parent_idx] : null;
        const { lastInsertRowid } = run(
          'INSERT INTO spaces (project_id,name,type,usage_id,parent_id,sort_order) VALUES (?,?,?,?,?,?)',
          [pid, s.name, s.type, s.usage_id || '', parentDbId, s.sort_order]
        );
        spaceDbIds.push(lastInsertRowid);
      }

      // Re-insert devices
      const deviceIdMap = {};
      for (const d of devices) {
        const spaceIdx = devSpaceMap[d.individual_address];
        const spaceId  = spaceIdx != null ? spaceDbIds[spaceIdx] : null;
        const { lastInsertRowid } = run(`
          INSERT OR IGNORE INTO devices
          (project_id,individual_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,parameters,app_ref,param_values,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pid, d.individual_address, d.name, d.description||'', d.comment||'', d.installation_hints||'',
           d.manufacturer||'', d.model||'', d.order_number||'', d.serial_number||'',
           d.product_ref||'', d.area, d.line, d.device_type, d.status||'unassigned',
           d.last_modified||'', d.last_download||'', '', '', spaceId, d.medium||'TP',
           JSON.stringify(d.parameters || []), d.app_ref||'', JSON.stringify(d.param_values||{}),
           JSON.stringify(d.model_translations||{}),
           d.bus_current||0, d.width_mm||0, d.is_power_supply?1:0, d.is_coupler?1:0, d.is_rail_mounted?1:0]);
        deviceIdMap[d.individual_address] = lastInsertRowid;
      }

      // Re-insert GAs
      run('DELETE FROM ga_group_names WHERE project_id=?', [pid]);
      const gaIdMap = {};
      for (const g of groupAddresses) {
        const { lastInsertRowid } = run(`
          INSERT INTO group_addresses
          (project_id,address,name,dpt,comment,description,main_g,middle_g,sub_g)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [pid, g.address, g.name, g.dpt||'', g.comment||'', g.description||'',
           g.main||0, g.middle||0, g.sub||0]);
        gaIdMap[g.address] = lastInsertRowid;
        if (g.mainGroupName) {
          run('INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,-1,?)',
            [pid, g.main||0, g.mainGroupName]);
        }
        if (g.middleGroupName) {
          run('INSERT OR REPLACE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
            [pid, g.main||0, g.middle||0, g.middleGroupName]);
        }
      }

      // Re-insert com objects
      for (const co of comObjects) {
        const devId = deviceIdMap[co.device_address];
        if (!devId) continue;
        run(`INSERT INTO com_objects
          (project_id,device_id,object_number,channel,name,function_text,dpt,object_size,flags,direction,ga_address,ga_send,ga_receive)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [pid, devId, co.object_number||0, co.channel||'', co.name||'', co.function_text||'',
           co.dpt||'', co.object_size||'', co.flags||'CW', co.direction||'both', co.ga_address||'',
           co.ga_send||'', co.ga_receive||'']);
      }

      // Re-insert catalog
      for (const sec of (catalogSections || [])) {
        run('INSERT OR REPLACE INTO catalog_sections (id,project_id,name,number,parent_id,mfr_id,manufacturer) VALUES (?,?,?,?,?,?,?)',
          [sec.id, pid, sec.name, sec.number||'', sec.parent_id||null, sec.mfr_id||'', sec.manufacturer||'']);
      }
      for (const item of (catalogItems || [])) {
        run('INSERT OR REPLACE INTO catalog_items (id,project_id,name,number,description,section_id,product_ref,h2p_ref,order_number,manufacturer,mfr_id,model,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [item.id, pid, item.name, item.number||'', item.description||'', item.section_id||'', item.product_ref||'', item.h2p_ref||'', item.order_number||'', item.manufacturer||'', item.mfr_id||'', item.model||'', item.bus_current||0, item.width_mm||0, item.is_power_supply?1:0, item.is_coupler?1:0, item.is_rail_mounted?1:0]);
      }

    });

    const data = db.getProjectFull(pid);

    // Save param models and master XML to disk
    if (paramModels) {
      for (const [appId, model] of Object.entries(paramModels)) {
        try {
          const safe = appId.replace(/[^a-zA-Z0-9_\-]/g, '_');
          fs.writeFileSync(path.join(APPS_DIR, safe + '.json'), JSON.stringify(model));
        } catch (_) {}
      }
    }
    if (knxMasterXml) saveMasterXml(pid, knxMasterXml);

    db.audit(pid, 'reimport', 'project', req.file.originalname,
      `Reimported ${devices.length} devices, ${groupAddresses.length} group addresses, ${comObjects.length} com objects`);

    res.json({
      ok: true, projectId: pid,
      summary: { devices: devices.length, groupAddresses: groupAddresses.length,
                 comObjects: comObjects.length, links: links.length },
      data,
    });
  } catch (err) {
    console.error('Reimport error:', err);
    res.status(500).json({ error: `Reimport failed: ${err.message}` });
  }
});

// ── Devices ───────────────────────────────────────────────────────────────────
router.get('/projects/:id/devices', (req, res) => {
  res.json(db.all(`SELECT * FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`, [+req.params.id]));
});

router.post('/projects/:id/devices', (req, res) => {
  const b = req.body, pid = +req.params.id;
  const { lastInsertRowid } = db.run(`
    INSERT OR REPLACE INTO devices
    (project_id,individual_address,name,description,comment,manufacturer,model,order_number,serial_number,product_ref,area,line,device_type,status,last_modified,last_download,app_number,app_version,space_id,medium,area_name,line_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [pid, b.individual_address, b.name||b.individual_address,
     b.description||'', b.comment||'', b.manufacturer||'', b.model||'',
     b.order_number||'', b.serial_number||'', b.product_ref||'',
     b.area||1, b.line||1, b.device_type||'generic', 'unassigned', '','','','',
     b.space_id||null, b.medium||'TP', b.area_name||'', b.line_name||'']);
  db.audit(pid, 'create', 'device', b.individual_address, `Created device "${b.name || b.individual_address}"`);
  db.scheduleSave();
  res.json(db.get('SELECT * FROM devices WHERE id=?', [lastInsertRowid]));
});

router.put('/projects/:pid/devices/:did', (req, res) => {
  const { pid, did } = req.params;
  const b = req.body;
  if (b.name !== undefined && !b.name?.trim()) return res.status(400).json({ error: 'name required' });
  const old = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [+did, +pid]);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const sets = [], vals = [], diffs = [];
  const track = (col, newVal) => { sets.push(`${col}=?`); vals.push(newVal); diffs.push(`${col}: "${old[col] ?? ''}" → "${newVal}"`); };
  if (b.name !== undefined)              track('name', b.name.trim());
  if (b.device_type !== undefined)       track('device_type', b.device_type || 'generic');
  if (b.description !== undefined)       track('description', b.description);
  if (b.comment !== undefined)           track('comment', b.comment);
  if (b.installation_hints !== undefined) track('installation_hints', b.installation_hints);
  if (b.floor_x !== undefined) { sets.push('floor_x=?'); vals.push(b.floor_x); }
  if (b.floor_y !== undefined) { sets.push('floor_y=?'); vals.push(b.floor_y); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(+did);
  db.run(`UPDATE devices SET ${sets.join(', ')} WHERE id=?`, vals);
  db.audit(+pid, 'update', 'device', old.individual_address || did, diffs.join('; ') || 'Updated position');
  db.scheduleSave();
  res.json({ ok: true });
});

router.post('/projects/:pid/floor-plan/:spaceId', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { pid, spaceId } = req.params;
  const dir = path.join(DATA_DIR, 'floorplans');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(req.file.originalname) || '.png';
  const fname = `${pid}_${spaceId}${ext}`;
  fs.writeFileSync(path.join(dir, fname), req.file.buffer);
  res.json({ ok: true, fileName: fname });
});

router.get('/projects/:pid/floor-plan/:spaceId', (req, res) => {
  const { pid, spaceId } = req.params;
  const dir = path.join(DATA_DIR, 'floorplans');
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No floor plan' });
  const files = fs.readdirSync(dir).filter(f => f.startsWith(`${pid}_${spaceId}.`));
  if (!files.length) return res.status(404).json({ error: 'No floor plan' });
  const filePath = path.join(dir, files[0]);
  res.sendFile(filePath);
});

router.delete('/projects/:pid/floor-plan/:spaceId', (req, res) => {
  const { pid, spaceId } = req.params;
  const dir = path.join(DATA_DIR, 'floorplans');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(f => f.startsWith(`${pid}_${spaceId}.`))) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  res.json({ ok: true });
});

router.patch('/projects/:pid/devices/:did/status', (req, res) => {
  const devS = db.get('SELECT individual_address, name, status FROM devices WHERE id=?', [+req.params.did]);
  db.run('UPDATE devices SET status=? WHERE id=?', [req.body.status, +req.params.did]);
  db.audit(+req.params.pid, 'update', 'device', devS?.individual_address || req.params.did,
    `status: "${devS?.status ?? ''}" → "${req.body.status}" on "${devS?.name || req.params.did}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

router.delete('/projects/:pid/devices/:did', (req, res) => {
  const did = +req.params.did;
  const devD = db.get('SELECT individual_address, name FROM devices WHERE id=?', [did]);
  db.run('DELETE FROM com_objects WHERE device_id=?', [did]);
  db.run('DELETE FROM devices WHERE id=?', [did]);
  db.audit(+req.params.pid, 'delete', 'device', devD?.individual_address || did, `Deleted device "${devD?.name || did}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

router.get('/projects/:pid/devices/:did/param-model', (req, res) => {
  const dev = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [+req.params.did, +req.params.pid]);
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  if (!dev.app_ref) return res.status(404).json({ error: 'no_model', message: 'No param model available. Re-import the project to enable editing.' });
  const safe = dev.app_ref.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath)) return res.status(404).json({ error: 'no_model', message: 'Param model file not found. Re-import the project.' });
  let model;
  try { model = JSON.parse(fs.readFileSync(modelPath, 'utf8')); }
  catch (e) { return res.status(500).json({ error: 'Failed to read param model' }); }
  let currentValues = {};
  try { currentValues = JSON.parse(dev.param_values || '{}'); } catch (_) {}
  res.json({ ...model, currentValues });
});

router.patch('/projects/:pid/devices/:did/param-values', (req, res) => {
  const devPV = db.get('SELECT * FROM devices WHERE id=? AND project_id=?', [+req.params.did, +req.params.pid]);
  if (!devPV) return res.status(404).json({ error: 'Not found' });
  let oldVals = {};
  try { oldVals = JSON.parse(devPV.param_values || '{}'); } catch (_) {}
  const newVals = req.body;
  const diffs = [];
  for (const k of Object.keys(newVals)) {
    const ov = oldVals[k], nv = newVals[k];
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      diffs.push(`${k}: "${ov ?? ''}" → "${nv}"`);
    }
  }
  db.run('UPDATE devices SET param_values=? WHERE id=?', [JSON.stringify(newVals), +req.params.did]);
  db.audit(+req.params.pid, 'update', 'param_values', devPV.individual_address || req.params.did,
    diffs.join('; ') || `Updated parameters on "${devPV.name || req.params.did}"`);
  db.scheduleSave();
  res.json({ ok: true });
});

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
  const sets = [], vals = [], diffs = [];
  const track = (col, newVal) => { sets.push(`${col}=?`); vals.push(newVal); diffs.push(`${col}: "${oldGA[col] ?? ''}" → "${newVal}"`); };
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
  const sets = [], vals = [], diffs = [];
  const track = (col, newVal) => { sets.push(`${col}=?`); vals.push(newVal); diffs.push(`${col}: "${old[col] ?? ''}" → "${newVal}"`); };
  if (b.name !== undefined) track('name', b.name.trim());
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(+sid);
  db.run(`UPDATE spaces SET ${sets.join(', ')} WHERE id=?`, vals);
  db.audit(+pid, 'update', 'space', old.name || sid, diffs.join('; '));
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
// Actions: { add: "1/2/3" } — append GA
//          { remove: "1/2/3" } — remove GA
//          { reorder: "1/2/3", position: 0 } — move GA to position
// In KNX, the first GA is the "sending" (main) GA; additional GAs are listeners.
// ga_send and ga_receive are rebuilt from position: first = send+receive, rest = receive only.
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

// ── Catalog ──────────────────────────────────────────────────────────────────
router.get('/projects/:id/catalog', (req, res) => {
  const pid = +req.params.id;
  const sections = db.all('SELECT * FROM catalog_sections WHERE project_id=? ORDER BY manufacturer, number, name', [pid]);
  const items = db.all('SELECT * FROM catalog_items WHERE project_id=? ORDER BY manufacturer, name', [pid]);
  // Mark which product_refs are in use by devices in this project
  const usedRefs = new Set(db.all('SELECT product_ref FROM devices WHERE project_id=?', [pid]).map(r => r.product_ref).filter(Boolean));
  res.json({ sections, items: items.map(i => ({ ...i, in_use: usedRefs.has(i.product_ref) })) });
});

// Import a standalone .knxprod file into a project's catalog
router.post('/projects/:id/catalog/import', upload.single('file'), (req, res) => {
  const pid = +req.params.id;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.knxprod'))
    return res.status(400).json({ error: 'File must be a .knxprod file' });
  const project = db.get('SELECT * FROM projects WHERE id=?', [pid]);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let parsed;
  try {
    parsed = parseKnxproj(req.file.buffer, null);
  } catch (err) {
    console.error('.knxprod parse error:', err);
    return res.status(422).json({ error: `Parse failed: ${err.message}` });
  }

  const { catalogSections = [], catalogItems = [], paramModels, knxMasterXml } = parsed;

  try {
    db.transaction(({ run }) => {
      for (const sec of catalogSections) {
        run('INSERT OR REPLACE INTO catalog_sections (id,project_id,name,number,parent_id,mfr_id,manufacturer) VALUES (?,?,?,?,?,?,?)',
          [sec.id, pid, sec.name, sec.number||'', sec.parent_id||null, sec.mfr_id||'', sec.manufacturer||'']);
      }
      for (const item of catalogItems) {
        run('INSERT OR REPLACE INTO catalog_items (id,project_id,name,number,description,section_id,product_ref,h2p_ref,order_number,manufacturer,mfr_id,model,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [item.id, pid, item.name, item.number||'', item.description||'', item.section_id||'', item.product_ref||'', item.h2p_ref||'', item.order_number||'', item.manufacturer||'', item.mfr_id||'', item.model||'', item.bus_current||0, item.width_mm||0, item.is_power_supply?1:0, item.is_coupler?1:0, item.is_rail_mounted?1:0]);
      }
    });

    // Save param models from .knxprod
    if (paramModels) {
      for (const [appId, model] of Object.entries(paramModels)) {
        try {
          const safe = appId.replace(/[^a-zA-Z0-9_\-]/g, '_');
          fs.writeFileSync(path.join(APPS_DIR, safe + '.json'), JSON.stringify(model));
        } catch (_) {}
      }
    }

    db.audit(pid, 'import', 'catalog', req.file.originalname,
      `Imported catalog: ${catalogSections.length} sections, ${catalogItems.length} items`);

    const sections = db.all('SELECT * FROM catalog_sections WHERE project_id=? ORDER BY manufacturer, number, name', [pid]);
    const items = db.all('SELECT * FROM catalog_items WHERE project_id=? ORDER BY manufacturer, name', [pid]);
    const usedRefs = new Set(db.all('SELECT product_ref FROM devices WHERE project_id=?', [pid]).map(r => r.product_ref).filter(Boolean));
    res.json({ ok: true, sections, items: items.map(i => ({ ...i, in_use: usedRefs.has(i.product_ref) })) });
  } catch (err) {
    console.error('.knxprod import error:', err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
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

// ── KNX Bus ───────────────────────────────────────────────────────────────────
router.get('/bus/status', (req, res) => res.json(bus.status()));

router.post('/bus/connect', async (req, res) => {
  const { host, port, projectId } = req.body;
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const result = await bus.connect(host, parseInt(port)||3671, projectId);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_host',?)", [host]);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_port',?)", [String(port||3671)]);
    db.scheduleSave();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/bus/usb-devices', (req, res) => {
  try {
    const devices = bus.listUsbDevices();
    res.json({ devices });
  } catch (err) {
    res.json({ devices: [], error: err.message });
  }
});

router.get('/bus/usb-devices/all', (req, res) => {
  try {
    const devices = bus.listAllHidDevices();
    res.json({ devices });
  } catch (err) {
    res.json({ devices: [], error: err.message });
  }
});

router.post('/bus/connect-usb', async (req, res) => {
  const { devicePath, projectId } = req.body;
  if (!devicePath) return res.status(400).json({ error: 'devicePath required' });
  try {
    const result = await bus.connectUsb(devicePath, projectId);
    res.json({ ok: true, type: 'usb', ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/bus/project', (req, res) => {
  const { projectId } = req.body;
  bus.projectId = projectId || null;
  res.json({ ok: true });
});

router.post('/bus/disconnect', (req, res) => {
  bus.disconnect();
  res.json({ ok: true });
});

router.post('/bus/write', (req, res) => {
  const { ga, value, dpt, projectId } = req.body;
  if (!ga) return res.status(400).json({ error: 'ga required' });
  try {
    const busGa = unremap(ga); // demo GA → real bus GA
    const result = bus.write(busGa, value, dpt);
    if (projectId) {
      db.run('INSERT INTO bus_telegrams (project_id,src,dst,type,raw_value,decoded,priority) VALUES (?,?,?,?,?,?,?)',
        [projectId, 'local', ga, 'GroupValue_Write', String(value), String(value), 'low']);
      db.scheduleSave();
      bus.broadcast('knx:telegram', {
        telegram: { timestamp: new Date().toISOString(), src:'local', dst:ga, type:'GroupValue_Write', raw_value:String(value), decoded:String(value) },
        projectId,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/bus/read', async (req, res) => {
  try { res.json(await bus.read(req.body.ga)); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// Probe device reachability
router.post('/bus/ping', async (req, res) => {
  const { gaAddresses = [], deviceAddress } = req.body;
  try {
    const result = await bus.ping(gaAddresses, deviceAddress || null);
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('Not connected') ? 409 : 502).json({ error: err.message });
  }
});

// Flash programming LED on device
router.post('/bus/identify', async (req, res) => {
  const { deviceAddress } = req.body;
  if (!deviceAddress) return res.status(400).json({ error: 'deviceAddress required' });
  try {
    await bus.identify(deviceAddress);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes('Not connected') ? 409 : 502).json({ error: err.message });
  }
});

// Bus scan — streams progress via WebSocket, returns immediately
let _activeScan = null;
router.post('/bus/scan', (req, res) => {
  const { area = 1, line = 1, timeout = 200 } = req.body;
  if (!bus.connected) return res.status(409).json({ error: 'Not connected' });
  if (_activeScan) bus.abortScan();
  res.json({ ok: true });
  _activeScan = bus.scan(parseInt(area), parseInt(line), parseInt(timeout), prog => {
    bus.broadcast('scan:progress', prog);
  }).then(results => {
    bus.broadcast('scan:done', { results, area: parseInt(area), line: parseInt(line) });
    _activeScan = null;
  }).catch(err => {
    bus.broadcast('scan:error', { error: err.message });
    _activeScan = null;
  });
});

router.post('/bus/scan/abort', (req, res) => {
  bus.abortScan();
  _activeScan = null;
  res.json({ ok: true });
});

// ── Device info ──────────────────────────────────────────────────────────────
router.post('/bus/device-info', async (req, res) => {
  const { deviceAddress } = req.body;
  if (!deviceAddress) return res.status(400).json({ error: 'deviceAddress required' });
  if (!bus.connected) return res.status(409).json({ error: 'Not connected' });
  try {
    const info = await bus.readDeviceInfo(deviceAddress);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KNX Programming ───────────────────────────────────────────────────────────

// Write individual address (device must be in programming mode)
router.post('/bus/program-ia', async (req, res) => {
  const { newAddr } = req.body;
  if (!newAddr) return res.status(400).json({ error: 'newAddr required' });
  if (!bus.connected) return res.status(409).json({ error: 'Bus not connected' });
  try {
    const result = await bus.programIA(newAddr);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Full application download for a device
router.post('/bus/program-device', async (req, res) => {
  const { deviceAddress, projectId, deviceId } = req.body;
  if (!deviceAddress) return res.status(400).json({ error: 'deviceAddress required' });
  if (!bus.connected) return res.status(409).json({ error: 'Bus not connected' });

  // Load device data
  const dev = deviceId
    ? db.get('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get('SELECT * FROM devices WHERE individual_address=? AND project_id=?', [deviceAddress, +projectId]);
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  // Load app model (load procedures)
  if (!dev.app_ref) return res.status(400).json({ error: 'no_app', message: 'Device has no application program reference. Re-import the project.' });
  const safe = dev.app_ref.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath)) return res.status(400).json({ error: 'no_model', message: 'App model not found. Re-import the project.' });
  let model;
  try { model = JSON.parse(fs.readFileSync(modelPath, 'utf8')); } catch { return res.status(500).json({ error: 'Failed to read app model' }); }
  if (!model.loadProcedures?.length) return res.status(400).json({ error: 'no_ldctrl', message: 'No load procedures found. Re-import the project.' });

  // Build GA table from project data
  const pid = dev.project_id;
  // Build association table from COM objects — derive GA links from com_objects
  const coRows = db.all('SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number', [dev.id]);
  const gaAddrsUsed = new Set();
  for (const co of coRows) for (const a of (co.ga_address || '').split(/\s+/).filter(Boolean)) gaAddrsUsed.add(a);
  const gaLinks = gaAddrsUsed.size > 0
    ? db.all(`SELECT address, main_g, middle_g, sub_g FROM group_addresses WHERE project_id=? AND address IN (${[...gaAddrsUsed].map(() => '?').join(',')}) ORDER BY main_g, middle_g, sub_g`, [dev.project_id, ...gaAddrsUsed])
    : [];

  const gaTable = buildGATable(gaLinks);
  const assocTable = buildAssocTable(coRows, gaLinks);

  // Parameter memory: build from param layout + current values
  const { paramSize, paramFill, relSegHex } = resolveParamSegment(model);
  let paramMem = null;
  if (paramSize > 0 && model.paramMemLayout) {
    let currentValues = {};
    try { currentValues = JSON.parse(dev.param_values || '{}'); } catch (_) {}
    paramMem = buildParamMem(paramSize, model.paramMemLayout, currentValues, paramFill, relSegHex, model.dynTree, model.params);
  } else if (paramSize > 0) {
    paramMem = Buffer.alloc(paramSize, 0xFF);
  }

  // Convert step data from hex strings back to Buffers
  const steps = model.loadProcedures.map(s => ({
    ...s,
    data: s.data ? Buffer.from(s.data, 'hex') : null,
  }));

  // Stream progress via WebSocket
  const onProgress = (p) => bus.broadcast('program:progress', { deviceAddress, ...p });
  onProgress({ msg: `Starting download to ${deviceAddress}`, pct: 0 });

  try {
    await bus.downloadDevice(deviceAddress, steps, gaTable, assocTable, paramMem, onProgress);
    db.run('UPDATE devices SET status=? WHERE id=?', ['programmed', dev.id]);
    db.scheduleSave();
    res.json({ ok: true, deviceAddress });
  } catch (err) {
    onProgress({ msg: `Error: ${err.message}`, pct: -1, error: true });
    res.status(502).json({ error: err.message });
  }
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const rows = db.all('SELECT key, value FROM settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.patch('/settings', (req, res) => {
  const allowed = new Set(['knxip_host', 'knxip_port', 'active_project_id', 'demo_mode', 'demo_addr_map']);
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.has(k)) db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, String(v)]);
  }
  if (req.body.demo_mode !== undefined || req.body.demo_addr_map !== undefined) {
    rebuildDemoMap();
  }
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Demo mode address remapping ──────────────────────────────────────────────
// When demo_mode is enabled, incoming bus addresses (device IAs and GA addresses)
// are remapped so that the real bus traffic matches the anonymized DB.
let _demoDevMap = null; // real IA → demo IA
let _demoGaMap  = null; // real GA → demo GA

function rebuildDemoMap() {
  // The demo address map is used when the active project is the demo project.
  // It's loaded unconditionally — the remapTelegram function checks whether
  // the active project is actually the demo before applying.
  const mapRow = db.get("SELECT value FROM settings WHERE key='demo_addr_map'");
  if (!mapRow || !mapRow.value) {
    _demoDevMap = null;
    _demoGaMap  = null;
    rebuildReverseMaps();
    return;
  }
  try {
    const map = JSON.parse(mapRow.value);
    _demoDevMap = map.devices || null;
    _demoGaMap  = map.gas || null;
    console.log(`[DEMO] Address map loaded: ${Object.keys(_demoDevMap||{}).length} devices, ${Object.keys(_demoGaMap||{}).length} GAs`);
    rebuildReverseMaps();
  } catch (e) {
    console.error('[DEMO] Failed to parse demo_addr_map:', e.message);
    _demoDevMap = null;
    _demoGaMap  = null;
    rebuildReverseMaps();
  }
}

function isDemoProjectActive() {
  // Check the bus manager's current project ID (set during connect)
  const pid = bus.projectId;
  if (!pid) return false;
  const proj = db.get("SELECT name FROM projects WHERE id=?", [+pid]);
  return proj && proj.name.includes('Demo');
}

function remapTelegram(tg) {
  if ((!_demoDevMap && !_demoGaMap) || !isDemoProjectActive()) return tg;
  return {
    ...tg,
    src: (_demoDevMap && _demoDevMap[tg.src]) || tg.src,
    dst: (_demoGaMap && _demoGaMap[tg.dst]) || tg.dst,
  };
}

// Reverse maps: demo address → real bus address (for sending)
let _demoDevMapRev = null;
let _demoGaMapRev  = null;

function rebuildReverseMaps() {
  _demoDevMapRev = _demoDevMap ? Object.fromEntries(Object.entries(_demoDevMap).map(([k,v]) => [v,k])) : null;
  _demoGaMapRev  = _demoGaMap  ? Object.fromEntries(Object.entries(_demoGaMap).map(([k,v]) => [v,k]))  : null;
}

/** Map a demo GA back to the real bus GA for sending */
function unremap(demoAddr) {
  if (!_demoGaMapRev || !isDemoProjectActive()) return demoAddr;
  return _demoGaMapRev[demoAddr] || demoAddr;
}

// Set the remapper on the bus manager so live telegrams are also remapped and decoded
bus.setRemapper((tg) => refineDecode(remapTelegram(tg)));
// Load demo map on startup (after DB is initialized — called from index.js)
setTimeout(() => { try { rebuildDemoMap(); } catch(_) {} }, 0);

// ── DPT-aware telegram decoding ──────────────────────────────────────────────
// The protocol layer decodes without knowing the DPT. Here we refine the
// decoded value using the GA's known DPT (e.g. DPT 5.001: 255 → 100%).
function normalizeDptKey(dpt) {
  if (!dpt) return null;
  const m = dpt.match(/^DPS?T-(\d+)-(\d+)$/i);
  if (m) return `${m[1]}.${m[2].padStart(3, '0')}`;
  if (dpt.includes('.')) { const [a, b] = dpt.split('.'); return `${a}.${b.padStart(3, '0')}`; }
  return null;
}

function refineDecode(tg) {
  if (!tg.projectId || !tg.dst?.includes('/') || !tg.raw_value) return tg;

  const ga = db.get('SELECT dpt FROM group_addresses WHERE project_id=? AND address=?',
    [tg.projectId, tg.dst]);
  if (!ga?.dpt) return tg;

  const key = normalizeDptKey(ga.dpt);
  if (!key) return tg;
  const major = parseInt(key.split('.')[0]);
  const info = getDptInfo(tg.projectId)[key];

  const rawBuf = Buffer.from(tg.raw_value, 'hex');
  if (!rawBuf.length) return tg;

  let decoded = tg.decoded;

  // Use enums if available (e.g. DPT 1: On/Off, DPT 20: HVAC modes)
  if (info?.enums) {
    const v = rawBuf.length === 1 ? rawBuf[0] : rawBuf.readUInt16BE(0);
    if (info.enums[v] !== undefined) return { ...tg, decoded: info.enums[v] };
  }

  // Re-decode from raw bytes using correct format for the DPT major type
  if (rawBuf.length === 1) {
    const v = rawBuf[0];
    const coeff = info?.coefficient;
    decoded = coeff ? (v * coeff).toFixed(1).replace(/\.0$/, '') : String(v);
  } else if (rawBuf.length === 2) {
    if (major === 9) {
      // DPT 9: KNX 2-byte float
      const raw = rawBuf.readUInt16BE(0);
      const sign = (raw >> 15) & 1, exp = (raw >> 11) & 0xF, mant = raw & 0x7FF;
      const signedMant = sign ? mant - 2048 : mant;
      const v = 0.01 * signedMant * Math.pow(2, exp);
      decoded = v.toFixed(2);
    } else if (major === 7) {
      // DPT 7: 16-bit unsigned integer
      const v = rawBuf.readUInt16BE(0);
      const coeff = info?.coefficient;
      decoded = coeff ? (v * coeff).toFixed(1).replace(/\.0$/, '') : String(v);
    } else if (major === 8) {
      // DPT 8: 16-bit signed integer
      const v = rawBuf.readInt16BE(0);
      const coeff = info?.coefficient;
      decoded = coeff ? (v * coeff).toFixed(1).replace(/\.0$/, '') : String(v);
    }
  } else if (rawBuf.length === 4 && major === 14) {
    // DPT 14: 32-bit IEEE 754 float
    decoded = rawBuf.readFloatBE(0).toFixed(2);
  }

  return { ...tg, decoded };
}

// Persist incoming telegrams from live bus
// (telegram already has projectId and has been through remap + refineDecode via bus remapper)
bus.on('telegram', (tg) => {
  if (!tg.projectId) return;
  try {
    db.run('INSERT INTO bus_telegrams (project_id,src,dst,type,raw_value,decoded,priority) VALUES (?,?,?,?,?,?,?)',
      [tg.projectId, tg.src, tg.dst, tg.type, tg.raw_value, tg.decoded, tg.priority||'low']);
    db.scheduleSave(500);
  } catch(_) {}
});

// ── KNX table builders ────────────────────────────────────────────────────────

// Build GA table bytes: [count(1)] + [GA_encoded(2) × count]
// gaLinks: array of { main_g, middle_g, sub_g }
function buildGATable(gaLinks) {
  const count = gaLinks.length;
  const buf = Buffer.alloc(1 + count * 2);
  buf[0] = count & 0xFF;
  gaLinks.forEach((ga, i) => {
    const b0 = ((ga.main_g & 0x1F) << 3) | (ga.middle_g & 0x07);
    const b1 = ga.sub_g & 0xFF;
    buf[1 + i * 2] = b0;
    buf[2 + i * 2] = b1;
  });
  return buf;
}


// Build association table bytes: [count(1)] + [CO_num(1), GA_idx(1)] × count
// coRows: array of { object_number, ga_address } from com_objects
// gaLinks: sorted GA list (GA index = position in sorted list)
function buildAssocTable(coRows, gaLinks) {
  const gaIndexMap = {};
  gaLinks.forEach((ga, i) => { gaIndexMap[ga.address] = i; });

  const entries = [];
  for (const co of coRows) {
    const gas = (co.ga_address || '').split(/\s+/).filter(Boolean);
    for (const gaAddr of gas) {
      const gaIdx = gaIndexMap[gaAddr];
      if (gaIdx != null) entries.push([co.object_number & 0xFF, gaIdx & 0xFF]);
    }
  }

  entries.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const buf = Buffer.alloc(1 + entries.length * 2);
  buf[0] = entries.length & 0xFF;
  entries.forEach(([co, ga], i) => { buf[1 + i * 2] = co; buf[2 + i * 2] = ga; });
  return buf;
}

// Test whether a numeric/string value matches an ETS when-test condition.
// Tests can be exact values or relational operators (<, >, <=, >=).
function etsTestMatch(val, tests) {
  const n = parseFloat(val);
  for (const t of tests || []) {
    const rm = typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]);
      const op = rm[1];
      if (op === '<'  && n <  rv) return true;
      if (op === '>'  && n >  rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '='  && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) { return true; }
  }
  return false;
}

// Walk the ETS dynamic parameter tree (stored as app.dynTree) and collect paramRef IDs
// that are CONDITIONALLY active — i.e., reachable only through at least one choose/when branch.
// Unconditionally-visible params (always shown regardless of other param values) are excluded.
//
// ETS programming convention for RelSeg devices:
//   - Unconditionally-visible params: ETS leaves the RelSeg blob value in place.
//   - Conditionally-visible params (inside a choose/when that evaluates true):
//       if the param IS in the project XML → write that value (handled by currentValues)
//       if NOT in project XML → write the XML default (this function identifies these).
// Build the set of paramRefs that are unconditionally reachable from top-level channels/cib/pb
// without passing through any choice/when branch. These are always-active params.
function buildUnconditionalChannelSet(dynTree) {
  const s = new Set();
  function walk(node) {
    if (!node) return;
    for (const r of node.paramRefs || []) s.add(r);
    for (const b of node.blocks   || []) walk(b);
    // Do NOT walk into choices — params inside choices are conditional
  }
  for (const ch of dynTree?.main?.channels || []) walk(ch.node);
  for (const ci of dynTree?.main?.cib      || []) walk(ci);
  for (const pb of dynTree?.main?.pb       || []) walk(pb);
  return s;
}

function evalConditionallyActiveParamRefs(dynTree, params, currentValues) {
  const conditional = new Set();
  const getVal = (prKey) => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function evalChoice(choice, inChoice) {
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node, true); }
    }
    if (!matched && defNode) walkNode(defNode, true);
  }
  function walkNode(node, inChoice) {
    if (!node) return;
    for (const r of node.paramRefs || []) { if (inChoice) conditional.add(r); }
    for (const b of node.blocks || []) walkNode(b, inChoice);
    for (const choice of node.choices || []) evalChoice(choice, inChoice);
  }
  function walkDynSection(section) {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node, false);
    for (const ci of section.cib || []) walkNode(ci, false);
    for (const pb of section.pb || []) walkNode(pb, false);
    for (const choice of section.choices || []) evalChoice(choice, false);
  }
  walkDynSection(dynTree?.main);
  return conditional;
}

// Write `bitSize` bits of `value` into buf at byte `byteOffset`, starting from bit `bitOffset`.
// KNX/ETS6 convention:
//   - Multi-byte aligned values (bitOffset=0, bitSize multiple of 8): big-endian (MSB first).
//   - Sub-byte values: bitOffset is from the MSB of the byte (bit 0 = MSB = bit 7 in LSB notation).
//     A field at bitOffset=k, bitSize=n occupies byte bits [7-k .. 8-k-n] (LSB indexing).
//     value bit 0 (LSB) maps to byte bit (8 - bitOffset - bitSize).
// Encode a value as KNX 2-byte float (DPT 9.x) and write big-endian at byteOffset.
// Format: sign(1) + exponent(4) + mantissa(11). value = 0.01 × mantissa × 2^exponent
function writeKnxFloat16(buf, byteOffset, value) {
  if (byteOffset + 2 > buf.length) return;
  // Encode: find exponent such that mantissa fits in 11-bit signed range [-2048..2047]
  let m = Math.round(value * 100); // 0.01 factor
  let e = 0;
  while (m < -2048 || m > 2047) {
    m = Math.round(m / 2);
    e++;
    if (e > 15) break;
  }
  const sign = m < 0 ? 1 : 0;
  if (sign) m = m + 2048; // two's complement 11-bit: negative mantissa stored as 2048 + m
  const raw = (sign << 15) | ((e & 0xF) << 11) | (m & 0x7FF);
  buf[byteOffset]     = (raw >> 8) & 0xFF;
  buf[byteOffset + 1] = raw & 0xFF;
}

function writeBits(buf, byteOffset, bitOffset, bitSize, value) {
  if (byteOffset >= buf.length || bitSize <= 0) return;
  const mask = bitSize >= 32 ? 0xFFFFFFFF : (1 << bitSize) - 1;
  value = value & mask;
  // Byte-aligned multi-byte: write big-endian (KNX/ETS standard)
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      if (bIdx >= buf.length) continue;
      buf[bIdx] = (value >>> ((byteCount - 1 - i) * 8)) & 0xFF;
    }
    return;
  }
  // Sub-byte: bitOffset from MSB (KNX convention: bitOffset=0 is bit 7 of the byte).
  // Handle spanning two bytes by splitting recursively (matches ETS DptValueConverter.WriteBits).
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    writeBits(buf, byteOffset,     bitOffset, bitsInFirstByte, value >>> (bitSize - bitsInFirstByte));
    writeBits(buf, byteOffset + 1, 0,         bitSize - bitsInFirstByte, value);
    return;
  }
  const shift = 8 - bitOffset - bitSize;
  const bmask = ((1 << bitSize) - 1) << shift;
  buf[byteOffset] = (buf[byteOffset] & ~bmask) | ((value << shift) & bmask);
}


// Collect Assign operations whose when-branch is currently active.
// Returns array of { target, source, value } where source is a paramRef key (or null for literal assigns).
function collectActiveAssigns(dynTree, params, currentValues) {
  const result = [];
  const getVal = (prKey) => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walkNode(node) {
    if (!node) return;
    for (const ass of node.assigns || []) result.push(ass);
    for (const b of node.blocks || []) walkNode(b);
    for (const choice of node.choices || []) evalChoice(choice);
  }
  function evalChoice(choice) {
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node); }
    }
    if (!matched && defNode) walkNode(defNode);
  }
  function walkDynSection(section) {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node);
    for (const ci of section.cib || []) walkNode(ci);
    for (const pb of section.pb || []) walkNode(pb);
    for (const choice of section.choices || []) evalChoice(choice);
  }
  walkDynSection(dynTree?.main);
  return result;
}

// Build parameter memory segment from the paramMemLayout (all params, including hidden ones).
// currentValues: { [paramRefId]: rawValue } — user overrides (may be sparse)
// fill: byte value to initialize the buffer with (from LdCtrlRelSegment.@Fill)
// relSegHex: optional hex string from Static/Code/RelativeSegment/Data — when present,
//   used as the base buffer (encodes factory defaults) instead of a fill byte.
//   Devices that store all defaults in this blob have Parameter.@Offset="0" throughout,
//   so bit-level overrides from paramMemLayout may be unreliable; they are still applied
//   for devices that DO have correct per-param offsets.
// Determine parameter segment size and base data for a device model.
// Handles both RelativeSegment (System B) and AbsoluteSegment (ProductProcedure) devices.
function resolveParamSegment(model) {
  const lps = model.loadProcedures || [];
  // Try RelativeSegment path first (most common)
  const writeMemStep = lps.find(s => s.type === 'WriteRelMem');
  const relSegStep   = lps.find(s => s.type === 'RelSegment');
  if (writeMemStep || relSegStep) {
    const paramSize   = writeMemStep?.size || relSegStep?.size || 0;
    const paramFill   = relSegStep?.fill ?? 0xFF;
    const paramLsmIdx = relSegStep?.lsmIdx ?? 4;
    const relSegHex   = model.relSegData?.[paramLsmIdx] || null;
    return { paramSize, paramFill, relSegHex };
  }
  // Try AbsoluteSegment path: find the segment whose address range covers the parameter offsets.
  const absSegs = model.absSegData || {};
  const layout = model.paramMemLayout || {};
  const paramOffsets = Object.values(layout).map(v => v.offset).filter(v => v != null);
  if (paramOffsets.length === 0 || Object.keys(absSegs).length === 0) {
    return { paramSize: 0, paramFill: 0xFF, relSegHex: null };
  }
  const maxOffset = Math.max(...paramOffsets);
  // Find the AbsoluteSegment that contains the parameter range.
  // Parameters use offsets relative to the segment start, so the segment whose
  // size covers maxOffset is the parameter segment.
  for (const [addr, seg] of Object.entries(absSegs)) {
    if (seg.size > maxOffset) {
      return { paramSize: seg.size, paramFill: 0x00, relSegHex: seg.hex || null };
    }
  }
  // Fallback: use the largest segment
  const largest = Object.entries(absSegs).sort((a, b) => b[1].size - a[1].size)[0];
  if (largest) {
    return { paramSize: largest[1].size, paramFill: 0x00, relSegHex: largest[1].hex || null };
  }
  return { paramSize: 0, paramFill: 0xFF, relSegHex: null };
}

function buildParamMem(size, paramMemLayout, currentValues, fill = 0xFF, relSegHex = null, dynTree = null, params = null) {
  // Detect convention: when all directly-mapped params (Union children with Offset attr) have
  // offset=0, the device uses the relSeg blob as a monolithic default.
  // Memory-child params (fromMemoryChild=true) carry relSeg-index offsets — they are overrides
  // on top of the base blob and must be excluded from this detection. TypeText likewise.
  const hasPerParamOffsets = Object.values(paramMemLayout).some(
    i => !i.isText && !i.fromMemoryChild && i.offset > 0
  );
  const relSegConvention = !!relSegHex && !hasPerParamOffsets;

  // Detect the relSeg blob format from its first bytes:
  // - WzEn (0x577a456e): raw parameter defaults. Output = [0x03] + relSeg[0:size-1].
  //   Memory-child param offsets are relSeg indices; writes go to buf[offset + 1].
  // - 0x0000001c header: blob has a 2-byte prefix + 26-byte header (28 total) that gets
  //   zeroed in device memory. Output = relSeg[2:] with first 26 bytes zeroed. Size = relSeg.length - 2.
  //   Param offsets map directly to buf positions (no shift).
  const relSegBase = relSegHex ? Buffer.from(relSegHex, 'hex') : null;
  // (No blob format detection needed — the RelSeg Data blob is always the literal
  // parameter default image, regardless of its first bytes. "WzEn" and 0x0000001c
  // are just parameter data, not format markers.)

  let buf;
  let paramShift = 0; // offset adjustment for param writes
  if (relSegHex) {
    const base = relSegBase;
    if (relSegConvention) {
      // RelSeg blob is the literal parameter default image. Zero-pad to declared Size
      // (ETS uses new byte[Size]). Param offsets map directly into this buffer.
      buf = Buffer.alloc(size, 0x00);
      base.copy(buf, 0, 0, Math.min(base.length, size));
      paramShift = 0;
    } else {
      buf = Buffer.alloc(size, fill);
      base.copy(buf, 0, 0, Math.min(base.length, size));
      paramShift = 0;
    }
  } else {
    buf = Buffer.alloc(size, fill);
  }
  // For relSeg devices, two classes of params get their XML defaults written when not in project XML:
  // 1. Conditionally-visible params (inside choose/when branches that evaluate as active).
  // 2. Unconditionally-visible enum params in top-level channels at fill-value positions.
  //    ETS always initialises these (e.g. scene "unused" slots get the sentinel 0x40 default).
  //    Numeric/time params (typeKind !== 'enum') are excluded — ETS uses the relSeg value there.
  const conditionallyActive = (relSegHex && dynTree && params)
    ? evalConditionallyActiveParamRefs(dynTree, params, currentValues)
    : null;
  const unconditionalChannel = (relSegHex && dynTree)
    ? buildUnconditionalChannelSet(dynTree)
    : null;

  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;
    // Skip params at offset=0 when using a relSeg base with no per-param addressing —
    // their positions are not individually mapped; the blob already encodes their defaults.
    if (relSegHex && info.offset === 0) continue;
    // For Memory-child params: check reachability in the dynamic tree.
    // ETS6 skips visible params hidden by choose/when conditions, even if they have an
    // explicit value in the project XML. But invisible/internal params with project values
    // are always written.
    if (info.fromMemoryChild) {
      // Invisible/internal params with an explicit project value are always written
      if (!info.isVisible && prId in currentValues) { /* allow */ }
      // Params unconditionally reachable in the dynamic tree are always written
      else if (unconditionalChannel && unconditionalChannel.has(prId)) { /* allow */ }
      else {
        const passConditional = conditionallyActive && conditionallyActive.has(prId) && info.isVisible;
        if (!passConditional) continue;
      }
    }
    const rawVal = prId in currentValues ? currentValues[prId] : info.defaultValue;
    if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
    // For WzEn convention, Memory-child offsets are relSeg indices shifted by paramShift.
    // For 0x0000001c convention, offsets map directly (paramShift=0).
    const writeOff = (relSegConvention && info.fromMemoryChild) ? info.offset + paramShift : info.offset;
    // TypeText params: encoding byte (ISO-8859-1 = 0x00) precedes the string in memory.
    // The encoding byte is 1 byte before writeOff in the relSeg (already 0x00 in defaults).
    // String starts at writeOff.
    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      if (writeOff + byteSize > buf.length) continue;
      const strBuf = Buffer.from(rawVal, 'latin1');
      strBuf.copy(buf, writeOff, 0, Math.min(strBuf.length, byteSize));
      continue;
    }
    // TypeFloat: KNX 2-byte float (DPT 9.x) or IEEE 754 single/double
    if (info.isFloat) {
      const fVal = parseFloat(rawVal);
      if (isNaN(fVal)) continue;
      const scaledVal = info.coefficient ? fVal / info.coefficient : fVal;
      if (info.bitSize === 16) {
        // KNX 2-byte float: sign(1) + exponent(4) + mantissa(11)
        // value = 0.01 × mantissa × 2^exponent
        writeKnxFloat16(buf, writeOff, scaledVal);
      } else if (info.bitSize === 32) {
        // IEEE 754 single, big-endian
        if (writeOff + 4 <= buf.length) buf.writeFloatBE(scaledVal, writeOff);
      } else if (info.bitSize === 64) {
        // IEEE 754 double, big-endian
        if (writeOff + 8 <= buf.length) buf.writeDoubleBE(scaledVal, writeOff);
      }
      continue;
    }
    const numVal = parseFloat(rawVal);
    if (isNaN(numVal)) continue;
    // Coefficient scaling: raw = Round(value / coefficient) before writing
    const intVal = info.coefficient ? Math.round(numVal / info.coefficient) : Math.round(numVal);
    writeBits(buf, writeOff, info.bitOffset, info.bitSize, intVal);
  }

  // Process Assign operations: copy source param value (or literal value) to target param's memory position.
  // Assigns are conditional (inside choose/when branches) and are evaluated based on current param values.
  if (dynTree && params) {
    const activeAssigns = collectActiveAssigns(dynTree, params, currentValues);
    for (const { target, source, value } of activeAssigns) {
      const targetInfo = paramMemLayout[target];
      if (!targetInfo || targetInfo.offset === null || targetInfo.offset === undefined) continue;
      if (relSegHex && targetInfo.offset === 0) continue;
      let rawVal;
      if (source) {
        const sourceParam = params[source];
        if (!sourceParam) continue;
        rawVal = source in currentValues ? currentValues[source] : sourceParam.defaultValue;
      } else {
        rawVal = value;
      }
      if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
      const intVal = parseInt(rawVal);
      if (isNaN(intVal)) continue;
      const writeOff = (relSegConvention && targetInfo.fromMemoryChild) ? targetInfo.offset + paramShift : targetInfo.offset;
      writeBits(buf, writeOff, targetInfo.bitOffset, targetInfo.bitSize, intVal);
    }
  }

  return buf;
}

module.exports = router;
