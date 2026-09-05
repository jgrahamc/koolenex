/**
 * Database layer using sql.js (pure JavaScript SQLite — no native compilation).
 *
 * sql.js runs the database in memory. We persist it to disk by writing the binary
 * .db file after every mutating operation. On startup we load from disk if it exists.
 */

import initSqlJs from 'sql.js';
import type { SqlJsDatabase, SqlJsStatic, SqlValue } from 'sql.js';
import path from 'path';
import fs from 'fs';
import type {
  Project,
  Device,
  GroupAddress,
  ComObjectWithDevice,
  Space,
  Topology,
  GaGroupName,
  EnrichedGA,
  ProjectFull,
  RunResult,
} from '../shared/types.ts';
export { buildGAMaps } from '../shared/ga-maps.ts';
import { buildGAMaps } from '../shared/ga-maps.ts';
import { logger } from './log.ts';

const DB_PATH = path.join(process.cwd(), 'koolenex.db');

let SQL: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;
let _inMemory = false;

function assertDb(d: SqlJsDatabase | null): asserts d is SqlJsDatabase {
  if (!d) throw new Error('Database not initialised — call init() first');
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init(
  options: { inMemory?: boolean } = {},
): Promise<void> {
  SQL = (await initSqlJs()) as SqlJsStatic;

  if (options.inMemory) {
    _inMemory = true;
    db = new SQL.Database();
    logger.info('db', 'Created in-memory database (test mode)');
  } else if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    logger.info('db', `Loaded from ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    logger.info('db', `Created new database at ${DB_PATH}`);
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
      ga_receive    TEXT DEFAULT '',
      read_on_init  INTEGER DEFAULT 0,
      priority      TEXT DEFAULT 'low',
      read          INTEGER DEFAULT 0,
      write         INTEGER DEFAULT 0,
      comm          INTEGER DEFAULT 0,
      tx            INTEGER DEFAULT 0,
      upd           INTEGER DEFAULT 0
    )
  `);
  // Migrations for existing databases
  try {
    db.run("ALTER TABLE com_objects ADD COLUMN ga_send TEXT DEFAULT ''");
  } catch (e) {
    logger.warn('db', 'migration: add com_objects.ga_send', {
      error: (e as Error).message,
    });
  }
  try {
    db.run("ALTER TABLE com_objects ADD COLUMN ga_receive TEXT DEFAULT ''");
  } catch (e) {
    logger.warn('db', 'migration: add com_objects.ga_receive', {
      error: (e as Error).message,
    });
  }

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
  // When a device doesn't answer at its assigned address (e.g. after a
  // factory reset) and a serial is on record, /bus/program-device can
  // locate/readdress it by serial (A_IndividualAddressSerialNumber_Write,
  // real-hardware confirmed - see docs/knx-device-write-protocol.md §9.2)
  // instead of always requiring a physical programming-button press.
  // 'true' skips the choice prompt and does this automatically; '' (the
  // default) offers the choice each time.
  db.run(`INSERT OR IGNORE INTO settings VALUES ('auto_address_by_serial', '')`);

  // ── Migrations: add columns introduced after initial schema ──────────────
  // SQLite has no ADD COLUMN IF NOT EXISTS, so we check pragma first.
  assertDb(db);
  const dbRef = db;
  const migrate = (table: string, col: string, def: string): void => {
    try {
      const cols = dbRef.exec(`PRAGMA table_info(${table})`)[0];
      if (!cols) return;
      const exists = cols.values.some((row: unknown[]) => row[1] === col);
      if (!exists) dbRef.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch (e) {
      logger.warn('db', `migration: add ${table}.${col}`, {
        error: (e as Error).message,
      });
    }
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
  // Read-On-Init and Priority - added 2026-08-29 for Object 3 (Group Object
  // Table) support (docs/knx-device-write-protocol.md §10.1, knx-tables.ts's
  // GroupObjectFlags). read_on_init mirrors the other flag columns' boolean-
  // as-INTEGER convention; priority mirrors bus_telegrams.priority's
  // lowercase-string convention ('low'/'alarm'/'high'/'system').
  migrate('com_objects', 'read_on_init', 'INTEGER DEFAULT 0');
  migrate('com_objects', 'priority', "TEXT DEFAULT 'low'");
  // Raw Read/Write/Communication/Transmit booleans - added same day
  // alongside read_on_init/priority above. `flags` is a composite DISPLAY
  // string only (buildFlags()) and has a lossy all-false fallback ('CW') -
  // not safe to parse back into individual booleans for a real download.
  migrate('com_objects', 'read', 'INTEGER DEFAULT 0');
  migrate('com_objects', 'write', 'INTEGER DEFAULT 0');
  migrate('com_objects', 'comm', 'INTEGER DEFAULT 0');
  migrate('com_objects', 'tx', 'INTEGER DEFAULT 0');
  // Update - added 2026-08-29, as its own real fix (a real bug: this flag
  // was never given a dedicated raw column when read/write/comm/tx were,
  // and separately was resolved wrong - see the comment on CoDef.update in
  // ets-app.ts). Named `upd`, not `update` - `UPDATE` is a SQL keyword and
  // an unquoted column literally named that risks breaking any raw SQL
  // written against this table later; every other layer (ParsedComObject,
  // ComObject, GroupObjectFlags) still calls it `update`, this is a
  // DB-column-only rename.
  migrate('com_objects', 'upd', 'INTEGER DEFAULT 0');
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
  // has_address - added 2026-08-30, real bug fix: a <DeviceInstance> with no
  // Address attribute (never placed on a line in ETS) was defaulting to
  // device number 0, which both collides with the real ETS convention of
  // addressing a line's first/router device as 0 (confirmed against the
  // live Test Bed project) and, since individual_address is UNIQUE per
  // project, silently dropped every subsequent unaddressed device via
  // INSERT OR REPLACE - it never appeared in the Devices or Programming
  // views, with no error anywhere. Existing rows default to 1 (real
  // address) since they were only ever inserted from devices that DID have
  // one; only newly-imported unaddressed devices get 0.
  migrate('devices', 'has_address', 'INTEGER DEFAULT 1');
  migrate('catalog_items', 'model', "TEXT DEFAULT ''");
  migrate('catalog_items', 'bus_current', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'width_mm', 'REAL DEFAULT 0');
  migrate('catalog_items', 'is_power_supply', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'is_coupler', 'INTEGER DEFAULT 0');
  migrate('catalog_items', 'is_rail_mounted', 'INTEGER DEFAULT 0');
  // Real request, 2026-08-31: `LastUsedAPDULength` was already being
  // parsed off each real `<DeviceInstance>` (ets-parser.ts) but silently
  // dropped before reaching the DB - never persisted, never used. Found
  // while investigating real per-device chunk-size limits
  // (`PID_MAX_APDULENGTH`, see knx-connection.ts's own doc comment on
  // `_resolveMaxApduLength()`): the project file already caches this
  // value from ETS's own last real session with the device (confirmed
  // exact match against a live property-56 read for one real device,
  // 55==55), so it's a real, free, no-bus-round-trip source - preferred
  // over the live read when present, which now only serves as a fallback
  // for a device never downloaded to from this project.
  migrate('devices', 'apdu_length', "TEXT DEFAULT ''");
  // Count/detail of writes whose response never arrived during this
  // device's last download - see knx-connection.ts's DownloadResult doc
  // comment. Persisted so the "verify recommended" indicator survives a
  // reload; cleared (set back to 0/'[]') on the next download or a
  // successful verify.
  migrate('devices', 'unconfirmed_writes_count', 'INTEGER DEFAULT 0');
  migrate('devices', 'unconfirmed_writes_detail', "TEXT DEFAULT '[]'");
  // Persisted last-verify outcome, added 2026-09-01 - real request: "we
  // should consider an indicator for both successful verify and failed"
  // (mirrors the existing status/last_download persistence pattern for
  // downloads, immediately above). NULL means "never verified" (distinct
  // from a real 0/false failed verify) - a plain boolean column can't
  // represent that third state, hence nullable INTEGER, not
  // "DEFAULT 0"/BOOLEAN. Written by runVerifyDevice() (server/routes/
  // bus.ts) after a real live bus verify only - the cache-only recompute
  // path deliberately does not touch this column (see its own doc
  // comment: it never re-reads the device, so persisting a "verified"
  // result from it would be misleading). Cleared back to NULL on the next
  // download (/bus/program-device) and on any edit to data feeding a real
  // device write while a prior verify result exists
  // (markDeviceModifiedIfProgrammed, server/routes/shared.ts) - a verify
  // result only means something until the thing it verified changes.
  migrate('devices', 'last_verify_match', 'INTEGER');
  migrate('devices', 'last_verify_at', 'TEXT');
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
        } catch (e) {
          logger.warn('db', 'migration: topology area insert', {
            error: (e as Error).message,
          });
        }
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
        } catch (e) {
          logger.warn('db', 'migration: topology line insert', {
            error: (e as Error).message,
          });
        }
      }
    }
  } catch (e) {
    logger.warn('db', 'migration: topology data migration', {
      error: (e as Error).message,
    });
  }

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
  } catch (e) {
    logger.warn('db', 'migration: ga_group_names data migration', {
      error: (e as Error).message,
    });
  }

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

  // Real change-log, added 2026-09-01, replacing an earlier (same-day,
  // never-shipped-to-real-hardware) design that read the device's current
  // memory content and diffed it against the computed target - real user
  // correction: "I don't want to store a device memory cache. I want to
  // log changes in our DB (e.g. by edits)." This table IS that log: one row
  // per (device, kind, key) currently mid-edit, holding only the value from
  // BEFORE any of the edits pending against it (`baseline_value`, set once,
  // never overwritten while the row exists) and the latest edited value
  // (`current_value`, overwritten on every further edit to the same key).
  // No device bytes, no offsets, no "what we think is on the device" -
  // purely "what we've changed since the last successful download",
  // exactly the data model requested. `kind` is one of 'param_value' /
  // 'ga_link' / 'group_object_flag' (see resolvePendingWriteRanges() in
  // routes/bus.ts for how each maps to a specific relmem object/offset at
  // download time - deliberately NOT resolved or stored here, so a layout
  // fix never requires a data migration). Rows are upserted by
  // trackPendingChange() (routes/shared.ts): editing a key back to its own
  // baseline_value deletes the row outright (real request: "if user
  // re-edits a previous change back to original value, we clear the
  // tracking/undo modified status") rather than leaving a stale no-op row
  // around. Cleared entirely for a device once a download actually
  // completes ('until we have programmed successfully', per the same
  // request) - see clearPendingChanges(), called from /bus/program-device's
  // completion block alongside its existing status/verify resets.
  db.run(`
    CREATE TABLE IF NOT EXISTS device_pending_changes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id      INTEGER NOT NULL,
      kind           TEXT NOT NULL,
      key            TEXT NOT NULL,
      baseline_value TEXT,
      current_value  TEXT,
      created_at     TEXT DEFAULT (datetime('now','localtime')),
      updated_at     TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(device_id, kind, key)
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_pending_changes_device ON device_pending_changes(device_id)`,
  );

  // ── Indexes on project_id for query performance ───────────────────────────
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_devices_project ON devices(project_id)',
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_gas_project ON group_addresses(project_id)',
  );
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_co_project ON com_objects(project_id)',
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_co_device ON com_objects(device_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_spaces_project ON spaces(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_topo_project ON topology(project_id)');
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_telegrams_project ON bus_telegrams(project_id)',
  );

  save();
}

