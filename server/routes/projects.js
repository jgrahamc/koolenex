'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { parseKnxproj } = require('../ets-parser');
const { saveModelsAndMasterXml } = require('./shared');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Shared insert logic used by both import and reimport
function insertParsedData(run, pid, parsed) {
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
  const spaceDbIds = [];
  for (const s of spaces) {
    const parentDbId = s.parent_idx != null ? spaceDbIds[s.parent_idx] : null;
    const { lastInsertRowid } = run(
      'INSERT INTO spaces (project_id,name,type,usage_id,parent_id,sort_order) VALUES (?,?,?,?,?,?)',
      [pid, s.name, s.type, s.usage_id || '', parentDbId, s.sort_order],
    );
    spaceDbIds.push(lastInsertRowid);
  }

  const deviceIdMap = {};
  for (const d of devices) {
    const spaceIdx = devSpaceMap[d.individual_address];
    const spaceId = spaceIdx != null ? spaceDbIds[spaceIdx] : null;
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

  const gaIdMap = {};
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

function parseUploadedKnxproj(req) {
  return parseKnxproj(req.file.buffer, req.body.password || null);
}

// ── Projects ──────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  res.json(db.all('SELECT * FROM projects ORDER BY updated_at DESC'));
});

router.post('/projects', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const { lastInsertRowid } = db.run('INSERT INTO projects (name) VALUES (?)', [
    name.trim(),
  ]);
  db.audit(
    lastInsertRowid,
    'create',
    'project',
    name.trim(),
    'Created project',
  );
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
  const oldProj = db.get('SELECT name FROM projects WHERE id=?', [
    +req.params.id,
  ]);
  db.run("UPDATE projects SET name=?, updated_at=datetime('now') WHERE id=?", [
    name,
    +req.params.id,
  ]);
  db.audit(
    +req.params.id,
    'update',
    'project',
    name,
    `name: "${oldProj?.name ?? ''}" → "${name}"`,
  );
  db.scheduleSave();
  res.json(db.get('SELECT * FROM projects WHERE id=?', [+req.params.id]));
});

router.delete('/projects/:id', (req, res) => {
  // Cascade manually (sql.js doesn't enforce FK by default in all cases)
  const pid = +req.params.id;
  db.transaction(({ run }) => {
    // Delete com_objects via subquery instead of string-interpolated ID list
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
router.post('/projects/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.originalname.toLowerCase().endsWith('.knxproj'))
    return res.status(400).json({ error: 'File must be a .knxproj file' });

  let parsed;
  try {
    parsed = parseUploadedKnxproj(req);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED')
      return res.status(422).json({
        error: 'Project is password-protected',
        code: 'PASSWORD_REQUIRED',
      });
    if (err.code === 'PASSWORD_INCORRECT')
      return res
        .status(422)
        .json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
    console.error('ETS parse error:', err);
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
    const projectId = db.transaction(({ run, _all }) => {
      const { lastInsertRowid: pid } = run(
        'INSERT INTO projects (name, file_name, thumbnail, project_info) VALUES (?,?,?,?)',
        [
          projectName,
          req.file.originalname,
          thumbnail || '',
          JSON.stringify(projectInfo || {}),
        ],
      );

      insertParsedData(run, pid, parsed);

      return pid;
    });

    const data = db.getProjectFull(projectId);

    saveModelsAndMasterXml(paramModels, knxMasterXml, projectId);

    db.audit(
      projectId,
      'import',
      'project',
      req.file.originalname,
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
    parsed = parseUploadedKnxproj(req);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED')
      return res.status(422).json({
        error: 'Project is password-protected',
        code: 'PASSWORD_REQUIRED',
      });
    if (err.code === 'PASSWORD_INCORRECT')
      return res
        .status(422)
        .json({ error: 'Incorrect password', code: 'PASSWORD_INCORRECT' });
    console.error('ETS reimport parse error:', err);
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
    db.transaction(({ run, _all }) => {
      // Clear existing data for this project
      run('DELETE FROM com_objects WHERE project_id=?', [pid]);
      run('DELETE FROM group_addresses WHERE project_id=?', [pid]);
      run('DELETE FROM devices WHERE project_id=?', [pid]);
      run('DELETE FROM topology WHERE project_id=?', [pid]);
      run('DELETE FROM catalog_sections WHERE project_id=?', [pid]);
      run('DELETE FROM catalog_items WHERE project_id=?', [pid]);
      run('DELETE FROM spaces WHERE project_id=?', [pid]);
      run(
        "UPDATE projects SET name=?, file_name=?, thumbnail=?, project_info=?, updated_at=datetime('now') WHERE id=?",
        [
          projectName,
          req.file.originalname,
          thumbnail || '',
          JSON.stringify(projectInfo || {}),
          pid,
        ],
      );

      // Re-insert spaces
      const spaceDbIds = [];
      for (const s of parsed.spaces) {
        const parentDbId =
          s.parent_idx != null ? spaceDbIds[s.parent_idx] : null;
        const { lastInsertRowid } = run(
          'INSERT INTO spaces (project_id,name,type,usage_id,parent_id,sort_order) VALUES (?,?,?,?,?,?)',
          [pid, s.name, s.type, s.usage_id || '', parentDbId, s.sort_order],
        );
        spaceDbIds.push(lastInsertRowid);
      }

      // Re-insert devices
      const deviceIdMap = {};
      for (const d of devices) {
        const spaceIdx = parsed.devSpaceMap[d.individual_address];
        const spaceId = spaceIdx != null ? spaceDbIds[spaceIdx] : null;
        const { lastInsertRowid } = run(
          `
          INSERT OR IGNORE INTO devices
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

      // Re-insert GAs
      run('DELETE FROM ga_group_names WHERE project_id=?', [pid]);
      const gaIdMap = {};
      for (const g of groupAddresses) {
        const { lastInsertRowid } = run(
          `
          INSERT INTO group_addresses
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

      // Re-insert com objects
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

      // Re-insert topology
      for (const t of parsed.topologyEntries || []) {
        run(
          'INSERT OR REPLACE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
          [pid, t.area, t.line, t.name || '', t.medium || 'TP'],
        );
      }

      // Re-insert catalog
      for (const sec of parsed.catalogSections || []) {
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
      for (const item of parsed.catalogItems || []) {
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
    });

    const data = db.getProjectFull(pid);

    saveModelsAndMasterXml(paramModels, knxMasterXml, pid);

    db.audit(
      pid,
      'reimport',
      'project',
      req.file.originalname,
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
  } catch (err) {
    console.error('Reimport error:', err);
    res.status(500).json({ error: `Reimport failed: ${err.message}` });
  }
});

module.exports = router;
