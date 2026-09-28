/**
 * Protocol-level tests for DownloadExtra.mode='partial' (knx-connection.ts's
 * downloadDevice()). Partial mode is driven by DownloadExtra.pendingWriteRanges
 * - an edit log (device_pending_changes, resolved upstream in routes/bus.ts)
 * names exactly which byte ranges to write, with no device read/diff involved.
 *
 * Uses a protocol-level "virtual device" (subclasses KnxConnection, intercepts
 * sendCEMI, answers both reads and writes against its own backing buffer) to
 * prove the skip-when-nothing-pending and mode-byte logic deterministically
 * without hardware.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  parseCEMI,
  buildCEMI,
  apduConnectedFull,
  apduGroup,
  APCI_EXT,
  TPCI,
} from '../server/knx-cemi.ts';
import { KnxConnection, crc16Knx } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';
import { saveMasterXml, DATA_DIR } from '../server/routes/shared.ts';
import { clearMaskProcedureCache } from '../server/knx-mask-procedures.ts';

/**
 * Fake device answering DeviceDescriptor_Read (System B, mask 0x07B0),
 * Authorize_Request, PropertyValue_Write (LSM/load-state transitions -
 * always accepted, no real state machine simulated), PropertyValue_Read
 * (from a configurable per-objIdx/propId property store), Memory_Read/
 * MemoryExtended_Read, and Memory_Write/MemoryExtended_Write - both memory
 * services apply to and read back from a shared backing buffer.
 */
class FakeRWMemoryDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory: Buffer;
  /** objIdx:propId -> response data. Unconfigured reads get NO response at
   * all (matches real device behavior for e.g. an unallocated
   * PID_TABLE_REFERENCE, per writeUndeclaredTable()'s own "unallocated -
   * skipping write" handling) rather than an empty/zero value. */
  properties = new Map<string, Buffer>();
  /** objIdx -> {base, length, signalByte} for a P=27 (PID_MCB_TABLE) read
   *  computed LIVE from the current backing buffer content, rather than a
   *  fixed setProperty() value - takes precedence over `properties` when
   *  configured. Added alongside the final pre-Restart
   *  verification's own live CRC-mismatch detection: that check needs a
   *  fake device whose checksum genuinely reflects what was actually
   *  written (mismatches before a real write, matches after
   *  one), which a single fixed setProperty() value can't represent -
   *  real hardware's own PID_MCB_TABLE naturally updates the same way. */
  private live27 = new Map<
    number,
    { base: number; length: number; signalByte: number }
  >();
  private readonly deviceAddr: string;
  constructor(deviceAddr: string, memory: Buffer) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
    // PID_MAX_APDULENGTH (property 56, objIdx 0): downloadDevice() resolves
    // this once per session (_resolveMaxApduLength()) for the chunk-size
    // ceiling. Defaulted generously so it never caps this file's sizes;
    // override via setProperty() to test capping/fallback explicitly.
    this.setProperty(0, 56, Buffer.from([0x03, 0xe8])); // 1000
  }

  /** Configure this fake device to answer a PropertyValue_Read for (objIdx, propId) with `data`. */
  setProperty(objIdx: number, propId: number, data: Buffer): void {
    this.properties.set(`${objIdx}:${propId}`, data);
  }

  /** objIdx:propId -> live MaxNrOfElements to answer a
   * PropertyDescription_Read with (real KNX PropertyDescription_Response
   * shape: [ObjIdx][PropId][PX][T][MaxNrOfElem:2][R/W]). Unconfigured reads
   * get no response at all, matching `properties` above. */
  descriptors = new Map<string, number>();

  /** Configure this fake device to answer a PropertyDescription_Read for
   * (objIdx, propId) with a given live MaxNrOfElements (12-bit field). */
  setDescriptorMaxNrOfElements(
    objIdx: number,
    propId: number,
    maxNrOfElements: number,
  ): void {
    this.descriptors.set(`${objIdx}:${propId}`, maxNrOfElements);
  }

  /** Configure this fake device to answer P=27 (PID_MCB_TABLE) for `objIdx`
   *  with a checksum computed LIVE from `this.memory[base..base+length)` on
   *  every read - see the `live27` field's own comment for why. Takes
   *  precedence over a static setProperty(objIdx, 27, ...) value. */
  setLiveProp27(
    objIdx: number,
    base: number,
    length: number,
    signalByte = 0x33,
  ): void {
    this.live27.set(objIdx, { base, length, signalByte });
  }

  /** objIdx:propId -> remaining "drop this read" count, for simulating a
   *  transient lost frame - see `setFlakyProperty()`. */
  private flaky = new Map<string, number>();

  /** Configure a PropertyValue_Read for (objIdx, propId) to silently drop
   *  the first `dropCount` reads (as if the frame or its response were
   *  lost) before answering normally with the value already configured via
   *  setProperty()/setLiveProp27(). Used to test propReadFinal()'s own
   *  retry-hardening: a real device occasionally missing one frame should
   *  not, by itself, withhold Restart. */
  setFlakyProperty(objIdx: number, propId: number, dropCount: number): void {
    this.flaky.set(`${objIdx}:${propId}`, dropCount);
  }

  private reply(respApdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.from([0x07, 0xb0]);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }

    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    if (fullApci === 0x3d1 /* Authorize_Request */) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
      return Promise.resolve();
    }
    // PropertyValue_Write (0x3D7): downloadDevice() waits for any non-error
    // reply to unblock (see propWrite/lsmWrite); this echoes a minimal
    // PropertyValue_Response-shaped frame without decoding it.
    if (fullApci === 0x3d7) {
      const word = (TPCI.DATA_CONNECTED << 10) | 0x3d5;
      this.reply(Buffer.from([(word >> 8) & 0xff, word & 0xff, 0, 0, 0]));
      return Promise.resolve();
    }
    // PropertyValue_Read (0x3D5) - answered from `this.properties`. An
    // unconfigured property gets no response, matching an unallocated
    // property on real hardware (propRead() treats that as null).
    if (fullApci === 0x3d5) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const meta = frame.apduData.subarray(2, 4);
      const flakyKey = `${objIdx}:${propId}`;
      const remaining = this.flaky.get(flakyKey);
      if (remaining && remaining > 0) {
        this.flaky.set(flakyKey, remaining - 1);
        return Promise.resolve(); // simulate a lost frame - no reply at all
      }
      const live = propId === 27 ? this.live27.get(objIdx) : undefined;
      const data = live
        ? buildMcb(
            live.length,
            live.signalByte,
            crc16Knx(this.memory.subarray(live.base, live.base + live.length)),
          )
        : this.properties.get(`${objIdx}:${propId}`);
      if (data) {
        const word =
          ((TPCI.DATA_CONNECTED << 10) | APCI_EXT.PropertyValue_Response) &
          0xffff;
        this.reply(
          Buffer.concat([
            Buffer.from([(word >> 8) & 0xff, word & 0xff, objIdx, propId]),
            meta,
            data,
          ]),
        );
      }
      return Promise.resolve();
    }

    // PropertyDescription_Read (0x3D8) - answered from `this.descriptors`,
    // set via setDescriptorMaxNrOfElements(). No response at all if
    // unconfigured, same convention as PropertyValue_Read above.
    if (fullApci === APCI_EXT.PropertyDescription_Read) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const maxNrOfElements = this.descriptors.get(`${objIdx}:${propId}`);
      if (maxNrOfElements !== undefined) {
        const value = Buffer.from([
          objIdx,
          propId,
          0x03, // PX
          0x14, // T (PDT code)
          (maxNrOfElements >> 8) & 0x0f,
          maxNrOfElements & 0xff,
          0x32, // R/W, packed
        ]);
        this.reply(
          apduConnectedFull(0, APCI_EXT.PropertyDescription_Response, value),
        );
      }
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = this.memory.subarray(address, address + count);
      const word =
        (TPCI.DATA_CONNECTED << 10) | (9 /* Memory_Response */ << 6) | count;
      this.reply(
        Buffer.concat([
          Buffer.from([
            (word >> 8) & 0xff,
            word & 0xff,
            (address >> 8) & 0xff,
            address & 0xff,
          ]),
          data,
        ]),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'MemoryExtended_Read') {
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const data = this.memory.subarray(address, address + count);
      const word =
        ((TPCI.DATA_CONNECTED << 10) | APCI_EXT.MemoryExtended_Read_Response) &
        0xffff;
      this.reply(
        Buffer.concat([
          Buffer.from([
            (word >> 8) & 0xff,
            word & 0xff,
            0x00,
            (address >> 16) & 0xff,
            (address >> 8) & 0xff,
            address & 0xff,
          ]),
          data,
        ]),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'Memory_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 8) | frame.apduData[2]!;
      frame.apduData.subarray(3, 3 + count).copy(this.memory, address);
      // downloadDevice()'s write loop waits for each chunk's response
      // before sending the next; omitting this would stall on the timeout.
      this.reply(apduGroup('Memory_Response', 0, frame.apduData));
    } else if (frame.apciName === 'MemoryExtended_Write') {
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      frame.apduData.subarray(4, 4 + count).copy(this.memory, address);
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.MemoryExtended_Write_Response,
          Buffer.alloc(0),
        ),
      );
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every LoadData (PropertyValue_Write, PID_LOAD_STATE_CONTROL event=0x03) frame's decoded mode byte, in order. */
  loadDataModeBytes(): number[] {
    const out: number[] = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const fullApci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (fullApci !== 0x3d7) continue;
      // apduData layout: [objIdx][propId][count/startIdx:2][event][SCF][rsvd:2][size:2][mode][fill][rsvd:2]
      // - 4-byte meta header + 10-byte LSM payload; mode byte at index 10.
      const event = f.apduData[4];
      if (event === 0x03) out.push(f.apduData[10]!); // event=LOAD_DATA, mode byte
    }
    return out;
  }

  /** Every Memory_Write/MemoryExtended_Write frame sent (for asserting skip vs write). */
  writeCount(): number {
    return this.sent.filter((c) => {
      const f = parseCEMI(c);
      return (
        f &&
        (f.apciName === 'Memory_Write' || f.apciName === 'MemoryExtended_Write')
      );
    }).length;
  }

  /** Every PropertyValue_Read P=27 (PID_MCB_TABLE) request, in the exact
   *  order it was sent - `{ objIdx, index }` pairs, `index` being the
   *  position in `sent`. A given objIdx can appear more than once (the
   *  checksum-gated skip logic already reads P=27 EARLY, before Unload,
   *  for objIdx 1/2/3 - this returns every occurrence, not just the final
   *  one, so a test can tell them apart by position). */
  p27ReadEvents(): Array<{ objIdx: number; index: number }> {
    const out: Array<{ objIdx: number; index: number }> = [];
    this.sent.forEach((c, i) => {
      const f = parseCEMI(c);
      if (!f) return;
      const fullApci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (fullApci === 0x3d5 && f.apduData[1] === 27)
        out.push({ objIdx: f.apduData[0]!, index: i });
    });
    return out;
  }

  /** Index of the Restart frame - `null` if none was sent. */
  restartIndex(): number | null {
    for (let i = 0; i < this.sent.length; i++) {
      const f = parseCEMI(this.sent[i]!);
      if (f?.apciName === 'Restart' || f?.apciName === 'Restart_Extended')
        return i;
    }
    return null;
  }
}

