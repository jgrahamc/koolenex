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
  type: 'udp' | 'tcp' | 'usb' | null;
  projectId: number | string | null;
  _wss: WebSocketServer | null;
  _remapFn: ((telegram: Telegram) => Telegram) | null;
  _reconnecting: Promise<{ host: string; port: number; type: 'udp' | 'tcp' }> | null;
  _forceReconnecting: Promise<void> | null;
  _connecting: Promise<{ host: string; port: number; type: 'udp' | 'tcp' }> | null;
  _keepAliveRefs: number;
  // Real bug, found live 2026-08-31: "needsAttention" (the badge's
  // Idle-vs-Disconnected distinction) previously lived ONLY as a live
  // 'knx:reconnect-failed' WebSocket event, never in server-side state at
  // all - a real, standing reconnect failure was completely invisible to
  // any client that (re)connects afterward, including a plain browser
  // reload or even just the WebSocket itself reconnecting mid-session
  // (client's own syncBusStatus() replaces busStatus wholesale from
  // /bus/status, which never carried this at all). Tracked here now, so a
  // genuine "last reconnect attempt failed" state survives and is reported
  // to every client that asks, not just the one that happened to be
  // listening at the exact moment it happened.
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
   * Acquires an interest in proactively keeping the bus connection alive
   * across a gateway idle-timeout drop (see the 'disconnected' handler in
   * _attachEvents() and _autoReconnect() below). Reconnect-on-demand
   * (_ensureConnected(), used by every bus operation) already recovers a
   * dropped connection the moment something real needs it, at zero
   * ongoing cost - proactive reconnection exists only for callers with no
   * operation of their own to trigger that (passively watching live
   * telegrams) or where a drop mid-operation would otherwise interrupt a
   * long-running one (a device download/verify).
   *
   * Deliberately ref-counted and not global: most KNXnet/IP gateways
   * support only a small number of concurrent tunneling channels, so
   * reconnecting indefinitely whenever the app merely happens to be
   * connected - with nobody watching and nothing running - would
   * needlessly occupy one of those slots and could block ETS or another
   * tool from connecting on-site. Returns a release function; safe to
   * call more than once (idempotent).
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
    // Spread payload first so `type` (the message-kind discriminator
    // clients dispatch on, e.g. 'knx:connected') always wins even if the
    // payload itself happens to have its own field called `type` - it
    // previously came last, so a payload field named `type` silently
    // replaced the message kind and the message went undelivered to any
    // handler.
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
      // This event only ever fires for an unexpected drop - an explicit
      // disconnect() call sets `connected = false` itself beforehand, which
      // suppresses the underlying connection's own 'disconnected' emit (see
      // knx-protocol.ts). Only reconnect proactively while something has
      // registered real interest via addKeepAliveRef() - see its doc
      // comment above for why this is scoped rather than unconditional.
      // Without an active ref, a drop is left for reconnect-on-demand
      // (_ensureConnected(), used by every bus operation) to recover the
      // next time something actually needs the bus.
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
    // Real bug, found live 2026-08-31: connect() had NO reentrancy guard of
    // its own at all. Two overlapping calls (e.g. a user clicking "Connect"
    // on the badge while a bus operation's own forceReconnect()/
    // _ensureConnected() is independently mid-flight after an unexpected
    // drop) each run this synchronous prefix - `if (this.connection)
    // this.disconnect()` - before EITHER call's own conn.connect() has
    // resolved and actually set `this.connection`. So the second call never
    // sees the first one's (still-pending) connection to tear down, and
    // both independently open a brand-new physical KNXnet/IP tunnel to the
    // same router. Whichever resolves second then silently overwrites
    // `this.connection`, orphaning the first - a real leaked tunnel channel
    // the router never gets told to close. This exactly matches a real
    // capture from live testing the same day: two "Connected" log lines
    // under 2 seconds apart, then the connection closing again half a
    // second later - the router very plausibly reacting to the leaked/
    // orphaned channel, or simply running low on its own limited tunnel
    // slots. A single shared in-flight guard, reused by ANY caller
    // (`/bus/connect` directly, `_ensureConnected()`, `forceReconnect()`,
    // `_autoReconnect()`), closes this at the one place all of them
    // actually go through.
    if (this._connecting) return this._connecting;
    // disconnect() (which also clears this.host/this.type - see its own
    // body) must run BEFORE these are set below, not after - real
    // ordering bug caught while writing this fix: moving the old
    // `if (this.connection) this.disconnect()` prefix into the async body
    // below it would otherwise clobber this.host back to null right after
    // setting it, since disconnect() runs after the assignment instead of
    // before.
    if (this.connection) this.disconnect();
    this.host = host;
    const resolvedPort = port || 3671;
    this.port = resolvedPort;
    this.projectId = projectId ?? null;

    this._connecting = (async () => {
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
        // Real gap, found live 2026-08-31 right after the fix above: the
        // three _ensureConnected()/forceReconnect()/_autoReconnect() sites
        // that set _needsAttention on failure don't cover a DIRECT failed
        // connect attempt via this method (e.g. /bus/connect with a wrong
        // host) - that's arguably the most deserving case of all, and a
        // real user directly noticed it wasn't flipping the badge. Setting
        // it here, in connect() itself, covers every caller uniformly at
        // the one place they all actually go through - the three call-site
        // assignments upstream become redundant but harmless (idempotent).
        // Also broadcast live, same as the other three sites - a real user
        // finding, immediately after the state-only version of this fix:
        // an already-open tab has no other way to learn this happened
        // (it only re-fetches /bus/status on its own mount/WS-reconnect,
        // neither of which a direct failed connect triggers on its own) -
        // "showing idle at my end" despite the server-side state already
        // being correct. This may double-broadcast alongside
        // forceReconnect()/_ensureConnected()'s own catch (they call this
        // method, so both fire for the same failure) - harmless, the
        // client-side handler is idempotent.
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
    // A deliberate disconnect (explicit user action, or connect()'s own
    // teardown-before-reconnect) isn't a failure state - whatever
    // "needsAttention" meant before no longer applies to a bus with no
    // configured host at all. Matches the client's existing calm-by-
    // default reading for a genuinely idle bus (AppShell.tsx's badge).
    this._needsAttention = false;
  }

  /**
   * Forces a fresh IP connection (disconnect + reconnect using the last
   * known host/port/transport) regardless of whether the current one still
   * looks alive - real request 2026-08-31, prompted by a real live
   * failure: a Verify that started right after an idle-timeout drop and
   * auto-reconnect still failed with "Management timeout waiting for
   * MemoryExtended_Read_Response", because the request itself had already
   * gone out on the dying connection before the drop was even noticed.
   * `_ensureConnected()` below only recovers an ALREADY-dead connection;
   * it has no notion of "this one is old, refresh it before starting
   * something that needs the full idle-timeout budget". Used by
   * Program/Verify specifically (server/routes/bus.ts) - real KNXnet/IP
   * tools (ETS itself, per real-world observation) don't appear to hold a
   * connection open at all outside of live monitoring, opening a fresh one
   * per operation instead; this doesn't go that far (koolenex still keeps
   * one shared connection alive for Monitor/passive watchers, which this
   * briefly disrupts - a momentary disconnect/reconnect blip, not lost
   * data), but gives the same guarantee to the operations that actually
   * need a real, bounded time budget (a Full Download can take real time).
   * A no-op if never connected at all (host null) or on USB (no
   * transport-level idle timeout to guard against) - the caller's own
   * subsequent `_ensureConnected()` still surfaces the normal "not
   * connected" error in that case.
   */
  async forceReconnect(): Promise<void> {
    if (!this.host || this.type === 'usb') return;
    // Real live-test finding, 2026-08-31: this previously called
    // this.connect() completely unconditionally, with no awareness of an
    // already-in-flight reconnect from _ensureConnected()/_autoReconnect()
    // (this._reconnecting) or of a second, concurrent forceReconnect()
    // call. connect() unconditionally tears down `this.connection` first
    // (disconnect() then a fresh socket) - two connect() calls racing each
    // other against the same physical router is a real, concrete way to
    // turn a normally-fast reconnect into a much longer, confusing stall
    // (each attempt's fresh socket getting torn down by the other before
    // it finishes negotiating), which matches a real report the same day:
    // a partial download sat at 0% for "30 seconds plus" right after an
    // idle-timeout drop. Not yet confirmed as the exact cause of that
    // specific stall (no live repro capture exists proving it), but this
    // coordination gap is real regardless and worth closing on its own
    // merits - piggyback on an already-in-flight reconnect (of either
    // kind) instead of starting a second one alongside it.
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
        // Same "needs manual attention" signal _ensureConnected() sends on
        // a real failure (see its own doc comment) - a Program/Verify's
        // own forced reconnect failing is exactly as real a failure as any
        // other, and would otherwise never surface on the connection badge
        // at all (this method bypasses _ensureConnected() entirely).
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
   * Transparently reconnects before a bus operation if the connection has
   * gone idle-dropped since the last one - a KNXnet/IP gateway may close an
   * idle TCP tunneling connection on its own after a period with no
   * traffic (see knx-protocol.ts). Rather than holding the connection open
   * indefinitely against a gateway-specific, unconfirmed idle timeout, the
   * bus reconnects using the last known host/port/transport on demand.
   * USB connections are not auto-reconnected (no default device path to
   * retry); callers get the usual "not connected" error for those.
   *
   * `broadcastFailure` (default true) sends 'knx:reconnect-failed' to
   * clients if the reconnect attempt itself fails - real request
   * 2026-08-31: this is what lets the UI distinguish a calm "not
   * connected, nothing needs it right now" idle state from a genuine
   * "this needs manual attention" one (e.g. a wrong IP - see AppShell.tsx's
   * connection badge). A real bus operation calling this directly (the
   * normal case - every route in server/routes/bus.ts goes through this)
   * gets exactly one broadcast per real failure. _autoReconnect() below
   * passes false for its own internal retries - a single attempt failing
   * mid-backoff isn't yet "exhausted", so it broadcasts its own signal only
   * once retries are genuinely exhausted, not on every intermediate one.
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
   * Proactively reconnects after an unexpected disconnect (see the
   * 'disconnected' handler in _attachEvents() above), independent of
   * whether any bus operation happens to run. Only called while at least
   * one addKeepAliveRef() is held. Retries with backoff up to a bounded
   * number of attempts, re-checking host/type/keep-alive-interest on
   * every attempt so a real, explicit disconnect() call (which clears
   * host) or the last keep-alive ref being released during the retry
   * window stops the cycle immediately rather than continuing to retry
   * against a host nothing is interested in any more.
   */
  _autoReconnect(attempt: number = 1): void {
    if (!this.host || this.type === 'usb' || this._keepAliveRefs <= 0) return;
    const maxAttempts = 5;
    this._ensureConnected(false)
      .then(() => {
        logger.info('knx', 'Bus auto-reconnected after an unexpected disconnect');
      })
      .catch((err: Error) => {
        if (!this.host || this.type === 'usb' || this._keepAliveRefs <= 0) return;
        logger.warn('knx', 'Bus auto-reconnect attempt failed', {
          attempt,
          message: err.message,
        });
        if (attempt < maxAttempts) {
          const delay = Math.min(30000, 2000 * 2 ** (attempt - 1));
          setTimeout(() => this._autoReconnect(attempt + 1), delay);
        } else {
          // Retries genuinely exhausted - this is the moment the UI's
          // calm "idle" reading stops applying; something needs a look
          // (wrong IP, router down, etc.), not just "nobody's using it
          // right now".
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

  // Direct A_Restart trigger, no address write involved - added 2026-08-31
  // as a real diagnostic tool to isolate the "no visible reboot" question
  // (docs/knx-device-write-protocol.md §9.5) from the write path itself:
  // lets a Restart be sent against a device that's already correctly
  // addressed, with nothing else in flight, to see in isolation whether
  // this specific device visibly reboots on A_Restart at all.
  async restartDevice(
    deviceAddr: string,
    settleMs?: number,
    postRestartDelayMs?: number,
  ): Promise<void> {
    await this._ensureConnected();
    return this.connection!.restartDevice(deviceAddr, settleMs, postRestartDelayMs);
  }

  async readSerialNumbersInProgrammingMode(
    timeoutMs?: number,
  ): Promise<Array<{ serial: string; src: string }>> {
    await this._ensureConnected();
    return this.connection!.readSerialNumbersInProgrammingMode(timeoutMs);
  }

  // Real request, 2026-08-31: "can you confirm this yourself via a bus
  // query" (verifying a real ETS Factory Reset actually took effect) - the
  // same real mechanism ETS's own Factory Reset uses for its own final
  // verify step (docs/knx-device-write-protocol.md §9.3): ask by serial
  // "whatever address you're at, report it" - no guessing an address, and
  // no programming-mode button-press needed (unlike checkProgrammingMode()/
  // readSerialNumbersInProgrammingMode() above).
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
    reads: Array<{ objIdx: number; propId: number }>,
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
