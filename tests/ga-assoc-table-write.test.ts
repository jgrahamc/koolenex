/**
 * Protocol-level regression test for the missing GA table (objIdx 1) /
 * Association table (objIdx 2) writes on RelSegment-style apps that don't
 * themselves declare a step for those objects - see docs/knx-device-write-
 * protocol.md's "Genuinely open questions" (now resolved) and the 2026-08-29
 * fix in knx-connection.ts's downloadDevice(). Real ETS writes both tables
 * via the same Unload/StartLoading/LoadData/write/LoadCompleted mechanism
 * used for the parameter object, confirmed directly from a real capture
 * decode - but neither of this project's two real app models declares this
 * themselves the way real ETS actually behaves (1.1.9's app: no step at all
 * for objIdx 1/2; 1.1.10's app: declares `LoadImageProp` instead, a
 * different, already-honored mechanism). Before this fix, koolenex never
 * wrote the GA/Association table for an app shaped like 1.1.9's, ever,
 * silently - no error, no rejected-write signal, nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCEMI, buildCEMI, apduConnectedFull, apduGroup, APCI_EXT } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

class TableFakeDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory: Buffer;
  private readonly deviceAddr: string;
  loadingObjIdx: number | null = null;
  lsmEvents: Array<{ objIdx: number; event: number }> = [];
  // objIdx -> PID_TABLE_REFERENCE response (4-byte BE base, 0 = unallocated)
  private readonly bases: Record<number, number>;

  constructor(deviceAddr: string, memory: Buffer, bases: Record<number, number>) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.bases = bases;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const respApdu = apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0]));
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

    const fullApci = frame.apdu.length >= 2
      ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
      : -1;

    if (fullApci === 0x3d1 /* Authorize_Request */) {
      const respApdu = apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00]));
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
    } else if (fullApci === 0x3d7 /* PropertyValue_Write */) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const data = frame.apduData.subarray(4);
      let state = 0x00;
      if (propId === 5 && data.length > 0) {
        const event = data[0]!;
        this.lsmEvents.push({ objIdx, event });
        if (event === 0x01) {
          this.loadingObjIdx = objIdx;
          state = 0x02;
        } else if (event === 0x03) {
          state = 0x02;
        } else if (event === 0x02) {
          if (this.loadingObjIdx === objIdx) this.loadingObjIdx = null;
          state = 0x01;
        } else if (event === 0x04) {
          if (this.loadingObjIdx === objIdx) this.loadingObjIdx = null;
          state = 0x00;
        }
      }
      const respExtra = propId === 5 ? Buffer.from([state]) : data.length ? data : Buffer.from([0x00]);
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([Buffer.from([objIdx, propId, 0x10, 0x01]), respExtra]),
      );
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
    } else if (fullApci === 0x3d5 /* PropertyValue_Read */) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      let value: Buffer;
      if (propId === 7) {
        value = Buffer.alloc(4);
        value.writeUInt32BE(this.bases[objIdx] ?? 0);
      } else if (propId === 13) {
        value = Buffer.from('0004002510', 'hex');
      } else {
        value = Buffer.alloc(0);
      }
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([Buffer.from([objIdx, propId, 0x10, 0x01]), value]),
      );
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'Memory_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 8) | frame.apduData[2]!;
      const data = frame.apduData.subarray(3, 3 + count);
      data.copy(this.memory, address);
      // downloadDevice()'s memory-write loop now waits for each chunk's
      // real response before sending the next (2026-08-30 fix) - respond
      // like real hardware does, or every write would stall on the 3s
      // timeout.
      const respApdu = apduGroup('Memory_Response', 0, frame.apduData);
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'MemoryExtended_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 16) | (frame.apduData[2]! << 8) | frame.apduData[3]!;
      const data = frame.apduData.subarray(4, 4 + count);
      data.copy(this.memory, address);
      const respApdu = apduConnectedFull(0, APCI_EXT.MemoryExtended_Write_Response, Buffer.alloc(0));
      const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
      setImmediate(() => this._onCEMI(resp));
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('GA table / Association table write fallback for apps that don\'t declare it', () => {
  // Real byte shapes from docs/knx-device-write-protocol.md §1.1 Stage 3:
  // GA table (objIdx 1): [count=2][GA 9/1/1][GA 9/1/4], 6 bytes.
  const gaTable = Buffer.from('000249014904', 'hex');
  // Association table (objIdx 2): [count=2][gaIndex=1,co=5][gaIndex=2,co=8], 10 bytes.
  const assocTable = Buffer.from('00020001000500020008', 'hex');

  it('writes the GA and Association tables when the model has no step for them (1.1.9\'s real shape)', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new TableFakeDevice('1.1.9', backing, { 1: 0x4000, 2: 0x470a });
    // Matches 1.1.9's real model: only objIdx 4 declared.
    const steps: DownloadStep[] = [
      { type: 'RelSegment', objIdx: 0, propId: 0, lsmIdx: 4, size: 20, mode: 'full', fill: 255 },
      { type: 'WriteRelMem', objIdx: 4, propId: 0, size: 20, offset: 0 },
    ];
    const payload = Buffer.alloc(20, 0xaa);

    await dev.downloadDevice('1.1.9', steps, gaTable, assocTable, payload, undefined, {
      resolvedBases: { 4: 0x5f0e },
    });

    assert.deepEqual(
      [...dev.memory.subarray(0x4000, 0x4000 + gaTable.length)],
      [...gaTable],
      'GA table should land at its resolved base',
    );
    assert.deepEqual(
      [...dev.memory.subarray(0x470a, 0x470a + assocTable.length)],
      [...assocTable],
      'Association table should land at its resolved base',
    );
    // Both objects should have gone through the real Load State sequence,
    // not a raw write.
    for (const objIdx of [1, 2]) {
      const events = dev.lsmEvents.filter((e) => e.objIdx === objIdx).map((e) => e.event);
      assert.deepEqual(events, [0x04, 0x01, 0x03, 0x02], `objIdx ${objIdx} should Unload/StartLoad/LoadData/LoadCompleted`);
    }
  });

  it('still runs the real write when the model only declares (read-only) LoadImageProp for objIdx 1/2 (1.1.10\'s real shape) - corrected 2026-08-29', async () => {
    // Was previously asserted the other way (fallback suppressed) under the
    // wrong assumption that a declared LoadImageProp step meant "this object
    // already handled". Confirmed 2026-08-29 against 3 independent real
    // downloads of 1.1.10 that LoadImageProp is read-only for every objIdx -
    // it never performs the real content write. Suppressing the fallback for
    // a LoadImageProp-only declaration was therefore a latent bug: it meant
    // koolenex never actually wrote the GA/Association table content for an
    // app shaped like 1.1.10's either (silently, like the 1.1.9 case this
    // whole fallback exists to fix). Only a genuine WriteRelMem declaration
    // (a real content write) should count as "already handled" - see
    // knx-connection.ts's declaredTableObjIdxs.
    const backing = Buffer.alloc(0x10000);
    const dev = new TableFakeDevice('1.1.10', backing, { 1: 0x4000, 2: 0x470a });
    const steps: DownloadStep[] = [
      { type: 'LoadImageProp', objIdx: 1, propId: 27 },
      { type: 'LoadImageProp', objIdx: 2, propId: 27 },
    ];

    await dev.downloadDevice('1.1.10', steps, gaTable, assocTable, null, undefined, {});

    assert.deepEqual(
      [...dev.memory.subarray(0x4000, 0x4000 + gaTable.length)],
      [...gaTable],
      'GA table should land at its resolved base despite the declared LoadImageProp step',
    );
    assert.deepEqual(
      [...dev.memory.subarray(0x470a, 0x470a + assocTable.length)],
      [...assocTable],
      'Association table should land at its resolved base despite the declared LoadImageProp step',
    );
    for (const objIdx of [1, 2]) {
      const events = dev.lsmEvents.filter((e) => e.objIdx === objIdx).map((e) => e.event);
      assert.deepEqual(events, [0x04, 0x01, 0x03, 0x02], `objIdx ${objIdx} should Unload/StartLoad/LoadData/LoadCompleted`);
    }
  });

  it('skips a table gracefully when its PID_TABLE_REFERENCE is unallocated (0x00000000)', async () => {
    const backing = Buffer.alloc(0x10000);
    // objIdx 1's base resolves to 0 - unallocated, matching the real
    // "segment never programmed at all" failure mode documented in
    // knx-segment-base.ts.
    const dev = new TableFakeDevice('1.1.9', backing, { 1: 0, 2: 0x470a });
    const steps: DownloadStep[] = [
      { type: 'RelSegment', objIdx: 0, propId: 0, lsmIdx: 4, size: 20, mode: 'full', fill: 255 },
      { type: 'WriteRelMem', objIdx: 4, propId: 0, size: 20, offset: 0 },
    ];
    const payload = Buffer.alloc(20, 0xaa);

    // Should not throw despite the unallocated base.
    await dev.downloadDevice('1.1.9', steps, gaTable, assocTable, payload, undefined, {
      resolvedBases: { 4: 0x5f0e },
    });

    assert.deepEqual(
      [...dev.memory.subarray(0x470a, 0x470a + assocTable.length)],
      [...assocTable],
      'Association table (allocated) should still land correctly',
    );
    // Nothing should have been written at address 0 (the fallback base
    // when unallocated) - the memory there stays untouched.
    assert.ok(
      dev.memory.subarray(0, gaTable.length).every((b) => b === 0),
      'GA table (unallocated base) should not have been written anywhere',
    );
  });
});
