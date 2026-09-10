/**
 * Protocol-level test harness for downloadDevice()'s memory-write-service
 * resolution (legacy A_Memory_Write vs extended A_MemoryExtended_Write) -
 * see the resolution comment block in knx-connection.ts covering
 * `SupportsExtendedMemoryServices` (checked first) and the restored
 * `PID_MCB_TABLE` byte-5 check (the fallback chain underneath it) for the
 * full real-hardware evidence this priority chain is built from.
 *
 * Adapted from this repo's own `tests/relmem-write-protocol.test.ts`
 * (`FakeWritableMemoryDevice`) - that harness has no
 * PropertyValue_Read/Write responder, which this resolution chain needs
 * (`PID_MCB_TABLE` is read via PropertyValue_Read). Two kinds of coverage
 * here: synthetic per-signal resolution cases (does each priority-chain
 * branch select the correct service), and a golden-capture replay (a fake
 * device seeded with the real mask/MCB values captured from a real Zennio
 * KLIC-DI v2, downloading the real 57,076-byte image ETS itself wrote to a
 * blank example of this device - see
 * `fixtures/1140-zennio-real-blank-device-write-README.md` - then
 * byte-comparing what landed in the fake device's own backing memory
 * against that same real capture, rather than inferring correctness from
 * which APCI was used).
 *
 * See docs/knx-device-write-protocol.md §4.1 for the full evidence behind
 * this resolution chain.
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

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
function loadFixtureHex(name: string): Buffer {
  return Buffer.from(
    fs.readFileSync(path.join(FIXTURES, name), 'utf8').trim(),
    'hex',
  );
}

/**
 * Minimal fake device: answers just enough of the real protocol for a
 * step-less-of-LSM `WriteRelMem`-only download to complete (see this
 * repo's own `relmem-write-protocol.test.ts` for why omitting a
 * `RelSegment` step + supplying `resolvedBases` skips the whole
 * Unload/StartLoading/LoadData/LoadCompleted/Restart cycle entirely - only
 * Authorize, DeviceDescriptor_Read, PropertyValue_Read/Write, and the
 * actual memory-write chunks are needed).
 */
class FakeResolutionDevice extends KnxConnection {
  sent: Buffer[] = [];
  /** Backing memory - Memory_Write/MemoryExtended_Write chunks are applied
   *  here for real, so a golden-capture replay test can read back exactly
   *  what landed and byte-compare it against the real captured content -
   *  not just infer correctness from which service was used. */
  memory: Buffer;
  private readonly deviceAddr: string;
  private readonly maskVersion: number | null;
  /** byte 5 of a LIVE PropertyValue_Read OX=4 P=27 response - `null` means
   *  the device never answers at all (property doesn't exist for this app,
   *  matching most real apps that never declare it either way). */
  private readonly liveMcbByte5: number | null;

  constructor(
    deviceAddr: string,
    opts: {
      maskVersion?: number | null;
      liveMcbByte5?: number | null;
      memorySize?: number;
    } = {},
  ) {
    super();
    this.deviceAddr = deviceAddr;
    this.connected = true;
    this.localAddr = '1.0.1';
    this.maskVersion = opts.maskVersion ?? 0x07b0;
    this.liveMcbByte5 = opts.liveMcbByte5 ?? null;
    this.memory = Buffer.alloc(opts.memorySize ?? 0x1000);
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      if (this.maskVersion == null) return Promise.resolve(); // simulate no response
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(this.maskVersion);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }

    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;

