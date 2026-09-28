/**
 * KnxConnection — base class for KNX bus communication.
 * Contains all shared protocol logic (CEMI, APDU, management sessions, etc.)
 * Transport-specific subclasses (UDP, USB) implement sendCEMI() and connect/disconnect.
 */

import EventEmitter from 'events';
import { logger } from './log.ts';
import { decodeDptBuffer } from './knx-dpt.ts';
import {
  MC,
  buildCEMI,
  TPCI,
  APCI_EXT,
  apduGroup,
  apduGroupRead,
  apduGroupWrite,
  apduConnected,
  apduRestartExtended,
  apduControl,
  apduMemoryRead,
  apduMemoryWrite,
  parseMemoryResponse,
  apduMemoryExtendedRead,
  apduMemoryExtendedWrite,
  parseMemoryExtendedResponse,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  apduFuncPropExtStateRead,
  apduPropertyDescriptionRead,
  apduAuthorizeRequest,
  apduIndividualAddressSerialNumberWrite,
  apduIndividualAddressSerialNumberRead,
  parseIndividualAddressSerialNumberResponse,
  apduSystemNetworkParamRead,
  parseSystemNetworkParamResponse,
  encodePhysical,
  eventType,
  type CemiFrame,
} from './knx-cemi.ts';
import {
  planDownload,
  isAbsSegmentProcedure,
  type PlanStep,
  type AbsSegSeed,
} from './knx-download-plan.ts';
import {
  getMaskProcedure,
  spliceAppSteps,
  orderByMergedOps,
  resolveProcedureSubType,
  type MaskOp,
} from './knx-mask-procedures.ts';

// Re-export from knx-dpt.ts
export { encodeDpt, decodeDptBuffer } from './knx-dpt.ts';

// Re-export from knx-cemi.ts
export {
  MC,
  APCI_EXT,
  buildCEMI,
  parseCEMI,
  encodePhysical,
  decodePhysical,
  encodeGroup,
  decodeGroup,
  apduGroup,
  apduConnected,
  apduConnectedFull,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  apduControl,
  apduIndividualAddressSerialNumberWrite,
  apduIndividualAddressSerialNumberRead,
  parseIndividualAddressSerialNumberResponse,
  apduSystemNetworkParamRead,
  parseSystemNetworkParamResponse,
  eventType,
} from './knx-cemi.ts';
export type {
  CemiFrame,
  IndividualAddressSerialNumberResponse,
  SystemNetworkParamResponse,
} from './knx-cemi.ts';
export {
  _apduGroupRead,
  _apduGroupWrite,
  _apduGroupResponse,
  _apduControl,
  _apduPropertyValueRead,
  _apduPropertyValueWrite,
  _TPCI,
  _APCI,
} from './knx-cemi.ts';

// ── Telegram type ──────────────────────────────────────────────────────────────

interface Telegram {
  timestamp: string;
  src: string;
  dst: string;
  type: string;
  raw_value: string;
  decoded: string;
  priority: string;
}

// ── Download step type ─────────────────────────────────────────────────────────

export interface DownloadStep {
  type: string;
  objIdx: number;
  propId: number;
  data?: Buffer;
  size?: number;
  offset?: number;
  // RelSegment (ABB/System-7-style) fields — see the RelSegment/WriteRelMem
  // handling in downloadDevice() below. mode is comma-joined when a segment
  // declares both "full" and "par" RelSegment for the same lsmIdx (e.g.
  // "full,par" on the WriteRelMem step); fill is the segment's fill byte.
  mode?: string;
  fill?: number;
  // `Verify="true"` on this app's `LdCtrlWriteRelMem` declaration. 🟡 Only
  // observed on the parameter-object step; not confirmed as a general rule
  // — see downloadDevice()'s use of this field.
  verify?: boolean;
  // `Verify` of the load-control step: false means the device sends no
  // confirmation for it, so the download must not wait for one. Absent =
  // wait (default). See ets-app.ts's LpWriteProp.verifyResponse.
  verifyResponse?: boolean;
  // `LdCtrlWriteProp StartElement`: the 1-based property-array index the
  // write starts at (absent = 1). PID_MCB_TABLE on the parameter object is
  // declared twice, the second with StartElement="2".
  startElement?: number;
  // `LdCtrlLoadImageProp Count`: how many array elements the property has,
  // i.e. how many the read-back covers (absent = not declared).
  count?: number;
  // AbsoluteSegment (MDT-style) load-procedure fields — see knx-download-plan.ts
  lsmIdx?: number;
  address?: number;
  // The enclosing `<LoadProcedure MergeId="N">`'s attribute (ets-app.ts's
  // LoadProcedures parsing) — the splice point knx-mask-procedures.ts uses
  // to place this step in the mask's Procedure template. Absent when the
  // declaration has no MergeId.
  mergeId?: number;
}

export interface DownloadProgress {
  msg: string;
  pct?: number;
  done?: boolean;
  // Marks the single "press the button" wait message so a client modal
  // (Cancel-only, auto-dismisses on resolve) can identify it — see
  // /bus/program-device's pre-flight in server/routes/bus.ts. Every later
  // message (found, ambiguous, written, confirmed, error) omits it.
  awaitingButton?: boolean;
  // Present only on the final "Download complete" message - count of
  // writes whose response never arrived. 0/absent means all confirmed;
  // see DownloadResult's doc comment.
  unconfirmedWrites?: number;
  // Marks a low-level protocol-step message (Unload/StartLoading/
  // WriteProp/mask-resolution/etc.) as debug detail rather than
  // operator-facing. Filtered client-side (App.tsx's program:progress
  // handler, gated on the "show debug" preference); the progress bar
  // still reacts to every message regardless. Absent/false for anything
  // a normal operator should always see.
  debug?: boolean;
  // Present on the final "Download complete" message - true when Restart
  // was withheld. See DownloadResult.restartWithheld's own doc comment.
  restartWithheld?: boolean;
}

/** Extra context needed to plan an AbsoluteSegment (MDT-style) download. */
export interface DownloadExtra {
  // Locates the project's saved `knx_master_<projectId>.xml`, the KNX
  // Master Data mask-Procedure ordering source (knx-mask-procedures.ts).
  // Falls back to each executor's hand-written sequencing when absent or
  // when the mask/procedure combination isn't found in master data — see
  // the fallback at each call site below.
  projectId?: string | number | null;
  paramBase?: number | null;
  /**
   * One parameter buffer per declared AbsoluteSegment. An application may
   * declare several parameter-carrying segments, each numbering its
   * offsets from zero; this says which buffer belongs at which address.
   * Omitted for RelSegment devices and for app models that predate
   * segment tracking, where paramBase/paramMem remain the single buffer.
   */
  paramMemBySegment?: Map<number, Buffer> | null;
  absSegData?: Record<number, AbsSegSeed>;
  appId?: string;
  resolvedBases?: Record<number, number>;
  // 'full' (default): LoadData's mode byte follows the model's declared
  // full/combined shape and every RelSegment/table write happens
  // unconditionally. 'partial': forces the Partial-Download mode byte
  // (0x00) and, before touching an object, reads its current bytes and
  // skips the Unload/StartLoading/LoadData/write/LoadCompleted cycle when
  // they already match the target image. Only proven against RelSegment/
  // ABB-style (System 7, mask 07B0) apps — the AbsoluteSegment (MDT-style)
  // branch always does a full replay regardless of this flag.
  mode?: 'full' | 'partial';
  // Object 3 (Group Object Table) content from buildGroupObjectTable()
  // (server/routes/knx-tables.ts). Written via the same "undeclared table"
  // mechanism as gaTable/assocTable (writeUndeclaredTable, below):
  // unconditional on 'full' mode, peek-and-skip-if-unchanged on 'partial'.
  // Real ETS's Full-Download trigger for Object 3 is only understood for
  // one app (property-27 checksum gate); another app writes it
  // unconditionally with no known predicate. Always writing on 'full' mode
  // is the conservative choice (never skips when uncertain).
  groupObjectTable?: Buffer | null;
  // 🔴 SPECULATIVE — see ParamModel.isSecureEnabled's doc comment
  // (ets-app.ts). Candidate signal for downloadDevice()'s memory-write-
  // service decision, alongside the mask-version read; not yet confirmed
  // as a general rule.
  isSecureEnabled?: boolean;
  // The app's `<Static><Options LineCoupler0912NewProgrammingStyle>`. Only an
  // explicit false selects a mask's legacy Load procedure when master data
  // declares the same procedure in more than one revision.
  lineCoupler0912NewProgrammingStyle?: boolean;
  // The app's `<ApplicationProgram PeiType>` ("0" = no PEI program content).
  // downloadDevice() refuses anything but "0" (undefined is treated as "0"):
  // apps declaring PEI content have never been downloaded with this code.
  peiType?: string;
  // Polled before each chunk of the memory-write loop. Returning true stops
  // writing: the in-progress object is left in an incomplete load state
  // (device keeps its previous content for it), already-finished objects
  // stay committed, and the result reports `aborted`. Lets Cancel act
  // inside a single long device write, not just between devices.
  shouldAbort?: () => boolean;
  // True when this physical unit has been downloaded to before (a download
  // on record AND matching serial). Decides how Object 5 (PEI Program) is
  // unloaded — see downloadDevice().
  hasPriorDownloadHistory?: boolean;
  // 🟡 See AppIndex.supportsExtendedMemoryServices's doc comment
  // (ets-app.ts). Checked first, ahead of PID_MCB_TABLE, in
  // downloadDevice()'s memory-write-service resolution.
  supportsExtendedMemoryServices?: boolean;
  // Cached `LastUsedAPDULength` from the project file (`Device.apdu_length`,
  // shared/types.ts). downloadDevice() always reads PID_MAX_APDULENGTH live
  // and uses this only as a fallback when that read gets no answer (stale
  // after a firmware/unit change; a disagreement is logged). null/undefined
  // when the device has never been downloaded to.
  cachedMaxApduLength?: number | null;
  // Byte ranges to write in 'partial' mode, replacing a read-then-diff
  // approach (reading each relmem object's full content first cost as much
  // wall-clock time as writing it, defeating the point). The caller
  // (resolvePendingWriteRanges(), server/routes/bus.ts) knows exactly what
  // changed from the edit log and resolves each change to a byte range via
  // the same layout logic used to build the target image (paramMemLayout
  // for objIdx 4, computeGroupObjectByte()'s offset formula for objIdx 3).
  // Keyed by objIdx; an object with no entry is skipped entirely — no read,
  // no write. GA/Association tables (objIdx 1/2) have no stable per-key
  // offset formula (a link change can shift every later entry), so
  // resolvePendingWriteRanges() marks those objects' full range dirty
  // whenever any ga_link change is pending. It also appends objIdx 4's
  // final byte whenever any other range is pending — a real ETS Partial
  // Download requirement (docs/knx-device-write-protocol.md §6.1).
  pendingWriteRanges?: Record<
    number,
    Array<{ offset: number; length: number }>
  >;
}

// ── Download result type ───────────────────────────────────────────────────────
// downloadDevice() completing without throwing means the protocol sequence
// ran to completion, not that every write was confirmed — a device may not
// answer an individual write (see the per-chunk write loop's comment). This
// surfaces a count and per-write detail of every unconfirmed write so
// callers can report "completed with N unconfirmed writes" rather than an
// unconditional success.
export interface DownloadResult {
  unconfirmedWrites: number;
  unconfirmedDetails: string[];
  // True when DownloadExtra.shouldAbort() fired mid-write. Never set for a
  // normal completion, even one with unconfirmed writes (a tolerated
  // outcome, not a deliberate stop).
  aborted?: boolean;
  // Real problems found by live verification reads - verification issues
  // should surface to callers directly rather than only being logged
  // internally. Currently populated by
  // the partial-mode pre-write PID_MCB_TABLE (P=27) checksum read (objIdx
  // 1/2/3) when it fails to get a live response - NOT the same thing as
  // `unconfirmedDetails` above (a write whose response never arrived): this
  // is a live READ that failed, before any decision about what to write was
  // even made. Always present (empty array, not undefined) so callers can
  // log/persist it unconditionally. koolenex has no DB persistence layer
  // for this yet - a caller wanting persisted issue counts/details would
  // add it at the route/DB layer, same shape as this array.
  verificationIssues: string[];
  // 🟢 True when the final pre-Restart verification (P=27
  // checksum on the RelSegment path, memory read-back on the AbsSegment
  // path - see downloadDevice()'s own comments for both) found a genuine
  // problem, a confirmed content MISMATCH or a persistent no-response
  // surviving retry, and Restart was deliberately WITHHELD rather than
  // sent anyway. A device not yet restarted is, by the Load State
  // Machine's own staged-write design, still running its OLD, untouched
  // application - safe to leave un-rebooted while an operator retries or
  // investigates, with nothing lost by not restarting. Callers should
  // treat this as a distinct, non-"ok" outcome rather than an ordinary
  // success - koolenex has no DB persistence layer for this yet, same
  // caveat as verificationIssues above.
  restartWithheld?: boolean;
  // Human-readable reasons for restartWithheld=true, one per failed
  // region/object - same detail level as verificationIssues' own entries
  // (often literally the same strings), kept separate so a caller doesn't
  // have to guess which of potentially several verificationIssues actually
  // triggered the withhold.
  restartWithheldReasons?: string[];
}

// ── Device info type ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  descriptor: string;
  address: string;
  serialNumber?: string;
  manufacturerId?: number;
  programVersion?: {
    manufacturerId: number;
    deviceType: number;
    appVersion: number;
  };
  orderInfo?: string;
  hardwareType?: string;
  firmwareRevision?: number;
  // PID_VERSION (device object, property 25): 2 bytes, raw hex.
  version?: string;
  // KNX Security Object's PID_SECURITY_MODE (OT=17/OI=1/P=51), raw hex.
  // Read for ETS-capture parity only; nothing here branches on it. See
  // readDeviceInfo()'s call site.
  securityMode?: string;
  error?: string;
}

// ── Scan progress type ─────────────────────────────────────────────────────────

export interface ScanProgress {
  address: string;
  reachable: boolean;
  descriptor: string | null;
  done: number;
  total: number;
}

// ── Management session helpers ──────────────────────────────────────────────────

interface ManagementSessionFns {
  sendData: (apciName: string, extraBuf?: Buffer | null) => Promise<void>;
  waitResponse: (
    apciNameExpected: string,
    ms?: number,
    /**
     * Extra test a frame must pass to count as the response. A frame with
     * the right APCI that fails it is ignored and the wait continues, so a
     * stale or retransmitted response from an earlier request can't be
     * mistaken for the answer to this one — see readRegionInSession().
     */
    accept?: (frame: CemiFrame) => boolean,
  ) => Promise<CemiFrame>;
  nextSeq: () => number;
}

// ── KnxConnection base class ───────────────────────────────────────────────────

export class KnxConnection extends EventEmitter {
  localAddr: string;
  connected: boolean;
  _scanAbort: boolean;
  /**
   * How long to wait for a memory read's response.
   *
   * Must exceed the KNX transport layer's own ack timeout (3000ms): a
   * transport connection allows only one unacknowledged numbered frame at a
   * time, so a lost T_Ack of the device's previous response makes it hold
   * the next response until it retransmits and gets acked — a full cycle
   * can take just over 3s by itself. 6s covers one full retransmit-and-
   * recover cycle at negligible cost on the fast path. A field rather than
   * a constant so tests can override it.
   */
  memoryResponseTimeoutMs = 6000;

  constructor() {
    super();
    this.localAddr = '0.0.0'; // physical addr (assigned by gateway or USB device)
    this.connected = false;
    this._scanAbort = false;
  }

  /**
   * cEMI source address for ordinary group communication (write()/read()),
   * deliberately distinct from `localAddr`, which device-management traffic
   * (property reads/writes, Restart, etc.) always uses.
   *
   * ETS sources device-management frames from `0.0.0` (KNX's reserved
   * "unconfigured device" address, collision-proof by construction)
   * regardless of what a gateway assigns for the session. A gateway-
   * assigned tunnel address is a normal, assignable individual address that
   * can collide with a real device on the same line, so `KnxIpConnection`
   * never adopts it as `localAddr`.
   *
   * Group communication is the exception: ETS sources its own outgoing
   * GroupValue_Write/Read from the gateway's assigned address, not `0.0.0`.
   * `KnxIpConnection` overrides this to return that address once one
   * exists; the base default (same as `localAddr`) is correct for USB,
   * which never assigns one.
   */
  get groupCommAddr(): string {
    return this.localAddr;
  }

  /**
   * Send a CEMI frame over the transport. Must be implemented by subclasses.
   * @param {Buffer} cemi - raw CEMI frame
   * @returns {Promise<void>}
   */
  sendCEMI(_cemi: Buffer): Promise<void> {
    throw new Error('sendCEMI() must be implemented by transport subclass');
  }

  /**
   * Send a CEMI frame via KNXnet/IP Routing (multicast) instead of the
   * normal Tunneling connection. Default throws (no Routing capability) -
   * only KnxIpConnection (knx-protocol.ts) overrides this; USB has no IP
   * path at all. See docs/knx-device-write-protocol.md §9.
   */
  sendCEMIViaRouting(_cemi: Buffer): Promise<void> {
    throw new Error('KNXnet/IP Routing is not available on this transport');
  }

  /** Disconnect from the bus. Must be implemented by transport subclass. */
  disconnect(): void {
    throw new Error('disconnect() must be implemented by transport subclass');
  }

  /**
   * Resolves once a previous disconnect() has actually released the
   * transport, not just asked it to close. disconnect() is deliberately
   * synchronous (fire-and-forget), but tearing a socket down takes real
   * time, and reconnecting to the same gateway must wait for it — see
   * KnxIpConnection's override. Default: nothing to wait for (instantaneous
   * disconnect, e.g. USB).
   */
  whenClosed(): Promise<void> {
    return Promise.resolve();
  }

  /** Called by transport subclass when a CEMI frame is received from the bus. */
  _onCEMI(cemi: CemiFrame): void {
    // Network-management broadcast services (individual-address discovery,
    // serial-number addressing) use group address 0/0/0, never a
    // legitimate application GA (docs/knx-device-write-protocol.md §9), so
    // such a reply routes to '_mgmt' (checkProgrammingMode(), serial-number
    // services), not 'telegram', despite being a GROUP-type frame.
    if (cemi.isGroup && cemi.dst === '0/0/0') {
      this.emit('_mgmt', cemi);
    } else if (cemi.isGroup && cemi.apciName) {
      const raw = cemi.apduData.toString('hex');
      const decoded = decodeDptBuffer(cemi.apduData);
      const telegram: Telegram = {
        timestamp: new Date().toISOString(),
        src: cemi.src,
        dst: cemi.dst,
        type: eventType(cemi.apciName),
        raw_value: raw,
        decoded,
        priority: 'low',
      };
      this.emit('telegram', telegram);
    } else if (!cemi.isGroup) {
      // Trace of the whole management exchange at LOG_LEVEL=debug, so a
      // timeout waiting for a specific APCI can be distinguished from the
      // device answering something else (error response, different
      // service, T_NAK).
      logger.debug('knx', 'Management frame received', {
        src: cemi.src,
        dst: cemi.dst,
        apciName: cemi.apciName,
        tpciType: cemi.tpciType,
        apdu: cemi.apdu.toString('hex'),
      });
      this.emit('_mgmt', cemi);
    }
  }

  // ── Group communication ───────────────────────────────────────────────────────

  async write(
    ga: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduGroupWrite(value, dpt);
    const cemi = buildCEMI(this.groupCommAddr, ga, apdu, true);
    await this.sendCEMI(cemi);
    return { ok: true, ga, value, dpt };
  }

