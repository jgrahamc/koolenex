/**
 * KnxLoopbackConnection - a `KnxConnection` transport subclass that never
 * touches a real socket/USB device. Drives a full write - handshaking
 * included - so it can be byte-checked with no hardware present.
 *
 * Drives the real `KnxConnection.downloadDevice()` orchestration end to end
 * - real Authorize/DeviceDescriptor/LoadControl sequencing, real chunking,
 * real Restart choice - by overriding the one abstract transport hook
 * `KnxConnection` defines for this (`sendCEMI()`), then feeding synthesized
 * responses back in via the same `_onCEMI()` injection point.
 *
 * Response shapes use real device facts where available (DeviceDescriptor
 * mask, serial, manufacturer/hardware/program-version identity - sourced
 * from the imported project, never invented). Where no real captured
 * response is worth replaying (most property reads/writes, whose content
 * the orchestrator never inspects - only that a response of the right APCI
 * arrives), a generic dummy/ACK value is synthesized instead, per branch.
 *
 * Deliberately does not send a T_ACK for outgoing connection-oriented
 * frames - nothing here waits on one (only `managementSession()`'s
 * `ackHandler` ACKs the device's responses, the other direction).
 */
import {
  KnxConnection,
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnected,
  apduConnectedFull,
  APCI_EXT,
  delay,
  crc16Knx,
} from './knx-connection.ts';
import type { CemiFrame } from './knx-cemi.ts';

export interface RecordedFrame {
  direction: 'out' | 'in';
  cemi: Buffer;
  parsed: CemiFrame | null;
  /** Human-readable one-liner, same spirit as the server's own debug log line. */
  decoded: string;
}

export interface RecordedMemoryWrite {
  objIdx: number | null;
  address: number;
  data: Buffer;
  extended: boolean;
}

/**
 * Per-device facts this loopback replays, sourced from a real capture or DB
 * record, never invented. `tableBases` answers every `PropertyValue_Read`
 * for property 7 (PID_TABLE_REFERENCE) on objIdx 1-4 - the mechanism
 * `downloadDevice()` uses to find where on the device to write each table;
 * without it the write phase resolves address 0 and skips every object as
 * unallocated. Table-base values are per-device runtime allocations, not app
 * content, so placeholder addresses are fine as long as they're distinct and
 * nonzero.
 */
export interface LoopbackDeviceConfig {
  deviceAddr: string;
  localAddr?: string;
  /** Real DeviceDescriptor mask, e.g. 0x07b0 for System B. */
  mask: number;
  /** Real 6-byte serial, lowercase hex. */
  serial: string;
  /** Per-objIdx PID_TABLE_REFERENCE base address (1=GA, 2=Assoc, 3=Obj3, 4=Param). */
  tableBases: Record<number, number>;
  /**
   * PID_MCB_TABLE (property 27) byte 5, consulted only if
   * `extra.supportsExtendedMemoryServices`/`isSecureEnabled` are both
   * unresolved. Defaults to 0x33 (extended).
   */
  mcbByte5?: number;
  /** PID_MANUFACTURER_ID (property 12, objIdx 0). 2-byte value, e.g. 0x0004 for Albrecht Jung. */
  manufacturerId?: number;
  /** PID_HARDWARE_TYPE (property 78, objIdx 0). 6-byte value. */
  hardwareType?: Buffer;
  /**
   * PID_PROGRAM_VERSION (property 13, objIdx 4 - the Application Program
   * object, not the Device object). 5-byte value (2-byte manufacturer,
   * 2-byte application number, 1-byte application version) - build with
   * `programVersionToBuffer()` (knx-connection.ts) from a
   * `parseProgramVersionFromAppId()` result.
   */
  programVersion?: Buffer;
}

/** Builds a device->tool response CEMI frame, mirroring buildCEMI's own
 *  parameter order used throughout this codebase's test fixtures. */
