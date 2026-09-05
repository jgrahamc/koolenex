/**
 * Protocol-level regression test for the missing Unload/StartLoading/
 * LoadData/LoadCompleted sequence around WriteRelMem - see
 * docs/follow-ups/2026-08-28-write-path-missing-load-sequence.md for the
 * full root-cause writeup. Real device firmware silently ignores memory
 * writes to an interface object outside "Loading" state; koolenex used to
 * send WriteRelMem completely raw, so every such write was a silent no-op
 * on real hardware regardless of address correctness.
 *
 * Unlike relmem-write-protocol.test.ts's FakeWritableMemoryDevice (which
 * accepts any Memory_Write unconditionally - fine for proving address
 * SELECTION is correct, but blind to this class of bug entirely), this
 * fake device models Load State gating: it only actually applies a memory
 * write to its backing buffer while the target object is in "Loading"
 * state, exactly like real hardware. Proves this fix is both necessary
 * (a version without the load-sequence emits writes the gated fake device
 * would reject) and sufficient (the real sequence, byte-verified against
 * four independent real captures, actually unlocks the write).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCEMI, buildCEMI, apduConnectedFull, apduGroup, APCI_EXT } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

type LsmState = 'unloaded' | 'loaded' | 'loading';

class LoadGatedFakeDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory: Buffer;
  private readonly deviceAddr: string;
  // Real hardware gates writes per-object, keyed by interface object index -
  // simplified here to "the currently loading object, if any" since these
  // tests only ever exercise one object at a time.
  loadingObjIdx: number | null = null;
  lsmEvents: Array<{ objIdx: number; event: number; data: Buffer }> = [];
  rejectedWrites: Array<{ address: number; extended: boolean }> = [];
  authRequests: Buffer[] = [];

  constructor(deviceAddr: string, memory: Buffer) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    // downloadDevice() now reads the device's mask version via
    // A_DeviceDescriptor_Read at the start of every RelSegment-driven
    // session, to gate legacy-vs-extended memory writes on the real device
    // family instead of a blanket rule - see the 2026-08-28 "gate on real
    // mask version" fix in knx-connection.ts's WriteRelMem case. Respond
    // with 0x07B0 (System B), matching the real device (1.1.9) this test's
    // scenario is modeled on.
    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.from([0x07, 0xb0]);
      const respApdu = apduGroup('DeviceDescriptor_Response', 0, maskBuf);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

    // parseCEMI() doesn't register PropertyValue_Write/Read (0x3D7/0x3D5) in
    // its extended-APCI name table (only the MemoryExtended_* ones are) -
    // frame.apciName comes back 'OTHER' for these, and frame.apciIdx is the
    // wrong (4-bit-only) value. Recompute the real full 10-bit APCI
    // ourselves from the raw APDU the same way parseCEMI does internally.
    const fullApci = frame.apdu.length >= 2
      ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
      : -1;
    if (fullApci === 0x3d1 /* Authorize_Request */) {
      this.authRequests.push(Buffer.from(frame.apduData));
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.Authorize_Response,
        Buffer.from([0x00]), // level 0 = full access, matching real captures
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (fullApci === 0x3d7 /* PropertyValue_Write */) {
      // apduPropertyValueWrite layout: [objIdx][propId][count/start:2][data...]
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const data = frame.apduData.subarray(4);
      // propWrite() now waits for a response before proceeding for EVERY
      // property write (not just LSM ones - see the 2026-08-28
      // "PID_PROGRAM_VERSION write-back" fix, which writes propId 13, not
      // 5) - respond to all of them like real hardware does, or any
      // non-LSM propWrite() call would time out after 3s. `state` below
      // only has real meaning for propId 5 (LSM); echoed back verbatim
      // otherwise (matching real ETS's own PID_PROGRAM_VERSION write-back,
      // which gets its own value echoed back in the response).
      let state = 0x00;
      if (propId === 5 && data.length > 0) {
        const event = data[0]!;
        this.lsmEvents.push({ objIdx, event, data: Buffer.from(data) });
        if (event === 0x01) {
          this.loadingObjIdx = objIdx; // StartLoading
          state = 0x02; // Loading
        } else if (event === 0x03) {
          state = 0x02; // LoadData - stays Loading
        } else if (event === 0x02) {
          // LoadCompleted
          if (this.loadingObjIdx === objIdx) this.loadingObjIdx = null;
          state = 0x01; // Loaded
        } else if (event === 0x04) {
          // Unload
          if (this.loadingObjIdx === objIdx) this.loadingObjIdx = null;
          state = 0x00; // Unloaded
        }
      }
      const respExtra =
        propId === 5 ? Buffer.from([state]) : data.length ? data : Buffer.from([0x00]);
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([Buffer.from([objIdx, propId, 0x10, 0x01]), respExtra]),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (fullApci === 0x3d5 /* PropertyValue_Read */) {
      // downloadDevice() now reads PID_PROGRAM_VERSION (objIdx 4, propId
      // 13) and writes it straight back before LoadCompleted (see the
      // 2026-08-28 "PID_PROGRAM_VERSION write-back" fix) - respond with a
      // fixed dummy value (shape matches the real captured
      // 0004002510: manufacturer(2)+appNumber(2)+version(1)) so that
      // round-trip actually completes instead of timing out.
      //
      // PID_MAX_APDULENGTH (property 56, objIdx 0) - real request,
      // 2026-08-31: needs its OWN case, not the generic fallback below -
      // the generic 5-byte dummy value would parse as a real but tiny
      // (4) max-APDU value, capping every chunk in this file's tests down
      // to ~1 byte and silently breaking their existing chunk-count
      // assumptions (built around the real 228-byte default). A generous
      // value here keeps every existing test's chunking unaffected.
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const value =
        objIdx === 0 && propId === 56
          ? Buffer.from([0x03, 0xe8]) // 1000
          : Buffer.from('0004002510', 'hex');
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([Buffer.from([objIdx, propId, 0x10, 0x01]), value]),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'Memory_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 8) | frame.apduData[2]!;
      const data = frame.apduData.subarray(3, 3 + count);
      if (this.loadingObjIdx !== null) data.copy(this.memory, address);
      else this.rejectedWrites.push({ address, extended: false });
      // downloadDevice()'s memory-write loop now waits for each chunk's
      // real response before sending the next (2026-08-30 fix - a real
      // device was found genuinely backlogged under the old fire-and-
      // forget pacing) - respond like real hardware does, or every write
      // would stall on the 3s timeout.
      const respApdu = apduGroup('Memory_Response', 0, frame.apduData);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'MemoryExtended_Write') {
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) | (frame.apduData[2]! << 8) | frame.apduData[3]!;
      const data = frame.apduData.subarray(4, 4 + count);
      if (this.loadingObjIdx !== null) data.copy(this.memory, address);
      else this.rejectedWrites.push({ address, extended: true });
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.MemoryExtended_Write_Response,
        Buffer.alloc(0),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('WriteRelMem load-sequence fix — real device gating simulation', () => {
  const RESOLVED_BASE = 0x5f0e; // 1.1.9's real resolved base for objIdx 4
  // A trimmed version of 1.1.9's real model.loadProcedures shape: two
  // RelSegment declarations (full+par, same lsmIdx) followed by WriteRelMem
  // - exactly what buildDeviceProgramming() produces for this real app.
  const steps: DownloadStep[] = [
    { type: 'RelSegment', objIdx: 0, propId: 0, lsmIdx: 4, size: 20, mode: 'full', fill: 255 },
    { type: 'RelSegment', objIdx: 0, propId: 0, lsmIdx: 4, size: 20, mode: 'par', fill: 255 },
    { type: 'WriteRelMem', objIdx: 4, propId: 0, size: 20, offset: 0 },
  ];
  const payload = Buffer.from(Array.from({ length: 20 }, (_, i) => i + 1));

  it('with the fix: the write actually lands, because the object is put into Loading state first', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new LoadGatedFakeDevice('1.1.9', backing);
    await dev.downloadDevice('1.1.9', steps, null, null, payload, undefined, {
      resolvedBases: { 4: RESOLVED_BASE },
    });

    assert.deepEqual(
      [...dev.memory.subarray(RESOLVED_BASE, RESOLVED_BASE + 20)],
      [...payload],
      'the real payload should be present at the real address once loaded correctly',
    );
    assert.equal(dev.rejectedWrites.length, 0, 'no write should have been rejected');
  });

  it('sends the exact real LSM event sequence, byte-verified against 4 independent real captures', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new LoadGatedFakeDevice('1.1.9', backing);
    await dev.downloadDevice('1.1.9', steps, null, null, payload, undefined, {
      resolvedBases: { 4: RESOLVED_BASE },
    });

    const hexEvents = dev.lsmEvents.map((e) => ({
      objIdx: e.objIdx,
      full: e.data.toString('hex'), // e.data already includes the leading event byte
    }));
    assert.deepEqual(hexEvents, [
      { objIdx: 4, full: '04000000000000000000' }, // Unload
      { objIdx: 4, full: '01000000000000000000' }, // StartLoading
      // LoadData: size=20 (0x0014), combined=1 (two RelSegment entries), fill=255
      { objIdx: 4, full: '030b0000001401ff0000' },
      { objIdx: 4, full: '02000000000000000000' }, // LoadCompleted
    ]);
  });

  it('WITHOUT the fix (no RelSegment steps in the model): the write is correctly rejected by the gated fake device', async () => {
    // Simulates exactly what koolenex sent before this fix, for an app
    // whose loadProcedures model doesn't declare a RelSegment for the
    // object being written (matches every app tested so far, pre-fix) -
    // proves the fake device's gating is real (would have caught the
    // original bug), not just a tautology that always passes.
    const bareSteps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 4, propId: 0, size: 20, offset: 0 },
    ];
    const backing = Buffer.alloc(0x10000);
    const dev = new LoadGatedFakeDevice('1.1.9', backing);
    await dev.downloadDevice('1.1.9', bareSteps, null, null, payload, undefined, {
      resolvedBases: { 4: RESOLVED_BASE },
    });

    assert.equal(dev.lsmEvents.length, 0, 'no load-state transition should have been sent at all');
    assert.ok(dev.rejectedWrites.length > 0, 'every write should have been rejected (device never entered Loading state)');
    assert.ok(
      dev.memory.subarray(RESOLVED_BASE, RESOLVED_BASE + 20).every((b) => b === 0),
      'memory should be unchanged - exactly what was observed on real hardware',
    );
  });
});