  // Note: no request correlation ID — concurrent reads to the same GA could
  // consume each other's responses. KNX has no request/response correlation
  // at the group level, so this is a protocol-level limitation, not a bug.
  read(
    ga: string,
    timeoutMs: number = 4000,
  ): Promise<{ ga: string; value: string }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onTelegram = (tg: Telegram): void => {
        if (tg.dst === ga && tg.type === 'GroupValue_Response') {
          clearTimeout(timer);
          this.off('telegram', onTelegram);
          resolve({ ga, value: tg.decoded });
        }
      };
      const timer = setTimeout(() => {
        this.off('telegram', onTelegram);
        reject(new Error('Read timeout'));
      }, scaledMs(timeoutMs));
      this.on('telegram', onTelegram);
      const cemi = buildCEMI(this.groupCommAddr, ga, apduGroupRead(), true);
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        reject(err);
      });
    });
  }

  // ── Management session ────────────────────────────────────────────────────────

  async managementSession(
    deviceAddr: string,
    fn: (fns: ManagementSessionFns) => Promise<void>,
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    let seq = 0;

    const sendControl = async (
      tpciCode: number,
      s: number = 0,
    ): Promise<void> => {
      logger.debug('knx', 'Management control frame sent', {
        dst: deviceAddr,
        tpciCode: `0x${tpciCode.toString(16)}`,
        seq: s,
      });
      const apdu = apduControl(tpciCode, s);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
        priority: 'system',
      });
      await this.sendCEMI(cemi);
    };

    const sendData = async (
      apciName: string,
      extraBuf: Buffer | null = null,
    ): Promise<void> => {
      // Consumes and advances the session's sequence counter, same as
      // nextSeq(): every new connection-oriented data frame in a T_Connect
      // session needs its own number. If sendData() didn't advance it, a
      // later nextSeq()-based frame would collide and the device would
      // treat it as a retransmission — T_Ack'd but never re-processed,
      // indistinguishable from the device simply not responding.
      const thisSeq = seq++;
      logger.debug('knx', 'Management data frame sent', {
        dst: deviceAddr,
        apciName,
        seq: thisSeq,
      });
      const apdu = apduConnected(thisSeq, apciName, extraBuf);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
        priority: 'system',
      });
      await this.sendCEMI(cemi);
    };

    const waitResponse = (
      apciNameExpected: string,
      ms: number = timeoutMs,
      accept?: (frame: CemiFrame) => boolean,
    ): Promise<CemiFrame> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.off('_mgmt', handler);
          reject(
            new Error(`Management timeout waiting for ${apciNameExpected}`),
          );
        }, scaledMs(ms));
        const handler = (cemi: CemiFrame): void => {
          if (cemi.src !== deviceAddr || cemi.apciName !== apciNameExpected)
            return;
          // Keep listening rather than resolving with a frame the caller
          // has said isn't the one it asked for. Resolving and letting the
          // caller throw loses the real response that is still on its way.
          if (accept && !accept(cemi)) {
            logger.debug('knx', 'Ignoring a non-matching response', {
              src: cemi.src,
              apciName: cemi.apciName,
              apdu: cemi.apdu.toString('hex'),
            });
            return;
          }
          clearTimeout(timer);
          this.off('_mgmt', handler);
          resolve(cemi);
        };
        this.on('_mgmt', handler);
      });

    // Connection-oriented transport requires T_Ack of every numbered data
    // frame the device sends before issuing the next request, or the peer
    // desyncs and stops responding after the first exchange.
    const ackHandler = (cemi: CemiFrame): void => {
      if (cemi.src !== deviceAddr || cemi.tpciType !== 'DATA_CONNECTED') return;
      const rxSeq = (cemi.apdu[0]! >> 2) & 0xf;
      // Fire-and-forget; swallow a failed send (e.g. KNXnet/IP ACK timeout)
      // so it can't become an unhandled rejection. The awaiting read/verify
      // still surfaces the failure via its own waitResponse timeout, but
      // silently — a lost T_Ack stalls the peer for its full retransmission
      // timer, so log it explicitly.
      sendControl(TPCI.ACK, rxSeq).catch((err: Error) => {
        logger.warn('knx', 'Failed to send T_Ack - the peer will stall', {
          deviceAddr,
          seq: rxSeq,
          error: err.message,
        });
      });
    };
    this.on('_mgmt', ackHandler);

    // A KNXnet/IP router echoes every frame it transmits as an L_Data.con
    // whose confirm bit says whether it really reached the bus. A T_CONNECT
    // explicitly not confirmed means the device never saw the connection
    // request, so all following frames would target a connection it lacks.
    // Fail closed only on that explicit negative, never on silence — this
    // method is shared by every transport, and USB/loopback has no such echo.
    //
    // This is, specifically and only, how "no device answers at this
    // individual address" manifests at the link layer - nobody acknowledged
    // the frame, so the router's own confirmation comes back negative, not
    // a sign of a wiring or hardware fault. The thrown message leads with
    // "No device found at X" (matching the wording elsewhere in this
    // codebase, e.g. routes/bus.ts's "No device answered at ... -
    // re-addressing required") so it reads as the address-level signal it
    // actually is.
    let connectNacked: Error | null = null;
    const onConnectEcho = (cemi: CemiFrame): void => {
      if (
        cemi.msgCode !== MC.CON ||
        cemi.dst !== deviceAddr ||
        cemi.tpciType !== 'CONNECT' ||
        !cemi.confirmBit
      )
        return;
      connectNacked = new Error(`No device found at ${deviceAddr}.`);
    };
    this.on('_mgmt', onConnectEcho);
    await sendControl(TPCI.CONNECT);
    await delay(100);
    this.off('_mgmt', onConnectEcho);
    if (connectNacked) {
      this.off('_mgmt', ackHandler);
      throw connectNacked;
    }

    try {
      await fn({ sendData, waitResponse, nextSeq: () => seq++ });
    } finally {
      this.off('_mgmt', ackHandler);
      try {
        await sendControl(TPCI.DISCONNECT);
      } catch (_) {}
    }
  }

  // ── Ping ──────────────────────────────────────────────────────────────────────

  ping(
    gaAddresses: string[],
    deviceAddr: string,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      let done = false;
      const finish = (reachable: boolean, ga: string | null = null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        this.off('_mgmt', onMgmt);
        resolve({ reachable, ga });
      };

      const timer = setTimeout(() => finish(false), scaledMs(timeoutMs));

      const gaSet = new Set(gaAddresses);
      const onTelegram = (tg: Telegram): void => {
        if ((deviceAddr && tg.src === deviceAddr) || gaSet.has(tg.dst))
          finish(true, tg.dst);
      };
      this.on('telegram', onTelegram);

      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish(true, deviceAddr);
      };
      this.on('_mgmt', onMgmt);

      this.managementSession(
        deviceAddr,
        async ({ sendData, waitResponse }) => {
          await sendData('DeviceDescriptor_Read', null);
          await waitResponse('DeviceDescriptor_Response', timeoutMs - 200);
          finish(true, deviceAddr);
        },
        timeoutMs,
      ).catch(() => {});
    });
  }

  /**
   * Sends a connection-oriented device Restart (A_Restart): opens a fresh
   * T_Connect session to `deviceAddr`, reads identity, sends Restart,
   * waits, disconnects. Used by the address-write paths below, since a
   * device must be restarted after its address changes.
   *
   * Session shape mirrors real ETS's "Download Individual Address"
   * exchange: DeviceDescriptor_Read plus two property reads (P=56, P=11)
   * before Restart, not a bare Restart — a real device accepted a bare
   * Connect→Restart at the protocol level but didn't visibly reboot. Each
   * read here is best-effort (failure logged, not fatal); only the session
   * shape matters, not the property values.
   *
   * A visible reboot indicator (screen/IP refresh) is not a reliable
   * success signal — it's device/firmware-dependent (see
   * docs/knx-device-write-protocol.md §9.5).
   *
   * The ~3s Restart→Disconnect gap (postRestartDelayMs) matches a real ETS
   * capture. The pre-connect settle delay is a conservative guess, not
   * capture-calibrated — a device that just adopted a new address may not
   * be immediately ready for a T_Connect.
   *
   * Restart variant depends on the device's own live mask: System B
   * (`(mask & 0xff) === 0xb0`) sends the Extended `RestartReq`/`RestartResp`
   * pair on this same identity-confirm step; other families get the plain
   * Basic `A_Restart` with no response — same branch `useExtendedMemory`
   * uses elsewhere in this file.
   */
  async restartDevice(
    deviceAddr: string,
    settleMs: number = 300,
    postRestartDelayMs: number = 3000,
  ): Promise<void> {
    if (settleMs > 0) await delay(settleMs);
    await this.managementSession(
      deviceAddr,
      async ({ sendData, waitResponse, nextSeq }) => {
        const propRead = async (
          objIdx: number,
          propId: number,
        ): Promise<void> => {
          try {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            });
            await this.sendCEMI(cemi);
            await waitResponse('OTHER', 2000);
          } catch (e) {
            logger.warn(
              'knx',
              'restartDevice: identity read before Restart failed (continuing anyway)',
              { deviceAddr, objIdx, propId, error: (e as Error).message },
            );
          }
        };
        // Same signal `useExtendedMemory` elsewhere in this file uses
        // (device mask low byte 0xB0 = System B family) - see this
        // method's own doc comment above for why it's needed here too.
        let deviceMask: number | null = null;
        try {
          const respP = waitResponse('DeviceDescriptor_Response', 2000);
          await sendData('DeviceDescriptor_Read');
          const resp = await respP;
          deviceMask =
            resp.apduData.length >= 2
              ? (resp.apduData[0]! << 8) | resp.apduData[1]!
              : null;
        } catch (e) {
          logger.warn(
            'knx',
            'restartDevice: DeviceDescriptor_Read before Restart failed (continuing anyway - Restart variant will default to Basic)',
            { deviceAddr, error: (e as Error).message },
          );
        }
        await propRead(0, 56);
        await propRead(0, 11);
        const useExtendedRestart =
          deviceMask !== null && (deviceMask & 0xff) === 0xb0;
        if (useExtendedRestart) {
          const seq = nextSeq();
          const apdu = apduRestartExtended(seq);
          const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
            priority: 'system',
          });
          const respP = waitResponse('Restart_Extended_Response', 3000);
          await this.sendCEMI(cemi);
          try {
            await respP;
            logger.info(
              'knx',
              'restartDevice: RestartResp received (Extended Restart, System B device)',
              { deviceAddr },
            );
          } catch {
            logger.warn(
              'knx',
              'restartDevice: No RestartResp within 3s on Extended Restart - falling back to a settle delay',
              { deviceAddr },
            );
          }
          // A RestartResp only means the device ACCEPTED the restart request,
          // not that it has finished rebooting. Wait the full settle delay on
          // success as well as on timeout: callers resume sending straight
          // after this returns (address programming, the early restart of a
          // Full Download), and frames sent into a device that is still
          // rebooting are silently lost, which can leave the following
          // session without a valid connection.
          if (postRestartDelayMs > 0) await delay(postRestartDelayMs);
        } else {
          await sendData('Restart');
          if (postRestartDelayMs > 0) await delay(postRestartDelayMs);
        }
      },
    );
  }

  // ── Individual address programming ────────────────────────────────────────────

  /**
   * Write an individual address to whichever device is in physical
   * programming mode (button held) — A_IndividualAddress_Write, the
   * write-side counterpart to checkProgrammingMode()'s
   * A_IndividualAddress_Read. Same wire format as the other network-
   * management broadcast services (GROUP-type frame to 0/0/0 at System
   * priority — see checkProgrammingMode()); an individual-type frame at
   * ordinary/Low priority is silently ignored by a real device.
   *
   * Restarts the device at its new address afterward (real ETS does this
   * after every address write, not just content downloads) — see
   * restartDevice(). Restart failure doesn't fail the call: the address
   * write itself has no response to confirm and is already considered
   * succeeded; a failed restart surfaces via `restarted: false`.
   */
  async programIA(
    newAddr: string,
    _timeoutMs: number = 5000,
  ): Promise<{ ok: boolean; newAddr: string; restarted: boolean }> {
    if (!this.connected) throw new Error('Not connected');
    const addrBuf = encodePhysical(newAddr);
    const apdu = apduGroup('PhysicalAddress_Write', 0, addrBuf);
    const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
      priority: 'system',
    });
    await this.sendCEMI(cemi);
    let restarted = true;
    try {
      await this.restartDevice(newAddr);
    } catch (e) {
      restarted = false;
      logger.warn('knx', 'programIA: restart after address write failed', {
        newAddr,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return { ok: true, newAddr, restarted };
  }

  /**
   * Broadcast A_IndividualAddress_Read (APCI PhysicalAddress_Read) and wait
   * for a device in physical programming mode to answer with
   * A_IndividualAddress_Response. The read-side counterpart to programIA()
   * above; complementary to, not the same mechanism as, the serial-number
   * addressing below.
   *
   * GROUP-type frame to `0/0/0` at System priority (ctrl1 `0xB0`) — see
   * docs/knx-device-write-protocol.md §9 for the wire format.
   *
   * KNX precondition, not enforced here: only one device should be in
   * programming mode at a time. If more than one is, only the first
   * response is surfaced (multiple devices reply cleanly with no collision,
   * but this returns whichever arrives first and stops listening).
   */
  checkProgrammingMode(
    timeoutMs: number = 3000,
  ): Promise<{ address: string | null }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onMgmt = (cemi: CemiFrame): void => {
        // Logs every incoming _mgmt frame during the wait window, not just
        // matches — useful for diagnosing against different hardware.
        logger.info('knx', 'checkProgrammingMode: _mgmt frame seen', {
          src: cemi.src,
          apciName: cemi.apciName,
          apduHex: cemi.apdu.toString('hex'),
        });
        if (cemi.apciName !== 'PhysicalAddress_Response') return;
        clearTimeout(timer);
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve({ address: cemi.src });
      };
      const timer = setTimeout(() => {
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve({ address: null });
      }, scaledMs(timeoutMs));
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('PhysicalAddress_Read');
      // GROUP-type frame to 0/0/0 at System priority (ctrl1 0xB0) — see
      // this function's doc comment.
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      const send = (): void => {
        logger.info('knx', 'checkProgrammingMode: sending broadcast', {
          cemiHex: cemi.toString('hex'),
        });
        this.sendCEMI(cemi).catch((err: Error) => {
          clearTimeout(timer);
          clearInterval(repeat);
          this.off('_mgmt', onMgmt);
          reject(err);
        });
      };
      // A single one-shot broadcast only catches a device already in
      // programming mode at that instant. Re-sent every 3s for the whole
      // wait window to match real ETS's own repeat cadence
      // (docs/knx-device-write-protocol.md §9.4), so a device entering
      // programming mode partway through the window still gets caught.
      send();
      const repeat = setInterval(send, 3000);
    });
  }

  /**
   * Broadcast A_SystemNetworkParameter_Read for PID_SERIAL_NUMBER (object
   * type 0 = Device) and collect every response for the whole `timeoutMs`
   * window — the KNX network-management procedure
   * NM_Read_SerialNumber_By_ProgrammingMode: query the serial number of
   * whichever device(s) are in physical programming mode, no prior
   * knowledge needed. Unlike checkProgrammingMode(), this deliberately does
   * not stop on the first match: multiple devices reply cleanly with no
   * collision, and collecting all of them matters because two blank
   * devices share the same factory-default address (checkProgrammingMode()
   * can't tell them apart) but always have unique serials. Duplicates from
   * normal frame repetition are de-duplicated by serial.
   *
   * GROUP-type frame to `0/0/0` at System priority (ctrl1 `0xB0`), same
   * framing as checkProgrammingMode() and the address-assignment services
   * below — see docs/knx-device-write-protocol.md §9.
   */
  readSerialNumbersInProgrammingMode(
    timeoutMs: number = 3000,
  ): Promise<Array<{ serial: string; src: string }>> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const found = new Map<string, string>(); // serial hex -> src
      const onMgmt = (cemi: CemiFrame): void => {
        if (cemi.apdu.length < 2) return;
        const fullApci = ((cemi.apdu[0]! & 0x03) << 8) | cemi.apdu[1]!;
        if (fullApci !== APCI_EXT.SystemNetworkParam_Response) return;
        const resp = parseSystemNetworkParamResponse(cemi);
        if (resp.objectType !== 0 || resp.pid !== 11 || resp.value.length < 6)
          return;
        found.set(resp.value.slice(0, 6).toString('hex'), cemi.src);
      };
      const timer = setTimeout(() => {
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve([...found.entries()].map(([serial, src]) => ({ serial, src })));
      }, scaledMs(timeoutMs));
      this.on('_mgmt', onMgmt);
      const apdu = apduSystemNetworkParamRead(0, 11, 1);
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      const send = (): void => {
        this.sendCEMI(cemi).catch((err: Error) => {
          clearTimeout(timer);
          clearInterval(repeat);
          this.off('_mgmt', onMgmt);
          reject(err);
        });
      };
      // Same as checkProgrammingMode(): a one-shot broadcast only catches a
      // device already in programming mode at that instant. Re-sent every
      // 3s for the whole wait window to match real ETS's repeat cadence.
      send();
      const repeat = setInterval(send, 3000);
    });
  }

  // ── Individual address by serial number ───────────────────────────────────────
  // A_IndividualAddressSerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4):
  // assigns or queries a device's individual address via its 6-byte KNX
  // serial number, no physical programming-button press needed (unlike
  // programIA() above). GROUP-type frame to 0/0/0 at System priority — see
  // docs/knx-device-write-protocol.md §9. UNNUMBERED: no TPCI sequence, no
  // managementSession()/T_Connect — broadcast destinations carry no
  // transport-layer connection to ack/sequence against.

  /**
   * Broadcast A_IndividualAddressSerialNumber_Write — assigns `newAddr` to
   * whichever device matches `serial` (6 bytes). Fire-and-forget at the
   * protocol level (no response); call `readIndividualAddressBySerial()`
   * afterward to verify, or use `assignIndividualAddressBySerial()` which
   * does both.
   */
  async writeIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
  ): Promise<{ ok: boolean }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduIndividualAddressSerialNumberWrite(serial, newAddr);
    const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
      priority: 'system',
    });
    await this.sendCEMI(cemi);
    return { ok: true };
  }

  /**
   * Broadcast A_IndividualAddressSerialNumber_Read and wait for the device
   * whose serial matches to answer. Not correlated by source address
   * (unknown ahead of time — the whole point of addressing by serial);
   * matched by the serial embedded in the reply payload and by the exact
   * 10-bit response APCI (not the generic 'OTHER' bucket several extended
   * services share) to avoid mistaking an unrelated exchange for the
   * response. Returns null on timeout.
   */
  readIndividualAddressBySerial(
    serial: Buffer,
    timeoutMs: number = 3000,
  ): Promise<{ address: string } | null> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onMgmt = (cemi: CemiFrame): void => {
        if (cemi.apdu.length < 2) return;
        const fullApci = ((cemi.apdu[0]! & 0x03) << 8) | cemi.apdu[1]!;
        if (fullApci !== APCI_EXT.IndividualAddressSerialNumber_Response)
          return;
        const resp = parseIndividualAddressSerialNumberResponse(cemi);
        if (resp.serial.equals(serial)) {
          clearTimeout(timer);
          this.off('_mgmt', onMgmt);
          resolve({ address: resp.address });
        }
      };
      const timer = setTimeout(() => {
        this.off('_mgmt', onMgmt);
        resolve(null);
      }, scaledMs(timeoutMs));
      this.on('_mgmt', onMgmt);
      const apdu = apduIndividualAddressSerialNumberRead(serial);
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        reject(err);
      });
    });
  }

  /**
   * Write-then-read-verify, mirroring Calimero's
   * ManagementProceduresImpl.writeAddress() procedure: broadcast the
   * Write, then broadcast a Read to verify, retried over a deadline rather
   * than a single attempt. No precondition check that the device isn't
   * already addressed — this can re-address an already-configured device
   * too, not just commission a blank one.
   *
   * Restarts the device at its new address, but only once the read-back
   * has confirmed the write landed — see restartDevice(). Skipped when
   * verification failed/timed out, since restarting at an address the
   * device may not have adopted isn't meaningful. Restart failure doesn't
   * fail the call, surfaced via `restarted: false` (same as programIA()).
   */
  async assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs: number = 3000,
    // A single read-back attempt can fail against a factory-reset device
    // even though the write landed — the device isn't ready to answer the
    // immediate verification broadcast within that window (a later,
    // independent request finds it already at the new address). Only the
    // read is retried, not the write. Separate from `timeoutMs` so each
    // individual read's timeout can stay short while retrying overall for
    // longer (same pattern as routes/bus.ts's waitForDeviceBackUp()).
    verifyDeadlineMs: number = 20000,
  ): Promise<{
    ok: boolean;
    verified: boolean;
    address: string | null;
    restarted: boolean;
    /** True when the pre-check found the device already at `newAddr`: the
     *  write was skipped ("don't write what is already correct"). `false`
     *  whenever a write was attempted, including when the pre-check itself
     *  failed. */
    alreadyCorrect: boolean;
    /** Set (and NO write attempted) when a DIFFERENT device already answers
     *  at `newAddr` - see `_probeAddressOccupant()`. `serial` is that
     *  device's hex serial, or null when something answered but its serial
     *  could not be read. Absent in every other outcome. */
    occupiedBy?: { serial: string | null };
  }> {
    let alreadyCorrect = false;
    let currentAddress: string | null = null;
    try {
      const current = await this.readIndividualAddressBySerial(
        serial,
        timeoutMs,
      );
      currentAddress = current?.address ?? null;
      if (currentAddress === newAddr) alreadyCorrect = true;
    } catch (e) {
      logger.warn(
        'knx',
        'assignIndividualAddressBySerial: pre-check read failed - falling through to write-then-verify',
        { newAddr, error: e instanceof Error ? e.message : String(e) },
      );
    }
    let chk: { address: string } | null = null;
    if (alreadyCorrect) {
      chk = { address: newAddr };
    } else {
      // Never write an address onto a bus that already has a DIFFERENT device
      // answering there: two devices sharing one individual address means
      // every later point-to-point connection reaches whichever answers first
      // (or both, garbled), including a download. Only reached when a write
      // is actually about to happen, so the normal case pays nothing.
      const occupant = await this._probeAddressOccupant(
        newAddr,
        serial,
        currentAddress,
      );
      if (occupant) {
        logger.warn(
          'knx',
          'assignIndividualAddressBySerial: refusing to write - a different device already answers at the target address',
          {
            newAddr,
            occupantSerial: occupant.serial,
            ourSerial: serial.toString('hex'),
            ourCurrentAddress: currentAddress,
          },
        );
        return {
          ok: false,
          verified: false,
          address: currentAddress,
          restarted: false,
          alreadyCorrect: false,
          occupiedBy: occupant,
        };
      }
      await this.writeIndividualAddressBySerial(serial, newAddr);
      const verifyStart = Date.now();
      let attempt = 0;
      while (!chk && Date.now() - verifyStart < scaledMs(verifyDeadlineMs)) {
        attempt++;
        if (attempt > 1) await delay(2000);
        chk = await this.readIndividualAddressBySerial(serial, timeoutMs);
      }
    }
    const verified = chk?.address === newAddr;
    let restarted = false;
    if (verified) {
      try {
        await this.restartDevice(newAddr);
        restarted = true;
      } catch (e) {
        logger.warn(
          'knx',
          'assignIndividualAddressBySerial: restart after address write failed',
          { newAddr, error: e instanceof Error ? e.message : String(e) },
        );
      }
    }
    return {
      ok: true,
      verified,
      address: chk?.address ?? null,
      restarted,
      alreadyCorrect,
    };
  }

  /**
   * Is a DIFFERENT device already answering at `addr`? Called only once a
   * write of `addr` is about to happen (the device with `ourSerial` is not
   * already there).
   *
   * Returns null (safe to write) when nothing answers a DeviceDescriptor_Read
   * at `addr`, or when the answering device turns out to be ours. Returns
   * `{ serial }` when the occupant is definitively another device: its serial
   * was read and differs from ours - or, when its serial cannot be read, when
   * the serial lookup already told us OUR device sits at a different address,
   * so whatever answers here cannot be it. The one deliberately NOT refused
   * case - something answers, its serial is unreadable AND our own location
   * is unknown - is genuinely ambiguous, so it falls through to the ordinary
   * write-then-verify with a warning instead of refusing on a guess.
   */
  private async _probeAddressOccupant(
    addr: string,
    ourSerial: Buffer,
    ourCurrentAddress: string | null,
  ): Promise<{ serial: string | null } | null> {
    const probe = await this._probeSingle(addr, 2000);
    if (!probe) return null;

    let occupantSerial = null as string | null; // assigned in the callback below
    try {
      await this.managementSession(addr, async ({ waitResponse, nextSeq }) => {
        const seq = nextSeq();
        const apdu = apduPropertyValueRead(seq, 0, 11);
        await this.sendCEMI(
          buildCEMI(this.localAddr, addr, apdu, false, { priority: 'system' }),
        );
        const res = await waitResponse('OTHER', 2000);
        const data = res?.apduData;
        if (data && data.length >= 10)
          occupantSerial = data.subarray(4, 10).toString('hex');
      });
    } catch (e) {
      logger.warn(
        'knx',
        "_probeAddressOccupant: could not read the occupant's serial",
        { addr, error: e instanceof Error ? e.message : String(e) },
      );
    }

    const ours = ourSerial.toString('hex');
    if (occupantSerial === ours) return null;
    if (occupantSerial) return { serial: occupantSerial };
    if (ourCurrentAddress && ourCurrentAddress !== addr)
      return { serial: null };
    logger.warn(
      'knx',
      '_probeAddressOccupant: something answers at the target address but its serial is unreadable and our own location is unknown - not refusing on a guess',
      { addr },
    );
    return null;
  }

  // ── Application download ──────────────────────────────────────────────────────

  /**
   * Read `length` bytes of device memory starting at `address`, over the
   * bus. Non-destructive: issues A_Memory_Read requests only. Used by the
   * read-first validation flow to compare device memory against a computed
   * image.
   *
   * Default chunk size 228, matching the real MEM_CHUNK used for writes
   * (see downloadDevice()). An `rc=252` device error means the requested
   * length exceeds a table's real allocated size on the device — not a
   * chunk-size problem; `readRegionInSession`'s `Math.min(chunkSize, length
   * - off)` already clamps to a small region's real length regardless of
   * chunk size.
   */
  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 228,
    onChunk?: (bytesRead: number) => void,
    // Cached `LastUsedAPDULength` from the project file (see
    // `DownloadExtra.cachedMaxApduLength`), preferred over a live
    // property-56 read when available (no bus round-trip needed).
    // undefined/null falls back to the live read.
    cachedMaxApduLength?: number | null,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    let out: Buffer = Buffer.alloc(length);
    await this.managementSession(deviceAddr, async (fns) => {
      const useExtendedMemory = await this._resolveMemoryServiceForSession(
        fns,
        deviceAddr,
      );
      const maxApduLengthValue =
        cachedMaxApduLength != null
          ? cachedMaxApduLength
          : await this._resolveMaxApduLength(fns, deviceAddr);
      out = await this.readRegionInSession(
        fns,
        deviceAddr,
        address,
        length,
        chunkSize,
        useExtendedMemory,
        maxApduLengthValue,
        onChunk,
      );
    });
    return out;
  }

  /**
   * Read several memory regions of one device inside a SINGLE management
   * session (one Connect/Disconnect for the whole batch), rather than opening
   * a fresh connection-oriented session per region. Mirrors how a real
   * download drives all of a device's transfers over one session. Returns one
   * Buffer per requested region, in order. onChunk, if given, is called after
   * every chunk across every region with the cumulative bytes read so far -
   * the total length across all regions is known upfront by the caller
   * (it's the same computed-image size used for "expected"), so real
   * progress reporting is possible without waiting for the whole read to
   * finish.
   *
   * Default chunk size 228 - see readMemory()'s own comment for the real
   * story: an early rc=252 rejection at this size traced back to a stale
   * device id (wrong computed table length, not the chunk size itself).
   */
  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
    chunkSize: number = 228,
    onChunk?: (bytesRead: number) => void,
    // See readMemory()'s identical parameter for the real evidence/doc.
    cachedMaxApduLength?: number | null,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const results: Buffer[] = [];
    let cumulative = 0;
    await this.managementSession(deviceAddr, async (fns) => {
      const useExtendedMemory = await this._resolveMemoryServiceForSession(
        fns,
        deviceAddr,
      );
      const maxApduLengthValue =
        cachedMaxApduLength != null
          ? cachedMaxApduLength
          : await this._resolveMaxApduLength(fns, deviceAddr);
      for (const r of regions)
        results.push(
          await this.readRegionInSession(
            fns,
            deviceAddr,
            r.address,
            r.length,
            chunkSize,
            useExtendedMemory,
            maxApduLengthValue,
            onChunk
              ? (n) => {
                  cumulative += n;
                  onChunk(cumulative);
                }
              : undefined,
          ),
        );
    });
    return results;
  }

  /**
   * Determines which memory-READ service (legacy A_Memory_Read vs
   * A_MemoryExtended_Read) a device requires, from its real mask version
   * (A_DeviceDescriptor_Read) — mirrors the same gating used for
   * WriteRelMem's memory WRITES (see downloadDevice()).
   *
   * A mask `0x07B0` ("System B") device can silently fail a legacy read at
   * an in-range address (zero-byte response) even though it fits in 16
   * bits; ETS uses the extended service for reads on this mask family just
   * as much as writes. Same fallback as the write path: if the mask can't
   * be determined, fall back to the address-size heuristic.
   */
  private async _resolveMemoryServiceForSession(
    fns: ManagementSessionFns,
    deviceAddr: string,
  ): Promise<boolean | null> {
    const { waitResponse, sendData } = fns;
    try {
      // Connection-oriented, like every other request in this session — a
      // device in the connected transport state is not obliged to serve a
      // connectionless T_Data_Individual DeviceDescriptor_Read, and at
      // least one real Zennio unit doesn't.
      const respP = waitResponse('DeviceDescriptor_Response', 3000);
      await sendData('DeviceDescriptor_Read');
      const resp = await respP;
      const mask =
        resp.apduData.length >= 2
          ? (resp.apduData[0]! << 8) | resp.apduData[1]!
          : null;
      if (mask == null) return null;
      const useExtendedMemory = (mask & 0xff) === 0xb0;
      logger.info(
        'knx',
        `DeviceDescriptor mask=0x${mask.toString(16).padStart(4, '0')} ` +
          `(${useExtendedMemory ? 'SystemB family - extended memory reads' : 'legacy family - address-size heuristic applies'})`,
        { deviceAddr },
      );
      return useExtendedMemory;
    } catch (_e) {
      logger.info(
        'knx',
        'No DeviceDescriptor_Response received for memory read - falling back to address-size heuristic',
        { deviceAddr },
      );
      return null;
    }
  }

  /**
   * Reads a device's `PID_MAX_APDULENGTH` (property 56, objIdx 0, Device
   * Object — `PID-0-56` "Max. APDU-Length" in KNX Master Data), the
   * per-device basis for a safe A_Memory_Read/Write or
   * A_MemoryExtended_Read/Write chunk size. See `maxChunkFromApduLength()`
   * for the derivation. restartDevice() reads the same property but
   * discards the value; this is the value-preserving read for chunk sizing.
   */
  private async _resolveMaxApduLength(
    fns: ManagementSessionFns,
    deviceAddr: string,
  ): Promise<number | null> {
    const { waitResponse, nextSeq } = fns;
    try {
      const seq = nextSeq();
      const apdu = apduPropertyValueRead(seq, 0, 56);
      const respP = waitResponse('OTHER', 3000);
      await this.sendCEMI(
        buildCEMI(this.localAddr, deviceAddr, apdu, false, {
          priority: 'system',
        }),
      );
      const res = await respP;
      const data = res?.apduData;
      // 4-byte PropertyValue_Response header (objIdx, propId, count,
      // startIndex) + value; PID_MAX_APDULENGTH is PDT-4 (2-byte unsigned).
      if (!data || data.length < 6) return null;
      const value = data.readUInt16BE(4);
      logger.info('knx', `PID_MAX_APDULENGTH=${value}`, { deviceAddr });
      return value;
    } catch (_e) {
      logger.info(
        'knx',
        'No PID_MAX_APDULENGTH response - falling back to default chunk size',
        { deviceAddr },
      );
      return null;
    }
  }

  /**
   * Read one memory region using an already-open management session. The
   * device echoes the requested address in every A_Memory_Response; we reject
   * any response whose address does not match the chunk we asked for, so a
   * stale or reordered response can never be copied into the wrong offset of
   * the read-back buffer.
   */
  private async readRegionInSession(
    fns: ManagementSessionFns,
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number,
    useExtendedMemory: boolean | null,
    maxApduLengthValue: number | null,
    onChunk?: (bytesJustRead: number) => void,
  ): Promise<Buffer> {
    const { waitResponse, nextSeq } = fns;
    const out = Buffer.alloc(length);
    let off = 0;
    // A ceiling learned from this device refusing a request size, so the
    // rest of the region is asked for at a size it has already shown it
    // will serve — avoids re-discovering the same refusal (a 3s timeout)
    // on every chunk.
    let sizeCeiling = Infinity;
    while (off < length) {
      const seq = nextSeq();
      const wantAddr = address + off;
      // A_Memory_Read only carries a 16-bit address. A resolved relmem base
      // (via PID 7) can legitimately land above 0xFFFF; using the legacy
      // service there truncates to the wrong (low) address instead of
      // erroring, so use A_MemoryExtended_Read (24-bit address space)
      // whenever the address doesn't fit in 16 bits. Some legacy/ABB-style
      // devices only answer the legacy service, so devices whose address
      // fits keep using it.
      //
      // Gating reads on mask version too (mirroring WriteRelMem's
      // mask-0x07B0-requires-extended write finding) was tried and
      // reverted: forcing extended reads on a real HDL device turned a
      // prompt zero-byte legacy refusal into a full 3s timeout with no
      // response, and risked regressing devices whose legacy reads already
      // work. Address-size heuristic only, pending further evidence.
      const useExtended = wantAddr > 0xffff;
      void useExtendedMemory; // resolved but not yet trusted for reads - see above
      // Legacy A_Memory_Read packs its count into a 6-bit APCI field
      // (`count & 0x3f`, max 63). Once a prior short response left `off` at
      // a non-round offset, `n` could land at 64, which wraps to `0` — a
      // request for literally zero bytes that the device correctly answers
      // with nothing. Cap `n` to each service's real wire-format limit
      // before building the request, not just after interpreting the
      // response.
      //
      // Prefer the device's own PID_MAX_APDULENGTH-derived ceiling over the
      // protocol's theoretical max when known — real devices can support
      // meaningfully less. See `maxChunkFromApduLength()`. Falls back to
      // the protocol-theoretical-max heuristic when the value is unknown.
      const protocolMaxN = useExtended ? 255 : 63;
      const maxN =
        maxApduLengthValue != null
          ? Math.min(
              protocolMaxN,
              maxChunkFromApduLength(maxApduLengthValue, useExtended),
            )
          : protocolMaxN;
      let n = Math.min(chunkSize, length - off, maxN, sizeCeiling);
      // A legacy A_Memory_Read's address field can only represent up to
      // 0xFFFF - if this chunk's own end would cross that boundary, clamp
      // it here so it stays entirely below 0xFFFF; the remaining bytes
      // fall into the next loop iteration, where wantAddr > 0xffff then
      // naturally selects the extended service instead, with no special-
      // casing needed there. Without this, a chunk that starts just under
      // 0xFFFF but whose count pushes its end past it is a request the
      // legacy service's 16-bit address genuinely cannot represent - real
      // hardware confirmed correctly refusing exactly this with a
      // zero-byte response (0xFFFA start, 63-byte count -> 0x10039 end)
      // rather than serving it.
      if (!useExtended && wantAddr + n > 0x10000) n = 0x10000 - wantAddr;
      if (useExtended) {
        const apdu = apduMemoryExtendedRead(seq, n, wantAddr);
        const respP = waitResponse(
          'MemoryExtended_Read_Response',
          this.memoryResponseTimeoutMs,
          (f) => parseMemoryExtendedResponse(f).address === wantAddr,
        );
        await this.sendCEMI(
          buildCEMI(this.localAddr, deviceAddr, apdu, false, {
            priority: 'system',
          }),
        );
        const frame = await respP;
        const {
          returnCode,
          address: gotAddr,
          data,
        } = parseMemoryExtendedResponse(frame);
        if (returnCode !== 0)
          throw new Error(
            `MemoryExtended read error rc=${returnCode} at 0x${wantAddr.toString(16)}`,
          );
        // waitResponse only resolves on the requested address, so this is
        // an invariant guard against silent buffer corruption if a future
        // caller forgets the address predicate.
        if (gotAddr !== wantAddr)
          throw new Error(
            `MemoryExtended_Read_Response address mismatch: requested 0x${wantAddr.toString(
              16,
            )}, device answered 0x${gotAddr.toString(16)}`,
          );
        // A device can answer a well-formed request with a genuinely short
        // response (ACKed, just incomplete). Advance `off` by what was
        // actually received, not what was requested — otherwise the
        // shortfall silently stays zero-filled and the remainder is never
        // retried.
        const gotLen = Math.min(data.length, n);
        if (gotLen === 0)
          throw new Error(
            `MemoryExtended_Read_Response returned zero bytes at 0x${wantAddr.toString(16)} (requested ${n})`,
          );
        data.copy(out, off, 0, gotLen);
        onChunk?.(gotLen);
        off += gotLen;
        continue;
      }
      /** One legacy A_Memory_Read request/response round trip. */
      const legacyRead = async (
        count: number,
        s: number,
      ): Promise<CemiFrame> => {
        const apdu = apduMemoryRead(s, count, wantAddr);
        const respP = waitResponse(
          'Memory_Response',
          this.memoryResponseTimeoutMs,
          (f) => {
            const got = parseMemoryResponse(f).address;
            if (got !== wantAddr) wrongAddresses.add(got);
            return got === wantAddr;
          },
        );
        await this.sendCEMI(
          buildCEMI(this.localAddr, deviceAddr, apdu, false, {
            priority: 'system',
          }),
        );
        return respP;
      };

      logger.debug('knx', 'A_Memory_Read', {
        deviceAddr,
        address: `0x${wantAddr.toString(16)}`,
        count: n,
        seq,
        maxApduLengthValue,
      });

      // Addresses the device answered with that weren't the one asked for.
      // A response failing the predicate is ignored rather than resolving
      // the wait (see waitResponse) — usually a retransmission of the
      // previous chunk — but a device answering only wrong addresses needs
      // a different diagnosis than one that says nothing at all.
      const wrongAddresses = new Set<number>();
      const describeRead = (count: number): string =>
        `A_Memory_Read of ${count} byte(s) at 0x${wantAddr.toString(16)} on ${deviceAddr}` +
        ` (max APDU ${maxApduLengthValue ?? 'unknown'})`;

      // A device refusing a request size may answer with zero bytes or say
      // nothing at all — same refusal, same answer: ask smaller, and if
      // that works, use the smaller size for the rest of the region
      // (sizeCeiling). The ladder ends at one byte: a device that ignores a
      // single-byte read isn't refusing a size, it isn't serving this
      // address over this service at all.
      let frame: CemiFrame | null = null;
      let requested = n;
      const attempts: string[] = [];
      for (const size of [n, LEGACY_RETRY_CHUNK, 1].filter(
        (v, i) => i === 0 || v < n,
      )) {
        try {
          frame = await legacyRead(size, size === n ? seq : nextSeq());
          if (size < n) {
            logger.info(
              'knx',
              `${deviceAddr} answered a ${size}-byte read at 0x${wantAddr.toString(16)} after ignoring ${n} - using ${size} for the rest of this region`,
              { deviceAddr, wantAddr: wantAddr.toString(16), originalN: n },
            );
            sizeCeiling = size;
          }
          requested = size;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          attempts.push(`${describeRead(size)}: ${msg}`);
          // Only silence is a refusal worth asking smaller about; any
          // other failure is real and must surface as itself.
          if (!msg.includes('Management timeout')) {
            throw new Error(attempts.join('; '), { cause: err });
          }
          logger.info(
            'knx',
            `No Memory_Response to a ${size}-byte read at 0x${wantAddr.toString(16)}`,
            { deviceAddr, wantAddr: wantAddr.toString(16) },
          );
        }
      }
      if (!frame) {
        const why = wrongAddresses.size
          ? `the device answered only with other addresses (${[
              ...wrongAddresses,
            ]
              .map((a) => `0x${a.toString(16)}`)
              .join(', ')}), never the one requested`
          : 'the device answers DeviceDescriptor_Read but not A_Memory_Read at this address, so this is not a request-size limit';
        throw new Error(`${attempts.join('; ')} - ${why}`);
      }
      const { address: gotAddr, data } = parseMemoryResponse(frame);
      // Same invariant guard as the extended branch above.
      if (gotAddr !== wantAddr)
        throw new Error(
          `Memory_Response address mismatch: requested 0x${wantAddr.toString(
            16,
          )}, device answered 0x${gotAddr.toString(16)}`,
        );
      // Same short-response protection as the extended branch, clamped to
      // what was actually asked for (the silence retry above may have
      // reduced it below `n`).
      let gotLen = Math.min(data.length, requested);
      let usedData = data;
      // At least one real device enforces a legacy A_Memory_Read
      // request-size ceiling (52 bytes, bisected) well below the 6-bit APCI
      // field's theoretical 63-byte max — a pure size limit, not an
      // address issue. Rather than hardcode that number as a universal
      // constant (likely model/firmware-specific), retry once at a
      // conservatively small size (LEGACY_RETRY_CHUNK) before treating a
      // zero-byte response as genuine. A no-op for devices that already
      // serve the full size.
      if (gotLen === 0 && requested > LEGACY_RETRY_CHUNK) {
        logger.info(
          'knx',
          `Memory_Response returned zero bytes at 0x${wantAddr.toString(16)} (requested ${requested}) - retrying at a smaller size`,
          {
            deviceAddr,
            wantAddr: wantAddr.toString(16),
            originalN: requested,
          },
        );
        const retryN = LEGACY_RETRY_CHUNK;
        const retrySeq = nextSeq();
        const retryApdu = apduMemoryRead(retrySeq, retryN, wantAddr);
        const retryRespP = waitResponse(
          'Memory_Response',
          this.memoryResponseTimeoutMs,
          (f) => parseMemoryResponse(f).address === wantAddr,
        );
        await this.sendCEMI(
          buildCEMI(this.localAddr, deviceAddr, retryApdu, false, {
            priority: 'system',
          }),
        );
        const retryFrame = await retryRespP;
        const { address: retryGotAddr, data: retryData } =
          parseMemoryResponse(retryFrame);
        if (retryGotAddr === wantAddr) {
          gotLen = Math.min(retryData.length, retryN);
          usedData = retryData;
          // Same reasoning as the silence ladder above: a size this
          // device has just shown it will serve beats re-discovering the
          // refusal on every remaining chunk.
          if (gotLen > 0) sizeCeiling = retryN;
        }
      }
      if (gotLen === 0)
        throw new Error(
          `Memory_Response returned zero bytes at 0x${wantAddr.toString(16)} (requested ${requested})`,
        );
      usedData.copy(out, off, 0, gotLen);
      onChunk?.(gotLen);
      off += gotLen;
    }
    return out;
  }

  /**
   * Read a single interface-object property value (A_PropertyValue_Read).
   * Non-destructive. Returns the property VALUE bytes only — the 4-byte
   * response header (objIdx, propId, count, startIndex) is stripped. Used by
   * read-back verification of property-configured devices (e.g. KNX IP
   * routers) that carry no downloadable parameter-memory image.
   */
  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    const [value] = await this.readPropertyMany(deviceAddr, [
      { objIdx, propId },
    ]);
    return value ?? Buffer.alloc(0);
  }

  /**
   * Read several interface-object property values of one device inside a
   * SINGLE management session. Returns one VALUE buffer per read (the 4-byte
   * response header stripped), in order.
   */
  async readPropertyMany(
    deviceAddr: string,
    // `count` is the number of array elements to request (default 1);
    // `timeoutMs` overrides the 3000ms wait for that read's response.
    reads: Array<{
      objIdx: number;
      propId: number;
      count?: number;
      timeoutMs?: number;
    }>,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const values: Buffer[] = [];
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (const { objIdx, propId, count, timeoutMs } of reads) {
          const seq = nextSeq();
          const apdu = apduPropertyValueRead(seq, objIdx, propId, count ?? 1);
          const respP = waitResponse('OTHER', timeoutMs ?? 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            }),
          );
          const res = await respP;
          const data = res?.apduData;
          if (!data)
            throw new Error(
              `No PropertyValue_Response for obj=${objIdx} pid=${propId}`,
            );
          values.push(
            data.length > 4 ? Buffer.from(data.subarray(4)) : Buffer.alloc(0),
          );
        }
      },
    );
    return values;
  }

  /**
   * Read device memory using the extended memory services (A_MemoryExtended_Read,
   * 0x1FD) — required by System B / System 7 devices, which do not answer the
   * legacy A_Memory_Read. Non-destructive. 24-bit address space.
   */
  async readMemoryExtended(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 11,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    const out = Buffer.alloc(length);
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (let off = 0; off < length; off += chunkSize) {
          const n = Math.min(chunkSize, length - off);
          const seq = nextSeq();
          const apdu = apduMemoryExtendedRead(seq, n, address + off);
          const respP = waitResponse('MemoryExtended_Read_Response', 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            }),
          );
          const frame = await respP;
          const { returnCode, data } = parseMemoryExtendedResponse(frame);
          if (returnCode !== 0)
            throw new Error(
              `MemoryExtended read error rc=${returnCode} at 0x${(address + off).toString(16)}`,
            );
          data.copy(out, off);
        }
      },
    );
    return out;
  }

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (progress: DownloadProgress) => void,
    extra?: DownloadExtra,
  ): Promise<DownloadResult> {
    if (!this.connected) throw new Error('Not connected');

    const log = (msg: string): void => {
      if (onProgress) onProgress({ msg });
    };
    // Low-level protocol-step detail - see DownloadProgress.debug's own
    // doc comment for what this is/isn't used for.
    const logDebug = (msg: string): void => {
      if (onProgress) onProgress({ msg, debug: true });
    };

    // Every write whose response never arrived, across the whole session -
    // see DownloadResult's own doc comment for why this exists.
    const unconfirmed: string[] = [];
    refuseUnhandledSteps(steps);
    let aborted = false;
    // Real, worth-a-second-look problems found during live verification
    // reads - see DownloadResult.verificationIssues' own
    // doc comment for why this is a separate list from `unconfirmed` above
    // (a write whose response never arrived vs. a live checksum read that
    // failed are different kinds of problem, worth telling apart, not
    // folded into one bucket). Populated by both the RelSegment branch
    // (PID_MCB_TABLE checksum reads) and the AbsSegment branch (memory
    // read-back verification) below.
    const verificationIssues: string[] = [];
    // See DownloadResult.restartWithheld's own doc comment. Set true by
    // either branch's own final pre-Restart verification on a confirmed
    // mismatch or a persistent (retried) no-response; when true, Restart is
    // skipped entirely rather than sent regardless.
    let restartWithheld = false;
    const restartWithheldReasons: string[] = [];

    // AbsoluteSegment (MDT-style) load procedures — Connect/Unload/Load/
    // AbsSegment/TaskSegment/LoadCompleted/Restart/Disconnect — are planned
    // by the pure planDownload() function (see knx-download-plan.ts) and
    // this executor just replays the resulting ops as CEMI frames. Legacy
    // RelSegment/WriteRelMem/LoadImageProp (ABB-style) devices keep using
    // the inline loop below unchanged.
    if (isAbsSegmentProcedure(steps)) {
      await this.managementSession(
        deviceAddr,
        async ({ nextSeq, waitResponse }) => {
          const MEM_CHUNK = 44;

          // Real KNX Master Data mask-Procedure ordering (knx-mask-
          // procedures.ts), same source the RelSegment/System-B executor
          // above draws from - only the "all" subtype applies here, since
          // this path has no partial-mode variant of its own. Best-effort: a
          // device that never answers DeviceDescriptor_Read, has no
          // project id, or whose mask genuinely has no matching Procedure
          // declared in this project's own master data (a real, observed
          // case for at least one mask family - see this module's own
          // header comment) leaves `mergedOps` `null`, and planDownload()
          // then falls back to its own pre-existing behavior (the
          // application program's own declared step order) unchanged.
          let mergedOps: MaskOp[] | null = null;
          if (extra?.projectId != null) {
            try {
              const apdu = apduGroup('DeviceDescriptor_Read');
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
                priority: 'system',
              });
              const respP = waitResponse('DeviceDescriptor_Response', 3000);
              await this.sendCEMI(cemi);
              const resp = await respP;
              const mask =
                resp.apduData.length >= 2
                  ? (resp.apduData[0]! << 8) | resp.apduData[1]!
                  : null;
              if (mask != null) {
                const maskHex = mask.toString(16).padStart(4, '0');
                const maskOps = getMaskProcedure(
                  extra.projectId,
                  maskHex,
                  'Load',
                  'all',
                  extra.lineCoupler0912NewProgrammingStyle === false,
                );
                if (maskOps) {
                  mergedOps = spliceAppSteps(maskOps, steps);
                  refuseUnhandledSteps(mergedOps);
                  logDebug(
                    `Real download sequence resolved from mask ${maskHex} Procedure "Load:all" + this application program's own declared steps (${mergedOps.length} real ops)`,
                  );
                } else {
                  logDebug(
                    `No mask Procedure "Load:all" found for mask ${maskHex} in this project's own master data - falling back to this application program's own declared step order`,
                  );
                }
              }
            } catch (_e) {
              logDebug(
                "No DeviceDescriptor_Response received (falling back to this application program's own declared step order)",
              );
            }
          }

          const ops = planDownload(
            steps as PlanStep[],
            gaTable,
            assocTable,
            paramMem,
            extra?.paramBase ?? null,
            extra?.absSegData ?? {},
            extra?.appId ?? '',
            extra?.paramMemBySegment ?? null,
            mergedOps,
          );

          // Every memWrite op actually sent during this download - the source
          // of truth for the final pre-Restart read-back verification below.
          // 🟢 This AbsSegment fork has no confirmed PID_MCB_TABLE
          // (P=27) usage anywhere (planDownload() never emits a propWrite for
          // it - this device family's own load procedure only ever declares
          // Unload/Load/AbsSegment/TaskSegment/LoadCompleted steps, not
          // WriteProp/LoadImageProp), so the RelSegment fork's checksum-based
          // final verification doesn't apply here as-is. This fork's own
          // family already has a real, independently-confirmed verification
          // mechanism though - planVerify()'s 'absmem' family (see
          // knx-download-plan.ts) reads back exactly what planDownload()
          // streamed and byte-compares it. Reusing that same mechanism here,
          // inline and retry-hardened, gives this fork the same safety
          // property as the RelSegment fork's checksum check (a genuine,
          // confirmed-bad write withholds Restart) via the mechanism that's
          // actually proven for this device family, rather than forcing an
          // unconfirmed P=27 read onto it.
          const writtenMem: Array<{ addr: number; bytes: Buffer }> = [];

          /** Retry-hardened extended memory read, used only for the final
           *  pre-Restart verification below - mirrors propReadFinal()'s
           *  retry policy on the RelSegment path (2 extra attempts, 300ms
           *  apart) so a single lost frame doesn't look the same as a
           *  genuinely non-responding device. Chunks the read the same way
           *  readMemoryExtended() does. Returns null if any chunk never gets
           *  a valid response after retrying. */
          const memReadFinal = async (
            address: number,
            length: number,
            retries = 2,
          ): Promise<Buffer | null> => {
            const chunkSize = 11;
            const out = Buffer.alloc(length);
            for (let off = 0; off < length; off += chunkSize) {
              const n = Math.min(chunkSize, length - off);
              let got: Buffer | null = null;
              for (let attempt = 0; attempt <= retries; attempt++) {
                const seq = nextSeq();
                const apdu = apduMemoryExtendedRead(seq, n, address + off);
                const respP = waitResponse(
                  'MemoryExtended_Read_Response',
                  3000,
                );
                await this.sendCEMI(
                  buildCEMI(this.localAddr, deviceAddr, apdu, false, {
                    priority: 'system',
                  }),
                );
                try {
                  const frame = await respP;
                  const { returnCode, data } =
                    parseMemoryExtendedResponse(frame);
                  if (returnCode === 0) {
                    got = data;
                    break;
                  }
                } catch (_e) {
                  // fall through to retry
                }
                if (attempt < retries) await delay(300);
              }
              if (!got) return null;
              got.copy(out, off);
            }
            return out;
          };

          for (const op of ops) {
            switch (op.kind) {
              case 'connect':
              case 'disconnect': {
                // The connection-oriented session is already opened/closed by
                // managementSession() around this whole download; nothing to
                // send here.
                log(op.kind === 'connect' ? 'Connect' : 'Disconnect');
                break;
              }
              case 'propWrite': {
                // 🟢 Same objIdx=0 (Device Object) guard as the RelSegment
                // path's own propWrite() closure - see that guard's own
                // comment for the full reasoning. No allowlisted exception
                // here (unlike that closure's PID_DEVICE_CONTROL case) - no
                // legitimate objIdx=0 write is known to exist on this
                // AbsSegment/MDT-style path (every propWrite op here is a
                // PID 5 LoadStateControl transition on a real interface
                // object, never the Device Object itself).
                if (op.obj === 0) {
                  throw new Error(
                    `Refusing PropertyValue_Write to ObjIdx=0 (Device Object) PropId=${op.pid} on the AbsSegment write path - every real object index here must be 1 or above. This usually means a load-procedure step's own ObjIdx attribute was missing/unparsed and silently defaulted to 0 - check the app XML.`,
                  );
                }
                logDebug(`PropWrite ObjIdx=${op.obj} PropId=${op.pid}`);
                const seq = nextSeq();
                const apdu = apduPropertyValueWrite(
                  seq,
                  op.obj,
                  op.pid,
                  op.data,
                );
                const cemi = buildCEMI(
                  this.localAddr,
                  deviceAddr,
                  apdu,
                  false,
                  {
                    priority: 'system',
                  },
                );
                // Confirmed on real hardware - this used to be
                // unconditional fire-and-forget (send the CEMI frame, move
                // on after a fixed delay, response never awaited). Now
                // mirrors the RelSegment path's own established tolerance
                // policy - await a real response, log-and-continue rather
                // than hard-abort on a timeout (a still-unconfirmed write is
                // tracked and surfaced in the real return value instead of
                // being silently indistinguishable from a confirmed one).
                const respP = waitResponse('OTHER', 3000);
                await this.sendCEMI(cemi);
                try {
                  await respP;
                } catch (_e) {
                  const detail = `PropertyValue write ObjIdx=${op.obj} PropId=${op.pid} unconfirmed`;
                  logDebug(
                    `No PropertyValue_Response for ObjIdx=${op.obj} PropId=${op.pid} (continuing)`,
                  );
                  unconfirmed.push(detail);
                }
                await delay(50);
                break;
              }
              case 'memWrite': {
                logDebug(
                  `MemWrite Addr=0x${op.addr.toString(16)} Len=${op.bytes.length}`,
                );
                writtenMem.push({ addr: op.addr, bytes: op.bytes });
                for (let off = 0; off < op.bytes.length; off += MEM_CHUNK) {
                  const chunk = op.bytes.subarray(off, off + MEM_CHUNK);
                  const addr = op.addr + off;
                  const seq = nextSeq();
                  const apdu = apduMemoryWrite(seq, addr, chunk);
                  const cemi = buildCEMI(
                    this.localAddr,
                    deviceAddr,
                    apdu,
                    false,
                    { priority: 'system' },
                  );
                  // Confirmed on real hardware - waits on the classic
                  // Memory_Response (NOT the generic 'OTHER' bucket extended
                  // services share), matching apduMemoryWrite()'s own
                  // classic Memory_Write APCI. Unconfirmed, not fatal - same
                  // log-and-continue policy as propWrite above.
                  const respP = waitResponse('Memory_Response', 3000);
                  await this.sendCEMI(cemi);
                  try {
                    await respP;
                  } catch (_e) {
                    const detail = `Memory write Addr=0x${addr.toString(16)} Len=${chunk.length} unconfirmed`;
                    logDebug(
                      `No Memory_Response for Addr=0x${addr.toString(16)} (continuing)`,
                    );
                    unconfirmed.push(detail);
                  }
                  await delay(30);
                }
                break;
              }
              case 'restart': {
                // 🟢 Final pre-Restart verification - see the
                // `writtenMem`/`memReadFinal` comments above for why this
                // fork uses a memory read-back check rather than the
                // RelSegment fork's P=27 checksum. Re-reads every region
                // actually written during this download and byte-compares it
                // against what was sent; a confirmed mismatch or a persistent
                // (retried) no-response withholds Restart, same policy as
                // the RelSegment fork - see DownloadResult.restartWithheld's
                // own doc comment.
                for (const region of writtenMem) {
                  const readBack = await memReadFinal(
                    region.addr,
                    region.bytes.length,
                  );
                  if (!readBack) {
                    const issue = `Final verification read: Addr=0x${region.addr.toString(16)} Len=${region.bytes.length} - no response after the last write (persisted after retry), right before Restart`;
                    log(issue);
                    logger.error('knx', issue, {
                      deviceAddr,
                      stage: 'final verification (absmem)',
                    });
                    verificationIssues.push(issue);
                    restartWithheld = true;
                    restartWithheldReasons.push(issue);
                    continue;
                  }
                  if (!readBack.equals(region.bytes)) {
                    const issue = `Final verification read: Addr=0x${region.addr.toString(16)} Len=${region.bytes.length} MISMATCH after the last write - this region's real content may not match the intended target content, right before Restart`;
                    log(issue);
                    logger.error('knx', issue, {
                      deviceAddr,
                      stage: 'final verification (absmem)',
                    });
                    verificationIssues.push(issue);
                    restartWithheld = true;
                    restartWithheldReasons.push(issue);
                  } else {
                    logDebug(
                      `Final verification read (matches what was written): Addr=0x${region.addr.toString(16)} Len=${region.bytes.length}`,
                    );
                  }
                }
                if (restartWithheld) {
                  const alert =
                    `RESTART WITHHELD - ${restartWithheldReasons.length} pre-Restart verification problem(s) found; ` +
                    `device left un-restarted, still running its previous application, pending operator review: ` +
                    restartWithheldReasons.join(' | ');
                  log(alert);
                  logger.error('knx', alert, {
                    deviceAddr,
                    stage: 'restart withheld',
                    reasons: restartWithheldReasons,
                  });
                  break;
                }
                logDebug('Restart');
                const seq = nextSeq();
                const apdu = apduConnected(seq, 'Restart');
                const cemi = buildCEMI(
                  this.localAddr,
                  deviceAddr,
                  apdu,
                  false,
                  {
                    priority: 'system',
                  },
                );
                await this.sendCEMI(cemi);
                break;
              }
            }
          }

          if (restartWithheld) {
            log(
              `Download complete with Restart WITHHELD - device requires operator review before it can be restarted`,
            );
          } else if (unconfirmed.length) {
            log(
              `Download complete with ${unconfirmed.length} unconfirmed write(s) - verify recommended`,
            );
          } else {
            log('Download complete');
          }
          if (onProgress)
            onProgress({
              msg: restartWithheld
                ? 'Download complete - Restart withheld, review required'
                : 'Download complete',
              pct: 100,
              done: true,
              unconfirmedWrites: unconfirmed.length,
              restartWithheld,
            });
        },
      );
      return {
        unconfirmedWrites: unconfirmed.length,
        unconfirmedDetails: unconfirmed,
        verificationIssues,
        restartWithheld,
        restartWithheldReasons,
      };
    }

    await this.managementSession(deviceAddr, async (fns) => {
      const { nextSeq, waitResponse } = fns;
      // ETS's own MemoryExtended_Write chunk sizes top out at 228 bytes (as
      // much as fits, smaller only for a segment's tail remainder) - a
      // protocol-theoretical ceiling, not every device's real capacity.
      // Recapped below to the device's own PID_MAX_APDULENGTH when smaller
      // - see maxChunkFromApduLength(): an oversized chunk can silently
      // stall a Full Download.
      let MEM_CHUNK = 228;
      // See DownloadExtra.mode's doc comment above for what 'partial' does.
      const mode: 'full' | 'partial' = extra?.mode ?? 'full';

      // Waits for the actual PropertyValue_Response (0x3D7/0x3D5 aren't
      // named extended APCIs, so it arrives as apciName 'OTHER'). A
      // LoadCompleted response can take ~500ms, so this must wait for it
      // rather than firing Restart on a fixed short delay and discarding the
      // just-loaded segment. Not fatal if the response never arrives (some
      // property writes may legitimately not respond) - logged and
      // continued rather than aborting.
      //
      // Each read/write tolerates its own lost response, but three
      // consecutive misses (reset by any real answer) signal a dead
      // connection and abort the download rather than sending the rest of
      // the scripted sequence into nothing. The chunked memory-write loop
      // has its own separate protection, not counted here.
      const CONSECUTIVE_NO_RESPONSE_LIMIT = 3;
      let consecutiveNoResponse = 0;
      const propWrite = async (
        objIdx: number,
        propId: number,
        data: Buffer,
        startIndex = 1,
        // false = the step's XML declares Verify="false": the device sends no
        // confirmation, so send and pace instead of waiting out the timeout.
        verify = true,
      ): Promise<void> => {
        // 🟢 Real, hard guard (an adversarial safety-review finding) -
        // objIdx 0 is the Device Object: identity,
        // serial, individual address, the device's own bus manageability.
        // It must never be touched by this download's own Unload/Load/
        // content-write machinery. The one deliberate objIdx=0 write this
        // engine ever makes is PID_DEVICE_CONTROL (P=14, Verify Mode, see
        // that call site further below) - allowlisted explicitly here so
        // this guard protects every OTHER caller without needing to touch
        // that call site. A real, known gap this protects against: a
        // WriteProp/CompareProp/LoadImageProp step whose ObjIdx attribute
        // is missing could parse to objIdx=0 via a silent fallback
        // upstream - this throws synchronously, before any bus I/O,
        // instead of silently sending a wire write to the one object this
        // whole process must never disturb.
        if (objIdx === 0 && propId !== 14) {
          throw new Error(
            `Refusing PropertyValue_Write to ObjIdx=0 (Device Object) PropId=${propId} - only the deliberate PID_DEVICE_CONTROL (P=14) write may target objIdx 0; every other object index must be 1 or above. This usually means a load-procedure step's own ObjIdx attribute was missing/unparsed and silently defaulted to 0 - check the app XML.`,
          );
        }
        const seq = nextSeq();
        const apdu = apduPropertyValueWrite(
          seq,
          objIdx,
          propId,
          data,
          1,
          startIndex,
        );
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
          priority: 'system',
        });
        if (!verify) {
          // Real, critical bug: a real Partial Download to 1.1.13 wrote to
          // address 0x28C0 instead of the real PID_TABLE_REFERENCE value
          // (0xC3000). Traced all the way back to HERE - this app's own
          // declared Verify="false" WriteProp for property 27's first
          // element carries data starting `00 00 28 c0...`, and the device
          // (entirely correctly - nothing wrong with it answering a write
          // it wasn't asked to confirm) sent back a real
          // PropertyValue_Response echoing exactly that. This branch used
          // to send-and-move-on via a bare `delay(50)` - a plain timer,
          // registering NO listener at all - so that real response had
          // nothing consuming it and sat "in flight" until the NEXT,
          // unrelated `waitResponse('OTHER', ...)` call (the P=7 read this
          // exact app issues moments later) came along and claimed it,
          // generically, since nothing distinguishes one 'OTHER'-tagged
          // frame from another.
          //
          // A step declared Verify="false" never gets a REQUIRED
          // application-layer confirmation (ETS does not wait for one
          // either and moves on within ~150-200ms per this file's own
          // prior comment on this branch) - but "not required" is not the
          // same as "never arrives", and real ETS almost certainly still
          // drains whatever DOES come back in that window rather than
          // leaving it unclaimed for something else to misattribute later.
          // Fixed to do the same: register a real (short) listener and let
          // it settle - resolve or time out - before moving on, discarding
          // the result either way (Verify="false" genuinely means the
          // content doesn't matter). What matters is occupying the
          // listener slot so the device's real response, if and when it
          // arrives, is safely consumed here rather than sitting available
          // for a later, unrelated exchange to wrongly claim. `accept`
          // scopes this specifically to THIS write's own echoed
          // objIdx/propId, same correlation pattern now used by propRead().
          const drainP = waitResponse(
            'OTHER',
            200,
            (f) =>
              f.apduData.length >= 2 &&
              f.apduData[0] === objIdx &&
              f.apduData[1] === propId,
          );
          await this.sendCEMI(cemi);
          await drainP.catch(() => {
            /* Genuinely fine either way - Verify="false" means no response
             * was ever required. What mattered was holding this listener
             * open long enough to catch one if it comes; a timeout here
             * just means none did within the window, same as before. */
          });
          return;
        }
        const respP = waitResponse('OTHER', 3000);
        await this.sendCEMI(cemi);
        try {
          await respP;
          consecutiveNoResponse = 0;
        } catch (_e) {
          const detail = `PropertyValue write ObjIdx=${objIdx} PropId=${propId} unconfirmed`;
          logDebug(
            `No PropertyValue_Response for ObjIdx=${objIdx} PropId=${propId} (continuing)`,
          );
          unconfirmed.push(detail);
          consecutiveNoResponse++;
          if (consecutiveNoResponse >= CONSECUTIVE_NO_RESPONSE_LIMIT) {
            throw new Error(
              `${consecutiveNoResponse} consecutive reads/writes to ${deviceAddr} got no response at all - the connection appears dead, aborting rather than continuing to send into it (last: PropertyValue write ObjIdx=${objIdx} PropId=${propId})`,
              { cause: _e },
            );
          }
        }
      };

      /** Read a property's current value. Returns null on no response - see
       *  `consecutiveNoResponse` above for why it can also throw once misses
       *  keep coming. `countTowardFailureLimit` (default true) exists only for
       *  a separate final-verification read with its own retry policy, which
       *  must be able to report every object's outcome instead of aborting on
       *  the first object's third retry. */
      const propRead = async (
        objIdx: number,
        propId: number,
        count = 1,
        startIndex = 1,
        countTowardFailureLimit = true,
      ): Promise<Buffer | null> => {
        const seq = nextSeq();
        const apdu = apduPropertyValueRead(
          seq,
          objIdx,
          propId,
          count,
          startIndex,
        );
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
          priority: 'system',
        });
        // Real, critical bug: unlike MemoryExtended_Read/
        // Memory_Read just below (both pass a real `accept` predicate here,
        // validating the response's own echoed address before accepting
        // it), this call used to pass none at all - it resolved with
        // WHICHEVER extended-APCI frame arrived next classified as 'OTHER'
        // (the generic bucket covering every extended APCI except the 4
        // MemoryExtended_*/Restart_Extended codes - PropertyValue_Read/
        // Write, Authorize, PropDescrRead, FuncPropExtRead all share it), on
        // the assumption requests and responses always stay strictly
        // one-in-one-out. A real Partial Download to 1.1.13 was confirmed
        // (via a live packet capture) to write to address 0x28C0 instead of
        // the real PID_TABLE_REFERENCE value (0xC3000) - a stale response
        // (nothing wrong with the device sending it; ordinary processing
        // latency) was accepted as this read's answer well after a NEWER
        // request's own `waitResponse('OTHER', ...)` had already been
        // registered, and the newer call's listener claimed it first purely
        // because generic 'OTHER' matching can't tell the two apart. This
        // codebase already has the fix pattern proven elsewhere for the
        // identical risk (below); it just was never applied to property
        // reads. A real PropertyValue_Response always echoes back the
        // objIdx/propId it was asked for (the request's own meta bytes,
        // apduPropertyValueRead() - confirmed against this codebase's own
        // loopback fake, which builds its response the identical way) -
        // `accept` now requires that match, so a stale/misattributed frame
        // is correctly ignored (same "Ignoring a non-matching response" path
        // memory reads already use) and this call keeps waiting for its own
        // genuine response instead of ever treating the wrong one as an
        // answer.
        const respP = waitResponse(
          'OTHER',
          3000,
          (f) =>
            f.apduData.length >= 2 &&
            f.apduData[0] === objIdx &&
            f.apduData[1] === propId,
        );
        await this.sendCEMI(cemi);
        try {
          const res = await respP;
          if (countTowardFailureLimit) consecutiveNoResponse = 0;
          return res.apduData.length > 4
            ? Buffer.from(res.apduData.subarray(4))
            : Buffer.alloc(0);
        } catch (_e) {
          if (!countTowardFailureLimit) return null;
          consecutiveNoResponse++;
          if (consecutiveNoResponse >= CONSECUTIVE_NO_RESPONSE_LIMIT) {
            throw new Error(
              `${consecutiveNoResponse} consecutive reads/writes to ${deviceAddr} got no response at all - the connection appears dead, aborting rather than continuing to send into it (last: PropertyValue read ObjIdx=${objIdx} PropId=${propId})`,
              { cause: _e },
            );
          }
          return null;
        }
      };

      /** Retries a property read up to `retries` extra times ((retries+1)
       *  total attempts, 300ms apart) before giving up - used only for the
       *  final pre-Restart verification reads, where a single lost frame
       *  and a genuinely non-responding device would otherwise look
       *  identical. A read has no side effects, so retrying costs nothing
       *  beyond time. See DownloadResult.restartWithheld's own doc comment
       *  for the policy this feeds. */
      const propReadFinal = async (
        objIdx: number,
        propId: number,
        count = 1,
        startIndex = 1,
        retries = 2,
      ): Promise<Buffer | null> => {
        for (let attempt = 0; attempt <= retries; attempt++) {
          const res = await propRead(objIdx, propId, count, startIndex, false);
          if (res) return res;
          if (attempt < retries) await delay(300);
        }
        return null;
      };

      // Which memory-write service this device actually requires. The
      // resolution chain below is based on a small real-hardware sample.
      //
      //  1. SupportsExtendedMemoryServices - literal, KNX-Association-
      //     documented app attribute (`<Static><Options>`), no bus
      //     round-trip needed. See AppIndex.supportsExtendedMemoryServices
      //     (ets-app.ts).
      //  2. PID_MCB_TABLE (property 27) byte 5 == 0x33 exactly. 🔴 Empirical
      //     rule fitted to a small real-device sample (extended: two
      //     Albrecht Jung apps and a Zennio KLIC-DI v2, all byte5=0x33;
      //     legacy: HDL byte5=0xFF, Weinzierl byte5=0x32) - not confirmed
      //     from any KNX spec source, and an earlier looser "!= 0xFF" form
      //     was disproven by the Weinzierl case.
      //  3. IsSecureEnabled app attribute. 🔴 Also empirical, and has its
      //     own known counter-example (Zennio KLIC-DI v2 declares false but
      //     needs extended) - see ParamModel.isSecureEnabled (ets-app.ts).
      //  4. Live mask read (0x07B0 => extended) as last resort. Known
      //     unreliable alone: a third mask-0x07B0 device (HDL) needs
      //     legacy, so mask does not predict this by itself.
      //
      // The address-size heuristic (`useExtendedForThisChunk` below) is a
      // hard floor under all four - an address that doesn't fit in 16 bits
      // always needs extended regardless of what these signals say.
      //
      // `deviceMask`, once read (only step 4's branch does so - most apps
      // resolve earlier), is also reused independently below to gate the
      // mask-level Object 5 (PEI Program) Unload and Extended-Restart
      // choice - see hasPeiProgramObject.
      let deviceMask: number | null = null;
      let useExtendedMemory: boolean | null = null;
      if (extra?.supportsExtendedMemoryServices !== undefined) {
        useExtendedMemory = extra.supportsExtendedMemoryServices;
        logDebug(
          `SupportsExtendedMemoryServices=${extra.supportsExtendedMemoryServices} (${useExtendedMemory ? 'extended' : 'legacy'} memory writes - see code comment)`,
        );
      } else {
        const mcbWriteStep = steps.find(
          (s): s is DownloadStep & { data: Buffer } =>
            s.type === 'WriteProp' &&
            s.objIdx === 4 &&
            s.propId === 27 &&
            !!s.data &&
            s.data.length > 5,
        );
        let mcbByte5 = mcbWriteStep?.data[5];
        // Apps declaring only the read-only `LdCtrlLoadImageProp` for
        // PropId=27 (never `LdCtrlWriteProp`) have no static value here -
        // fall back to a live read, issued early, before any data write
        // (real ETS's own LoadImageProp read happens too late in the
        // session to inform this decision - docs/knx-device-write-protocol.md
        // §4.1). `propRead` returns null on timeout rather than throwing.
        if (mcbByte5 === undefined) {
          const live = await propRead(4, 27);
          if (live && live.length > 5) mcbByte5 = live[5];
        }
        if (mcbByte5 !== undefined) {
          useExtendedMemory = mcbByte5 === 0x33;
          logDebug(
            `PID_MCB_TABLE byte5=0x${mcbByte5.toString(16).padStart(2, '0')} (${mcbWriteStep ? 'static declaration' : 'live read'}; ${useExtendedMemory ? 'extended' : 'legacy'} memory writes - "==0x33" rule, see code comment)`,
          );
        } else if (extra?.isSecureEnabled !== undefined) {
          useExtendedMemory = extra.isSecureEnabled;
          logDebug(
            `IsSecureEnabled=${extra?.isSecureEnabled} (${useExtendedMemory ? 'extended' : 'legacy'} memory writes - 🔴 speculative, unconfirmed rule, see code comment; PID_MCB_TABLE unavailable for this app)`,
          );
        } else {
          const apdu = apduGroup('DeviceDescriptor_Read');
          const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
            priority: 'system',
          });
          const respP = waitResponse('DeviceDescriptor_Response', 3000);
          await this.sendCEMI(cemi);
          try {
            const resp = await respP;
            const mask =
              resp.apduData.length >= 2
                ? (resp.apduData[0]! << 8) | resp.apduData[1]!
                : null;
            deviceMask = mask;
            if (mask != null) {
              useExtendedMemory = (mask & 0xff) === 0xb0;
              logDebug(
                `DeviceDescriptor mask=0x${mask.toString(16).padStart(4, '0')} ` +
                  `(${useExtendedMemory ? 'SystemB family - extended memory writes' : 'legacy family - address-size heuristic applies'} - PID_MCB_TABLE and IsSecureEnabled both unavailable, falling back to mask)`,
              );
            }
          } catch (_e) {
            logDebug(
              'No DeviceDescriptor_Response received (falling back to address-size heuristic for memory writes)',
            );
          }
        }
      } // end else (SupportsExtendedMemoryServices unresolved - fell through to the PID_MCB_TABLE/IsSecureEnabled/mask chain)

      // KNX master-catalog data (knx_master.xml) declares a per-mask
      // load-procedure template that includes an unconditional Unload of
      // interface object 5 ("PEI Program") on the System B mask family
      // (0x07B0). Read the mask now if it wasn't already resolved above -
      // best-effort, never blocks the rest of the download.
      if (deviceMask === null) {
        try {
          const apdu = apduGroup('DeviceDescriptor_Read');
          const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
            priority: 'system',
          });
          const respP = waitResponse('DeviceDescriptor_Response', 3000);
          await this.sendCEMI(cemi);
          const resp = await respP;
          deviceMask =
            resp.apduData.length >= 2
              ? (resp.apduData[0]! << 8) | resp.apduData[1]!
              : null;
        } catch (_e) {
          logDebug(
            'No DeviceDescriptor_Response received (object-5/PEI Program step will be skipped)',
          );
        }
      }
      const hasPeiProgramObject =
        deviceMask !== null && (deviceMask & 0xff) === 0xb0;

      // Defense in depth for the caller's own PeiType check: refuse before any
      // write when the app declares real PEI program content. Every app seen
      // declares "0"; anything else has never been downloaded with this code.
      // Absent means "0".
      if ((extra?.peiType ?? '0') !== '0') {
        const msg =
          `Refusing to download: this app declares PEI program content (PeiType=${extra?.peiType}), ` +
          `which has never been tested. Only PeiType="0" applications are supported.`;
        logger.error('knx', msg, { deviceAddr, peiType: extra?.peiType });
        throw new Error(msg);
      }

      // Cap MEM_CHUNK to the device's own declared capacity rather than the
      // protocol-theoretical 228 unconditionally - see
      // maxChunkFromApduLength() (same fix as the read path's
      // _resolveMaxApduLength(), now driving writes too). `useExtendedMemory
      // ?? false` picks the smaller (legacy) header size when unresolved -
      // the conservative choice.
      //
      // Read PID_MAX_APDULENGTH live first (the project file's cached value
      // can be stale after a firmware/unit change); fall back to the cached
      // value only when the read gets no answer.
      const liveMaxApduLength = await this._resolveMaxApduLength(
        fns,
        deviceAddr,
      );
      const cachedMaxApduLength = extra?.cachedMaxApduLength ?? null;
      if (
        liveMaxApduLength != null &&
        cachedMaxApduLength != null &&
        liveMaxApduLength !== cachedMaxApduLength
      ) {
        logger.warn(
          'knx',
          'PID_MAX_APDULENGTH: the device reports a different value than the project file cached - using the live one',
          { deviceAddr, live: liveMaxApduLength, cached: cachedMaxApduLength },
        );
      }
      const maxApduLengthValue = liveMaxApduLength ?? cachedMaxApduLength;
      if (maxApduLengthValue != null) {
        MEM_CHUNK = Math.min(
          MEM_CHUNK,
          maxChunkFromApduLength(
            maxApduLengthValue,
            useExtendedMemory ?? false,
          ),
        );
        logDebug(`Real MEM_CHUNK for this device: ${MEM_CHUNK} bytes`);
      }

      // A_Authorize_Request with the well-known/default key - real ETS
      // sends this near the start of every download session, before any
      // property/memory writes: without it, a correctly-sequenced write can
      // still silently fail to persist even though the write's own response
      // looks valid, because the commit itself is gated behind an
      // authorization that was never requested. Sent once, unconditionally,
      // at the start of any RelSegment-driven download (a non-zero response
      // is possible on a device with real project-set access keys, unlike
      // this codebase's presumed-default 0xFFFFFFFF).
      {
        const seq = nextSeq();
        const apdu = apduAuthorizeRequest(seq);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
          priority: 'system',
        });
        const respP = waitResponse('OTHER', 3000);
        await this.sendCEMI(cemi);
        try {
          const resp = await respP;
          logDebug(`Authorize level=${resp.apduData[0] ?? 'unknown'}`);
        } catch (_e) {
          logDebug('No Authorize_Response received (continuing)');
        }
      }

      // PID_DEVICE_CONTROL (property 14, Device Object objIdx 0) - Verify
      // Mode (bit 2, value 0x04). 🟢 A legacy A_Memory_Write only gets a real
      // A_Memory_Response back if Verify Mode is set first on the device;
      // the write itself persists either way, only the confirmation depends
      // on this. 🔴 An earlier version gated on a project-file
      // `LdCtrlWriteRelMem Verify="true"` attribute - disproven, that
      // attribute is a fixed default for the RelSegment load-procedure
      // style, not a live per-device signal.
      //
      // 🟡 What correlates instead: which memory-write service the device
      // resolves to - legacy-service devices need this write, extended ones
      // never touch it. Gating on `useExtendedMemory` is therefore an
      // inference on top of an already-inferred resolution (see its own
      // resolution chain above) - see docs/knx-device-write-protocol.md
      // §4.1/§4.1d. `useExtendedMemory !== true` treats an unresolved
      // service the same as legacy (same conservative default as MEM_CHUNK
      // sizing) - sending this to a device that doesn't need it is harmless,
      // omitting it from one that does silently loses every write
      // confirmation.
      //
      // Gated on any `WriteRelMem` step's presence, not a per-step flag -
      // undeclared table writes (objects 1/2/3) benefit from this just as
      // much as the declared object 4 step does.
      if (
        steps.some((s) => s.type === 'WriteRelMem') &&
        useExtendedMemory !== true
      ) {
        logDebug(
          `PID_DEVICE_CONTROL: enabling Verify Mode ($04) before memory writes (write service resolved to ${useExtendedMemory === false ? 'legacy' : 'unresolved - defaulting to legacy'})`,
        );
        try {
          await propWrite(0, 14, Buffer.from([0x04]));
        } catch (_e) {
          logDebug('PID_DEVICE_CONTROL write failed (continuing)');
        }
      }

      // ── Load State Machine transitions (PID_LOAD_STATE_CONTROL = property
      // 5) around a RelSegment/WriteRelMem write. Device firmware silently
      // ignores memory writes to an interface object outside "Loading"
      // state, so a raw WriteRelMem with no load-state transition is a
      // silent no-op regardless of address correctness. Event/state codes
      // and the LoadData wire format below are transcribed from real
      // captures (four independent examples, sizes matched exactly), not
      // derived from spec - verified for RelSegment/ABB-style (System 7)
      // apps specifically.
      const LSM_EVENT = {
        UNLOAD: 0x04,
        START_LOADING: 0x01,
        LOAD_DATA: 0x03,
        LOAD_COMPLETED: 0x02,
      } as const;
      const lsmWrite = async (
        objIdx: number,
        event: number,
        extraBytes: Buffer = Buffer.alloc(9),
      ): Promise<void> => {
        await propWrite(
          objIdx,
          5,
          Buffer.concat([Buffer.from([event]), extraBytes]),
        );
      };
      // LoadData's real wire shape: [event=03][SCF=0x0B][rsvd:2][size:2 BE]
      // [combinedFullPar:1][fill:1][rsvd:2] - `combined` is set when the
      // model declares both a "full" and a "par" RelSegment for the same
      // object (only ever observed for the parameter object so far; every
      // other object's real example had combined=0).
      const loadDataExtra = (
        size: number,
        fill: number,
        combined: boolean,
      ): Buffer => {
        // Layout (9 bytes, after the leading event byte lsmWrite prepends):
        // [SCF=0x0B][rsvd:2][size:2 BE][mode:1][fill:1][rsvd:2] - verified
        // byte-for-byte against 4 independent real captures (offsets 1-9 of
        // the real 10-byte PropValueWrite value), see the doc referenced
        // above.
        const b = Buffer.alloc(9);
        b.writeUInt8(0x0b, 0);
        b.writeUInt16BE(size, 3);
        b.writeUInt8(combined ? 1 : 0, 5);
        b.writeUInt8(fill, 6);
        return b;
      };
      // Real relSeg info (size/fill/combined) per object, from the model's
      // own RelSegment step(s) - one step per mode ("full"/"par"), same
      // lsmIdx, real devices only need ONE combined LoadData either way.
      const relSegByObj = new Map<
        number,
        { size: number; fill: number; combined: boolean }
      >();
      for (const s of steps) {
        if (s.type !== 'RelSegment' || s.lsmIdx == null || s.size == null)
          continue;
        const existing = relSegByObj.get(s.lsmIdx);
        relSegByObj.set(s.lsmIdx, {
          size: s.size,
          fill: s.fill ?? 0,
          combined: !!existing, // a second RelSegment for the same object -> combined
        });
      }
      let anyRelSegmentLoaded = false;
      // 🟢 Real capture evidence (a genuine live 1.1.9 Full Download) showed
      // ETS never touches P=27 anywhere in the whole download for an app
      // whose own XML declares no WriteProp/LoadImageProp for it - whether
      // THIS app uses P=27 (PID_MCB_TABLE) at all, anywhere. Gates the final
      // pre-Restart verification read below: real
      // apps only ever declare P=27 on objIdx 4 (never 1/2/3 - the checksum
      // for those three is device-maintained, never explicitly declared) -
      // so this is deliberately a SINGLE whole-download gate, not
      // per-object: if the app uses P=27 at all, ETS checks every object; if
      // it never declares it anywhere, ETS checks none, and a live read
      // here would withhold Restart on a real device that never expected to
      // be asked in the first place.
      let appUsesP27 = false;

      // One real, resolved-write job per interface object - the parameter
      // object (from a `WriteRelMem` step below) and the GA/Association/
      // Object 3 undeclared tables (further below) all become one of
      // these, and are all executed together through the same batched
      // phases (see the big comment further down for why).
      interface RelmemJob {
        objIdx: number;
        label: string;
        table: Buffer;
        offset: number;
        // Non-null only for a caller-supplied base (the /bus/write-memory
        // debug tool's `resolvedBases`) - skips PID_TABLE_REFERENCE
        // resolution entirely and uses this address directly.
        presetBase: number | null;
        // The real 9-byte LOAD_DATA extra, or null when no Unload/
        // StartLoading/LoadData cycle applies at all (a WriteRelMem step
        // whose object has no RelSegment declaration - the object is
        // already loaded/known, use the caller-supplied base as-is).
        loadDataPayload: Buffer | null;
        // objIdx 4 (the application program) gets a real, real-hardware-
        // confirmed PID_PROGRAM_VERSION write-back after its memory write
        // finishes, before LoadCompleted - see the WriteRelMem case below.
        isParamObject: boolean;
        // False when the step's XML declares Verify="false" for its memory
        // write: the device confirms no chunk, so the chunk loop does not
        // wait for a per-chunk response. True (wait) otherwise.
        verifyResponse: boolean;
        // Set only by partial mode (never by full mode, and never for a
        // job with nothing pending) from DownloadExtra.pendingWriteRanges -
        // when present, the write loop further down writes ONLY these byte
        // ranges of `table`, not the whole thing. See that field's own doc
        // comment for the full reasoning (a real edit log resolved to
        // ranges, not a device content diff).
        writeRanges?: Array<{ offset: number; length: number }>;
      }
      const relmemJobs: RelmemJob[] = [];

      // A WriteProp step for an object that gets a real Unload/StartLoading/
      // LoadData cycle during this download (relSegByObj.has(step.objIdx))
      // is deferred here, keyed by objIdx, and executed right after that
      // same object's StartLoading+LoadData call rather than firing
      // immediately as `steps` is iterated - real ETS interleaves an
      // object's own declared WriteProp steps (e.g. the PID_MCB_TABLE
      // checksum-set for objIdx 4) with that object's own load-state cycle,
      // not as an isolated upfront pass before Unload begins. A WriteProp
      // for an object outside this download's load cycle still fires
      // immediately, unchanged.
      const deferredWriteProps = new Map<
        number,
        Array<{
          propId: number;
          data: Buffer;
          startElement: number;
          verify: boolean;
        }>
      >();

      // 🟢 The final post-write verification read
      // (further below) used to hardcode ascending objIdx order
      // unconditionally. Real-evidence-based (every app in this project's
      // own capture corpus that declares LdCtrlLoadImageProp at all happens
      // to declare it ascending), but still a fixed rule, not one derived
      // from this specific app's own declaration the way Unload/write order
      // already is (see `knx-mask-procedures.ts`). Records this app's own
      // real declared LoadImageProp order (from the 'LoadImageProp' case
      // below) so the final verification loop can follow it directly,
      // falling back to the ascending sort only for any objIdx this app
      // doesn't declare an order for at all.
      const loadImagePropOrder: number[] = [];

      for (const step of steps) {
        switch (step.type) {
          case 'WriteProp': {
            logDebug(`WriteProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            if (step.propId === 27) appUsesP27 = true;
            if (step.data && step.data.length) {
              // Property 27's declared InlineData is always 2 bytes longer
              // than what real ETS puts on the wire - always 10 bytes
              // declared for a real 8-byte element, across every
              // manufacturer app checked, with the same 2 trailing
              // zero-padding bytes. Scoped to propId 27 only; not observed
              // for any other property.
              const data =
                step.propId === 27 ? step.data.subarray(0, 8) : step.data;
              if (step.objIdx != null && relSegByObj.has(step.objIdx)) {
                const list = deferredWriteProps.get(step.objIdx) ?? [];
                list.push({
                  propId: step.propId!,
                  data,
                  startElement: step.startElement ?? 1,
                  verify: step.verifyResponse ?? true,
                });
                deferredWriteProps.set(step.objIdx, list);
                break;
              }
              await propWrite(
                step.objIdx,
                step.propId,
                data,
                step.startElement ?? 1,
                step.verifyResponse ?? true,
              );
            }
            break;
          }
          case 'CompareProp': {
            logDebug(`CompareProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            break;
          }
          case 'WriteRelMem': {
            logDebug(`WriteRelMem ObjIdx=${step.objIdx} Size=${step.size}`);
            if (!paramMem) throw new Error('Parameter memory not available');
            const objIdx = step.objIdx ?? 4;
            const relSeg = relSegByObj.get(objIdx);
            const presetBase = extra?.resolvedBases?.[objIdx] ?? null;
            // 🟢 Real, hard cross-check (an
            // adversarial safety-review finding) - `step.size` (this
            // WriteRelMem step's own declared Size, used just below to
            // slice the actual buffer that gets written) and `relSeg.size`
            // (the separate RelSegment step's own declared Size, used
            // further down to build the LoadData payload that tells the
            // DEVICE how big the incoming segment is) are two
            // independently-parsed XML attributes with no shared
            // derivation anywhere in this codebase. An understated LoadData
            // size relative to what's actually streamed is a textbook
            // overflow past the device's allocated segment; an overstated
            // one leaves part of a "loaded" segment genuinely uninitialized
            // while the device trusts the whole thing once LoadCompleted
            // arrives. Every real app examined so far happens to declare
            // these two attributes identically - nothing in the KNX file
            // format or this engine enforced that before this check;
            // refusing to proceed the one time they disagree is safer than
            // silently trusting either value.
            if (relSeg && relSeg.size !== step.size) {
              throw new Error(
                `RelSegment/WriteRelMem size mismatch for ObjIdx=${objIdx}: LdCtrlRelSegment declares Size=${relSeg.size} (would become the LoadData size told to the device) but LdCtrlWriteRelMem declares Size=${step.size} (would become the real content actually written) - refusing to write with two disagreeing size declarations for the same object.`,
              );
            }
            const mem = paramMem.slice(0, step.size);
            // Deferred to the batched phases below (Unload/StartLoading/
            // LoadData/PID7-resolve/write/LoadCompleted run together across
            // every interface object, not one at a time) - see the big
            // comment on that batch for why. `presetBase` (the
            // /bus/write-memory debug tool's caller-supplied address) skips
            // PID_TABLE_REFERENCE resolution there entirely, same as before.
            relmemJobs.push({
              objIdx,
              label: `param obj ${objIdx}`,
              table: mem,
              offset: step.offset ?? 0,
              presetBase,
              // Full mode: preserve the model's own declared full/combined
              // shape exactly as before. Partial mode: force the real
              // captured Partial-Download mode byte (0x00) regardless of
              // what the model declares - see DownloadExtra.mode. `null`
              // when the object has no RelSegment declaration at all - no
              // Unload/StartLoading/LoadData cycle applies, same as before
              // (the object is already loaded/known; write directly to
              // whatever base was supplied).
              loadDataPayload: relSeg
                ? loadDataExtra(
                    relSeg.size,
                    relSeg.fill,
                    mode === 'full' ? relSeg.combined : false,
                  )
                : null,
              isParamObject: objIdx === 4,
              verifyResponse: step.verifyResponse ?? true,
            });
            break;
          }
          case 'LoadImageProp': {
            // Despite the name, real ETS only ever reads this property, for
            // any objIdx - never writes through this step. A genuine write
            // to objIdx4/PropId27 comes from a separate `LdCtrlWriteProp`
            // step (see the WriteProp case above).
            logDebug(
              `LoadImageProp ObjIdx=${step.objIdx} PropId=${step.propId} - read-only per real ETS, not writing`,
            );
            if (step.propId === 27) appUsesP27 = true;
            // Only objIdx 4 gets a live read here (genuinely needed early,
            // for the memory-write-service byte5 detection above) - real
            // ETS never reads OX=1/2/3 P=27 at this point (only as part of
            // the final pre-Restart verification, or the partial-mode
            // checksum-gated skip's own dedicated read); reading here
            // unconditionally would double up with those.
            if (step.objIdx === 4) {
              await propRead(step.objIdx, step.propId, step.count ?? 1, 1);
            }
            // This app's own real declared LoadImageProp order, regardless
            // of objIdx - the final verification loop below follows it,
            // falling back to ascending sort only for an objIdx never
            // declared here.
            if (
              step.objIdx != null &&
              !loadImagePropOrder.includes(step.objIdx)
            ) {
              loadImagePropOrder.push(step.objIdx);
            }
            break;
          }
        }
      }

      // Real ETS also writes the GA table (objIdx 1) and Association table
      // (objIdx 2) during a Full Download via the same Unload/StartLoading/
      // LoadData/write/LoadCompleted RelSegment mechanism used for the
      // parameter object above - but not every real app declares a step for
      // objIdx 1/2 (some declare `LoadImageProp` instead, others nothing at
      // all). This appears to be a universal, mask-defined procedure, not
      // something every app needs to declare, so synthesize the write
      // whenever the model hasn't handled the object some other way
      // (WriteRelMem or LoadImageProp above) and the caller supplied a
      // table - never blind-writes an absent one.
      //
      // No real Partial Download example exists for these two objects, so
      // `mode=Full` (combined `true`) is used unconditionally here.
      //
      // Only a genuine `WriteRelMem` declaration (a real content write)
      // counts as "already handled" - `LoadImageProp` is read-only for
      // every objIdx real ETS declares it for (see the LoadImageProp case
      // above), so it must not suppress the undeclared-table write.
      const declaredTableObjIdxs = new Set(
        steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx),
      );
      // Undeclared-table write: GA table (objIdx 1), Association table
      // (objIdx 2), and Object 3 / Group Object Table (objIdx 3) all use the
      // same mechanism real ETS uses for a table the app's model doesn't
      // declare a step for, folded into the same `relmemJobs` batch as the
      // parameter object above so they all run together (see the batch
      // comment below for why).
      if (gaTable && gaTable.length && !declaredTableObjIdxs.has(1)) {
        relmemJobs.push({
          objIdx: 1,
          label: 'GA table',
          table: gaTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(gaTable.length, 0, mode === 'full'),
          isParamObject: false,
          verifyResponse: true, // an undeclared table has no XML step to read it from
        });
      }
      if (assocTable && assocTable.length && !declaredTableObjIdxs.has(2)) {
        relmemJobs.push({
          objIdx: 2,
          label: 'Association table',
          table: assocTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(assocTable.length, 0, mode === 'full'),
          isParamObject: false,
          verifyResponse: true, // an undeclared table has no XML step to read it from
        });
      }
      // Object 3's own write-trigger policy and caveats: see
      // DownloadExtra.groupObjectTable's doc comment.
      if (
        extra?.groupObjectTable &&
        extra.groupObjectTable.length &&
        !declaredTableObjIdxs.has(3)
      ) {
        relmemJobs.push({
          objIdx: 3,
          label: 'Group Object Table',
          table: extra.groupObjectTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(
            extra.groupObjectTable.length,
            0,
            mode === 'full',
          ),
          isParamObject: false,
          verifyResponse: true, // an undeclared table has no XML step to read it from
        });
      }

      // Every interface-object write this download needs (the parameter
      // object and the undeclared GA/Association/Object 3 tables above)
      // runs through the SAME batched phases together: Unload for every
      // object first, then StartLoading+LoadData for every object, and only
      // then PID_TABLE_REFERENCE (property 7) resolution + the real memory
      // write for every object, then LoadCompleted for every object - never
      // one object's whole cycle to completion before starting the next.
      // Running objects sequentially instead left later objects' PID 7
      // still unallocated after their own correctly-formed load cycle,
      // because real ETS interleaves all objects' StartLoading/LoadData
      // before resolving any of their table references.
      //
      // Partial mode: peek each object's real base and current content
      // before any load-state transition, dropping it from the batch if the
      // device already matches. A job with a caller-supplied `presetBase`
      // (the /bus/write-memory debug tool) peeks with that address directly
      // instead of resolving PID 7 first. No real Partial Download example
      // of a GA/Association/Object-3 table write exists, so extending this
      // to those three objects is a best-effort extrapolation.
      let activeJobs: RelmemJob[] = relmemJobs;
      if (mode === 'partial') {
        activeJobs = [];
        // See DownloadExtra.pendingWriteRanges for the reasoning this
        // replaces (peeking each object's full content, then diffing). No
        // device read happens here: `pendingWriteRanges` already gives the
        // exact byte ranges to write, resolved upstream from the change log,
        // not from device content. An object with nothing pending is
        // skipped outright - no PID 7 resolution, no read, no write.
        for (const j of relmemJobs) {
          // 🟢 Checksum-gated whole-object skip - real ETS's own mechanism for
          // GA/Association/Object 3 (objIdx 1/2/3 only - object 4/parameter
          // memory keeps using the pendingWriteRanges heuristic below
          // unconditionally, because the checksum decode covers the simple
          // 8-byte element shape for these three objects, while object 4's
          // N-element shape is verified only in the final pre-Restart pass
          // below): a live PropertyValue_Read on P=27 (PID_MCB_TABLE),
          // compared against a fresh crc16Knx() computed from the
          // download's own target table content. A match means the device
          // already carries exactly this content - skip the object's
          // entire Unload/Load/LoadData/LoadCompleted cycle, not just its
          // content, matching real ETS exactly. A mismatch is
          // whole-object-scoped evidence (a checksum covers the entire
          // table, not a byte range) - writes the object's FULL content,
          // superseding whatever narrower pendingWriteRanges tracked for
          // it. A failed/no-response read is a real problem (recorded in
          // `verificationIssues` + logged, not just debug-level - see
          // DownloadResult.verificationIssues' own doc comment) and falls
          // through to the pre-existing pendingWriteRanges heuristic below,
          // same as before the checksum gate existed - there was no live signal to gate on
          // either way.
          if ([1, 2, 3].includes(j.objIdx)) {
            const mcb = await propRead(j.objIdx, 27);
            const parsed = mcb ? parseMcbTableElement(mcb) : null;
            if (parsed) {
              const expected = crc16Knx(j.table);
              // Size AND checksum must both match: the size guards against
              // a checksum collision between tables of different lengths.
              if (
                parsed.size === j.table.length &&
                parsed.checksum === expected
              ) {
                logDebug(
                  `ObjIdx=${j.objIdx} (${j.label}): partial mode, live PID_MCB_TABLE size and checksum match (size=${parsed.size}, 0x${expected.toString(16).padStart(4, '0')}) - skipping this object entirely`,
                );
                continue;
              }
              logDebug(
                `ObjIdx=${j.objIdx} (${j.label}): partial mode, live PID_MCB_TABLE mismatch (device size=${parsed.size}/checksum=0x${parsed.checksum.toString(16).padStart(4, '0')}, expected size=${j.table.length}/checksum=0x${expected.toString(16).padStart(4, '0')}) - writing full object content`,
              );
              j.writeRanges = [{ offset: 0, length: j.table.length }];
              activeJobs.push(j);
              continue;
            }
            const issue = `ObjIdx=${j.objIdx} (${j.label}): live PID_MCB_TABLE (P=27) read failed during partial-mode verification - falling back to the tracked-change heuristic instead of a live device-truth signal`;
            log(issue);
            logger.warn('knx', issue, {
              deviceAddr,
              objIdx: j.objIdx,
              stage: 'pre-start verification',
            });
            verificationIssues.push(issue);
          }
          const ranges = extra?.pendingWriteRanges?.[j.objIdx];
          if (!ranges || !ranges.length) {
            logDebug(
              `ObjIdx=${j.objIdx} (${j.label}): partial mode, no pending changes tracked for this object - skipping`,
            );
            continue;
          }
          let resolvedBase: number;
          if (j.presetBase != null) {
            resolvedBase = j.presetBase;
          } else {
            // Still a real bus round-trip (PID_TABLE_REFERENCE, property 7)
            // - we need to know WHERE on the device to write, which is a
            // tiny, cheap property read, not a bulk content read.
            const buf = await propRead(j.objIdx, 7);
            resolvedBase = buf && buf.length >= 4 ? buf.readUInt32BE(0) : 0;
          }
          if (!resolvedBase) continue; // unallocated - nothing to write against
          j.writeRanges = ranges
            .map((r) => ({
              offset: r.offset,
              // Defensive clamp - a range resolved against a stale/mismatched
              // table length (e.g. the app model changed since the pending
              // row was logged) should never overrun the real buffer.
              length: Math.max(
                0,
                Math.min(r.length, j.table.length - r.offset),
              ),
            }))
            .filter((r) => r.length > 0);
          if (!j.writeRanges.length) continue;
          const dirtyBytes = j.writeRanges.reduce((s, r) => s + r.length, 0);
          logDebug(
            `ObjIdx=${j.objIdx} (${j.label}): partial mode, writing ${dirtyBytes} tracked-change byte(s) across ${j.writeRanges.length} region(s)`,
          );
          activeJobs.push(j);
        }
      }

      if (activeJobs.length) {
        anyRelSegmentLoaded = true;

        const loadCycleJobs = activeJobs.filter((j) => j.loadDataPayload);

        // KNX Master Data mask-Procedure ordering (knx-mask-procedures.ts) -
        // the single source the Unload/StartLoading/content-write orderings
        // below draw from, in place of independently hand-picked sorts.
        // `ProcedureSubType` is derived from structural facts computed here
        // (whether activeJobs touch the param object and/or the
        // group-address-family objects) - see resolveProcedureSubType().
        // `mergedOps` stays `null` (falling back to each ordering's own
        // hand-written rule) when no project id is available, the mask is
        // unknown, or master data has no matching Procedure declared.
        const paramJobForSubtype = activeJobs.find(
          (j) => j.objIdx === 4 && j.loadDataPayload,
        );
        const groupJobsForSubtype = activeJobs.some(
          (j) => j.objIdx !== 4 && j.loadDataPayload,
        );
        const procedureSubType = resolveProcedureSubType(
          !!paramJobForSubtype,
          groupJobsForSubtype,
          mode,
        );
        let mergedOps: MaskOp[] | null = null;
        if (
          procedureSubType &&
          extra?.projectId != null &&
          deviceMask !== null
        ) {
          const maskHex = deviceMask.toString(16).padStart(4, '0');
          const maskOps = getMaskProcedure(
            extra.projectId,
            maskHex,
            'Load',
            procedureSubType,
            extra.lineCoupler0912NewProgrammingStyle === false,
          );
          if (maskOps) {
            mergedOps = spliceAppSteps(maskOps, steps);
            refuseUnhandledSteps(mergedOps);
            logDebug(
              `Real download sequence resolved from mask ${maskHex} Procedure "${procedureSubType}" + this application program's own declared steps (${mergedOps.length} real ops)`,
            );
          } else {
            logDebug(
              `No mask Procedure "Load:${procedureSubType}" found for mask ${maskHex} in this project's own master data - falling back to the existing hand-written ordering`,
            );
          }
        }

        // PropDescrRead OX=2 P=23 (Association table's PID_TABLE descriptor)
        // + PropValueRead OX=4 P=5 (PID_LOAD_STATE_CONTROL, current load
        // state) - real ETS sends both, in this order, right before the load
        // cycle begins. The load-state read is informational only (this
        // codebase always sends the same fixed Unload/StartLoading/LoadData/
        // LoadCompleted sequence, since Unload is valid from any LSM state).
        // The Association descriptor gates a capacity check: a table needing
        // more entries than the device's live MaxNrOfElements is refused
        // before anything is written.
        if (loadCycleJobs.length) {
          const seq1 = nextSeq();
          const descrApdu = apduPropertyDescriptionRead(seq1, 2, 23);
          const descrCemi = buildCEMI(
            this.localAddr,
            deviceAddr,
            descrApdu,
            false,
            {
              priority: 'system',
            },
          );
          const descrRespP = waitResponse('OTHER', 3000);
          await this.sendCEMI(descrCemi);
          const descrRes = await descrRespP.catch(() => null);
          logDebug(
            `PropDescrRead ObjIdx=2 PropId=23 (Association table)${descrRes?.apduData ? ` -> ${descrRes.apduData.toString('hex')}` : ' -> no response'}`,
          );
          if (
            descrRes?.apduData &&
            descrRes.apduData.length >= 6 &&
            assocTable &&
            assocTable.length >= 2
          ) {
            const liveMaxNrOfElements =
              ((descrRes.apduData[4]! & 0x0f) << 8) | descrRes.apduData[5]!;
            const realAssocEntries = assocTable.readUInt16BE(0);
            if (
              liveMaxNrOfElements > 0 &&
              realAssocEntries > liveMaxNrOfElements
            ) {
              const msg =
                `Association table needs ${realAssocEntries} real entries, but this device's own live ` +
                `PropertyDescription (ObjIdx=2 PropId=23) reports a maximum of ${liveMaxNrOfElements} - ` +
                `refusing to write beyond the device's own reported capacity.`;
              logger.error('knx', msg, {
                deviceAddr,
                realAssocEntries,
                liveMaxNrOfElements,
              });
              throw new Error(msg);
            }
          }
          const loadStateRes = await propRead(4, 5);
          logDebug(
            `PropValueRead ObjIdx=4 PropId=5 (current load state)${loadStateRes ? ` -> ${loadStateRes.toString('hex')}` : ' -> no response'}`,
          );
        }
        // Real ETS unloads object 5 (PEI Program) on the System B mask
        // before object 4, regardless of whether the app uses it - gated on
        // the device's own history, not the download mode, and applies to
        // both Full and Partial. Only the Unload is sent (the mask
        // catalog's template also declares a subsequent Load+WriteProp,
        // never observed firing in any real capture).
        //
        // The Unload is conditional, as on real ETS: a device with no prior
        // download history gets an unconditional Unload; a previously-
        // downloaded device has object 5's load state read first, and the
        // Unload is skipped only on an exact $00 (Unloaded) reply. Any other
        // answer refuses the download rather than guess - see
        // docs/knx-device-write-protocol.md §3.3.2.
        if (hasPeiProgramObject) {
          if (!extra?.hasPriorDownloadHistory) {
            // First touch of this unit: unload unconditionally, no read.
            logDebug(
              'Unload ObjIdx=5 (PEI Program) - no prior download history for this device, so unconditional (matches real ETS on first touch)',
            );
            await lsmWrite(5, LSM_EVENT.UNLOAD);
          } else {
            // A unit downloaded to before: read its PEI Program object's
            // load state first. Only an exact $00 (Unloaded) lets the Unload
            // be skipped. Any other answer - a different value, a short reply
            // or silence - has no evidence behind it either way, so refuse
            // rather than guess; nothing has been written yet, so this is a
            // clean abort.
            const peiLoadState = await propRead(5, 5);
            const hex = peiLoadState ? peiLoadState.toString('hex') : null;
            logDebug(
              `PropValueRead ObjIdx=5 PropId=5 (current load state, PEI Program)${hex ? ` -> ${hex}` : ' -> no response'}`,
            );
            if (
              peiLoadState &&
              peiLoadState.length === 1 &&
              peiLoadState[0] === 0x00
            ) {
              logDebug(
                'ObjIdx=5 (PEI Program): live load state already Unloaded ($00) - skipping the Unload (matches real ETS)',
              );
            } else {
              const msg =
                `Refusing to download: ObjIdx=5 (PEI Program) load-state read returned ` +
                `${hex ? `$${hex}` : 'no response'} (expected exactly $00). A different value has no ` +
                `known meaning or safe handling, so the download was refused rather than guess. If this ` +
                `unit was reset or unloaded outside this tool, clear its download history and retry.`;
              logger.error('knx', msg, {
                deviceAddr,
                peiLoadStateHex: hex,
                peiLoadStateLength: peiLoadState?.length ?? 0,
              });
              throw new Error(msg);
            }
          }
        }
        // Order from `mergedOps` above, falling back to descending-by-objIdx
        // (real ETS's own order, e.g. 4,3,2,1) when unavailable.
        const unloadOrder = orderByMergedOps(
          loadCycleJobs,
          mergedOps,
          'Unload',
          'lsmIdx',
          (j) => j.objIdx,
          (a, b) => b.objIdx - a.objIdx,
        );
        for (const j of unloadOrder) {
          logDebug(`Unload ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.UNLOAD);
        }
        // Order from `mergedOps` above, falling back to a dependency-based
        // order (4, 3, 1, 2) when unavailable - Object 2 (Association Table)
        // cites entries in objects 1 and 3, so it loads only after both
        // exist.
        const loadOrder = orderByMergedOps(
          loadCycleJobs,
          mergedOps,
          'Load',
          'lsmIdx',
          (j) => j.objIdx,
          (a, b) => {
            const loadDependencyOrder = [4, 3, 1, 2];
            return (
              loadDependencyOrder.indexOf(a.objIdx) -
              loadDependencyOrder.indexOf(b.objIdx)
            );
          },
        );
        for (const j of loadOrder) {
          logDebug(`StartLoading ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.START_LOADING);
          logDebug(
            `LoadData ObjIdx=${j.objIdx} Size=${j.table.length} (${j.label})`,
          );
          await lsmWrite(j.objIdx, LSM_EVENT.LOAD_DATA, j.loadDataPayload!);
          // Real ETS fires an object's own declared WriteProp steps (e.g.
          // the PID_MCB_TABLE checksum-set for objIdx 4) right after that
          // same object's StartLoading+LoadData - see deferredWriteProps
          // above.
          const deferred = deferredWriteProps.get(j.objIdx);
          if (deferred) {
            for (const d of deferred) {
              logDebug(
                `WriteProp ObjIdx=${j.objIdx} PropId=${d.propId} (deferred to match real ETS's own load-phase position)`,
              );
              await propWrite(
                j.objIdx,
                d.propId,
                d.data,
                d.startElement,
                d.verify,
              );
            }
          }
        }

        // Progress is tracked as cumulative bytes across every active job
        // (not restarting a 0-80% scale per object, which would jump
        // backward each time a new object's writes began) so the
        // GA/Association/Object 3 tables — often the bulk of a Full
        // Download — move the bar, not just the parameter object. Counts
        // only bytes actually being written (writeRanges' total, for a
        // partial-mode surgical job) rather than the full table length, so
        // the denominator doesn't understate progress for a surgical write.
        const totalActiveBytes = activeJobs.reduce(
          (sum, jj) =>
            sum +
            (jj.writeRanges
              ? jj.writeRanges.reduce((s, r) => s + r.length, 0)
              : jj.table.length),
          0,
        );
        let bytesWrittenSoFar = 0;
        // 0-80% unconditionally; the remaining 80-100% covers the expected
        // long stretch before LoadCompleted/Restart. Both modes share this
        // scale.
        // Order from `mergedOps` above, falling back to descending-by-objIdx
        // (4, 3, 2, 1, each preceded by its own PID_TABLE_REFERENCE
        // resolve-and-write pair) when unavailable. Unrelated to
        // StartLoading's own 4,3,1,2 dependency order.
        const writeOrder = orderByMergedOps(
          activeJobs,
          mergedOps,
          'WriteRelMem',
          'objIdx',
          (j) => j.objIdx,
          (a, b) => b.objIdx - a.objIdx,
        );
        const resolvedBase = new Map<number, number>();
        for (const j of writeOrder) {
          let base: number;
          if (j.presetBase != null) {
            base = j.presetBase;
          } else if (j.loadDataPayload) {
            // Small pacing delay before each PID_TABLE_REFERENCE read - a
            // cheap defensive margin between consecutive objects' reads
            // within the same batch phase (the write loop below now waits
            // for each chunk's own response, the actual fix for a device
            // backlogged by a large preceding write).
            await delay(30);
            const baseBuf = await propRead(j.objIdx, 7);
            base = baseBuf && baseBuf.length >= 4 ? baseBuf.readUInt32BE(0) : 0;
            if (!base) {
              logDebug(
                `ObjIdx=${j.objIdx} (${j.label}): PID_TABLE_REFERENCE unallocated - skipping write`,
              );
              continue;
            }
          } else {
            // No RelSegment declaration and no caller-supplied base - the
            // object is already loaded/known; writes to address 0 + offset
            // (a real caller is expected to always supply a base here).
            base = 0;
          }
          resolvedBase.set(j.objIdx, base);
          // A job with pending-change-resolved `writeRanges` (see
          // DownloadExtra.pendingWriteRanges) writes only those byte spans;
          // otherwise the whole table from offset 0.
          const writeWindows = j.writeRanges ?? [
            { offset: 0, length: j.table.length },
          ];
          const jobBytesToWrite = writeWindows.reduce(
            (s, w) => s + w.length,
            0,
          );
          let jobBytesWritten = 0;
          for (const win of writeWindows) {
            for (let off = win.offset; off < win.offset + win.length; ) {
              // Cancel: checked before this chunk is sent, so nothing new
              // starts but whatever is already in flight finishes. The
              // object's base is dropped so the LoadCompleted pass treats it
              // as never having finished loading.
              if (extra?.shouldAbort?.()) {
                logDebug(
                  `Aborted mid-write: ObjIdx=${j.objIdx} (${j.label}) offset=${off} - cancel requested`,
                );
                aborted = true;
                resolvedBase.delete(j.objIdx);
                break;
              }
              const seq = nextSeq();
              const addr = base + j.offset + off;
              // A_Memory_Write only carries a 16-bit address - same problem
              // as the read side (see readRegionInSession). A resolved
              // relmem base above 0xFFFF must use A_MemoryExtended_Write, or
              // the legacy service silently truncates to the wrong address.
              // Also true even within 16 bits in at least one case (a
              // captured real ETS Partial Download used extended
              // exclusively at an in-range address) - see
              // `useExtendedMemory`'s resolution above for the primary
              // decision. `|| addr > 0xffff` is a hard floor applied
              // regardless of that resolution - never `??`, so an explicit
              // `false` (legacy) decision can't suppress extended for an
              // address that genuinely doesn't fit in 16 bits.
              const useExtendedForThisChunk =
                (useExtendedMemory ?? false) || addr > 0xffff;
              // Legacy A_Memory_Write packs its byte count into a 6-bit APCI
              // field (max 63); extended allows MEM_CHUNK up to 228. The
              // address-size heuristic can resolve a different service per
              // chunk (e.g. a write straddling 0xFFFF), so a chunk sized for
              // extended must be re-capped to 63 if it lands on legacy,
              // mirroring the read-side protocolMaxN fix.
              const stepSize = useExtendedForThisChunk
                ? MEM_CHUNK
                : Math.min(MEM_CHUNK, 63);
              // Bounded by the current window's own end, not just
              // `stepSize` - a pending-change-resolved range can (and
              // usually does) end well before a natural stepSize boundary;
              // Buffer.subarray's own clipping only protects the end of the
              // whole table, which isn't tight enough once writeWindows is a
              // sub-range of it.
              const chunkEnd = Math.min(
                off + stepSize,
                win.offset + win.length,
              );
              const chunk = j.table.subarray(off, chunkEnd);
              const apdu = useExtendedForThisChunk
                ? apduMemoryExtendedWrite(seq, addr, chunk)
                : apduMemoryWrite(seq, addr, chunk);
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
                priority: 'system',
              });
              // Waits for each chunk's own response rather than firing at a
              // flat pace - a large write can genuinely backlog the device,
              // and moving on to the next object's PID 7 read while it's
              // still digesting queues the read behind the backlog and times
              // it out. Real ETS does the same, adapting to the device's own
              // pace rather than a fixed delay. Not fatal if a chunk's
              // response never arrives (log and continue, same tolerance as
              // propWrite).
              if (!j.verifyResponse) {
                // Declared Verify="false": no per-chunk confirmation is
                // coming, so send and pace rather than wait it out.
                await this.sendCEMI(cemi);
                await delay(30);
                jobBytesWritten += chunk.length;
                if (onProgress && totalActiveBytes > 0)
                  onProgress({
                    msg: `WriteRelMem ObjIdx=${j.objIdx} (${j.label}) ${jobBytesWritten}/${jobBytesToWrite}`,
                    pct:
                      ((bytesWrittenSoFar + jobBytesWritten) /
                        totalActiveBytes) *
                      80,
                  });
                off = chunkEnd;
                continue;
              }
              const respP = waitResponse(
                useExtendedForThisChunk
                  ? 'MemoryExtended_Write_Response'
                  : 'Memory_Response',
                3000,
              );
              await this.sendCEMI(cemi);
              try {
                await respP;
              } catch (_e) {
                logDebug(
                  `No write response for ObjIdx=${j.objIdx} offset=${off} (continuing)`,
                );
                unconfirmed.push(
                  `Memory write ObjIdx=${j.objIdx} (${j.label}) offset=${off} size=${chunk.length} unconfirmed`,
                );
              }
              jobBytesWritten += chunk.length;
              // `bytesWrittenSoFar + jobBytesWritten` (bytes actually sent),
              // not `+ off` - `off` is a position within the table,
              // meaningless as a "bytes written" count once writeWindows is
              // a sub-range starting well past offset 0.
              if (onProgress && totalActiveBytes > 0)
                onProgress({
                  msg: `WriteRelMem ObjIdx=${j.objIdx} (${j.label}) ${jobBytesWritten}/${jobBytesToWrite}`,
                  pct:
                    ((bytesWrittenSoFar + jobBytesWritten) / totalActiveBytes) *
                    80,
                });
              off = chunkEnd;
            }
            if (aborted) break; // no further windows for this object
          }
          if (aborted) break; // no further objects at all
          bytesWrittenSoFar += jobBytesToWrite;
        }

        // Real ETS reads PID_PROGRAM_VERSION (property 13) on the
        // Application Program object early in its session, then writes it
        // back after EVERY object's content has been written (dead last,
        // after Object 3/Association/GA, not right after objIdx 4's own
        // content). Working theory: LoadCompleted marks the segment loaded,
        // but this registers the freshly-loaded data as belonging to a
        // known application - without it the device may discard the segment
        // on restart despite LoadCompleted confirming Loaded state. Only
        // meaningful for the Application Program object (objIdx 4) - the
        // GA/Association/Object 3 objects have no program version to
        // register.
        const paramJobWritten =
          !aborted &&
          activeJobs.some(
            (j) =>
              j.isParamObject &&
              j.loadDataPayload &&
              resolvedBase.has(j.objIdx),
          );
        if (paramJobWritten) {
          // Reading the property live at this point in the load cycle (before
          // LoadCompleted marks the segment genuinely loaded) can return
          // stale pre-load identity, which a naive read-then-write-back would
          // persist as garbage. Real ETS instead computes the value from the
          // app's own declared identity. Parses manufacturer/application-
          // number/version from `extra.appId`; falls back to read-then-echo
          // only if appId is unavailable/unparseable.
          const computed = parseProgramVersionFromAppId(extra?.appId);
          if (computed) {
            const version = programVersionToBuffer(computed);
            logDebug(
              `PID_PROGRAM_VERSION=${version.toString('hex')} (computed from appId=${extra?.appId}, not read-then-echoed)`,
            );
            await propWrite(4, 13, version);
          } else {
            logDebug(
              `Could not parse PID_PROGRAM_VERSION from appId=${extra?.appId || '(none)'} - falling back to read-then-write-back`,
            );
            const version = await propRead(4, 13);
            if (version && version.length) {
              logDebug(
                `PID_PROGRAM_VERSION=${version.toString('hex')} (live read, write-back fallback)`,
              );
              await propWrite(4, 13, version);
            } else {
              logDebug(
                'Could not read PID_PROGRAM_VERSION either - skipping write-back',
              );
            }
          }
        }

        // LoadCompleted order is also descending by object index, matching
        // the mask catalog's own template.
        for (const j of unloadOrder) {
          if (!resolvedBase.has(j.objIdx)) continue; // unallocated - skipped above
          logDebug(`LoadCompleted ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.LOAD_COMPLETED);
        }
      }

      // Real ETS ends a RelSegment-driven download with a device Restart
      // once every loaded object is marked LoadCompleted - without it a
      // freshly-loaded segment isn't confirmed to actually apply. Only sent
      // if a load cycle actually ran above.
      if (anyRelSegmentLoaded) {
        // 🟢 Real ETS's own final pre-Restart verification read (confirmed
        // via a full operation-by-operation stream comparison against three
        // real Full Download captures). Immediately after the LAST
        // LoadCompleted and immediately before Restart, real ETS reads
        // PropertyValue_Read P=27 (PID_MCB_TABLE) on every interface object
        // it considered, in ascending objIdx order - UNCONDITIONALLY,
        // regardless of which objects were actually written vs skipped
        // (confirmed even for an object whose load cycle was skipped
        // entirely by the checksum-gated skip above). `relmemJobs` (not
        // `activeJobs`) is the right source - it's the FULL universe
        // considered for this download, before partial-mode filtering
        // strips out whichever
        // objects the checksum/pendingWriteRanges logic decided to skip,
        // matching real ETS's own "read every object regardless of whether
        // it needed writing" behavior.
        //
        // Purely a verification/confirmation read for now - nothing in the
        // captured protocol suggests real ETS itself branches on this
        // read's own result either, so this doesn't interpret or act on
        // it. A failed/no-response read is logged and skipped, same
        // "don't guess from nothing" stance every other propRead() call in
        // this file already takes.
        // 🟢 Gates the whole final-verification pass on
        // `appUsesP27` (see its own doc comment above): an app that never
        // declares P=27 anywhere never gets it read here either, matching
        // real ETS's own confirmed behavior and avoiding withholding
        // Restart on a live device over a read it would never have sent.
        if (!appUsesP27) {
          logDebug(
            "Final verification read: skipped for every object - this app never declares WriteProp or LoadImageProp for P=27 on any object (matches real ETS's own confirmed behavior for such apps)",
          );
        } else {
          const finalCheckObjIdxSet = new Set(relmemJobs.map((j) => j.objIdx));
          // 🟢 This app's own real declared LoadImageProp
          // order (recorded above, from its own steps array) comes first;
          // any objIdx this app never declares an order for
          // (loadImagePropOrder doesn't cover it) falls back to the
          // ascending sort, real-evidence-based (every app in this
          // project's own captures agrees on ascending) but no longer the
          // ONLY source of truth. See loadImagePropOrder's own doc comment
          // above for the full reasoning.
          const declaredOrder = loadImagePropOrder.filter((objIdx) =>
            finalCheckObjIdxSet.has(objIdx),
          );
          const fallbackOrder = [...finalCheckObjIdxSet]
            .filter((objIdx) => !declaredOrder.includes(objIdx))
            .sort((a, b) => a - b);
          const finalCheckObjIdxs = [...declaredOrder, ...fallbackOrder];
          const relmemJobByObj = new Map(
            relmemJobs.map((j) => [j.objIdx, j] as const),
          );
          // 🟢 Retry-hardened reads + live CRC-mismatch detection - this
          // used to be an unconditional single read whose result was only
          // ever logged, never compared against anything or acted on. Now
          // uses propReadFinal() (retries a lost frame before concluding "no
          // response") and, for objIdx 1/2/3 (GA table/Association
          // table/Group Object Table - the three objects whose single
          // 8-byte PID_MCB_TABLE element shape is confirmed, see
          // parseMcbTableElement()'s own doc comment), computes the expected
          // checksum from the download's own target content (relmemJobs'
          // `table` field - the same value the
          // partial-mode checksum-gated skip above already compares
          // against) and treats a mismatch as a real problem, not just a
          // log line. Object 4 (parameter memory)'s own P=27 value holds one
          // or two elements, read with the declared element count and
          // compared per element in the block below; the partial-mode
          // checksum-gated skip above does not apply to it.
          for (const objIdx of finalCheckObjIdxs) {
            // Object 4 (parameter memory) holds a 1- or 2-element array.
            // An app that declares no LdCtrlWriteProp for it has ONE element
            // whose checksum covers the whole parameter buffer. An app that
            // declares it twice (the second with StartElement="2") has TWO:
            // element 1 covers the first N bytes, element 2 the last M, with
            // N and M taken from bytes 2-3 of each declared write's own
            // InlineData (per-app constants, not derived from content). How
            // many elements to read comes from the declared
            // LdCtrlLoadImageProp Count where present, else from the number
            // of declared writes.
            const p27WriteSteps =
              objIdx === 4
                ? steps.filter(
                    (s) =>
                      s.type === 'WriteProp' &&
                      s.objIdx === 4 &&
                      s.propId === 27 &&
                      !!s.data &&
                      s.data.length >= 4,
                  )
                : [];
            const elem1Step = p27WriteSteps.find(
              (s) => !s.startElement || s.startElement === 1,
            );
            const elem2Step = p27WriteSteps.find((s) => s.startElement === 2);
            const declaredCount =
              objIdx === 4
                ? steps.find(
                    (s) =>
                      s.type === 'LoadImageProp' &&
                      s.objIdx === 4 &&
                      s.propId === 27,
                  )?.count
                : undefined;
            const readCount =
              objIdx === 4
                ? Math.max(declaredCount ?? 1, p27WriteSteps.length || 1)
                : 1;
            const flag = (issue: string): void => {
              log(issue);
              logger.error('knx', issue, {
                deviceAddr,
                objIdx,
                stage: 'final verification',
              });
              verificationIssues.push(issue);
              restartWithheld = true;
              restartWithheldReasons.push(issue);
            };
            const finalMcb = await propReadFinal(objIdx, 27, readCount, 1);
            if (!finalMcb) {
              flag(
                `Final verification read: ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) - no response after the last LoadCompleted (persisted after retry), right before Restart`,
              );
              continue;
            }
            const job = relmemJobByObj.get(objIdx);
            if (objIdx === 4) {
              if (!job) {
                logDebug(
                  `Final verification read (matches real ETS's own pre-Restart check): ObjIdx=4 P=27 (PID_MCB_TABLE) = 0x${finalMcb.toString('hex')} - no expected content to compare against`,
                );
                continue;
              }
              if (readCount === 1) {
                if (finalMcb.length < 8) {
                  flag(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) - short response (${finalMcb.length} bytes, expected 8) after the last LoadCompleted, right before Restart`,
                  );
                  continue;
                }
                const realCrc = finalMcb.readUInt16BE(6);
                const expectedCrc = crc16Knx(job.table);
                if (realCrc === expectedCrc) {
                  logDebug(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) matches (whole-buffer crc=0x${realCrc.toString(16)})`,
                  );
                } else {
                  flag(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) MISMATCH after the last LoadCompleted (device crc=0x${realCrc.toString(16)}, expected crc=0x${expectedCrc.toString(16)}) - the parameter memory may not match the intended target content, right before Restart`,
                  );
                }
              } else if (elem1Step && elem2Step) {
                if (finalMcb.length < 16) {
                  flag(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) - short response (${finalMcb.length} bytes, expected at least 16) after the last LoadCompleted, right before Restart`,
                  );
                  continue;
                }
                const n1 = elem1Step.data!.readUInt16BE(2);
                const n2 = elem2Step.data!.readUInt16BE(2);
                const realCrc1 = finalMcb.readUInt16BE(6);
                const realCrc2 = finalMcb.readUInt16BE(14);
                const expectedCrc1 = crc16Knx(
                  job.table.subarray(0, Math.min(n1, job.table.length)),
                );
                const expectedCrc2 = crc16Knx(
                  job.table.subarray(Math.max(0, job.table.length - n2)),
                );
                const match1 = realCrc1 === expectedCrc1;
                const match2 = realCrc2 === expectedCrc2;
                if (match1 && match2) {
                  logDebug(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) matches (element1 crc=0x${realCrc1.toString(16)} over first ${n1} bytes, element2 crc=0x${realCrc2.toString(16)} over last ${n2} bytes)`,
                  );
                } else {
                  flag(
                    `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) MISMATCH after the last LoadCompleted (` +
                      `element1: device crc=0x${realCrc1.toString(16)}/expected=0x${expectedCrc1.toString(16)} over first ${n1} bytes${match1 ? ' [ok]' : ' [MISMATCH]'}, ` +
                      `element2: device crc=0x${realCrc2.toString(16)}/expected=0x${expectedCrc2.toString(16)} over last ${n2} bytes${match2 ? ' [ok]' : ' [MISMATCH]'}` +
                      `) - the parameter memory may not match the intended target content, right before Restart`,
                  );
                }
              } else {
                // A declared shape with no byte-range evidence (more than two
                // elements, or one declared write for a multi-element
                // property): read and logged, deliberately not compared.
                logDebug(
                  `Final verification read: ObjIdx=4 P=27 (PID_MCB_TABLE) = 0x${finalMcb.toString('hex')} (no comparison - ${p27WriteSteps.length} declared write(s), ${readCount} element(s))`,
                );
              }
              continue;
            }
            if (![1, 2, 3].includes(objIdx)) {
              logDebug(
                `Final verification read (matches real ETS's own pre-Restart check): ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) = 0x${finalMcb.toString('hex')}`,
              );
              continue;
            }
            const parsed = parseMcbTableElement(finalMcb);
            if (!parsed) {
              flag(
                `Final verification read: ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) - short/malformed response (${finalMcb.length} bytes, expected 8) after the last LoadCompleted, right before Restart`,
              );
              continue;
            }
            if (!job) {
              // No target content to compare against for this objIdx
              // (shouldn't happen - finalCheckObjIdxs is derived from
              // relmemJobs itself - but fail safe rather than guess).
              logDebug(
                `Final verification read (matches real ETS's own pre-Restart check): ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) checksum=0x${parsed.checksum.toString(16).padStart(4, '0')} - no expected content to compare against`,
              );
              continue;
            }
            const expected = crc16Knx(job.table);
            if (
              parsed.size === job.table.length &&
              parsed.checksum === expected
            ) {
              logDebug(
                `Final verification read (matches real ETS's own pre-Restart check): ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) size=${parsed.size} checksum=0x${parsed.checksum.toString(16).padStart(4, '0')} [ok]`,
              );
            } else {
              flag(
                `Final verification read: ObjIdx=${objIdx} P=27 (PID_MCB_TABLE) MISMATCH after the last LoadCompleted (device size=${parsed.size}/checksum=0x${parsed.checksum.toString(16).padStart(4, '0')}, expected size=${job.table.length}/checksum=0x${expected.toString(16).padStart(4, '0')}) - this object's real content may not match the intended target content, right before Restart`,
              );
            }
          }
        }
        // 🟢 A confirmed mismatch or persistent no-response
        // above means Restart is deliberately WITHHELD, not sent
        // regardless - see DownloadResult.restartWithheld's own doc
        // comment. The device is left exactly where it is: still running
        // its OLD application (per the Load State Machine's own
        // staged-write design, nothing just-loaded is live until a boot
        // happens), still reachable, deliberately not pushed through an
        // uncertain reboot.
        if (restartWithheld) {
          const alert =
            `RESTART WITHHELD - ${restartWithheldReasons.length} pre-Restart verification problem(s) found; ` +
            `device left un-restarted, still running its previous application, pending operator review: ` +
            restartWithheldReasons.join(' | ');
          log(alert);
          logger.error('knx', alert, {
            deviceAddr,
            stage: 'restart withheld',
            reasons: restartWithheldReasons,
          });
        } else {
          // Real ETS itself waits roughly another second after LoadCompleted's
          // own response before sending Restart (see the doc above's "Restart
          // race" finding - even with propWrite now waiting for the response
          // itself, real ETS's extra margin here is real, observed behavior,
          // not just a safety guess this fix invented on top of it).
          await delay(1000);
          logDebug('Restart');

          // Real ETS uses the EXTENDED, confirmed Restart (`RestartReq
          // $0100`, waits for a real `RestartResp $000000`) for System-B-mask
          // devices - but sends the plain, unconfirmed basic Restart to at
          // least one confirmed non-System-B device instead. `hasPeiProgramObject`
          // is the same live mask-family signal already resolved above (via a
          // real DeviceDescriptor_Read) for the Object-5 Unload decision - a
          // more direct signal than reusing `useExtendedMemory` (itself
          // resolved through a multi-step heuristic chain, any link of which
          // can win before a real mask read ever happens). Only fall back to
          // `useExtendedMemory` if the mask read itself genuinely failed (no
          // DeviceDescriptor_Response at all - rare, network-level failure).
          const useExtendedRestart =
            deviceMask !== null
              ? hasPeiProgramObject
              : useExtendedMemory === true;

          // Timing is real-capture-calibrated, not guessed: for the Extended
          // path, real ETS disconnected only ~200ms after seeing the
          // device's actual RestartResp (a ~620ms REQUEST-to-DISCONNECT
          // total, not a blind multi-second wait). Waiting for the real
          // response, capped by a safety-net timeout in case it never
          // arrives, is what actually matches ETS - not the wait itself. For
          // the Basic path, real ETS's own capture shows ~1.4s between its
          // Restart request and the following Disconnect - used verbatim as
          // this path's fixed delay, since a basic Restart has no response
          // to wait for at all.
          const seq = nextSeq();
          if (useExtendedRestart) {
            const apdu = apduRestartExtended(seq);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            });
            // Real bug, found while building a loopback test harness (no
            // real hardware involved in finding this - a synthesized
            // Restart_Extended_Response never matched here either, which is
            // what surfaced it): this waited for apciName 'OTHER', but
            // Restart_Extended_Response is one of the codes APCI_EXT_NAMES
            // (knx-cemi.ts) renames away from the generic 'OTHER' bucket -
            // `cemi.apciName !== apciNameExpected`'s strict-equality check
            // (managementSession()'s own waitResponse) meant a real device's
            // correct response could never match, silently falling through to
            // the 3s-timeout branch every single time, on real hardware too
            // (harmless in practice - the write had already committed by this
            // point - but the "device may not support the extended Restart"
            // log line was wrong on every successful run, and this added a
            // needless 3s delay to every Extended-Restart download).
            const respP = waitResponse('Restart_Extended_Response', 3000);
            await this.sendCEMI(cemi);
            try {
              await respP;
              logDebug('RestartResp received - device confirmed restart');
            } catch {
              logDebug(
                'No RestartResp within 3s - device may not support the extended Restart after all; falling back to a settle delay before disconnecting',
              );
              await delay(3000);
            }
            // Real ETS's own ~200ms grace between seeing RestartResp and
            // sending Disconnect (see comment above).
            await delay(200);
          } else {
            const apdu = apduConnected(seq, 'Restart');
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            });
            await this.sendCEMI(cemi);
            // Real ETS's own ~1.4s Restart-to-Disconnect gap for this
            // Restart variant, no response to wait for (see comment above).
            await delay(1400);
          }
        }
      }

      if (restartWithheld) {
        log(
          `Download complete with Restart WITHHELD - device requires operator review before it can be restarted`,
        );
      } else if (unconfirmed.length) {
        log(
          `Download complete with ${unconfirmed.length} unconfirmed write(s) - verify recommended`,
        );
      } else {
        log('Download complete');
      }
      if (onProgress)
        onProgress({
          msg: restartWithheld
            ? 'Download complete - Restart withheld, review required'
            : 'Download complete',
          pct: 100,
          done: true,
          unconfirmedWrites: unconfirmed.length,
          restartWithheld,
        });
    });
    return {
      unconfirmedWrites: unconfirmed.length,
      unconfirmedDetails: unconfirmed,
      aborted,
      verificationIssues,
      restartWithheld,
      restartWithheldReasons,
    };
  }

  // ── Identify ──────────────────────────────────────────────────────────────────

  async identify(deviceAddr: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const memWrite = (seq: number, addr: number, dataByte: number): Buffer =>
      apduMemoryWrite(seq, addr, Buffer.from([dataByte]));

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const seq0 = nextSeq();
      const on = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq0, 0x0060, 0x01),
        false,
        { priority: 'system' },
      );
      await this.sendCEMI(on);
      await delay(3000);
      const seq1 = nextSeq();
      const off = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq1, 0x0060, 0x00),
        false,
        { priority: 'system' },
      );
      await this.sendCEMI(off);
    });
  }

  // ── Device info ───────────────────────────────────────────────────────────────

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    if (!this.connected) throw new Error('Not connected');

    const probe = await this._probeSingle(deviceAddr, 2000);
    if (!probe) throw new Error(`Device ${deviceAddr} did not respond`);

    const info: DeviceInfo = {
      descriptor: probe.descriptor,
      address: deviceAddr,
    };

    try {
      await this.managementSession(
        deviceAddr,
        async ({ waitResponse, nextSeq }) => {
          const propRead = async (
            objIdx: number,
            propId: number,
          ): Promise<Buffer | null> => {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            });
            await this.sendCEMI(cemi);
            const res = await waitResponse('OTHER', 2000);
            return res?.apduData || null;
          };

          // Each read below tolerates its own failure (a missing property is
          // common and not a session problem), but a session where EVERY read
          // got no answer never really worked even though it opened without
          // an explicit error. Count them so that case can be reported.
          let attempted = 0;
          let succeeded = 0;
          const tryProp = async (
            propId: number,
            label: string,
            handler: (data: Buffer) => void,
          ): Promise<void> => {
            attempted++;
            try {
              const data = await propRead(0, propId);
              if (data) {
                logger.debug(
                  'knx',
                  `${deviceAddr} prop ${label} (${propId}) read`,
                  {
                    data: data.toString('hex'),
                  },
                );
                handler(data);
                succeeded++;
              } else {
                logger.debug(
                  'knx',
                  `${deviceAddr} prop ${label} (${propId}) read - no response data`,
                );
              }
            } catch (e) {
              logger.warn(
                'knx',
                `${deviceAddr} prop ${label} (${propId}) read failed`,
                {
                  error: (e as Error).message,
                },
              );
            }
          };

          // Security Object probe (PID_SECURITY_MODE, OT=17/OI=1/P=51),
          // placed here to match real ETS's own position: right after
          // DeviceDescriptor_Read (already done via _probeSingle above),
          // before every other identity read. Informational only - nothing
          // downstream branches on info.securityMode.
          try {
            const seq = nextSeq();
            const apdu = apduFuncPropExtStateRead(seq, 17, 51);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
              priority: 'system',
            });
            const respP = waitResponse('FunctionPropertyExt_Response', 2000);
            await this.sendCEMI(cemi);
            const res = await respP.catch(() => null);
            if (res?.apduData && res.apduData.length > 8) {
              info.securityMode = res.apduData.subarray(8).toString('hex');
            }
          } catch (e) {
            logger.warn(
              'knx',
              `${deviceAddr} securityMode (OT=17 P=51) read failed`,
              {
                error: (e as Error).message,
              },
            );
          }

          await tryProp(11, 'serialNumber', (data) => {
            if (data.length >= 10)
              info.serialNumber = data.slice(4).toString('hex');
          });
          await tryProp(12, 'manufacturerId', (data) => {
            if (data.length >= 6) info.manufacturerId = data.readUInt16BE(4);
          });
          await tryProp(13, 'programVersion', (data) => {
            if (data.length >= 9) {
              const pv = data.slice(4);
              info.programVersion = {
                manufacturerId: pv.readUInt16BE(0),
                deviceType: pv.readUInt16BE(2),
                appVersion: pv[4]!,
              };
            }
          });
          await tryProp(15, 'orderInfo', (data) => {
            if (data.length > 4) {
              const raw = data.slice(4);
              const nullIdx = raw.indexOf(0);
              const body = nullIdx >= 0 ? raw.slice(0, nullIdx) : raw;
              // Only accept the ASCII rendering when every byte is printable
              // ASCII (0x20-0x7E). Real devices often store binary here, and
              // Node's 'ascii' decoder masks the high bit while passing
              // control chars through - which surfaces as junk like "  ' `"
              // in the UI. Fall back to hex whenever the content isn't
              // cleanly printable.
              let printable = body.length > 0;
              for (const b of body) {
                if (b < 0x20 || b > 0x7e) {
                  printable = false;
                  break;
                }
              }
              const text = printable ? body.toString('ascii').trim() : '';
              info.orderInfo = text || raw.toString('hex');
            }
          });
          await tryProp(78, 'hardwareType', (data) => {
            if (data.length >= 10)
              info.hardwareType = data.slice(4).toString('hex');
          });
          await tryProp(9, 'firmwareRevision', (data) => {
            if (data.length >= 5) info.firmwareRevision = data[4];
          });
          await tryProp(25, 'version', (data) => {
            if (data.length >= 6)
              info.version = data.slice(4, 6).toString('hex');
          });
          if (attempted > 0 && succeeded === 0) {
            throw new Error(
              `All ${attempted} identity property reads for ${deviceAddr} got no response - the management session likely never really worked, even though it opened without an explicit error`,
            );
          }
        },
      );
    } catch (e) {
      info.error = (e as Error).message;
    }

    return info;
  }

  // ── Bus scan ──────────────────────────────────────────────────────────────────

  _probeSingle(
    deviceAddr: string,
    timeoutMs: number,
  ): Promise<{ descriptor: string } | null> {
    if (!this.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: { descriptor: string } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), scaledMs(timeoutMs));
      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish({ descriptor: cemi.apduData?.toString('hex') || '' });
      };
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('DeviceDescriptor_Read');
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false, {
        priority: 'system',
      });
      this.sendCEMI(cemi).catch(() => {});
    });
  }

  scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    this._scanAbort = false;
    return (async () => {
      const found: Array<{ address: string; descriptor: string }> = [];
      for (let dev = 0; dev <= 255; dev++) {
        if (this._scanAbort) break;
        const addr = `${area}.${line}.${dev}`;
        const result = await this._probeSingle(addr, timeoutMs);
        if (result)
          found.push({ address: addr, descriptor: result.descriptor });
        if (onProgress)
          onProgress({
            address: addr,
            reachable: !!result,
            descriptor: result?.descriptor || null,
            done: dev + 1,
            total: 256,
          });
      }
      return found;
    })();
  }

  abortScan(): void {
    this._scanAbort = true;
  }

  status(): { connected: boolean; hasLib: boolean } {
    return { connected: this.connected, hasLib: true };
  }
}

