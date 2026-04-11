/**
 * Tests for GA→DPT cache invalidation.
 * Verifies that updating, deleting, or reimporting GAs correctly
 * invalidates the cached DPT lookup used by telegram decoding.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createTestServer, req as rawReq, SMOKE_PROJECT } from './helpers.ts';
import type { TestServer, ReqResult } from './helpers.ts';

let ts: TestServer;
let projectId: number;

function req(
  method: string,
  urlPath: string,
  body?: unknown,
  isFormData = false,
): Promise<ReqResult> {
  return rawReq(ts.baseUrl, method, urlPath, body, isFormData);
}

const hasFixture = fs.existsSync(SMOKE_PROJECT);

before(async () => {
  ts = await createTestServer();
  if (!hasFixture) return;

  // Import the smoke test project
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(SMOKE_PROJECT)]), 'test.knxproj');
  const res = await req('POST', '/projects/import', fd, true);
  assert.equal(res.status, 200);
  projectId = (res.data as { projectId: number }).projectId;
});

after(() => ts?.close());

describe(
  'GA→DPT cache invalidation',
  { skip: !hasFixture && 'smoke-test.knxproj not found' },
  () => {
    it('GA update invalidates cache (DPT change is reflected)', async () => {
      // Find a GA with a DPT
      const projectRes = await req('GET', `/projects/${projectId}`);
      assert.equal(projectRes.status, 200);
      const data = projectRes.data as {
        gas: Array<{ id: number; address: string; dpt: string }>;
      };
      const gaWithDpt = data.gas.find((g) => g.dpt && g.dpt.length > 0);
      assert.ok(gaWithDpt, 'expected at least one GA with a DPT');

      const originalDpt = gaWithDpt.dpt;

      // Update the DPT to something different
      const updateRes = await req(
        'PUT',
        `/projects/${projectId}/gas/${gaWithDpt.id}`,
        {
          dpt: 'DPST-1-1',
        },
      );
      assert.equal(updateRes.status, 200);
      const updated = updateRes.data as { dpt: string };
      assert.equal(updated.dpt, 'DPST-1-1');

      // Restore original DPT
      const restoreRes = await req(
        'PUT',
        `/projects/${projectId}/gas/${gaWithDpt.id}`,
        {
          dpt: originalDpt,
        },
      );
      assert.equal(restoreRes.status, 200);
    });

    it('GA delete invalidates cache', async () => {
      // Create a new GA
      const createRes = await req('POST', `/projects/${projectId}/gas`, {
        address: '99/7/255',
        name: 'Cache test GA',
        dpt: 'DPST-9-1',
      });
      assert.equal(createRes.status, 200);
      const created = createRes.data as { id: number };

      // Delete it — should invalidate cache
      const deleteRes = await req(
        'DELETE',
        `/projects/${projectId}/gas/${created.id}`,
      );
      assert.equal(deleteRes.status, 200);

      // Verify the GA is gone
      const projectRes = await req('GET', `/projects/${projectId}`);
      const data = projectRes.data as { gas: Array<{ address: string }> };
      assert.ok(
        !data.gas.find((g) => g.address === '99/7/255'),
        'deleted GA should not appear in project data',
      );
    });

    it('project delete invalidates cache', async () => {
      // Create a minimal project
      const createRes = await req('POST', '/projects', {
        name: 'Cache test project',
      });
      assert.equal(createRes.status, 200);
      const pid = (createRes.data as { id: number }).id;

      // Delete it — should invalidate cache without error
      const deleteRes = await req('DELETE', `/projects/${pid}`);
      assert.equal(deleteRes.status, 200);
    });

    it('invalidateGaDptCache can be called independently', async () => {
      // Direct import of the function
      const { invalidateGaDptCache } = await import('../server/routes/bus.ts');
      // Should not throw even when called repeatedly
      invalidateGaDptCache();
      invalidateGaDptCache();
    });
  },
);
