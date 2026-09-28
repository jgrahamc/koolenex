/**
 * A legacy A_Memory_Read carries only a 16-bit address, so a request that
 * starts below 0x10000 but whose byte count would carry its end past it is
 * not representable. Real devices answer such a request with a zero-byte
 * response rather than serving it. readMemory() therefore clamps a legacy
 * chunk at the 0xFFFF boundary and lets the remainder go out as an
 * A_MemoryExtended_Read from 0x10000.
 *
 * The fake device below behaves like that real hardware: it refuses (zero
 * bytes) any legacy request whose end crosses 0x10000. The assertions are on
 * the frames that actually went on the wire - not just on the returned bytes -
 * because a reader that retried its way down to a smaller size would also end
 * up with correct data; only the clamp keeps the FIRST request in range.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apduGroup,
  apduConnectedFull,
  buildCEMI,
  parseCEMI,
  TPCI,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

const DEV = '1.1.10';

class BoundaryDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly memory: Buffer;
  constructor(memory: Buffer) {
    super();
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(buildCEMI(DEV, this.localAddr, apdu, false))!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      this.reply(
        apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
      );
      return Promise.resolve();
    }
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;

    // PID_MAX_APDULENGTH: a generous value so it never limits the chunk size.
    if (fullApci === APCI_EXT.PropertyValue_Read) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      if (objIdx === 0 && propId === 56) {
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.from([objIdx, propId, 0x10, 0x01, 0x03, 0xe8]),
          ),
        );
      }
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      // Real behaviour: a request whose end crosses the 16-bit limit is
      // answered with zero bytes, not served.
      const served = address + count > 0x10000 ? 0 : count;
      const data = this.memory.subarray(address, address + served);
      const word = (TPCI.DATA_CONNECTED << 10) | (9 << 6) | served;
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
    } else if (frame.apciName === 'MemoryExtended_Read') {
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
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  legacyReads(): Array<{ address: number; count: number }> {
    const out: Array<{ address: number; count: number }> = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (f?.apciName === 'Memory_Read') {
        out.push({
          address: (f.apduData[0]! << 8) | f.apduData[1]!,
          count: f.apdu[1]! & 0x3f,
        });
      }
    }
    return out;
  }

  extendedReads(): Array<{ address: number; count: number }> {
    const out: Array<{ address: number; count: number }> = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (f?.apciName === 'MemoryExtended_Read') {
        out.push({
          count: f.apduData[0]!,
          address:
            (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!,
        });
      }
    }
    return out;
  }
}

function patterned(size: number): Buffer {
  const mem = Buffer.alloc(size);
  for (let i = 0; i < mem.length; i++) mem[i] = (i * 7 + 3) & 0xff;
  return mem;
}

describe('readMemory(): legacy chunks are clamped at the 0xFFFF boundary', () => {
  it('a default-size read starting 6 bytes below 0x10000 splits into one legacy read up to the boundary and an extended read from it', async () => {
    const mem = patterned(0x10100);
    const dev = new BoundaryDevice(mem);

    // No chunk size given: the legacy service's own 63-byte ceiling applies,
    // so the naive first chunk would be 63 bytes from 0xFFFA and end at
    // 0x10039 - the request shape a real device refused.
    const out = await dev.readMemory(DEV, 0xfffa, 100);

    assert.deepEqual([...out], [...mem.subarray(0xfffa, 0xfffa + 100)]);
    assert.deepEqual(dev.legacyReads(), [{ address: 0xfffa, count: 6 }]);
    assert.deepEqual(dev.extendedReads(), [{ address: 0x10000, count: 94 }]);
  });

  it('never puts a legacy request on the wire whose end crosses 0x10000', async () => {
    const mem = patterned(0x10100);
    const dev = new BoundaryDevice(mem);

    // An explicit chunk size larger than the room left below the boundary.
    const out = await dev.readMemory(DEV, 0xfff0, 32, 32);

    assert.deepEqual([...out], [...mem.subarray(0xfff0, 0xfff0 + 32)]);
    for (const r of dev.legacyReads()) {
      assert.ok(
        r.address + r.count <= 0x10000,
        `legacy read of ${r.count} at 0x${r.address.toString(16)} crosses 0x10000`,
      );
    }
    assert.deepEqual(dev.legacyReads(), [{ address: 0xfff0, count: 16 }]);
    assert.deepEqual(dev.extendedReads(), [{ address: 0x10000, count: 16 }]);
  });

  it('a read that ends exactly on the boundary stays one full legacy read (no needless split)', async () => {
    const mem = patterned(0x10100);
    const dev = new BoundaryDevice(mem);

    const out = await dev.readMemory(DEV, 0xffe0, 32, 32);

    assert.deepEqual([...out], [...mem.subarray(0xffe0, 0xffe0 + 32)]);
    assert.deepEqual(dev.legacyReads(), [{ address: 0xffe0, count: 32 }]);
    assert.deepEqual(dev.extendedReads(), []);
  });
});
