import express from 'express';
import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { createRequire } from 'module';
import * as db from '../db.ts';
import {
  getDptInfo,
  readMasterXml,
  parseMasterXml,
  toArr,
  makeUpdateBuilder,
  _spaceUsageCache,
  _translationCache,
  _mediumTypeCache,
  _maskVersionCache,
} from './shared.ts';

// @iarna/rtf-to-html has no type declarations — use createRequire for CJS interop
// @ts-expect-error TS1470: import.meta is valid at runtime under --experimental-strip-types
const require_ = createRequire(import.meta.url);
const rtfToHTML = require_('@iarna/rtf-to-html') as (
  cb: (err: Error | null, html: string) => void,
) => NodeJS.WritableStream;

const router = express.Router();

// ── RTF to HTML conversion ────────────────────────────────────────────────────
router.post(
  '/rtf-to-html',
  express.text({ type: '*/*', limit: '1mb' }),
  (req: Request, res: Response): void => {
    const rtf = req.body as string | undefined;
    if (!rtf || typeof rtf !== 'string') {
      res.status(400).json({ error: 'No RTF content' });
      return;
    }
    // Decode XML entities that ETS embeds in RTF attributes
    const decoded = rtf.replace(
      /&#x([0-9A-Fa-f]+);/g,
      (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)),
    );
    const input = new Readable();
    input.push(decoded);
    input.push(null);
    input.pipe(
      rtfToHTML((err: Error | null, html: string) => {
        if (err) {
          res.status(400).json({ error: err.message });
          return;
        }
        // Extract just the <body> content — the library produces a full HTML document
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        res.json({ html: bodyMatch ? bodyMatch[1]!.trim() : html });
      }),
    );
  },
);

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response): void => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── DPT info ──────────────────────────────────────────────────────────────────
router.get('/dpt-info', (req: Request, res: Response): void => {
  res.json(getDptInfo(req.query.projectId as string));
});

// ── SpaceUsage info ───────────────────────────────────────────────────────────
interface SpaceUsageEntry {
  id: string;
  number: number;
  text: string;
}

function getSpaceUsages(projectId: string | number): SpaceUsageEntry[] {
  const cache = _spaceUsageCache as Record<string | number, SpaceUsageEntry[]>;
  if (cache[projectId]) return cache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (cache[projectId] = []);
  const root = parseMasterXml(xml) as Record<string, unknown>;
  const knx = root?.KNX as Record<string, unknown> | undefined;
  const md = knx?.MasterData as Record<string, unknown> | undefined;
  const sus = md?.SpaceUsages as Record<string, unknown> | undefined;
  const raw = (sus?.SpaceUsage || []) as Record<string, unknown>[];
  const arr = Array.isArray(raw) ? raw : [raw];
  cache[projectId] = arr.map((su) => ({
    id: su['@_Id'] as string,
    number: Number(su['@_Number']),
    text: (su['@_Text'] as string) || '',
  }));
  return cache[projectId]!;
}

router.get('/space-usages', (req: Request, res: Response): void => {
  res.json(getSpaceUsages(req.query.projectId as string));
});

// ── Translations ─────────────────────────────────────────────────────────────
const LANG_NAMES: Record<string, string> = {
  'de-DE': 'Deutsch',
  'cs-CZ': 'Čeština',
  'da-DK': 'Dansk',
  'el-GR': 'Ελληνικά',
  'es-ES': 'Español',
  'fi-FI': 'Suomi',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'ja-JP': '日本語',
  'nb-NO': 'Norsk',
  'nl-NL': 'Nederlands',
  'pl-PL': 'Polski',
  'pt-PT': 'Português',
  'ru-RU': 'Русский',
  'sv-SE': 'Svenska',
  'tr-TR': 'Türkçe',
  'zh-CN': '中文',
  'uk-UA': 'Українська',
};

interface TranslationResult {
  languages: Array<{ id: string; name: string }>;
  translations: Record<string, Record<string, string>>;
}

