/**
 * WebSocket integration tests.
 * Tests the WebSocket connection, initial handshake,
 * and KnxBusManager broadcast behavior.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { type AddressInfo } from 'net';

let server: http.Server;
let wss: WebSocketServer;
let port: number;

before(async () => {
  const app = express();
  server = http.createServer(app);
  wss = new WebSocketServer({ server });

  // Mirror the production handshake
  wss.on('connection', (ws) => {
    try {
      ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
    } catch {}
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

after(() => {
  wss.close();
  server.close();
});

function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait for the next message, with a timeout to prevent hangs. */
function nextMessage(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timeout waiting for WS message')),
      timeoutMs,
    );
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

/** Connect and consume the initial 'connected' handshake message. */
async function connectAndHandshake(): Promise<WebSocket> {
  const ws = await connectWS();
  await nextMessage(ws);
  return ws;
}

describe('WebSocket connection', () => {
  it('receives connected message on open', async () => {
    const ws = await connectWS();
    const msg = await nextMessage(ws);
    assert.equal(msg.type, 'connected');
    assert.ok(typeof msg.ts === 'number');
    ws.close();
  });

  it('handles multiple simultaneous clients', async () => {
    const ws1 = await connectAndHandshake();
    const ws2 = await connectAndHandshake();

    // Both received connected messages (consumed by connectAndHandshake)
    assert.equal(ws1.readyState, WebSocket.OPEN);
    assert.equal(ws2.readyState, WebSocket.OPEN);

    ws1.close();
    ws2.close();
  });
});

// Import KnxBusManager once at top level
const KnxBusManager = (await import('../server/knx-bus.ts')).default;

describe('KnxBusManager broadcast', () => {
  it('broadcasts messages to all connected clients', async () => {
    const bus = new KnxBusManager();
    bus.attachWSS(wss);

    const ws1 = await connectAndHandshake();
    const ws2 = await connectAndHandshake();

    // Broadcast a test message
    const p1 = nextMessage(ws1);
    const p2 = nextMessage(ws2);
    bus.broadcast('test:event', { value: 42 });

    const [msg1, msg2] = await Promise.all([p1, p2]);
    assert.equal(msg1.type, 'test:event');
    assert.equal(msg1.value, 42);
    assert.equal(msg2.type, 'test:event');
    assert.equal(msg2.value, 42);

    ws1.close();
    ws2.close();
  });

  it('broadcast skips clients that are not open', async () => {
    const bus = new KnxBusManager();
    bus.attachWSS(wss);

    const ws1 = await connectAndHandshake();
    const ws2 = await connectAndHandshake();

    // Close ws2
    ws2.close();
    await new Promise((r) => setTimeout(r, 50));

    // Broadcast — ws1 should get it, ws2 should not error
    const p1 = nextMessage(ws1);
    bus.broadcast('test:after-close', { ok: true });

    const msg = await p1;
    assert.equal(msg.type, 'test:after-close');
    assert.equal(msg.ok, true);

    ws1.close();
  });

  it('broadcast does nothing without WSS attached', () => {
    const bus = new KnxBusManager();
    // No WSS attached — should not throw
    bus.broadcast('test:no-wss', { x: 1 });
  });

  it('telegram remapper is applied', async () => {
    const bus = new KnxBusManager();
    bus.attachWSS(wss);

    bus.setRemapper((tg) => ({
      ...tg,
      dst: '0/0/99',
    }));

    const ws = await connectAndHandshake();

    const p = nextMessage(ws);
    const fakeTelegram = {
      src: '1.1.1',
      dst: '0/0/1',
      type: 'write',
      raw_value: '01',
    };

    const mapped = bus._remapFn!(fakeTelegram as any);
    bus.broadcast('knx:telegram', { telegram: mapped });

    const msg = await p;
    assert.equal(msg.type, 'knx:telegram');
    const tg = msg.telegram as Record<string, unknown>;
    assert.equal(tg.dst, '0/0/99'); // remapped

    ws.close();
  });
});