    if (fullApci === APCI_EXT.Authorize_Request) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
      return Promise.resolve();
    }

    if (fullApci === APCI_EXT.PropertyValue_Read) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      if (objIdx === 4 && propId === 27) {
        if (this.liveMcbByte5 == null) return Promise.resolve(); // property doesn't exist - no response, propRead() times out gracefully
        // Real 8-byte PID_MCB_TABLE element shape - only byte 5 matters for
        // this decision, the rest is filler (real values seen: e.g.
        // 0002E00000336250 for the real Zennio device this fix is based on).
        const value = Buffer.alloc(8);
        value[5] = this.liveMcbByte5;
        const meta = Buffer.from([objIdx, propId, 0x11, 0x01]);
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([meta, value]),
          ),
        );
      }
      return Promise.resolve();
    }

    if (fullApci === APCI_EXT.PropertyValue_Write) {
      // Generic ack - real devices echo the write back; the exact echoed
      // value is never inspected by anything under test here.
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Write') {
      // extraBuf layout from apduMemoryWrite: [addrHi][addrLo][data...] -
      // count lives in the header word's low 6 bits, not a leading data
      // byte (see apduMemoryWrite's own doc comment, knx-cemi.ts).
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = frame.apduData.subarray(2, 2 + count);
      data.copy(this.memory, address);
      this.reply(
        apduGroup('Memory_Response', 0, frame.apduData.subarray(0, 2 + count)),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'MemoryExtended_Write') {
      // extraBuf layout from apduMemoryExtendedWrite: [count(1)][addr(3,BE)][data...]
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const data = frame.apduData.subarray(4, 4 + count);
      data.copy(this.memory, address);
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.MemoryExtended_Write_Response,
          Buffer.alloc(0),
        ),
      );
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every Memory_Write/MemoryExtended_Write chunk actually sent - just
   *  which service, since that's the only thing this suite cares about. */
  writeServicesUsed(): Array<'legacy' | 'extended'> {
    return this.sent
      .map((c) => parseCEMI(c))
      .filter(
        (f): f is NonNullable<typeof f> =>
          !!f &&
          (f.apciName === 'Memory_Write' ||
            f.apciName === 'MemoryExtended_Write'),
      )
      .map((f) =>
        f.apciName === 'MemoryExtended_Write' ? 'extended' : 'legacy',
      );
  }
}

const RESOLVED_BASE = 0xa000; // well within 16 bits - isolates the service decision from the address-size hard floor
const PAYLOAD = Buffer.alloc(16, 0xaa);

function baseSteps(mcbInlineByte5?: number): DownloadStep[] {
  const steps: DownloadStep[] = [
    {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: PAYLOAD.length,
      offset: 0,
    },
  ];
  if (mcbInlineByte5 !== undefined) {
    // Mirrors a real app's own `LdCtrlWriteProp ObjIdx="4" PropId="27"
    // InlineData="..."` declaration (e.g. the real Jung apps) - byte 5 at
    // the same offset real captures show it at.
    const data = Buffer.alloc(10);
    data[5] = mcbInlineByte5;
    steps.push({ type: 'WriteProp', objIdx: 4, propId: 27, data });
  }
  return steps;
}