/**
 * Refuses a download whose load procedure (the application's own steps, or
 * those merged with the mask's) contains a directive this code does not know
 * how to run. Silently skipping a step a device's own procedure mandates is
 * exactly how a device ends up half-programmed; refusing costs nothing since
 * nothing has been written yet.
 */
function refuseUnhandledSteps(
  ops: ReadonlyArray<{ type: string; tag?: string }>,
): void {
  const unhandled = ops.filter((o) => o.type === 'Unhandled');
  if (unhandled.length === 0) return;
  const tags = [...new Set(unhandled.map((o) => o.tag ?? '?'))].join(', ');
  const msg =
    `Refusing to download: this device's load procedure declares ${unhandled.length} step(s) this ` +
    `software does not know how to perform (${tags}). Skipping them could leave the device only ` +
    `partly programmed, so the download was refused.`;
  logger.error('knx', msg, { tags });
  throw new Error(msg);
}

// Multiplier applied to every wait and timeout in the KNX layer. Always 1 in
// production; the test runner sets it below 1 (tests/helpers/time-scale.ts) so
// a test that would sit through real protocol delays runs in a fraction of the
// time. Ratios between waits are preserved.
let timeScale = 1;
export function setTimeScale(scale: number): void {
  if (!(scale > 0) || scale > 1)
    throw new Error('time scale must be in (0, 1]');
  timeScale = scale;
}
export function scaledMs(ms: number): number {
  return timeScale === 1 || ms <= 0
    ? ms
    : Math.max(1, Math.round(ms * timeScale));
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, scaledMs(ms)));
}

