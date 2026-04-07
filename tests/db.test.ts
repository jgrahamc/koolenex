import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../server/db.ts';

before(async () => {
  await db.init();
});

// ── init / tables & default settings ────────────────────────────────────────

describe('init', () => {
  it('creates all expected tables', () => {
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .map((r: any) => r.name);
    for (const t of [
      'projects',
      'devices',
      'group_addresses',
      'com_objects',
      'ga_device_links',
      'spaces',
      'bus_telegrams',
      'settings',
      'topology',
      'catalog_sections',
      'catalog_items',
      'ga_group_names',
      'audit_log',
    ]) {
      assert.ok(tables.includes(t), `missing table: ${t}`);
    }
  });

  it('inserts default settings', () => {
    const host = db.get("SELECT value FROM settings WHERE key='knxip_host'");
    assert.equal(host.value, '224.0.23.12');

    const port = db.get("SELECT value FROM settings WHERE key='knxip_port'");
    assert.equal(port.value, '3671');

    const active = db.get(
      "SELECT value FROM settings WHERE key='active_project_id'",
    );
    assert.equal(active.value, '');

    const demo = db.get("SELECT value FROM settings WHERE key='demo_mode'");
    assert.ok(demo, 'demo_mode setting should exist');

    const demoMap = db.get(
      "SELECT value FROM settings WHERE key='demo_addr_map'",
    );
    assert.ok(demoMap, 'demo_addr_map setting should exist');
  });
});

// ── all() ───────────────────────────────────────────────────────────────────

describe('all()', () => {
  it('returns empty array for no matches', () => {
    const rows = db.all(
      "SELECT * FROM projects WHERE name='dbtest_nonexistent_xyz'",
    );
    assert.deepEqual(rows, []);
  });

  it('returns array of plain objects', () => {
    db.run("INSERT INTO projects (name) VALUES ('dbtest_all_obj')");
    const rows = db.all(
      "SELECT name FROM projects WHERE name='dbtest_all_obj'",
    );
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].name, 'dbtest_all_obj');
  });

  it('binds parameters correctly', () => {
    db.run("INSERT INTO projects (name) VALUES ('dbtest_bind_param')");
    const rows = db.all('SELECT name FROM projects WHERE name=?', [
      'dbtest_bind_param',
    ]);
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].name, 'dbtest_bind_param');
  });

  it('returns multiple rows in order', () => {
    const tag = `dbtest_order_${Date.now()}`;
    db.run(`INSERT INTO projects (name) VALUES ('${tag}_a')`);
    db.run(`INSERT INTO projects (name) VALUES ('${tag}_b')`);
    const rows = db.all(
      `SELECT name FROM projects WHERE name LIKE '${tag}%' ORDER BY name`,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, `${tag}_a`);
    assert.equal(rows[1].name, `${tag}_b`);
  });
});

// ── get() ───────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns first row as object', () => {
    db.run("INSERT INTO projects (name) VALUES ('dbtest_get_first')");
    const row = db.get(
      "SELECT name FROM projects WHERE name='dbtest_get_first'",
    );
    assert.ok(row);
    assert.equal(row.name, 'dbtest_get_first');
  });

  it('returns null for no matches', () => {
    const row = db.get(
      "SELECT * FROM projects WHERE name='dbtest_get_none_xyz'",
    );
    assert.equal(row, null);
  });
});

// ── run() ───────────────────────────────────────────────────────────────────

describe('run()', () => {
  it('returns lastInsertRowid after INSERT', () => {
    const result = db.run(
      "INSERT INTO projects (name) VALUES ('dbtest_run_id')",
    );
    assert.ok(typeof result.lastInsertRowid === 'number');
    assert.ok(result.lastInsertRowid > 0);
  });

  it('returns changes count after UPDATE', () => {
    const { lastInsertRowid } = db.run(
      "INSERT INTO projects (name) VALUES ('dbtest_run_upd')",
    );
    const result = db.run('UPDATE projects SET name=? WHERE id=?', [
      'dbtest_run_upd2',
      lastInsertRowid,
    ]);
    assert.equal(result.changes, 1);
  });

  it('returns changes count after DELETE', () => {
    const { lastInsertRowid } = db.run(
      "INSERT INTO projects (name) VALUES ('dbtest_run_del')",
    );
    const result = db.run('DELETE FROM projects WHERE id=?', [lastInsertRowid]);
    assert.equal(result.changes, 1);
  });
});

