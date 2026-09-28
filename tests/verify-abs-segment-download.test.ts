/**
 * AbsoluteSegment (classic memory-mapped) download path of downloadDevice():
 *
 *  - the Device Object (objIdx 0) is never written to;
 *  - property writes and memory writes wait for the device's own response,
 *    and a write that never gets one is reported as unconfirmed instead of
 *    being silently indistinguishable from a confirmed one;
 *  - every memory region written is read back before Restart, and a mismatch
 *    or a persistent silence withholds the Restart.
 *
 * The fake device below is scripted per test: it can stay silent for
 * property writes or memory writes, drop a write without applying it, and
 * answer read-backs correctly, wrongly, flakily or not at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  KnxConnection,
  parseCEMI,
  buildCEMI,
  apduGroup,
  type DownloadStep,
  type DownloadProgress,
  type DownloadResult,
} from '../server/knx-connection.ts';
import { _TPCI as TPCI, APCI_EXT } from '../server/knx-cemi.ts';

const DEVICE = '1.1.2';
/** GA table: count=1, one entry. Planned as two memory writes: the count byte
 *  (incremented by one for the reserved slot) at the segment start, and the
 *  entries three bytes further on. */
const GA_TABLE = Buffer.from([0x01, 0x08, 0x00]);
const REGION_COUNT_ADDR = 0x4000;
const REGION_ENTRIES_ADDR = 0x4003;

interface FakeOptions {
  /** Answer PropertyValue_Write (load-state transitions). Default true. */
  answerPropWrites: boolean;
  /** Answer Memory_Write with Memory_Response. Default true. */
  answerMemWrites: boolean;
  /** Copy a Memory_Write's bytes into the backing store. Default true. */
  applyMemWrites: boolean;
  /** Answer MemoryExtended_Read at all. Default true. */
  answerReads: boolean;
  /** Read addresses that come back with inverted bytes. */
  corruptReadAddrs: Set<number>;
  /** Number of leading MemoryExtended_Read requests to ignore (lost frames). */
  dropFirstReads: number;
}

class AbsFakeDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory = Buffer.alloc(0x10000);
  opts: FakeOptions = {
    answerPropWrites: true,
    answerMemWrites: true,
    applyMemWrites: true,
    answerReads: true,
    corruptReadAddrs: new Set(),
    dropFirstReads: 0,
  };
  private readsSeen = 0;

  constructor() {
    super();
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(buildCEMI(DEVICE, this.localAddr, apdu, false))!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;

    if (fullApci === APCI_EXT.PropertyValue_Write) {
      if (this.opts.answerPropWrites) {
        const word =
          (TPCI.DATA_CONNECTED << 10) | APCI_EXT.PropertyValue_Response;
        this.reply(Buffer.from([(word >> 8) & 0xff, word & 0xff, 0, 0, 0]));
      }
      return Promise.resolve();
    }
    if (frame.apciName === 'Memory_Write') {
      // Classic Memory_Write carries its 6-bit count in the APCI itself.
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      if (this.opts.applyMemWrites) {
        frame.apduData.subarray(2, 2 + count).copy(this.memory, address);
      }
      if (this.opts.answerMemWrites) {
        this.reply(apduGroup('Memory_Response', 0, frame.apduData));
      }
      return Promise.resolve();
    }
    if (frame.apciName === 'MemoryExtended_Read') {
      this.readsSeen++;
      if (!this.opts.answerReads) return Promise.resolve();
      if (this.readsSeen <= this.opts.dropFirstReads) return Promise.resolve();
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const real = this.memory.subarray(address, address + count);
      const data = this.opts.corruptReadAddrs.has(address)
        ? Buffer.from(real.map((b) => b ^ 0xff))
        : real;
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

  /** Object index of every PropertyValue_Write that went out, in order. */
  propWriteObjIdxs(): number[] {
    const out: number[] = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (apci === APCI_EXT.PropertyValue_Write) out.push(f.apduData[0]!);
    }
    return out;
  }

  /** `{ index, address, count }` of every MemoryExtended_Read request. */
  readRequests(): Array<{ index: number; address: number; count: number }> {
    const out: Array<{ index: number; address: number; count: number }> = [];
    this.sent.forEach((c, index) => {
      const f = parseCEMI(c);
      if (f?.apciName !== 'MemoryExtended_Read') return;
      out.push({
        index,
        count: f.apduData[0]!,
        address:
          (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!,
      });
    });
    return out;
  }

  /** Index of the Restart frame, or -1 when none was sent. */
  restartIndex(): number {
    return this.sent.findIndex((c) => parseCEMI(c)?.apciName === 'Restart');
  }
}

function steps(lsmIdx: number): DownloadStep[] {
  return [
    { type: 'Connect', objIdx: 0, propId: 0 },
    { type: 'Unload', objIdx: 0, propId: 0, lsmIdx },
    { type: 'Load', objIdx: 0, propId: 0, lsmIdx },
    {
      type: 'AbsSegment',
      objIdx: 0,
      propId: 0,
      lsmIdx,
      address: REGION_COUNT_ADDR,
      size: 3,
    },
    { type: 'LoadCompleted', objIdx: 0, propId: 0, lsmIdx },
    { type: 'Restart', objIdx: 0, propId: 0 },
    { type: 'Disconnect', objIdx: 0, propId: 0 },
  ];
}

async function run(
  dev: AbsFakeDevice,
  lsmIdx = 1,
): Promise<{ result: DownloadResult; progress: DownloadProgress[] }> {
  const progress: DownloadProgress[] = [];
  const result = await dev.downloadDevice(
    DEVICE,
    steps(lsmIdx),
    GA_TABLE,
    null,
    null,
    (p) => progress.push(p),
    {},
  );
  return { result, progress };
}

// ── Device Object guard ─────────────────────────────────────────────────────

describe('AbsSegment download - Device Object (objIdx 0) write guard', () => {
  it('refuses a step that resolves to objIdx 0 before anything goes on the wire', async () => {
    const dev = new AbsFakeDevice();
    await assert.rejects(
      () => run(dev, 0),
      /Refusing PropertyValue_Write to ObjIdx=0 \(Device Object\) PropId=5 on the AbsSegment write path/,
    );
    assert.deepEqual(
      dev.propWriteObjIdxs(),
      [],
      'no property write of any kind may be sent',
    );
    assert.equal(dev.restartIndex(), -1, 'no Restart may be sent either');
  });

  it('stops at the first objIdx 0 write even after earlier, valid writes went out', async () => {
    const dev = new AbsFakeDevice();
    const mixed: DownloadStep[] = [
      { type: 'Connect', objIdx: 0, propId: 0 },
      { type: 'Unload', objIdx: 0, propId: 0, lsmIdx: 1 },
      { type: 'Load', objIdx: 0, propId: 0, lsmIdx: 0 },
      {
        type: 'AbsSegment',
        objIdx: 0,
        propId: 0,
        lsmIdx: 0,
        address: REGION_COUNT_ADDR,
        size: 3,
      },
      { type: 'Restart', objIdx: 0, propId: 0 },
    ];
    await assert.rejects(
      () =>
        dev.downloadDevice(DEVICE, mixed, GA_TABLE, null, null, undefined, {}),
      /Refusing PropertyValue_Write to ObjIdx=0/,
    );
    // The Unload of object 1 was legitimate and went out; nothing that
    // followed it - in particular no write to object 0 - did.
    assert.deepEqual(dev.propWriteObjIdxs(), [1]);
    assert.equal(dev.restartIndex(), -1);
  });

  it('control: the same steps against a real object index (1) complete normally', async () => {
    const dev = new AbsFakeDevice();
    const { result } = await run(dev, 1);
    assert.equal(result.restartWithheld, false);
    assert.ok(dev.propWriteObjIdxs().length > 0);
    assert.ok(dev.propWriteObjIdxs().every((o) => o === 1));
    assert.notEqual(dev.restartIndex(), -1);
  });
});

// ── Write confirmation / unconfirmed tracking ───────────────────────────────

describe('AbsSegment download - write confirmation tracking', () => {
  it('a device that answers every write reports zero unconfirmed writes', async () => {
    const dev = new AbsFakeDevice();
    const { result, progress } = await run(dev);
    assert.equal(result.unconfirmedWrites, 0);
    assert.deepEqual(result.unconfirmedDetails, []);
    assert.deepEqual(result.verificationIssues, []);
    assert.equal(result.restartWithheld, false);
    assert.ok(progress.some((p) => p.msg === 'Download complete'));
  });

  it('memory writes are confirmed by Memory_Response, and both regions land in the store', async () => {
    const dev = new AbsFakeDevice();
    const { result } = await run(dev);
    assert.equal(result.unconfirmedWrites, 0);
    assert.equal(
      dev.memory[REGION_COUNT_ADDR],
      0x02,
      'count byte + reserved slot',
    );
    assert.deepEqual(
      [...dev.memory.subarray(REGION_ENTRIES_ADDR, REGION_ENTRIES_ADDR + 2)],
      [0x08, 0x00],
    );
  });

  it('property writes the device never answers are each reported as unconfirmed, and the download still completes', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.answerPropWrites = false;
    const { result, progress } = await run(dev);

    // Unload, Load, segment descriptor, LoadCompleted - four PID 5 writes.
    assert.equal(result.unconfirmedWrites, 4);
    assert.deepEqual(result.unconfirmedDetails, [
      'PropertyValue write ObjIdx=1 PropId=5 unconfirmed',
      'PropertyValue write ObjIdx=1 PropId=5 unconfirmed',
      'PropertyValue write ObjIdx=1 PropId=5 unconfirmed',
      'PropertyValue write ObjIdx=1 PropId=5 unconfirmed',
    ]);
    // The memory content itself was written and reads back correctly, so
    // silence on the property writes alone is tolerated, not fatal.
    assert.deepEqual(result.verificationIssues, []);
    assert.equal(result.restartWithheld, false);
    assert.notEqual(dev.restartIndex(), -1);
    assert.ok(
      progress.some(
        (p) =>
          p.msg ===
          'Download complete with 4 unconfirmed write(s) - verify recommended',
      ),
    );
    const done = progress.find((p) => p.done);
    assert.equal(done?.unconfirmedWrites, 4);
  });

  it('memory writes the device never answers are reported per chunk with address and length', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.answerMemWrites = false; // silent, but the write still lands
    const { result } = await run(dev);

    assert.equal(result.unconfirmedWrites, 2);
    assert.deepEqual(result.unconfirmedDetails, [
      'Memory write Addr=0x4000 Len=1 unconfirmed',
      'Memory write Addr=0x4003 Len=2 unconfirmed',
    ]);
    // Content did land, so the read-back still matches and Restart is sent.
    assert.equal(result.restartWithheld, false);
    assert.notEqual(dev.restartIndex(), -1);
  });

  it('a memory response is not accepted from the property-write channel (Memory_Response is what counts)', async () => {
    // Answer Memory_Write with a PropertyValue_Response-shaped frame instead
    // of Memory_Response: the wrong response type must not confirm the write.
    class WrongResponseDevice extends AbsFakeDevice {
      override sendCEMI(cemi: Buffer): Promise<void> {
        const f = parseCEMI(cemi);
        if (f?.apciName === 'Memory_Write') {
          const count = f.apdu[1]! & 0x3f;
          const address = (f.apduData[0]! << 8) | f.apduData[1]!;
          f.apduData.subarray(2, 2 + count).copy(this.memory, address);
          this.sent.push(cemi);
          const word =
            (TPCI.DATA_CONNECTED << 10) | APCI_EXT.PropertyValue_Response;
          const resp = parseCEMI(
            buildCEMI(
              DEVICE,
              this.localAddr,
              Buffer.from([(word >> 8) & 0xff, word & 0xff, 0, 0, 0]),
              false,
            ),
          )!;
          setImmediate(() => this._onCEMI(resp));
          return Promise.resolve();
        }
        return super.sendCEMI(cemi);
      }
    }
    const dev = new WrongResponseDevice();
    const { result } = await run(dev);
    assert.equal(result.unconfirmedWrites, 2);
    assert.ok(
      result.unconfirmedDetails.every((d) =>
        d.startsWith('Memory write Addr=0x'),
      ),
    );
  });
});