interface AppProgramVersion {
  manufacturerId: number;
  applicationNumber: number;
  applicationVersion: number;
}

/**
 * Parses PID_PROGRAM_VERSION's three fields (manufacturer, application
 * number, application version) out of an app's `appId`
 * (`M-XXXX_A-YYYY-ZZ-...`) - a reliable static source, used in place of
 * reading the value live off the device. See downloadDevice()'s
 * PID_PROGRAM_VERSION write-back.
 */
export function parseProgramVersionFromAppId(
  appId: string | undefined,
): AppProgramVersion | null {
  if (!appId) return null;
  const m = /^M-([0-9A-Fa-f]{4})_A-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{2})-/.exec(
    appId,
  );
  if (!m) return null;
  return {
    manufacturerId: parseInt(m[1]!, 16),
    applicationNumber: parseInt(m[2]!, 16),
    applicationVersion: parseInt(m[3]!, 16),
  };
}

/** The 5-byte PID_PROGRAM_VERSION wire format (DPT 217.001). */
export function programVersionToBuffer(pv: AppProgramVersion): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt16BE(pv.manufacturerId, 0);
  buf.writeUInt16BE(pv.applicationNumber, 2);
  buf.writeUInt8(pv.applicationVersion, 4);
  return buf;
}

/**
 * Computes the max per-chunk DATA size for A_Memory_Read/Write (legacy) or
 * A_MemoryExtended_Read/Write (extended) from a device's declared
 * `PID_MAX_APDULENGTH` (see `KnxConnection._resolveMaxApduLength()`),
 * replacing a fixed constant with the device's own stated capacity - an
 * oversized fixed chunk can silently stall a device mid-download, leaving
 * it backlogged and NAKing subsequent reads.
 *
 * Real ETS reads `PID_MAX_APDULENGTH` once (property 56, objIdx 0) and
 * computes the safe size deterministically, no trial and error. The wire
 * NPDU Length byte equals (real octet count − 1); subtract the header size
 * (read from `apduMemoryRead()`/`apduMemoryWrite()`/`apduMemoryExtendedRead()`'s
 * own layout in `knx-cemi.ts`) to get the real payload capacity.
 *
 * `headerBytes`:
 * - legacy: 2 (TPCI+APCI+count, packed by `apduConnectedFull()`) + 2
 *   (16-bit address) = 4
 * - extended: 2 (TPCI+APCI_EXT header) + 1 (count) + 3 (24-bit address) = 6
 */