function respFrame(
  deviceAddr: string,
  localAddr: string,
  apdu: Buffer,
): CemiFrame {
  return parseCEMI(
    buildCEMI(deviceAddr, localAddr, apdu, false, { priority: 'system' }),
  )!;
}

/** Recomputes the full 10-bit extended APCI code from the frame's raw APDU
 *  bytes - `req.apciIdx` only carries this for the small APCI_EXT_NAMES
 *  subset, so anything else needs deriving it the way parseCEMI() does. */
function fullApci(req: CemiFrame): number {
  if (req.apdu.length < 2) return -1;
  return ((req.apdu[0]! & 0x03) << 8) | req.apdu[1]!;
}

export class KnxLoopbackConnection extends KnxConnection {
  readonly frames: RecordedFrame[] = [];
  // LOCAL TESTING AID ONLY - once set, the device stops answering
  // anything at all from this point on, to exercise the dead-connection
  // abort path live. Not part of the real class's design.
  goSilent = false;
  // LOCAL TESTING AID ONLY - once the device has sent this many real
  // outbound (device->tool) response frames, it goes silent from the
  // NEXT request onward - lets a normal pre-flight/addressing sequence
  // complete first, then loses the connection partway through the real
  // download write loop, exactly like a real dead connection would.
  goSilentAfterResponses: number | null = null;
  private _responsesSent = 0;
  // LOCAL TESTING AID ONLY - per-property override, keyed by
  // `${objIdx}:${propId}`. A Buffer replaces the normal synthesized
  // value; `null` means "no response at all" for that one property
  // specifically (simulating a device that never answers it), without
  // silencing the whole connection.
  propertyOverrides = new Map<string, Buffer | null>();
  // LOCAL TESTING AID ONLY - keyed the same way as propertyOverrides
  // (`${objIdx}:${propId}`). Deliberately answers with WRONG meta bytes
  // (a different objIdx/propId than the one actually asked) instead of
  // echoing the real request back - simulates a genuinely misattributed/
  // out-of-order response, a real failure mode confirmed live: a real
  // Full/Partial Download wrote to the wrong address because a stale
  // response got accepted as the answer to an unrelated request.
  // This class otherwise cannot produce that shape at all (it always
  // echoes the actual incoming request's own objIdx/propId), so this
  // exists purely to exercise propRead()'s own defensive validation
  // against it.
  forceMismatchedMetaFor = new Map<
    string,
    { objIdx: number; propId: number }
  >();
  // LOCAL TESTING AID ONLY - artificial per-response delay (ms), so a
  // human/automated click has time to hit Cancel mid-download. The real
  // class always responds on the same tick (setImmediate); this is
  // purely to make manual testing observable.
  responseDelayMs = 0;
  readonly memoryWrites: RecordedMemoryWrite[] = [];
  private readonly cfg: LoopbackDeviceConfig;
  /** Which objIdx a given PID_TABLE_REFERENCE-resolved base address belongs
   *  to, so a later memory write can be attributed back to the right table -
   *  device memory is one flat address space, `downloadDevice()` never tags
   *  a write with which table it belongs to. */
  private readonly baseToObjIdx = new Map<number, number>();

  constructor(cfg: LoopbackDeviceConfig) {
    super();
    this.cfg = cfg;
    this.connected = true;
    this.localAddr = cfg.localAddr ?? '1.0.1';
    for (const [objIdxStr, base] of Object.entries(cfg.tableBases)) {
      this.baseToObjIdx.set(base, Number(objIdxStr));
    }
  }