describe("downloadDevice() mode='partial'", () => {
  const BASE = 0x5f0e; // within 16 bits, matches 1.1.9's real relmem base shape

  it('skips the object entirely when nothing is pending for it (no Unload/StartLoading/LoadData/write, no read either)', async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000); // deliberately left all-zero - genuinely differs from payload
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: BASE },
        mode: 'partial',
        pendingWriteRanges: {}, // nothing tracked for objIdx 4
      },
    );

    assert.equal(
      dev.writeCount(),
      0,
      'no Memory_Write/MemoryExtended_Write should have been sent',
    );
    assert.equal(
      dev.loadDataModeBytes().length,
      0,
      'no LoadData step should have been sent either - the whole cycle was skipped',
    );
  });

  it('writes (with the real Partial mode byte 0x00) exactly the pending-write-range bytes, nothing more', async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000); // starts all-zero
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: BASE },
        mode: 'partial',
        pendingWriteRanges: { 4: [{ offset: 0, length: payload.length }] },
      },
    );

    assert.ok(
      dev.writeCount() > 0,
      'expected real write chunks - a range was tracked as pending',
    );
    assert.deepEqual(
      dev.loadDataModeBytes(),
      [0x00],
      'partial mode must force the LoadData mode byte to 0x00 (real captured Partial semantic), not the model-declared combined shape',
    );
    assert.deepEqual(
      [...dev.memory.subarray(BASE, BASE + payload.length)],
      [...payload],
    );
  });

  it("mode='full' (the default) is completely unaffected - always writes, mode byte follows the model's own declared combined shape", async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000);
    payload.copy(backing, BASE); // device ALREADY matches - full mode must still write anyway
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    // Two RelSegment steps for the same lsmIdx makes relSegByObj compute
    // combined=true, so the mode byte genuinely follows the declared shape
    // rather than coincidentally landing on 0.
    const relSegFull: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const relSegPar: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    // mode omitted entirely - exercises the real default, not an explicit 'full'.
    await dev.downloadDevice(
      '1.1.9',
      [relSegFull, relSegPar, write],
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: BASE },
      },
    );

    assert.ok(
      dev.writeCount() > 0,
      'full mode must always write, even if the device already matches',
    );
    assert.deepEqual(
      dev.loadDataModeBytes(),
      [0x01],
      'a combined (full+par) RelSegment declaration must still produce mode=Full (0x01) unchanged in full mode',
    );
  });
});

