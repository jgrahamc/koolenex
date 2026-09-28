/**
 * Protocol-level tests for the ordering and end-of-session behaviour of a
 * RelSegment-style downloadDevice() against a scripted fake device.
 *
 *  - the application PROGRAM_VERSION property write (object 4, property 13):
 *    exact bytes, position in the session, and when it is (not) sent
 *  - refusal of a mask load procedure that declares a step this code cannot
 *    run (nothing may have been written when it refuses)
 *  - the closing Restart: Extended (answered, then a short settle) for a
 *    System B mask vs the Basic Restart otherwise, and the fallback when the
 *    mask read gets no answer
 *  - load-state ordering across the four interface objects
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnectedFull,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import {
  KnxConnection,
  scaledMs,
  parseProgramVersionFromAppId,
  programVersionToBuffer,
} from '../server/knx-connection.ts';
import type {
  DownloadStep,
  DownloadExtra,
  DownloadProgress,
} from '../server/knx-connection.ts';
import { saveMasterXml, DATA_DIR } from '../server/routes/shared.ts';
import { clearMaskProcedureCache } from '../server/knx-mask-procedures.ts';

// ── Fake device ───────────────────────────────────────────────────────────────

interface FakeOpts {
  /** Reply to DeviceDescriptor_Read. `null` = never answers. Default 0x07B0. */
  mask?: number | null;
  /** Value PID_TABLE_REFERENCE reads return per object (0 = unallocated). */
  bases?: Record<number, number>;
  /** Whether a Restart_Extended gets its Restart_Extended_Response. Default true. */
  answerRestartExt?: boolean;
  /** What a live read of object 4 / property 13 returns. `null` = no answer. */
  liveProgramVersion?: Buffer | null;
}

/** Default table base addresses: one distinct 0x1000-byte window per object. */
const BASES: Record<number, number> = {
  4: 0x6000,
  3: 0x5000,
  2: 0x4000,
  1: 0x3000,
};

type Ev =
  | {
      k:
        | 'connect'
        | 'disconnect'
        | 'ack'
        | 'devdesc'
        | 'authorize'
        | 'restartBasic';
      t: number;
    }
  | { k: 'propRead'; obj: number; prop: number; t: number }
  | { k: 'propWrite'; obj: number; prop: number; data: Buffer; t: number }
  | {
      k: 'memWrite';
      svc: 'legacy' | 'extended';
      addr: number;
      data: Buffer;
      t: number;
    }
  | { k: 'restartExt'; data: Buffer; systemPriority: boolean; t: number }
  | { k: 'other'; name: string; t: number };

class SeqFakeDevice extends KnxConnection {
  sent: Buffer[] = [];
  sentAt: number[] = [];
  private readonly deviceAddr: string;
  private readonly opts: FakeOpts;

