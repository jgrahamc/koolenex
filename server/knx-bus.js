'use strict';

/**
 * KNX Bus Manager
 * Facade over KnxIpConnection (UDP) and KnxUsbConnection (USB HID).
 */

const EventEmitter = require('events');
const { KnxConnection: KnxIpConnection } = require('./knx-protocol');
const { KnxUsbConnection } = require('./knx-usb');

class KnxBusManager extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.connected  = false;
    this.host       = null;
    this.port       = 3671;
    this.type       = null;   // 'udp' or 'usb'
    this.projectId  = null;
    this._wss       = null;
    this._remapFn   = null;
  }

  /** Set a function that remaps telegram src/dst addresses (for demo mode) */
  setRemapper(fn) { this._remapFn = fn; }

  attachWSS(wss) {
    this._wss = wss;
  }

  broadcast(type, payload) {
    if (!this._wss) return;
    const msg = JSON.stringify({ type, ...payload });
    this._wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }

  _attachEvents(conn) {
    conn.on('telegram', (telegram) => {
      const tg = { ...telegram, projectId: this.projectId };
      const mapped = this._remapFn ? this._remapFn(tg) : tg;
      this.broadcast('knx:telegram', { telegram: mapped, projectId: this.projectId });
      this.emit('telegram', mapped);
    });

    conn.on('disconnected', () => {
      this.connected = false;
      this.broadcast('knx:disconnected', {});
    });

    conn.on('error', (err) => {
      this.connected = false;
      this.broadcast('knx:error', { error: String(err) });
    });
  }

  connect(host, port, projectId) {
    if (this.connection) this.disconnect();

    this.host      = host;
    this.port      = port || 3671;
    this.projectId = projectId;
    this.type      = 'udp';

    const conn = new KnxIpConnection();
    this._attachEvents(conn);

    return conn.connect(host, this.port).then(() => {
      this.connection = conn;
      this.connected  = true;
      console.log(`[KNX] Connected to ${host}:${this.port}`);
      this.broadcast('knx:connected', { host, port: this.port, type: 'udp' });
      return { host, port: this.port };
    });
  }

  connectUsb(devicePath, projectId) {
    if (this.connection) this.disconnect();

    this.projectId = projectId;
    this.type      = 'usb';
    this.host      = null;
    this.port      = null;

    const conn = new KnxUsbConnection();
    this._attachEvents(conn);

    return conn.connect(devicePath).then((info) => {
      this.connection = conn;
      this.connected  = true;
      console.log(`[KNX] Connected via USB: ${devicePath}`);
      this.broadcast('knx:connected', { type: 'usb', path: devicePath });
      return info;
    });
  }

  /** List available KNX USB HID devices */
  listUsbDevices() {
    return KnxUsbConnection.listDevices();
  }

  /** List all HID devices (for debugging) */
  listAllHidDevices() {
    return KnxUsbConnection.listAllHidDevices();
  }

  disconnect() {
    if (this.connection) {
      try { this.connection.disconnect(); } catch (_) {}
      this.connection = null;
    }
    this.connected = false;
    this.host      = null;
    this.type      = null;
  }

  write(groupAddress, value, dpt = '1') {
    if (!this.connection || !this.connected) throw new Error('Not connected to KNX bus');
    return this.connection.write(groupAddress, value, dpt);
  }

  read(groupAddress) {
    if (!this.connection || !this.connected) throw new Error('Not connected to KNX bus');
    return this.connection.read(groupAddress);
  }

  ping(gaAddresses, deviceAddress = null, timeoutMs = 2000) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.ping(gaAddresses, deviceAddress, timeoutMs);
  }

  identify(deviceAddress) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.identify(deviceAddress);
  }

  scan(area, line, timeoutMs = 200, onProgress = null) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.scan(area, line, timeoutMs, onProgress);
  }

  abortScan() {
    if (this.connection) this.connection.abortScan();
  }

  readDeviceInfo(deviceAddr) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.readDeviceInfo(deviceAddr);
  }

  programIA(newAddr) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.programIA(newAddr);
  }

  downloadDevice(deviceAddr, steps, gaTable, assocTable, paramMem, onProgress) {
    if (!this.connection || !this.connected) return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.downloadDevice(deviceAddr, steps, gaTable, assocTable, paramMem, onProgress);
  }

  status() {
    return {
      connected: this.connected,
      type:      this.type,
      host:      this.host,
      port:      this.port,
      hasLib:    true,
    };
  }
}

module.exports = new KnxBusManager();