describe("downloadDevice() sequencing: WriteProp deferred to its own object's load phase, content written in descending objIdx order", () => {
  const BASE4 = 0x1000;
  const BASE1 = 0x2000;

  it("WriteProp(4,27) fires after ObjIdx=4's own StartLoading+LoadData, not upfront before any Unload", async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg4: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write4: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    const writeProp: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(10), // matches the real 10-byte declared InlineData shape (trimmed to 8 on write)
    };
    const relSeg1: DownloadStep = {
      type: 'RelSegment',
      objIdx: 1,
      propId: 0,
      lsmIdx: 1,
      size: 4,
      fill: 0,
    };
    const write1: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 1,
      propId: 0,
      size: 4,
      offset: 0,
    };

    const progress: string[] = [];
    await dev.downloadDevice(
      '1.1.9',
      [relSeg4, write4, writeProp, relSeg1, write1],
      null,
      null,
      payload,
      (p) => progress.push(p.msg),
      { resolvedBases: { 4: BASE4, 1: BASE1 } },
    );

    const loadData4 = progress.findIndex(
      (m) => m === 'LoadData ObjIdx=4 Size=8 (param obj 4)',
    );
    // Match only the "(deferred..." log from the loadOrder loop (the actual
    // send), not the unconditional logDebug fired when the step is first
    // collected into relmemJobs.
    const writePropIdx = progress.findIndex(
      (m) =>
        m.includes('WriteProp ObjIdx=4 PropId=27') && m.includes('deferred'),
    );
    const startLoading1 = progress.findIndex(
      (m) => m === 'StartLoading ObjIdx=1 (param obj 1)',
    );
    const firstUnload = progress.findIndex((m) =>
      m.startsWith('Unload ObjIdx='),
    );

    assert.notEqual(loadData4, -1, 'expected a LoadData log line for objIdx 4');
    assert.notEqual(
      writePropIdx,
      -1,
      'expected a deferred WriteProp log line for objIdx 4 propId 27',
    );
    assert.ok(
      writePropIdx > loadData4,
      "WriteProp(4,27) must fire AFTER objIdx 4's own StartLoading+LoadData, not before",
    );
    assert.ok(
      firstUnload !== -1 && writePropIdx > firstUnload,
      'WriteProp(4,27) must not fire before Unload has even begun',
    );
    assert.ok(
      startLoading1 === -1 || writePropIdx < startLoading1,
      "WriteProp(4,27) belongs to objIdx 4's own load phase, before StartLoading begins for the next object",
    );
  });

  it('writes object content in descending objIdx order (4 before 1), matching real ETS', async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg4: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write4: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    const relSeg1: DownloadStep = {
      type: 'RelSegment',
      objIdx: 1,
      propId: 0,
      lsmIdx: 1,
      size: 4,
      fill: 0,
    };
    const write1: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 1,
      propId: 0,
      size: 4,
      offset: 0,
    };

    const progress: string[] = [];
    // Steps declared ascending (1 before 4) - write order must still come
    // out descending, proving it follows ETS convention, not declaration order.
    await dev.downloadDevice(
      '1.1.9',
      [relSeg1, write1, relSeg4, write4],
      null,
      null,
      payload,
      (p) => progress.push(p.msg),
      { resolvedBases: { 4: BASE4, 1: BASE1 } },
    );

    // "(param obj N)" only appears on the actual chunk-write progress
    // message; the plain "WriteRelMem ObjIdx=N Size=..." line is the
    // step-collection log and follows declaration order, not write order.
    const firstWrite4 = progress.findIndex(
      (m) => m.startsWith('WriteRelMem ObjIdx=4') && m.includes('(param obj'),
    );
    const firstWrite1 = progress.findIndex(
      (m) => m.startsWith('WriteRelMem ObjIdx=1') && m.includes('(param obj'),
    );

    assert.notEqual(firstWrite4, -1);
    assert.notEqual(firstWrite1, -1);
    assert.ok(
      firstWrite4 < firstWrite1,
      "objIdx 4's own content must be written before objIdx 1's, regardless of step declaration order",
    );
  });

  it('with a real mask-Procedure source available (extra.projectId + real master data), the mask-driven path actually engages and reproduces the identical descending order', async () => {
    // Regression guard for knx-mask-procedures.ts's wiring: supplies real
    // knx_master_1.xml (mask 0x07B0, System B) via a saved project id to
    // force the mask-driven path (vs. the hand-written descending-by-objIdx
    // fallback the other tests exercise) and confirms it produces the same order.
    const masterXmlPath = 'data/knx_master_1.xml';
    if (!fs.existsSync(masterXmlPath)) return; // real master data not present in this checkout
    const projectId = `test_maskproc_wiring_${Date.now()}`;
    saveMasterXml(projectId, fs.readFileSync(masterXmlPath, 'utf8'));
    try {
      const payload = Buffer.from('deadbeefcafef00d', 'hex');
      const backing = Buffer.alloc(0x10000);
      const dev = new FakeRWMemoryDevice('1.1.9', backing);

      const relSeg4: DownloadStep = {
        type: 'RelSegment',
        objIdx: 4,
        propId: 0,
        lsmIdx: 4,
        size: payload.length,
        fill: 0,
      };
      // Mask 07B0's Load:all Procedure declares the GA/Association/Object-3
      // WriteRelMem steps directly (ETS always writes those regardless of
      // the app), but reserves a splice point (MergeId=4) for the
      // application-specific parameter-object write, right before its own
      // WriteRelMem(3,2,1) sequence. Setting mergeId here exercises that
      // real splice rather than relying on the step happening to have none.
      const write4: DownloadStep = {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
        mergeId: 4,
      };
      const relSeg1: DownloadStep = {
        type: 'RelSegment',
        objIdx: 1,
        propId: 0,
        lsmIdx: 1,
        size: 4,
        fill: 0,
      };
      const write1: DownloadStep = {
        type: 'WriteRelMem',
        objIdx: 1,
        propId: 0,
        size: 4,
        offset: 0,
      };

      const progress: string[] = [];
      await dev.downloadDevice(
        '1.1.9',
        [relSeg1, write1, relSeg4, write4],
        null,
        null,
        payload,
        (p) => progress.push(p.msg),
        { resolvedBases: { 4: BASE4, 1: BASE1 }, projectId },
      );

      const engaged = progress.some((m) =>
        m.includes('Real download sequence resolved from mask 07b0'),
      );
      assert.ok(
        engaged,
        'expected the mask-driven path to actually engage for this real project id/mask - if this fails, the test is silently exercising the fallback instead of what it means to test',
      );

      const firstWrite4 = progress.findIndex(
        (m) => m.startsWith('WriteRelMem ObjIdx=4') && m.includes('(param obj'),
      );
      const firstWrite1 = progress.findIndex(
        (m) => m.startsWith('WriteRelMem ObjIdx=1') && m.includes('(param obj'),
      );
      assert.notEqual(firstWrite4, -1);
      assert.notEqual(firstWrite1, -1);
      assert.ok(
        firstWrite4 < firstWrite1,
        'the mask-driven order must match the same real descending (4 before 1) order the fallback produces',
      );

      const firstUnload4 = progress.findIndex(
        (m) => m === 'Unload ObjIdx=4 (param obj 4)',
      );
      const firstUnload1 = progress.findIndex(
        (m) => m === 'Unload ObjIdx=1 (param obj 1)',
      );
      assert.notEqual(firstUnload4, -1);
      assert.notEqual(firstUnload1, -1);
      assert.ok(
        firstUnload4 < firstUnload1,
        'Unload order must also be descending (4 before 1) under the mask-driven path',
      );
    } finally {
      clearMaskProcedureCache(projectId);
      try {
        fs.unlinkSync(path.join(DATA_DIR, `knx_master_${projectId}.xml`));
      } catch {
        /* nothing to clean up */
      }
    }
  });
});

describe('FakeRWMemoryDevice.setProperty() - PropertyValue_Read support', () => {
  // Exercises writeUndeclaredTable()'s PID_TABLE_REFERENCE (property 7)
  // resolution for objIdx 1 (the GA table).
  const GA_TABLE_BASE = 0x4000;

  it('resolves the real base via a configured property and writes the GA table there (full mode)', async () => {
    const gaTable = Buffer.from('000249014905', 'hex'); // [count=2][9/1/1][9/1/5]
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00])); // PID_TABLE_REFERENCE -> 0x4000

    await dev.downloadDevice('1.1.9', [], gaTable, null, null, undefined, {});

    assert.deepEqual(
      [...dev.memory.subarray(GA_TABLE_BASE, GA_TABLE_BASE + gaTable.length)],
      [...gaTable],
      'the GA table should land at the address resolved from the configured PID 7 property',
    );
  });

  it('an unconfigured property (no PropertyValue_Response at all) is treated as unallocated - no write attempted', async () => {
    const gaTable = Buffer.from('000249014905', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    // No setProperty() call - PID 7 goes unanswered, matching a real
    // device reporting an unallocated segment.

    await dev.downloadDevice('1.1.9', [], gaTable, null, null, undefined, {});

    assert.equal(
      dev.writeCount(),
      0,
      "no write should be attempted when the base can't be resolved",
    );
  });

  it('partial mode: skips the GA table entirely when nothing is pending for objIdx 1 (no PID 7 resolution even attempted)', async () => {
    const gaTable = Buffer.from('000249014905', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    // Not configured via setProperty() - the intent is skip-before-any-
    // round-trip, not merely "no write lands"; if PID 7 resolution were
    // attempted here it would go unanswered.

    await dev.downloadDevice('1.1.9', [], gaTable, null, null, undefined, {
      mode: 'partial',
      pendingWriteRanges: {},
    });

    assert.equal(
      dev.writeCount(),
      0,
      'partial mode should skip the whole cycle when nothing is pending for this object',
    );
  });

  it('partial mode: writes the GA table when a ga_link change is pending, resolving the base via PID 7 as normal', async () => {
    const gaTable = Buffer.from('000249014905', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));

    await dev.downloadDevice('1.1.9', [], gaTable, null, null, undefined, {
      mode: 'partial',
      pendingWriteRanges: { 1: [{ offset: 0, length: gaTable.length }] },
    });

    assert.deepEqual(
      [...dev.memory.subarray(GA_TABLE_BASE, GA_TABLE_BASE + gaTable.length)],
      [...gaTable],
      'the GA table should still land at the address resolved from the configured PID 7 property',
    );
  });
});

