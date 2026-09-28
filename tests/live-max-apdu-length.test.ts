/**
 * downloadDevice() always reads the device's PID_MAX_APDULENGTH (object 0,
 * property 56) live, where ETS does (after DeviceDescriptor_Read, before
 * Authorize), and falls back to the project file's cached value only when the
 * live read gets no usable answer. A cached value can be stale after a unit or
 * firmware change, so the live value wins when they disagree.
 *
 * The observable effect is the memory-write chunk size (maxChunkFromApduLength),
 * so each case downloads a payload bigger than any chunk and checks the size of
 * the first MemoryExtended_Write actually sent.
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
import {
  KnxConnection,
  maxChunkFromApduLength,
} from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

class FakeApduDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;
  /** Value answered for OX=0 P=56; null = never answers (read times out). */
  private readonly livePid56: number | null;

  constructor(deviceAddr: string, livePid56: number | null) {
    super();
    this.deviceAddr = deviceAddr;
    this.livePid56 = livePid56;
    this.connected = true;
    this.localAddr = '1.0.1';
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
      this.reply(
        apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
      );
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
      if (
        frame.apduData[0] === 0 &&
        frame.apduData[1] === 56 &&
        this.livePid56 != null
      ) {
        const value = Buffer.alloc(2);
        value.writeUInt16BE(this.livePid56);
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([Buffer.from([0, 56, 0x11, 0x01]), value]),
          ),
        );
      }
      return Promise.resolve();
    }
    if (fullApci === APCI_EXT.PropertyValue_Write) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'MemoryExtended_Write') {
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

  pid56ReadsSent(): number {
    return this.sent
      .map((c) => parseCEMI(c))
      .filter(
        (f) =>
          f &&
          f.apdu.length >= 2 &&
          (((f.apdu[0]! & 0x03) << 8) | f.apdu[1]!) ===
            APCI_EXT.PropertyValue_Read &&
          f.apduData[0] === 0 &&
          f.apduData[1] === 56,
      ).length;
  }

  /** Data-byte count of the first MemoryExtended_Write actually sent. */
  firstWriteChunk(): number | null {
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (f && f.apciName === 'MemoryExtended_Write') return f.apduData[0]!;
    }
    return null;
  }
}

const PAYLOAD = Buffer.alloc(600, 0xaa); // bigger than any chunk under test
const STEPS: DownloadStep[] = [
  {
    type: 'WriteRelMem',
    objIdx: 4,
    propId: 0,
    size: PAYLOAD.length,
    offset: 0,
  },
];

function run(dev: FakeApduDevice, cachedMaxApduLength: number | null) {
  return dev.downloadDevice(
    dev['deviceAddr'],
    STEPS,
    null,
    null,
    PAYLOAD,
    undefined,
    {
      resolvedBases: { 4: 0xa000 },
      cachedMaxApduLength,
      supportsExtendedMemoryServices: true,
      isSecureEnabled: false,
    },
  );
}

describe('downloadDevice() always reads PID_MAX_APDULENGTH live (matches ETS)', () => {
  it('reads it live even when a cached value is present, and chunks by the (matching) value', async () => {
    const dev = new FakeApduDevice('1.1.200', 233);
    await run(dev, 233);
    assert.equal(
      dev.pid56ReadsSent(),
      1,
      'the live P=56 read must be sent even though a cached value exists',
    );
    assert.equal(dev.firstWriteChunk(), maxChunkFromApduLength(233, true)); // 228
  });

  it('the LIVE value wins when it disagrees with the cached one (a stale cache after a device swap)', async () => {
    const dev = new FakeApduDevice('1.1.201', 100);
    await run(dev, 233);
    assert.equal(dev.pid56ReadsSent(), 1);
    assert.equal(dev.firstWriteChunk(), maxChunkFromApduLength(100, true)); // 95, not the cached 228
  });

  it('falls back to the cached value when the live read gets no answer', async () => {
    const dev = new FakeApduDevice('1.1.202', null); // never answers P=56 -> the read times out
    await run(dev, 100);
    assert.equal(dev.pid56ReadsSent(), 1, 'the live read was still attempted');
    assert.equal(dev.firstWriteChunk(), maxChunkFromApduLength(100, true));
  });

  it('with no cached value, still uses the live value (unchanged behaviour)', async () => {
    const dev = new FakeApduDevice('1.1.203', 100);
    await run(dev, null);
    assert.equal(dev.pid56ReadsSent(), 1);
    assert.equal(dev.firstWriteChunk(), maxChunkFromApduLength(100, true));
  });
});
