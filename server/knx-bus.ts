/**
 * KNX Bus Manager
 * Facade over KnxIpConnection (UDP) and KnxUsbConnection (USB HID).
 */

import EventEmitter from 'events';
import { KnxConnection as KnxIpConnection } from './knx-protocol.ts';
import { KnxUsbConnection } from './knx-usb.ts';
import type { Telegram } from '../shared/types.ts';

interface KnxConnectionInstance {
  connected: boolean;
  connect(...args: unknown[]): Promise<unknown>;
  disconnect(): void;
  write(ga: string, value: unknown, dpt?: string): Record<string, unknown>;
  read(ga: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  ping(
    gaAddresses: string[],
    deviceAddress: string | null,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  identify(deviceAddress: string): Promise<void>;
  scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress: ((prog: Record<string, unknown>) => void) | null,
  ): Promise<Record<string, unknown>[]>;
  abortScan(): void;
  readDeviceInfo(deviceAddr: string): Promise<Record<string, unknown>>;
  programIA(newAddr: string): Promise<Record<string, unknown>>;
  downloadDevice(
    deviceAddr: string,
    steps: unknown[],
    gaTable: Buffer,
    assocTable: Buffer,
    paramMem: Buffer | null,
    onProgress: (p: Record<string, unknown>) => void,
  ): Promise<void>;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
}

interface WebSocketClient {
  readyState: number;
  send(data: string): void;
}

interface WebSocketServer {
  clients: Set<WebSocketClient>;
}

class KnxBusManager extends EventEmitter {
  connection: KnxConnectionInstance | null;
  connected: boolean;
  host: string | null;
  port: number | null;
  type: 'udp' | 'usb' | null;
  projectId: number | string | null;
  _wss: WebSocketServer | null;
  _remapFn: ((telegram: Telegram) => Telegram) | null;

  constructor() {
    super();
    this.connection = null;
    this.connected = false;
    this.host = null;
    this.port = 3671;
    this.type = null;
    this.projectId = null;
    this._wss = null;
    this._remapFn = null;
  }

  /** Set a function that remaps telegram src/dst addresses (for demo mode) */
  setRemapper(fn: (telegram: Telegram) => Telegram): void {
    this._remapFn = fn;
  }

  attachWSS(wss: WebSocketServer): void {
    this._wss = wss;
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    if (!this._wss) return;
    const msg = JSON.stringify({ type, ...payload });
    this._wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(msg);
    });
  }

  _attachEvents(conn: KnxConnectionInstance): void {
    conn.on('telegram', (...args: unknown[]) => {
      const telegram = args[0] as Telegram;
      const tg = { ...telegram, projectId: this.projectId ?? undefined };
      const mapped = this._remapFn ? this._remapFn(tg) : tg;
      this.broadcast('knx:telegram', {
        telegram: mapped,
        projectId: this.projectId,
      } as Record<string, unknown>);
      this.emit('telegram', mapped);
    });

    conn.on('disconnected', () => {
      this.connected = false;
      this.broadcast('knx:disconnected', {});
    });

    conn.on('error', (...args: unknown[]) => {
      this.connected = false;
      this.broadcast('knx:error', { error: String(args[0]) });
    });
  }

  connect(
    host: string,
    port: number,
    projectId?: number | string | null,
  ): Promise<{ host: string; port: number }> {
    if (this.connection) this.disconnect();

    this.host = host;
    const resolvedPort = port || 3671;
    this.port = resolvedPort;
    this.projectId = projectId ?? null;
    this.type = 'udp';

    const conn = new KnxIpConnection() as unknown as KnxConnectionInstance;
    this._attachEvents(conn);

    return (conn.connect(host, resolvedPort) as Promise<void>).then(() => {
      this.connection = conn;
      this.connected = true;
      console.log(`[KNX] Connected to ${host}:${resolvedPort}`);
      this.broadcast('knx:connected', {
        host,
        port: resolvedPort,
        type: 'udp',
      });
      return { host, port: resolvedPort };
    });
  }

  connectUsb(
    devicePath: string,
    projectId?: number | string | null,
  ): Promise<Record<string, unknown>> {
    if (this.connection) this.disconnect();

    this.projectId = projectId ?? null;
    this.type = 'usb';
    this.host = null;
    this.port = null;

    const conn = new KnxUsbConnection() as unknown as KnxConnectionInstance;
    this._attachEvents(conn);

    return (conn.connect(devicePath) as Promise<Record<string, unknown>>).then(
      (info) => {
        this.connection = conn;
        this.connected = true;
        console.log(`[KNX] Connected via USB: ${devicePath}`);
        this.broadcast('knx:connected', { type: 'usb', path: devicePath });
        return info;
      },
    );
  }

  /** List available KNX USB HID devices */
  listUsbDevices(): Record<string, unknown>[] {
    return KnxUsbConnection.listDevices();
  }

  /** List all HID devices (for debugging) */
  listAllHidDevices(): Record<string, unknown>[] {
    return KnxUsbConnection.listAllHidDevices();
  }

  disconnect(): void {
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch (_) {}
      this.connection = null;
    }
    this.connected = false;
    this.host = null;
    this.type = null;
  }

  write(
    groupAddress: string,
    value: unknown,
    dpt: string = '1',
  ): Record<string, unknown> {
    if (!this.connection || !this.connected)
      throw new Error('Not connected to KNX bus');
    return this.connection.write(groupAddress, value, dpt);
  }

  read(groupAddress: string): Promise<Record<string, unknown>> {
    if (!this.connection || !this.connected)
      throw new Error('Not connected to KNX bus');
    return this.connection.read(groupAddress);
  }

  ping(
    gaAddresses: string[],
    deviceAddress: string | null = null,
    timeoutMs: number = 2000,
  ): Promise<Record<string, unknown>> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.ping(gaAddresses, deviceAddress, timeoutMs);
  }

  identify(deviceAddress: string): Promise<void> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.identify(deviceAddress);
  }

  scan(
    area: number,
    line: number,
    timeoutMs: number = 200,
    onProgress: ((prog: Record<string, unknown>) => void) | null = null,
  ): Promise<Record<string, unknown>[]> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.scan(area, line, timeoutMs, onProgress);
  }

  abortScan(): void {
    if (this.connection)
      (this.connection as unknown as { abortScan(): void }).abortScan();
  }

  readDeviceInfo(deviceAddr: string): Promise<Record<string, unknown>> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.readDeviceInfo(deviceAddr);
  }

  programIA(newAddr: string): Promise<Record<string, unknown>> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.programIA(newAddr);
  }

  downloadDevice(
    deviceAddr: string,
    steps: unknown[],
    gaTable: Buffer,
    assocTable: Buffer,
    paramMem: Buffer | null,
    onProgress: (p: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.connection || !this.connected)
      return Promise.reject(new Error('Not connected to KNX bus'));
    return this.connection.downloadDevice(
      deviceAddr,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
    );
  }

  status(): Record<string, unknown> {
    return {
      connected: this.connected,
      type: this.type,
      host: this.host,
      port: this.port,
      hasLib: true,
    };
  }
}

export default KnxBusManager;
