/**
 * KNXnet/IP transport — UDP tunneling to a KNXnet/IP gateway.
 * Extends KnxConnection (shared protocol logic) with UDP-specific transport.
 */

import dgram from 'dgram';
import os from 'os';
import { KnxConnection, parseCEMI } from './knx-connection.ts';

// ── KNXnet/IP service types ────────────────────────────────────────────────────
const SVC = {
  CONNECT_REQ: 0x0205,
  CONNECT_RES: 0x0206,
  CONNSTATE_REQ: 0x0207,
  CONNSTATE_RES: 0x0208,
  DISCONNECT_REQ: 0x0209,
  DISCONNECT_RES: 0x020a,
  TUNNELING_REQ: 0x0420,
  TUNNELING_ACK: 0x0421,
} as const;

// ── KNXnet/IP packet builders ──────────────────────────────────────────────────

function hdr(svc: number, totalLen: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 0x06;
  b[1] = 0x10;
  b.writeUInt16BE(svc, 2);
  b.writeUInt16BE(totalLen, 4);
  return b;
}

function hpai(ip: string, port: number): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 0x08;
  b[1] = 0x01;
  ip.split('.').forEach((o, i) => {
    b[2 + i] = parseInt(o, 10);
  });
  b.writeUInt16BE(port, 6);
  return b;
}

function pktConnect(localIp: string, localPort: number): Buffer {
  const h = hpai(localIp, localPort);
  const cri = Buffer.from([0x04, 0x04, 0x02, 0x00]);
  return Buffer.concat([hdr(SVC.CONNECT_REQ, 26), h, h, cri]);
}

function pktConnState(
  channelId: number,
  localIp: string,
  localPort: number,
): Buffer {
  return Buffer.concat([
    hdr(SVC.CONNSTATE_REQ, 16),
    Buffer.from([channelId, 0x00]),
    hpai(localIp, localPort),
  ]);
}

function pktDisconnect(
  channelId: number,
  localIp: string,
  localPort: number,
): Buffer {
  return Buffer.concat([
    hdr(SVC.DISCONNECT_REQ, 16),
    Buffer.from([channelId, 0x00]),
    hpai(localIp, localPort),
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

function decodePhysicalRaw(buf: Buffer, off: number): string {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  return `${b0 >> 4}.${b0 & 0xf}.${b1}`;
}

// ── Local IP detection ─────────────────────────────────────────────────────────

function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

// ── Pending ACK state ──────────────────────────────────────────────────────────

interface PendingAck {
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── KnxIpConnection ────────────────────────────────────────────────────────────

class KnxIpConnection extends (KnxConnection as new () => InstanceType<
  typeof KnxConnection
>) {
  socket: dgram.Socket | null;
  host: string | null;
  port: number;
  localIp: string;
  localPort: number;
  channelId: number;
  seqOut: number;
  seqIn: number;
  _hbTimer: ReturnType<typeof setInterval> | null;
  _pendingAck: PendingAck | null;

  constructor() {
    super();
    this.socket = null;
    this.host = null;
    this.port = 3671;
    this.localIp = '0.0.0.0';
    this.localPort = 0;
    this.channelId = 0;
    this.seqOut = 0;
    this.seqIn = -1;
    this._hbTimer = null;
    this._pendingAck = null;
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  connect(
    host: string,
    port: number = 3671,
    timeoutMs: number = 8000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.host = host;
      this.port = port;
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err: Error) => {
        if (!this.connected) reject(err);
        else {
          this.connected = false;
          this.emit('error', err);
        }
      });
      this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) =>
        this._onMsg(msg, rinfo),
      );

      this.socket.bind(0, () => {
        this.localPort = this.socket!.address().port;
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

        this._sendRaw(pktConnect(this.localIp, this.localPort));
      });
    });
  }

  _sendRaw(buf: Buffer): void {
    if (this.socket && this.host)
      this.socket.send(buf, 0, buf.length, this.port, this.host);
  }

  // ── Incoming message dispatcher ──────────────────────────────────────────────

  _onMsg(msg: Buffer, _rinfo: dgram.RemoteInfo): void {
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
    this._hbTimer = setInterval(() => {
      this._sendRaw(pktConnState(this.channelId, this.localIp, this.localPort));
    }, 60000);

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
    return new Promise((resolve, reject) => {
      const seq = this.seqOut;
      this.seqOut = (this.seqOut + 1) & 0xff;
      const pkt = pktTunnelingReq(this.channelId, seq, cemi);

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
    if (!this.socket) return;
    this._clearHeartbeat();
    if (this.connected) {
      try {
        this._sendRaw(
          pktDisconnect(this.channelId, this.localIp, this.localPort),
        );
      } catch (_) {}
    }
    this.connected = false;
    setTimeout(() => {
      try {
        this.socket?.close();
      } catch (_) {}
      this.socket = null;
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
  } {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      hasLib: true,
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
