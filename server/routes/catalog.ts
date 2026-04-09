import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as db from '../db.ts';
import { parseKnxproj, type ParsedProject } from '../ets-parser.ts';
import { APPS_DIR, MAX_UPLOAD_BYTES } from './shared.ts';
import { logger, safeError } from '../log.ts';
import { paramId } from '../validate.ts';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Build catalog response for a project, marking items in use by devices. */
function buildCatalogResponse(pid: number) {
  const sections = db.all(
    'SELECT * FROM catalog_sections WHERE project_id=? ORDER BY manufacturer, number, name',
    [pid],
  );
  const items = db.all(
    'SELECT * FROM catalog_items WHERE project_id=? ORDER BY manufacturer, name',
    [pid],
  );
  const usedRefs = new Set(
    db
      .all<{ product_ref: string }>(
        'SELECT product_ref FROM devices WHERE project_id=?',
        [pid],
      )
      .map((r) => r.product_ref)
      .filter(Boolean),
  );
  return {
    sections,
    items: items.map((i) => ({
      ...i,
      in_use: usedRefs.has(i.product_ref as string),
    })),
  };
}

// ── Catalog ──────────────────────────────────────────────────────────────────
router.get('/projects/:id/catalog', (req: Request, res: Response): void => {
  const pid = paramId(req, 'id');
  res.json(buildCatalogResponse(pid));
});

// Import a standalone .knxprod file into a project's catalog
router.post(
  '/projects/:id/catalog/import',
  upload.single('file'),
  (req: Request, res: Response): void => {
    const pid = paramId(req, 'id');
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    if (!req.file.originalname.toLowerCase().endsWith('.knxprod')) {
      res.status(400).json({ error: 'File must be a .knxprod file' });
      return;
    }
    const project = db.get('SELECT * FROM projects WHERE id=?', [pid]);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    let parsed: ParsedProject;
    try {
      parsed = parseKnxproj(req.file.buffer, null);
    } catch (err) {
      res.status(422).json({ error: safeError('ets', 'Parse failed', err) });
      return;
    }

    const { catalogSections, catalogItems, paramModels } = parsed;

    try {
      db.transaction(({ run }) => {
        for (const sec of catalogSections) {
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
        for (const item of catalogItems) {
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

      // Save param models from .knxprod
      if (paramModels) {
        for (const [appId, model] of Object.entries(paramModels)) {
          const safe = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
          try {
            fs.writeFileSync(
              path.join(APPS_DIR, safe + '.json'),
              JSON.stringify(model),
            );
          } catch (e) {
            logger.warn('ets', `failed to write model ${safe}.json`, {
              error: (e as Error).message,
            });
          }
        }
      }

      db.audit(
        pid,
        'import',
        'catalog',
        req.file.originalname,
        `Imported catalog: ${catalogSections.length} sections, ${catalogItems.length} items`,
      );

      res.json({ ok: true, ...buildCatalogResponse(pid) });
    } catch (err) {
      res.status(500).json({ error: safeError('ets', 'Import failed', err) });
    }
  },
);

export { router };
