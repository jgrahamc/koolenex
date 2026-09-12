/**
 * Every request inside a management session must be connection-oriented.
 *
 * Real failure, 2026-09-12, verifying a Zennio at 1.3.60
 * (M-0071_A-1222-15-CBCE). koolenex opened a T_Connect session and sent
 * A_DeviceDescriptor_Read as a connectionless T_Data_Individual frame:
 *
 *   11:11:17.514  us -> device   DeviceDescriptor_Read  (DATA_GROUP)
 *   11:11:20.485  us             3s timeout, no response
 *   11:11:20.517  us -> device   Memory_Read            (DATA_CONNECTED)
 *   11:11:20.596  device -> us   Memory_Response        (DATA_CONNECTED)
 *
 * The device answered the connection-oriented frame that followed, in the
 * same session, so it was alive throughout - it simply does not serve
 * T_Data_Individual while in the connected transport state, which it is
 * under no obligation to do.
 *
 * That descriptor read was the only connectionless frame in an otherwise
 * connection-oriented session; restartDevice() has always sent the same
 * service through sendData(). The device below models the Zennio: it
 * replies only to connection-oriented frames.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduConnected,
  apduConnectedFull,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

/** Answers connection-oriented management frames, and ignores the rest. */
class FakeConnectedOnlyDevice extends KnxConnection {
  memory: Buffer;
  /** tpciType of every management frame the device received. */
  seen: Array<{ apci: string | null; tpci: string | null }> = [];
  private readonly deviceAddr: string;

  constructor(deviceAddr: string) {
    super();
    this.connected = true;
    this.localAddr = '1.0.11';
    this.deviceAddr = deviceAddr;
    this.memory = Buffer.alloc(0x5000);
    for (let i = 0; i < this.memory.length; i++) this.memory[i] = i & 0xff;
    this.memoryResponseTimeoutMs = 300;
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
    if (frame.apciName || frame.tpciType === 'DATA_CONNECTED')
      this.seen.push({ apci: frame.apciName, tpci: frame.tpciType });

    // The whole point: anything not connection-oriented is ignored.
    if (frame.tpciType !== 'DATA_CONNECTED') return Promise.resolve();
    const seq = (frame.apdu[0]! >> 2) & 0xf;

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const mask = Buffer.alloc(2);
      mask.writeUInt16BE(0x07b0);
      // DeviceDescriptor_Response is a 4-bit APCI, so the connected form
      // is apduConnected(), not the extended-APCI apduConnectedFull().
      this.reply(apduConnected(seq, 'DeviceDescriptor_Response', mask));
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const addrBuf = Buffer.from([(address >> 8) & 0xff, address & 0xff]);
      const data = this.memory.subarray(address, address + count);
      this.reply(
        apduConnectedFull(
          seq,
          (9 << 6) | (count & 0x3f), // A_Memory_Response
          Buffer.concat([addrBuf, data]),
        ),
      );
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('a device that only answers connection-oriented frames', () => {
  it('resolves the device descriptor and completes the read', async () => {
    const dev = new FakeConnectedOnlyDevice('1.3.60');

    const out = await dev.readMemory('1.3.60', 0x4000, 4, 228, undefined, 15);
    assert.deepEqual([...out], [...dev.memory.subarray(0x4000, 0x4004)]);

    const descriptor = dev.seen.find((f) => f.apci === 'DeviceDescriptor_Read');
    assert.ok(descriptor, 'the session must read the device descriptor');
    assert.equal(
      descriptor.tpci,
      'DATA_CONNECTED',
      'and must do so connection-oriented, like every other request',
    );
  });
});
