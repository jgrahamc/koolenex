/**
 * PROJECT_TABLES must stay in step with the schema.
 *
 * A project's rows are wiped in two places - a reimport, which replaces the
 * imported content, and DELETE /projects/:id, which removes everything -
 * and each used to carry its own hand-written list of DELETE statements,
 * eight tables in one and ten in the other. Adding a per-project table
 * meant remembering to edit both. This asks SQLite which tables actually
 * have a project_id column, so a new one fails here until it is listed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, req, type TestServer } from './helpers.ts';
import { PROJECT_TABLES, REIMPORT_KEEPS } from '../server/routes/projects.ts';

let ts: TestServer;

before(async () => {
  ts = await createTestServer();
});

after(() => ts?.close());

/** Every table in the live schema that carries a project_id column. */
function tablesWithProjectId(): string[] {
  const tables = ts.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  return tables
    .map((t) => t.name)
    .filter((name) =>
      ts.db
        .all<{ name: string }>(`PRAGMA table_info(${name})`)
        .some((col) => col.name === 'project_id'),
    )
    .sort();
}

describe('PROJECT_TABLES', () => {
  it('lists exactly the tables that have a project_id column', () => {
    assert.deepEqual([...PROJECT_TABLES].sort(), tablesWithProjectId());
  });

  it('deletes com_objects before devices', () => {
    // deleteProjectRows sweeps com_objects by device as well as by
    // project_id, which reads from devices - so com_objects has to come
    // first in the list.
    assert.ok(
      PROJECT_TABLES.indexOf('com_objects') < PROJECT_TABLES.indexOf('devices'),
    );
  });

  it('keeps a project’s own history across a reimport', () => {
    // Not part of the .knxproj, so a reimport must not take them with it.
    assert.deepEqual([...REIMPORT_KEEPS].sort(), [
      'audit_log',
      'bus_telegrams',
    ]);
  });
});

describe('DELETE /projects/:id clears every per-project table', () => {
  it('leaves no row behind in any of them', async () => {
    const created = await req(ts.baseUrl, 'POST', '/projects', {
      name: 'wipe me',
    });
    const pid = (created.data as { id: number }).id;

    // One row in every per-project table, written directly: going through
    // the API would only reach the tables the API happens to write, which
    // is the gap this test exists to close.
    ts.db.run(
      "INSERT INTO devices (project_id, individual_address, name, param_values) VALUES (?,'1.1.1','d','{}')",
      [pid],
    );
    const devId = ts.db.get<{ id: number }>(
      'SELECT last_insert_rowid() AS id',
    )!.id;
    ts.db.run(
      'INSERT INTO com_objects (project_id, device_id, object_number) VALUES (?,?,1)',
      [pid, devId],
    );
    ts.db.run(
      "INSERT INTO group_addresses (project_id, address, name, main_g, middle_g, sub_g) VALUES (?,'1/1/1','g',1,1,1)",
      [pid],
    );
    ts.db.run(
      "INSERT INTO ga_group_names (project_id, main_g, middle_g, name) VALUES (?,1,1,'n')",
      [pid],
    );
    ts.db.run(
      "INSERT INTO topology (project_id, area, line, name, medium) VALUES (?,1,1,'t','TP')",
      [pid],
    );
    // catalog_sections/catalog_items key on (project_id, id) with a TEXT
    // id from the ETS catalog, not a rowid.
    ts.db.run(
      "INSERT INTO catalog_sections (id, project_id, name) VALUES ('S-1',?,'s')",
      [pid],
    );
    ts.db.run(
      "INSERT INTO catalog_items (id, project_id, name) VALUES ('I-1',?,'i')",
      [pid],
    );
    ts.db.run(
      "INSERT INTO spaces (project_id, name, type) VALUES (?,'s','room')",
      [pid],
    );
    ts.db.run(
      "INSERT INTO bus_telegrams (project_id, src, dst, type) VALUES (?,'1.1.1','1/1/1','GroupValue_Write')",
      [pid],
    );
    ts.db.run(
      "INSERT INTO audit_log (project_id, action, entity, entity_id, detail) VALUES (?,'test','project','x','y')",
      [pid],
    );

    for (const table of PROJECT_TABLES) {
      const n = ts.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`,
        [pid],
      )!.n;
      assert.ok(n > 0, `${table} should have a row to delete`);
    }

    const del = await req(ts.baseUrl, 'DELETE', `/projects/${pid}`);
    assert.equal(del.status, 200);

    for (const table of PROJECT_TABLES) {
      const n = ts.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`,
        [pid],
      )!.n;
      assert.equal(n, 0, `${table} still has rows for the deleted project`);
    }
    assert.ok(!ts.db.get('SELECT id FROM projects WHERE id=?', [pid]));
  });
});
