import http from 'http';
import { WebSocketServer } from 'ws';
import * as db from './db.ts';
import KnxBusManager from './knx-bus.ts';
import { logger } from './log.ts';
import { createApp } from './app.ts';

const bus = new KnxBusManager();
const PORT = process.env.PORT || 4000;
const CORS_OPEN = process.argv.includes('--cors-open');

async function start(): Promise<void> {
  // Must init DB before routes can use it
  await db.init();

  // Periodic sweep of stale import jobs (TTL eviction)
  const importJobs = await import('./routes/import-jobs.ts');
  importJobs.startSweeper();

  // Routes are loaded inside createApp, after the db.init() above
  const { app } = await createApp({
    cors: CORS_OPEN ? 'open' : 'local',
    serveClient: true,
    bus,
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  bus.attachWSS(wss);

  wss.on('connection', (ws) => {
    try {
      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    } catch (_) {}

    // A client can ask the bus to keep the connection alive across a
    // gateway idle timeout while it's actively watching - see
    // KnxBusManager.addKeepAliveRef(). Released automatically on
    // disconnect (tab closed, network drop) even without watch:stop, so it
    // can never leak.
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

  // KnxBusManager's connection state is in-memory only, so a restart loses
  // it even though host/port/protocol are persisted (settings table) on
  // every successful /bus/connect. Auto-reconnect to the last known target
  // on boot avoids a misleading "Idle" badge after restart when a working
  // connection existed moments before; failure correctly flips the badge to
  // "Disconnected" via connect()'s own needsAttention/reconnect-failed path.
  // Fire-and-forget - must not block server startup on a network round trip.
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
    bus
      .connect(lastHost, lastPort, undefined, lastProtocol)
      .catch((err: Error) => {
        logger.warn('knx', 'Auto-reconnect to last known host failed on boot', {
          host: lastHost,
          port: lastPort,
          error: err.message,
        });
      });
  }

  // A graceful shutdown sends DISCONNECT_REQUEST before the process exits,
  // so a restart doesn't abandon a TCP tunneling channel the router still
  // thinks is active (a plausible cause of ECONNRESET on the next connect).
  // Does not help against a hard kill (SIGKILL/taskkill /F). The disconnect
  // itself (KnxConnection.disconnect()) closes the socket on a short delay
  // to let the request flush, hence the grace period here.
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
