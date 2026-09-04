import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import fs from 'fs';
import * as db from './db.ts';
import KnxBusManager from './knx-bus.ts';
import { logger } from './log.ts';
import { ValidationError } from './validate.ts';

const bus = new KnxBusManager();
const PORT = process.env.PORT || 4000;
const CORS_OPEN = process.argv.includes('--cors-open');

async function start(): Promise<void> {
  // Must init DB before routes can use it
  await db.init();

  // Lazy-load routes after DB is ready
  const { router: routes } = await import('./routes/index.ts');
  routes.setBus(bus);

  // Periodic sweep of stale import jobs (TTL eviction)
  const importJobs = await import('./routes/import-jobs.ts');
  importJobs.startSweeper();

  const app = express();
  app.use(
    CORS_OPEN
      ? cors({ origin: '*' })
      : cors({
          origin: (origin, callback) => {
            // Allow requests with no origin (same-origin, curl, etc.)
            if (!origin) return callback(null, true);
            // Allow localhost on any port (dev server, prod server)
            if (/^https?:\/\/localhost(:\d+)?$/.test(origin))
              return callback(null, true);
            callback(new Error('CORS not allowed'));
          },
        }),
  );
  if (CORS_OPEN) logger.warn('api', 'CORS open to all origins (--cors-open)');
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
  const frontendDist = path.join(process.cwd(), 'client', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*path', (_req, res) =>
      res.sendFile(path.join(frontendDist, 'index.html')),
    );
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  bus.attachWSS(wss);

  wss.on('connection', (ws) => {
    try {
      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    } catch (_) {}

    // A client (the Monitor view, specifically) can ask the bus to
    // proactively keep the KNX connection alive across a gateway idle
    // timeout for as long as it's actively watching - see
    // KnxBusManager.addKeepAliveRef()'s doc comment for why this is opt-in
    // rather than unconditional. The ref is released automatically if the
    // client disconnects without an explicit watch:stop (tab closed,
    // navigated away, network drop), so it can never leak.
    let releaseKeepAlive: (() => void) | null = null;
    ws.on('message', (raw) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      if (msg.type === 'watch:start') {
        if (!releaseKeepAlive) releaseKeepAlive = bus.addKeepAliveRef();
      } else if (msg.type === 'watch:stop') {
        releaseKeepAlive?.();
        releaseKeepAlive = null;
      }
    });
    ws.on('close', () => {
      releaseKeepAlive?.();
      releaseKeepAlive = null;
    });
  });

  server.listen(PORT, () => {
    logger.info('api', `koolenex started on port ${String(PORT)}`);
  });

  // Real bug, found live 2026-08-31: KnxBusManager's connection state is
  // purely in-memory - every server restart lost it entirely, even though
  // the last-used host/port/protocol were already being persisted to the
  // settings table on every successful /bus/connect (server/routes/bus.ts)
  // and just never read back. A fresh process reported connected=false,
  // needsAttention=false ("Idle", the calm default) - genuinely correct
  // for a project that's never been connected to a bus at all, but
  // actively misleading right after a restart when there WAS a real,
  // working connection moments before: a live device write/verify
  // attempted right then fails outright ("Not connected to KNX bus"),
  // directly contradicting the calm badge - a real user finding the same
  // day ("So it is definitely disconnected, but showing Idle... investigate
  // and resolve"). Auto-reconnecting to the last known target on boot (when
  // one is on record at all) closes this at the source: either it
  // succeeds and the operator never has to manually reconnect after a
  // restart, or it fails and needsAttention/the 'knx:reconnect-failed'
  // broadcast (both already wired into connect() itself) correctly flip
  // the badge to "Disconnected" instead of a misleading "Idle". Fire-and-
  // forget - must not block server startup on a real network round trip.
  const lastHost = db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key='knxip_host'",
  )?.value;
  if (lastHost) {
    const lastPort = Number(
      db.get<{ value: string }>(
        "SELECT value FROM settings WHERE key='knxip_port'",
      )?.value || 3671,
    );
    const lastProtocol =
      (db.get<{ value: string }>(
        "SELECT value FROM settings WHERE key='knxip_protocol'",
      )?.value as 'udp' | 'tcp' | 'auto' | undefined) || 'auto';
    bus.connect(lastHost, lastPort, undefined, lastProtocol).catch((err: Error) => {
      logger.warn('knx', 'Auto-reconnect to last known host failed on boot', {
        host: lastHost,
        port: lastPort,
        error: err.message,
      });
    });
  }

  // Real bug, found live 2026-08-30: this process had no shutdown handler
  // at all - every restart during development (Ctrl+C, a normal `kill`, a
  // supervisor restart) let the Node process just vanish, abandoning
  // whatever TCP tunneling connection was open without ever sending the
  // real KNX_bus.disconnect()'s own DISCONNECT_REQUEST. Real KNX IP
  // routers support only a small number of concurrent tunnel channels;
  // real ETS always disconnects cleanly on its own session lifecycle and
  // has never hit this, while this project's own dev-time restarts (many,
  // over one long real-hardware session) plausibly left the router
  // holding several channels it believed were still active, a real
  // candidate for the otherwise-unexplained `ECONNRESET` failures seen
  // that same session. Does NOT help against a hard kill (`taskkill /F`,
  // SIGKILL) - those bypass all process handlers, same as pulling the
  // plug - but protects every normal restart from here on. The real
  // disconnect (KnxConnection.disconnect() in knx-protocol.ts) sends the
  // DISCONNECT_REQUEST synchronously but closes the socket on a short
  // `setTimeout` afterward to let it flush - give the process a brief
  // grace period rather than exiting the instant the handler returns.
  const shutdown = (signal: string): void => {
    logger.info('api', `${signal} received, disconnecting bus before exit`);
    try {
      bus.disconnect();
    } catch (_) {}
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err: unknown) => {
  logger.error('api', 'Failed to start', {
    error: (err as Error).message || String(err),
  });
  process.exit(1);
});
