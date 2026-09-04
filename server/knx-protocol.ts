/**
 * KNXnet/IP transport — Tunneling (UDP and TCP) to a KNXnet/IP gateway,
 * plus a secondary Routing (multicast) channel (knx-protocol-routing.ts).
 * Extends KnxConnection (shared protocol logic) with IP-specific
 * transport. See docs/knx-device-write-protocol.md §9.
 *
 * TCP support: a real capture confirmed ETS uses TCP tunneling against
 * this project's testbed router, while this class had only ever spoken
 * UDP - see docs/follow-ups/2026-08-27-relmem-write-scope-investigation.md
 * and docs/knx-device-write-protocol.md §9. Wire-level facts (HPAI
 * protocol-code byte, the TCP placeholder HPAI, stream frame-reassembly)
 * cross-checked against Calimero's real implementation
 * (StreamConnection.java, HPAI.java).
 */

import dgram from 'dgram';
import net from 'net';
import { KnxConnection, parseCEMI } from './knx-connection.ts';
import {
  hdr,
  hpai,
  decodePhysicalRaw,
  getLocalIp,
  SVC,
  HOST_PROTOCOL,
} from './knx-ip-common.ts';
import { KnxRoutingSocket } from './knx-protocol-routing.ts';
import { logger } from './log.ts';

// ── KNXnet/IP packet builders ──────────────────────────────────────────────────

/**
 * `hostProtocol` selects which HPAI shape to build: UDP embeds the real
 * local IP/port (unchanged from before); TCP uses the spec's placeholder
 * HPAI (protocol code TCP, address 0.0.0.0, port 0 - Calimero's `HPAI.Tcp`)
 * since the TCP socket itself already defines the real endpoint.
 */
function pktConnect(
  localIp: string,
  localPort: number,
  hostProtocol: number = HOST_PROTOCOL.UDP,
): Buffer {
  const h =
    hostProtocol === HOST_PROTOCOL.TCP
      ? hpai('0.0.0.0', 0, HOST_PROTOCOL.TCP)
      : hpai(localIp, localPort, HOST_PROTOCOL.UDP);
  const cri = Buffer.from([0x04, 0x04, 0x02, 0x00]);
  return Buffer.concat([hdr(SVC.CONNECT_REQ, 26), h, h, cri]);
}

function pktConnState(
  channelId: number,
  localIp: string,
  localPort: number,
  hostProtocol: number = HOST_PROTOCOL.UDP,
): Buffer {
  const h =
    hostProtocol === HOST_PROTOCOL.TCP
      ? hpai('0.0.0.0', 0, HOST_PROTOCOL.TCP)
      : hpai(localIp, localPort, HOST_PROTOCOL.UDP);
  return Buffer.concat([
    hdr(SVC.CONNSTATE_REQ, 16),
    Buffer.from([channelId, 0x00]),
    h,
  ]);
}

function pktDisconnect(
  channelId: number,
  localIp: string,
  localPort: number,
  hostProtocol: number = HOST_PROTOCOL.UDP,
): Buffer {
  return Buffer.concat([
    hdr(SVC.DISCONNECT_REQ, 16),
    Buffer.from([channelId, 0x00]),
    hpai(localIp, localPort, hostProtocol),
  ]);
}

function pktDisconnectRes(channelId: number): Buffer {
  return Buffer.concat([
    hdr(SVC.DISCONNECT_RES, 8),
    Buffer.from([channelId, 0x00]),
  ]);
}

function pktTunnelingReq(channelId: number, seq: number, cemi: Buffer): Buffer {
  return Buffer.concat([
    hdr(SVC.TUNNELING_REQ, 10 + cemi.length),
    Buffer.from([0x04, channelId, seq & 0xff, 0x00]),
    cemi,
  ]);
}

function pktTunnelingAck(
  channelId: number,
  seq: number,
  status: number = 0x00,
): Buffer {
  return Buffer.concat([
    hdr(SVC.TUNNELING_ACK, 10),
    Buffer.from([0x04, channelId, seq & 0xff, status]),
  ]);
}

// ── Pending ACK state ──────────────────────────────────────────────────────────

