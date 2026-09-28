/**
 * PID_MCB_TABLE (property 27) final verification, and LdCtrlWriteProp
 * StartElement / LdCtrlLoadImageProp Count handling.
 *
 * Shapes of the parameter object's (objIdx 4) property 27:
 *  - an app that declares no LdCtrlWriteProp for it has ONE element whose
 *    checksum covers the whole parameter buffer;
 *  - an app that declares it twice (the second with StartElement="2") has
 *    TWO elements: element 1 covers the first N bytes, element 2 the last M,
 *    with N and M taken from bytes 2-3 of each declared write's InlineData.
 * Objects 1/2/3 (GA table, Association table, Group Object Table) have one
 * element whose size AND checksum must both match.
 * A mismatch, a short answer or silence withholds Restart.
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
import { KnxConnection, crc16Knx } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

/** Answers DeviceDescriptor_Read, Authorize, PID_MAX_APDULENGTH, the table
 *  base addresses, property writes and memory writes. Property 27 answers
 *  come from a caller-supplied per-object map, so a test can set up a
 *  matching or deliberately wrong final read. */
class FakeDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;
  private readonly p27: Map<number, Buffer>;

  constructor(deviceAddr: string, p27: Map<number, Buffer>) {
    super();
    this.deviceAddr = deviceAddr;
    this.p27 = p27;
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
      const mask = Buffer.alloc(2);
      mask.writeUInt16BE(0x07b0);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, mask));
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
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      const respond = (payload: Buffer): void =>
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([Buffer.from([objIdx, propId, 0x11, 0x01]), payload]),
          ),
        );
      if (objIdx === 0 && propId === 56) {
        respond(Buffer.from([0x00, 0xe4]));
      } else if (propId === 7) {
        const base = objIdx === 1 ? 0xf000 : objIdx === 2 ? 0x13000 : 0x16000;
        const value = Buffer.alloc(4);
        value.writeUInt32BE(base, 0);
        respond(value);
      } else if (propId === 27) {
        const canned = this.p27.get(objIdx);
        if (canned) respond(canned);
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
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Element count requested by the LAST property-27 read for `objIdx`. */
  lastP27ReadCount(objIdx: number): number | undefined {
    let count: number | undefined;
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (
        apci === APCI_EXT.PropertyValue_Read &&
        f.apduData[0] === objIdx &&
        f.apduData[1] === 27
      ) {
        count = f.apduData[2]! >> 4;
      }
    }
    return count;
  }

  /** Every property-27 write to objIdx 4 as `{ startIndex, data }`, decoded
   *  from the wire. */
  p27Writes(): Array<{ startIndex: number; data: Buffer }> {
    const out: Array<{ startIndex: number; data: Buffer }> = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (apci !== APCI_EXT.PropertyValue_Write) continue;
      if (f.apduData[0] !== 4 || f.apduData[1] !== 27) continue;
      out.push({
        startIndex: ((f.apduData[2]! & 0x0f) << 8) | f.apduData[3]!,
        data: Buffer.from(f.apduData.subarray(4)),
      });
    }
    return out;
  }
}

/** [00,00,SizeHi,SizeLo,00,byte5,CrcHi,CrcLo] - the 8-byte PID_MCB_TABLE
 *  element shape. */
function mcbElement(size: number, crc: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(size, 2);
  b[5] = 0x33;
  b.writeUInt16BE(crc, 6);
  return b;
}

/** The parameter object's own load cycle: without a RelSegment + WriteRelMem
 *  pair no job exists for objIdx 4 and the final check never runs. */
function paramSteps(paramMem: Buffer, count?: number): DownloadStep[] {
  return [
    {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: paramMem.length,
      fill: 0,
    },
    {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: paramMem.length,
      offset: 0,
    },
    {
      type: 'LoadImageProp',
      objIdx: 4,
      propId: 27,
      ...(count != null ? { count } : {}),
    },
  ];
}

function paramMemory(): Buffer {
  const b = Buffer.alloc(20);
  for (let i = 0; i < b.length; i++) b[i] = i + 1;
  return b;
}

async function run(
  dev: FakeDevice,
  steps: DownloadStep[],
  paramMem: Buffer,
  gaTable: Buffer | null = null,
) {
  return dev.downloadDevice(
    '1.1.90',
    steps,
    gaTable,
    null,
    paramMem,
    undefined,
    {
      mode: 'full',
      cachedMaxApduLength: 228,
    },
  );
}

describe('downloadDevice() - LdCtrlWriteProp StartElement', () => {
  it('sends the declared StartElement as the wire start index, not always 1', async () => {
    const paramMem = paramMemory();
    const dev = new FakeDevice('1.1.90', new Map());
    const first = mcbElement(10, 0);
    const second = mcbElement(4, 0);
    await run(
      dev,
      [
        { type: 'WriteProp', objIdx: 4, propId: 27, data: first },
        {
          type: 'WriteProp',
          objIdx: 4,
          propId: 27,
          data: second,
          startElement: 2,
        },
      ],
      paramMem,
    );
    const writes = dev.p27Writes();
    assert.equal(writes.length, 2);
    assert.equal(writes[0]!.startIndex, 1, 'no StartElement -> index 1');
    assert.equal(writes[1]!.startIndex, 2, 'StartElement="2" -> index 2');
    assert.deepEqual(writes[0]!.data, first);
    assert.deepEqual(writes[1]!.data, second);
  });
});

