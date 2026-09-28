/**
 * Loopback test for ParameterByteOrder gating: drives the real, unmodified
 * downloadDevice() path - buildParamMem() -> WriteRelMem -> the wire-encoding
 * code in knx-connection.ts - against a fake in-memory device (same
 * technique as relmem-write-protocol.test.ts), then reads the fake device's
 * backing buffer back to prove which byte landed at which address.
 *
 * dpt.test.ts / knx-tables.test.ts already prove writeBits()/readBits()
 * respect `byteOrder` in isolation; this exercises the full chain
 * (ParamModel.parameterByteOrder -> buildParamMem() -> downloadDevice() ->
 * WriteRelMem) that a unit test calling writeBits() directly cannot catch a
 * threading mistake in.
 *
 * One device per confirmed real-world case:
 *   - LittleEndian: a real product's Union (enum 1283 = "0.5s"), which only
 *     holds if the 16-bit value's low byte lands at the lower offset - see
 *     writeBits()'s own doc comment.
 *   - BigEndian (also the fallback when the attribute is absent): the
 *     opposite order, matching every other real-hardware case checked (see
 *     docs/knx-device-write-protocol.md §6.1a).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduConnectedFull,
  apduGroup,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';
import {
  buildParamMem,
  decodeParamMem,
  type ParamMemEntry,
} from '../server/routes/knx-tables.ts';

/**
 * Minimal fake device: answers DeviceDescriptor_Read (System B, so writes
 * resolve to the real protocol steps downloadDevice() would actually take)
 * and Authorize_Request, and applies a real Memory_Write straight to its own
 * backing buffer - so the buffer's state after downloadDevice() reflects
 * exactly what the real write path put on the wire, byte order included.
 */
class FakeWritableMemoryDevice extends KnxConnection {
  memory: Buffer;
  private readonly deviceAddr: string;
  constructor(deviceAddr: string, memory: Buffer) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(0x07b0); // System B
      const respApdu = apduGroup('DeviceDescriptor_Response', 0, maskBuf);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }

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
      // This file only cares about Memory_Write/MemoryExtended_Write landing
      // at the right address/byte order - it doesn't model Load State
      // (objIdx 5's Unload, etc.) the way relmem-load-sequence.test.ts's
      // LoadGatedFakeDevice does. downloadDevice() waits for a real
      // PropertyValue_Response to EVERY PropertyValue_Write it sends
      // (propWrite()'s own wait) - the mask-driven object-5/PEI Program
      // Unload sends one of these unconditionally for a System-B-mask
      // device (this test's own DeviceDescriptor_Response above). Ack
      // generically, matching what a real device does, so that write
      // doesn't go unconfirmed for reasons this file isn't testing.
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
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = frame.apduData.subarray(2, 2 + count);
      data.copy(this.memory, address);
      const respApdu = apduGroup('Memory_Response', 0, frame.apduData);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame.apciName === 'MemoryExtended_Write') {
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
}

async function runLoopback(
  devAddr: string,
  base: number,
  paramMem: Buffer,
): Promise<Buffer> {
  const backing = Buffer.alloc(base + paramMem.length + 16);
  const dev = new FakeWritableMemoryDevice(devAddr, backing);
  const steps: DownloadStep[] = [
    {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: paramMem.length,
      offset: 0,
    },
  ];
  const result = await dev.downloadDevice(
    devAddr,
    steps,
    null,
    null,
    paramMem,
    undefined,
    { resolvedBases: { 4: base } },
  );
  assert.equal(
    result.unconfirmedWrites,
    0,
    `every write should be confirmed: ${JSON.stringify(result)}`,
  );
  return dev.memory.subarray(base, base + paramMem.length);
}

describe('ParameterByteOrder gating — full downloadDevice() loopback, one device per real-world case', () => {
  const BASE = 0x4000;

  // LittleEndian device: M-0002_A-A001-13-63C2's own real Union declaration
  // (see writeBits()'s doc comment, knx-tables.ts) - enum 1283 = "0.5s" only
  // holds if the low byte lands at the lower offset.
  it("LittleEndian app: a real product's 16-bit enum lands least-significant byte first on the wire", async () => {
    const layout: Record<string, ParamMemEntry> = {
      up44: { offset: 3, bitOffset: 0, bitSize: 16, defaultValue: '1283' },
    };
    const paramMem = buildParamMem(
      8,
      layout,
      {},
      0xff,
      null,
      null,
      null,
      undefined,
      'LittleEndian',
    );

    const written = await runLoopback('1.1.20', BASE, paramMem);

    // 1283 = 0x0503 -> LittleEndian = [0x03, 0x05] at offset 3.
    assert.equal(written[3], 0x03, 'low byte (base=100ms) at the lower offset');
    assert.equal(written[4], 0x05, 'high byte (factor=5) at the higher offset');

    const decoded = decodeParamMem(written, layout, null, 'LittleEndian');
    assert.equal(
      decoded[0]!.rawValue,
      1283,
      'round-trips through the real wire bytes',
    );
  });

  // BigEndian device (also the fallback when the attribute is absent) -
  // matches every real-hardware case checked so far (see
  // docs/knx-device-write-protocol.md §6.1a).
  it('BigEndian app: a 16-bit value lands most-significant byte first on the wire', async () => {
    const layout: Record<string, ParamMemEntry> = {
      up1: { offset: 2, bitOffset: 0, bitSize: 16, defaultValue: '4660' }, // 0x1234
    };
    const paramMem = buildParamMem(
      8,
      layout,
      {},
      0xff,
      null,
      null,
      null,
      undefined,
      'BigEndian',
    );

    const written = await runLoopback('1.1.10', BASE, paramMem);

    assert.equal(written[2], 0x12, 'high byte at the lower offset');
    assert.equal(written[3], 0x34, 'low byte at the higher offset');

    const decoded = decodeParamMem(written, layout, null, 'BigEndian');
    assert.equal(
      decoded[0]!.rawValue,
      4660,
      'round-trips through the real wire bytes',
    );
  });

  it('absent ParameterByteOrder falls back to the same BigEndian order', async () => {
    const layout: Record<string, ParamMemEntry> = {
      up1: { offset: 2, bitOffset: 0, bitSize: 16, defaultValue: '4660' },
    };
    const paramMem = buildParamMem(8, layout, {}, 0xff, null, null, null);

    const written = await runLoopback('1.1.9', BASE, paramMem);

    assert.equal(written[2], 0x12);
    assert.equal(written[3], 0x34);
  });
});