describe("downloadDevice() mode='partial' surgical write", () => {
  const BASE = 0x5f0e;

  it('writes only the pending-write-range bytes, not the whole object, for a single tracked change in a large buffer', async () => {
    // A large (1000-byte) object with one tracked 2-byte pending range
    // produces exactly one small write, not ~5 chunks (Math.ceil(1000/228))
    // for a full rewrite of this size.
    const size = 1000;
    const target = Buffer.alloc(size);
    for (let i = 0; i < size; i++) target[i] = i % 256;
    const backing = Buffer.alloc(0x10000); // device starts genuinely different - irrelevant now, never read
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      target,
      undefined,
      {
        resolvedBases: { 4: BASE },
        mode: 'partial',
        pendingWriteRanges: { 4: [{ offset: 500, length: 2 }] },
      },
    );

    assert.equal(
      dev.writeCount(),
      1,
      'expected exactly one small write covering the tracked 2-byte range, not ~5 chunks for a full 1000-byte rewrite',
    );
    // Only the tracked range actually lands on the device - surgical
    // writing must never write bytes outside what was tracked as pending.
    assert.deepEqual(
      [...dev.memory.subarray(BASE + 500, BASE + 502)],
      [...target.subarray(500, 502)],
    );
    assert.deepEqual(
      [...dev.memory.subarray(BASE, BASE + 500)],
      [...Buffer.alloc(500)],
      'bytes outside the tracked range must be untouched, still zero',
    );
  });

  it('writes multiple separate regions when multiple pending-write-ranges are given', async () => {
    const size = 1000;
    const target = Buffer.alloc(size);
    for (let i = 0; i < size; i++) target[i] = i % 256;
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      target,
      undefined,
      {
        resolvedBases: { 4: BASE },
        mode: 'partial',
        pendingWriteRanges: {
          4: [
            { offset: 10, length: 1 }, // near the start
            { offset: 900, length: 1 }, // near the end, a separate region
          ],
        },
      },
    );

    assert.equal(
      dev.writeCount(),
      2,
      'two separate tracked ranges should produce two separate small writes',
    );
    assert.deepEqual(
      [dev.memory[BASE + 10], dev.memory[BASE + 900]],
      [target[10], target[900]],
    );
  });
});

/** Association-table wire format (buildAssocTable, routes/knx-tables.ts):
 * a leading 2-byte entry count followed by 4 bytes per entry. */
function assocTableWithCount(count: number): Buffer {
  const buf = Buffer.alloc(2 + count * 4);
  buf.writeUInt16BE(count, 0);
  return buf;
}