// ── Read-back verification before Restart ───────────────────────────────────

describe('AbsSegment download - read-back verification before Restart', () => {
  it('reads back every region that was written, before sending Restart', async () => {
    const dev = new AbsFakeDevice();
    const { result } = await run(dev);
    assert.equal(result.restartWithheld, false);

    const reads = dev.readRequests();
    assert.deepEqual(
      reads.map((r) => [r.address, r.count]),
      [
        [REGION_COUNT_ADDR, 1],
        [REGION_ENTRIES_ADDR, 2],
      ],
      'exactly the two regions written, no more, no fewer',
    );
    const restart = dev.restartIndex();
    assert.notEqual(restart, -1);
    assert.ok(
      reads.every((r) => r.index < restart),
      'every read-back must precede Restart',
    );
  });

  it('a mismatch in one region withholds Restart and names that region only', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.corruptReadAddrs = new Set([REGION_ENTRIES_ADDR]);
    const { result, progress } = await run(dev);

    assert.equal(result.restartWithheld, true);
    assert.equal(result.verificationIssues.length, 1);
    assert.match(
      result.verificationIssues[0]!,
      /Addr=0x4003 Len=2 MISMATCH after the last write/,
    );
    assert.deepEqual(result.restartWithheldReasons, result.verificationIssues);
    assert.equal(dev.restartIndex(), -1, 'Restart must not be sent');
    const done = progress.find((p) => p.done);
    assert.equal(done?.restartWithheld, true);
    assert.equal(
      done?.msg,
      'Download complete - Restart withheld, review required',
    );
    assert.ok(
      progress.some((p) =>
        p.msg.startsWith('RESTART WITHHELD - 1 pre-Restart'),
      ),
    );
  });

  it('a write that was acknowledged but never applied is caught by the read-back', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.applyMemWrites = false; // device says "ok" but stores nothing
    const { result } = await run(dev);

    assert.equal(
      result.unconfirmedWrites,
      0,
      'the writes were all acknowledged',
    );
    assert.equal(result.restartWithheld, true, 'yet the content is wrong');
    assert.equal(result.verificationIssues.length, 2);
    assert.equal(dev.restartIndex(), -1);
  });

  it('unconfirmed writes and a failed read-back are both reported in the same result', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.answerMemWrites = false;
    dev.opts.applyMemWrites = false;
    const { result } = await run(dev);

    assert.equal(result.unconfirmedWrites, 2);
    assert.equal(result.restartWithheld, true);
    assert.equal(result.verificationIssues.length, 2);
    assert.equal(dev.restartIndex(), -1);
  });

  it('a device that never answers the read-back withholds Restart after retrying each region', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.answerReads = false;
    const { result } = await run(dev);

    assert.equal(result.restartWithheld, true);
    assert.equal(result.verificationIssues.length, 2);
    assert.ok(
      result.verificationIssues.every((i) =>
        i.includes('no response after the last write (persisted after retry)'),
      ),
    );
    // Initial attempt plus two retries, for each of the two regions.
    assert.equal(dev.readRequests().length, 6);
    assert.equal(dev.restartIndex(), -1);
  });

  it('one lost read-back frame is retried and does not withhold Restart', async () => {
    const dev = new AbsFakeDevice();
    dev.opts.dropFirstReads = 1;
    const { result } = await run(dev);

    assert.equal(result.restartWithheld, false);
    assert.deepEqual(result.verificationIssues, []);
    // First region needed a second attempt; second region answered first time.
    assert.equal(dev.readRequests().length, 3);
    assert.notEqual(dev.restartIndex(), -1);
  });
});