function getTranslations(projectId: string | number): TranslationResult {
  const cache = _translationCache as Record<string | number, TranslationResult>;
  if (cache[projectId]) return cache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (cache[projectId] = { languages: [], translations: {} });
  const root = parseMasterXml(xml) as Record<string, unknown>;
  const knx = root?.KNX as Record<string, unknown> | undefined;
  const md = knx?.MasterData as Record<string, unknown> | undefined;

  const en: Record<string, string> = {};
  const dptTypes = md?.DatapointTypes as Record<string, unknown> | undefined;
  for (const dpt of toArr(
    dptTypes?.DatapointType as Record<string, unknown>[] | undefined,
  )) {
    if (dpt['@_Id'] && dpt['@_Text'])
      en[dpt['@_Id'] as string] = dpt['@_Text'] as string;
    const dptSubs = dpt?.DatapointSubtypes as
      | Record<string, unknown>
      | undefined;
    for (const sub of toArr(
      dptSubs?.DatapointSubtype as Record<string, unknown>[] | undefined,
    )) {
      if (sub['@_Id'] && sub['@_Text'])
        en[sub['@_Id'] as string] = sub['@_Text'] as string;
    }
  }
  const spaceUsages = md?.SpaceUsages as Record<string, unknown> | undefined;
  for (const su of toArr(
    spaceUsages?.SpaceUsage as Record<string, unknown>[] | undefined,
  )) {
    if (su['@_Id'] && su['@_Text'])
      en[su['@_Id'] as string] = su['@_Text'] as string;
  }
  const mediumTypes = md?.MediumTypes as Record<string, unknown> | undefined;
  for (const mt of toArr(
    mediumTypes?.MediumType as Record<string, unknown>[] | undefined,
  )) {
    if (mt['@_Id'] && mt['@_Text'])
      en[mt['@_Id'] as string] = mt['@_Text'] as string;
  }
  const functionTypes = md?.FunctionTypes as
    | Record<string, unknown>
    | undefined;
  for (const ft of toArr(
    functionTypes?.FunctionType as Record<string, unknown>[] | undefined,
  )) {
    if (ft['@_Id'] && ft['@_Text'])
      en[ft['@_Id'] as string] = ft['@_Text'] as string;
    for (const fp of toArr(
      ft?.FunctionPoint as Record<string, unknown>[] | undefined,
    )) {
      if (fp['@_Id'] && fp['@_Text'])
        en[fp['@_Id'] as string] = fp['@_Text'] as string;
    }
  }

  const translations: Record<string, Record<string, string>> = { 'en-US': en };
  const languages: Array<{ id: string; name: string }> = [
    { id: 'en-US', name: 'English' },
  ];
  const langs = md?.Languages as Record<string, unknown> | undefined;
  for (const lang of toArr(
    langs?.Language as Record<string, unknown>[] | undefined,
  )) {
    const langId = lang['@_Identifier'] as string | undefined;
    if (!langId) continue;
    languages.push({ id: langId, name: LANG_NAMES[langId] || langId });
    const langTexts: Record<string, string> = {};
    for (const tu of toArr(
      lang?.TranslationUnit as Record<string, unknown>[] | undefined,
    )) {
      for (const te of toArr(
        tu?.TranslationElement as Record<string, unknown>[] | undefined,
      )) {
        const refId = te['@_RefId'] as string | undefined;
        if (!refId) continue;
        for (const tr of toArr(
          te?.Translation as Record<string, unknown>[] | undefined,
        )) {
          if (tr['@_AttributeName'] === 'Text' && tr['@_Text'])
            langTexts[refId] = tr['@_Text'] as string;
        }
      }
    }
    translations[langId] = langTexts;
  }

  cache[projectId] = { languages, translations };
  return cache[projectId]!;
}

router.get('/translations', (req: Request, res: Response): void => {
  res.json(getTranslations(req.query.projectId as string));
});

// ── MediumType info ──────────────────────────────────────────────────────────
function getMediumTypes(projectId: string | number): Record<string, string> {
  const cache = _mediumTypeCache as Record<
    string | number,
    Record<string, string>
  >;
  if (cache[projectId]) return cache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (cache[projectId] = {});
  const root = parseMasterXml(xml) as Record<string, unknown>;
  const knx = root?.KNX as Record<string, unknown> | undefined;
  const md = knx?.MasterData as Record<string, unknown> | undefined;
  const mts = md?.MediumTypes as Record<string, unknown> | undefined;
  const raw = (mts?.MediumType || []) as Record<string, unknown>[];
  const arr = Array.isArray(raw) ? raw : [raw];
  const result: Record<string, string> = {};
  for (const mt of arr)
    result[(mt['@_Name'] as string) || ''] = (mt['@_Text'] as string) || '';
  return (cache[projectId] = result);
}

router.get('/medium-types', (req: Request, res: Response): void => {
  res.json(getMediumTypes(req.query.projectId as string));
});

// ── Mask version info ────────────────────────────────────────────────────────
interface MaskVersionEntry {
  name: string;
  managementModel: string;
  medium: string;
}

