/**
 * Tests for the KNXnet/IP transport layer: KnxIpConnection message dispatcher
 * (knx-protocol.ts) and KnxBusManager state management (knx-bus.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import {
  buildCEMI,
  _apduGroupRead as apduGroupRead,
  _apduGroupWrite as apduGroupWrite,
} from '../server/knx-cemi.ts';

// ── KnxIpConnection message dispatcher ────────────────────────────────────────

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import { _SVC as SVC } from '../server/knx-protocol.ts';

describe('KnxIpConnection._onConnectRes', () => {
  it('sets connected state and channelId on success', () => {
    const conn = new KnxIpConnection();
    const events: string[] = [];
    conn.on('_connected', () => events.push('_connected'));
    conn.on('connected', () => events.push('connected'));

    // Build a CONNECT_RES: header(6) + channelId(1) + status(1) + CRD(4) + HPAI(8)
    const buf = Buffer.alloc(20);
    // Header
    buf[0] = 0x06;
    buf[1] = 0x10;
    buf.writeUInt16BE(SVC.CONNECT_RES, 2);
    buf.writeUInt16BE(20, 4);
    // Channel ID
    buf[6] = 0x42;
    // Status OK
    buf[7] = 0x00;
    // CRD (4 bytes)
    buf[8] = 0x04;
    buf[9] = 0x04;
    // Data endpoint HPAI (8 bytes) — starts at offset 10
    buf[10] = 0x08;
    buf[11] = 0x01;
    // local address at bytes 18-19
    buf[18] = 0x11; // 1.1.x
    buf[19] = 0x02; // x.x.2

    conn._onConnectRes(buf);

    assert.equal(conn.channelId, 0x42);
    assert.equal(conn.connected, true);
    assert.equal(conn.localAddr, '1.1.2');
    assert.ok(events.includes('_connected'));
    assert.ok(events.includes('connected'));

    // Clean up heartbeat timer
    conn._clearHeartbeat();
  });

  it('emits _connectFailed on non-zero status', () => {
    const conn = new KnxIpConnection();
    let failedErr: Error | null = null;
    conn.on('_connectFailed', (err: Error) => {
      failedErr = err;
    });

    const buf = Buffer.alloc(8);
    buf[0] = 0x06;
    buf[1] = 0x10;
    buf.writeUInt16BE(SVC.CONNECT_RES, 2);
    buf.writeUInt16BE(8, 4);
    buf[6] = 0x42;
    buf[7] = 0x24; // E_NO_MORE_CONNECTIONS

    conn._onConnectRes(buf);

    assert.ok(failedErr);
    assert.ok(failedErr!.message.includes('0x24'));
    assert.equal(conn.connected, false);
  });

  it('ignores too-short message', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onConnectRes(Buffer.alloc(5));
    assert.equal(conn.connected, false);
  });
});

describe('KnxIpConnection._onDisconnectReq', () => {
  it('clears connected state and emits disconnected', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    let disconnected = false;
    conn.on('disconnected', () => {
      disconnected = true;
    });

    const buf = Buffer.alloc(16);
    buf[6] = 0x42; // channel ID

    conn._onDisconnectReq(buf);

    assert.equal(conn.connected, false);
    assert.ok(disconnected);
  });
});

describe('KnxIpConnection._onDisconnectRes', () => {
  it('clears connected state and emits disconnected', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    let disconnected = false;
    conn.on('disconnected', () => {
      disconnected = true;
    });

    conn._onDisconnectRes();

    assert.equal(conn.connected, false);
    assert.ok(disconnected);
  });
});

describe('KnxIpConnection._onTunnelingReq', () => {
  it('sends ACK and processes CEMI', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    const sentRaw: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sentRaw.push(buf);

    const telegrams: unknown[] = [];
    conn.on('telegram', (tg) => telegrams.push(tg));

    // Build a tunneling request with embedded CEMI GroupValue_Write
    const apdu = apduGroupWrite(true, '1');
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const msg = Buffer.alloc(10 + cemi.length);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(10 + cemi.length, 4);
    msg[6] = 0x04; // connection header length
    msg[7] = 0x42; // channel ID
    msg[8] = 0x05; // sequence number
    msg[9] = 0x00; // reserved
    cemi.copy(msg, 10);

    conn._onTunnelingReq(msg);

    // Should have sent an ACK
    assert.equal(sentRaw.length, 1);
    const ackBuf = sentRaw[0]!;
    assert.equal(ackBuf.readUInt16BE(2), SVC.TUNNELING_ACK);
    assert.equal(ackBuf[7], 0x42); // channel ID
    assert.equal(ackBuf[8], 0x05); // sequence echoed

    // Should have emitted telegram
    assert.equal(telegrams.length, 1);
    assert.equal(conn.seqIn, 0x05);
  });

  it('deduplicates same sequence number', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn._sendRaw = () => {};

    const telegrams: unknown[] = [];
    conn.on('telegram', (tg) => telegrams.push(tg));

    const apdu = apduGroupWrite(true, '1');
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const msg = Buffer.alloc(10 + cemi.length);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(10 + cemi.length, 4);
    msg[6] = 0x04;
    msg[7] = 0x42;
    msg[8] = 0x03; // seq=3
    cemi.copy(msg, 10);

    conn._onTunnelingReq(msg);
    conn._onTunnelingReq(msg); // same seq — should be deduplicated

    assert.equal(telegrams.length, 1); // only one telegram emitted
  });

  it('ignores too-short messages', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onTunnelingReq(Buffer.alloc(8));
  });
});

describe('KnxIpConnection._onTunnelingAck', () => {
  it('resolves pending ACK on success', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    // Start a sendCEMI which sets up a pending ACK
    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 2000);

    // Simulate ACK for seq 0
    const ackMsg = Buffer.alloc(10);
    ackMsg[0] = 0x06;
    ackMsg[1] = 0x10;
    ackMsg.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    ackMsg.writeUInt16BE(10, 4);
    ackMsg[6] = 0x04;
    ackMsg[7] = 0x42;
    ackMsg[8] = 0x00; // seq=0
    ackMsg[9] = 0x00; // status OK

    conn._onTunnelingAck(ackMsg);

    await sendPromise; // should resolve without error
  });

  it('rejects pending ACK on error status', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 2000);

    const ackMsg = Buffer.alloc(10);
    ackMsg[0] = 0x06;
    ackMsg[1] = 0x10;
    ackMsg.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    ackMsg.writeUInt16BE(10, 4);
    ackMsg[6] = 0x04;
    ackMsg[7] = 0x42;
    ackMsg[8] = 0x00; // seq=0
    ackMsg[9] = 0x29; // error status

    conn._onTunnelingAck(ackMsg);

    await assert.rejects(sendPromise, /Tunneling ACK error/);
  });

  it('times out when no ACK received', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    await assert.rejects(() => conn.sendCEMI(cemi, 100), {
      message: 'Tunneling ACK timeout',
    });
  });

  it('ignores ACK with wrong sequence', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 200);

    // Send ACK with wrong seq
    const ackMsg = Buffer.alloc(10);
    ackMsg[8] = 0x05; // wrong seq (should be 0)
    ackMsg[9] = 0x00;
    conn._onTunnelingAck(ackMsg);

    // Should still time out
    await assert.rejects(sendPromise, { message: 'Tunneling ACK timeout' });
  });
});

describe('KnxIpConnection._onMsg dispatcher', () => {
  it('dispatches CONNECT_RES', () => {
    const conn = new KnxIpConnection();
    let called = false;
    conn._onConnectRes = () => {
      called = true;
    };

    const msg = Buffer.alloc(8);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.CONNECT_RES, 2);
    msg.writeUInt16BE(8, 4);

    conn._onMsg(msg, {} as any);
    assert.ok(called);
  });

  it('dispatches TUNNELING_REQ', () => {
    const conn = new KnxIpConnection();
    let called = false;
    conn._onTunnelingReq = () => {
      called = true;
    };

    const msg = Buffer.alloc(12);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(12, 4);

    conn._onMsg(msg, {} as any);
    assert.ok(called);
  });

  it('ignores too-short messages', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onMsg(Buffer.alloc(4), {} as any);
  });
});

describe('KnxIpConnection.disconnect', () => {
  it('is a no-op without a socket', () => {
    const conn = new KnxIpConnection();
    // No socket — early return, should not throw
    conn.disconnect();
    assert.equal(conn.connected, false);
  });
});

describe('KnxIpConnection.sendCEMI sequence', () => {
  it('increments sequence number and wraps at 256', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    conn._sendRaw = () => {};

    // Set seqOut near wrap point
    conn.seqOut = 254;

    // Each sendCEMI creates a pending ACK — resolve them to allow next send
    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    // Send 3 frames: seq 254, 255, 0
    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 255);
    // Resolve pending ACK
    assert.ok(conn._pendingAck);
    clearTimeout(conn._pendingAck.timer);
    conn._pendingAck.resolve();
    conn._pendingAck = null;

    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 0); // wrapped
    clearTimeout(conn._pendingAck!.timer);
    conn._pendingAck!.resolve();
    conn._pendingAck = null;

    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 1);
    clearTimeout(conn._pendingAck!.timer);
    conn._pendingAck!.resolve();
    conn._pendingAck = null;
  });
});

describe('KnxIpConnection.sendCEMI queue serialization', () => {
  function ackMsg(channelId: number, seq: number, status = 0x00): Buffer {
    const b = Buffer.alloc(10);
    b[0] = 0x06;
    b[1] = 0x10;
    b.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    b.writeUInt16BE(10, 4);
    b[6] = 0x04;
    b[7] = channelId;
    b[8] = seq;
    b[9] = status;
    return b;
  }

  it('holds a second send off the wire until the first is ACKed, then sends it with the next sequence number', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    const sent: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sent.push(buf);

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    const p1 = conn.sendCEMI(cemi, 5000);
    const p2 = conn.sendCEMI(cemi, 5000);

    // Only the first packet should be on the wire; the second is queued
    // behind it, and _pendingAck must belong to the first send.
    assert.equal(sent.length, 1);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 0);

    conn._onTunnelingAck(ackMsg(1, 0));
    await p1;

    // ACKing the first send must release the second synchronously.
    assert.equal(sent.length, 2);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 1);

    conn._onTunnelingAck(ackMsg(1, 1));
    await p2;
  });

  it('does not deadlock the queue when the first send times out', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    const sent: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sent.push(buf);

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    const p1 = conn.sendCEMI(cemi, 50);
    const p2 = conn.sendCEMI(cemi, 5000);

    assert.equal(sent.length, 1);

    await assert.rejects(p1, { message: 'Tunneling ACK timeout' });

    // The internal timeout settles _sendCEMIOnce's promise via the raw
    // closure reject (bypassing _pendingAck), so the queue drains on a
    // follow-up microtask rather than synchronously — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sent.length, 2);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 1);

    conn._onTunnelingAck(ackMsg(1, 1));
    await p2;
  });
});

describe('KnxIpConnection.status', () => {
  it('returns correct status', () => {
    const conn = new KnxIpConnection();
    conn.host = '192.168.1.1';
    conn.port = 3671;
    conn.connected = true;

    const s = conn.status();
    assert.equal(s.connected, true);
    assert.equal(s.host, '192.168.1.1');
    assert.equal(s.port, 3671);
    assert.equal(s.hasLib, true);
  });
});

// ── KnxBusManager ─────────────────────────────────────────────────────────────

const KnxBusManager = (await import('../server/knx-bus.ts')).default;

describe('KnxBusManager: not-connected guards', () => {
  it('write rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.write('1/0/0', true), /Not connected/);
  });

  it('read rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.read('1/0/0'), /Not connected/);
  });

  it('ping rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.ping(['1/0/0']), /Not connected/);
  });

  it('identify rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.identify('1.1.1'), /Not connected/);
  });

  it('scan rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.scan(1, 1), /Not connected/);
  });

  it('readDeviceInfo rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.readDeviceInfo('1.1.1'), /Not connected/);
  });

  it('programIA rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.programIA('1.1.1'), /Not connected/);
  });

  it('downloadDevice rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(
      () => bus.downloadDevice('1.1.1', [], null, null, null),
      /Not connected/,
    );
  });
});

describe('KnxBusManager._ensureConnected', () => {
  it('reconnects using the last known host/port/type when idle-dropped', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connection = null;

    let connectCalls = 0;
    bus.connect = (async (
      host: string,
      port: number,
      _projectId?: number | string | null,
      protocol?: string,
    ) => {
      connectCalls++;
      assert.equal(host, '10.0.0.5');
      assert.equal(port, 3671);
      assert.equal(protocol, 'tcp');
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await bus._ensureConnected();
    assert.equal(connectCalls, 1);
    assert.equal(bus.connected, true);
  });

  it('does not reconnect if already connected', async () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.connection = {} as any;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus._ensureConnected();
    assert.equal(connectCalls, 0);
  });

  it('rejects without attempting reconnect when no host is known', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await assert.rejects(() => bus._ensureConnected(), /Not connected/);
    assert.equal(connectCalls, 0);
  });

  it('rejects without attempting reconnect for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    bus.type = 'usb';
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await assert.rejects(() => bus._ensureConnected(), /Not connected/);
    assert.equal(connectCalls, 0);
  });

  it('coalesces concurrent reconnect attempts into a single connect() call', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;

    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      await new Promise((r) => setTimeout(r, 10));
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await Promise.all([
      bus._ensureConnected(),
      bus._ensureConnected(),
      bus._ensureConnected(),
    ]);
    assert.equal(connectCalls, 1);
  });

  it('broadcasts knx:reconnect-failed on a real failure by default', async () => {
    // Real request 2026-08-31: lets the connection badge distinguish a
    // calm "not connected" idle state from a genuine "needs manual
    // attention" one. Every real bus route calls _ensureConnected() with
    // no arguments, so the default must broadcast.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus._ensureConnected(), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
  });

  it('does not broadcast when called with broadcastFailure=false', async () => {
    // _autoReconnect() passes false for its own intermediate retries - a
    // single attempt failing mid-backoff isn't yet "exhausted" and
    // shouldn't flip the badge to "needs attention" prematurely.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus._ensureConnected(false), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 0);
  });
});

describe('KnxBusManager.forceReconnect', () => {
  it('reconnects using the last known host/port/type even while already connected', async () => {
    // Real request 2026-08-31, after a real live failure (a Verify that
    // started right after an idle-drop-and-reconnect still failed - the
    // request had already gone out on the dying connection). Unlike
    // _ensureConnected(), this must reconnect even when `connected` is
    // already true - that's the whole point.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;

    let connectCalls = 0;
    bus.connect = (async (
      host: string,
      port: number,
      _projectId?: number | string | null,
      protocol?: string,
    ) => {
      connectCalls++;
      assert.equal(host, '10.0.0.5');
      assert.equal(port, 3671);
      assert.equal(protocol, 'tcp');
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 1, 'connect() is called even though already connected');
  });

  it('is a no-op when never connected at all (no known host)', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 0);
  });

  it('is a no-op for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = null;
    bus.type = 'usb';
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 0);
  });

  it('propagates a real connection failure to the caller', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    await assert.rejects(() => bus.forceReconnect(), /ECONNREFUSED/);
  });

  it('broadcasts knx:reconnect-failed on a real failure', async () => {
    // forceReconnect() bypasses _ensureConnected() entirely (calls
    // connect() directly), so it needs its own broadcast on failure -
    // otherwise a Program/Verify's own forced reconnect failing would
    // never surface on the connection badge at all.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus.forceReconnect(), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
  });
});

describe('KnxBusManager._autoReconnect', () => {
  it('reconnects immediately on first attempt while a keep-alive ref is held', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    // _autoReconnect is fire-and-forget; let its promise chain settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 1);
    assert.equal(bus.connected, true);
  });

  it('does nothing when no keep-alive ref is held, even with a known host', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    // No addKeepAliveRef() call - nothing has registered interest in a
    // proactive reconnect (e.g. no Monitor view open, no download running).

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('stops retrying once the last keep-alive ref is released mid-backoff', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    const release = bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(connectCalls, 1);
      assert.equal(scheduled.length, 1);

      // e.g. the Monitor view unmounted before the scheduled retry fires.
      release();
      const next = scheduled.shift()!;
      next();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(connectCalls, 1);
    assert.equal(scheduled.length, 0);
  });

  it('does nothing for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.host = null;
    bus.type = 'usb';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('retries with backoff on failure, up to a bounded number of attempts', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    // Intercept setTimeout so the retry schedule advances instantly
    // instead of waiting through real backoff delays.
    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      // Drain the retry chain: each failed attempt schedules exactly one
      // more retry via the stubbed setTimeout, up to maxAttempts (5).
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const next = scheduled.shift();
        if (next) next();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(connectCalls, 5);
    assert.equal(scheduled.length, 0);
  });

  it('stops retrying once an explicit disconnect clears the host', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(connectCalls, 1);
      assert.equal(scheduled.length, 1);

      // Simulate the user disconnecting before the scheduled retry fires.
      bus.host = null;
      const next = scheduled.shift()!;
      next();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The retry re-checks host/type before calling connect() again.
    assert.equal(connectCalls, 1);
    assert.equal(scheduled.length, 0);
  });

  it('broadcasts knx:reconnect-failed only once retries are genuinely exhausted', async () => {
    // Real request 2026-08-31: a single attempt failing mid-backoff isn't
    // "exhausted" - the badge should stay calm/idle through the retry
    // sequence, only escalating to "needs attention" once every attempt
    // has failed. Drives all 5 real attempts (maxAttempts in
    // _autoReconnect) by manually firing each scheduled retry.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    bus.connect = (async () => {
      throw new Error('gateway unreachable');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      // Attempts 1-4 each schedule a retry and broadcast nothing.
      for (let i = 0; i < 4; i++) {
        assert.equal(broadcasts.length, 0, `no broadcast yet after attempt ${i + 1}`);
        const next = scheduled.shift()!;
        next();
        await new Promise((r) => setImmediate(r));
      }
      // The 5th (final) attempt exhausts maxAttempts and broadcasts once.
      assert.equal(scheduled.length, 0);
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('KnxBusManager.addKeepAliveRef', () => {
  it('ref-counts and only reaches zero once every release() is called', () => {
    const bus = new KnxBusManager();
    assert.equal(bus._keepAliveRefs, 0);

    const releaseA = bus.addKeepAliveRef();
    const releaseB = bus.addKeepAliveRef();
    assert.equal(bus._keepAliveRefs, 2);

    releaseA();
    assert.equal(bus._keepAliveRefs, 1);

    releaseB();
    assert.equal(bus._keepAliveRefs, 0);
  });

  it('is idempotent - calling the same release() twice does not underflow', () => {
    const bus = new KnxBusManager();
    const release = bus.addKeepAliveRef();
    release();
    release();
    assert.equal(bus._keepAliveRefs, 0);
  });
});

describe('KnxBusManager.disconnect', () => {
  it('clears state', () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = '192.168.1.1';
    bus.type = 'udp';

    bus.disconnect();

    assert.equal(bus.connected, false);
    assert.equal(bus.host, null);
    assert.equal(bus.type, null);
  });

  it('clears state even if connection.disconnect throws', () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = '192.168.1.1';
    bus.type = 'udp';
    bus.connection = {
      disconnect() {
        throw new Error('boom');
      },
    } as any;

    bus.disconnect();

    assert.equal(bus.connected, false);
    assert.equal(bus.connection, null);
  });

  it('disconnect before connect is a no-op', () => {
    const bus = new KnxBusManager();
    bus.disconnect(); // should not throw
    assert.equal(bus.connected, false);
  });
});

describe('KnxBusManager.status', () => {
  it('returns default status', () => {
    const bus = new KnxBusManager();
    const s = bus.status();
    assert.equal(s.connected, false);
    assert.equal(s.type, null);
    assert.equal(s.host, null);
    assert.equal(s.port, 3671);
    assert.equal(s.hasLib, true);
  });
});

describe('KnxBusManager event forwarding', () => {
  it('forwards telegram events with remapper and projectId', () => {
    const bus = new KnxBusManager();
    bus.projectId = 42;
    bus.setRemapper((tg) => ({ ...tg, dst: '0/0/99' }));

    const broadcasted: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasted.push({ type, payload });
    };

    // Create a mock connection with EventEmitter
    const conn = new EventEmitter();
    bus.connection = conn;
    bus._attachEvents(conn);

    // Simulate a telegram from the connection
    const fakeTelegram = {
      timestamp: new Date().toISOString(),
      src: '1.1.1',
      dst: '1/0/0',
      type: 'GroupValue_Write',
      raw_value: '01',
      decoded: '1',
      priority: 'low',
    };
    conn.emit('telegram', fakeTelegram);

    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, 'knx:telegram');
    const tg = broadcasted[0].payload.telegram as Record<string, unknown>;
    assert.equal(tg.dst, '0/0/99'); // remapped
    assert.equal(tg.projectId, 42);
  });

  it('forwards disconnect events', () => {
    const bus = new KnxBusManager();
    const broadcasted: string[] = [];
    bus.broadcast = (type: string) => {
      broadcasted.push(type);
    };

    const conn = new EventEmitter();
    bus._attachEvents(conn);
    conn.emit('disconnected');

    assert.equal(bus.connected, false);
    assert.ok(broadcasted.includes('knx:disconnected'));
  });

  it('does not proactively reconnect on disconnect without a keep-alive ref', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.type = 'tcp';
    bus.broadcast = () => {};
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    const conn = new EventEmitter();
    bus._attachEvents(conn);
    conn.emit('disconnected');
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('proactively reconnects on disconnect while a keep-alive ref is held', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.type = 'tcp';
    bus.broadcast = () => {};
    bus.addKeepAliveRef();
    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    const conn = new EventEmitter();
    bus._attachEvents(conn);
    conn.emit('disconnected');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 1);
  });

  it('forwards error events', () => {
    const bus = new KnxBusManager();
    const broadcasted: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasted.push({ type, payload });
    };

    const conn = new EventEmitter();
    bus._attachEvents(conn);
    conn.emit('error', new Error('socket died'));

    assert.equal(bus.connected, false);
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, 'knx:error');
    assert.equal(broadcasted[0].payload.error, 'Error: socket died');
  });
});

describe('KnxBusManager.broadcast', () => {
  it('preserves the message-kind discriminator even when the payload has its own `type` field', () => {
    const bus = new KnxBusManager();
    const sent: Array<{ readyState: number; data?: string }> = [];
    const client = {
      readyState: 1,
      send(data: string) {
        sent.push({ readyState: 1, data });
      },
    };
    bus.attachWSS({ clients: new Set([client]) } as any);

    // A payload field literally named `type` (e.g. a connection's
    // transport, 'tcp') must not collide with and overwrite the outer
    // message-kind discriminator the client dispatches on.
    bus.broadcast('knx:connected', { host: '10.0.0.5', type: 'tcp' });

    assert.equal(sent.length, 1);
    const parsed = JSON.parse(sent[0]!.data!);
    assert.equal(parsed.type, 'knx:connected');
  });

  it("connect()'s knx:connected broadcast carries the transport under connectionType, not type", async () => {
    const bus = new KnxBusManager();
    const sent: string[] = [];
    bus.attachWSS({
      clients: new Set([
        {
          readyState: 1,
          send(data: string) {
            sent.push(data);
          },
        },
      ]),
    } as any);

    // KnxBusManager.connect() constructs its own KnxIpConnection instance
    // internally (no dependency injection) - patch the shared prototype's
    // connect() so that instance resolves to a fake, network-free
    // implementation instead of attempting a real socket connection.
    const knxProtocol = await import('../server/knx-protocol.ts');
    const proto = (knxProtocol.KnxConnection as any).prototype;
    const realConnect = proto.connect;
    proto.connect = async function (this: any) {
      this.transport = 'tcp';
    };

    try {
      await bus.connect('10.0.0.5', 3671, 1, 'tcp');
    } finally {
      proto.connect = realConnect;
    }

    const connectedMsg = sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === 'knx:connected');
    assert.ok(connectedMsg, 'a knx:connected message was broadcast');
    assert.equal(connectedMsg.connectionType, 'tcp');
    assert.equal(connectedMsg.host, '10.0.0.5');
  });
});
