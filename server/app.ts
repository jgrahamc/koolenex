/**
 * Express app construction, shared by the real server (server/index.ts) and
 * the test harness (tests/helpers.ts).
 *
 * This lived in three places until 2026-09-09: server/index.ts's start(),
 * tests/helpers.ts's createTestServer(), and a third hand-rolled copy inside
 * tests/api.test.ts. The copies carried their own error middleware, so the
 * status codes the largest test file asserted against were the copy's, not
 * the ones the server actually returns - a middleware change in index.ts
 * could not fail a test.
 *
 * Routes are imported lazily here for the same reason index.ts did it: they
 * capture the db module at import time, so db.init() must have completed
 * before this is called.
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { logger } from './log.ts';
import { ValidationError } from './validate.ts';
import type KnxBusManager from './knx-bus.ts';

// Koolenex is a self-hosted LAN tool: accept requests from localhost, the
// same origin as the server, RFC1918/link-local IPs, and *.local (mDNS).
// This covers direct access on :4000 as well as vite dev-server access on
// :5173, whose proxy rewrites Host to localhost:4000 (changeOrigin: true),
// which would otherwise defeat a plain same-origin check.
export function isLocalOrigin(
  origin: string,
  host: string | undefined,
): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (_) {
    return false;
  }
  if (host && url.host === host) return true;
  const h = url.hostname.toLowerCase();
  // URL.hostname keeps the brackets on an IPv6 literal ('[::1]'), which is
  // why the fc00::/fe80:: patterns below allow for one - the bare '::1' arm
  // could never match on its own.
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]')
    return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // IPv4 link-local
  if (/^\[?f[cd]/i.test(h)) return true; // IPv6 unique-local fc00::/7
  if (/^\[?fe[89ab]/i.test(h)) return true; // IPv6 link-local fe80::/10
  if (/\.local$/i.test(h)) return true; // mDNS
  return false;
}

export interface CreateAppOptions {
  /**
   * 'local' (default) applies the LAN-origin allowlist above, 'open' allows
   * any origin (the --cors-open flag), 'none' installs no CORS middleware -
   * tests drive the app over loopback and never send an Origin header.
   */
  cors?: 'local' | 'open' | 'none';
  /** Serve client/dist with an SPA fallback, if that directory exists. */
  serveClient?: boolean;
  /** Bus manager to hand the routes; omitted in tests that never touch it. */
  bus?: KnxBusManager;
}

export interface CreatedApp {
  app: express.Express;
  routes: Awaited<typeof import('./routes/index.ts')>['router'];
}

export async function createApp(
  opts: CreateAppOptions = {},
): Promise<CreatedApp> {
  const { cors: corsMode = 'local', serveClient = false, bus } = opts;

  const { router: routes } = await import('./routes/index.ts');
  if (bus) routes.setBus(bus);

  const app = express();

  if (corsMode === 'open') {
    app.use(cors({ origin: '*' }));
    logger.warn('api', 'CORS open to all origins (--cors-open)');
  } else if (corsMode === 'local') {
    app.use(
      cors((req, callback) => {
        const origin = req.header('Origin');
        // Allow requests with no origin (same-origin, curl, etc.)
        if (!origin) return callback(null, { origin: true });
        if (isLocalOrigin(origin, req.header('Host')))
          return callback(null, { origin: true });
        callback(new Error('CORS not allowed'));
      }),
    );
  }

  app.use(express.json());
  app.use('/api', routes);

  // Error handling middleware — catch unhandled route errors
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
      logger.error('api', 'Unhandled error', { error: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    },
  );

  // Serve built frontend
  if (serveClient) {
    const frontendDist = path.join(process.cwd(), 'client', 'dist');
    if (fs.existsSync(frontendDist)) {
      app.use(express.static(frontendDist));
      app.get('*path', (_req, res) =>
        res.sendFile(path.join(frontendDist, 'index.html')),
      );
    }
  }

  return { app, routes };
}