describe('downloadDevice() - live Association-table capacity check (PropertyDescription_Read ObjIdx=2 PropId=23)', () => {
  it('proceeds normally when the real entry count is within the live-reported MaxNrOfElements', async () => {
    const backing = Buffer.alloc(0x20000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    dev.setDescriptorMaxNrOfElements(2, 23, 1600);
    // GA/Association tables resolve their write base via a live
    // PID_TABLE_REFERENCE (P=7) read, not `resolvedBases` (that only feeds
    // the parameter object, objIdx 4); base 0 reads as unallocated.
    dev.setProperty(1, 7, Buffer.from([0x00, 0x01, 0x00, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x02, 0x00, 0x00]));

    const assocTable = assocTableWithCount(4); // well within 1600
    const gaTable = Buffer.from([0x00, 0x00]);

    await dev.downloadDevice(
      '1.1.9',
      [],
      gaTable,
      assocTable,
      null,
      undefined,
      {
        mode: 'full',
      },
    );

    assert.equal(
      dev.writeCount() > 0,
      true,
      'the Association table should have actually been written',
    );
  });

  it('refuses the download (throws) when the real entry count exceeds the live-reported MaxNrOfElements, even when a caller-supplied table would otherwise pass a larger static declaration', async () => {
    const backing = Buffer.alloc(0x20000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    // An app may statically declare a larger MaxEntries than the device
    // itself live-reports.
    dev.setDescriptorMaxNrOfElements(2, 23, 255);

    const assocTable = assocTableWithCount(280); // exceeds the LIVE 255
    const gaTable = Buffer.from([0x00, 0x00]);

    await assert.rejects(
      () =>
        dev.downloadDevice('1.1.10', [], gaTable, assocTable, null, undefined, {
          mode: 'full',
        }),
      /Association table needs 280 real entries.*maximum of 255/,
      'should refuse with a clear message naming both the real need and the live-reported ceiling',
    );
    assert.equal(
      dev.writeCount(),
      0,
      'must refuse before writing anything, not after a partial write',
    );
  });

  it('proceeds without a capacity check when the device gives no PropertyDescription_Read response at all', async () => {
    const backing = Buffer.alloc(0x20000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    // No setDescriptorMaxNrOfElements() call - the fake device answers
    // nothing for ObjIdx=2/PropId=23, matching an app/mask that never
    // declares this property.
    dev.setProperty(1, 7, Buffer.from([0x00, 0x01, 0x00, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x02, 0x00, 0x00]));
    const assocTable = assocTableWithCount(9000); // would exceed any realistic real capacity
    const gaTable = Buffer.from([0x00, 0x00]);

    await dev.downloadDevice(
      '1.1.9',
      [],
      gaTable,
      assocTable,
      null,
      undefined,
      {
        mode: 'full',
      },
    );

    assert.equal(
      dev.writeCount() > 0,
      true,
      'with no live capacity signal available, the write must proceed unchecked rather than refuse blindly',
    );
  });
});

// ── Checksum-gated whole-object skip, objIdx 1/2/3 ──────────────────────────
//
// Real ETS's own mechanism for GA/Association/Object 3 -
// a live PropertyValue_Read on P=27 (PID_MCB_TABLE), compared against a
// fresh crc16Knx() computed from the download's own target table. A match
// skips the object's entire load cycle; a mismatch writes the object's full
// content (whole-object-scoped, not a byte-range diff); a failed/no-response
// read falls back to the pre-existing pendingWriteRanges heuristic.
//
// `buildMcb()` below encodes the real 8-byte PID_MCB_TABLE element shape:
// [reserved:2][size,BE:2][reserved:1][signal:1][checksum,BE:2].
//
// The GA table content and its real checksum (0xE5AF) are taken directly
// from this project's own real-hardware fixture
// (tests/fixtures/relmem-real-devices/ga-assoc-wire-format-1.1.10.json,
// `00020A010A02`) and cross-checked against the matching real ETS capture
// (a real ETS Partial Download capture of 1.1.10:
// `PropValueResp OX=1 P=27 $000000060033E5AF`) - not a synthetic value,
// per this project's standing rule to validate protocol claims against real
// captured ETS downloads.

function buildMcb(size: number, signalByte: number, checksum: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(size, 2);
  buf[5] = signalByte;
  buf.writeUInt16BE(checksum, 6);
  return buf;
}

describe('downloadDevice() partial mode - checksum-gated skip for objIdx 1/2/3', () => {
  // Real fixture: tests/fixtures/relmem-real-devices/ga-assoc-wire-format-1.1.10.json
  const REAL_GA_TABLE_1_1_10 = Buffer.from('00020A010A02', 'hex');
  const REAL_GA_TABLE_CHECKSUM = 0xe5af; // real capture, frame 138 above

  it('crc16Knx() matches the real captured checksum for the real 1.1.10 GA table fixture', () => {
    assert.equal(crc16Knx(REAL_GA_TABLE_1_1_10), REAL_GA_TABLE_CHECKSUM);
  });

  // Real fixture: tests/fixtures/relmem-real-devices/object3-wire-format-1.1.10.json
  // Closes a prior open question - the
  // checksum algorithm was previously confirmed against GA/Association table
  // content only; this is the same confirmation against Object 3's own real
  // 942-byte content, cross-checked against the real device's own
  // PropertyValue_Read P=27 response captured immediately after the write.
  const REAL_OBJECT3_1_1_10 = Buffer.from(
    '01D60000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009700CF00000097039307CB07000000000000000000000000000000000000000000000000000000009300CB00000093039307CB07000000000000000000000000000000000000000000000000000000009300CB00000093039307CB07000000000000000000000000000000000000000000000000000000009300CB00000093039307CB0700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    'hex',
  );
  const REAL_OBJECT3_CHECKSUM = 0x3b56; // real capture, PropertyValue_Read P=27 immediately after this write

  it('crc16Knx() matches the real captured checksum for the real 1.1.10 Object 3 fixture', () => {
    assert.equal(crc16Knx(REAL_OBJECT3_1_1_10), REAL_OBJECT3_CHECKSUM);
    assert.equal(REAL_OBJECT3_1_1_10.length, 942);
  });

  it('skips the whole object (no bus write at all) when the live PID_MCB_TABLE checksum already matches the target content', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00])); // PID_TABLE_REFERENCE (test base, well within the fake device backing buffer)
    dev.setProperty(
      1,
      27,
      buildMcb(
        REAL_GA_TABLE_1_1_10.length,
        0x33,
        crc16Knx(REAL_GA_TABLE_1_1_10),
      ),
    );

    await dev.downloadDevice(
      '1.1.10',
      [],
      REAL_GA_TABLE_1_1_10,
      null,
      null,
      undefined,
      { mode: 'partial', pendingWriteRanges: {} },
    );

    assert.equal(
      dev.writeCount(),
      0,
      'a matching live checksum must skip the entire object, including any PID 7 base resolution for the write itself',
    );
  });

  it('does NOT skip when the checksum matches but the device reports a different table size', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(
      1,
      27,
      buildMcb(
        REAL_GA_TABLE_1_1_10.length + 2,
        0x33,
        crc16Knx(REAL_GA_TABLE_1_1_10),
      ),
    );

    await dev.downloadDevice(
      '1.1.10',
      [],
      REAL_GA_TABLE_1_1_10,
      null,
      null,
      undefined,
      { mode: 'partial', pendingWriteRanges: {} },
    );

    assert.deepEqual(
      [...dev.memory.subarray(0x4000, 0x4000 + REAL_GA_TABLE_1_1_10.length)],
      [...REAL_GA_TABLE_1_1_10],
      'a size mismatch must not be skipped on a checksum match alone',
    );
  });

  it('writes the FULL object content when the live PID_MCB_TABLE checksum does not match, even though pendingWriteRanges is empty', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    // Device's real checksum doesn't match the target content -
    // e.g. stale/out-of-band content, or a genuine GA-link change.
    dev.setProperty(1, 27, buildMcb(REAL_GA_TABLE_1_1_10.length, 0x33, 0x0000));

    await dev.downloadDevice(
      '1.1.10',
      [],
      REAL_GA_TABLE_1_1_10,
      null,
      null,
      undefined,
      // Deliberately empty pendingWriteRanges - the checksum mismatch alone
      // must be sufficient to trigger a full write; this is NOT gated on
      // the tracked-change heuristic at all once a live checksum disagrees.
      { mode: 'partial', pendingWriteRanges: {} },
    );

    assert.deepEqual(
      [...dev.memory.subarray(0x4000, 0x4000 + REAL_GA_TABLE_1_1_10.length)],
      [...REAL_GA_TABLE_1_1_10],
      'a checksum mismatch must write the FULL real table content, not a partial/tracked range',
    );
  });

  it('falls back to the pendingWriteRanges heuristic when the live PID_MCB_TABLE read fails (no response) - and records a verificationIssue', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    // Deliberately NOT configured via setProperty(1, 27, ...) - the live
    // checksum read goes unanswered, matching a real device/app that
    // doesn't declare property 27 for this object, or a genuine read
    // failure.

    const result = await dev.downloadDevice(
      '1.1.10',
      [],
      REAL_GA_TABLE_1_1_10,
      null,
      null,
      undefined,
      {
        mode: 'partial',
        pendingWriteRanges: {
          1: [{ offset: 0, length: REAL_GA_TABLE_1_1_10.length }],
        },
      },
    );

    assert.deepEqual(
      [...dev.memory.subarray(0x4000, 0x4000 + REAL_GA_TABLE_1_1_10.length)],
      [...REAL_GA_TABLE_1_1_10],
      'the pre-existing pendingWriteRanges heuristic should still drive the write when the live checksum signal is unavailable',
    );
    assert.equal(
      result.verificationIssues.length,
      1,
      'a failed live checksum read is a real, worth-recording problem - not silent',
    );
    assert.match(result.verificationIssues[0]!, /PID_MCB_TABLE.*read failed/);
  });

  it('a failed live checksum read with NOTHING pending falls through to the ordinary "nothing pending" skip (no write, but the read failure is still recorded)', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    // No property 27 configured (read fails) AND no pendingWriteRanges.

    const result = await dev.downloadDevice(
      '1.1.10',
      [],
      REAL_GA_TABLE_1_1_10,
      null,
      null,
      undefined,
      { mode: 'partial', pendingWriteRanges: {} },
    );

    assert.equal(dev.writeCount(), 0);
    assert.equal(result.verificationIssues.length, 1);
  });

  it('objIdx 4 (parameter memory) is unaffected - keeps using pendingWriteRanges unconditionally, no live PID_MCB_TABLE read attempted', async () => {
    const size = 100;
    const target = Buffer.alloc(size);
    for (let i = 0; i < size; i++) target[i] = i % 256;
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    // Deliberately NOT configuring property 27 for objIdx 4 - if the
    // checksum-gated path were (incorrectly) applied to objIdx 4 too, this
    // read would fail and get recorded as a verificationIssue; asserting
    // zero issues here proves objIdx 4 never even attempts the read.
    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    const result = await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      target,
      undefined,
      {
        resolvedBases: { 4: 0x5f0e },
        mode: 'partial',
        pendingWriteRanges: { 4: [{ offset: 10, length: 1 }] },
      },
    );

    assert.equal(
      result.verificationIssues.length,
      0,
      'objIdx 4 must not attempt the checksum read at all (its own N-element shape is not wired into this comparison yet)',
    );
    assert.equal(dev.writeCount(), 1);
  });
});

