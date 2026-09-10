/**
 * Tests for KnxIpConnection's TCP stream frame-reassembly (_onTcpData) -
 * real KNXnet/IP-over-TCP messages arrive as an arbitrary byte stream, not
 * one-message-per-event the way UDP datagrams do. Logic verified against
 * Calimero's real StreamConnection.runReceiveLoop() - see
 * docs/knx-device-write-protocol.md §9. Isolated from real sockets: constructs
 * a KnxIpConnection directly and feeds _onTcpData() raw bytes, spying on
 * _onMsg() to record what full messages it reassembled.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import {
  _hdr as hdr,
  _SVC as SVC,
  _pktConnState as pktConnState,
  _HOST_PROTOCOL as HOST_PROTOCOL,
} from '../server/knx-protocol.ts';

function makeMsg(svc: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([hdr(svc, 6 + body.length), body]);
}

describe('KnxIpConnection._onTcpData (TCP stream reassembly)', () => {
  it('processes one message delivered in a single chunk', () => {
    const conn = new (KnxIpConnection as any)();
    const seen: Buffer[] = [];
    conn._onMsg = (msg: Buffer) => seen.push(msg);

    const msg = makeMsg(SVC.CONNSTATE_RES, Buffer.from([0x01, 0x00]));
    conn._onTcpData(msg);

    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0]!], [...msg]);
  });

  it('reassembles one message split across multiple chunks', () => {
    const conn = new (KnxIpConnection as any)();
    const seen: Buffer[] = [];
    conn._onMsg = (msg: Buffer) => seen.push(msg);

    const msg = makeMsg(SVC.CONNSTATE_RES, Buffer.from([0x01, 0x00]));
    conn._onTcpData(msg.subarray(0, 3)); // mid-header
    assert.equal(seen.length, 0);
    conn._onTcpData(msg.subarray(3, 6)); // header now complete, body not yet
    assert.equal(seen.length, 0);
    conn._onTcpData(msg.subarray(6)); // rest of body
    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0]!], [...msg]);
  });

  it('splits two messages delivered back-to-back in one chunk', () => {
    const conn = new (KnxIpConnection as any)();
    const seen: Buffer[] = [];
    conn._onMsg = (msg: Buffer) => seen.push(msg);

    const msgA = makeMsg(SVC.CONNSTATE_RES, Buffer.from([0x01, 0x00]));
    const msgB = makeMsg(SVC.DISCONNECT_RES, Buffer.from([0x02, 0x00]));
    conn._onTcpData(Buffer.concat([msgA, msgB]));

    assert.equal(seen.length, 2);
    assert.deepEqual([...seen[0]!], [...msgA]);
    assert.deepEqual([...seen[1]!], [...msgB]);
  });

  it('handles a third message arriving in a later chunk after two were already processed', () => {
    const conn = new (KnxIpConnection as any)();
    const seen: Buffer[] = [];
    conn._onMsg = (msg: Buffer) => seen.push(msg);

    const msgA = makeMsg(SVC.CONNSTATE_RES);
    const msgB = makeMsg(SVC.DISCONNECT_RES, Buffer.from([0x01, 0x00]));
    const msgC = makeMsg(SVC.CONNSTATE_RES);
    conn._onTcpData(Buffer.concat([msgA, msgB.subarray(0, 4)]));
    assert.equal(seen.length, 1);
    conn._onTcpData(Buffer.concat([msgB.subarray(4), msgC]));

    assert.equal(seen.length, 3);
    assert.deepEqual([...seen[1]!], [...msgB]);
    assert.deepEqual([...seen[2]!], [...msgC]);
  });

  it('does nothing with fewer than 6 buffered bytes', () => {
    const conn = new (KnxIpConnection as any)();
    let called = false;
    conn._onMsg = () => {
      called = true;
    };
    conn._onTcpData(Buffer.from([0x06, 0x10, 0x02]));
    assert.equal(called, false);
  });
});

// ── KnxIpConnection._sendCEMIOnce: TCP skips the TUNNELING_ACK wait ──────────
// Real, confirmed 2026-08-30: over TCP, KNXnet/IP servers don't send a
// TUNNELING_ACK at all - matches Calimero's real client
// ("with tcp, service acks are not required and just ignored"). Found via
// real-hardware testing: waiting for one over TCP (as this codebase
// previously did unconditionally) caused every call after the first in a
// session to hang until timeout.

describe('KnxIpConnection._sendCEMIOnce: TCP ACK skip', () => {
  it('resolves immediately over TCP without waiting for a TUNNELING_ACK', async () => {
    const conn = new (KnxIpConnection as any)();
    conn.transport = 'tcp';
    conn.tcpSocket = { write: () => {} };
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60]);
    await conn._sendCEMIOnce(cemi, 1000); // would hang/reject on timeout if this waited for an ack
    assert.equal(conn._pendingAck, null);
  });

  it('still waits for a real TUNNELING_ACK over UDP (unchanged)', async () => {
    const conn = new (KnxIpConnection as any)();
    conn.transport = 'udp';
    conn.udpSocket = { send: () => {} };
    conn.host = '10.0.0.1';
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60]);
    const p = conn._sendCEMIOnce(cemi, 1000);
    assert.ok(conn._pendingAck !== null);
    conn._pendingAck.resolve();
    await p;
  });
});

// ── KnxIpConnection._onConnectRes: CONNSTATE heartbeat over UDP and TCP ──────
// Sending the CONNECTIONSTATE_REQUEST heartbeat over TCP was previously
// believed unnecessary and was disabled for TCP connections, on the
// assumption that TCP's own connection liveness (close/error events)
// already covers what the heartbeat provides over UDP - matching
// Calimero's client, which never starts its heartbeat monitor for a
// stream/TCP connection.
//
// See the matching comment in knx-protocol.ts's `_onConnectRes` for the
// full evidence: a real KNXnet/IP gateway was observed closing a genuinely
// idle TCP tunnel after approximately 120 seconds with no heartbeat
// running, and a byte-level parse of a real ETS capture confirmed ETS
// itself sends a genuine CONNECTIONSTATE_REQUEST over its own TCP tunnel
// approximately every 30.2 seconds. An earlier attempt to send this over
// TCP had closed the tunnel - traced to a call-site bug, not a protocol
// restriction: the call omitted the `hostProtocol` argument to
// `pktConnState()`, silently defaulting to `HOST_PROTOCOL.UDP` and
// producing a self-contradictory HPAI (UDP protocol byte, TCP's
// placeholder 0.0.0.0:0 address) that the gateway rejected by closing the
// tunnel. Fixed by passing `HOST_PROTOCOL.TCP` explicitly for TCP
// connections - confirmed against real hardware: a TCP tunnel held
// genuinely idle for over 540 seconds with zero disconnects, and
// separately across repeated real Full Downloads with zero disconnects.

function makeConnectRes(channelId: number): Buffer {
  // header(6) + channelId(1) + reserved(1) + status(1) = 8 bytes minimum
  return Buffer.concat([
    hdr(SVC.CONNECT_RES, 8),
    Buffer.from([channelId, 0x00, 0x00]),
  ]);
}

describe('KnxIpConnection._onConnectRes: heartbeat', () => {
  it('starts the CONNSTATE heartbeat for UDP', () => {
    const conn = new (KnxIpConnection as any)();
    conn.transport = 'udp';
    conn._onConnectRes(makeConnectRes(0x01));
    assert.ok(conn._hbTimer !== null);
    clearInterval(conn._hbTimer);
  });

  it('also starts the CONNSTATE heartbeat for TCP, sending the TCP HPAI protocol byte every 30s', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      const conn = new (KnxIpConnection as any)();
      conn.transport = 'tcp';
      conn.localIp = '0.0.0.0';
      conn.localPort = 0;
      const sent: Buffer[] = [];
      conn._sendRaw = (buf: Buffer) => sent.push(buf);
      conn._onConnectRes(makeConnectRes(0x01));
      assert.ok(conn._hbTimer !== null);
      assert.equal(
        sent.length,
        0,
        'nothing sent yet - the interval has not fired',
      );

      // Actually advance the mocked interval rather than hand-constructing
      // what the callback "should" send - this is the same fake-HPAI-byte
      // bug (an omitted hostProtocol argument silently defaulting to UDP)
      // that killed a real router's TCP tunnel, so the test needs to
      // observe the real call site's output, not a parallel computation of
      // what it's expected to produce.
      t.mock.timers.tick(30000);
      assert.equal(sent.length, 1);
      // byte 1 of the HPAI (offset 9 in the full CONNECTIONSTATE_REQUEST
      // packet: 6-byte header + 1-byte channel ID + 1-byte reserved + 1-byte
      // HPAI length) must be the TCP protocol code, not the UDP default the
      // original bug sent.
      assert.equal(
        sent[0]![9],
        HOST_PROTOCOL.TCP,
        'HPAI protocol byte must be TCP (0x02), not the UDP default',
      );
      assert.deepEqual(
        [...sent[0]!],
        [
          ...pktConnState(
            conn.channelId,
            conn.localIp,
            conn.localPort,
            HOST_PROTOCOL.TCP,
          ),
        ],
      );

      clearInterval(conn._hbTimer);
    } finally {
      t.mock.timers.reset();
    }
  });
});

// ── KnxIpConnection.sendCEMIViaRouting ────────────────────────────────────────
// Overrides the base class's default-throw (knx-connection.test.ts) when a
// Routing channel came up during connect().

describe('KnxIpConnection.sendCEMIViaRouting', () => {
  it('delegates to the active Routing socket', async () => {
    const conn = new (KnxIpConnection as any)();
    const sent: Buffer[] = [];
    conn._routing = {
      active: true,
      send: (cemi: Buffer) => {
        sent.push(cemi);
        return Promise.resolve();
      },
    };
    const cemi = Buffer.from([0x29, 0x00, 0xa0]);
    await conn.sendCEMIViaRouting(cemi);
    assert.equal(sent.length, 1);
    assert.deepEqual([...sent[0]!], [...cemi]);
  });

  it('rejects when Routing never came up (e.g. no multicast route)', async () => {
    const conn = new (KnxIpConnection as any)();
    conn._routing = null;
    await assert.rejects(
      () => conn.sendCEMIViaRouting(Buffer.from([0x29])),
      /Routing.*not active/,
    );
  });

  it('rejects when the Routing socket exists but was stopped', async () => {
    const conn = new (KnxIpConnection as any)();
    conn._routing = { active: false, send: () => Promise.resolve() };
    await assert.rejects(() => conn.sendCEMIViaRouting(Buffer.from([0x29])));
  });
});
