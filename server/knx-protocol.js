'use strict';
/**
 * KNXnet/IP transport — UDP tunneling to a KNXnet/IP gateway.
 * Extends KnxConnection (shared protocol logic) with UDP-specific transport.
 */

const dgram = require('dgram');
const os    = require('os');
const { KnxConnection, parseCEMI } = require('./knx-connection');

// ── KNXnet/IP service types ────────────────────────────────────────────────────
const SVC = {
  CONNECT_REQ:         0x0205,
  CONNECT_RES:         0x0206,
  CONNSTATE_REQ:       0x0207,
  CONNSTATE_RES:       0x0208,
  DISCONNECT_REQ:      0x0209,
  DISCONNECT_RES:      0x020A,
  TUNNELING_REQ:       0x0420,
  TUNNELING_ACK:       0x0421,
};

// ── KNXnet/IP packet builders ──────────────────────────────────────────────────

function hdr(svc, totalLen) {
  const b = Buffer.alloc(6);
  b[0] = 0x06; b[1] = 0x10;
  b.writeUInt16BE(svc, 2);
  b.writeUInt16BE(totalLen, 4);
  return b;
}

function hpai(ip, port) {
  const b = Buffer.alloc(8);
  b[0] = 0x08; b[1] = 0x01;
  ip.split('.').forEach((o, i) => { b[2 + i] = parseInt(o); });
  b.writeUInt16BE(port, 6);
  return b;
}

function pktConnect(localIp, localPort) {
  const h = hpai(localIp, localPort);
  const cri = Buffer.from([0x04, 0x04, 0x02, 0x00]);
  return Buffer.concat([hdr(SVC.CONNECT_REQ, 26), h, h, cri]);
}

function pktConnState(channelId, localIp, localPort) {
  return Buffer.concat([
    hdr(SVC.CONNSTATE_REQ, 16),
    Buffer.from([channelId, 0x00]),
    hpai(localIp, localPort),
  ]);
}

function pktDisconnect(channelId, localIp, localPort) {
  return Buffer.concat([
    hdr(SVC.DISCONNECT_REQ, 16),
    Buffer.from([channelId, 0x00]),
    hpai(localIp, localPort),
  ]);
}

function pktDisconnectRes(channelId) {
  return Buffer.concat([hdr(SVC.DISCONNECT_RES, 8), Buffer.from([channelId, 0x00])]);
}

function pktTunnelingReq(channelId, seq, cemi) {
  return Buffer.concat([
    hdr(SVC.TUNNELING_REQ, 10 + cemi.length),
    Buffer.from([0x04, channelId, seq & 0xFF, 0x00]),
    cemi,
  ]);
}

function pktTunnelingAck(channelId, seq, status = 0x00) {
  return Buffer.concat([
    hdr(SVC.TUNNELING_ACK, 10),
    Buffer.from([0x04, channelId, seq & 0xFF, status]),
  ]);
}

function decodePhysicalRaw(buf, off) {
  const b0 = buf[off], b1 = buf[off + 1];
  return `${(b0 >> 4)}.${b0 & 0xF}.${b1}`;
}

// ── Local IP detection ─────────────────────────────────────────────────────────

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

// ── KnxIpConnection ────────────────────────────────────────────────────────────

class KnxIpConnection extends KnxConnection {
  constructor() {
    super();
    this.socket     = null;
    this.host       = null;
    this.port       = 3671;
    this.localIp    = '0.0.0.0';
    this.localPort  = 0;
    this.channelId  = 0;
    this.seqOut     = 0;
    this.seqIn      = -1;
    this._hbTimer   = null;
    this._pendingAck = null;
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  connect(host, port = 3671, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      this.host = host;
      this.port = port;
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', err => {
        if (!this.connected) reject(err);
        else { this.connected = false; this.emit('error', err); }
      });
      this.socket.on('message', (msg, rinfo) => this._onMsg(msg, rinfo));

