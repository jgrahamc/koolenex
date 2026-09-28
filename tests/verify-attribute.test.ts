/**
 * `Verify` on LdCtrlWriteProp / LdCtrlWriteRelMem.
 *
 * A step whose XML declares Verify="false" never gets an application-layer
 * confirmation from the device, and ETS does not wait for one either: it moves
 * on within ~200ms. downloadDevice() used to wait out the full 3s timeout on
 * every such step and log it as unconfirmed. Now an explicit Verify="false"
 * sends and paces instead. Verify="true", or no Verify at all, keeps the
 * wait: only an explicit false changes anything.
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
import { KnxConnection, scaledMs } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

/** Answers DeviceDescriptor_Read, Authorize, PID_MAX_APDULENGTH and the table
 *  base address, but NEVER a property write or a memory write. */
class FakeSilentWriteDevice extends KnxConnection {
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
      const payload =
        objIdx === 0 && propId === 56
          ? Buffer.from([0x00, 0xe4])
          : propId === 7
            ? Buffer.from([0x00, 0x00, 0xa0, 0x00])
            : null;
      if (payload) {
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([Buffer.from([objIdx, propId, 0x11, 0x01]), payload]),
          ),
        );
      }
    } else if (
      apci === APCI_EXT.PropertyValue_Write &&
      frame.apduData[1] === 5
    ) {
      // Load-state (property 5) writes are confirmed, as on a real device;
      // the writes under test are not.
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
    }
    // Every other property write and every memory write: silence.
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

const run = (
  dev: FakeSilentWriteDevice,
  steps: DownloadStep[],
  paramMem: Buffer | null = null,
) =>
  dev.downloadDevice('1.1.60', steps, null, null, paramMem, undefined, {
    mode: 'full',
    cachedMaxApduLength: 228,
  });

describe('LdCtrlWriteProp Verify', () => {
  it('does not wait for a confirmation when the step declares Verify="false"', async () => {
    const dev = new FakeSilentWriteDevice('1.1.60');
    const started = Date.now();
    const result = await run(dev, [
      {
        type: 'WriteProp',
        objIdx: 4,
        propId: 27,
        data: Buffer.from('000028c000330000', 'hex'),
        verifyResponse: false,
      },
    ]);
    // The old behaviour waited out the 3000ms timeout.
    assert.ok(Date.now() - started < scaledMs(2000));
    assert.ok(
      result.unconfirmedDetails.every((d) => !d.includes('PropId=27')),
      'a write that was never expected to confirm must not be reported as unconfirmed',
    );
  });

  it('still waits, and reports the write as unconfirmed, for Verify="true"', async () => {
    const dev = new FakeSilentWriteDevice('1.1.60');
    const started = Date.now();
    const result = await run(dev, [
      {
        type: 'WriteProp',
        objIdx: 4,
        propId: 13,
        data: Buffer.from('0000000000', 'hex'),
        verifyResponse: true,
      },
    ]);
    assert.ok(Date.now() - started >= scaledMs(2900));
    assert.ok(result.unconfirmedDetails.some((d) => d.includes('PropId=13')));
  });

  it('keeps waiting when Verify is not declared at all (only an explicit false skips the wait)', async () => {
    const dev = new FakeSilentWriteDevice('1.1.60');
    const started = Date.now();
    const result = await run(dev, [
      {
        type: 'WriteProp',
        objIdx: 4,
        propId: 13,
        data: Buffer.from('0000000000', 'hex'),
      },
    ]);
    assert.ok(Date.now() - started >= scaledMs(2900));
    assert.ok(result.unconfirmedDetails.some((d) => d.includes('PropId=13')));
  });
});

describe('LdCtrlWriteRelMem Verify', () => {
  const PARAM = Buffer.alloc(300, 0x11);
  const steps = (verifyResponse?: boolean): DownloadStep[] => [
    {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: PARAM.length,
      fill: 0,
    },
    {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: PARAM.length,
      offset: 0,
      ...(verifyResponse !== undefined ? { verifyResponse } : {}),
    },
  ];
  const chunkWrites = (r: { unconfirmedDetails: string[] }) =>
    r.unconfirmedDetails.filter((d) => d.startsWith('Memory write'));

  it('Verify="false": chunks are paced, not waited on, and are not reported as unconfirmed', async () => {
    const dev = new FakeSilentWriteDevice('1.1.60');
    const result = await run(dev, steps(false), PARAM);
    assert.equal(chunkWrites(result).length, 0);
  });

  it('no Verify declared: every silent chunk is still reported as unconfirmed', async () => {
    const dev = new FakeSilentWriteDevice('1.1.60');
    const result = await run(dev, steps(), PARAM);
    assert.ok(chunkWrites(result).length >= 1);
  });
});
