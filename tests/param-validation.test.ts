/**
 * Every :id-style route parameter must reject a non-numeric value with 400.
 *
 * routes/index.ts declares eight of these validators - id, pid, did, gid,
 * sid, tid, coid, spaceId - as eight byte-identical handlers, and not one of
 * them was asserted anywhere. Table-driven so a ninth parameter is one line
 * here, and so the eight can be collapsed into a loop with something
 * checking that they still all behave.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, req, type TestServer } from './helpers.ts';

let ts: TestServer;

before(async () => {
  ts = await createTestServer();
});

after(() => ts?.close());

/** One route per declared parameter, with that parameter made non-numeric. */
const CASES: Array<{ param: string; method: string; path: string }> = [
  { param: 'id', method: 'GET', path: '/projects/abc/devices' },
  { param: 'pid', method: 'POST', path: '/projects/abc/spaces' },
  { param: 'did', method: 'DELETE', path: '/projects/1/devices/abc' },
  { param: 'gid', method: 'DELETE', path: '/projects/1/gas/abc' },
  { param: 'sid', method: 'DELETE', path: '/projects/1/spaces/abc' },
  { param: 'tid', method: 'DELETE', path: '/projects/1/topology/abc' },
  { param: 'coid', method: 'PATCH', path: '/projects/1/comobjects/abc/gas' },
  {
    param: 'spaceId',
    method: 'DELETE',
    path: '/projects/1/floor-plan/abc',
  },
];

describe('route parameter validation', () => {
  for (const { param, method, path } of CASES) {
    it(`:${param} rejects a non-numeric value`, async () => {
      const r = await req(ts.baseUrl, method, path);
      assert.equal(r.status, 400, `${method} ${path}`);
      assert.match(
        (r.data as { error: string }).error,
        new RegExp(`Invalid ID: ${param}`),
      );
    });
  }

  // The check is "digits only", not "parses as a number" - these all reach
  // parseInt happily and would silently address the wrong row.
  for (const val of ['1abc', '-1', '1.5', '1e3', '', ' ', '%20']) {
    it(`:id rejects ${JSON.stringify(val)}`, async () => {
      const r = await req(ts.baseUrl, 'GET', `/projects/${val}/devices`);
      assert.notEqual(r.status, 200, `"${val}" should not reach the handler`);
    });
  }

  it('lets a numeric value through to the handler', async () => {
    // 404-or-empty, but past the validator - which is the point.
    const r = await req(ts.baseUrl, 'GET', '/projects/999999/devices');
    assert.notEqual(r.status, 400);
  });
});
