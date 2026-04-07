/**
 * Database layer using sql.js (pure JavaScript SQLite — no native compilation).
 *
 * sql.js runs the database in memory. We persist it to disk by writing the binary
 * .db file after every mutating operation. On startup we load from disk if it exists.
 */

import initSqlJs from 'sql.js';
import type { SqlJsDatabase, SqlJsStatic } from 'sql.js';
import path from 'path';
import fs from 'fs';
import type {
  ComObjectWithDevice,
  GAMaps,
  GaGroupName,
  EnrichedGA,
  ProjectFull,
  RunResult,
} from '../shared/types.ts';

const DB_PATH = path.join(process.cwd(), 'koolenex.db');

let SQL: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;

function assertDb(d: SqlJsDatabase | null): asserts d is SqlJsDatabase {
  if (!d) throw new Error('Database not initialised — call init() first');
}

export function buildGAMaps(
  comObjects: Array<{ device_address: string; ga_address: string }>,
): GAMaps {
  const deviceGAMap: Record<string, string[]> = {};
  const gaDeviceMap: Record<string, string[]> = {};
  for (const co of comObjects) {
    const da = co.device_address;
    for (const ga of (co.ga_address || '').split(/\s+/).filter(Boolean)) {
      if (!deviceGAMap[da]) deviceGAMap[da] = [];
      if (!deviceGAMap[da]!.includes(ga)) deviceGAMap[da]!.push(ga);
      if (!gaDeviceMap[ga]) gaDeviceMap[ga] = [];
      if (!gaDeviceMap[ga]!.includes(da)) gaDeviceMap[ga]!.push(da);
    }
  }
  return { deviceGAMap, gaDeviceMap };
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  SQL = (await initSqlJs()) as SqlJsStatic;

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log('[DB] Loaded from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database at', DB_PATH);
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      file_name  TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER NOT NULL,
      individual_address TEXT NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT DEFAULT '',
      comment            TEXT DEFAULT '',
      order_number       TEXT DEFAULT '',
      serial_number      TEXT DEFAULT '',
      manufacturer       TEXT DEFAULT '',
      model              TEXT DEFAULT '',
      product_ref        TEXT DEFAULT '',
      area               INTEGER DEFAULT 1,
      line               INTEGER DEFAULT 1,
      device_type        TEXT DEFAULT 'generic',
      status             TEXT DEFAULT 'unassigned',
      last_modified      TEXT DEFAULT '',
      last_download      TEXT DEFAULT '',
      app_number         TEXT DEFAULT '',
      app_version        TEXT DEFAULT '',
      parameters         TEXT DEFAULT '[]',
      UNIQUE(project_id, individual_address)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS group_addresses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      address    TEXT NOT NULL,
      name       TEXT NOT NULL,
      dpt        TEXT DEFAULT '',
      main_g     INTEGER DEFAULT 0,
      middle_g   INTEGER DEFAULT 0,
      sub_g      INTEGER DEFAULT 0,
      UNIQUE(project_id, address)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS com_objects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER NOT NULL,
      device_id     INTEGER NOT NULL,
      object_number INTEGER DEFAULT 0,
      channel       TEXT DEFAULT '',
      name          TEXT DEFAULT '',
      function_text TEXT DEFAULT '',
      dpt           TEXT DEFAULT '',
      object_size   TEXT DEFAULT '',
      flags         TEXT DEFAULT '',
      direction     TEXT DEFAULT 'both',
      ga_address    TEXT DEFAULT '',
      ga_send       TEXT DEFAULT '',
      ga_receive    TEXT DEFAULT ''
    )
  `);
  // Migrations for existing databases
  try {
    db.run("ALTER TABLE com_objects ADD COLUMN ga_send TEXT DEFAULT ''");
  } catch {}
  try {
    db.run("ALTER TABLE com_objects ADD COLUMN ga_receive TEXT DEFAULT ''");
  } catch {}

  // Legacy table — kept for backward compatibility but no longer used.
  // Device↔GA mappings are now derived from com_objects.ga_address.
  db.run(`
    CREATE TABLE IF NOT EXISTS ga_device_links (
      ga_id     INTEGER,
      device_id INTEGER,
      PRIMARY KEY(ga_id, device_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS spaces (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name       TEXT NOT NULL,
      type       TEXT DEFAULT 'Room',
      parent_id  INTEGER,
      sort_order INTEGER DEFAULT 0,
      usage_id   TEXT DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS bus_telegrams (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      timestamp  TEXT DEFAULT (datetime('now','localtime')),
      src        TEXT,
      dst        TEXT,
      type       TEXT,
      raw_value  TEXT,
      decoded    TEXT,
      priority   TEXT DEFAULT 'low'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.run(`INSERT OR IGNORE INTO settings VALUES ('knxip_host', '224.0.23.12')`);
  db.run(`INSERT OR IGNORE INTO settings VALUES ('knxip_port', '3671')`);
  db.run(`INSERT OR IGNORE INTO settings VALUES ('active_project_id', '')`);

  // ── Migrations: add columns introduced after initial schema ──────────────
  // SQLite has no ADD COLUMN IF NOT EXISTS, so we check pragma first.
  const migrate = (table: string, col: string, def: string): void => {
    try {
      const cols = db!.exec(`PRAGMA table_info(${table})`)[0];
      if (!cols) return;
      const exists = cols.values.some((row: unknown[]) => row[1] === col);
      if (!exists) db!.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch (_) {}
  };
  migrate('devices', 'comment', "TEXT DEFAULT ''");
  migrate('devices', 'order_number', "TEXT DEFAULT ''");
  migrate('devices', 'serial_number', "TEXT DEFAULT ''");
  migrate('devices', 'last_modified', "TEXT DEFAULT ''");
  migrate('devices', 'last_download', "TEXT DEFAULT ''");
  migrate('devices', 'area_name', "TEXT DEFAULT ''");
  migrate('devices', 'line_name', "TEXT DEFAULT ''");
  migrate('devices', 'medium', "TEXT DEFAULT 'TP'");
  migrate('group_addresses', 'comment', "TEXT DEFAULT ''");
  migrate('group_addresses', 'main_group_name', "TEXT DEFAULT ''");
  migrate('group_addresses', 'middle_group_name', "TEXT DEFAULT ''");
  migrate('com_objects', 'channel', "TEXT DEFAULT ''");
  migrate('com_objects', 'object_size', "TEXT DEFAULT ''");
  migrate('devices', 'space_id', 'INTEGER');
  migrate('devices', 'parameters', "TEXT DEFAULT '[]'");
  migrate('devices', 'app_ref', "TEXT DEFAULT ''");
  migrate('devices', 'param_values', "TEXT DEFAULT '{}'");
  migrate('spaces', 'usage_id', "TEXT DEFAULT ''");
  migrate('devices', 'model_translations', "TEXT DEFAULT '{}'");
  migrate('devices', 'bus_current', 'INTEGER DEFAULT 0');
  migrate('devices', 'width_mm', 'REAL DEFAULT 0');
  migrate('devices', 'is_power_supply', 'INTEGER DEFAULT 0');
  migrate('devices', 'is_coupler', 'INTEGER DEFAULT 0');
  migrate('devices', 'is_rail_mounted', 'INTEGER DEFAULT 0');
  migrate('projects', 'thumbnail', "TEXT DEFAULT ''");
  migrate('projects', 'project_info', "TEXT DEFAULT ''");
  migrate('devices', 'installation_hints', "TEXT DEFAULT ''");
  migrate('group_addresses', 'description', "TEXT DEFAULT ''");
  migrate('devices', 'floor_x', 'REAL DEFAULT -1');
  migrate('devices', 'floor_y', 'REAL DEFAULT -1');
  migrate('catalog_items', 'model', "TEXT DEFAULT ''");
  migrate('catalog_items', 'bus_current', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'width_mm', 'REAL DEFAULT 0');
  migrate('catalog_items', 'is_power_supply', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'is_coupler', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'is_rail_mounted', 'INTEGER DEFAULT 0');
  db.run(`INSERT OR IGNORE INTO settings VALUES ('demo_mode', '')`);
  db.run(`INSERT OR IGNORE INTO settings VALUES ('demo_addr_map', '')`);

  db.run(`
    CREATE TABLE IF NOT EXISTS topology (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      area       INTEGER NOT NULL,
      line       INTEGER,
      name       TEXT DEFAULT '',
      medium     TEXT DEFAULT 'TP',
      UNIQUE(project_id, area, line)
    )
  `);

  // Migrate existing area/line data from devices into topology table
  try {
    const hasRows = (
      all('SELECT count(*) as c FROM topology')[0] as { c: number } | undefined
    )?.c;
    if (!hasRows) {
      // Migrate areas
      const areas = all<{
        project_id: number;
        area: number;
        area_name: string;
      }>(
        "SELECT DISTINCT project_id, area, area_name FROM devices WHERE area_name != '' AND area_name IS NOT NULL",
      );
      for (const r of areas) {
        try {
          db.run(
            'INSERT OR IGNORE INTO topology (project_id, area, line, name, medium) VALUES (?,?,NULL,?,?)',
            [r.project_id, r.area, r.area_name, 'TP'],
          );
        } catch (_) {}
      }
      // Migrate lines
      const lines = all<{
        project_id: number;
        area: number;
        line: number;
        line_name: string;
        medium: string;
      }>(
        'SELECT DISTINCT project_id, area, line, line_name, medium FROM devices',
      );
      for (const r of lines) {
        try {
          db.run(
            'INSERT OR IGNORE INTO topology (project_id, area, line, name, medium) VALUES (?,?,?,?,?)',
            [r.project_id, r.area, r.line, r.line_name || '', r.medium || 'TP'],
          );
        } catch (_) {}
      }
    }
  } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_sections (
      id         TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      name       TEXT NOT NULL DEFAULT '',
      number     TEXT DEFAULT '',
      parent_id  TEXT,
      mfr_id     TEXT DEFAULT '',
      manufacturer TEXT DEFAULT '',
      PRIMARY KEY (project_id, id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      id           TEXT NOT NULL,
      project_id   INTEGER NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      number       TEXT DEFAULT '',
      description  TEXT DEFAULT '',
      section_id   TEXT DEFAULT '',
      product_ref  TEXT DEFAULT '',
      h2p_ref      TEXT DEFAULT '',
      order_number TEXT DEFAULT '',
      manufacturer TEXT DEFAULT '',
      mfr_id       TEXT DEFAULT '',
      model        TEXT DEFAULT '',
      bus_current  INTEGER DEFAULT 0,
      width_mm     REAL DEFAULT 0,
      is_power_supply INTEGER DEFAULT 0,
      is_coupler   INTEGER DEFAULT 0,
      is_rail_mounted INTEGER DEFAULT 0,
      PRIMARY KEY (project_id, id)
    )
  `);

  // ── ga_group_names: one row per main or middle group name ──────────────────
  // middle_g = -1 means it's a main-group name, otherwise it's a middle-group name.
  db.run(`
    CREATE TABLE IF NOT EXISTS ga_group_names (
      project_id INTEGER NOT NULL,
      main_g     INTEGER NOT NULL,
      middle_g   INTEGER NOT NULL DEFAULT -1,
      name       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, main_g, middle_g)
    )
  `);

  // Migrate existing redundant columns into ga_group_names (one-time)
  try {
    const cols = db.exec('PRAGMA table_info(group_addresses)')[0];
    const hasMainGN =
      cols && cols.values.some((r: unknown[]) => r[1] === 'main_group_name');
    if (hasMainGN) {
      // Migrate main group names
      const mains = all<{
        project_id: number;
        main_g: number;
        main_group_name: string;
      }>(
        "SELECT DISTINCT project_id, main_g, main_group_name FROM group_addresses WHERE main_group_name != ''",
      );
      for (const r of mains) {
        db.run(
          'INSERT OR IGNORE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,-1,?)',
          [r.project_id, r.main_g, r.main_group_name],
        );
      }
      // Migrate middle group names
      const mids = all<{
        project_id: number;
        main_g: number;
        middle_g: number;
        middle_group_name: string;
      }>(
        "SELECT DISTINCT project_id, main_g, middle_g, middle_group_name FROM group_addresses WHERE middle_group_name != ''",
      );
      for (const r of mids) {
        db.run(
          'INSERT OR IGNORE INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,?,?,?)',
          [r.project_id, r.main_g, r.middle_g, r.middle_group_name],
        );
      }
    }
  } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      timestamp  TEXT DEFAULT (datetime('now','localtime')),
      action     TEXT NOT NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT DEFAULT '',
      detail     TEXT DEFAULT ''
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, timestamp)`,
  );

  save();
}

// ── Persist ───────────────────────────────────────────────────────────────────

export function save(): void {
  assertDb(db);
  const data = db.export(); // Uint8Array
  fs.writeFile(DB_PATH, Buffer.from(data), (err) => {
    if (err) console.error('[DB] save error:', err.message);
  });
}

// Debounced save — avoids hammering disk during bulk imports
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleSave(delayMs = 200): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save();
    saveTimer = null;
  }, delayMs);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export function all<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  assertDb(db);
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

export function get<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T | null {
  const rows = all<T>(sql, params);
  return rows[0] ?? null;
}

export function run(sql: string, params: unknown[] = []): RunResult {
  assertDb(db);
  db.run(sql, params);
  const lastInsertRowid =
    (db.exec('SELECT last_insert_rowid() as id')[0]?.values[0]?.[0] as
      | number
      | null) ?? null;
  const changes =
    (db.exec('SELECT changes() as c')[0]?.values[0]?.[0] as number) ?? 0;
  return { lastInsertRowid, changes };
}

export interface TransactionHelpers {
  all: typeof all;
  get: typeof get;
  run: typeof run;
}

export function transaction<T>(fn: (helpers: TransactionHelpers) => T): T {
  assertDb(db);
  db.run('BEGIN');
  try {
    const result = fn({ all, get, run });
    db.run('COMMIT');
    scheduleSave(50);
    return result;
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ── Higher-level helpers ──────────────────────────────────────────────────────

export function getProjectFull(projectId: number): ProjectFull | null {
  const project = get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) return null;

  const devices = all(
    `SELECT id,project_id,individual_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,area_name,line_name,medium,device_type,status,last_modified,last_download,app_number,app_version,parameters,app_ref,param_values,space_id,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted,floor_x,floor_y FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
    [projectId],
  );
  const gas = all(
    'SELECT * FROM group_addresses WHERE project_id=? ORDER BY main_g, middle_g, sub_g',
    [projectId],
  );
  const comObjects = all<ComObjectWithDevice>(
    `
    SELECT co.*, d.individual_address as device_address, d.name as device_name
    FROM com_objects co JOIN devices d ON co.device_id=d.id
    WHERE co.project_id=? ORDER BY d.area, d.line, CAST(REPLACE(d.individual_address, d.area||'.'||d.line||'.', '') AS INTEGER), co.object_number
  `,
    [projectId],
  );
  const { deviceGAMap, gaDeviceMap } = buildGAMaps(comObjects);

  // Build group-name lookup from ga_group_names table
  const groupNames = all<GaGroupName>(
    'SELECT main_g, middle_g, name FROM ga_group_names WHERE project_id=?',
    [projectId],
  );
  const mainNameMap: Record<number, string> = {};
  const midNameMap: Record<string, string> = {};
  for (const gn of groupNames) {
    if (gn.middle_g === -1) mainNameMap[gn.main_g] = gn.name;
    else midNameMap[`${gn.main_g}/${gn.middle_g}`] = gn.name;
  }

  // Attach group names and device lists to GAs
  const normGas: EnrichedGA[] = gas.map((g: Record<string, unknown>) => {
    const main = g.main_g as number;
    const middle = g.middle_g as number;
    return {
      ...g,
      main_group_name: mainNameMap[main] ?? '',
      middle_group_name: midNameMap[`${main}/${middle}`] ?? '',
      devices: gaDeviceMap[g.address as string] ?? [],
    } as EnrichedGA;
  });

  const spaces = all('SELECT * FROM spaces WHERE project_id=? ORDER BY id', [
    projectId,
  ]);

  const topoRows = all(
    'SELECT * FROM topology WHERE project_id=? ORDER BY area, line',
    [projectId],
  );
  // Build lookup for area/line names
  const areaNameMap: Record<number, string> = {};
  const lineNameMap: Record<string, { name: string; medium: string }> = {};
  for (const t of topoRows) {
    const row = t as Record<string, unknown>;
    if (row.line === null) areaNameMap[row.area as number] = row.name as string;
    else
      lineNameMap[`${row.area}.${row.line}`] = {
        name: row.name as string,
        medium: row.medium as string,
      };
  }
  // Attach topology names to devices
  const devicesWithTopo = devices.map((d: Record<string, unknown>) => ({
    ...d,
    area_name: areaNameMap[d.area as number] ?? (d.area_name as string) ?? '',
    line_name:
      lineNameMap[`${d.area}.${d.line}`]?.name ?? (d.line_name as string) ?? '',
  }));

  return {
    project,
    devices: devicesWithTopo,
    gas: normGas,
    comObjects,
    deviceGAMap,
    gaDeviceMap,
    spaces,
    topology: topoRows,
  } as unknown as ProjectFull;
}

export function audit(
  projectId: number,
  action: string,
  entity: string,
  entityId?: string,
  detail?: string,
): void {
  assertDb(db);
  try {
    db.run(
      'INSERT INTO audit_log (project_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)',
      [projectId, action, entity, entityId ?? '', detail ?? ''],
    );
  } catch (_) {
    /* never let audit logging break the main operation */
  }
}