// ── Final pre-Restart PID_MCB_TABLE verification read ───────────────────────
//
// Real ETS reads PropertyValue_Read P=27 on every interface object it
// considered, in ascending objIdx order, immediately after the
// last LoadCompleted and immediately before Restart - unconditionally, even
// for an object whose own load cycle was skipped.

describe("downloadDevice() - real ETS's final pre-Restart PID_MCB_TABLE verification read", () => {
  it('Full mode: every relmem object (GA/Assoc/Object3/param) gets a final P=27 read, in ascending objIdx order, all before Restart', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const assocTable = Buffer.from('00020001001F00020020', 'hex');
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x00, 0x50, 0x00]));
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x60, 0x00]));
    // 🟢 The final pre-Restart verification read does live
    // CRC-mismatch detection for objIdx 1/2/3 (see downloadDevice()'s own
    // comments) - an unanswered/mismatched read there now genuinely
    // withholds Restart, so this test (which cares about read ORDER, not
    // content) needs real, self-consistent responses to let Restart
    // proceed. `setLiveProp27` computes the checksum from the fake
    // device's own backing memory at the resolved base, so it naturally
    // matches once Full mode's own write actually lands - exactly like a
    // real device's PID_MCB_TABLE would. Object 4's P=27 is content-compared
    // too (one element for an app that declares no split write: the CRC of
    // the whole parameter buffer).
    dev.setLiveProp27(1, 0x4000, gaTable.length);
    dev.setLiveProp27(2, 0x5000, assocTable.length);
    dev.setProperty(4, 27, buildMcb(size, 0x33, crc16Knx(paramMem)));

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    // This app declares P=27 for objIdx 4 (matching a real HDL/Jung-style
    // app) - required for `appUsesP27` to gate the final-verification pass
    // ON - an app that never declares P=27 anywhere gets NO final reads
    // at all, matching real ETS's own confirmed behavior for such apps.
    const writeProp27: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(0),
    };

    const dev2 = dev; // keep name short below
    await dev2.downloadDevice(
      '1.1.10',
      [writeProp27, relSeg, write],
      gaTable,
      assocTable,
      paramMem,
      undefined,
      {},
    );

    const restartIdx = dev2.restartIndex();
    assert.ok(
      restartIdx != null,
      'a Restart must have been sent (a load cycle genuinely ran)',
    );

    // The FINAL P=27 read for each objIdx (the one closest to, and before,
    // Restart) must appear for every object this download considered (1, 2,
    // 4 - no groupObjectTable was supplied so objIdx 3 isn't in play here),
    // in ascending order, all strictly before Restart.
    const p27Before = dev2.p27ReadEvents().filter((e) => e.index < restartIdx!);
    const lastByObj = new Map<number, number>();
    for (const e of p27Before) lastByObj.set(e.objIdx, e.index);
    const finalObjIdxsInOrder = [...lastByObj.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([objIdx]) => objIdx);

    // The LAST three P=27 reads before Restart must be exactly objIdx
    // 1, 2, 4 in ascending order (the final verification pass) - earlier
    // occurrences of objIdx 1/2 in p27Before are the checksum-gate's own
    // early reads, not this pass.
    assert.deepEqual(
      finalObjIdxsInOrder.slice(-3),
      [1, 2, 4],
      'the final pre-Restart P=27 reads must cover every relmem object in ascending objIdx order',
    );
  });

  it('Partial mode: an object whose load cycle was checksum-skipped STILL gets the final P=27 read, as long as another object in the same download genuinely wrote (so a load cycle - and therefore Restart - genuinely ran)', async () => {
    // Real shape objIdx 1 (GA table)
    // mismatches - it gets written, driving anyRelSegmentLoaded true and
    // therefore the whole final-verification-read + Restart sequence.
    // objIdx 2 (Association table) matches - skipped entirely - but must
    // STILL get the final read, matching real ETS reading every object
    // it considered, not just the ones it touched.
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const assocTable = Buffer.from('00020001001F00020020', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x00, 0x50, 0x00]));
    // 🟢 `setLiveProp27` (not a fixed setProperty() value) for
    // objIdx 1 - the final pre-Restart verification read now does live
    // CRC-mismatch detection (see downloadDevice()'s own comments), so a
    // fixed "wrong" checksum used only to trigger the pre-write skip check
    // would ALSO look wrong at the final check, even after a genuine
    // correct write, and wrongly withhold Restart. A live value (computed
    // from the fake device's own backing memory) naturally mismatches
    // before the write (backing is still zero-filled there) and matches
    // after it, exactly like a real device's PID_MCB_TABLE would.
    dev.setLiveProp27(1, 0x4000, gaTable.length); // mismatches until GA actually writes
    dev.setProperty(
      2,
      27,
      buildMcb(assocTable.length, 0x33, crc16Knx(assocTable)),
    ); // match - Assoc skipped, never rewritten, stays correct
    // This app declares P=27 (on objIdx 4, matching real apps - see the
    // previous test's own comment) - required for `appUsesP27` to gate the
    // final-verification pass ON.
    const writeProp27: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(0),
    };

    await dev.downloadDevice(
      '1.1.10',
      [writeProp27],
      gaTable,
      assocTable,
      null,
      undefined,
      { mode: 'partial', pendingWriteRanges: {} },
    );

    const restartIdx = dev.restartIndex();
    assert.ok(
      restartIdx != null,
      'a Restart must have been sent - objIdx 1 genuinely wrote',
    );

    const finalReadObjIdxs = dev
      .p27ReadEvents()
      .filter((e) => e.index < restartIdx!)
      .reduce(
        (last, e) => last.set(e.objIdx, e.index),
        new Map<number, number>(),
      );
    const orderedFinal = [...finalReadObjIdxs.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([objIdx]) => objIdx);

    assert.ok(
      orderedFinal.includes(2),
      'Association table (objIdx 2) - skipped via the checksum match - must still get a final verification read',
    );
    assert.ok(
      orderedFinal.includes(1),
      'GA table (objIdx 1) - written - also gets the final read',
    );
  });

  it('an app that never declares P=27 anywhere gets NO final verification reads at all, even though a load cycle genuinely ran', async () => {
    // Real evidence: a genuine live 1.1.9 Full Download capture showed ETS
    // never touches P=27 for this app - no WriteProp, no LoadImageProp, no
    // final read - because the app's own XML never declares it anywhere.
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    // Deliberately NO WriteProp/LoadImageProp for propId 27 anywhere in
    // this app's steps - matching 1.1.9's own real app XML.

    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      paramMem,
      undefined,
      {},
    );

    assert.ok(
      dev.restartIndex() != null,
      'a Restart must have been sent - a load cycle genuinely ran',
    );
    // Note: this does NOT assert zero P=27 reads of any kind - the
    // completely separate memory-write-service resolution (legacy vs
    // extended, `useExtendedMemory` above) also reads P=27 on objIdx 4,
    // once, very early (before any Unload), as one of its OWN candidate
    // signals - unrelated to the final-verification mechanism gated
    // here. What matters is that THIS gate suppresses every OTHER P=27
    // read - in particular the whole final-verification pass - leaving
    // exactly that one, pre-existing, unrelated read and nothing more.
    assert.equal(
      dev.p27ReadEvents().length,
      1,
      'an app that never declares P=27 must get no final-verification P=27 reads - only the pre-existing, unrelated memory-write-service resolution read on objIdx 4 should remain',
    );
  });

  // ── propReadFinal() retry-hardening + live CRC-mismatch detection +
  //    Restart-withhold policy ──────────────────────────────────────────

  it('propReadFinal() tolerates one lost final-verification frame and still restarts normally once the retry succeeds', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    // A real device's PID_MCB_TABLE naturally reflects what was actually
    // written, so `setLiveProp27` (not a static value) - but the FIRST
    // final-verification read for objIdx 1 is dropped entirely (simulating
    // one lost KNXnet/IP frame), forcing propReadFinal() to retry.
    dev.setLiveProp27(1, 0x4000, gaTable.length);
    dev.setFlakyProperty(1, 27, 1);
    const writeProp27: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(0),
    };

    const result = await dev.downloadDevice(
      '1.1.10',
      [writeProp27],
      gaTable,
      null,
      null,
      undefined,
      {},
    );

    assert.equal(
      result.restartWithheld,
      false,
      'one lost frame, recovered by retry, must NOT withhold Restart',
    );
    assert.ok(
      dev.restartIndex() != null,
      'Restart must still have been sent once the retried read succeeded',
    );
    assert.equal(result.verificationIssues.length, 0);
  });

  it('a genuine, persistent PID_MCB_TABLE checksum mismatch withholds Restart and reports why', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x60, 0x00]));
    // A fixed, permanently WRONG checksum for objIdx 1 - real, persistent
    // disagreement between what was written and what the device
    // reports, surviving every retry (never a "lost frame").
    dev.setProperty(1, 27, buildMcb(gaTable.length, 0x33, 0xdead));
    // objIdx 4's own P=27 isn't content-compared yet (see downloadDevice()'s
    // own comment) - answered normally so this test isolates objIdx 1's
    // mismatch as the only trigger.
    dev.setProperty(4, 27, buildMcb(size, 0x33, crc16Knx(paramMem)));
    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    const writeProp27: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(0),
    };

    const result = await dev.downloadDevice(
      '1.1.10',
      [writeProp27, relSeg, write],
      gaTable,
      null,
      paramMem,
      undefined,
      {},
    );

    assert.equal(
      result.restartWithheld,
      true,
      'a persistent checksum mismatch must withhold Restart',
    );
    assert.ok(
      result.restartWithheldReasons && result.restartWithheldReasons.length > 0,
      'restartWithheldReasons must explain why',
    );
    assert.ok(
      result.restartWithheldReasons!.some(
        (r) => r.includes('ObjIdx=1') && r.includes('MISMATCH'),
      ),
      'the reason must name the object and the mismatch',
    );
    assert.ok(
      result.verificationIssues.some((i) => i.includes('MISMATCH')),
      'the same problem must also appear in verificationIssues',
    );
    assert.equal(
      dev.restartIndex(),
      null,
      'Restart must NOT have been sent to the device at all',
    );
  });

  it('a persistent no-response on the final read (retries exhausted) also withholds Restart', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.10', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    // No setProperty(1, 27, ...) and no setLiveProp27() at all - every
    // attempt (the initial read and both retries) goes unanswered.
    const writeProp27: DownloadStep = {
      type: 'WriteProp',
      objIdx: 4,
      propId: 27,
      data: Buffer.alloc(0),
    };

    const result = await dev.downloadDevice(
      '1.1.10',
      [writeProp27],
      gaTable,
      null,
      null,
      undefined,
      {},
    );

    assert.equal(result.restartWithheld, true);
    assert.ok(
      result.restartWithheldReasons!.some(
        (r) => r.includes('no response') && r.includes('retry'),
      ),
      'the reason must describe a persistent no-response, not a mismatch',
    );
    assert.equal(dev.restartIndex(), null);
  });
});

