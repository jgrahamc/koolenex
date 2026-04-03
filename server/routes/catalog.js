'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const { parseKnxproj } = require('../ets-parser');
const { APPS_DIR } = require('./shared');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

module.exports = router;