  /** Transport hook (see KnxConnection's doc comment) - records the frame,
   *  captures any memory write, then (async via setImmediate, so this call
   *  returns before the simulated device "replies") synthesizes and injects
   *  the next expected protocol response. */
  sendCEMI(cemi: Buffer): Promise<void> {
    const parsed = parseCEMI(cemi);
    this.frames.push({
      direction: 'out',
      cemi: Buffer.from(cemi),
      parsed,
      decoded: describe(parsed),
    });
    if (this.goSilent) return Promise.resolve();
    if (
      this.goSilentAfterResponses != null &&
      this._responsesSent >= this.goSilentAfterResponses
    ) {
      return Promise.resolve();
    }
    if (parsed && parsed.dst === this.cfg.deviceAddr) {
      this._recordMemoryWrite(parsed);
      const resp = this._synthesizeResponse(parsed);
      if (resp) {
        this._responsesSent++;
        const emit = () => {
          this.frames.push({
            direction: 'in',
            cemi: resp.apdu,
            parsed: resp,
            decoded: describe(resp),
          });
          this._onCEMI(resp);
        };
        if (this.responseDelayMs > 0) setTimeout(emit, this.responseDelayMs);
        else setImmediate(emit);
      }
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  private _recordMemoryWrite(req: CemiFrame): void {
    if (req.apciName === 'Memory_Write' && req.apduData.length >= 2) {
      const address = (req.apduData[0]! << 8) | req.apduData[1]!;
      const data = req.apduData.subarray(2);
      this.memoryWrites.push({
        objIdx: this._objIdxForAddress(address),
        address,
        data: Buffer.from(data),
        extended: false,
      });
    } else if (
      fullApci(req) === APCI_EXT.MemoryExtended_Write &&
      req.apduData.length >= 4
    ) {
      const address =
        (req.apduData[1]! << 16) | (req.apduData[2]! << 8) | req.apduData[3]!;
      const data = req.apduData.subarray(4);
      this.memoryWrites.push({
        objIdx: this._objIdxForAddress(address),
        address,
        data: Buffer.from(data),
        extended: true,
      });
    }
  }

  /** Attributes an absolute write address back to the objIdx whose
   *  PID_TABLE_REFERENCE base it falls under - the closest base below
   *  `address` wins (a table write is always `base + offset`, offset >= 0). */
  private _objIdxForAddress(address: number): number | null {
    let best: number | null = null;
    let bestBase = -1;
    for (const [base, objIdx] of this.baseToObjIdx) {
      if (base <= address && base > bestBase) {
        best = objIdx;
        bestBase = base;
      }
    }
    return best;
  }

  /** Reconstructs the currently-known byte content of a table object (GA/
   *  Assoc/Obj3/Param, objIdx 1-4) from every WriteRelMem-equivalent frame
   *  recorded so far, relative to that objIdx's own PID_TABLE_REFERENCE
   *  base - the same real bytes `downloadDevice()` itself just wrote,
   *  reused so PID_MCB_TABLE (property 27) can answer with a REAL
   *  size/checksum instead of a fixed placeholder (see `_propertyValueResponse`'s
   *  own comment on propId 27 for why that placeholder isn't good enough
   *  on its own). Gaps (never written) are 0xAA-filled, matching this
   *  class's other synthesized-content conventions. Returns null if
   *  nothing has been written to this objIdx yet (nothing to reconstruct). */
  private _objMemBuffer(objIdx: number): Buffer | null {
    const base = this.cfg.tableBases[objIdx];
    if (base === undefined) return null;
    let maxEnd = 0;
    for (const w of this.memoryWrites) {
      if (w.objIdx !== objIdx) continue;
      maxEnd = Math.max(maxEnd, w.address + w.data.length - base);
    }
    if (maxEnd <= 0) return null;
    const buf = Buffer.alloc(maxEnd, 0xaa);
    for (const w of this.memoryWrites) {
      if (w.objIdx !== objIdx) continue;
      w.data.copy(buf, w.address - base);
    }
    return buf;
  }

  private _synthesizeResponse(req: CemiFrame): CemiFrame | null {
    const { deviceAddr, localAddr } = this._addrs();

    // ── Classic (4-bit) APCIs ──────────────────────────────────────────
    if (req.apciName === 'DeviceDescriptor_Read') {
      const mask = Buffer.from([
        (this.cfg.mask >> 8) & 0xff,
        this.cfg.mask & 0xff,
      ]);
      return respFrame(
        deviceAddr,
        localAddr,
        apduGroup('DeviceDescriptor_Response', 0, mask),
      );
    }
    if (req.apciName === 'Memory_Write') {
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnected(0, 'Memory_Response'),
      );
    }
    if (req.apciName === 'Restart') {
      // Fire-and-forget - no response is ever waited for on this path.
      return null;
    }

    // ── Extended (10-bit) APCIs - `req.apciIdx` only carries the full
    // 10-bit code for the small subset parseCEMI renames (APCI_EXT_NAMES in
    // knx-cemi.ts: the 4 MemoryExtended_* codes plus
    // Restart_Extended/_Response); everything else (PropertyValue_*,
    // Authorize_*, PropertyDescription_*, FunctionPropertyExtState_Read)
    // stays classified as the generic classic-APCI 'OTHER' bucket
    // (apciIdx=15) - see managementSession()'s waitResponse('OTHER', ...).
    // Disambiguate the way parseCEMI() does internally: recompute the full
    // code from the raw APDU's first two bytes, rather than matching
    // `req.apciIdx` directly (which never fires for those services).
    const full = fullApci(req);
    if (full === APCI_EXT.MemoryExtended_Write) {
      const addr =
        req.apduData.length >= 4
          ? (req.apduData[1]! << 16) |
            (req.apduData[2]! << 8) |
            req.apduData[3]!
          : 0;
      const payload = Buffer.from([
        0x00,
        (addr >> 16) & 0xff,
        (addr >> 8) & 0xff,
        addr & 0xff,
      ]);
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(0, APCI_EXT.MemoryExtended_Write_Response, payload),
      );
    }
    // LOCAL TESTING AID ONLY - Verify (/bus/verify-device) reads memory
    // back to compare against the computed image; this class never
    // answered that at all until now, so Verify always failed against a
    // loopback-connected device with "Management timeout waiting for
    // MemoryExtended_Read_Response", regardless of which device. Answers
    // from this.memoryWrites (already recorded for the dump-writes debug
    // route) - the same real bytes downloadDevice() itself just wrote, so
    // a genuine successful Verify is now reachable end-to-end without
    // hardware. Anything never written (or a device with no download
    // history at all) reads back as 0xAA fill, same convention as every
    // other synthesized property in this class.
    if (full === APCI_EXT.MemoryExtended_Read) {
      const count = req.apduData[0] ?? 0;
      const addr =
        req.apduData.length >= 4
          ? (req.apduData[1]! << 16) |
            (req.apduData[2]! << 8) |
            req.apduData[3]!
          : 0;
      const buf = Buffer.alloc(count, 0xaa);
      for (const w of this.memoryWrites) {
        const wStart = w.address;
        const wEnd = w.address + w.data.length;
        const rStart = addr;
        const rEnd = addr + count;
        const start = Math.max(wStart, rStart);
        const end = Math.min(wEnd, rEnd);
        if (start < end) {
          w.data.copy(buf, start - rStart, start - wStart, end - wStart);
        }
      }
      const payload = Buffer.concat([
        Buffer.from([
          0x00,
          (addr >> 16) & 0xff,
          (addr >> 8) & 0xff,
          addr & 0xff,
        ]),
        buf,
      ]);
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(0, APCI_EXT.MemoryExtended_Read_Response, payload),
      );
    }
    if (full === APCI_EXT.PropertyValue_Read) {
      const objIdx = req.apduData[0] ?? 0;
      const propId = req.apduData[1] ?? 0;
      const key = `${objIdx}:${propId}`;
      if (this.propertyOverrides.has(key)) {
        const override = this.propertyOverrides.get(key)!;
        if (override === null) return null;
        const startIndex = req.apduData.length >= 4 ? req.apduData[3]! : 1;
        const meta = Buffer.from([objIdx, propId, 0x10, startIndex]);
        return respFrame(
          deviceAddr,
          localAddr,
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([meta, override]),
          ),
        );
      }
      return this._propertyValueResponse(req, deviceAddr, localAddr);
    }
    if (full === APCI_EXT.PropertyValue_Write) {
      // The orchestrator never inspects a property-write response's content,
      // only that one arrives (propWrite()'s `waitResponse('OTHER', 3000)`)
      // - echo the request's own meta bytes back as a generic ack.
      const meta = req.apduData.subarray(0, 4);
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, meta),
      );
    }
    if (full === APCI_EXT.PropertyDescription_Read) {
      // Informational-only; content irrelevant to the orchestration under
      // test, same "satisfies the minimum-length check" convention as every
      // unconfigured property response.
      const meta = req.apduData.subarray(0, 3);
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(
          0,
          APCI_EXT.PropertyDescription_Response,
          Buffer.concat([meta, Buffer.alloc(4, 0xaa)]),
        ),
      );
    }
    if (full === APCI_EXT.FunctionPropertyExtState_Read) {
      // Reports Security Mode 0 (disabled) - the only value this stub needs.
      const meta = req.apduData.subarray(0, 5);
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(
          0,
          APCI_EXT.FunctionPropertyExt_Response,
          Buffer.concat([meta, Buffer.from([0x00, 0x00, 0x00, 0x00])]),
        ),
      );
    }
    if (full === APCI_EXT.Authorize_Request) {
      // Single access-level byte, 0 = full access.
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
    }
    if (full === APCI_EXT.Restart_Extended) {
      // RestartResp $000000 (no error).
      return respFrame(
        deviceAddr,
        localAddr,
        apduConnectedFull(
          0,
          APCI_EXT.Restart_Extended_Response,
          Buffer.from([0x00, 0x00, 0x00]),
        ),
      );
    }
    return null;
  }

  /** PropertyValue_Read responder. propId 7 (PID_TABLE_REFERENCE) and propId
   *  11 (PID_SERIAL_NUMBER, on objIdx 0) get config-sourced values; every
   *  other property gets a dummy buffer (0xAA fill) that satisfies the
   *  minimum-length check, content otherwise irrelevant. */
  private _propertyValueResponse(
    req: CemiFrame,
    deviceAddr: string,
    localAddr: string,
  ): CemiFrame {
    const objIdx = req.apduData[0] ?? 0;
    const propId = req.apduData[1] ?? 0;
    // Real request layout (apduPropertyValueRead(), knx-cemi.ts): byte[2]'s
    // top 4 bits are the element count, its bottom 4 bits are startIndex's
    // high bits; byte[3] is startIndex's low byte. Only propId 27 below
    // actually varies its response by count today (a multi-element
    // PID_MCB_TABLE read, used by the final pre-Restart verification check
    // for an app that declares more than one P=27 write step) - every
    // other property here has only ever been requested as one element, so
    // reading count for them would be a no-op in practice.
    const meta2 = req.apduData.length >= 3 ? req.apduData[2]! : 0x10;
    const count = Math.max(1, meta2 >> 4);
    const startIndex =
      req.apduData.length >= 4 ? ((meta2 & 0x0f) << 8) | req.apduData[3]! : 1;
    let value: Buffer;
    if (propId === 7) {
      const base = this.cfg.tableBases[objIdx] ?? 0;
      value = Buffer.from([
        (base >> 24) & 0xff,
        (base >> 16) & 0xff,
        (base >> 8) & 0xff,
        base & 0xff,
      ]);
    } else if (propId === 11 && objIdx === 0) {
      value = Buffer.from(this.cfg.serial, 'hex');
    } else if (
      propId === 12 &&
      objIdx === 0 &&
      this.cfg.manufacturerId !== undefined
    ) {
      value = Buffer.from([
        (this.cfg.manufacturerId >> 8) & 0xff,
        this.cfg.manufacturerId & 0xff,
      ]);
    } else if (
      propId === 78 &&
      objIdx === 0 &&
      this.cfg.hardwareType !== undefined
    ) {
      value = this.cfg.hardwareType;
    } else if (
      propId === 13 &&
      objIdx === 4 &&
      this.cfg.programVersion !== undefined
    ) {
      // Application Program object (OX=4), not the Device object - matches
      // what real devices actually answer, and what this codebase's own
      // PID_PROGRAM_VERSION write-back fix reads/writes.
      value = this.cfg.programVersion;
    } else if (propId === 5) {
      // PID_LOAD_STATE_CONTROL - real downloadDevice() pre-checks read this
      // for an object it isn't about to (re)load itself (e.g. Object 5/PEI
      // Program on an app with no real PEI content) and refuse to proceed
      // unless it reads back exactly $00 ("idle/unloaded", the only state
      // with no ambiguity about what to do next) - the generic 0xAA fill
      // this class otherwise answers with fails that check on every such
      // app, blocking a real loopback test before it can even begin. A
      // fresh/never-loaded object genuinely reports $00 on real hardware.
      value = Buffer.from([0x00]);
    } else if (propId === 27) {
      // PID_MCB_TABLE - real 8-byte-per-element shape (size @ [2:4] BE16,
      // byte 5 = the memory-write-service signal byte this codebase reads
      // live, checksum @ [6:8] BE16 - see parseMcbTableElement(),
      // knx-connection.ts). A fixed placeholder for every objIdx/element is
      // enough to satisfy the live partial-download checksum gate (which
      // tolerates any mismatch by falling back to a full write) but not the
      // separate final pre-Restart verification read (downloadDevice(),
      // knx-connection.ts), which re-reads this property after writing and
      // expects it to reflect what was actually just written - a fixed
      // value spuriously fails that check regardless of correctness.
      // Reconstructed instead from this.memoryWrites - the same bytes
      // downloadDevice() itself just wrote - whenever this objIdx has
      // recorded any; falls back to the placeholder for an objIdx nothing
      // has written to yet.
      //
      // Known remaining gap: a multi-element read (count > 1, used by an
      // app that declares more than one P=27 write step for the SAME
      // objIdx, each covering a different real sub-range) answers every
      // element with the SAME whole-object checksum, not the real
      // per-sub-range split (this class has no way to know that split -
      // it's driven by the app's own declared LoadImageProp payload, not
      // by anything reconstructable from raw memory writes alone).
      const real = this._objMemBuffer(objIdx);
      const size = real ? real.length : 0xe000;
      const checksum = real ? crc16Knx(real) : 0x6250;
      const element = Buffer.from([
        0x00,
        0x02,
        (size >> 8) & 0xff,
        size & 0xff,
        0x00,
        this.cfg.mcbByte5 ?? 0x33,
        (checksum >> 8) & 0xff,
        checksum & 0xff,
      ]);
      value = Buffer.concat(Array.from({ length: count }, () => element));
    } else {
      value = Buffer.alloc(10, 0xaa);
    }
    const mismatch = this.forceMismatchedMetaFor.get(`${objIdx}:${propId}`);
    const meta = mismatch
      ? Buffer.from([mismatch.objIdx, mismatch.propId, 0x10, startIndex])
      : Buffer.from([objIdx, propId, 0x10, startIndex]);
    return respFrame(
      deviceAddr,
      localAddr,
      apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([meta, value]),
      ),
    );
  }

  private _addrs(): { deviceAddr: string; localAddr: string } {
    return {
      deviceAddr: this.cfg.deviceAddr,
      localAddr: this.localAddr || '1.0.1',
    };
  }
}

function describe(f: CemiFrame | null): string {
  if (!f) return '(unparseable)';
  return `${f.src}->${f.dst} ${f.apciName ?? '?'}${f.apciIdx != null ? ` (0x${f.apciIdx.toString(16)})` : ''} [${f.apduData.toString('hex')}]`;
}

// Re-exported so a CLI script doesn't need its own import of `delay` from
// knx-connection.ts to add a settle pause after construction.
export { delay };
