import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import * as db from '../db.ts';
import { parseKnxproj, type ParsedProject } from '../ets-parser.ts';
import {
  MAX_UPLOAD_BYTES,
  insertCatalog,
  saveModelsAndMasterXml,
} from './shared.ts';
import { safeError } from '../log.ts';
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
        insertCatalog(run, pid, catalogSections, catalogItems);
      });

      // Models only - a .knxprod's own master XML is deliberately not saved
      // over the project's, which a full .knxproj import is what sets.
      saveModelsAndMasterXml(paramModels, null, pid);

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