  constructor(deviceAddr: string, opts: FakeOpts = {}) {
    super();
    this.deviceAddr = deviceAddr;
    this.opts = opts;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  private propResponse(obj: number, prop: number, value: Buffer): void {
    this.reply(
      apduConnectedFull(
        0,
        APCI_EXT.PropertyValue_Response,
        Buffer.concat([Buffer.from([obj, prop, 0x11, 0x01]), value]),
      ),
    );
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    this.sentAt.push(Date.now());
    const frame = parseCEMI(cemi);
    if (!frame || frame.apdu.length < 2) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const mask = this.opts.mask === undefined ? 0x07b0 : this.opts.mask;
      if (mask !== null) {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(mask);
        this.reply(apduGroup('DeviceDescriptor_Response', 0, buf));
      }
      return Promise.resolve();
    }

    const fullApci = ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!;
    if (fullApci === APCI_EXT.Authorize_Request) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
    } else if (fullApci === APCI_EXT.PropertyValue_Read) {
      const obj = frame.apduData[0]!;
      const prop = frame.apduData[1]!;
      if (prop === 7) {
        const base = (this.opts.bases ?? BASES)[obj] ?? 0;
        const v = Buffer.alloc(4);
        v.writeUInt32BE(base);
        this.propResponse(obj, prop, v);
      } else if (obj === 0 && prop === 56) {
        this.propResponse(obj, prop, Buffer.from([0x00, 0xe9]));
      } else if (obj === 4 && prop === 13) {
        const live =
          this.opts.liveProgramVersion === undefined
            ? Buffer.from('000a1234ff', 'hex')
            : this.opts.liveProgramVersion;
        if (live) this.propResponse(obj, prop, live);
      } else {
        this.propResponse(obj, prop, Buffer.from([0x00]));
      }
    } else if (fullApci === APCI_EXT.PropertyValue_Write) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.PropertyValue_Response, frame.apduData),
      );
    } else if (fullApci === APCI_EXT.PropertyDescription_Read) {
      // Max element count 0 = "no limit reported" (the download only refuses
      // on a positive, exceeded capacity).
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.PropertyDescription_Response,
          Buffer.alloc(8),
        ),
      );
    } else if (frame.apciName === 'Memory_Write') {
      const count = frame.apdu[1]! & 0x3f;
      this.reply(
        apduGroup('Memory_Response', 0, frame.apduData.subarray(0, 2 + count)),
      );
    } else if (frame.apciName === 'MemoryExtended_Write') {
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.MemoryExtended_Write_Response,
          Buffer.alloc(0),
        ),
      );
    } else if (frame.apciName === 'Restart_Extended') {
      if (this.opts.answerRestartExt !== false) {
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.Restart_Extended_Response,
            Buffer.from([0, 0, 0]),
          ),
        );
      }
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every frame the download sent, decoded to the parts these tests assert on. */
  events(): Ev[] {
    return this.sent.map((c, i): Ev => {
      const t = this.sentAt[i]!;
      const f = parseCEMI(c)!;
      if (f.tpciType === 'CONNECT') return { k: 'connect', t };
      if (f.tpciType === 'DISCONNECT') return { k: 'disconnect', t };
      if (f.tpciType === 'ACK') return { k: 'ack', t };
      if (f.apciName === 'DeviceDescriptor_Read') return { k: 'devdesc', t };
      const fullApci = ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]!;
      if (fullApci === APCI_EXT.Authorize_Request) return { k: 'authorize', t };
      if (fullApci === APCI_EXT.PropertyValue_Read)
        return { k: 'propRead', obj: f.apduData[0]!, prop: f.apduData[1]!, t };
      if (fullApci === APCI_EXT.PropertyValue_Write)
        return {
          k: 'propWrite',
          obj: f.apduData[0]!,
          prop: f.apduData[1]!,
          data: Buffer.from(f.apduData.subarray(4)),
          t,
        };
      if (f.apciName === 'Memory_Write') {
        const count = f.apdu[1]! & 0x3f;
        return {
          k: 'memWrite',
          svc: 'legacy',
          addr: (f.apduData[0]! << 8) | f.apduData[1]!,
          data: Buffer.from(f.apduData.subarray(2, 2 + count)),
          t,
        };
      }
      if (f.apciName === 'MemoryExtended_Write') {
        const count = f.apduData[0]!;
        return {
          k: 'memWrite',
          svc: 'extended',
          addr: (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!,
          data: Buffer.from(f.apduData.subarray(4, 4 + count)),
          t,
        };
      }
      if (f.apciName === 'Restart_Extended')
        return {
          k: 'restartExt',
          data: Buffer.from(f.apduData),
          systemPriority: (c[2]! & 0x0c) === 0,
          t,
        };
      if (f.apciName === 'Restart') return { k: 'restartBasic', t };
      return { k: 'other', name: f.apciName ?? '?', t };
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LSM = {
  UNLOAD: 0x04,
  START_LOADING: 0x01,
  LOAD_DATA: 0x03,
  LOAD_COMPLETED: 0x02,
} as const;

const paramMem = Buffer.from('0102030405060708090a', 'hex');
/** RelSegment + WriteRelMem for object 4: the parameter object's load cycle. */
const PARAM_STEPS: DownloadStep[] = [
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
const GA_TABLE = Buffer.from('0001aabbccdd', 'hex');
const ASSOC_TABLE = Buffer.from('0001000100010001', 'hex');
const OBJ3_TABLE = Buffer.from('00010203', 'hex');

const BASE_EXTRA: DownloadExtra = {
  mode: 'full',
  cachedMaxApduLength: 233,
  supportsExtendedMemoryServices: true,
};

async function run(
  dev: SeqFakeDevice,
  addr: string,
  steps: DownloadStep[],
  tables: {
    ga?: Buffer | null;
    assoc?: Buffer | null;
    param?: Buffer | null;
  } = {},
  extra: DownloadExtra = BASE_EXTRA,
): Promise<{ progress: DownloadProgress[]; debug: string[] }> {
  const progress: DownloadProgress[] = [];
  await dev.downloadDevice(
    addr,
    steps,
    tables.ga ?? null,
    tables.assoc ?? null,
    tables.param === undefined ? paramMem : tables.param,
    (p) => progress.push(p),
    extra,
  );
  return { progress, debug: progress.filter((p) => p.debug).map((p) => p.msg) };
}

/** Index of the first/last event matching a predicate (-1 when none). */
function firstIdx(evs: Ev[], pred: (e: Ev) => boolean): number {
  return evs.findIndex(pred);
}
function lastIdx(evs: Ev[], pred: (e: Ev) => boolean): number {
  for (let i = evs.length - 1; i >= 0; i--) if (pred(evs[i]!)) return i;
  return -1;
}
const isLsm =
  (event: number, obj?: number) =>
  (e: Ev): boolean =>
    e.k === 'propWrite' &&
    e.prop === 5 &&
    e.data[0] === event &&
    (obj === undefined || e.obj === obj);
const isMemWrite = (e: Ev): boolean => e.k === 'memWrite';
const isPv = (e: Ev): boolean =>
  e.k === 'propWrite' && e.obj === 4 && e.prop === 13;

/** Object numbers, in order of first appearance, for the LSM events of one kind. */
function lsmObjOrder(evs: Ev[], event: number): number[] {
  return evs
    .filter(isLsm(event))
    .map((e) => (e as Extract<Ev, { k: 'propWrite' }>).obj);
}

const ALL_TABLES = { ga: GA_TABLE, assoc: ASSOC_TABLE };
const WITH_OBJ3: DownloadExtra = {
  ...BASE_EXTRA,
  groupObjectTable: OBJ3_TABLE,
};

// ── PROGRAM_VERSION ───────────────────────────────────────────────────────────

describe('parseProgramVersionFromAppId / programVersionToBuffer', () => {
  it('splits an application id into manufacturer, application number and version', () => {
    assert.deepEqual(parseProgramVersionFromAppId('M-0004_A-D142-21-8848'), {
      manufacturerId: 0x0004,
      applicationNumber: 0xd142,
      applicationVersion: 0x21,
    });
    assert.deepEqual(
      parseProgramVersionFromAppId('M-00c5_A-0a1b-FF-1234-O000A'),
      {
        manufacturerId: 0x00c5,
        applicationNumber: 0x0a1b,
        applicationVersion: 0xff,
      },
    );
  });

  it('returns null for anything that is not an application id', () => {
    assert.equal(parseProgramVersionFromAppId(undefined), null);
    assert.equal(parseProgramVersionFromAppId(''), null);
    assert.equal(parseProgramVersionFromAppId('not-an-app-id'), null);
    assert.equal(parseProgramVersionFromAppId('M-0004_A-D142'), null);
    assert.equal(parseProgramVersionFromAppId('M-004_A-D142-21-88'), null);
  });

  it('serialises as 2 + 2 + 1 bytes, big-endian', () => {
    assert.equal(
      programVersionToBuffer({
        manufacturerId: 0x0004,
        applicationNumber: 0xd142,
        applicationVersion: 0x21,
      }).toString('hex'),
      '0004d14221',
    );
  });
});

describe('downloadDevice() - application PROGRAM_VERSION write', () => {
  it('writes the 5 bytes derived from the app id, once, after the last content write and before the first LoadCompleted', async () => {
    const dev = new SeqFakeDevice('1.1.9');
    await run(dev, '1.1.9', PARAM_STEPS, ALL_TABLES, {
      ...WITH_OBJ3,
      appId: 'M-0004_A-D142-21-8848',
    });
    const evs = dev.events();

    const pv = evs.filter(isPv) as Array<Extract<Ev, { k: 'propWrite' }>>;
    assert.equal(pv.length, 1, 'exactly one PROGRAM_VERSION write');
    assert.equal(pv[0]!.data.toString('hex'), '0004d14221');

    const pvAt = firstIdx(evs, isPv);
    assert.ok(lastIdx(evs, isMemWrite) >= 0);
    assert.ok(
      pvAt > lastIdx(evs, isMemWrite),
      'after the content of every object has been written',
    );
    assert.ok(
      pvAt < firstIdx(evs, isLsm(LSM.LOAD_COMPLETED)),
      'before any object is marked LoadCompleted',
    );
  });

  it('uses the app id, not the value the device currently reports', async () => {
    // The device answers a live read with a different (stale) identity; the
    // written value must come from the app id, and no live read is needed.
    const dev = new SeqFakeDevice('1.1.9', {
      liveProgramVersion: Buffer.from('000a1234ff', 'hex'),
    });
    await run(
      dev,
      '1.1.9',
      PARAM_STEPS,
      {},
      { ...BASE_EXTRA, appId: 'M-00C5_A-0233-0A-9999' },
    );
    const evs = dev.events();
    assert.equal(
      evs.filter((e) => e.k === 'propRead' && e.obj === 4 && e.prop === 13)
        .length,
      0,
    );
    const pv = evs.find(isPv) as Extract<Ev, { k: 'propWrite' }>;
    assert.equal(pv.data.toString('hex'), '00c502330a');
  });

  it('without a usable app id, reads the live value and writes exactly that back', async () => {
    for (const appId of [undefined, 'garbage']) {
      const live = Buffer.from('000a1234ff', 'hex');
      const dev = new SeqFakeDevice('1.1.9', { liveProgramVersion: live });
      await run(
        dev,
        '1.1.9',
        PARAM_STEPS,
        {},
        { ...BASE_EXTRA, ...(appId ? { appId } : {}) },
      );
      const evs = dev.events();
      const readAt = firstIdx(
        evs,
        (e) => e.k === 'propRead' && e.obj === 4 && e.prop === 13,
      );
      const pvAt = firstIdx(evs, isPv);
      assert.ok(readAt >= 0, 'a live read is issued');
      assert.ok(pvAt > readAt, 'the write follows the read');
      assert.equal(
        (evs[pvAt] as Extract<Ev, { k: 'propWrite' }>).data.toString('hex'),
        live.toString('hex'),
      );
    }
  });

  it('without a usable app id and no answer to the live read, no write is sent (and the download still completes)', async () => {
    const dev = new SeqFakeDevice('1.1.9', { liveProgramVersion: null });
    await run(dev, '1.1.9', PARAM_STEPS, {}, { ...BASE_EXTRA });
    const evs = dev.events();
    assert.ok(
      evs.some((e) => e.k === 'propRead' && e.obj === 4 && e.prop === 13),
    );
    assert.equal(evs.filter(isPv).length, 0);
    assert.ok(
      evs.some(isLsm(LSM.LOAD_COMPLETED, 4)),
      'the download itself still finishes',
    );
  });

  it('is not sent when the download carries no parameter-object content (tables only)', async () => {
    const dev = new SeqFakeDevice('1.1.9');
    await run(dev, '1.1.9', [], ALL_TABLES, {
      ...BASE_EXTRA,
      appId: 'M-0004_A-D142-21-8848',
    });
    const evs = dev.events();
    assert.ok(evs.some(isMemWrite), 'the tables were written');
    assert.equal(evs.filter(isPv).length, 0);
    assert.equal(
      evs.filter((e) => e.k === 'propRead' && e.obj === 4 && e.prop === 13)
        .length,
      0,
    );
  });

  it('is not sent when the parameter object has no allocated table on the device', async () => {
    const dev = new SeqFakeDevice('1.1.9', {
      bases: { 4: 0, 3: 0x5000, 2: 0x4000, 1: 0x3000 },
    });
    await run(dev, '1.1.9', PARAM_STEPS, ALL_TABLES, {
      ...BASE_EXTRA,
      appId: 'M-0004_A-D142-21-8848',
    });
    const evs = dev.events();
    assert.equal(evs.filter(isPv).length, 0);
    assert.equal(
      evs.some(isLsm(LSM.LOAD_COMPLETED, 4)),
      false,
      'the unallocated object is not marked loaded',
    );
    assert.ok(
      evs.some(isLsm(LSM.LOAD_COMPLETED, 1)),
      'the other objects still are',
    );
  });

  it('is not sent when the download is cancelled before any content is written', async () => {
    const dev = new SeqFakeDevice('1.1.9');
    const result = await dev.downloadDevice(
      '1.1.9',
      PARAM_STEPS,
      GA_TABLE,
      ASSOC_TABLE,
      paramMem,
      undefined,
      {
        ...BASE_EXTRA,
        appId: 'M-0004_A-D142-21-8848',
        shouldAbort: () => true,
      },
    );
    assert.equal(result.aborted, true);
    const evs = dev.events();
    assert.equal(evs.filter(isMemWrite).length, 0);
    assert.equal(evs.filter(isPv).length, 0);
    assert.equal(evs.filter(isLsm(LSM.LOAD_COMPLETED)).length, 0);
  });
});

// ── Unhandled mask procedure step ─────────────────────────────────────────────

describe('downloadDevice() - refuses a merged mask procedure containing an unrecognised step', () => {
  const projectId = `test_seq_unhandled_${Date.now()}`;
  const okProjectId = `${projectId}_ok`;
  const MASK = 0x07b0;

  const masterXml = (extraDirective: string): string => `<?xml version="1.0"?>
<KNX>
  <MasterData>
    <MaskVersions>
      <MaskVersion Id="MV-TEST" MaskVersion="${MASK}" Name="Test Mask">
        <HawkConfigurationData>
          <Procedures>
            <Procedure ProcedureType="Load" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlUnload LsmIdx="4" />
              <LdCtrlLoad LsmIdx="4" />
              <LdCtrlMerge MergeId="4" />
              ${extraDirective}
              <LdCtrlLoadCompleted LsmIdx="4" />
              <LdCtrlRestart />
              <LdCtrlDisconnect />
            </Procedure>
          </Procedures>
        </HawkConfigurationData>
      </MaskVersion>
    </MaskVersions>
  </MasterData>
</KNX>`;

  const ids = [projectId, okProjectId];
  after(() => {
    for (const id of ids) {
      clearMaskProcedureCache(id);
      try {
        fs.unlinkSync(path.join(DATA_DIR, `knx_master_${id}.xml`));
      } catch {
        /* never written */
      }
    }
  });

  // The parameter object plus the GA table: both active selects the "all" procedure.
  const steps: DownloadStep[] = [
    PARAM_STEPS[0]!,
    { ...PARAM_STEPS[1]!, mergeId: 4 },
  ];

  it('throws naming the unknown directive, and has written nothing to the device', async () => {
    saveMasterXml(projectId, masterXml('<LdCtrlFrobnicate />'));
    const dev = new SeqFakeDevice('1.1.9');
    await assert.rejects(
      () =>
        run(
          dev,
          '1.1.9',
          steps,
          { ga: GA_TABLE },
          { ...BASE_EXTRA, projectId },
        ),
      /Refusing to download.*LdCtrlFrobnicate/s,
    );
    const evs = dev.events();
    assert.equal(
      evs.filter((e) => e.k === 'propWrite').length,
      0,
      'no property write',
    );
    assert.equal(evs.filter(isMemWrite).length, 0, 'no memory write');
    assert.equal(
      evs.filter((e) => e.k === 'restartExt' || e.k === 'restartBasic').length,
      0,
      'no restart',
    );
    assert.equal(
      evs[evs.length - 1]!.k,
      'disconnect',
      'the management session is still closed cleanly',
    );
  });

  it('the same procedure without the unknown directive downloads normally', async () => {
    saveMasterXml(okProjectId, masterXml(''));
    const dev = new SeqFakeDevice('1.1.9');
    const { debug } = await run(
      dev,
      '1.1.9',
      steps,
      { ga: GA_TABLE },
      { ...BASE_EXTRA, projectId: okProjectId },
    );
    assert.ok(
      debug.some((m) =>
        m.includes('Real download sequence resolved from mask 07b0'),
      ),
    );
    assert.ok(dev.events().some(isLsm(LSM.LOAD_COMPLETED, 4)));
  });
});

// ── Closing Restart ───────────────────────────────────────────────────────────

describe('downloadDevice() - closing Restart variant', () => {
  const TOL = 0.9; // timers never fire early by more than rounding; keep a margin

  it('a System B mask gets the Extended Restart: system priority, payload 01 00, answered, then a short settle before Disconnect', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: 0x07b0 });
    const { debug } = await run(dev, '1.1.9', PARAM_STEPS, {});
    const evs = dev.events();

    assert.equal(evs.filter((e) => e.k === 'restartBasic').length, 0);
    const exts = evs.filter((e) => e.k === 'restartExt') as Array<
      Extract<Ev, { k: 'restartExt' }>
    >;
    assert.equal(exts.length, 1);
    assert.equal(exts[0]!.data.toString('hex'), '0100');
    assert.equal(exts[0]!.systemPriority, true);

    const restartAt = firstIdx(evs, (e) => e.k === 'restartExt');
    const lastCompleted = lastIdx(evs, isLsm(LSM.LOAD_COMPLETED));
    const disconnectAt = lastIdx(evs, (e) => e.k === 'disconnect');
    assert.ok(
      restartAt > lastCompleted,
      'Restart follows the last LoadCompleted',
    );
    assert.ok(
      disconnectAt > restartAt,
      'the session is closed after the Restart',
    );

    assert.ok(
      debug.includes('RestartResp received - device confirmed restart'),
    );
    assert.ok(!debug.some((m) => m.startsWith('No RestartResp')));
    // ~1s settle after LoadCompleted, before the Restart is sent.
    assert.ok(
      evs[restartAt]!.t - evs[lastCompleted]!.t >= scaledMs(1000) * TOL,
    );
    // ~200ms grace after the response - and NOT the 3s no-response fallback.
    const grace = evs[disconnectAt]!.t - evs[restartAt]!.t;
    assert.ok(
      grace >= scaledMs(200) * TOL,
      `grace after RestartResp too short (${grace}ms)`,
    );
    assert.ok(
      grace < scaledMs(3000) * TOL,
      `should not have waited out the no-response fallback (${grace}ms)`,
    );
  });

  it('an unanswered Extended Restart waits out a settle delay before Disconnect, and the download still succeeds', async () => {
    const dev = new SeqFakeDevice('1.1.9', {
      mask: 0x07b0,
      answerRestartExt: false,
    });
    const { debug } = await run(dev, '1.1.9', PARAM_STEPS, {});
    const evs = dev.events();
    assert.ok(debug.some((m) => m.startsWith('No RestartResp within 3s')));
    const restartAt = firstIdx(evs, (e) => e.k === 'restartExt');
    const disconnectAt = lastIdx(evs, (e) => e.k === 'disconnect');
    assert.ok(evs[disconnectAt]!.t - evs[restartAt]!.t >= scaledMs(3200) * TOL);
  });

  it('a mask outside the System B family gets the Basic Restart (no response awaited, ~1.4s before Disconnect)', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: 0x0705 });
    // Legacy memory service too, as a device of that family would use.
    const { debug } = await run(
      dev,
      '1.1.9',
      PARAM_STEPS,
      {},
      { ...BASE_EXTRA, supportsExtendedMemoryServices: false },
    );
    const evs = dev.events();
    assert.equal(evs.filter((e) => e.k === 'restartExt').length, 0);
    assert.equal(evs.filter((e) => e.k === 'restartBasic').length, 1);
    assert.ok(!debug.some((m) => m.includes('RestartResp')));

    const restartAt = firstIdx(evs, (e) => e.k === 'restartBasic');
    const lastCompleted = lastIdx(evs, isLsm(LSM.LOAD_COMPLETED));
    const disconnectAt = lastIdx(evs, (e) => e.k === 'disconnect');
    assert.ok(restartAt > lastCompleted);
    assert.ok(
      evs[restartAt]!.t - evs[lastCompleted]!.t >= scaledMs(1000) * TOL,
    );
    assert.ok(evs[disconnectAt]!.t - evs[restartAt]!.t >= scaledMs(1400) * TOL);
  });

  it('the choice follows the device mask, not the memory-write service', async () => {
    const cases: Array<{
      mask: number;
      ext: boolean;
      expect: 'restartExt' | 'restartBasic';
    }> = [
      { mask: 0x07b0, ext: true, expect: 'restartExt' },
      { mask: 0x07b0, ext: false, expect: 'restartExt' }, // System B but legacy memory service
      { mask: 0x27b0, ext: false, expect: 'restartExt' }, // low byte 0xB0 = System B family
      { mask: 0x0705, ext: true, expect: 'restartBasic' }, // not System B but extended memory service
      { mask: 0x0705, ext: false, expect: 'restartBasic' },
    ];
    for (const c of cases) {
      const dev = new SeqFakeDevice('1.1.9', { mask: c.mask });
      await run(
        dev,
        '1.1.9',
        PARAM_STEPS,
        {},
        { ...BASE_EXTRA, supportsExtendedMemoryServices: c.ext },
      );
      const kinds = dev.events().map((e) => e.k);
      const other = c.expect === 'restartExt' ? 'restartBasic' : 'restartExt';
      assert.ok(
        kinds.includes(c.expect),
        `mask 0x${c.mask.toString(16)} ext=${c.ext}: expected ${c.expect}`,
      );
      assert.ok(
        !kinds.includes(other),
        `mask 0x${c.mask.toString(16)} ext=${c.ext}: must not send ${other}`,
      );
    }
  });
});

