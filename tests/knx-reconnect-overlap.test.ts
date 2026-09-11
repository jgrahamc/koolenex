/**
 * A reconnect must not hold two connections open to the same gateway.
 *
 * Real live failure, 2026-09-11. Verify calls forceReconnect() first, which
 * disconnects the current connection and immediately opens a new one to the
 * same router. disconnect() only *started* the teardown - the old socket was
 * destroyed on a 500ms timer - so for half a second the router had two TCP
 * connections from us, and it responded by taking the tunnel down a moment
 * after the new one came up:
 *
 *   18:33:15.725 Connected to 192.168.42.229:3671 (tcp)
 *   18:33:15.944 DeviceDescriptor mask=0x0701
 *   18:33:16.206 TCP socket closed          <- 500ms after the reconnect began
 *   18:33:19.066 Device verify failed: Management timeout waiting for
 *                Memory_Response
 *
 * These drive a real loopback TCP server standing in for the gateway, which
 * records every accept and close, so the assertion is the one that matters:
 * the second connection is never accepted while the first is still open.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { AddressInfo } from 'net';

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import { _SVC as SVC } from '../server/knx-protocol.ts';
import KnxBusManager from '../server/knx-bus.ts';

/** CONNECT_RESPONSE: header(6) + channelId + status + CRD(4) + HPAI(8). */
function connectRes(channelId: number): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0x06;
  buf[1] = 0x10;
  buf.writeUInt16BE(SVC.CONNECT_RES, 2);
  buf.writeUInt16BE(20, 4);
  buf[6] = channelId;
  buf[7] = 0x00; // E_NO_ERROR
  buf[8] = 0x04;
  buf[9] = 0x04;
  buf[10] = 0x08;
  buf[11] = 0x01;
  buf[18] = 0x11; // assigned individual address 1.1.2
  buf[19] = 0x02;
  return buf;
}

/**
 * The smallest gateway that gets KnxIpConnection to 'connected': answer
 * CONNECT_REQUEST, ignore everything else (DISCONNECT_REQUEST included - a
 * gateway that never answers it is the harsher case for the teardown path).
 */
class FakeGateway {
  server: net.Server;
  port = 0;
  /** 'open'/'close' in the order the gateway saw them. */
  events: string[] = [];
  live = 0;
  maxLive = 0;
  private channel = 1;

  constructor() {
    this.server = net.createServer((socket) => {
      this.events.push('open');
      this.live++;
      this.maxLive = Math.max(this.maxLive, this.live);
      socket.on('data', (chunk: Buffer) => {
        if (chunk.length >= 4 && chunk.readUInt16BE(2) === SVC.CONNECT_REQ) {
          socket.write(connectRes(this.channel++));
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        this.events.push('close');
        this.live--;
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let gw: FakeGateway;

before(async () => {
  gw = new FakeGateway();
  await gw.listen();
});

after(async () => {
  await gw?.close();
});

describe('KnxIpConnection.whenClosed', () => {
  it('resolves only once the socket is really gone', async () => {
    const conn = new KnxIpConnection();
    await conn.connect('127.0.0.1', gw.port, 2000, 'tcp');
    assert.equal(conn.connected, true);

    const before = gw.events.length;
    conn.disconnect();
    await conn.whenClosed();

    // Before the fix this resolved... never: there was nothing to await,
    // and the socket was still open for 500ms after disconnect() returned.
    assert.ok(
      gw.events.slice(before).includes('close'),
      'the gateway has seen the socket close by the time whenClosed resolves',
    );
    assert.equal(conn.tcpSocket, null);
  });

  it('is already resolved on a connection that was never connected', async () => {
    const conn = new KnxIpConnection();
    conn.disconnect(); // no socket: early return
    await conn.whenClosed();
  });
});

describe('KnxBusManager reconnect', () => {
  it('never has two connections open to the gateway at once', async () => {
    const bus = new KnxBusManager();
    gw.events.length = 0;
    gw.maxLive = 0;

    await bus.connect('127.0.0.1', gw.port, null, 'tcp');
    assert.equal(bus.connected, true);

    // The Verify path: disconnect and immediately reconnect to the same
    // gateway. This is the call that used to leave the old socket open
    // across the new connect.
    await bus.forceReconnect();
    assert.equal(bus.connected, true);

    bus.disconnect();
    await (bus.connection as KnxIpConnection | null)?.whenClosed();

    assert.equal(
      gw.maxLive,
      1,
      'two sockets were open to the gateway at the same time',
    );
    // The old one is closed before the new one is accepted, not after.
    assert.deepEqual(gw.events.slice(0, 3), ['open', 'close', 'open']);
  });
});