describe('downloadDevice() memory-write-service resolution', () => {
  it('SupportsExtendedMemoryServices=true (top-priority signal) wins over a legacy-signaling static MCB byte', async () => {
    // A literal `<Options SupportsExtendedMemoryServices="true">` on the
    // app's own `<Static>` element, KNX-Association-documented (ETS6 SDK:
    // "Gets a value indicating whether extended memory services are
    // supported"). Checked before PID_MCB_TABLE - this test confirms it
    // wins even when the (lower-priority) MCB byte would indicate legacy.
    const dev = new FakeResolutionDevice('1.1.40', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.40',
      baseSteps(0x32) /* legacy-signaling MCB byte */,
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        supportsExtendedMemoryServices: true,
        isSecureEnabled: false,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'extended'),
      `expected all-extended, got ${JSON.stringify(used)}`,
    );
  });

  it('SupportsExtendedMemoryServices=false wins over an extended-signaling static MCB byte, with no live PID_MCB_TABLE read at all', async () => {
    // liveMcbByte5 deliberately left at its default (null/no-response) - if
    // the SupportsExtendedMemoryServices check did not short-circuit the MCB
    // read entirely, this fake device would never answer the
    // PropertyValue_Read and the resolution would fall through further down
    // the chain instead of proving the short-circuit. The static WriteProp
    // declaration (0x33) is still present in steps, so a check that skipped
    // this signal but still ran the fallback chain would resolve extended
    // here - this test only passes if the signal genuinely takes priority.
    const dev = new FakeResolutionDevice('1.1.11', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.11',
      baseSteps(0x33) /* extended-signaling MCB byte */,
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        supportsExtendedMemoryServices: false,
        isSecureEnabled: true,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'legacy'),
      `expected all-legacy, got ${JSON.stringify(used)}`,
    );
  });

  it('SupportsExtendedMemoryServices absent (undefined - e.g. a project imported before this field existed) falls through to the unchanged PID_MCB_TABLE/IsSecureEnabled/mask chain', async () => {
    // Same as the "static PID_MCB_TABLE byte5=0x33" case below, just
    // asserting explicitly that omitting the new field entirely reproduces
    // the exact pre-existing behavior - this new signal is a strict
    // superset, never a behavior change for a device it can't resolve.
    const dev = new FakeResolutionDevice('1.1.40', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.40',
      baseSteps(0x33),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        // supportsExtendedMemoryServices deliberately omitted (undefined)
        isSecureEnabled: false,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'extended'),
      `expected all-extended (via PID_MCB_TABLE, unchanged), got ${JSON.stringify(used)}`,
    );
  });

  it('address-size hard floor still wins over SupportsExtendedMemoryServices=false - address alone exceeding 0xFFFF forces extended', async () => {
    const HIGH_BASE = 0x1c3000; // exceeds 0xFFFF
    const dev = new FakeResolutionDevice('1.1.20', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.20',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: HIGH_BASE },
        cachedMaxApduLength: 233,
        supportsExtendedMemoryServices: false,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'extended'),
      `address > 0xFFFF must force extended regardless of the new signal, got ${JSON.stringify(used)}`,
    );
  });

  it('static PID_MCB_TABLE byte5=0x33 (declared WriteProp) -> extended, even with IsSecureEnabled=false', async () => {
    const dev = new FakeResolutionDevice('1.1.40', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.40',
      baseSteps(0x33),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        isSecureEnabled: false, // the real Zennio app's own declared value - would say "legacy" if it were consulted
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0, 'expected at least one write chunk');
    assert.ok(
      used.every((s) => s === 'extended'),
      `expected all-extended, got ${JSON.stringify(used)}`,
    );
  });

  it('static PID_MCB_TABLE byte5=0x32 (the real Weinzierl value) -> legacy, even with IsSecureEnabled=true', async () => {
    const dev = new FakeResolutionDevice('1.1.11', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.11',
      baseSteps(0x32),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        isSecureEnabled: true, // would say "extended" if it were consulted
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'legacy'),
      `expected all-legacy, got ${JSON.stringify(used)}`,
    );
  });

  it('live PID_MCB_TABLE read (no static WriteProp declared) byte5=0x33 -> extended - the real Zennio KLIC-DI v2 case', async () => {
    // This app only ever declares the read-only LdCtrlLoadImageProp for
    // PropId=27, never LdCtrlWriteProp - the whole reason the live-read
    // fallback exists (see the big comment in knx-connection.ts). Confirms
    // the fallback that was missing from the first (static-only) version of
    // this fix, which still used legacy for this exact app on real
    // hardware.
    const dev = new FakeResolutionDevice('1.1.40', {
      maskVersion: 0x07b0,
      liveMcbByte5: 0x33,
    });
    await dev.downloadDevice(
      '1.1.40',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        isSecureEnabled: false,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'extended'),
      `expected all-extended, got ${JSON.stringify(used)}`,
    );
  });

  it('PID_MCB_TABLE entirely unavailable (no static declaration, no live response - most real apps) falls back to IsSecureEnabled', async () => {
    const devTrue = new FakeResolutionDevice('1.1.9', {
      maskVersion: 0x07b0,
      liveMcbByte5: null,
    });
    await devTrue.downloadDevice(
      '1.1.9',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        isSecureEnabled: true,
      },
    );
    assert.ok(devTrue.writeServicesUsed().every((s) => s === 'extended'));

    const devFalse = new FakeResolutionDevice('1.1.20', {
      maskVersion: 0x07b0,
      liveMcbByte5: null,
    });
    await devFalse.downloadDevice(
      '1.1.20',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        isSecureEnabled: false, // the real HDL case
      },
    );
    assert.ok(devFalse.writeServicesUsed().every((s) => s === 'legacy'));
  });

  it('neither PID_MCB_TABLE nor IsSecureEnabled available -> falls back to the live mask read (System B -> extended)', async () => {
    const dev = new FakeResolutionDevice('1.1.9', {
      maskVersion: 0x07b0,
      liveMcbByte5: null,
    });
    await dev.downloadDevice(
      '1.1.9',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
        // extra.isSecureEnabled deliberately omitted (undefined)
      },
    );
    assert.ok(dev.writeServicesUsed().every((s) => s === 'extended'));
  });

  it('non-System-B mask, no other signal -> legacy via the mask fallback', async () => {
    const dev = new FakeResolutionDevice('1.1.24', {
      maskVersion: 0x0705,
      liveMcbByte5: null,
    });
    await dev.downloadDevice(
      '1.1.24',
      baseSteps(),
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: RESOLVED_BASE },
        cachedMaxApduLength: 233,
      },
    );
    assert.ok(dev.writeServicesUsed().every((s) => s === 'legacy'));
  });

  it('address-size hard floor still wins over a legacy MCB signal - address alone exceeding 0xFFFF forces extended', async () => {
    const HIGH_BASE = 0x1c3000; // exceeds 0xFFFF
    const dev = new FakeResolutionDevice('1.1.10', { maskVersion: 0x07b0 });
    await dev.downloadDevice(
      '1.1.10',
      baseSteps(0x32) /* legacy-signaling MCB byte */,
      null,
      null,
      PAYLOAD,
      undefined,
      {
        resolvedBases: { 4: HIGH_BASE },
        cachedMaxApduLength: 233,
      },
    );
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0);
    assert.ok(
      used.every((s) => s === 'extended'),
      `address > 0xFFFF must force extended regardless of the MCB signal, got ${JSON.stringify(used)}`,
    );
  });
});

