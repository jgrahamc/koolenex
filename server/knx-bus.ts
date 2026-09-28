/**
 * KNX Bus Manager
 * Facade over KnxIpConnection (UDP) and KnxUsbConnection (USB HID).
 */

import EventEmitter from 'events';
import { logger } from './log.ts';
import {
  KnxConnection,
  type DownloadStep,
  type DownloadProgress,
  type DownloadExtra,
  type DownloadResult,
  type ScanProgress,
  type DeviceInfo,
} from './knx-connection.ts';
import {
  KnxConnection as KnxIpConnection,
  type IpTransportProtocol,
} from './knx-protocol.ts';
// LOCAL TESTING AID ONLY - see connectLoopback()'s own doc comment below.
import {
  KnxLoopbackConnection,
  type LoopbackDeviceConfig,
} from './knx-loopback-connection.ts';
import { KnxUsbConnection } from './knx-usb.ts';
import type { Telegram } from '../shared/types.ts';

interface WebSocketClient {
  readyState: number;
  send(data: string): void;
}

interface WebSocketServer {
  clients: Set<WebSocketClient>;
}

class KnxBusManager extends EventEmitter {
  connection: KnxConnection | null;
  connected: boolean;
  host: string | null;
  port: number | null;
  // 'loopback' is a LOCAL TESTING AID ONLY - a simulated single device,
  // never a real bus connection. Not part of any real feature; drop this
  // before shipping anything.
  type: 'udp' | 'tcp' | 'usb' | 'loopback' | null;
  projectId: number | string | null;
  _wss: WebSocketServer | null;
  _remapFn: ((telegram: Telegram) => Telegram) | null;
  _reconnecting: Promise<{
    host: string;
    port: number;
    type: 'udp' | 'tcp';
  }> | null;
  _forceReconnecting: Promise<void> | null;
  _connecting: Promise<{
    host: string;
    port: number;
    type: 'udp' | 'tcp';
  }> | null;
  _keepAliveRefs: number;
  // Server-side "needs attention" flag (Idle vs Disconnected on the badge) -
  // kept here, not just broadcast as an event, so any client that (re)connects
  // later (reload, WS reconnect) still learns of a standing reconnect failure
  // via /bus/status.
  _needsAttention: boolean;

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
    this._reconnecting = null;
    this._forceReconnecting = null;
    this._connecting = null;
    this._keepAliveRefs = 0;
    this._needsAttention = false;
  }

  /** Set a function that remaps telegram src/dst addresses (for demo mode) */
  setRemapper(fn: (telegram: Telegram) => Telegram): void {
    this._remapFn = fn;
  }

  attachWSS(wss: WebSocketServer): void {
    this._wss = wss;
  }

  /**
   * Registers interest in proactive reconnection after an idle-timeout drop
   * (see _attachEvents()'s 'disconnected' handler and _autoReconnect()).
   * _ensureConnected() already recovers on-demand for any bus operation;
   * this only matters for passive watchers or a long-running operation that
   * would otherwise be interrupted mid-flight. Ref-counted, not global -
   * most gateways support few concurrent tunneling channels, so idle
   * reconnection must not run when nothing needs it. Returns an idempotent
   * release function.
   */
  addKeepAliveRef(): () => void {
    this._keepAliveRefs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._keepAliveRefs = Math.max(0, this._keepAliveRefs - 1);
    };
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    if (!this._wss) return;
    // `type` must be spread last so it always wins over a same-named field
    // in payload - clients dispatch on it.
    const msg = JSON.stringify({ ...payload, type });
    this._wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch (_) {}
      }
    });
  }

  _attachEvents(conn: KnxConnection): void {
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
      // Fires only for an unexpected drop (an explicit disconnect() sets
      // `connected = false` first, suppressing this). Reconnect proactively
      // only with an active keep-alive ref; otherwise left for
      // _ensureConnected() to recover on next use.
      if (this._keepAliveRefs > 0) {
        this._autoReconnect();
      }
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
    protocol: IpTransportProtocol = 'auto',
  ): Promise<{ host: string; port: number; type: 'udp' | 'tcp' }> {
    // Reentrancy guard: without it, two overlapping calls (e.g. a manual
    // Connect racing an in-flight forceReconnect()/_ensureConnected()) could
    // both open a fresh tunnel to the same router before either sets
    // `this.connection`, orphaning one channel and leaking a tunnel slot.
    // Shared by every caller (routes, _ensureConnected(), forceReconnect(),
    // _autoReconnect()).
    if (this._connecting) return this._connecting;
    // disconnect() clears this.host/this.type, so it must run before they're
    // set below, not after.
    const previous = this.connection;
    if (this.connection) this.disconnect();
    this.host = host;
    const resolvedPort = port || 3671;
    this.port = resolvedPort;
    this.projectId = projectId ?? null;

    this._connecting = (async () => {
      // Wait for the old socket to actually close before opening the new
      // one - a router that reuses the channel id or is short of tunnel
      // slots can take the new tunnel down along with the old socket.
      if (previous) await previous.whenClosed();
      const conn = new KnxIpConnection();
      this._attachEvents(conn);
      await conn.connect(host, resolvedPort, undefined, protocol);
      this.connection = conn;
      this.connected = true;
      // A genuine successful connect clears any standing "needs
      // attention" state - whatever the earlier failure was, it's over.
      this._needsAttention = false;
      // Reflects what connect() actually negotiated ('auto' may have
      // resolved to either) - see knx-protocol.ts's TCP-first/UDP-fallback
      // logic.
      const negotiated = conn.transport ?? 'udp';
      this.type = negotiated;
      logger.info(
        'knx',
        `Connected to ${host}:${resolvedPort} (${negotiated})`,
      );
      this.broadcast('knx:connected', {
        host,
        port: resolvedPort,
        connectionType: negotiated,
      });
      return { host, port: resolvedPort, type: negotiated };
    })()
      .catch((err: Error) => {
        // Set/broadcast here so every caller (direct /bus/connect included)
        // is covered uniformly; the equivalent assignments upstream in
        // forceReconnect()/_ensureConnected() become redundant but harmless
        // (idempotent, and the client-side handler tolerates a double fire).
        this._needsAttention = true;
        this.broadcast('knx:reconnect-failed', { error: err.message });
        throw err;
      })
      .finally(() => {
        this._connecting = null;
      });
    return this._connecting;
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

    const conn = new KnxUsbConnection();
    this._attachEvents(conn);

    return (conn.connect(devicePath) as Promise<Record<string, unknown>>).then(
      (info) => {
        this.connection = conn;
        this.connected = true;
        logger.info('knx', `Connected via USB: ${devicePath}`);
        this.broadcast('knx:connected', {
          connectionType: 'usb',
          path: devicePath,
        });
        return info;
      },
    );
  }

  /**
   * LOCAL TESTING AID ONLY - connects to a KnxLoopbackConnection simulating
   * one real device from the active project, instead of a real socket/USB
   * device. Lets the whole app (Program/Verify/Restart) be driven exactly
   * as a real user would, with no hardware attached. For development and
   * testing only: it never touches a real device.
   */
  connectLoopback(
    deviceAddr: string,
    cfg: LoopbackDeviceConfig,
    projectId?: number | string | null,
  ): Promise<Record<string, unknown>> {
    if (this.connection) this.disconnect();

    this.projectId = projectId ?? null;
    this.type = 'loopback';
    this.host = null;
    this.port = null;

    const conn = new KnxLoopbackConnection(cfg);
    this._attachEvents(conn);
    this.connection = conn;
    this.connected = true;
    logger.info('knx', `Connected via loopback (test): ${deviceAddr}`);
    this.broadcast('knx:connected', {
      connectionType: 'loopback',
      deviceAddress: deviceAddr,
    });
    return Promise.resolve({ ok: true, deviceAddress: deviceAddr });
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
    // An explicit/deliberate disconnect is not a failure state.
    this._needsAttention = false;
  }

  /**
   * Forces a fresh IP connection regardless of whether the current one still
   * looks alive - guards against a Verify/Download starting right after an
   * idle-timeout drop, where the request could go out on a dying connection
   * before the drop is noticed. `_ensureConnected()` only recovers an
   * already-dead connection; this refreshes a merely-stale one first. No-op
   * when never connected (host null) or on USB (no idle timeout to guard
   * against).
   */
  async forceReconnect(): Promise<void> {
    if (!this.host || this.type === 'usb') return;
    // Piggyback on an in-flight reconnect of either kind instead of racing
    // it - connect() tears down the existing connection first, so two
    // concurrent connect() calls against the same router can each tear down
    // the other's fresh socket before it finishes negotiating.
    if (this._reconnecting) {
      await this._reconnecting;
      return;
    }
    if (this._forceReconnecting) {
      await this._forceReconnecting;
      return;
    }
    const host = this.host;
    const port = this.port ?? 3671;
    const projectId = this.projectId;
    const protocol = this.type as IpTransportProtocol;
    this._forceReconnecting = this.connect(host, port, projectId, protocol)
      .then(() => undefined)
      .catch((err: Error) => {
        // Same "needs attention" signal _ensureConnected() sends on a real
        // failure - this bypasses _ensureConnected() entirely, so it must
        // set it itself.
        this._needsAttention = true;
        this.broadcast('knx:reconnect-failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      })
      .finally(() => {
        this._forceReconnecting = null;
      });
    await this._forceReconnecting;
  }

  /**
   * Reconnects on demand before a bus operation if the connection has gone
   * idle-dropped since the last one (a KNXnet/IP gateway may close an idle
   * TCP tunneling connection after a period with no traffic - see
   * knx-protocol.ts). USB is never auto-reconnected; callers get the usual
   * "not connected" error there.
   *
   * `broadcastFailure` (default true) sends 'knx:reconnect-failed' on
   * failure, distinguishing a calm idle state from one needing attention.
   * _autoReconnect() passes false for its own mid-backoff retries, only
   * broadcasting once retries are exhausted.
   */
  async _ensureConnected(broadcastFailure = true): Promise<void> {
    if (this.connected && this.connection) return;
    if (!this.host || this.type === 'usb') {
      throw new Error('Not connected to KNX bus');
    }
    if (!this._reconnecting) {
      this._reconnecting = this.connect(
        this.host,
        this.port ?? 3671,
        this.projectId,
        (this.type ?? 'auto') as IpTransportProtocol,
      )
        .catch((err: Error) => {
          if (broadcastFailure) {
            this._needsAttention = true;
            this.broadcast('knx:reconnect-failed', { error: err.message });
          }
          throw err;
        })
        .finally(() => {
          this._reconnecting = null;
        });
    }
    await this._reconnecting;
  }

  /**
   * Proactively reconnects after an unexpected disconnect, independent of
   * any bus operation. Only runs while a keep-alive ref is held. Retries
   * with backoff up to a bounded attempt count, re-checking
   * host/type/keep-alive interest each time so an explicit disconnect() or
   * the last ref being released stops the cycle immediately.
   */
  _autoReconnect(attempt: number = 1): void {
    if (!this.host || this.type === 'usb' || this._keepAliveRefs <= 0) return;
    const maxAttempts = 5;
    this._ensureConnected(false)
      .then(() => {
        logger.info(
          'knx',
          'Bus auto-reconnected after an unexpected disconnect',
        );
      })
      .catch((err: Error) => {
        if (!this.host || this.type === 'usb' || this._keepAliveRefs <= 0)
          return;
        logger.warn('knx', 'Bus auto-reconnect attempt failed', {
          attempt,
          message: err.message,
        });
        if (attempt < maxAttempts) {
          const delay = Math.min(30000, 2000 * 2 ** (attempt - 1));
          setTimeout(() => this._autoReconnect(attempt + 1), delay);
        } else {
          // Retries exhausted - flag for the UI (wrong IP, router down, etc.).
          this._needsAttention = true;
          this.broadcast('knx:reconnect-failed', { error: err.message });
        }
      });
  }

  async write(
    groupAddress: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    await this._ensureConnected();
    return this.connection!.write(groupAddress, value, dpt);
  }

  async read(groupAddress: string): Promise<{ ga: string; value: string }> {
    await this._ensureConnected();
    return this.connection!.read(groupAddress);
  }

  async ping(
    gaAddresses: string[],
    deviceAddress: string | null = null,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    await this._ensureConnected();
    return this.connection!.ping(gaAddresses, deviceAddress ?? '', timeoutMs);
  }

  async identify(deviceAddress: string): Promise<void> {
    await this._ensureConnected();
    return this.connection!.identify(deviceAddress);
  }

  async scan(
    area: number,
    line: number,
    timeoutMs: number = 200,
    onProgress?: (prog: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    await this._ensureConnected();
    return this.connection!.scan(area, line, timeoutMs, onProgress);
  }

  abortScan(): void {
    if (this.connection) this.connection.abortScan();
  }

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    await this._ensureConnected();
    return this.connection!.readDeviceInfo(deviceAddr);
  }

  async programIA(
    newAddr: string,
  ): Promise<{ ok: boolean; newAddr: string; restarted: boolean }> {
    await this._ensureConnected();
    return this.connection!.programIA(newAddr);
  }

  async checkProgrammingMode(
    timeoutMs?: number,
  ): Promise<{ address: string | null }> {
    await this._ensureConnected();
    return this.connection!.checkProgrammingMode(timeoutMs);
  }

  // Direct A_Restart trigger, no address write involved - isolates whether a
  // given device visibly reboots on A_Restart (docs/knx-device-write-protocol.md §9.5).
  async restartDevice(
    deviceAddr: string,
    settleMs?: number,
    postRestartDelayMs?: number,
  ): Promise<void> {
    await this._ensureConnected();
    return this.connection!.restartDevice(
      deviceAddr,
      settleMs,
      postRestartDelayMs,
    );
  }

  async readSerialNumbersInProgrammingMode(
    timeoutMs?: number,
  ): Promise<Array<{ serial: string; src: string }>> {
    await this._ensureConnected();
    return this.connection!.readSerialNumbersInProgrammingMode(timeoutMs);
  }

  // Queries a device's current address by serial (docs/knx-device-write-protocol.md §9.3),
  // same mechanism ETS's Factory Reset verify uses - no programming-button press needed.
  async readIndividualAddressBySerial(
    serial: Buffer,
    timeoutMs?: number,
  ): Promise<{ address: string } | null> {
    await this._ensureConnected();
    return this.connection!.readIndividualAddressBySerial(serial, timeoutMs);
  }

  async assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs?: number,
  ): Promise<{
    ok: boolean;
    verified: boolean;
    address: string | null;
    restarted: boolean;
    alreadyCorrect: boolean;
    occupiedBy?: { serial: string | null };
  }> {
    await this._ensureConnected();
    return this.connection!.assignIndividualAddressBySerial(
      serial,
      newAddr,
      timeoutMs,
    );
  }

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (p: DownloadProgress) => void,
    extra?: DownloadExtra,
  ): Promise<DownloadResult> {
    await this._ensureConnected();
    return this.connection!.downloadDevice(
      deviceAddr,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
      extra,
    );
  }

  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize?: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readMemory(deviceAddr, address, length, chunkSize);
  }

  /**
   * Replay a literal sequence of raw CEMI frame bytes, completely verbatim
   * - no automatic T_Connect/T_Disconnect wrapping, no APDU reconstruction.
   * The caller is expected to include the real captured Connect/Disconnect
   * control frames as part of `frames` itself (extracted straight from a
   * real ETS capture) - this method just fires each buffer through
   * sendCEMI() in order, nothing more. Debug-only.
   */
  async replayFrames(
    _deviceAddr: string,
    frames: Buffer[],
    delayMs: number = 30,
    onProgress?: (i: number, total: number) => void,
  ): Promise<void> {
    await this._ensureConnected();
    for (let i = 0; i < frames.length; i++) {
      await this.connection!.sendCEMI(frames[i]!);
      if (onProgress) onProgress(i + 1, frames.length);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
    chunkSize?: number,
    onChunk?: (bytesRead: number) => void,
    // See KnxConnection.readMemory()'s identical parameter for the real
    // evidence/doc comment.
    cachedMaxApduLength?: number | null,
  ): Promise<Buffer[]> {
    await this._ensureConnected();
    return this.connection!.readMemoryMany(
      deviceAddr,
      regions,
      chunkSize,
      onChunk,
      cachedMaxApduLength,
    );
  }

  // Extended memory read (A_MemoryExtended_Read, 0x1FD) for System B / System 7
  // devices that do not answer the legacy A_Memory_Read. Exposed here so the
  // capability is reachable from routes; see the note in /bus/verify-device.
  async readMemoryExtended(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize?: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readMemoryExtended(
      deviceAddr,
      address,
      length,
      chunkSize,
    );
  }

  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readProperty(deviceAddr, objIdx, propId);
  }

  async readPropertyMany(
    deviceAddr: string,
    reads: Array<{
      objIdx: number;
      propId: number;
      count?: number;
      timeoutMs?: number;
    }>,
  ): Promise<Buffer[]> {
    await this._ensureConnected();
    return this.connection!.readPropertyMany(deviceAddr, reads);
  }

  status(): {
    connected: boolean;
    type: string | null;
    host: string | null;
    port: number | null;
    hasLib: boolean;
    needsAttention: boolean;
  } {
    return {
      connected: this.connected,
      type: this.type,
      host: this.host,
      port: this.port,
      hasLib: true,
      needsAttention: this._needsAttention,
    };
  }
}

export default KnxBusManager;