      this.socket.bind(0, () => {
        this.localPort = this.socket.address().port;
        this.localIp   = getLocalIp();

        const timer = setTimeout(() => reject(new Error(`Connect timeout to ${host}:${port}`)), timeoutMs);
        this.once('_connected', () => { clearTimeout(timer); resolve(); });
        this.once('_connectFailed', err => { clearTimeout(timer); reject(err); });

        this._sendRaw(pktConnect(this.localIp, this.localPort));
      });
    });
  }

  _sendRaw(buf) {
    if (this.socket) this.socket.send(buf, 0, buf.length, this.port, this.host);
  }

  // ── Incoming message dispatcher ──────────────────────────────────────────────

  _onMsg(msg, _rinfo) {
    if (msg.length < 6) return;
    const svc = msg.readUInt16BE(2);
    switch (svc) {
      case SVC.CONNECT_RES:    this._onConnectRes(msg);    break;
      case SVC.CONNSTATE_RES:  /* heartbeat ack */ break;
      case SVC.DISCONNECT_REQ: this._onDisconnectReq(msg); break;
      case SVC.DISCONNECT_RES: this._onDisconnectRes();    break;
      case SVC.TUNNELING_REQ:  this._onTunnelingReq(msg);  break;
      case SVC.TUNNELING_ACK:  this._onTunnelingAck(msg);  break;
    }
  }

  _onConnectRes(msg) {
    if (msg.length < 8) return;
    const status = msg[7];
    if (status !== 0x00) {
      this.emit('_connectFailed', new Error(`KNX connect error 0x${status.toString(16).padStart(2,'0')}`));
      return;
    }
    this.channelId = msg[6];
    if (msg.length >= 20) this.localAddr = decodePhysicalRaw(msg, 18);

    this.connected = true;
    this._hbTimer = setInterval(() => {
      this._sendRaw(pktConnState(this.channelId, this.localIp, this.localPort));
    }, 60000);

    this.emit('connected');
    this.emit('_connected');
  }

  _onDisconnectReq(msg) {
    this.connected = false;
    this._clearHeartbeat();
    if (msg.length >= 7) this._sendRaw(pktDisconnectRes(msg[6]));
    this.emit('disconnected');
  }

  _onDisconnectRes() {
    this.connected = false;
    this._clearHeartbeat();
    this.emit('disconnected');
  }

  _onTunnelingReq(msg) {
    if (msg.length < 10) return;
    const channelId = msg[7];
    const seq       = msg[8];

    this._sendRaw(pktTunnelingAck(channelId, seq));

    if (seq === this.seqIn) return;
    this.seqIn = seq;

    const cemi = parseCEMI(msg, 10);
    if (!cemi) return;
    this._onCEMI(cemi);
  }

  _onTunnelingAck(msg) {
    if (msg.length < 10) return;
    const seq    = msg[8];
    const status = msg[9];
    if (this._pendingAck && this._pendingAck.seq === seq) {
      clearTimeout(this._pendingAck.timer);
      const { resolve, reject } = this._pendingAck;
      this._pendingAck = null;
      if (status === 0x00) resolve();
      else reject(new Error(`Tunneling ACK error 0x${status.toString(16)}`));
    }
  }

  // ── Send CEMI via KNXnet/IP tunneling with ACK wait ───────────────────────────

  sendCEMI(cemi, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const seq = this.seqOut;
      this.seqOut = (this.seqOut + 1) & 0xFF;
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

  disconnect() {
    if (!this.socket) return;
    this._clearHeartbeat();
    if (this.connected) {
      try { this._sendRaw(pktDisconnect(this.channelId, this.localIp, this.localPort)); } catch (_) {}
    }
    this.connected = false;
    setTimeout(() => { try { this.socket.close(); } catch (_) {} this.socket = null; }, 500);
  }

  _clearHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  status() {
    return { connected: this.connected, host: this.host, port: this.port, hasLib: true };
  }
}

module.exports = { KnxConnection: KnxIpConnection };