describe('downloadDevice() golden-capture replay — real Zennio KLIC-DI v2', () => {
  // Real captured values, not synthetic - see
  // fixtures/1140-zennio-real-blank-device-write-README.md.
  const REAL_MASK = 0x07b0;
  const REAL_MCB_BYTE5 = 0x33; // from PropValueResp OX=4 P=27 = $0002E00000336250
  const REAL_BASE = 0xa000; // this device's real objIdx-4 base, from the same capture

  it('replays the exact real blank-device write (57,076 bytes) and lands byte-identical to what ETS itself wrote', async () => {
    const realImage = loadFixtureHex('1140-zennio-real-blank-device-write.hex');
    assert.equal(
      realImage.length,
      57076,
      'fixture should be the full real 57,076-byte capture',
    );

    const dev = new FakeResolutionDevice('1.1.40', {
      maskVersion: REAL_MASK,
      liveMcbByte5: REAL_MCB_BYTE5,
      memorySize: REAL_BASE + realImage.length,
    });
    const steps: DownloadStep[] = [
      {
        type: 'WriteRelMem',
        objIdx: 4,
        propId: 0,
        size: realImage.length,
        offset: 0,
      },
    ];
    await dev.downloadDevice(
      '1.1.40',
      steps,
      null,
      null,
      realImage,
      undefined,
      {
        resolvedBases: { 4: REAL_BASE },
        isSecureEnabled: false, // the real app's own declared value - would wrongly force legacy without the fix
        cachedMaxApduLength: 233, // this device's real cached value (see knx-connection.ts's own doc comment on this field)
      },
    );

    // Service: every chunk must be extended - real ETS used MemExtWrite
    // exclusively for this device, never legacy Memory_Write.
    const used = dev.writeServicesUsed();
    assert.ok(used.length > 0, 'expected at least one write chunk');
    assert.ok(
      used.every((s) => s === 'extended'),
      `expected all-extended (matching the real capture), got a mix/legacy: ${JSON.stringify(used)}`,
    );

    // Content: what actually landed in the fake device's backing memory,
    // read back at the real base address, must be byte-identical to the
    // real image we just fed in - proves the chunking/addressing loop
    // doesn't drop, misplace, or corrupt any byte across a genuinely large
    // (57KB, ~250-chunk) real-shaped write, not just a short synthetic one.
    const landed = dev.memory.subarray(REAL_BASE, REAL_BASE + realImage.length);
    assert.equal(
      landed.toString('hex'),
      realImage.toString('hex'),
      'bytes written via downloadDevice() should be byte-identical to the real captured image',
    );
  });
});