/**
 * The size a legacy A_Memory_Read falls back to when a device won't serve
 * the size first asked for.
 *
 * This is a last resort for a device that refuses a size, not the normal
 * sizing rule - a device's declared PID_MAX_APDULENGTH already caps every
 * request (see maxChunkFromApduLength below); this only applies when the
 * device won't serve what that cap allowed. See the two retry sites in
 * readRegionInSession().
 *
 * ⚠ TEMPORARY: 32 is not derived from anything and must go. It was chosen
 * comfortably below a ceiling measured on one device, not a rule from the
 * KNX spec, ETS, or product data - a device with a lower ceiling would
 * still fail here, and one with a higher ceiling reads more slowly than
 * necessary. What should replace it is a declared limit: whether the
 * product data or a mask-version property states what a device refusing a
 * request WITHIN its declared PID_MAX_APDULENGTH is actually signaling.
 * Do not tune this number against another device - replace it.
 */
const LEGACY_RETRY_CHUNK = 32;

export function maxChunkFromApduLength(
  maxApduLengthValue: number,
  useExtended: boolean,
): number {
  const headerBytes = useExtended ? 6 : 4;
  return Math.max(1, maxApduLengthValue + 1 - headerBytes);
}

// computeDirtyRanges() (device-read-and-diff) was replaced by
// DownloadExtra.pendingWriteRanges: an edit log resolved to write ranges
// upstream, not a device content read diffed here - changes are logged in
// the database as edits happen, rather than cached as a device memory
// snapshot.

