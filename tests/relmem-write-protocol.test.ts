/**
 * Protocol-level test for the WRITE side of address resolution in
 * knx-connection.ts's WriteRelMem case, covering 16-bit address truncation
 * (memory-read.test.ts's FakeMemoryDevice covers the READ side, but has no
 * write handling).
 *
 * Uses a protocol-level fake device (subclasses KnxConnection, intercepts
 * sendCEMI, replies with real CEMI-encoded responses) seeded with a real
 * captured memory map from an ETS download -
 * tests/fixtures/relmem-real-devices/1.1.10-expected-computed.hex (the
 * to-write payload) cross-checked against full-download-1.1.10-writes.json
 * (real offsets/bytes ETS wrote during a Full Download). Runs the real,
 * unmodified downloadDevice()/WriteRelMem path against the fake device, then
 * inspects its backing buffer to confirm where bytes actually landed. No
 * hardware/bus/testbed needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCEMI,
  buildCEMI,
  apduConnectedFull,
  apduGroup,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'relmem-real-devices');

function loadHex(name: string): Buffer {
  return Buffer.from(
    fs.readFileSync(path.join(FIX, name), 'utf8').trim(),
    'hex',
  );
}

function loadJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

/**
 * Like memory-read.test.ts's FakeMemoryDevice, but also answers
 * Memory_Write and MemoryExtended_Write by applying the write directly to
 * its own backing buffer - so the buffer's state after a downloadDevice()
 * call reflects exactly what koolenex's real write path actually did,
 * address selection included.
 */
class FakeWritableMemoryDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory: Buffer;
  private readonly deviceAddr: string;
  // Mask version reported on A_DeviceDescriptor_Read; gates legacy vs
  // extended write service selection (knx-connection.ts's WriteRelMem case).
  // Defaults to `0x07B0` (System B), matching the real device (1.1.10) these
  // fixtures were captured from. `null` simulates a device that never
  // answers the descriptor read (exercises the address-size fallback).
  private readonly maskVersion: number | null;
  constructor(
    deviceAddr: string,
    memory: Buffer,
    maskVersion: number | null = 0x07b0,
  ) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
    this.maskVersion = maskVersion;
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      if (this.maskVersion == null) return Promise.resolve(); // simulate no response
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(this.maskVersion);
      const respApdu = apduGroup('DeviceDescriptor_Response', 0, maskBuf);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

    // downloadDevice() sends A_Authorize_Request before any RelSegment-
    // driven writes and waits for the response - respond like real hardware
    // does, or every download stalls on the 3s wait timeout.
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    if (fullApci === 0x3d1 /* Authorize_Request */) {
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.Authorize_Response,
        Buffer.from([0x00]),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

    if (fullApci === 0x3d7 /* PropertyValue_Write */) {
      // This file doesn't model Load State (objIdx 5's Unload, PID_PROGRAM_
      // VERSION write-back, etc.) like relmem-load-sequence.test.ts's
      // LoadGatedFakeDevice does - it only cares about Memory_Write/
      // MemoryExtended_Write landing at the right address. downloadDevice()
      // waits for a real PropertyValue_Response to every PropertyValue_Write
      // it sends (propWrite()'s 3s wait); ack generically here so an
      // unrelated write doesn't inflate result.unconfirmedWrites.
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const data = frame.apduData.subarray(4);
      const respApdu = apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([
          Buffer.from([objIdx, propId, 0x10, 0x01]),
          data.length ? data : Buffer.from([0x00]),
        ]),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Write') {
      // extraBuf layout from apduMemoryWrite: [addrHi][addrLo][data...] -
      // count lives in the low 6 bits of the APCI header word, not as a
      // leading data byte (see apduMemoryWrite's doc comment in
      // knx-cemi.ts).
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = frame.apduData.subarray(2, 2 + count);
      data.copy(this.memory, address);
      // downloadDevice()'s WriteRelMem loop waits for each chunk's response
      // before sending the next - respond like real hardware does, or the
      // write stalls on the 3s timeout.
      const respApdu = apduGroup('Memory_Response', 0, frame.apduData);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'MemoryExtended_Write') {
      // extraBuf layout from apduMemoryExtendedWrite: [count(1)][addr(3,BE)][data...]
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const data = frame.apduData.subarray(4, 4 + count);
      data.copy(this.memory, address);
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

  /** Every Memory_Write/MemoryExtended_Write frame actually sent, decoded. */
  writesSent(): Array<{ extended: boolean; address: number; count: number }> {
    return this.sent
      .map((c) => parseCEMI(c))
      .filter(
        (f): f is NonNullable<typeof f> =>
          !!f &&
          (f.apciName === 'Memory_Write' ||
            f.apciName === 'MemoryExtended_Write'),
      )
      .map((f) => {
        if (f.apciName === 'MemoryExtended_Write') {
          return {
            extended: true,
            address:
              (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!,
            count: f.apduData[0]!,
          };
        }
        return {
          extended: false,
          // extraBuf layout from apduMemoryWrite: [addrHi][addrLo][data...];
          // count lives in the header word's low 6 bits (see the sendCEMI
          // handler above for the fuller note).
          address: (f.apduData[0]! << 8) | f.apduData[1]!,
          count: f.apdu[1]! & 0x3f,
        };
      });
  }
}

describe('WriteRelMem protocol-level test — 1.1.10 (real captured memory, base > 0xFFFF)', () => {
  const RESOLVED_BASE = 0xc3000; // real PID-7-resolved base for this device/app
  const writes = loadJson('full-download-1.1.10-writes.json');
  const expected = loadHex('1.1.10-expected-computed.hex'); // koolenex's own computed image - the payload under test

  // downloadDevice()'s WriteRelMem loop delays 30ms per 10-byte chunk
  // (matches bus pacing); replaying the full 10433-byte segment would take
  // ~30s per test. The address-selection logic under test (`addr > 0xffff`)
  // only cares about each chunk's resolved address, not segment size, so a
  // short slice proves the same thing faster. Two windows: a near-start
  // slice (covers named-parameter offsets 69/172-199) and the single byte at
  // the end of the segment (offset 10432) - separate downloadDevice() calls,
  // since a shared `paramMem` is always sliced from its own offset 0
  // regardless of the step's target `offset` (see knx-connection.ts's
  // WriteRelMem case).
  const NEAR_START = expected.subarray(0, 200);
  const TAIL_BYTE = expected.subarray(10432, 10433);

  it('writes every chunk via MemoryExtended_Write (never legacy Memory_Write), since the base alone exceeds 0xFFFF', async () => {
    const backing = Buffer.alloc(0x100000); // room for the real base + segment
    const dev = new FakeWritableMemoryDevice('1.1.10', backing);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: NEAR_START.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice(
      '1.1.10',
      steps,
      null,
      null,
      NEAR_START,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
      },
    );

    const sentWrites = dev.writesSent();
    assert.ok(sentWrites.length > 0, 'expected at least one write chunk');
    assert.ok(
      sentWrites.every((w) => w.extended),
      `every chunk should use MemoryExtended_Write (base 0x${RESOLVED_BASE.toString(16)} alone exceeds 0xFFFF) - got: ${JSON.stringify(sentWrites)}`,
    );
    // None should have silently truncated to a low address - every real
    // address must actually be >= the resolved base.
    assert.ok(
      sentWrites.every((w) => w.address >= RESOLVED_BASE),
      `every write address should be >= 0x${RESOLVED_BASE.toString(16)} - a truncated write would show up as a low address here`,
    );
  });

  it('the real named-parameter bytes land at the correct absolute address in device memory', async () => {
    const backing = Buffer.alloc(0x100000);
    const dev = new FakeWritableMemoryDevice('1.1.10', backing);

    // Pass 1: the near-start real bytes (covers offset 172, one of the two
    // real captured named-parameter writes).
    await dev.downloadDevice(
      '1.1.10',
      [
        {
          type: 'WriteRelMem',
          objIdx: 4,
          propId: 0,
          size: NEAR_START.length,
          offset: 0,
        },
      ],
      null,
      null,
      NEAR_START,
      undefined,
      { resolvedBases: { 4: RESOLVED_BASE } },
    );
    // Pass 2: the single real byte at the very end of the segment (offset
    // 10432, the other real captured named-parameter write) - a fresh
    // paramMem containing just that one real byte, targeted via `offset`.
    await dev.downloadDevice(
      '1.1.10',
      [{ type: 'WriteRelMem', objIdx: 4, propId: 0, size: 1, offset: 10432 }],
      null,
      null,
      TAIL_BYTE,
      undefined,
      { resolvedBases: { 4: RESOLVED_BASE } },
    );

    // Cross-check against the real write-ops fixture (what ETS itself
    // wrote) - proves the write lands the same values at the same
    // addresses ETS did, not just "wrote something at the right offset".
    for (const w of writes.paramWrites) {
      const absAddr = RESOLVED_BASE + w.offsetFromBase;
      const got = dev.memory
        .subarray(absAddr, absAddr + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `offset ${w.offsetFromBase} (absolute 0x${absAddr.toString(16)}): fake device has ${got}, real ETS capture said ${w.hex}`,
      );
    }
  });

  it('a chunk straddling the 0xFFFF boundary still resolves to the correct address, via the fallback heuristic (device never answers DeviceDescriptor_Read)', async () => {
    // Write service selection gates on the device's real mask version (see
    // knx-connection.ts's WriteRelMem case): extended unconditionally for a
    // confirmed System B device, falling back to this address-size
    // heuristic when the mask is unread/unrecognized. This exercises the
    // fallback path (`maskVersion: null` simulates a device that never
    // answers the descriptor read); see the dedicated mask-gating test
    // further down for the System-B-confirmed case.
    const backing = Buffer.alloc(0x10100);
    const dev = new FakeWritableMemoryDevice('1.1.10', backing, null);
    const payload = Buffer.alloc(250, 0xaa);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    // Base/length chosen so the write region straddles 0xFFFF with the real
    // MEM_CHUNK=228 (see knx-connection.ts's own comment). downloadDevice()'s
    // WriteRelMem loop chunks at up to 228 bytes for the extended service,
    // but re-caps to 63 for legacy (its 6-bit wire count field - see
    // knx-connection.ts's comment on `stepSize`, next to apduMemoryWrite's
    // doc comment in knx-cemi.ts): base 0xFFDC (65500) + off 0 = 0xFFDC fits
    // in 16 bits, so chunk 1 is legacy and capped at 63 bytes; base 0xFFDC +
    // off 63 = 65563 = 0xFFFB already exceeds 0xFFFF, so chunk 2 (the
    // remaining 187 bytes) switches to extended.
    await dev.downloadDevice('1.1.10', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0xffdc },
    });

    const sentWrites = dev.writesSent();
    assert.equal(
      sentWrites.length,
      2,
      'expected 2 chunks: 63 legacy bytes then 187 extended bytes',
    );
    assert.equal(
      sentWrites[0]!.extended,
      false,
      'fallback heuristic: first chunk (0xFFDC) fits in 16 bits',
    );
    assert.equal(sentWrites[0]!.address, 0xffdc);
    assert.equal(
      sentWrites[0]!.count,
      63,
      'legacy chunk capped at its 6-bit wire count-field max',
    );
    assert.equal(
      sentWrites[1]!.extended,
      true,
      'fallback heuristic: second chunk (0xFFFB) does not fit',
    );
    assert.equal(sentWrites[1]!.address, 0xffdc + 63);
    assert.deepEqual(
      [...dev.memory.subarray(0xffdc, 0xffdc + 250)],
      [...payload],
    );
  });

  it('writes PID_DEVICE_CONTROL Verify Mode ($04) before memory writes when the write service resolves to legacy', async () => {
    // A legacy A_Memory_Write only gets a real A_Memory_Response if Verify
    // Mode is set first (see knx-connection.ts's doc comment on this
    // write). Gated on the resolved write service, not a project-file
    // `Verify="true"` attribute (that attribute is present identically on
    // apps that never receive this write). `isSecureEnabled: false` forces
    // legacy resolution deterministically.
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.20', backing, null);
    const payload = Buffer.alloc(5, 0xaa);
    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice('1.1.20', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x1000 },
      isSecureEnabled: false,
    });
    const verifyModeWrites = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f): f is NonNullable<typeof f> => {
        if (!f) return false;
        const fullApci =
          f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
        return (
          fullApci === 0x3d7 /* PropertyValue_Write */ &&
          f.apduData[0] === 0 /* objIdx 0 */ &&
          f.apduData[1] === 14 /* PID_DEVICE_CONTROL */
        );
      });
    assert.equal(
      verifyModeWrites.length,
      1,
      'expected exactly one PID_DEVICE_CONTROL write',
    );
    assert.equal(
      verifyModeWrites[0]!.apduData[4],
      0x04,
      'Verify Mode bit (bit 2) should be set',
    );
  });

  it('also writes PID_DEVICE_CONTROL when the write service could not be resolved at all (conservative default)', async () => {
    // No `isSecureEnabled` and no answered DeviceDescriptor_Read (mask
    // null): `useExtendedMemory` stays unresolved, treated the same as
    // legacy - sending this write to a device that doesn't need it is
    // harmless, while omitting it from a device that does need it silently
    // loses every write confirmation.
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.20', backing, null);
    const payload = Buffer.alloc(5, 0xaa);
    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice('1.1.20', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x1000 },
    });
    const verifyModeWrites = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f): f is NonNullable<typeof f> => {
        if (!f) return false;
        const fullApci =
          f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
        return (
          fullApci === 0x3d7 /* PropertyValue_Write */ &&
          f.apduData[0] === 0 /* objIdx 0 */ &&
          f.apduData[1] === 14 /* PID_DEVICE_CONTROL */
        );
      });
    assert.equal(
      verifyModeWrites.length,
      1,
      'expected exactly one PID_DEVICE_CONTROL write',
    );
  });

  it('does NOT write PID_DEVICE_CONTROL when the write service resolves to extended', async () => {
    // Other side of the same gate: a device using the extended service
    // never receives this write - the extended-write handler has no Verify
    // Mode dependency.
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.20', backing, null);
    const payload = Buffer.alloc(5, 0xaa);
    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice('1.1.20', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x1000 },
      isSecureEnabled: true,
    });
    const verifyModeWrites = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f): f is NonNullable<typeof f> => {
        if (!f) return false;
        const fullApci =
          f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
        return (
          fullApci === 0x3d7 /* PropertyValue_Write */ &&
          f.apduData[0] === 0 /* objIdx 0 */ &&
          f.apduData[1] === 14 /* PID_DEVICE_CONTROL */
        );
      });
    assert.equal(verifyModeWrites.length, 0);
  });

  it("gates on the device's real mask version: System B (0x07B0) always uses A_MemoryExtended_Write, even for a 16-bit-fitting address", async () => {
    // A captured ETS Partial Download against a System B device (mask
    // 0x07B0, address 0x5F53, well within 16 bits) used
    // A_MemoryExtended_Write exclusively - see knx-connection.ts's
    // WriteRelMem case.
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.9', backing, 0x07b0);
    const payload = Buffer.alloc(5, 0xaa);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice('1.1.9', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x5f53 }, // well within 16 bits
    });

    const sentWrites = dev.writesSent();
    assert.equal(sentWrites.length, 1);
    assert.equal(
      sentWrites[0]!.extended,
      true,
      'System B device: extended even though the address fits in 16 bits',
    );
    assert.equal(sentWrites[0]!.address, 0x5f53);
  });

  it("gates on the device's real mask version: a legacy (non-System-B) device falls back to the address-size heuristic", async () => {
    // Other side of the gate: a recognized non-System-B mask (e.g. 0x0020 =
    // BCU2, per the bundled KNX Master Data, data/knx_master_*.xml) must not
    // be forced onto the extended service for a low address - untested on
    // real hardware, so the fallback stays conservative rather than
    // assuming "always extended" generalizes.
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.1', backing, 0x0020);
    const payload = Buffer.alloc(5, 0xaa);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice('1.1.1', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0x5f53 },
    });

    const sentWrites = dev.writesSent();
    assert.equal(sentWrites.length, 1);
    assert.equal(
      sentWrites[0]!.extended,
      false,
      'BCU2 (non-System-B): address fits in 16 bits, so legacy Memory_Write',
    );
    assert.equal(sentWrites[0]!.address, 0x5f53);
  });
});

