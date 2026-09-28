/**
 * downloadDevice() over all four RelSegment interface objects (1 = address
 * table, 2 = association table, 3 = group object table, 4 = parameter
 * memory) against a System B (mask 0x07B0) device, plus Object 5 (PEI
 * Program), which only ever gets an Unload.
 *
 * The order of the Unload / StartLoading / memory-write / LoadCompleted
 * phases is decided in one of two ways:
 *  - with no mask master data available, by the built-in ordering
 *    (Unload descending 4,3,2,1; StartLoading 4,3,1,2; writes descending);
 *  - with a project's KNX master data available, by the mask's own declared
 *    Load procedure, with the application's own steps spliced in at their
 *    merge points.
 * The synthetic mask below declares an order that differs from the built-in
 * one at every phase, so an engine that ignored the mask - or ignored the
 * built-in fallback - would produce a different sequence.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnectedFull,
  apduExtUnnumbered,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection, crc16Knx } from '../server/knx-connection.ts';
import type {
  DownloadStep,
  DownloadExtra,
  DownloadProgress,
  DownloadResult,
} from '../server/knx-connection.ts';
import { saveMasterXml, DATA_DIR } from '../server/routes/shared.ts';
import { clearMaskProcedureCache } from '../server/knx-mask-procedures.ts';

const DEVICE = '1.1.9';
/** PID_TABLE_REFERENCE per object - all distinct, all beyond 16 bits except
 *  the first, so an object can be told apart by where it was written. */
const BASES: Record<number, number> = {
  1: 0xf000,
  2: 0x13000,
  3: 0x15000,
  4: 0x16000,
};

const TABLES: Record<number, Buffer> = {
  1: Buffer.from('000249014905', 'hex'), // 6 bytes
  2: Buffer.from('0001000100020002', 'hex'), // 8 bytes
  3: Buffer.from('0004a0b0c0d0e0f0', 'hex'), // 8 bytes
  4: Buffer.from('0102030405060708090a0b0c', 'hex'), // 12 bytes
};

function buildMcb(size: number, crc: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(size, 2);
  b[5] = 0x33;
  b.writeUInt16BE(crc, 6);
  return b;
}

class SystemBDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory = Buffer.alloc(0x20000);
  /** Object whose memory writes are acknowledged but never stored. */
  dropWritesForObj: number | null = null;

  constructor() {
    super();
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(buildCEMI(DEVICE, this.localAddr, apdu, false))!;
    setImmediate(() => this._onCEMI(resp));
  }

  private objectAt(address: number): number | null {
    for (const [obj, base] of Object.entries(BASES)) {
      if (address >= base && address < base + TABLES[Number(obj)]!.length)
        return Number(obj);
    }
    return null;
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
    if (frame.apciIdx === APCI_EXT.Restart_Extended) {
      this.reply(
        apduExtUnnumbered(
          APCI_EXT.Restart_Extended_Response,
          Buffer.from([0x00, 0x00, 0x00]),
        ),
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
        const value = Buffer.alloc(4);
        value.writeUInt32BE(BASES[objIdx] ?? 0, 0);
        respond(value);
      } else if (propId === 27 && TABLES[objIdx]) {
        // Checksum computed live from what is actually in memory.
        const len = TABLES[objIdx]!.length;
        const base = BASES[objIdx]!;
        respond(
          buildMcb(len, crc16Knx(this.memory.subarray(base, base + len))),
        );
      } else {
        respond(Buffer.from([0x00]));
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
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      if (this.objectAt(address) !== this.dropWritesForObj) {
        frame.apduData.subarray(4, 4 + count).copy(this.memory, address);
      }
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

  /** The wire sequence reduced to its load-cycle events, in send order:
   *  `Unload:4`, `StartLoading:4`, `LoadData:4`, `Write:4`, `LoadCompleted:4`,
   *  `ProgramVersion`, `MCB:1` (a P=27 read), `Restart`. Consecutive memory
   *  chunks of one object collapse to a single `Write:<obj>` entry. */
  timeline(): string[] {
    const out: string[] = [];
    const push = (s: string): void => {
      if (out[out.length - 1] !== s) out.push(s);
    };
    const names: Record<number, string> = {
      4: 'Unload',
      1: 'StartLoading',
      3: 'LoadData',
      2: 'LoadCompleted',
    };
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (apci === APCI_EXT.PropertyValue_Write) {
        const obj = f.apduData[0]!;
        const prop = f.apduData[1]!;
        if (prop === 5) out.push(`${names[f.apduData[4]!]}:${obj}`);
        else if (obj === 4 && prop === 13) out.push('ProgramVersion');
      } else if (f.apciName === 'MemoryExtended_Write') {
        const address =
          (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!;
        push(`Write:${this.objectAt(address)}`);
      } else if (apci === APCI_EXT.PropertyValue_Read && f.apduData[1] === 27) {
        out.push(`MCB:${f.apduData[0]}`);
      } else if (f.apciIdx === APCI_EXT.Restart_Extended) {
        out.push('Restart');
      }
    }
    return out;
  }

  /** LoadData size field (bytes 8-9 of the property payload) per object. */
  loadDataSizes(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const apci =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (
        apci === APCI_EXT.PropertyValue_Write &&
        f.apduData[1] === 5 &&
        f.apduData[4] === 0x03
      )
        out[f.apduData[0]!] = f.apduData.readUInt16BE(8);
    }
    return out;
  }

  sentRestart(): boolean {
    return this.sent.some(
      (c) => parseCEMI(c)?.apciIdx === APCI_EXT.Restart_Extended,
    );
  }
}

function paramSteps(mergeId?: number): DownloadStep[] {
  return [
    {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: TABLES[4]!.length,
      fill: 0,
    },
    {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: TABLES[4]!.length,
      offset: 0,
      ...(mergeId != null ? { mergeId } : {}),
    },
  ];
}

const BASE_EXTRA: DownloadExtra = {
  mode: 'full',
  // Skip the live write-service probe: this file is about ordering.
  supportsExtendedMemoryServices: true,
  appId: 'M-0004_A-0025-10-1BA6-O00A6',
};

async function run(
  dev: SystemBDevice,
  steps: DownloadStep[],
  extra: DownloadExtra = BASE_EXTRA,
): Promise<{ result: DownloadResult; progress: DownloadProgress[] }> {
  const progress: DownloadProgress[] = [];
  const result = await dev.downloadDevice(
    DEVICE,
    steps,
    TABLES[1]!,
    TABLES[2]!,
    TABLES[4]!,
    (p) => progress.push(p),
    { ...extra, groupObjectTable: TABLES[3]! },
  );
  return { result, progress };
}

// ── Built-in ordering, no mask data ─────────────────────────────────────────

describe('downloadDevice() - four objects, System B, built-in ordering', () => {
  it('sends the full sequence: Object 5 Unload, then 4,3,2,1 Unload, 4,3,1,2 loads, 4,3,2,1 writes and completions, then Restart', async () => {
    const dev = new SystemBDevice();
    const { result } = await run(dev, paramSteps());

    assert.equal(result.restartWithheld, false);
    assert.equal(result.unconfirmedWrites, 0);
    assert.deepEqual(dev.timeline(), [
      'Unload:5', // PEI Program: unload only, first of everything
      'Unload:4',
      'Unload:3',
      'Unload:2',
      'Unload:1',
      'StartLoading:4',
      'LoadData:4',
      'StartLoading:3',
      'LoadData:3',
      'StartLoading:1',
      'LoadData:1',
      'StartLoading:2',
      'LoadData:2',
      'Write:4',
      'Write:3',
      'Write:2',
      'Write:1',
      'ProgramVersion',
      'LoadCompleted:4',
      'LoadCompleted:3',
      'LoadCompleted:2',
      'LoadCompleted:1',
      'Restart',
    ]);
  });

  it('never loads or completes Object 5 - only unloads it', async () => {
    const dev = new SystemBDevice();
    await run(dev, paramSteps());
    const obj5 = dev.timeline().filter((e) => e.endsWith(':5'));
    assert.deepEqual(obj5, ['Unload:5']);
  });

  it("tells the device each object's real size in LoadData and stores each table at that object's own base", async () => {
    const dev = new SystemBDevice();
    await run(dev, paramSteps());

    assert.deepEqual(dev.loadDataSizes(), {
      1: TABLES[1]!.length,
      2: TABLES[2]!.length,
      3: TABLES[3]!.length,
      4: TABLES[4]!.length,
    });
    for (const obj of [1, 2, 3, 4]) {
      assert.deepEqual(
        [
          ...dev.memory.subarray(
            BASES[obj]!,
            BASES[obj]! + TABLES[obj]!.length,
          ),
        ],
        [...TABLES[obj]!],
        `object ${obj} content`,
      );
    }
  });

  it("with P=27 declared, checks every object's checksum after the last LoadCompleted and before Restart", async () => {
    const dev = new SystemBDevice();
    const steps: DownloadStep[] = [
      ...paramSteps(),
      { type: 'LoadImageProp', objIdx: 4, propId: 27 },
    ];
    const { result } = await run(dev, steps);
    assert.equal(result.restartWithheld, false);
    assert.deepEqual(result.verificationIssues, []);

    const tl = dev.timeline();
    const lastCompleted = tl.lastIndexOf('LoadCompleted:1');
    const restart = tl.indexOf('Restart');
    assert.ok(lastCompleted > -1 && restart > lastCompleted);
    const finalReads = tl
      .slice(lastCompleted + 1, restart)
      .filter((e) => e.startsWith('MCB:'))
      .sort();
    assert.deepEqual(finalReads, ['MCB:1', 'MCB:2', 'MCB:3', 'MCB:4']);
    assert.equal(tl.slice(restart + 1).length, 0, 'nothing follows Restart');
  });

  it("withholds Restart when one object's stored content does not match, naming that object", async () => {
    const dev = new SystemBDevice();
    dev.dropWritesForObj = 2; // acknowledged, never stored
    const steps: DownloadStep[] = [
      ...paramSteps(),
      { type: 'LoadImageProp', objIdx: 4, propId: 27 },
    ];
    const { result } = await run(dev, steps);

    assert.equal(result.restartWithheld, true);
    assert.equal(result.verificationIssues.length, 1);
    assert.match(result.verificationIssues[0]!, /ObjIdx=2 P=27 .* MISMATCH/);
    assert.equal(dev.sentRestart(), false);
    // The other objects were still loaded and completed.
    const tl = dev.timeline();
    for (const e of [
      'LoadCompleted:4',
      'LoadCompleted:3',
      'LoadCompleted:2',
      'LoadCompleted:1',
    ])
      assert.ok(tl.includes(e), e);
  });
});

// ── Mask-declared ordering ──────────────────────────────────────────────────

const createdIds: string[] = [];

after(() => {
  for (const id of createdIds) {
    clearMaskProcedureCache(id);
    try {
      fs.unlinkSync(path.join(DATA_DIR, `knx_master_${id}.xml`));
    } catch {
      /* nothing saved for this id */
    }
  }
});

function newProject(tag: string, xml: string): string {
  const id = `test_verify_${tag}_${Date.now()}`;
  saveMasterXml(id, xml);
  createdIds.push(id);
  return id;
}

/** A mask-0x07B0 master-data fragment whose Load:all order differs from the
 *  built-in order at every phase: Unload ascending (1,2,3,4), StartLoading
 *  ascending (1,2,3,4), and memory writes 2, <application step at merge 4>,
 *  1, 3. */
function syntheticMaskXml(maskDecimal: number): string {
  return `<?xml version="1.0"?>
<KNX>
  <MasterData>
    <MaskVersions>
      <MaskVersion Id="MV-TEST" MaskVersion="${maskDecimal}" Name="Synthetic">
        <HawkConfigurationData>
          <Procedures>
            <Procedure ProcedureType="Load" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlUnload LsmIdx="1" />
              <LdCtrlUnload LsmIdx="2" />
              <LdCtrlUnload LsmIdx="3" />
              <LdCtrlUnload LsmIdx="4" />
              <LdCtrlUnload LsmIdx="5" />
              <LdCtrlLoad LsmIdx="1" />
              <LdCtrlLoad LsmIdx="2" />
              <LdCtrlLoad LsmIdx="3" />
              <LdCtrlLoad LsmIdx="4" />
              <LdCtrlWriteRelMem ObjIdx="2" Offset="0" Size="1048576" Verify="true" />
              <LdCtrlMerge MergeId="4" />
              <LdCtrlWriteRelMem ObjIdx="1" Offset="0" Size="1048576" Verify="true" />
              <LdCtrlWriteRelMem ObjIdx="3" Offset="0" Size="1048576" Verify="true" />
              <LdCtrlLoadCompleted LsmIdx="1" />
              <LdCtrlLoadCompleted LsmIdx="2" />
              <LdCtrlLoadCompleted LsmIdx="3" />
              <LdCtrlLoadCompleted LsmIdx="4" />
              <LdCtrlRestart />
            </Procedure>
          </Procedures>
        </HawkConfigurationData>
      </MaskVersion>
    </MaskVersions>
  </MasterData>
</KNX>`;
}

describe('downloadDevice() - four objects, System B, mask-declared ordering', () => {
  it('follows the mask XML order (not the built-in one) for Unload, StartLoading, writes and LoadCompleted', async () => {
    const projectId = newProject('order', syntheticMaskXml(0x07b0));
    const dev = new SystemBDevice();
    const { result, progress } = await run(dev, paramSteps(4), {
      ...BASE_EXTRA,
      projectId,
    });

    assert.ok(
      progress.some((p) =>
        p.msg.includes('Real download sequence resolved from mask 07b0'),
      ),
      'the mask-driven path must actually engage',
    );
    assert.equal(result.restartWithheld, false);
    assert.deepEqual(dev.timeline(), [
      'Unload:5', // Object 5 is handled before the ordered phases either way
      'Unload:1',
      'Unload:2',
      'Unload:3',
      'Unload:4',
      'StartLoading:1',
      'LoadData:1',
      'StartLoading:2',
      'LoadData:2',
      'StartLoading:3',
      'LoadData:3',
      'StartLoading:4',
      'LoadData:4',
      // The application's own write (merge point 4) sits between the mask's
      // write of object 2 and its writes of objects 1 and 3.
      'Write:2',
      'Write:4',
      'Write:1',
      'Write:3',
      'ProgramVersion',
      'LoadCompleted:1',
      'LoadCompleted:2',
      'LoadCompleted:3',
      'LoadCompleted:4',
      'Restart',
    ]);
  });

  it("places the application's write by its merge point: moving the merge point moves the write", async () => {
    // Same mask, but the application's write step declares a merge point the
    // mask never mentions - it must not be placed at the mask's slot for 4.
    const projectId = newProject('orphan', syntheticMaskXml(0x07b0));
    const dev = new SystemBDevice();
    await run(dev, paramSteps(9), { ...BASE_EXTRA, projectId });
    const writes = dev.timeline().filter((e) => e.startsWith('Write:'));
    assert.deepEqual(writes, ['Write:2', 'Write:1', 'Write:3', 'Write:4']);
  });

  it("a mask that is present but declares nothing for this device's mask falls back to the built-in order", async () => {
    const projectId = newProject('othermask', syntheticMaskXml(0x0705));
    const dev = new SystemBDevice();
    const { progress } = await run(dev, paramSteps(), {
      ...BASE_EXTRA,
      projectId,
    });

    assert.ok(
      progress.some((p) =>
        p.msg.includes('No mask Procedure "Load:all" found for mask 07b0'),
      ),
    );
    const tl = dev.timeline();
    assert.deepEqual(
      tl.filter((e) => e.startsWith('Unload:')),
      ['Unload:5', 'Unload:4', 'Unload:3', 'Unload:2', 'Unload:1'],
    );
    assert.deepEqual(
      tl.filter((e) => e.startsWith('Write:')),
      ['Write:4', 'Write:3', 'Write:2', 'Write:1'],
    );
  });

  it('the same download without a project id uses the built-in order - so the mask run above differs because of the mask', async () => {
    const dev = new SystemBDevice();
    const { progress } = await run(dev, paramSteps(4), BASE_EXTRA);
    assert.ok(
      !progress.some((p) =>
        p.msg.includes('Real download sequence resolved from mask'),
      ),
    );
    assert.deepEqual(
      dev.timeline().filter((e) => e.startsWith('Write:')),
      ['Write:4', 'Write:3', 'Write:2', 'Write:1'],
    );
  });
});

// ── Real KNX master data, when a checkout has it ────────────────────────────

describe('downloadDevice() - four objects, real mask 0x07B0 master data', () => {
  const masterXmlPath = 'data/knx_master_1.xml';
  const present = fs.existsSync(masterXmlPath);

  it(
    'engages the real mask procedure and produces the same descending sequence as the built-in order',
    {
      skip: present
        ? false
        : 'real KNX master data is not present in this checkout',
    },
    async () => {
      const projectId = newProject(
        'real',
        fs.readFileSync(masterXmlPath, 'utf8'),
      );
      const dev = new SystemBDevice();
      const { progress } = await run(dev, paramSteps(4), {
        ...BASE_EXTRA,
        projectId,
      });

      assert.ok(
        progress.some((p) =>
          p.msg.includes('Real download sequence resolved from mask 07b0'),
        ),
      );
      const tl = dev.timeline();
      assert.deepEqual(
        tl.filter((e) => e.startsWith('Unload:')),
        ['Unload:5', 'Unload:4', 'Unload:3', 'Unload:2', 'Unload:1'],
      );
      assert.deepEqual(
        tl.filter((e) => e.startsWith('StartLoading:')),
        [
          'StartLoading:4',
          'StartLoading:3',
          'StartLoading:1',
          'StartLoading:2',
        ],
      );
      assert.deepEqual(
        tl.filter((e) => e.startsWith('Write:')),
        ['Write:4', 'Write:3', 'Write:2', 'Write:1'],
      );
      assert.equal(tl[tl.length - 1], 'Restart');
    },
  );
});
