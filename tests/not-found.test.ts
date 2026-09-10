/**
 * What every mutating route does with an id that does not exist, and with a
 * body that asks for no change.
 *
 * Six 404 assertions existed across 77 routes before this file. Two of the
 * routes here were answering something else entirely: PUT /projects/:id ran
 * its UPDATE against nothing and returned 200 with a null body, and the
 * device status PATCH did the same until 1be98b6.
 *
 * Table-driven, so a new mutating route is one line - and so the DELETE
 * split below stays visible rather than being rediscovered.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, req, type TestServer } from './helpers.ts';

let ts: TestServer;
let pid: number;
const NX = 999999;

before(async () => {
  ts = await createTestServer();
  const { data } = await req(ts.baseUrl, 'POST', '/projects', {
    name: 'not-found fixture',
  });
  pid = (data as { id: number }).id;
});

after(() => ts?.close());

describe('mutating routes: unknown id', () => {
  const CASES: Array<[string, string, unknown?]> = [
    ['PUT', `/projects/${NX}`, { name: 'x' }],
    ['PUT', `/projects/PID/devices/${NX}`, { name: 'x' }],
    ['PATCH', `/projects/PID/devices/${NX}/status`, { status: 'modified' }],
    ['PATCH', `/projects/PID/devices/${NX}/unassign`, {}],
    ['PATCH', `/projects/PID/devices/${NX}/param-values`, { values: {} }],
    ['PUT', `/projects/PID/gas/${NX}`, { name: 'x' }],
    ['PUT', `/projects/PID/spaces/${NX}`, { name: 'x' }],
    ['DELETE', `/projects/PID/spaces/${NX}`],
    ['PUT', `/projects/PID/topology/${NX}`, { name: 'x' }],
    ['DELETE', `/projects/PID/topology/${NX}`],
    ['PATCH', `/projects/PID/comobjects/${NX}/gas`, { ga_address: '1/1/1' }],
    ['PATCH', `/projects/PID/comobjects/${NX}/flags`, { flags: 'CRT' }],
  ];

  for (const [method, path, body] of CASES) {
    it(`${method} ${path} is 404`, async () => {
      const r = await req(
        ts.baseUrl,
        method,
        path.replace('PID', String(pid)),
        body,
      );
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal((r.data as { error: string }).error, 'Not found');
    });
  }
});

// Deliberately not 404: deleting something that is already gone is the
// outcome the caller asked for. api.test.ts's "DELETE returns ok for
// nonexistent device" is the documented contract for the device case.
//
// Note this is NOT uniform across the API - spaces and topology 404 instead
// (asserted above). Both behaviours are defensible; having both is what is
// odd, and it is pinned here so the split is a decision rather than a
// surprise.
describe('deletes that are idempotent', () => {
  const CASES: Array<[string, string]> = [
    ['DELETE', `/projects/PID/devices/${NX}`],
    ['DELETE', `/projects/PID/gas/${NX}`],
    ['DELETE', `/projects/PID/floor-plan/${NX}`],
    ['DELETE', `/projects/${NX}`],
  ];

  for (const [method, path] of CASES) {
    it(`${method} ${path} is 200 ok`, async () => {
      const r = await req(ts.baseUrl, method, path.replace('PID', String(pid)));
      assert.equal(r.status, 200, `${method} ${path}`);
      assert.deepEqual(r.data, { ok: true });
    });
  }
});

describe('updates with nothing to update', () => {
  it('PUT a device with no known field is 400', async () => {
    const { data: dev } = await req(
      ts.baseUrl,
      'POST',
      `/projects/${pid}/devices`,
      {
        individual_address: '1.1.9',
        name: 'nf',
        area: 1,
        line: 1,
      },
    );
    const id = (dev as { id: number }).id;
    const r = await req(ts.baseUrl, 'PUT', `/projects/${pid}/devices/${id}`, {
      not_a_column: 'x',
    });
    assert.equal(r.status, 400);
    assert.equal((r.data as { error: string }).error, 'No fields to update');
  });

  it('PUT a GA with no known field is 400', async () => {
    const { data: ga } = await req(ts.baseUrl, 'POST', `/projects/${pid}/gas`, {
      address: '7/0/1',
      name: 'nf',
      dpt: '1.001',
    });
    const id = (ga as { id: number }).id;
    const r = await req(ts.baseUrl, 'PUT', `/projects/${pid}/gas/${id}`, {
      not_a_column: 'x',
    });
    assert.equal(r.status, 400);
    assert.equal((r.data as { error: string }).error, 'No fields to update');
  });
});