describe('downloadDevice() - the DeviceDescriptor (mask) read gets no answer', () => {
  it('is issued once up front, tolerated, and the download completes without touching the PEI Program object', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: null });
    const started = Date.now();
    const { debug } = await run(dev, '1.1.9', PARAM_STEPS, {});
    const elapsed = Date.now() - started;
    const evs = dev.events();

    assert.equal(
      evs.filter((e) => e.k === 'devdesc').length,
      1,
      'read once (the memory service was already resolved)',
    );
    assert.ok(
      debug.some((m) =>
        m.includes(
          'No DeviceDescriptor_Response received (object-5/PEI Program step will be skipped)',
        ),
      ),
    );
    // The unanswered read costs its full 3s wait, and the download carries on.
    assert.ok(elapsed >= scaledMs(3000) * 0.9);
    assert.equal(
      evs.filter((e) => e.k === 'propWrite' && e.obj === 5).length,
      0,
      'no PEI Program unload without a known mask',
    );
    assert.ok(
      evs.some(isLsm(LSM.LOAD_COMPLETED, 4)),
      'the load cycle still completes',
    );
  });

  it('the closing Restart then follows the memory-write service: extended service -> Extended Restart', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: null });
    await run(
      dev,
      '1.1.9',
      PARAM_STEPS,
      {},
      { ...BASE_EXTRA, supportsExtendedMemoryServices: true },
    );
    const kinds = dev.events().map((e) => e.k);
    assert.ok(kinds.includes('restartExt'));
    assert.ok(!kinds.includes('restartBasic'));
  });

  it('the closing Restart then follows the memory-write service: legacy service -> Basic Restart', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: null });
    await run(
      dev,
      '1.1.9',
      PARAM_STEPS,
      {},
      { ...BASE_EXTRA, supportsExtendedMemoryServices: false },
    );
    const evs = dev.events();
    const kinds = evs.map((e) => e.k);
    assert.ok(kinds.includes('restartBasic'));
    assert.ok(!kinds.includes('restartExt'));
    assert.ok(evs.some((e) => e.k === 'memWrite' && e.svc === 'legacy'));
  });
});

