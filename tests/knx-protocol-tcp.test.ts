/**
 * Tests for KnxIpConnection's TCP stream frame-reassembly (_onTcpData) -
 * KNXnet/IP-over-TCP messages arrive as an arbitrary byte stream, not
 * one-message-per-event the way UDP datagrams do (cf. Calimero's
 * StreamConnection.runReceiveLoop(), docs/knx-device-write-protocol.md §9).
 * Constructs a KnxIpConnection directly and feeds _onTcpData() raw bytes,
 * spying on _onMsg() to record what full messages it reassembled.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import { buildCEMI, apduGroupWrite } from '../server/knx-cemi.ts';
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
// Over TCP, KNXnet/IP servers don't send a TUNNELING_ACK at all - matches
// Calimero's client ("with tcp, service acks are not required and just
// ignored"). Waiting for one over TCP hangs every call after the first.

describe('KnxIpConnection._sendCEMIOnce: TCP ACK skip', () => {
  it('resolves immediately over TCP without waiting for a TUNNELING_ACK', async () => {
    const conn = new (KnxIpConnection as any)();
    conn.transport = 'tcp';
    conn.connected = true;
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

// ── KnxIpConnection._sendCEMIOnce: dead-socket TCP send must reject ─────────
// A mid-session TCP disconnect (e.g. ECONNRESET) leaves `tcpSocket` non-null
// - its 'close' handler only flips `this.connected`, never nulls the
// reference. `_sendRaw()`'s `write(buf)` is fire-and-forget: Node's
// net.Socket.write() on an already-destroyed socket does not throw
// synchronously, it schedules an async 'error' event later.
// `_sendCEMIOnce()` must check liveness itself, not resolve unconditionally.

describe('KnxIpConnection._sendCEMIOnce: dead TCP socket must reject, not silently resolve', () => {
  it('rejects once the TCP socket has been destroyed mid-session, against a real net.Socket', async () => {
    const server = net.createServer((sock) => sock.on('data', () => {}));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as net.AddressInfo).port;

    const conn = new (KnxIpConnection as unknown as new () => {
      tcpSocket: net.Socket | null;
      transport: 'udp' | 'tcp' | null;
      connected: boolean;
      channelId: number;
      seqOut: number;
      _sendCEMIOnce: (cemi: Buffer, timeoutMs: number) => Promise<void>;
    })();

    const clientSocket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      clientSocket.once('connect', () => resolve());
      clientSocket.once('error', reject);
    });
    conn.tcpSocket = clientSocket;
    conn.transport = 'tcp';
    conn.connected = true;
    conn.channelId = 1;

    const fakeCemi = Buffer.from([0x11, 0x00, 0x00, 0x00, 0x00, 0x00]);

    // Sanity check: a live, connected socket really does resolve.
    await conn._sendCEMIOnce(fakeCemi, 1000);

    // Destroy the socket as ECONNRESET would, without wiring up a 'close'
    // listener - isolates whether _sendCEMIOnce() itself detects a dead
    // socket independent of any listener flipping `connected`.
    clientSocket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () => conn._sendCEMIOnce(fakeCemi, 1000),
      /not connected|socket/i,
      '_sendCEMIOnce() must reject once the TCP socket is destroyed, not silently resolve as if the send succeeded',
    );

    server.close();
  });

  it('also rejects when `connected` is already false, even with a live (never-connected) tcpSocket reference', async () => {
    const conn = new (KnxIpConnection as unknown as new () => {
      tcpSocket: net.Socket | null;
      transport: 'udp' | 'tcp' | null;
      connected: boolean;
      channelId: number;
      seqOut: number;
      _sendCEMIOnce: (cemi: Buffer, timeoutMs: number) => Promise<void>;
    })();
    conn.tcpSocket = new net.Socket(); // real object, never connected/destroyed
    conn.transport = 'tcp';
    conn.connected = false; // the real post-ECONNRESET state ('close' already fired)
    conn.channelId = 1;

    await assert.rejects(
      () =>
        conn._sendCEMIOnce(
          Buffer.from([0x11, 0x00, 0x00, 0x00, 0x00, 0x00]),
          1000,
        ),
      /not connected/i,
    );
  });

  it('still resolves normally over TCP when genuinely connected (no regression to the ACK-skip behavior above)', async () => {
    const conn = new (KnxIpConnection as any)();
    conn.transport = 'tcp';
    conn.connected = true;
    conn.tcpSocket = { write: () => {}, destroyed: false };
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x60]);
    await conn._sendCEMIOnce(cemi, 1000);
    assert.equal(conn._pendingAck, null);
  });
});

// ── KnxIpConnection._onConnectRes: CONNSTATE heartbeat over UDP and TCP ──────
// The CONNECTIONSTATE_REQUEST heartbeat runs over TCP too, despite
// Calimero's client never starting one for a stream/TCP connection: an idle
// TCP tunnel with no heartbeat gets closed by the gateway after ~120s, and
// ETS itself sends a CONNECTIONSTATE_REQUEST over TCP every ~30.2s. The
// heartbeat's HPAI must carry `HOST_PROTOCOL.TCP` explicitly - omitting it
// silently defaults to UDP, producing a self-contradictory HPAI (UDP
// protocol byte, TCP's placeholder 0.0.0.0:0 address) that gets the tunnel
// closed by the gateway.

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
      // _onConnectRes also sends a TunnelFeature GET (BUS_STATUS) and SET
      // (INFO_SERVICE_ENABLE) immediately - both land in `sent` before the
      // heartbeat interval ever fires.
      assert.equal(
        sent.length,
        2,
        'only the TunnelFeature negotiation sent so far - the interval has not fired',
      );

      // Advance the mocked interval rather than hand-constructing the
      // expected frame, so the test observes the real call site's output
      // (an omitted hostProtocol argument silently defaults to UDP).
      t.mock.timers.tick(30000);
      assert.equal(sent.length, 3);
      const heartbeatFrame = sent[2]!;
      // byte 1 of the HPAI (offset 9 in the full CONNECTIONSTATE_REQUEST
      // packet: 6-byte header + 1-byte channel ID + 1-byte reserved + 1-byte
      // HPAI length) must be the TCP protocol code, not the UDP default the
      // original bug sent.
      assert.equal(
        heartbeatFrame[9],
        HOST_PROTOCOL.TCP,
        'HPAI protocol byte must be TCP (0x02), not the UDP default',
      );
      assert.deepEqual(
        [...heartbeatFrame],
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

// ── Incoming telegrams over TCP ─────────────────────────────────────────────

// The bus monitor went quiet a moment after a TCP connection came up.
// _onTunnelingReq drops a TUNNELLING_REQUEST whose sequence number matches
// the last one seen - correct over UDP, where a datagram really can arrive
// twice because the gateway resends when our ack goes missing, and wrong
// over TCP, where the stream delivers exactly once and a gateway is free to
// leave the sequence number alone. Every telegram after the first then
// looked like a duplicate.
describe('KnxIpConnection._onTunnelingReq: sequence de-duplication', () => {
  function tunnelReq(channelId: number, seq: number, cemi: Buffer): Buffer {
    const body = Buffer.concat([
      Buffer.from([0x04, channelId, seq, 0x00]),
      cemi,
    ]);
    return Buffer.concat([hdr(SVC.TUNNELING_REQ, 6 + body.length), body]);
  }

  function harness(transport: 'tcp' | 'udp') {
    const conn = new (KnxIpConnection as unknown as new () => {
      connected: boolean;
      transport: string;
      channelId: number;
      _sendRaw: (b: Buffer) => void;
      _onMsg: (b: Buffer) => void;
      on: (e: string, cb: (t: { raw_value: string }) => void) => void;
    })();
    conn.connected = true;
    conn.transport = transport;
    conn.channelId = 1;
    const acks: Buffer[] = [];
    conn._sendRaw = (b: Buffer) => {
      acks.push(b);
    };
    const values: string[] = [];
    conn.on('telegram', (t) => values.push(t.raw_value));
    return { conn, values, acks };
  }

  const write = (v: number) =>
    buildCEMI('1.1.1', '1/0/1', apduGroupWrite(Buffer.from([v])), true);

  it('delivers every telegram over TCP even when the sequence never moves', () => {
    const { conn, values } = harness('tcp');
    for (const v of [1, 2, 3]) conn._onMsg(tunnelReq(1, 0, write(v)));
    assert.equal(values.length, 3, 'all three should reach the monitor');
  });

  it('still drops a repeated sequence number over UDP', () => {
    // A genuine retransmit: the gateway resent because it never saw our
    // ack. Delivering it twice would put a phantom event in the monitor.
    const { conn, values } = harness('udp');
    for (const v of [1, 2, 3]) conn._onMsg(tunnelReq(1, 0, write(v)));
    assert.equal(values.length, 1);
  });

  it('delivers each new sequence number over UDP', () => {
    const { conn, values } = harness('udp');
    [1, 2, 3].forEach((v, i) => conn._onMsg(tunnelReq(1, i, write(v))));
    assert.equal(values.length, 3);
  });

  it('acknowledges over UDP, but not over TCP', () => {
    // ETS never sends a TUNNELING_ACK over TCP - TCP's own delivery
    // guarantee already covers this. Matches the send side's TCP-never-acks
    // behavior (_sendCEMIOnce).
    {
      const { conn, acks } = harness('udp');
      conn._onMsg(tunnelReq(1, 0, write(1)));
      assert.equal(acks.length, 1, 'udp');
      assert.equal(acks[0]!.readUInt16BE(2), SVC.TUNNELING_ACK, 'udp');
    }
    {
      const { conn, acks } = harness('tcp');
      conn._onMsg(tunnelReq(1, 0, write(1)));
      assert.equal(acks.length, 0, 'tcp');
    }
  });
});