interface PendingAck {
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type IpTransportProtocol = 'udp' | 'tcp' | 'auto';

// ── KnxIpConnection ────────────────────────────────────────────────────────────

class KnxIpConnection extends (KnxConnection as new () => InstanceType<
  typeof KnxConnection
>) {
  // Exactly one of these is set once connected, depending on which
  // transport `connect()` ended up using.
  udpSocket: dgram.Socket | null;
  tcpSocket: net.Socket | null;
  _tcpRecvBuf: Buffer;
  transport: 'udp' | 'tcp' | null;
  host: string | null;
  port: number;
  localIp: string;
  localPort: number;
  channelId: number;
  seqOut: number;
  seqIn: number;
  _hbTimer: ReturnType<typeof setInterval> | null;
  _pendingAck: PendingAck | null;
  _sending: boolean;
  _sendQueue: Array<() => void>;
  // Secondary Routing (multicast) channel - independent of Tunneling,
  // best-effort (its own failure never fails the main connect()). See
  // knx-protocol-routing.ts.
  _routing: KnxRoutingSocket | null;

  constructor() {
    super();
    this.udpSocket = null;
    this.tcpSocket = null;
    this._tcpRecvBuf = Buffer.alloc(0);
    this.transport = null;
    this.host = null;
    this.port = 3671;
    this.localIp = '0.0.0.0';
    this.localPort = 0;
    this.channelId = 0;
    this.seqOut = 0;
    this.seqIn = -1;
    this._hbTimer = null;
    this._pendingAck = null;
    this._sending = false;
    this._sendQueue = [];
    this._routing = null;
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  async connect(
    host: string,
    port: number = 3671,
    timeoutMs: number = 8000,
    protocol: IpTransportProtocol = 'auto',
  ): Promise<void> {
    this.host = host;
    this.port = port;

    if (protocol === 'udp') {
      await this._connectUdp(host, port, timeoutMs);
    } else if (protocol === 'tcp') {
      await this._connectTcp(host, port, timeoutMs);
    } else {
      // 'auto': try TCP first (a real, independently confirmed capture
      // shows real ETS uses TCP against this project's own testbed router
      // - see this file's doc comment), falling back to UDP if the TCP
      // socket itself can't even be established. Deliberately does NOT
      // fall back to UDP if the TCP *socket* connects but the KNXnet/IP
      // CONNECT_REQ/RES handshake over it fails/times out - a device that
      // accepts a TCP connection on 3671 at all is expected to support
      // Tunnelling v2 properly; that narrower case is a known, accepted
      // gap, not silently masked by an unconditional fallback.
      const tcpProbeMs = Math.min(2000, timeoutMs);
      try {
        await this._connectTcp(host, port, tcpProbeMs);
      } catch (_) {
        await this._connectUdp(host, port, timeoutMs);
      }
    }

    // Routing is independent of which Tunneling transport was used, and
    // its own failure (e.g. no multicast route on this network) must never
    // fail the overall connect() - System Broadcast services simply won't
    // work, surfaced only if/when they're actually called.
    try {
      const routing = new KnxRoutingSocket();
      await routing.start(
        (cemi) => {
          const frame = parseCEMI(cemi);
          if (frame) this._onCEMI(frame);
        },
        (msg) => logger.info('knx', msg),
      );
      this._routing = routing;
    } catch (err) {
      logger.warn('knx', 'KNXnet/IP Routing unavailable, continuing without it', {
        error: (err as Error).message,
      });
    }
  }

  _connectUdp(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udpSocket = socket;
      this.transport = 'udp';

      socket.on('error', (err: Error) => {
        if (!this.connected) reject(err);
        else {
          this.connected = false;
          this.emit('error', err);
        }
      });
      socket.on('message', (msg: Buffer) => this._onMsg(msg));

      socket.bind(0, () => {
        this.localPort = socket.address().port;
        this.localIp = getLocalIp();

        const timer = setTimeout(
          () => reject(new Error(`Connect timeout to ${host}:${port}`)),
          timeoutMs,
        );
        this.once('_connected', () => {
          clearTimeout(timer);
          resolve();
        });
        this.once('_connectFailed', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });

        this._sendRaw(pktConnect(this.localIp, this.localPort, HOST_PROTOCOL.UDP));
      });
    });
  }

  _connectTcp(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch (_) {}
        reject(err);
      };

      const connectTimer = setTimeout(
        () => fail(new Error(`TCP connect timeout to ${host}:${port}`)),
        timeoutMs,
      );

      socket.on('error', (err: Error) => {
        logger.warn('knx', 'TCP socket error', {
          message: err.message,
          code: (err as NodeJS.ErrnoException).code,
        });
        if (!this.connected) fail(err);
        else {
          this.connected = false;
          this.emit('error', err);
        }
      });

      socket.on('close', (hadError: boolean) => {
        logger.info('knx', 'TCP socket closed', { hadError });
        if (this.connected) {
          this.connected = false;
          this._clearHeartbeat();
          this.emit('disconnected');
        }
      });

      socket.on('end', () => {
        logger.info('knx', 'TCP socket received FIN from remote');
      });

      socket.on('data', (chunk: Buffer) => this._onTcpData(chunk));

      socket.connect(port, host, () => {
        clearTimeout(connectTimer);
        this.tcpSocket = socket;
        this.transport = 'tcp';
        // Node's plain net.Socket does not enable OS-level TCP keepalive by
        // default; enabling it guards against a network path silently
        // dropping the connection with no signal on either side. This does
        // not prevent a KNXnet/IP gateway from applying its own idle
        // timeout to a TCP tunneling connection and closing it (a clean
        // FIN) after a period with no application traffic - TCP keepalive
        // probes are transport-level and do not count as traffic against
        // that timer. The connection manager (KnxBusManager) handles this
        // by reconnecting on demand before the next bus operation rather
        // than by holding the connection open with a periodic heartbeat -
        // see _ensureConnected() in knx-bus.ts.
        socket.setKeepAlive(true, 30000);
        // TCP's CONNECT_REQ uses the placeholder HPAI (0.0.0.0:0, protocol
        // TCP) - the socket itself is the real endpoint. localIp/localPort
        // are kept at their defaults; CONNSTATE/DISCONNECT over TCP reuse
        // the same placeholder (see their call sites below).
        this.localIp = '0.0.0.0';
        this.localPort = 0;

        const handshakeTimer = setTimeout(
          () => fail(new Error(`Connect timeout to ${host}:${port}`)),
          timeoutMs,
        );
        this.once('_connected', () => {
          clearTimeout(handshakeTimer);
          settled = true;
          resolve();
        });
        this.once('_connectFailed', (err: Error) => {
          clearTimeout(handshakeTimer);
          fail(err);
        });

        this._sendRaw(pktConnect(this.localIp, this.localPort, HOST_PROTOCOL.TCP));
      });
    });
  }

  /**
   * Real KNXnet/IP-over-TCP messages arrive as an arbitrary byte stream,
   * not one-message-per-event the way UDP datagrams do - reassemble using
   * the 6-byte header's own declared total length, exactly matching
   * Calimero's real StreamConnection.runReceiveLoop() logic (verified
   * against its source, not guessed): buffer bytes, once >=6 are buffered
   * read the header, once the full declared length is buffered process one
   * message and shift any leftover bytes to the front for the next pass.
   */
  _onTcpData(chunk: Buffer): void {
    this._tcpRecvBuf = Buffer.concat([this._tcpRecvBuf, chunk]);
    for (;;) {
      if (this._tcpRecvBuf.length < 6) return;
      const totalLen = this._tcpRecvBuf.readUInt16BE(4);
      if (totalLen < 6 || this._tcpRecvBuf.length < totalLen) return;
      const msg = this._tcpRecvBuf.subarray(0, totalLen);
      this._tcpRecvBuf = this._tcpRecvBuf.subarray(totalLen);
      this._onMsg(Buffer.from(msg));
    }
  }

  _sendRaw(buf: Buffer): void {
    if (this.transport === 'tcp') {
      this.tcpSocket?.write(buf);
    } else if (this.udpSocket && this.host) {
      this.udpSocket.send(buf, 0, buf.length, this.port, this.host);
    }
  }

  // ── Incoming message dispatcher (shared by UDP and TCP) ───────────────────────

  _onMsg(msg: Buffer): void {
    if (msg.length < 6) return;
    const svc = msg.readUInt16BE(2);
    switch (svc) {
      case SVC.CONNECT_RES:
        this._onConnectRes(msg);
        break;
      case SVC.CONNSTATE_RES:
        /* heartbeat ack */ break;
      case SVC.DISCONNECT_REQ:
        this._onDisconnectReq(msg);
        break;
      case SVC.DISCONNECT_RES:
        this._onDisconnectRes();
        break;
      case SVC.TUNNELING_REQ:
        this._onTunnelingReq(msg);
        break;
      case SVC.TUNNELING_ACK:
        this._onTunnelingAck(msg);
        break;
    }
  }

  _onConnectRes(msg: Buffer): void {
    if (msg.length < 8) return;
    const status = msg[7]!;
    if (status !== 0x00) {
      this.emit(
        '_connectFailed',
        new Error(
          `KNX connect error 0x${status.toString(16).padStart(2, '0')}`,
        ),
      );
      return;
    }
    this.channelId = msg[6]!;
    if (msg.length >= 20) this.localAddr = decodePhysicalRaw(msg, 18);

    this.connected = true;
    // The CONNECTIONSTATE_REQUEST heartbeat is UDP-only - confirmed
    // against Calimero's own client (ClientConnection.java: the heartbeat
    // monitor is never started for a stream/TCP connection). TCP's own
    // connection liveness ('close'/'error' on the socket, see
    // _connectTcp() above) covers what the heartbeat exists for over UDP.
    // A KNXnet/IP gateway may still close an idle TCP tunneling connection
    // on its own after a period with no application traffic; rather than
    // holding the connection open indefinitely against a gateway-specific
    // idle timeout, the caller (KnxBusManager) reconnects on demand before
    // the next bus operation - see _ensureConnected() in knx-bus.ts.
    if (this.transport !== 'tcp') {
      this._hbTimer = setInterval(() => {
        this._sendRaw(pktConnState(this.channelId, this.localIp, this.localPort));
      }, 60000);
    }

    this.emit('connected');
    this.emit('_connected');
  }

  _onDisconnectReq(msg: Buffer): void {
    this.connected = false;
    this._clearHeartbeat();
    if (msg.length >= 7) this._sendRaw(pktDisconnectRes(msg[6]!));
    this.emit('disconnected');
  }

  _onDisconnectRes(): void {
    this.connected = false;
    this._clearHeartbeat();
    this.emit('disconnected');
  }

  _onTunnelingReq(msg: Buffer): void {
    if (msg.length < 10) return;
    const channelId = msg[7]!;
    const seq = msg[8]!;

    this._sendRaw(pktTunnelingAck(channelId, seq));

    if (seq === this.seqIn) return;
    this.seqIn = seq;

    const cemi = parseCEMI(msg, 10);
    if (!cemi) return;
    this._onCEMI(cemi);
  }

  _onTunnelingAck(msg: Buffer): void {
    if (msg.length < 10) return;
    const seq = msg[8]!;
    const status = msg[9]!;
    if (this._pendingAck && this._pendingAck.seq === seq) {
      clearTimeout(this._pendingAck.timer);
      const { resolve, reject } = this._pendingAck;
      this._pendingAck = null;
      if (status === 0x00) resolve();
      else reject(new Error(`Tunneling ACK error 0x${status.toString(16)}`));
    }
  }

  // ── Send CEMI via KNXnet/IP tunneling with ACK wait ───────────────────────────

  sendCEMI(cemi: Buffer, timeoutMs: number = 1000): Promise<void> {
    // KNXnet/IP tunnelling permits only one un-acked TUNNELLING_REQUEST in
    // flight, so sends are serialized: the first one (queue idle) runs
    // _sendCEMIOnce synchronously — callers/tests inspect _pendingAck/seqOut
    // right after calling sendCEMI, without awaiting a microtask. Later sends
    // queue up and run once the prior one settles (resolve OR reject; a
    // failed send must not deadlock the queue).
    if (!this._sending) {
      this._sending = true;
      return this._startSend(cemi, timeoutMs);
    }
    return new Promise<void>((resolve, reject) => {
      this._sendQueue.push(() => {
        this._startSend(cemi, timeoutMs).then(resolve, reject);
      });
    });
  }

  /**
   * Send a cEMI frame via KNXnet/IP Routing (multicast) instead of the
   * Tunneling connection above - see KnxConnection.sendCEMIViaRouting()'s
   * doc comment for why this exists. No ACK, no sequencing - Routing is
   * connectionless. Throws if Routing didn't come up during connect()
   * (e.g. no multicast route on this network - logged there, not fatal to
   * the overall connection).
   */
  sendCEMIViaRouting(cemi: Buffer): Promise<void> {
    if (!this._routing?.active) {
      return Promise.reject(
        new Error('KNXnet/IP Routing is not active on this connection'),
      );
    }
    return this._routing.send(cemi);
  }

  _startSend(cemi: Buffer, timeoutMs: number): Promise<void> {
    const result = this._sendCEMIOnce(cemi, timeoutMs);

    let drained = false;
    const drain = (): void => {
      if (drained) return;
      drained = true;
      const next = this._sendQueue.shift();
      if (next) next();
      else this._sending = false;
    };

    // Synchronous drain hook: _onTunnelingAck (and unit tests) resolve/reject
    // via _pendingAck directly, so wrap those callbacks to advance the queue
    // in the same tick rather than waiting for a promise microtask.
    if (this._pendingAck) {
      const pending = this._pendingAck;
      const origResolve = pending.resolve;
      const origReject = pending.reject;
      pending.resolve = () => {
        drain();
        origResolve();
      };
      pending.reject = (err: Error) => {
        drain();
        origReject(err);
      };
    }
    // Safety net for settlement paths that bypass _pendingAck (the internal
    // ACK timeout below nulls _pendingAck before rejecting). No-op if drain()
    // already ran synchronously above.
    result.then(drain, drain);

    return result;
  }

  _sendCEMIOnce(cemi: Buffer, timeoutMs: number): Promise<void> {
    const seq = this.seqOut;
    this.seqOut = (this.seqOut + 1) & 0xff;
    const pkt = pktTunnelingReq(this.channelId, seq, cemi);

    // Real, confirmed 2026-08-30: over TCP, KNXnet/IP servers don't send a
    // TUNNELING_ACK at all - TCP's own delivery guarantee makes the ack
    // redundant, and real ETS traffic against this project's own testbed
    // router never carries one either. Confirmed against Calimero's real
    // client (ClientConnection.java): "with tcp, service acks are not
    // required and just ignored". Waiting for one over TCP (as this
    // function still does for UDP, where the ack is real and required)
    // caused every TCP-tunneled call after the first to hang until
    // timeout - found via real-hardware testing, not by inspection.
    if (this.transport === 'tcp') {
      this._sendRaw(pkt);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAck = null;
        reject(new Error('Tunneling ACK timeout'));
      }, timeoutMs);

      this._pendingAck = { seq, resolve, reject, timer };
      this._sendRaw(pkt);
    });
  }

  // ── Disconnect ────────────────────────────────────────────────────────────────

  disconnect(): void {
    this._routing?.stop();
    this._routing = null;

    if (!this.udpSocket && !this.tcpSocket) return;
    this._clearHeartbeat();
    if (this.connected) {
      try {
        this._sendRaw(
          this.transport === 'tcp'
            ? pktDisconnect(this.channelId, '0.0.0.0', 0, HOST_PROTOCOL.TCP)
            : pktDisconnect(this.channelId, this.localIp, this.localPort),
        );
      } catch (_) {}
    }
    this.connected = false;
    setTimeout(() => {
      try {
        this.udpSocket?.close();
      } catch (_) {}
      try {
        this.tcpSocket?.destroy();
      } catch (_) {}
      this.udpSocket = null;
      this.tcpSocket = null;
    }, 500);
  }

  _clearHeartbeat(): void {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  status(): {
    connected: boolean;
    host: string | null;
    port: number;
    hasLib: boolean;
    transport: 'udp' | 'tcp' | null;
    routingActive: boolean;
  } {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      hasLib: true,
      transport: this.transport,
      routingActive: this._routing?.active ?? false,
    };
  }
}

export { KnxIpConnection as KnxConnection };

// Export pure helpers for testing
export { hdr as _hdr };
export { hpai as _hpai };
export { pktConnect as _pktConnect };
export { pktConnState as _pktConnState };
export { pktDisconnect as _pktDisconnect };
export { pktDisconnectRes as _pktDisconnectRes };
export { pktTunnelingReq as _pktTunnelingReq };
export { SVC as _SVC };
export { HOST_PROTOCOL as _HOST_PROTOCOL };
