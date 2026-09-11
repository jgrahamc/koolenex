/**
 * A retransmitted response must not be mistaken for the answer to the
 * request in flight.
 *
 * From a real capture, 2026-09-11, verifying 1.1.21 (mask 0x0701) over a
 * TCP tunnel. Every read up to 0x4200 worked. Then:
 *
 *   36.684  device -> us   Memory_Response seq 3  (0x4200, 12 bytes)
 *   36.684  us -> device   T_Ack seq 3            (never arrived)
 *   36.685  us -> device   Memory_Read seq 4      (0x420c, 12 bytes)
 *   36.774  device -> us   T_Ack seq 4            (request received)
 *   ...     silence: a transport connection allows one unacknowledged
 *           numbered frame at a time, so the device could not send its
 *           next response until its previous one was acked
 *   39.687  us             3s timeout, retry ladder drops to 1 byte
 *   39.820  device -> us   Memory_Response seq 3 AGAIN (retransmission)
 *   39.821  us             matched that as the answer, and failed with
 *                          "address mismatch: requested 0x420c, device
 *                          answered 0x4200"
 *   39.960  device -> us   Memory_Response seq 4 (0x420c) - the real one,
 *                          140ms after we gave up and disconnected
 *
 * Two faults, both fixed here: the wait resolved on a frame carrying the
 * wrong address instead of ignoring it and continuing, and the timeout was
 * 3000ms - exactly the peer's own acknowledgement timeout, so koolenex
 * gave up at the precise moment the peer's recovery began.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCEMI, buildCEMI, apduGroup } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

/**
 * Reproduces the capture: for one nominated address the device replays its
 * PREVIOUS response first, after a delay, and only then sends the real one.
 */
class FakeRetransmittingDevice extends KnxConnection {
  memory: Buffer;
  reads: Array<{ address: number; count: number }> = [];
  private readonly deviceAddr: string;
  private readonly stallAt: number;
  private lastResponse: Buffer | null = null;

  constructor(deviceAddr: string, stallAt: number) {
    super();
    this.connected = true;
    this.localAddr = '1.0.11';
    this.deviceAddr = deviceAddr;
    this.stallAt = stallAt;
    this.memory = Buffer.alloc(0x5000);
    for (let i = 0; i < this.memory.length; i++) this.memory[i] = i & 0xff;
    this.memoryResponseTimeoutMs = 600;
  }

  private send(apdu: Buffer, afterMs = 0): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    if (afterMs) setTimeout(() => this._onCEMI(resp), afterMs).unref();
    else setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(0x0701);
      this.send(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      this.reads.push({ address, count });

      const addrBuf = Buffer.from([(address >> 8) & 0xff, address & 0xff]);
      const answer = apduGroup(
        'Memory_Response',
        count,
        Buffer.concat([
          addrBuf,
          this.memory.subarray(address, address + count),
        ]),
      );

      if (address === this.stallAt && this.lastResponse) {
        // The stalled case: the previous response comes back first, then
        // the real one - the order the capture recorded.
        const stale = this.lastResponse;
        this.send(stale, 150);
        this.send(answer, 200);
      } else {
        this.send(answer);
      }
      this.lastResponse = answer;
      return Promise.resolve();
    }

    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('a device that replays its previous response', () => {
  it('ignores the replay and reads the right bytes', async () => {
    const dev = new FakeRetransmittingDevice('1.1.21', 0x420c);

    const out = await dev.readMemory('1.1.21', 0x4200, 24, 12, undefined, 15);

    assert.deepEqual([...out], [...dev.memory.subarray(0x4200, 0x4218)]);
    assert.deepEqual(dev.reads, [
      { address: 0x4200, count: 12 },
      { address: 0x420c, count: 12 },
    ]);
  });
});