// ── transaction() ───────────────────────────────────────────────────────────

describe('transaction()', () => {
  it('commits on success — data persists', () => {
    db.transaction(({ run }: any) => {
      run("INSERT INTO projects (name) VALUES ('dbtest_tx_ok')");
    });
    const row = db.get("SELECT name FROM projects WHERE name='dbtest_tx_ok'");
    assert.ok(row);
    assert.equal(row.name, 'dbtest_tx_ok');
  });

  it('rolls back on error — data not persisted', () => {
    assert.throws(() => {
      db.transaction(({ run }: any) => {
        run("INSERT INTO projects (name) VALUES ('dbtest_tx_fail')");
        throw new Error('forced rollback');
      });
    }, /forced rollback/);
    const row = db.get("SELECT name FROM projects WHERE name='dbtest_tx_fail'");
    assert.equal(row, null);
  });

  it('returns value from fn', () => {
    const val = db.transaction(() => 42);
    assert.equal(val, 42);
  });

  it('fn receives { all, get, run } helpers', () => {
    db.transaction((helpers: any) => {
      assert.equal(typeof helpers.all, 'function');
      assert.equal(typeof helpers.get, 'function');
      assert.equal(typeof helpers.run, 'function');
    });
  });
});

// ── audit() ─────────────────────────────────────────────────────────────────

describe('audit()', () => {
  it('inserts audit_log row', () => {
    // Use a unique project_id to avoid collisions
    const pid = 99900;
    db.audit(pid, 'test_action', 'test_entity', 'eid_123', 'some detail');
    const row = db.get(
      "SELECT * FROM audit_log WHERE project_id=? AND action='test_action'",
      [pid],
    );
    assert.ok(row);
    assert.equal(row.project_id, pid);
    assert.equal(row.action, 'test_action');
    assert.equal(row.entity, 'test_entity');
    assert.equal(row.entity_id, 'eid_123');
    assert.equal(row.detail, 'some detail');
  });

  it('handles null entityId/detail gracefully', () => {
    const pid = 99901;
    db.audit(pid, 'test_null', 'ent', null, null);
    const row = db.get(
      "SELECT * FROM audit_log WHERE project_id=? AND action='test_null'",
      [pid],
    );
    assert.ok(row);
    assert.equal(row.entity_id, '');
    assert.equal(row.detail, '');
  });
});

// ── getProjectFull() ────────────────────────────────────────────────────────

