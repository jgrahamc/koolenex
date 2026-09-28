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
import { KnxConnection } from '../server/knx-connection.ts';
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
      const data = this.properties.get(`${objIdx}:${propId}`);
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