// ── Write-process safety guards ──────────────────────────────────────────────
//
// (An adversarial safety-review finding): two hard, synchronous, before-any-
// bus-I/O checks that refuse to proceed rather than silently trusting
// unenforced assumptions about the app's own declared load procedure.

describe('downloadDevice() - write-process safety guards', () => {
  it('refuses a PropertyValue_Write to ObjIdx=0 (Device Object) for any PropId other than 14 (PID_DEVICE_CONTROL)', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    // A WriteProp step whose ObjIdx is (or defaults to) 0 for some OTHER
    // property - the real gap this guard protects against (a missing
    // ObjIdx attribute silently defaulting to 0 upstream).
    const badStep: DownloadStep = {
      type: 'WriteProp',
      objIdx: 0,
      propId: 12, // manufacturer id - NOT the allowlisted P=14
      data: Buffer.from('0004', 'hex'),
    };

    await assert.rejects(
      () =>
        dev.downloadDevice('1.1.9', [badStep], null, null, null, undefined, {}),
      /Refusing PropertyValue_Write to ObjIdx=0.*PropId=12/,
    );
  });

  it('does NOT refuse the deliberate PID_DEVICE_CONTROL (ObjIdx=0, PropId=14) write - the one allowlisted exception', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x5f, 0x0e])); // PID_TABLE_REFERENCE
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    // Should complete without throwing - PID_DEVICE_CONTROL's own real
    // objIdx=0/propId=14 write (issued internally, not via a DownloadStep)
    // is unaffected by the guard.
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      paramMem,
      undefined,
      {},
    );
    assert.ok(
      dev.writeCount() > 0,
      'the real param write should still have gone through',
    );
  });

  it('refuses to write when LdCtrlRelSegment and LdCtrlWriteRelMem declare disagreeing sizes for the same object', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    const paramMem = Buffer.alloc(20);
    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: 20, // RelSegment says 20 bytes...
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: 16, // ...but WriteRelMem says 16 - a genuine disagreement
      offset: 0,
    };

    await assert.rejects(
      () =>
        dev.downloadDevice(
          '1.1.9',
          [relSeg, write],
          null,
          null,
          paramMem,
          undefined,
          {},
        ),
      /RelSegment\/WriteRelMem size mismatch for ObjIdx=4.*Size=20.*Size=16/,
    );
  });

  it('proceeds normally when RelSegment and WriteRelMem declare the same size (the real, universal case)', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.9', backing);
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x5f, 0x0e])); // PID_TABLE_REFERENCE
    const size = 20;
    const paramMem = Buffer.alloc(size);
    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    await dev.downloadDevice(
      '1.1.9',
      [relSeg, write],
      null,
      null,
      paramMem,
      undefined,
      {},
    );
    assert.ok(dev.writeCount() > 0);
  });
});

// ── LoadImageProp no longer reads OX=1/2/3 P=27 early ───────────────────────
//
// Real bug: the generic `LoadImageProp` step handler issued a live P=27
// read for EVERY declared LoadImageProp step, immediately, regardless of
// objIdx - but this project's own real capture corpus never shows an early
// OX=1/OX=2 P=27 read outside the post-write final-verification pass, and
// the one case where OX=1/2/3 genuinely DO read early (a real Partial
// Download's own checksum-gated skip decision, seen in a real ETS Partial
// Download capture of 1.1.10) is a
// SEPARATE mechanism this codebase already has (`mode === 'partial'`
// above) - reading here too meant a real double read for objIdx 1/2/3 in
// partial mode, and a wasted, ETS-incorrect early read for them in full
// mode (where the checksum-gate never runs at all).