describe('getProjectFull()', () => {
  let projectId: any;

  before(() => {
    // 1. Create a project
    const { lastInsertRowid: pid } = db.run(
      "INSERT INTO projects (name) VALUES ('dbtest_full_proj')",
    );
    projectId = pid;

    // 2. Add a device with area=1, line=2
    db.run(
      `INSERT INTO devices (project_id, individual_address, name, area, line, area_name, line_name, medium)
       VALUES (?, '1.2.3', 'dbtest_dev_A', 1, 2, '', '', 'TP')`,
      [projectId],
    );
    const devId = db.get(
      "SELECT id FROM devices WHERE individual_address='1.2.3' AND project_id=?",
      [projectId],
    ).id;

    // 3. Add group addresses with main_g, middle_g, sub_g
    db.run(
      `INSERT INTO group_addresses (project_id, address, name, dpt, main_g, middle_g, sub_g)
       VALUES (?, '1/2/3', 'dbtest_ga_light', 'DPST-1-1', 1, 2, 3)`,
      [projectId],
    );
    db.run(
      `INSERT INTO group_addresses (project_id, address, name, dpt, main_g, middle_g, sub_g)
       VALUES (?, '1/2/4', 'dbtest_ga_dimmer', 'DPST-5-1', 1, 2, 4)`,
      [projectId],
    );

    // 4. Add com_objects linking device to GAs (space-separated ga_address)
    db.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, name, ga_address)
       VALUES (?, ?, 0, 'Switch', '1/2/3 1/2/4')`,
      [projectId, devId],
    );

    // 5. Add ga_group_names for main and middle groups
    db.run(
      `INSERT INTO ga_group_names (project_id, main_g, middle_g, name)
       VALUES (?, 1, -1, 'Lighting')`,
      [projectId],
    );
    db.run(
      `INSERT INTO ga_group_names (project_id, main_g, middle_g, name)
       VALUES (?, 1, 2, 'Living Room')`,
      [projectId],
    );

    // 6. Add topology entries
    db.run(
      `INSERT INTO topology (project_id, area, line, name, medium)
       VALUES (?, 1, NULL, 'Building A', 'TP')`,
      [projectId],
    );
    db.run(
      `INSERT INTO topology (project_id, area, line, name, medium)
       VALUES (?, 1, 2, 'Line 1.2', 'TP')`,
      [projectId],
    );
  });

  it('returns null for non-existent project', () => {
    const result = db.getProjectFull(999999);
    assert.equal(result, null);
  });

  it('returns project with all sub-collections', () => {
    const full = db.getProjectFull(projectId);
    assert.ok(full);
    assert.ok(full.project);
    assert.equal(full.project.name, 'dbtest_full_proj');
    assert.ok(Array.isArray(full.devices));
    assert.ok(Array.isArray(full.gas));
    assert.ok(Array.isArray(full.comObjects));
    assert.ok(Array.isArray(full.spaces));
    assert.ok(Array.isArray(full.topology));
  });

  it('includes devices', () => {
    const full = db.getProjectFull(projectId);
    const dev = full.devices.find((d: any) => d.individual_address === '1.2.3');
    assert.ok(dev, 'device 1.2.3 not found');
    assert.equal(dev.name, 'dbtest_dev_A');
  });

  it('includes group addresses with normalised fields', () => {
    const full = db.getProjectFull(projectId);
    const ga = full.gas.find((g: any) => g.address === '1/2/3');
    assert.ok(ga, 'GA 1/2/3 not found');
    assert.equal(ga.main_g, 1);
    assert.equal(ga.middle_g, 2);
    assert.equal(ga.sub_g, 3);
  });

  it('builds deviceGAMap from com_objects', () => {
    const full = db.getProjectFull(projectId);
    assert.ok(full.deviceGAMap['1.2.3']);
    assert.ok(full.deviceGAMap['1.2.3'].includes('1/2/3'));
    assert.ok(full.deviceGAMap['1.2.3'].includes('1/2/4'));
  });

  it('builds gaDeviceMap from com_objects', () => {
    const full = db.getProjectFull(projectId);
    assert.ok(full.gaDeviceMap['1/2/3']);
    assert.ok(full.gaDeviceMap['1/2/3'].includes('1.2.3'));
    assert.ok(full.gaDeviceMap['1/2/4']);
    assert.ok(full.gaDeviceMap['1/2/4'].includes('1.2.3'));
  });

  it('merges group names from ga_group_names table', () => {
    const full = db.getProjectFull(projectId);
    const ga = full.gas.find((g: any) => g.address === '1/2/3');
    assert.equal(ga.main_group_name, 'Lighting');
    assert.equal(ga.middle_group_name, 'Living Room');
  });

  it('attaches GA device list', () => {
    const full = db.getProjectFull(projectId);
    const ga = full.gas.find((g: any) => g.address === '1/2/3');
    assert.ok(Array.isArray(ga.devices));
    assert.ok(ga.devices.includes('1.2.3'));
  });

  it('attaches topology area/line names to devices', () => {
    const full = db.getProjectFull(projectId);
    const dev = full.devices.find((d: any) => d.individual_address === '1.2.3');
    assert.equal(dev.area_name, 'Building A');
    assert.equal(dev.line_name, 'Line 1.2');
  });

  it('returns topology rows', () => {
    const full = db.getProjectFull(projectId);
    assert.ok(full.topology.length >= 2);
    const area = full.topology.find(
      (t: any) => t.project_id === projectId && t.line === null,
    );
    assert.ok(area, 'area topology row not found');
    assert.equal(area.name, 'Building A');
  });
});
