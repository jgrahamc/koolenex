/**
 * A legacy A_Memory_Read that gets no answer at all is retried smaller.
 *
 * Real failure, 2026-09-11: Verify of a mask 0x0701 device at 1.5.11 read
 * its device descriptor fine and then sat out the full 3s timeout waiting
 * for a Memory_Response that never came:
 *
 *   18:45:57.407 DeviceDescriptor mask=0x0701 (legacy family ...)
 *   18:46:00.520 Device verify failed: Management timeout waiting for
 *                Memory_Response
 *
 * readRegionInSession() already knew that a real device can refuse a
 * request size it can't serve - an HDL M/AG40B.1 was bisected to a hard
 * 52-byte ceiling - but only handled the polite form of that refusal, a
 * response carrying zero bytes. A device that simply says nothing hit a
 * bare transport timeout that named neither the address nor the size.
 *
 * The fake device here refuses by silence above a configurable ceiling,
 * which is the case that was missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCEMI, buildCEMI, apduGroup } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

/**
 * Answers DeviceDescriptor_Read and Memory_Read, and ignores a Memory_Read
 * asking for more than `readCeiling` bytes - no response of any kind, which
 * is what the real device did.
 */
class FakeSilentAboveCeilingDevice extends KnxConnection {
  memory: Buffer;
  /** (address, count) of every Memory_Read request received, in order. */
  reads: Array<{ address: number; count: number }> = [];

  private readonly deviceAddr: string;
  private readonly readCeiling: number;
  private readonly maskVersion: number;

  constructor(deviceAddr: string, readCeiling: number, maskVersion = 0x0701) {
    super();
    this.deviceAddr = deviceAddr;
    this.readCeiling = readCeiling;
    this.maskVersion = maskVersion;
    this.connected = true;
    this.localAddr = '1.0.1';
    this.memory = Buffer.alloc(0x5000);
    for (let i = 0; i < this.memory.length; i++) this.memory[i] = i & 0xff;
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(this.maskVersion);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      this.reads.push({ address, count });
      if (count > this.readCeiling) return Promise.resolve(); // silence
      const addrBuf = Buffer.from([(address >> 8) & 0xff, address & 0xff]);
      const data = this.memory.subarray(address, address + count);
      this.reply(
        apduGroup('Memory_Response', count, Buffer.concat([addrBuf, data])),
      );
      return Promise.resolve();
    }

    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('legacy A_Memory_Read against a device that answers nothing', () => {
  it('retries the chunk at 32 bytes and completes the read', async () => {
    const dev = new FakeSilentAboveCeilingDevice('1.5.11', 32);

    // cachedMaxApduLength 254 lets the sizing rules ask for the full 40 in
    // one go, which is exactly what the real Verify did.
    const out = await dev.readMemory('1.5.11', 0x0100, 40, 228, undefined, 254);

    assert.deepEqual([...out], [...dev.memory.subarray(0x0100, 0x0128)]);
    assert.deepEqual(dev.reads, [
      { address: 0x0100, count: 40 }, // refused by silence
      { address: 0x0100, count: 32 }, // the retry
      { address: 0x0120, count: 8 }, // remainder, normally
    ]);
  });

  it('reuses the size it learned for the rest of the region', async () => {
    // Without a remembered ceiling every chunk re-discovers the refusal,
    // which costs a 3s timeout each time - the difference between a slow
    // read and an unusable one.
    const dev = new FakeSilentAboveCeilingDevice('1.5.11', 32);

    const out = await dev.readMemory('1.5.11', 0x0200, 80, 228, undefined, 254);

    assert.deepEqual([...out], [...dev.memory.subarray(0x0200, 0x0250)]);
    assert.deepEqual(dev.reads, [
      { address: 0x0200, count: 63 }, // refused by silence
      { address: 0x0200, count: 32 }, // the retry, answered
      { address: 0x0220, count: 32 }, // straight to 32 from here on
      { address: 0x0240, count: 16 },
    ]);
  });

  it('drops all the way to a single byte when the first retry is too big', async () => {
    // The real case this ladder was added for: a mask 0x0701 device at
    // 1.1.20 declaring max APDU 15, so the read was only 12 bytes to
    // begin with - already at or under the single 32-byte step that used
    // to be the whole retry, which therefore never fired at all.
    const dev = new FakeSilentAboveCeilingDevice('1.1.20', 1);

    const out = await dev.readMemory('1.1.20', 0x4003, 3, 228, undefined, 15);

    assert.deepEqual([...out], [...dev.memory.subarray(0x4003, 0x4006)]);
    assert.deepEqual(dev.reads, [
      { address: 0x4003, count: 3 }, // ignored
      { address: 0x4003, count: 1 }, // the floor of the ladder, answered
      { address: 0x4004, count: 1 },
      { address: 0x4005, count: 1 },
    ]);
  });

  it('says it is not a size limit when even one byte goes unanswered', async () => {
    // Ceiling 0: nothing is ever answered, at any size. That is not a
    // device refusing a request size, and the error has to say so - the
    // message used to be just "Management timeout waiting for
    // Memory_Response", with no address, size or device in it.
    const dev = new FakeSilentAboveCeilingDevice('1.5.11', 0);

    await assert.rejects(
      () => dev.readMemory('1.5.11', 0x0100, 8, 228, undefined, 15),
      (err: Error) => {
        assert.match(err.message, /A_Memory_Read of 8 byte\(s\) at 0x100/);
        assert.match(err.message, /A_Memory_Read of 1 byte\(s\) at 0x100/);
        assert.match(err.message, /on 1\.5\.11/);
        assert.match(err.message, /max APDU 15/);
        assert.match(err.message, /not a request-size limit/);
        return true;
      },
    );
    assert.deepEqual(dev.reads, [
      { address: 0x0100, count: 8 },
      { address: 0x0100, count: 1 },
    ]);
  });
});
