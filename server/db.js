'use strict';
/**
 * Database layer using sql.js (pure JavaScript SQLite — no native compilation).
 * 
 * sql.js runs the database in memory. We persist it to disk by writing the binary
 * .db file after every mutating operation. On startup we load from disk if it exists.
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'koolenex.db');

let SQL = null;  // sql.js module
let db  = null;  // Database instance

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log('[DB] Loaded from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database at', DB_PATH);
  }

  db.run("PRAGMA foreign_keys = ON");

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
  try { db.run("ALTER TABLE com_objects ADD COLUMN ga_send TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE com_objects ADD COLUMN ga_receive TEXT DEFAULT ''"); } catch {}

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
  const migrate = (table, col, def) => {
    try {
      const cols = db.exec(`PRAGMA table_info(${table})`)[0];
      if (!cols) return;
      const exists = cols.values.some(row => row[1] === col);
      if (!exists) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch (_) {}
  };
  migrate('devices', 'comment',             "TEXT DEFAULT ''");
  migrate('devices', 'order_number',        "TEXT DEFAULT ''");
  migrate('devices', 'serial_number',       "TEXT DEFAULT ''");
  migrate('devices', 'last_modified',       "TEXT DEFAULT ''");
  migrate('devices', 'last_download',       "TEXT DEFAULT ''");
  migrate('devices', 'area_name',           "TEXT DEFAULT ''");
  migrate('devices', 'line_name',           "TEXT DEFAULT ''");
  migrate('devices', 'medium',              "TEXT DEFAULT 'TP'");
  migrate('group_addresses', 'comment',           "TEXT DEFAULT ''");
  migrate('group_addresses', 'main_group_name',   "TEXT DEFAULT ''");
  migrate('group_addresses', 'middle_group_name', "TEXT DEFAULT ''");
  migrate('com_objects', 'channel',     "TEXT DEFAULT ''");
  migrate('com_objects', 'object_size', "TEXT DEFAULT ''");
  migrate('devices',     'space_id',    "INTEGER");
  migrate('devices',     'parameters',  "TEXT DEFAULT '[]'");
  migrate('devices',     'app_ref',     "TEXT DEFAULT ''");
  migrate('devices',     'param_values',"TEXT DEFAULT '{}'");
  migrate('spaces',      'usage_id',    "TEXT DEFAULT ''");
  migrate('devices',     'model_translations', "TEXT DEFAULT '{}'");
  migrate('devices',     'bus_current',     "INTEGER DEFAULT 0");
  migrate('devices',     'width_mm',        "REAL DEFAULT 0");
  migrate('devices',     'is_power_supply', "INTEGER DEFAULT 0");
  migrate('devices',     'is_coupler',      "INTEGER DEFAULT 0");
  migrate('devices',     'is_rail_mounted', "INTEGER DEFAULT 0");
  migrate('projects',    'thumbnail',   "TEXT DEFAULT ''");
  migrate('projects',    'project_info',"TEXT DEFAULT ''");
  migrate('devices',     'installation_hints', "TEXT DEFAULT ''");
  migrate('group_addresses', 'description', "TEXT DEFAULT ''");
  migrate('devices', 'floor_x', "REAL DEFAULT -1");
  migrate('devices', 'floor_y', "REAL DEFAULT -1");
  db.run(`INSERT OR IGNORE INTO settings VALUES ('demo_mode', '')`);
  db.run(`INSERT OR IGNORE INTO settings VALUES ('demo_addr_map', '')`);

  save();
}

// ── Persist ───────────────────────────────────────────────────────────────────

function save() {
  const data = db.export();          // Uint8Array
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Debounced save — avoids hammering disk during bulk imports
let saveTimer = null;
function scheduleSave(delayMs = 200) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { save(); saveTimer = null; }, delayMs);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Run a SELECT and return array of plain objects.
 */
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Run a SELECT and return the first row as a plain object, or null.
 */
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

/**
 * Run an INSERT/UPDATE/DELETE. Returns { lastInsertRowid, changes }.
 */
function run(sql, params = []) {
  db.run(sql, params);
  const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0] ?? null;
  return { lastInsertRowid };
}

/**
 * Run multiple statements in a transaction.
 * fn receives { all, get, run } and should not call save().
 * After fn returns, the db is saved once.
 */
function transaction(fn) {
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

function getProjectFull(projectId) {
  const project = get('SELECT * FROM projects WHERE id=?', [projectId]);
  if (!project) return null;

  const devices = all(
    `SELECT id,project_id,individual_address,name,description,comment,installation_hints,manufacturer,model,order_number,serial_number,product_ref,area,line,area_name,line_name,medium,device_type,status,last_modified,last_download,app_number,app_version,parameters,app_ref,param_values,space_id,model_translations,bus_current,width_mm,is_power_supply,is_coupler,is_rail_mounted,floor_x,floor_y FROM devices WHERE project_id=? ORDER BY area, line, CAST(REPLACE(individual_address, area||'.'||line||'.', '') AS INTEGER)`,
    [projectId]
  );
  const gas = all(
    'SELECT * FROM group_addresses WHERE project_id=? ORDER BY main_g, middle_g, sub_g',
    [projectId]
  );
  const comObjects = all(`
    SELECT co.*, d.individual_address as device_address, d.name as device_name
    FROM com_objects co JOIN devices d ON co.device_id=d.id
    WHERE co.project_id=? ORDER BY d.area, d.line, CAST(REPLACE(d.individual_address, d.area||'.'||d.line||'.', '') AS INTEGER), co.object_number
  `, [projectId]);
  // Derive device↔GA mappings from com_objects.ga_address (no separate link table)
  const deviceGAMap = {};
  const gaDeviceMap = {};
  for (const co of comObjects) {
    const da = co.device_address;
    for (const ga of (co.ga_address || '').split(/\s+/).filter(Boolean)) {
      if (!deviceGAMap[da]) deviceGAMap[da] = [];
      if (!deviceGAMap[da].includes(ga)) deviceGAMap[da].push(ga);
      if (!gaDeviceMap[ga]) gaDeviceMap[ga] = [];
      if (!gaDeviceMap[ga].includes(da)) gaDeviceMap[ga].push(da);
    }
  }

  // Normalise column names for GAs
  const normGas = gas.map(g => ({
    ...g,
    main:   g.main_g   ?? g.main   ?? 0,
    middle: g.middle_g ?? g.middle ?? 0,
    sub:    g.sub_g    ?? g.sub    ?? 0,
    devices: gaDeviceMap[g.address] || [],
  }));

  const spaces = all(
    'SELECT * FROM spaces WHERE project_id=? ORDER BY id',
    [projectId]
  );

  return { project, devices, gas: normGas, comObjects, deviceGAMap, gaDeviceMap, spaces };
}

module.exports = { init, save, scheduleSave, all, get, run, transaction, getProjectFull };
