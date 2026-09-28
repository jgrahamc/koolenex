/**
 * KNXnet/IP transport - Tunneling (UDP and TCP) to a KNXnet/IP gateway, plus
 * a secondary Routing (multicast) channel (knx-protocol-routing.ts). Extends
 * KnxConnection (shared protocol logic) with IP-specific transport. See
 * docs/knx-device-write-protocol.md §9.
 *
 * ETS uses TCP tunneling in addition to UDP. Wire-level facts (HPAI
 * protocol-code byte, the TCP placeholder HPAI, stream frame-reassembly)
 * cross-checked against Calimero (StreamConnection.java, HPAI.java).
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
  TUNNELING_FEATURE,
  pktTunnelFeature,
} from './knx-ip-common.ts';
import { KnxRoutingSocket } from './knx-protocol-routing.ts';
import { logger } from './log.ts';

// ── KNXnet/IP packet builders ──────────────────────────────────────────────────

/**
 * `hostProtocol` selects which HPAI shape to build: UDP embeds the local
 * IP/port; TCP uses the spec's placeholder HPAI (protocol code TCP, address
 * 0.0.0.0, port 0 - Calimero's `HPAI.Tcp`) since the TCP socket itself
 * defines the real endpoint.
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
  // Resolves when a disconnect() started here has finished releasing the
  // socket. See whenClosed() below.
  _teardown: Promise<void> | null;
  // Individual address the gateway assigned this tunnel channel
  // (CONNECT_RESPONSE's CRD block) - parsed in _onConnectRes below, but
  // never adopted as `localAddr` itself (see groupCommAddr's doc comment on
  // the base class, knx-connection.ts). `null` until a CONNECT_RESPONSE with
  // a CRD block has been seen.
  assignedAddr: string | null;
  // Sequence counter for TunnelFeatureGet/Set requests - separate from
  // seqOut/seqIn (ordinary Tunneling). See pktTunnelFeature's doc comment
  // (knx-ip-common.ts) for the wire shape.
  _featureSeq: number;

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
    this._teardown = null;
    this.assignedAddr = null;
    this._featureSeq = 0;
  }

  // Overrides the base class default (`localAddr`) for group communication
  // frames specifically - prefers the router-assigned tunnel address once
  // known. Management/point-to-point frames source from `localAddr`
  // directly (see `_onConnectRes` above).
  get groupCommAddr(): string {
    return this.assignedAddr ?? this.localAddr;
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
      // 'auto': try TCP first, falling back to UDP only if the TCP socket
      // itself can't be established. Does NOT fall back to UDP if the TCP
      // socket connects but the KNXnet/IP CONNECT_REQ/RES handshake over it
      // fails/times out - a device accepting a TCP connection on 3671 is
      // expected to support Tunnelling v2 properly.
      const tcpProbeMs = Math.min(2000, timeoutMs);
      try {
        await this._connectTcp(host, port, tcpProbeMs);
      } catch (_) {
        await this._connectUdp(host, port, timeoutMs);
      }
    }

    // Routing is independent of which Tunneling transport was used, and its
    // failure (e.g. no multicast route on this network) must never fail the
    // overall connect() - System Broadcast services simply won't work.
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
      logger.warn(
        'knx',
        'KNXnet/IP Routing unavailable, continuing without it',
        {
          error: (err as Error).message,
        },
      );
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

        this._sendRaw(
          pktConnect(this.localIp, this.localPort, HOST_PROTOCOL.UDP),
        );
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
        // Node's plain net.Socket doesn't enable OS-level TCP keepalive by
        // default; without it a dropped network path gives no signal on
        // either side. Does not substitute for the application-level
        // CONNECTIONSTATE_REQUEST heartbeat below.
        socket.setKeepAlive(true, 30000);
        // Nagle can coalesce a T_Ack and the next request (sent a
        // millisecond apart) into one TCP segment; a router that delivers
        // only the second drops the T_Ack, and the device then holds its
        // response for a full 3s retransmission timer. Every frame here is
        // small and latency-sensitive - exactly what Nagle is wrong for.
        socket.setNoDelay(true);
        // TCP's CONNECT_REQ uses the placeholder HPAI (0.0.0.0:0, protocol
        // TCP) - the socket itself is the real endpoint. localIp/localPort
        // stay at their defaults; CONNSTATE/DISCONNECT over TCP reuse the
        // same placeholder (see their call sites below).
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

        this._sendRaw(
          pktConnect(this.localIp, this.localPort, HOST_PROTOCOL.TCP),
        );
      });
    });
  }

  /**
   * KNXnet/IP-over-TCP messages arrive as an arbitrary byte stream, not
   * one-message-per-event the way UDP datagrams do - reassemble using the
   * 6-byte header's declared total length, matching Calimero's
   * StreamConnection.runReceiveLoop(): buffer bytes, once >=6 buffered read
   * the header, once the full declared length is buffered process one
   * message and shift leftover bytes to the front for the next pass.
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
      case SVC.TUNNELING_FEATURE_RESPONSE:
        this._onTunnelingFeature(msg, false);
        break;
      case SVC.TUNNELING_FEATURE_INFO:
        // Server-initiated, unprompted - sent only when InfoServiceEnable
        // is on and a negotiated feature's value changes. The actual signal
        // this mechanism exists to catch.
        this._onTunnelingFeature(msg, true);
        break;
    }
  }

  /**
   * Decodes a TunnelFeatureResponse or (unprompted) TunnelFeatureInfo body
   * and emits it as `_featureInfo` (matches the KNXnet/IP service name, not
   * `logger.info`). Same
   * `[StructLength][ChannelId][SeqCounter][FeatureId][ReturnCode/Reserved]
   * [Value...]` layout as the request. `unprompted=true` for
   * TUNNELING_FEATURE_INFO, logged at 'warn' so an unprompted bus-status
   * change is never missed.
   */
  _onTunnelingFeature(msg: Buffer, unprompted: boolean): void {
    // Wire layout (SeqCounter is 2 bytes, not 1 - see pktTunnelFeature's
    // doc comment, knx-ip-common.ts):
    // [hdr:6][StructLength:1][ChannelId:1][SeqCounter:2][FeatureId:1]
    // [ReturnCode/Reserved:1][Value...]
    if (msg.length < 12) return;
    const featureId = msg[10]!;
    const value = msg.subarray(12);
    const featureName =
      featureId === TUNNELING_FEATURE.BUS_STATUS
        ? 'BusStatus'
        : featureId === TUNNELING_FEATURE.INFO_SERVICE_ENABLE
          ? 'InfoServiceEnable'
          : `0x${featureId.toString(16)}`;
    const payload = {
      featureId,
      featureName,
      valueHex: value.toString('hex'),
      unprompted,
    };
    logger[unprompted ? 'warn' : 'info'](
      'knx',
      unprompted
        ? `Unprompted TunnelingFeatureInfo: ${featureName}=0x${value.toString('hex')} - a negotiated feature's value just changed`
        : `TunnelFeature ${featureName} = 0x${value.toString('hex')}`,
      payload,
    );
    this.emit('_featureInfo', payload);
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
    // Must NOT be adopted as `localAddr` itself, the address every outgoing
    // cEMI frame's source field uses - see groupCommAddr's doc comment
    // (knx-connection.ts) for why that's an avoidable address-collision
    // risk for device-management traffic. Still parsed and kept: useful
    // diagnostic data, and the source `groupCommAddr` uses for ordinary
    // group communication - unlike management traffic.
    if (msg.length >= 20) this.assignedAddr = decodePhysicalRaw(msg, 18);

    this.connected = true;

    // ETS sends both of these immediately after every Tunnel connect.
    // `InfoServiceEnable` is a subscribe toggle (Qt KNX's documented
    // `InterfaceFeatureInfoServiceEnable`) - once set, the gateway
    // proactively pushes an unprompted TunnelingFeatureInfo whenever a
    // negotiated feature's value changes, e.g. BusStatus flipping to a
    // fault state. Best-effort: never blocks/fails the connection if the
    // gateway doesn't support this - `_sendRaw` is fire-and-forget here,
    // same tolerance the heartbeat below has.
    this._sendRaw(
      pktTunnelFeature(
        SVC.TUNNELING_FEATURE_GET,
        this.channelId,
        this._featureSeq++,
        TUNNELING_FEATURE.BUS_STATUS,
      ),
    );
    this._sendRaw(
      pktTunnelFeature(
        SVC.TUNNELING_FEATURE_SET,
        this.channelId,
        this._featureSeq++,
        TUNNELING_FEATURE.INFO_SERVICE_ENABLE,
        0x01,
      ),
    );
    // CONNECTIONSTATE_REQUEST heartbeat over TCP.
    //
    // Required even over TCP: OS-level TCP keepalive probes are
    // transport-level only and don't count as application traffic against a
    // KNXnet/IP gateway's own idle timeout on a tunneling connection - only
    // this application-level heartbeat does. Without it, a gateway closes a
    // TCP tunnel after ~120s, including mid-transfer during an active Full
    // Download; reconnect-on-demand doesn't help a write already in
    // progress past that timeout. ETS itself sends a CONNECTIONSTATE_REQUEST
    // over its persistent TCP tunnel roughly every 30.2s throughout a
    // session, including during active writes. HPAI on this request must be
    // the TCP placeholder (`08 02 00000000 0000` - protocol byte 0x02),
    // hence explicitly passing `HOST_PROTOCOL.TCP` here rather than letting
    // it default to UDP (which produces a self-contradictory HPAI the
    // gateway rejects by closing the tunnel with a clean FIN).
    this._hbTimer = setInterval(() => {
      logger.debug(
        'knx',
        'Sending CONNECTIONSTATE_REQUEST heartbeat to keep the tunnel alive',
        {
          transport: this.transport,
          channelId: this.channelId,
        },
      );
      this._sendRaw(
        this.transport === 'tcp'
          ? pktConnState(
              this.channelId,
              this.localIp,
              this.localPort,
              HOST_PROTOCOL.TCP,
            )
          : pktConnState(this.channelId, this.localIp, this.localPort),
      );
    }, 30000);

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

    // ETS never sends a TUNNELING_ACK over TCP - TCP's own ACK already
    // covers delivery, and a KNXnet/IP-level ack on top is unnecessary
    // traffic. Mirrors the same transport check on the wait side (see
    // _sendCEMIOnce: waiting for an ack that never arrives over TCP hangs
    // every send after the first).
    if (this.transport !== 'tcp') {
      this._sendRaw(pktTunnelingAck(channelId, seq));
    }

    // Dropping a repeated sequence number is a UDP-only concern: a datagram
    // can genuinely arrive twice (the gateway resends when our ack goes
    // missing). Over TCP there are no duplicates to suppress - the stream
    // delivers exactly once, in order - and applying this check there is
    // harmful: a gateway is free to leave the sequence number alone when
    // it's not sequencing anything, so every telegram after the first would
    // match seqIn and be dropped, silencing the bus monitor.
    if (this.transport !== 'tcp' && seq === this.seqIn) return;
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
   * doc comment. No ACK, no sequencing - Routing is connectionless. Throws
   * if Routing didn't come up during connect() (e.g. no multicast route).
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

    // Over TCP, KNXnet/IP servers don't send a TUNNELING_ACK at all - TCP's
    // own delivery guarantee makes it redundant (Calimero's
    // ClientConnection.java documents TCP service acks as not required and
    // ignored). Waiting for one over TCP, as this function does for UDP
    // where the ack is required, hangs every TCP-tunneled call after the
    // first.
    if (this.transport === 'tcp') {
      // A mid-session TCP disconnect (e.g. ECONNRESET) leaves `tcpSocket`
      // non-null - its 'close' handler only flips `this.connected`, never
      // nulls the reference. `_sendRaw()`'s `write(buf)` is fire-and-forget:
      // write() on an already-destroyed socket doesn't throw synchronously,
      // it schedules an async 'error' event later. Without this check every
      // send after such a disconnect would silently "succeed" - checked
      // here rather than in the shared `_sendRaw()` helper, whose other
      // call sites (heartbeat timer, TUNNELING_FEATURE negotiation) invoke
      // it synchronously with no try/catch.
      if (!this.connected || !this.tcpSocket || this.tcpSocket.destroyed) {
        return Promise.reject(
          new Error('Not connected (TCP socket unavailable) - cannot send'),
        );
      }
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

    // Already torn down (or never connected): whenClosed() still reports
    // the earlier teardown, if there was one.
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

    const udp = this.udpSocket;
    const tcp = this.tcpSocket;
    this.udpSocket = null;
    this.tcpSocket = null;

    this._teardown = new Promise<void>((resolve) => {
      if (tcp) {
        // end() flushes the DISCONNECT_REQUEST written just above and then
        // sends FIN, so TCP needs no timer to get the bytes out - only a
        // backstop for a gateway that never completes the close.
        const backstop = setTimeout(() => {
          try {
            tcp.destroy();
          } catch (_) {}
          resolve();
        }, 500);
        tcp.once('close', () => {
          clearTimeout(backstop);
          resolve();
        });
        try {
          tcp.end();
        } catch (_) {
          clearTimeout(backstop);
          try {
            tcp.destroy();
          } catch (_) {}
          resolve();
        }
        return;
      }
      // dgram queues sends, and closing the socket in the same tick as
      // send() can drop the datagram that was the whole point of the
      // disconnect - hence the delay UDP still needs.
      setTimeout(() => {
        try {
          udp?.close();
        } catch (_) {}
        resolve();
      }, 500);
    });
  }

  /**
   * Resolves once disconnect() has genuinely released the socket.
   *
   * Needed because Verify runs forceReconnect() first, which disconnects
   * the current connection and immediately opens a new one to the same
   * gateway. Without waiting, the old socket lives on for a further 500ms
   * on a timer, so briefly two TCP connections to the same router are open
   * at once - and the router reacts by dropping the new tunnel a moment
   * after it comes up. Same fault shape as the overlapping-connect race
   * documented in KnxBusManager.connect() (two connects too close together,
   * router closes the leaked/orphaned channel), just on the disconnect side.
   */
  whenClosed(): Promise<void> {
    return this._teardown ?? Promise.resolve();
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
