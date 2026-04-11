/**
 * Shared test helpers — server setup, HTTP request helper, fixture paths.
 */
import express from 'express';
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
 * Spin up an Express test server with in-memory SQLite.
 * Call `close()` in your `after()` hook.
 */
export async function createTestServer(): Promise<TestServer> {
  const db = await import('../server/db.ts');
  await db.init({ inMemory: true });
  const { router: routes } = await import('../server/routes/index.ts');
  const { ValidationError } = await import('../server/validate.ts');

  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.errors.join('; ') });
        return;
      }
      res.status(500).json({ error: err.message || 'Internal server error' });
    },
  );

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