// ── Persist ───────────────────────────────────────────────────────────────────

export function save(): void {
  if (_inMemory) return;
  assertDb(db);
  const data = db.export(); // Uint8Array
  fs.writeFileSync(DB_PATH, Buffer.from(data));
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
  stmt.bind(params as SqlValue[]);
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
  db.run(sql, params as SqlValue[]);
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
  const project = get<Project>('SELECT * FROM projects WHERE id=?', [
    projectId,
  ]);
  if (!project) return null;

  // Real bug, found live 2026-09-01: this hand-maintained column list had
  // silently fallen 5 columns behind the real `Device` interface
  // (`apdu_length`, `unconfirmed_writes_count`, `unconfirmed_writes_detail`,
  // `last_verify_match`, `last_verify_at`) - a genuine live verify result
  // was correctly persisted server-side, then vanished from the UI on the
  // very next page refresh, because THIS is the query a refresh actually
  // calls (the sibling devices-list route, GET /projects/:pid/devices in
  // devices.ts, already used `SELECT *` and was unaffected - only this
  // one, less-visited path had drifted). An explicit column list needs a
  // matching edit here every time a column is added anywhere else in the
  // codebase, with nothing to enforce that at compile time (TypeScript's
  // own `all<Device>()` cast doesn't check the query actually returns
  // every field the type promises) - switched to `SELECT *`, matching the
  // sibling route's own convention, so this can't drift out of sync again.
  const devices = all<Device>(
    `SELECT * FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
    [projectId],
  );
  const gas = all<GroupAddress>(
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
  const normGas: EnrichedGA[] = gas.map((g) => ({
    ...g,
    main_group_name: mainNameMap[g.main_g] ?? '',
    middle_group_name: midNameMap[`${g.main_g}/${g.middle_g}`] ?? '',
    devices: gaDeviceMap[g.address] ?? [],
  }));

  const spaces = all<Space>(
    'SELECT * FROM spaces WHERE project_id=? ORDER BY id',
    [projectId],
  );

  const topoRows = all<Topology>(
    'SELECT * FROM topology WHERE project_id=? ORDER BY area, line',
    [projectId],
  );
  // Build lookup for area/line names
  const areaNameMap: Record<number, string> = {};
  const lineNameMap: Record<string, { name: string; medium: string }> = {};
  for (const t of topoRows) {
    if (t.line === null) areaNameMap[t.area] = t.name;
    else
      lineNameMap[`${t.area}.${t.line}`] = {
        name: t.name,
        medium: t.medium,
      };
  }
  // Attach topology names to devices
  const devicesWithTopo: Device[] = devices.map((d) => ({
    ...d,
    area_name: areaNameMap[d.area] ?? d.area_name ?? '',
    line_name: lineNameMap[`${d.area}.${d.line}`]?.name ?? d.line_name ?? '',
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
  };
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
  } catch (e) {
    /* never let audit logging break the main operation */
    logger.warn('db', 'audit insert failed', {
      error: (e as Error).message,
    });
  }
}
