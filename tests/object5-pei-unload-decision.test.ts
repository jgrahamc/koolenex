/**
 * Object 5 (PEI Program) Unload decision on a System B Full Download.
 *
 *  - A unit with no prior download on record: Unload(5) is sent
 *    unconditionally, with no live-state read.
 *  - A unit downloaded to before: Object 5's load state is read first, and
 *    only an exact $00 (Unloaded) lets the Unload be skipped.
 *  - Any other answer (a different value, a short reply, silence) has no
 *    known meaning or safe handling, so the download is refused before
 *    anything is written.
 * An application declaring PEI program content (PeiType other than "0") is
 * refused outright.
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
import type { DownloadStep, DownloadExtra } from '../server/knx-connection.ts';

/** Minimal fake device - mask 0x07b0 (System B, so hasPeiProgramObject is
 *  true), one real RelSegment+WriteRelMem pair for objIdx=4 (the minimum
 *  needed for `activeJobs`/`loadCycleJobs` to be non-empty at all - mirrors
 *  obj4-p27-final-verification.test.ts's own `paramObjectSteps` fixture
 *  convention - without it, the whole Object-5 decision block this file
 *  tests never runs). The only thing under test is what happens around
 *  ObjIdx=5/PropId=5. */
class FakePeiDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;
  /** What to reply to a PropertyValue_Read on ObjIdx=5/PropId=5 -
   *  `undefined` means "no response at all" (real timeout case). */
  readonly obj5P5Response: Buffer | undefined;

  constructor(deviceAddr: string, obj5P5Response: Buffer | undefined) {
    super();
    this.deviceAddr = deviceAddr;
    this.obj5P5Response = obj5P5Response;
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
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(0x07b0);
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
      const objIdx = frame.apduData[0];
      const propId = frame.apduData[1];
      if (objIdx === 5 && propId === 5) {
        if (this.obj5P5Response !== undefined) {
          // Real shape: [objIdx, propId, countHi/startHi, startLo, ...value]
          const respData = Buffer.concat([
            Buffer.from([5, 5, 0x10, 0x01]),
            this.obj5P5Response,
          ]);
          this.reply(
            apduConnectedFull(0, APCI_EXT.PropertyValue_Response, respData),
          );
        }
        // else: deliberately no reply at all (real "no response" case)
        return Promise.resolve();
      }
      if (propId === 7) {
        // PID_TABLE_REFERENCE - a plausible base address per objIdx, real
        // shape mirrored from obj4-p27-final-verification.test.ts.
        const base =
          objIdx === 1
            ? 0xf000
            : objIdx === 2
              ? 0x13000
              : objIdx === 3
                ? 0x15000
                : 0x16000;
        const value = Buffer.alloc(4);
        value.writeUInt32BE(base, 0);
        const meta = Buffer.from([objIdx ?? 0, propId, 0x11, 0x01]);
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([meta, value]),
          ),
        );
        return Promise.resolve();
      }
      // Any other read (e.g. ObjIdx=2/P=23 pre-check, ObjIdx=4/P=5) -
      // generic ack, content not load-bearing for this test.
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
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
    // Restart etc - no response needed.
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every real PropertyValue_Write to ObjIdx=5/PropId=5 carrying the Unload
   *  event byte (0x04), decoded straight from the wire APDU. */
  obj5UnloadWrites(): number {
    let count = 0;
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const fullApci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (fullApci !== APCI_EXT.PropertyValue_Write) continue;
      if (f.apduData[0] === 5 && f.apduData[1] === 5 && f.apduData[4] === 0x04)
        count++;
    }
    return count;
  }

  obj5P5ReadCount(): number {
    let count = 0;
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const fullApci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (
        fullApci === APCI_EXT.PropertyValue_Read &&
        f.apduData[0] === 5 &&
        f.apduData[1] === 5
      )
        count++;
    }
    return count;
  }
}

const paramMem = Buffer.from('0102030405060708090a', 'hex');
/** The minimum real declared shape (RelSegment + WriteRelMem for objIdx=4)
 *  needed for `activeJobs` to be non-empty - see FakePeiDevice's own doc
 *  comment for why this is required at all. */
const MIN_STEPS: DownloadStep[] = [
  {
    type: 'RelSegment',
    objIdx: 4,
    propId: 0,
    lsmIdx: 4,
    size: paramMem.length,
    mode: 'Rel',
    fill: 0,
  },
  {
    type: 'WriteRelMem',
    objIdx: 4,
    propId: 0,
    size: paramMem.length,
    offset: 0,
  },
];