function getMaskVersions(
  projectId: string | number,
): Record<string, MaskVersionEntry> {
  const cache = _maskVersionCache as Record<
    string | number,
    Record<string, MaskVersionEntry>
  >;
  if (cache[projectId]) return cache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (cache[projectId] = {});
  const root = parseMasterXml(xml) as Record<string, unknown>;
  const knx = root?.KNX as Record<string, unknown> | undefined;
  const md = knx?.MasterData as Record<string, unknown> | undefined;
  const mvs = md?.MaskVersions as Record<string, unknown> | undefined;
  const raw = (mvs?.MaskVersion || []) as Record<string, unknown>[];
  const arr = Array.isArray(raw) ? raw : [raw];
  const result: Record<string, MaskVersionEntry> = {};
  for (const mv of arr) {
    const num = parseInt(mv['@_MaskVersion'] as string);
    if (isNaN(num)) continue;
    const hex = num.toString(16).padStart(4, '0');
    if (!result[hex]) {
      result[hex] = {
        name: (mv['@_Name'] as string) || '',
        managementModel: (mv['@_ManagementModel'] as string) || '',
        medium: (mv['@_MediumTypeRefId'] as string) || '',
      };
    }
  }
  return (cache[projectId] = result);
}

router.get('/mask-versions', (req: Request, res: Response): void => {
  res.json(getMaskVersions(req.query.projectId as string));
});

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', (_req: Request, res: Response): void => {
  const rows = db.all<{ key: string; value: string }>(
    'SELECT key, value FROM settings',
  );
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

// rebuildDemoMap is injected after construction via setRebuildDemoMap
let _rebuildDemoMap: () => void = () => {};
function setRebuildDemoMap(fn: () => void): void {
  _rebuildDemoMap = fn;
}

router.patch('/settings', (req: Request, res: Response): void => {
  const body = req.body as Record<string, unknown>;
  const allowed = new Set([
    'knxip_host',
    'knxip_port',
    'active_project_id',
    'demo_mode',
    'demo_addr_map',
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k))
      db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, String(v)]);
  }
  if (body.demo_mode !== undefined || body.demo_addr_map !== undefined) {
    _rebuildDemoMap();
  }
  db.scheduleSave();
  res.json({ ok: true });
});

// ── Topology ─────────────────────────────────────────────────────────────────
router.get('/projects/:pid/topology', (req: Request, res: Response): void => {
  res.json(
    db.all('SELECT * FROM topology WHERE project_id=? ORDER BY area, line', [
      +req.params.pid!,
    ]),
  );
});

router.post('/projects/:pid/topology', (req: Request, res: Response): void => {
  const pid = +req.params.pid!;
  const { area, line, name, medium } = req.body as Record<string, unknown>;
  if (area === undefined) {
    res.status(400).json({ error: 'area required' });
    return;
  }
  const { lastInsertRowid } = db.run(
    'INSERT OR REPLACE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
    [pid, area, line ?? null, name || '', medium || 'TP'],
  );
  const label = line != null ? `${area}.${line}` : `Area ${area}`;
  db.audit(
    pid,
    'create',
    'topology',
    String(label),
    `Created ${line != null ? 'line' : 'area'} "${(name as string) || label}"`,
  );
  db.scheduleSave();
  res.json(db.get('SELECT * FROM topology WHERE id=?', [lastInsertRowid]));
});