// ── Load-state ordering ───────────────────────────────────────────────────────

describe('downloadDevice() - object ordering across the four interface objects', () => {
  it('unloads 5,4,3,2,1; loads 4,3,1,2; writes content 4,3,2,1; completes 4,3,2,1', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: 0x07b0 });
    await run(dev, '1.1.9', PARAM_STEPS, ALL_TABLES, WITH_OBJ3);
    const evs = dev.events();

    assert.deepEqual(
      lsmObjOrder(evs, LSM.UNLOAD),
      [5, 4, 3, 2, 1],
      'unload order',
    );
    assert.deepEqual(
      lsmObjOrder(evs, LSM.START_LOADING),
      [4, 3, 1, 2],
      'load order',
    );
    assert.deepEqual(
      lsmObjOrder(evs, LSM.LOAD_COMPLETED),
      [4, 3, 2, 1],
      'LoadCompleted order',
    );

    // Content order: which object's window each memory write landed in.
    const objAt = (addr: number): number =>
      Number(
        Object.entries(BASES).find(
          ([, b]) => addr >= b && addr < b + 0x1000,
        )![0],
      );
    const writeObjs = (
      evs.filter(isMemWrite) as Array<Extract<Ev, { k: 'memWrite' }>>
    ).map((e) => objAt(e.addr));
    assert.deepEqual(
      [...new Set(writeObjs)],
      [4, 3, 2, 1],
      'content write order',
    );
  });

  it('runs the phases as whole-session batches: all Unloads, then all loads, then all content, then all LoadCompleted', async () => {
    const dev = new SeqFakeDevice('1.1.9', { mask: 0x07b0 });
    await run(dev, '1.1.9', PARAM_STEPS, ALL_TABLES, WITH_OBJ3);
    const evs = dev.events();

    const lastUnload = lastIdx(evs, isLsm(LSM.UNLOAD));
    const firstStart = firstIdx(evs, isLsm(LSM.START_LOADING));
    const lastLoadData = lastIdx(evs, isLsm(LSM.LOAD_DATA));
    const firstMem = firstIdx(evs, isMemWrite);
    const lastMem = lastIdx(evs, isMemWrite);
    const firstCompleted = firstIdx(evs, isLsm(LSM.LOAD_COMPLETED));
    assert.ok(lastUnload < firstStart);
    assert.ok(lastLoadData < firstMem);
    assert.ok(lastMem < firstCompleted);

    // Within the load phase each StartLoading is immediately followed by its own LoadData.
    const lsm = evs.filter(
      (e) => e.k === 'propWrite' && e.prop === 5 && e.obj !== 5,
    ) as Array<Extract<Ev, { k: 'propWrite' }>>;
    const loadPhase = lsm.filter(
      (e) => e.data[0] === LSM.START_LOADING || e.data[0] === LSM.LOAD_DATA,
    );
    for (let i = 0; i < loadPhase.length; i += 2) {
      assert.equal(loadPhase[i]!.data[0], LSM.START_LOADING);
      assert.equal(loadPhase[i + 1]!.data[0], LSM.LOAD_DATA);
      assert.equal(loadPhase[i]!.obj, loadPhase[i + 1]!.obj);
    }
  });
});
