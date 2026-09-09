/**
 * Cross-project isolation for the routes that take BOTH a :pid and an
 * entity id.
 *
 * Three of them (device DELETE, device status PATCH, GA DELETE) used to
 * look the entity up by its own id alone and act on it regardless of which
 * project owned it - so `DELETE /projects/A/devices/{id-owned-by-B}` really
 * deleted B's device, and wrote the audit entry against A. Every sibling
 * route already scoped with `AND project_id=?`; these didn't, and nothing
 * tested it. These tests pin the behaviour down for all of them.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, req, type TestServer } from './helpers.ts';

let srv: TestServer;
let baseUrl: string;

/** Project A - the one named in the URL of every cross-project attempt. */
let projA: number;
/** Project B - the real owner of the entities under attack. */
let projB: number;
let devB: number;
let gaB: number;

before(async () => {
  srv = await createTestServer();
  baseUrl = srv.baseUrl;
});

after(() => srv.close());

async function post<T>(path: string, body: unknown): Promise<T> {
  const { status, data } = await req(baseUrl, 'POST', path, body);
  assert.equal(status, 200, `POST ${path} failed: ${JSON.stringify(data)}`);
  return data as T;
}

describe('cross-project isolation', () => {
  before(async () => {
    projA = (await post<{ id: number }>('/projects', { name: 'A' })).id;
    projB = (await post<{ id: number }>('/projects', { name: 'B' })).id;
    devB = (
      await post<{ id: number }>(`/projects/${projB}/devices`, {
        individual_address: '1.1.7',
        name: 'B device',
      })
    ).id;
    gaB = (
      await post<{ id: number }>(`/projects/${projB}/gas`, {
        address: '1/2/7',
        name: 'B group address',
      })
    ).id;
    // A com object on B's device, so the device DELETE has cascade work to
    // do - it must not run against another project's rows either.
    srv.db.run(
      'INSERT INTO com_objects (project_id, device_id, object_number, name) VALUES (?,?,?,?)',
      [projB, devB, 1, 'B com object'],
    );
  });

  // These two DELETEs are idempotent by contract (see the route comments):
  // an id this project doesn't own answers 200 like any other no-op. What
  // matters is that the other project's row survives.
  describe('DELETE /projects/:pid/devices/:did', () => {
    it('does not delete a device owned by another project', async () => {
      const { status } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projA}/devices/${devB}`,
      );
      assert.equal(status, 200);
    });

    it("leaves the other project's device and com objects intact", () => {
      const dev = srv.db.get('SELECT * FROM devices WHERE id=?', [devB]);
      assert.ok(dev, "B's device was deleted through project A");
      const cos = srv.db.all('SELECT * FROM com_objects WHERE device_id=?', [
        devB,
      ]);
      assert.equal(cos.length, 1, "B's com objects were deleted");
    });

    it('does not write an audit entry against the wrong project', () => {
      const rows = srv.db.all(
        "SELECT * FROM audit_log WHERE project_id=? AND action='delete'",
        [projA],
      );
      assert.equal(rows.length, 0);
    });
  });

  describe('PATCH /projects/:pid/devices/:did/status', () => {
    it('refuses a device id owned by another project', async () => {
      const { status } = await req(
        baseUrl,
        'PATCH',
        `/projects/${projA}/devices/${devB}/status`,
        { status: 'programmed' },
      );
      assert.equal(status, 404);
    });

    it("leaves the other project's device status unchanged", () => {
      const dev = srv.db.get<{ status: string }>(
        'SELECT status FROM devices WHERE id=?',
        [devB],
      );
      assert.equal(dev!.status, 'unassigned');
    });
  });

  describe('DELETE /projects/:pid/gas/:gid', () => {
    it('does not delete a group address owned by another project', async () => {
      const { status } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projA}/gas/${gaB}`,
      );
      assert.equal(status, 200);
    });

    it("leaves the other project's group address intact", () => {
      const ga = srv.db.get('SELECT * FROM group_addresses WHERE id=?', [gaB]);
      assert.ok(ga, "B's group address was deleted through project A");
    });
  });

  // A nonexistent id is the same case as "owned by someone else" - neither
  // is a row this project can act on, so each route answers exactly as it
  // does above.
  describe('unknown ids', () => {
    it('DELETE device → 200 (idempotent)', async () => {
      const { status, data } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projA}/devices/999999`,
      );
      assert.equal(status, 200);
      assert.equal((data as { ok: boolean }).ok, true);
    });

    it('PATCH device status → 404', async () => {
      const { status } = await req(
        baseUrl,
        'PATCH',
        `/projects/${projA}/devices/999999/status`,
        { status: 'programmed' },
      );
      assert.equal(status, 404);
    });

    it('DELETE group address → 200 (idempotent)', async () => {
      const { status, data } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projA}/gas/999999`,
      );
      assert.equal(status, 200);
      assert.equal((data as { ok: boolean }).ok, true);
    });
  });

  // The owning project must still be able to do all three, unchanged.
  describe('the owning project is unaffected', () => {
    it('PATCH status updates its own device', async () => {
      const { status, data } = await req(
        baseUrl,
        'PATCH',
        `/projects/${projB}/devices/${devB}/status`,
        { status: 'programmed' },
      );
      assert.equal(status, 200);
      assert.equal((data as { status: string }).status, 'programmed');
    });

    it('DELETE removes its own group address', async () => {
      const { status } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projB}/gas/${gaB}`,
      );
      assert.equal(status, 200);
      assert.equal(
        srv.db.get('SELECT * FROM group_addresses WHERE id=?', [gaB]),
        null,
      );
    });

    it('DELETE removes its own device and its com objects', async () => {
      const { status } = await req(
        baseUrl,
        'DELETE',
        `/projects/${projB}/devices/${devB}`,
      );
      assert.equal(status, 200);
      assert.equal(
        srv.db.get('SELECT * FROM devices WHERE id=?', [devB]),
        null,
      );
      assert.equal(
        srv.db.all('SELECT * FROM com_objects WHERE device_id=?', [devB])
          .length,
        0,
      );
    });
  });
});