/**
 * CRC-16 as used by PID_MCB_TABLE (property 27)'s per-object checksum.
 * Polynomial 0x1021, initial
 * value 0x1D0F, no input/output reflection, no final XOR - not one of the
 * well-known named CRC-16 presets. Computed directly over the object's own
 * raw table bytes, no address prefix, no header, no padding.
 */
export function crc16Knx(buf: Buffer): number {
  let crc = 0x1d0f;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Parses an 8-byte PID_MCB_TABLE (property 27) element for interface
 * objects 1 (GA table), 2 (Association table), and 3 (Group Object
 * Table):
 * `[reserved:2][table size, BE:2][reserved:1][write-service signal:1][checksum, BE:2]`.
 * Returns `null` for anything shorter than 8 bytes (object 4/parameter
 * memory uses a different, N-element shape - not
 * handled here). Only the first 8 bytes of a longer value are read, on
 * the (currently untested beyond objects 1/2/3) assumption that a
 * multi-element value for THESE three objects, if one ever exists, would
 * still lead with this same per-object element shape.
 */
export function parseMcbTableElement(
  buf: Buffer,
): { size: number; signalByte: number; checksum: number } | null {
  if (buf.length < 8) return null;
  return {
    size: buf.readUInt16BE(2),
    signalByte: buf[5]!,
    checksum: buf.readUInt16BE(6),
  };
}
