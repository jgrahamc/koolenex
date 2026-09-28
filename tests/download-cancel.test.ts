/**
 * A Cancel acts inside a single long device write, not only between devices.
 *
 * downloadDevice() polls DownloadExtra.shouldAbort() before each chunk of the
 * memory-write loop. Once it fires the download stops writing, reports
 * `aborted`, and never LoadCompleted-s the interrupted object (so the device
 * keeps its previous content for it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnectedFull,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

class FakeWriteDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;

  constructor(deviceAddr: string) {
    super();
    this.deviceAddr = deviceAddr;
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
    const apci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    if (apci === APCI_EXT.Authorize_Request) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
    } else if (apci === APCI_EXT.PropertyValue_Read) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const respond = (v: Buffer) =>
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([Buffer.from([objIdx, propId, 0x11, 0x01]), v]),
          ),
        );
      if (objIdx === 0 && propId === 56)
        respond(Buffer.from([0x00, 0x3c])); // 60: small chunks
      else if (propId === 7) respond(Buffer.from([0x00, 0x00, 0xa0, 0x00]));
    } else if (apci === APCI_EXT.PropertyValue_Write) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
    } else if (frame.apciName === 'MemoryExtended_Write') {
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.MemoryExtended_Write_Response,
          Buffer.alloc(0),
        ),
      );
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  memoryWrites(): number {
    return this.sent.filter(
      (c) => parseCEMI(c)?.apciName === 'MemoryExtended_Write',
    ).length;
  }

  /** Load-state events written to object 4 (property 5): 0x04 Unload, 0x01
   *  StartLoading, 0x02 LoadCompleted. */
  loadEvents(): number[] {
    const out: number[] = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (
        apci === APCI_EXT.PropertyValue_Write &&
        f.apduData[0] === 4 &&
        f.apduData[1] === 5
      ) {
        out.push(f.apduData[4]!);
      }
    }
    return out;
  }
}

const PARAM = Buffer.alloc(600, 0xab);
const STEPS: DownloadStep[] = [
  {
    type: 'RelSegment',
    objIdx: 4,
    propId: 0,
    lsmIdx: 4,
    size: PARAM.length,
    fill: 0,
  },
  { type: 'WriteRelMem', objIdx: 4, propId: 0, size: PARAM.length, offset: 0 },
];
const extra = (shouldAbort?: () => boolean) => ({
  mode: 'full' as const,
  cachedMaxApduLength: 60,
  shouldAbort,
});

describe('downloadDevice() Cancel inside a single write', () => {
  it('runs to completion when shouldAbort never fires', async () => {
    const dev = new FakeWriteDevice('1.1.50');
    const result = await dev.downloadDevice(
      '1.1.50',
      STEPS,
      null,
      null,
      PARAM,
      undefined,
      extra(() => false),
    );
    assert.equal(result.aborted, false);
    assert.ok(
      dev.memoryWrites() > 4,
      'the parameter object needs several chunks',
    );
    assert.ok(dev.loadEvents().includes(0x02), 'the object is LoadCompleted');
  });

  it('stops writing once shouldAbort fires, reports aborted, and never LoadCompleted-s the interrupted object', async () => {
    const dev = new FakeWriteDevice('1.1.51');
    const full = new FakeWriteDevice('1.1.52');
    await full.downloadDevice(
      '1.1.52',
      STEPS,
      null,
      null,
      PARAM,
      undefined,
      extra(),
    );
    const total = full.memoryWrites();

    let polls = 0;
    const result = await dev.downloadDevice(
      '1.1.51',
      STEPS,
      null,
      null,
      PARAM,
      undefined,
      extra(() => ++polls > 2), // let two chunks through, then cancel
    );
    assert.equal(result.aborted, true);
    assert.equal(
      dev.memoryWrites(),
      2,
      `only the chunks before the cancel are sent (a full write is ${total})`,
    );
    assert.ok(total > 2);
    assert.ok(
      !dev.loadEvents().includes(0x02),
      'the interrupted object must not be LoadCompleted',
    );
  });
});