describe('downloadDevice() - parameter object (objIdx 4) PID_MCB_TABLE final verification', () => {
  it('single element (no declared write): matches when the whole-buffer checksum is right', async () => {
    const paramMem = paramMemory();
    const dev = new FakeDevice(
      '1.1.90',
      new Map([[4, mcbElement(paramMem.length, crc16Knx(paramMem))]]),
    );
    const result = await run(dev, paramSteps(paramMem), paramMem);
    assert.deepEqual(result.verificationIssues, []);
    assert.equal(result.restartWithheld, false);
  });

  it('single element: a wrong whole-buffer checksum is flagged and withholds Restart', async () => {
    const paramMem = paramMemory();
    const dev = new FakeDevice(
      '1.1.90',
      new Map([[4, mcbElement(paramMem.length, 0xbeef)]]),
    );
    const result = await run(dev, paramSteps(paramMem), paramMem);
    assert.equal(result.verificationIssues.length, 1);
    assert.match(result.verificationIssues[0]!, /ObjIdx=4.*MISMATCH/);
    assert.equal(result.restartWithheld, true);
  });

  it('two elements (second declared with StartElement="2"): both checksums match', async () => {
    const paramMem = paramMemory();
    const N = 10;
    const M = 4;
    const response = Buffer.concat([
      mcbElement(N, crc16Knx(paramMem.subarray(0, N))),
      mcbElement(M, crc16Knx(paramMem.subarray(paramMem.length - M))),
    ]);
    const dev = new FakeDevice('1.1.90', new Map([[4, response]]));
    const result = await run(
      dev,
      [
        ...paramSteps(paramMem),
        { type: 'WriteProp', objIdx: 4, propId: 27, data: mcbElement(N, 0) },
        {
          type: 'WriteProp',
          objIdx: 4,
          propId: 27,
          data: mcbElement(M, 0),
          startElement: 2,
        },
      ],
      paramMem,
    );
    assert.deepEqual(result.verificationIssues, []);
    assert.equal(result.restartWithheld, false);
    assert.equal(dev.lastP27ReadCount(4), 2);
  });

  it('two elements: a wrong first element is reported per element and withholds Restart', async () => {
    const paramMem = paramMemory();
    const N = 10;
    const M = 4;
    const response = Buffer.concat([
      mcbElement(N, 0xbeef),
      mcbElement(M, crc16Knx(paramMem.subarray(paramMem.length - M))),
    ]);
    const dev = new FakeDevice('1.1.90', new Map([[4, response]]));
    const result = await run(
      dev,
      [
        ...paramSteps(paramMem),
        { type: 'WriteProp', objIdx: 4, propId: 27, data: mcbElement(N, 0) },
        {
          type: 'WriteProp',
          objIdx: 4,
          propId: 27,
          data: mcbElement(M, 0),
          startElement: 2,
        },
      ],
      paramMem,
    );
    assert.equal(result.verificationIssues.length, 1);
    assert.match(result.verificationIssues[0]!, /element1:.*MISMATCH/);
    assert.match(result.verificationIssues[0]!, /element2:.*\[ok\]/);
    assert.equal(result.restartWithheld, true);
  });

  it('a declared LoadImageProp Count higher than the number of writes is read in full', async () => {
    const paramMem = paramMemory();
    const N = 10;
    const M = 4;
    const response = Buffer.concat([
      mcbElement(N, crc16Knx(paramMem.subarray(0, N))),
      mcbElement(M, crc16Knx(paramMem.subarray(paramMem.length - M))),
      mcbElement(0, 0),
    ]);
    const dev = new FakeDevice('1.1.90', new Map([[4, response]]));
    const result = await run(
      dev,
      [
        ...paramSteps(paramMem, 3),
        { type: 'WriteProp', objIdx: 4, propId: 27, data: mcbElement(N, 0) },
        {
          type: 'WriteProp',
          objIdx: 4,
          propId: 27,
          data: mcbElement(M, 0),
          startElement: 2,
        },
      ],
      paramMem,
    );
    // The two elements with byte-range evidence verify; the third is read
    // but not compared.
    assert.deepEqual(result.verificationIssues, []);
    assert.equal(dev.lastP27ReadCount(4), 3);
  });

  it('a short answer is flagged, not trusted', async () => {
    const paramMem = paramMemory();
    const dev = new FakeDevice(
      '1.1.90',
      new Map([[4, Buffer.from([0x00, 0x00])]]),
    );
    const result = await run(dev, paramSteps(paramMem), paramMem);
    assert.equal(result.verificationIssues.length, 1);
    assert.match(result.verificationIssues[0]!, /short response/);
    assert.equal(result.restartWithheld, true);
  });
});

describe('downloadDevice() - GA table (objIdx 1) PID_MCB_TABLE final verification checks the size too', () => {
  const gaTable = Buffer.from('00020A010A02', 'hex');
  const paramMem = paramMemory();
  const paramOk = mcbElement(paramMem.length, crc16Knx(paramMem));

  it('right size and checksum: no issue', async () => {
    const dev = new FakeDevice(
      '1.1.90',
      new Map([
        [1, mcbElement(gaTable.length, crc16Knx(gaTable))],
        [4, paramOk],
      ]),
    );
    const result = await run(dev, paramSteps(paramMem), paramMem, gaTable);
    assert.deepEqual(result.verificationIssues, []);
  });

  it('right checksum but a different size: flagged and Restart withheld', async () => {
    const dev = new FakeDevice(
      '1.1.90',
      new Map([
        [1, mcbElement(gaTable.length + 2, crc16Knx(gaTable))],
        [4, paramOk],
      ]),
    );
    const result = await run(dev, paramSteps(paramMem), paramMem, gaTable);
    assert.equal(result.verificationIssues.length, 1);
    assert.match(result.verificationIssues[0]!, /ObjIdx=1.*MISMATCH.*size/);
    assert.equal(result.restartWithheld, true);
  });
});