describe('downloadDevice() - Object 5 (PEI Program) Unload decision', () => {
  it('no prior download history -> Unload(5) sent unconditionally, no live-state read', async () => {
    const dev = new FakePeiDevice('1.1.70', undefined);
    const extra: DownloadExtra = { mode: 'full', cachedMaxApduLength: 228 }; // hasPriorDownloadHistory absent
    await dev.downloadDevice(
      '1.1.70',
      MIN_STEPS,
      null,
      null,
      paramMem,
      undefined,
      extra,
    );

    assert.equal(
      dev.obj5P5ReadCount(),
      0,
      'should never read the load state when there is no prior history',
    );
    assert.equal(
      dev.obj5UnloadWrites(),
      1,
      'should send exactly one unconditional Unload(5)',
    );
  });

  it('prior history + live read comes back exactly $00 -> Unload(5) is skipped', async () => {
    const dev = new FakePeiDevice('1.1.71', Buffer.from([0x00]));
    const extra: DownloadExtra = {
      mode: 'full',
      cachedMaxApduLength: 228,
      hasPriorDownloadHistory: true,
    };
    await dev.downloadDevice(
      '1.1.71',
      MIN_STEPS,
      null,
      null,
      paramMem,
      undefined,
      extra,
    );

    assert.equal(
      dev.obj5P5ReadCount(),
      1,
      'should read the load state exactly once when history exists',
    );
    assert.equal(
      dev.obj5UnloadWrites(),
      0,
      'a $00 (Unloaded) response should skip the Unload write entirely',
    );
  });

  it('prior history + live read comes back non-zero -> refuses the download, no Unload(5) sent', async () => {
    const dev = new FakePeiDevice('1.1.72', Buffer.from([0x01])); // e.g. Loaded - no known meaning
    const extra: DownloadExtra = {
      mode: 'full',
      cachedMaxApduLength: 228,
      hasPriorDownloadHistory: true,
    };

    await assert.rejects(
      () =>
        dev.downloadDevice(
          '1.1.72',
          MIN_STEPS,
          null,
          null,
          paramMem,
          undefined,
          extra,
        ),
      /Refusing to download.*ObjIdx=5.*load-state/s,
    );
    assert.equal(
      dev.obj5UnloadWrites(),
      0,
      'must not send Unload(5) once refused',
    );
  });

  it('prior history + no response at all to the live read -> refuses the download', async () => {
    const dev = new FakePeiDevice('1.1.73', undefined); // no reply -> propRead() times out/returns null
    const extra: DownloadExtra = {
      mode: 'full',
      cachedMaxApduLength: 228,
      hasPriorDownloadHistory: true,
    };

    await assert.rejects(
      () =>
        dev.downloadDevice(
          '1.1.73',
          MIN_STEPS,
          null,
          null,
          paramMem,
          undefined,
          extra,
        ),
      /Refusing to download.*ObjIdx=5.*load-state/s,
    );
    assert.equal(dev.obj5UnloadWrites(), 0);
  });

  it('an application declaring PEI program content (PeiType != "0") is refused before anything is written', async () => {
    const dev = new FakePeiDevice('1.1.73', undefined);
    const extra: DownloadExtra = {
      mode: 'full',
      cachedMaxApduLength: 228,
      peiType: '1',
    };
    await assert.rejects(
      () =>
        dev.downloadDevice(
          '1.1.73',
          MIN_STEPS,
          null,
          null,
          paramMem,
          undefined,
          extra,
        ),
      /PeiType=1/,
    );
    assert.equal(dev.obj5UnloadWrites(), 0);
    for (const c of dev.sent) {
      const f = parseCEMI(c);
      const apci =
        f && f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      assert.notEqual(
        apci,
        APCI_EXT.PropertyValue_Write,
        'nothing may be written',
      );
    }
  });

  it('PeiType "0" (or absent) proceeds normally', async () => {
    const dev = new FakePeiDevice('1.1.74', undefined);
    const extra: DownloadExtra = {
      mode: 'full',
      cachedMaxApduLength: 228,
      peiType: '0',
    };
    await dev.downloadDevice(
      '1.1.74',
      MIN_STEPS,
      null,
      null,
      paramMem,
      undefined,
      extra,
    );
    assert.equal(dev.obj5UnloadWrites(), 1);
  });

  // The decision above is not scoped to Full mode - a device's own history
  // determines it regardless of which mode this download is. Same two
  // outcomes as the Full-mode tests above, run with mode: 'partial'.
  it('mode: partial, no prior download history -> Unload(5) sent unconditionally, no live-state read', async () => {
    const dev = new FakePeiDevice('1.1.75', undefined);
    const extra: DownloadExtra = {
      mode: 'partial',
      cachedMaxApduLength: 228,
      pendingWriteRanges: { 4: [{ offset: 0, length: paramMem.length }] },
    };
    await dev.downloadDevice(
      '1.1.75',
      MIN_STEPS,
      null,
      null,
      paramMem,
      undefined,
      extra,
    );

    assert.equal(
      dev.obj5P5ReadCount(),
      0,
      'should never read the load state when there is no prior history',
    );
    assert.equal(
      dev.obj5UnloadWrites(),
      1,
      'should send exactly one unconditional Unload(5)',
    );
  });

  it('mode: partial, prior history + live read comes back exactly $00 -> Unload(5) is skipped', async () => {
    const dev = new FakePeiDevice('1.1.76', Buffer.from([0x00]));
    const extra: DownloadExtra = {
      mode: 'partial',
      cachedMaxApduLength: 228,
      hasPriorDownloadHistory: true,
      pendingWriteRanges: { 4: [{ offset: 0, length: paramMem.length }] },
    };
    await dev.downloadDevice(
      '1.1.76',
      MIN_STEPS,
      null,
      null,
      paramMem,
      undefined,
      extra,
    );

    assert.equal(
      dev.obj5P5ReadCount(),
      1,
      'should read the load state exactly once when history exists',
    );
    assert.equal(
      dev.obj5UnloadWrites(),
      0,
      'a $00 (Unloaded) response should skip the Unload write entirely',
    );
  });
});