router.put(
  '/projects/:pid/topology/:tid',
  (req: Request, res: Response): void => {
    const { pid, tid } = req.params;
    const b = req.body as Record<string, unknown>;
    const old = db.get('SELECT * FROM topology WHERE id=? AND project_id=?', [
      +tid!,
      +pid!,
    ]);
    if (!old) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { track, sets, vals, diffs } = makeUpdateBuilder(old);
    if (b.name !== undefined) track('name', b.name);
    if (b.medium !== undefined) track('medium', b.medium);
    if (!sets.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    vals.push(+tid!);
    db.run(`UPDATE topology SET ${sets.join(', ')} WHERE id=?`, vals);
    const label =
      old.line != null ? `${old.area}.${old.line}` : `Area ${old.area}`;
    db.audit(+pid!, 'update', 'topology', String(label), diffs.join('; '));
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.delete(
  '/projects/:pid/topology/:tid',
  (req: Request, res: Response): void => {
    const { pid, tid } = req.params;
    const old = db.get('SELECT * FROM topology WHERE id=? AND project_id=?', [
      +tid!,
      +pid!,
    ]);
    if (!old) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    db.run('DELETE FROM topology WHERE id=?', [+tid!]);
    const label =
      old.line != null ? `${old.area}.${old.line}` : `Area ${old.area}`;
    db.audit(
      +pid!,
      'delete',
      'topology',
      String(label),
      `Deleted ${old.line != null ? 'line' : 'area'} "${(old.name as string) || label}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

// ── Spaces ───────────────────────────────────────────────────────────────────
router.post('/projects/:pid/spaces', (req: Request, res: Response): void => {
  const pid = +req.params.pid!;
  const b = req.body as Record<string, unknown>;
  const bName = b.name as string | undefined;
  if (!bName?.trim()) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  const { lastInsertRowid } = db.run(
    'INSERT INTO spaces (project_id, name, type, parent_id, sort_order, usage_id) VALUES (?,?,?,?,?,?)',
    [
      pid,
      bName.trim(),
      (b.type as string) || 'Room',
      b.parent_id || null,
      b.sort_order ?? 0,
      (b.usage_id as string) || '',
    ],
  );
  const space = db.get('SELECT * FROM spaces WHERE id=?', [lastInsertRowid]);
  db.audit(
    pid,
    'create',
    'space',
    bName.trim(),
    `Created ${(b.type as string) || 'Room'} "${bName.trim()}"`,
  );
  db.scheduleSave();
  res.json(space);
});

router.delete(
  '/projects/:pid/spaces/:sid',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const sid = req.params.sid as string;
    const old = db.get('SELECT * FROM spaces WHERE id=? AND project_id=?', [
      +sid!,
      +pid!,
    ]);
    if (!old) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Unassign devices from this space
    db.run(
      'UPDATE devices SET space_id=NULL WHERE space_id=? AND project_id=?',
      [+sid!, +pid!],
    );
    // Reparent child spaces to this space's parent
    db.run('UPDATE spaces SET parent_id=? WHERE parent_id=? AND project_id=?', [
      old.parent_id || null,
      +sid!,
      +pid!,
    ]);
    db.run('DELETE FROM spaces WHERE id=?', [+sid!]);
    db.audit(
      +pid!,
      'delete',
      'space',
      (old.name as string) || sid!,
      `Deleted ${old.type} "${old.name}"`,
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

router.put(
  '/projects/:pid/spaces/:sid',
  (req: Request, res: Response): void => {
    const pid = req.params.pid as string;
    const sid = req.params.sid as string;
    const b = req.body as Record<string, unknown>;
    const old = db.get('SELECT * FROM spaces WHERE id=? AND project_id=?', [
      +sid!,
      +pid!,
    ]);
    if (!old) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { track, sets, vals, diffs } = makeUpdateBuilder(old);
    if (b.name !== undefined) track('name', (b.name as string).trim());
    if (!sets.length) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    vals.push(+sid!);
    db.run(`UPDATE spaces SET ${sets.join(', ')} WHERE id=?`, vals);
    db.audit(
      +pid!,
      'update',
      'space',
      (old.name as string) || sid!,
      diffs.join('; '),
    );
    db.scheduleSave();
    res.json({ ok: true });
  },
);

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/projects/:id/audit-log', (req: Request, res: Response): void => {
  const limit = parseInt(req.query.limit as string) || 500;
  res.json(
    db.all(
      'SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT ?',
      [+req.params.id!, limit],
    ),
  );
});

router.get(
  '/projects/:id/audit-log/csv',
  (req: Request, res: Response): void => {
    const rows = db.all(
      'SELECT * FROM audit_log WHERE project_id=? ORDER BY id DESC',
      [+req.params.id!],
    );
    const escape = (v: unknown): string =>
      `"${String(v || '').replace(/"/g, '""')}"`;
    const header = 'timestamp,action,entity,entity_id,detail';
    const lines = rows.map((r) =>
      [r.timestamp, r.action, r.entity, r.entity_id, r.detail]
        .map(escape)
        .join(','),
    );
    const csv = [header, ...lines].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-log-${req.params.id!}.csv"`,
    );
    res.send(csv);
  },
);

// ── Telegrams ─────────────────────────────────────────────────────────────────
router.get('/projects/:id/telegrams', (req: Request, res: Response): void => {
  const limit = parseInt(req.query.limit as string) || 200;
  res.json(
    db.all(
      'SELECT * FROM bus_telegrams WHERE project_id=? ORDER BY id DESC LIMIT ?',
      [+req.params.id!, limit],
    ),
  );
});

router.delete(
  '/projects/:id/telegrams',
  (req: Request, res: Response): void => {
    db.run('DELETE FROM bus_telegrams WHERE project_id=?', [+req.params.id!]);
    db.scheduleSave();
    res.json({ ok: true });
  },
);

export { router, setRebuildDemoMap };