describe('downloadDevice() - LoadImageProp no longer reads OX=1/2/3 P=27 early', () => {
  function loadImageStep(objIdx: number): DownloadStep {
    return { type: 'LoadImageProp', objIdx, propId: 27 };
  }

  it('Full mode: an app declaring LoadImageProp for objIdx 1/2/3/4 gets ZERO early P=27 reads for 1/2/3 - only objIdx 4 reads early (write-service detection), and the final verification pass covers all four', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const assocTable = Buffer.from('00020001001F00020020', 'hex');
    const groupObjTable = Buffer.from('0002' + '80'.repeat(2), 'hex');
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.100', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x00, 0x50, 0x00]));
    dev.setProperty(3, 7, Buffer.from([0x00, 0x00, 0x55, 0x00]));
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x60, 0x00]));
    // Full mode never content-compares against these - any non-empty
    // response is enough to satisfy the final verification pass without
    // withholding Restart.
    dev.setLiveProp27(1, 0x4000, gaTable.length);
    dev.setLiveProp27(2, 0x5000, assocTable.length);
    dev.setLiveProp27(3, 0x5500, groupObjTable.length);
    dev.setProperty(4, 27, buildMcb(size, 0x33, crc16Knx(paramMem)));

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    const steps: DownloadStep[] = [
      loadImageStep(1),
      loadImageStep(2),
      loadImageStep(3),
      loadImageStep(4),
      relSeg,
      write,
    ];

    await dev.downloadDevice(
      '1.1.100',
      steps,
      gaTable,
      assocTable,
      paramMem,
      undefined,
      { groupObjectTable: groupObjTable },
    );

    const restartIdx = dev.restartIndex();
    assert.ok(
      restartIdx != null,
      'a Restart must have been sent - a load cycle genuinely ran',
    );
    const early = dev.p27ReadEvents().filter((e) => e.index < restartIdx!);
    // The final verification pass itself reads all 4 objects right before
    // Restart - exclude that cluster (the last 4 P=27 reads) to isolate
    // whatever happened EARLIER in the session.
    const beforeFinal = early.slice(0, Math.max(0, early.length - 4));

    assert.ok(
      !beforeFinal.some((e) => e.objIdx === 1),
      `OX=1 P=27 must never be read early in Full mode - got: ${JSON.stringify(beforeFinal)}`,
    );
    assert.ok(
      !beforeFinal.some((e) => e.objIdx === 2),
      `OX=2 P=27 must never be read early in Full mode - got: ${JSON.stringify(beforeFinal)}`,
    );
    assert.ok(
      !beforeFinal.some((e) => e.objIdx === 3),
      `OX=3 P=27 must never be read early in Full mode (no checksum-gate runs in full mode) - got: ${JSON.stringify(beforeFinal)}`,
    );
    assert.ok(
      beforeFinal.some((e) => e.objIdx === 4),
      'OX=4 P=27 should still read early - the real memory-write-service byte5 detection genuinely needs it',
    );

    const finalFour = early
      .slice(-4)
      .map((e) => e.objIdx)
      .sort((a, b) => a - b);
    assert.deepEqual(
      finalFour,
      [1, 2, 3, 4],
      'the final verification pass must still cover all four objects',
    );
  });

  it("Partial mode: an app declaring LoadImageProp for objIdx 1/2/3 reads P=27 EXACTLY ONCE early per object (from the dedicated checksum-gate only, not doubled by LoadImageProp's own generic read)", async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const assocTable = Buffer.from('00020001001F00020020', 'hex');
    const groupObjTable = Buffer.from('0002' + '80'.repeat(2), 'hex');
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.101', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x00, 0x50, 0x00]));
    dev.setProperty(3, 7, Buffer.from([0x00, 0x00, 0x55, 0x00]));
    // Genuinely matching checksums (real crc16Knx() of each table) - the
    // checksum-gate should skip all three objects entirely, matching a
    // real "history exists, nothing changed" partial-download session.
    dev.setProperty(1, 27, buildMcb(gaTable.length, 0x33, crc16Knx(gaTable)));
    dev.setProperty(
      2,
      27,
      buildMcb(assocTable.length, 0x33, crc16Knx(assocTable)),
    );
    dev.setProperty(
      3,
      27,
      buildMcb(groupObjTable.length, 0x33, crc16Knx(groupObjTable)),
    );

    const steps: DownloadStep[] = [
      loadImageStep(1),
      loadImageStep(2),
      loadImageStep(3),
    ];

    await dev.downloadDevice(
      '1.1.101',
      steps,
      gaTable,
      assocTable,
      null,
      undefined,
      {
        mode: 'partial',
        pendingWriteRanges: {},
        groupObjectTable: groupObjTable,
      },
    );

    const p27 = dev.p27ReadEvents();
    for (const objIdx of [1, 2, 3]) {
      const count = p27.filter((e) => e.objIdx === objIdx).length;
      assert.equal(
        count,
        1,
        `OX=${objIdx} P=27 should be read exactly once (the checksum-gate's own read, not doubled by LoadImageProp) - got ${count}`,
      );
    }
    // Every object's checksum matched - nothing should have been written,
    // and with nothing genuinely loaded, no Restart is sent either.
    assert.equal(
      dev.writeCount(),
      0,
      'nothing should have been written - every checksum matched',
    );
  });
});

// ── Final verification read order follows the app's own declared
//    LoadImageProp order ──────────────────────────────────────────────────
//
// The final pre-Restart verification read used to hardcode ascending
// objIdx order unconditionally. Real-evidence-based (every app in this
// project's own captures that declares LoadImageProp at all happens to
// declare it ascending), but still a fixed rule, not one derived from the
// app's own declaration. A fixture using an ascending declared order could
// never tell "follows the declaration" apart from "always sorts ascending
// regardless" - so this uses a deliberately NON-ascending order.

describe("downloadDevice() - final verification read order follows the app's own declared LoadImageProp order", () => {
  it('DISCRIMINATING TEST - app declaring LoadImageProp in a deliberately non-ascending order (3,1,4,2): the final verification pass follows it exactly, not the ascending fallback', async () => {
    const gaTable = Buffer.from('00020A010A02', 'hex');
    const assocTable = Buffer.from('00020001001F00020020', 'hex');
    const groupObjTable = Buffer.from('0002' + '80'.repeat(2), 'hex');
    const size = 8;
    const paramMem = Buffer.alloc(size);
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeRWMemoryDevice('1.1.103', backing);
    dev.setProperty(1, 7, Buffer.from([0x00, 0x00, 0x40, 0x00]));
    dev.setProperty(2, 7, Buffer.from([0x00, 0x00, 0x50, 0x00]));
    dev.setProperty(3, 7, Buffer.from([0x00, 0x00, 0x55, 0x00]));
    dev.setProperty(4, 7, Buffer.from([0x00, 0x00, 0x60, 0x00]));
    dev.setLiveProp27(1, 0x4000, gaTable.length);
    dev.setLiveProp27(2, 0x5000, assocTable.length);
    dev.setLiveProp27(3, 0x5500, groupObjTable.length);
    dev.setProperty(4, 27, buildMcb(size, 0x33, crc16Knx(paramMem)));

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size,
      offset: 0,
    };
    // Deliberately non-ascending declared order: 3, 1, 4, 2.
    const steps: DownloadStep[] = [
      { type: 'LoadImageProp', objIdx: 3, propId: 27 },
      { type: 'LoadImageProp', objIdx: 1, propId: 27 },
      { type: 'LoadImageProp', objIdx: 4, propId: 27 },
      { type: 'LoadImageProp', objIdx: 2, propId: 27 },
      relSeg,
      write,
    ];

    await dev.downloadDevice(
      '1.1.103',
      steps,
      gaTable,
      assocTable,
      paramMem,
      undefined,
      { groupObjectTable: groupObjTable },
    );

    const restartIdx = dev.restartIndex();
    assert.ok(restartIdx != null, 'a Restart must have been sent');
    const early = dev.p27ReadEvents().filter((e) => e.index < restartIdx!);
    const finalFour = early.slice(-4).map((e) => e.objIdx);

    // A hardcoded ascending fallback would produce [1,2,3,4] here
    // regardless of this fixture's declaration - seeing that shape would
    // mean the declared-order lookup was silently ignored.
    assert.deepEqual(
      finalFour,
      [3, 1, 4, 2],
      `final verification should follow this app's own declared LoadImageProp order exactly - got: ${finalFour.join(', ')} (if this is [1,2,3,4], the declared-order lookup silently fell back to the ascending sort)`,
    );
  });
});
