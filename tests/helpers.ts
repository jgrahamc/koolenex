/**
 * Shared test helpers — server setup, HTTP request helper, fixture paths.
 */
import path from 'path';
import { type AddressInfo } from 'net';
import type { Server } from 'http';

// ── Fixture paths ────────────────────────────────────────────────────────────

export const FIXTURES_DIR = import.meta.dirname;

export const SMOKE_PROJECT = path.join(FIXTURES_DIR, 'smoke-test.knxproj');
export const SMOKE_PROJECT_PW = path.join(
  FIXTURES_DIR,
  'password-protected-smoke-test.knxproj',
);
export const KNXPROD_LSTOUCH = path.join(
  FIXTURES_DIR,
  '4295-LS-Touch-v5.1.knxprod',
);
export const KNXPROD_MDT_RAIN = path.join(
  FIXTURES_DIR,
  'MDT_KP_SCN_01_Rain_Sensor_V11.knxprod',
);

// ── HTTP request helper ──────────────────────────────────────────────────────

export interface ReqResult {
  status: number;
  data: unknown;
  headers: Headers;
}

export async function req(
  baseUrl: string,
  method: string,
  urlPath: string,
  body?: unknown,
  isFormData = false,
): Promise<ReqResult> {
  const url = baseUrl + urlPath;
  const headers: Record<string, string> = {};
  const opts: RequestInit = { method, headers };
  if (body && !isFormData) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body as BodyInit;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// ── Express test server ──────────────────────────────────────────────────────

export interface TestServer {
  server: Server;
  baseUrl: string;
  db: typeof import('../server/db.ts');
  close: () => void;
}

/**
 * Synchronous-feeling import helper for tests: POST the file, then poll the
 * status endpoint until the job reaches a terminal status. Returns the final
 * snapshot. Useful since the production endpoint is now async.
 */
export async function importProject(
  baseUrl: string,
  filePath: string,
  fileName = 'test.knxproj',
  password?: string,
  maxMs = 30_000,
): Promise<{
  importId: string;
  status: 'done' | 'failed';
  projectId?: number;
  summary?: {
    devices: number;
    groupAddresses: number;
    comObjects: number;
    links: number;
  };
  error?: string;
  code?: string;
}> {
  const fs = await import('fs');
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)]), fileName);
  if (password) fd.append('password', password);
  const kickoff = await req(baseUrl, 'POST', '/projects/import', fd, true);
  if (kickoff.status !== 200) {
    throw new Error(
      `import kickoff failed: ${kickoff.status} ${JSON.stringify(kickoff.data)}`,
    );
  }
  const importId = (kickoff.data as { importId: string }).importId;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await req(baseUrl, 'GET', `/projects/import/${importId}/status`);
    if (r.status === 200) {
      const snap = r.data as {
        importId: string;
        status: string;
        projectId?: number;
        summary?: {
          devices: number;
          groupAddresses: number;
          comObjects: number;
          links: number;
        };
        error?: string;
        code?: string;
      };
      if (snap.status === 'done' || snap.status === 'failed') {
        return {
          importId: snap.importId,
          status: snap.status,
          projectId: snap.projectId,
          summary: snap.summary,
          error: snap.error,
          code: snap.code,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`import ${importId} did not finish within ${maxMs}ms`);
}

/**
 * Spin up an Express test server with in-memory SQLite.
 * Call `close()` in your `after()` hook.
 */
export async function createTestServer(): Promise<TestServer> {
  const db = await import('../server/db.ts');
  await db.init({ inMemory: true });
  // The real app the server ships (server/app.ts) - same routes, same error
  // middleware - so a change there is visible to these tests. Only the CORS
  // layer and the static client are left off: tests drive it over loopback
  // and send no Origin header.
  const { createApp } = await import('../server/app.ts');
  const { app } = await createApp({ cors: 'none' });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://localhost:${port}/api`,
        db,
        close: () => server.close(),
      });
    });
  });
}