/** Like FakeWritableMemoryDevice, but never answers a memory write - proves
 * an unanswered write is reported, not silently swallowed as success (see
 * DownloadResult, knx-connection.ts). */
class UnresponsiveMemoryDevice extends FakeWritableMemoryDevice {
  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (
      frame &&
      (frame.apciName === 'Memory_Write' ||
        frame.apciName === 'MemoryExtended_Write')
    ) {
      this.sent.push(cemi);
      return Promise.resolve(); // swallow - simulate no response
    }
    return super.sendCEMI(cemi);
  }
}

describe('downloadDevice() reports unconfirmed writes instead of silent success', () => {
  it('surfaces a write whose response never arrived, rather than reporting unconditional success', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new UnresponsiveMemoryDevice('1.1.9', backing);
    const payload = Buffer.alloc(5, 0xaa);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    const result = await dev.downloadDevice(
      '1.1.9',
      steps,
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: 0x5f53 },
      },
    );

    assert.equal(result.unconfirmedWrites, 1);
    assert.equal(result.unconfirmedDetails.length, 1);
    assert.match(result.unconfirmedDetails[0]!, /unconfirmed/);
    // The write was still genuinely attempted (sent on the wire) - this is
    // "no response", not "never sent".
    assert.equal(dev.writesSent().length, 1);
  });

  it('reports zero unconfirmed writes when every write gets its response', async () => {
    const backing = Buffer.alloc(0x10000);
    const dev = new FakeWritableMemoryDevice('1.1.9', backing);
    const payload = Buffer.alloc(5, 0xaa);

    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: payload.length,
        offset: 0,
      },
    ];
    const result = await dev.downloadDevice(
      '1.1.9',
      steps,
      null,
      null,
      payload,
      undefined,
      {
        resolvedBases: { 4: 0x5f53 },
      },
    );

    assert.equal(result.unconfirmedWrites, 0);
    assert.deepEqual(result.unconfirmedDetails, []);
  });
});
