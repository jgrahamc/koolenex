/**
 * Tests for the centralized mask-Procedure download ordering source
 * (server/knx-mask-procedures.ts).
 *
 * `parseMaskProcedures`/`spliceAppSteps`/`orderByMergedOps`/
 * `resolveProcedureSubType` run against small synthetic fixtures.
 * `getMaskProcedure` is additionally exercised against the real KNX Master
 * Data (`data/knx_master_1.xml`): mask `0x07B0` (System B) declares a
 * `Load:all` Procedure with DESCENDING unload order (5,4,3,2,1); mask
 * `0x0705` (Gira) declares no `Load` Procedure at all, so both executors'
 * fallback-to-natural-order path is expected behavior there, not a gap.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  parseMaskProcedures,
  spliceAppSteps,
  orderByMergedOps,
  resolveProcedureSubType,
  getMaskProcedure,
  clearMaskProcedureCache,
  type MaskOp,
} from '../server/knx-mask-procedures.ts';
import { saveMasterXml, DATA_DIR } from '../server/routes/shared.ts';

const uid = `test_maskproc_${Date.now()}`;
const tempIds: string[] = [];

after(() => {
  for (const id of tempIds) {
    clearMaskProcedureCache(id);
    try {
      fs.unlinkSync(path.join(DATA_DIR, `knx_master_${id}.xml`));
    } catch {
      /* nothing was ever saved for this id - fine */
    }
  }
});

// Small, fully synthetic master-data fixture: one mask version with a real
// Merge-splice-point-shaped Load:all Procedure and a plain Unload:all one.
function fixtureXml(maskVersionDecimal: number): string {
  return `<?xml version="1.0"?>
<KNX>
  <MasterData>
    <MaskVersions>
      <MaskVersion Id="MV-TEST" MaskVersion="${maskVersionDecimal}" Name="Test Mask">
        <HawkConfigurationData>
          <Procedures>
            <Procedure ProcedureType="Load" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlUnload LsmIdx="3" />
              <LdCtrlUnload LsmIdx="2" />
              <LdCtrlUnload LsmIdx="1" />
              <LdCtrlLoad LsmIdx="2" />
              <LdCtrlMerge MergeId="1" />
              <LdCtrlLoad LsmIdx="1" />
              <LdCtrlMerge MergeId="2" />
              <LdCtrlWriteRelMem ObjIdx="2" Offset="0" Size="100" />
              <LdCtrlWriteRelMem ObjIdx="1" Offset="0" Size="100" />
              <LdCtrlMerge MergeId="3" />
              <LdCtrlLoadCompleted LsmIdx="2" />
              <LdCtrlLoadCompleted LsmIdx="1" />
              <LdCtrlRestart />
            </Procedure>
            <Procedure ProcedureType="Unload" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlUnload LsmIdx="1" />
              <LdCtrlUnload LsmIdx="2" />
              <LdCtrlDisconnect />
            </Procedure>
          </Procedures>
        </HawkConfigurationData>
      </MaskVersion>
    </MaskVersions>
  </MasterData>
</KNX>`;
}

// ── parseMaskProcedures ──────────────────────────────────────────────────

describe('parseMaskProcedures', () => {
  it('parses a real MaskVersion/Procedures/Procedure structure, in document order', () => {
    const entries = parseMaskProcedures(fixtureXml(1234));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.maskVersionDecimal, 1234);
    const loadAll = entries[0]!.procedures.get('Load:all')?.[0]?.ops;
    assert.ok(loadAll);
    assert.deepEqual(
      loadAll!.map((op) => op.type),
      [
        'Connect',
        'Unload',
        'Unload',
        'Unload',
        'Load',
        'Merge',
        'Load',
        'Merge',
        'WriteRelMem',
        'WriteRelMem',
        'Merge',
        'LoadCompleted',
        'LoadCompleted',
        'Restart',
      ],
    );
    const unloadAll = entries[0]!.procedures.get('Unload:all')?.[0]?.ops;
    assert.ok(unloadAll);
    assert.equal(unloadAll!.length, 4);
  });

  it('returns an empty list for XML with no MaskVersions at all', () => {
    assert.deepEqual(parseMaskProcedures('<KNX><MasterData/></KNX>'), []);
  });

  it('skips a MaskVersion with no numeric MaskVersion attribute', () => {
    const xml = `<KNX><MasterData><MaskVersions><MaskVersion Id="x"><HawkConfigurationData/></MaskVersion></MaskVersions></MasterData></KNX>`;
    assert.deepEqual(parseMaskProcedures(xml), []);
  });
});

// ── spliceAppSteps ───────────────────────────────────────────────────────

describe('spliceAppSteps', () => {
  const maskOps: MaskOp[] = [
    { type: 'Connect' },
    { type: 'Unload', lsmIdx: 1 },
    { type: 'Merge', mergeId: 1 },
    { type: 'Merge', mergeId: 2 },
    { type: 'Restart' },
  ];

  it('splices declared app steps in at their own MergeId, mask ops otherwise unchanged', () => {
    const appSteps = [
      { type: 'WriteRelMem', objIdx: 2, mergeId: 2 },
      { type: 'WriteProp', objIdx: 4, mergeId: 1 },
    ];
    const result = spliceAppSteps(maskOps, appSteps);
    assert.deepEqual(
      result.map((op) => op.type),
      ['Connect', 'Unload', 'WriteProp', 'WriteRelMem', 'Restart'],
    );
  });

  it('a Merge marker with no matching declared group contributes nothing', () => {
    const result = spliceAppSteps(maskOps, []);
    assert.deepEqual(
      result.map((op) => op.type),
      ['Connect', 'Unload', 'Restart'],
    );
  });

  it('steps with no mergeId at all are appended at the very end, not dropped', () => {
    const appSteps = [{ type: 'WriteProp', objIdx: 4 }];
    const result = spliceAppSteps(maskOps, appSteps);
    assert.deepEqual(
      result.map((op) => op.type),
      ['Connect', 'Unload', 'Restart', 'WriteProp'],
    );
  });

  it('multiple steps at the same MergeId keep their own relative order', () => {
    const appSteps = [
      { type: 'WriteRelMem', objIdx: 3, mergeId: 2 },
      { type: 'WriteRelMem', objIdx: 2, mergeId: 2 },
      { type: 'WriteRelMem', objIdx: 1, mergeId: 2 },
    ];
    const result = spliceAppSteps(maskOps, appSteps);
    assert.deepEqual(
      result.filter((op) => op.type === 'WriteRelMem').map((op) => op.objIdx),
      [3, 2, 1],
    );
  });
});

// ── orderByMergedOps ─────────────────────────────────────────────────────

describe('orderByMergedOps', () => {
  interface Job {
    objIdx: number;
  }
  const jobs: Job[] = [
    { objIdx: 1 },
    { objIdx: 2 },
    { objIdx: 3 },
    { objIdx: 4 },
  ];

  it('falls back to fallbackCompare when mergedOps is null', () => {
    const result = orderByMergedOps(
      jobs,
      null,
      'Unload',
      'objIdx',
      (j) => j.objIdx,
      (a, b) => b.objIdx - a.objIdx,
    );
    assert.deepEqual(
      result.map((j) => j.objIdx),
      [4, 3, 2, 1],
    );
  });

  it('orders jobs by the mask ops own real position for the matching op type', () => {
    const mergedOps: MaskOp[] = [
      { type: 'Unload', objIdx: 2 },
      { type: 'Unload', objIdx: 4 },
      { type: 'Unload', objIdx: 1 },
      { type: 'Unload', objIdx: 3 },
    ];
    const result = orderByMergedOps(
      jobs,
      mergedOps,
      'Unload',
      'objIdx',
      (j) => j.objIdx,
      (a, b) => a.objIdx - b.objIdx, // fallback should not be used here
    );
    assert.deepEqual(
      result.map((j) => j.objIdx),
      [2, 4, 1, 3],
    );
  });

  it('falls back when mergedOps genuinely has no occurrence of this op type for some job', () => {
    const mergedOps: MaskOp[] = [
      { type: 'Unload', objIdx: 1 },
      { type: 'Unload', objIdx: 2 },
      // objIdx 3 and 4 never appear as an Unload op
    ];
    const result = orderByMergedOps(
      jobs,
      mergedOps,
      'Unload',
      'objIdx',
      (j) => j.objIdx,
      (a, b) => b.objIdx - a.objIdx,
    );
    assert.deepEqual(
      result.map((j) => j.objIdx),
      [4, 3, 2, 1],
    );
  });

  it('reads the rank from lsmIdx when rankField is lsmIdx, keyed against a different job field', () => {
    interface Step {
      lsmIdx: number;
    }
    const steps: Step[] = [{ lsmIdx: 1 }, { lsmIdx: 2 }, { lsmIdx: 3 }];
    const mergedOps: MaskOp[] = [
      { type: 'Load', lsmIdx: 3 },
      { type: 'Load', lsmIdx: 1 },
      { type: 'Load', lsmIdx: 2 },
    ];
    const result = orderByMergedOps(
      steps,
      mergedOps,
      'Load',
      'lsmIdx',
      (s) => s.lsmIdx,
      (a, b) => a.lsmIdx - b.lsmIdx,
    );
    assert.deepEqual(
      result.map((s) => s.lsmIdx),
      [3, 1, 2],
    );
  });
});

// ── resolveProcedureSubType ──────────────────────────────────────────────

describe('resolveProcedureSubType', () => {
  it('param and group both active -> "all" for full mode', () => {
    assert.equal(resolveProcedureSubType(true, true, 'full'), 'all');
  });
  it('param and group both active -> "par,grp" for partial mode', () => {
    assert.equal(resolveProcedureSubType(true, true, 'partial'), 'par,grp');
  });
  it('param only -> "par"', () => {
    assert.equal(resolveProcedureSubType(true, false, 'full'), 'par');
    assert.equal(resolveProcedureSubType(true, false, 'partial'), 'par');
  });
  it('group only -> "grp"', () => {
    assert.equal(resolveProcedureSubType(false, true, 'full'), 'grp');
  });
  it('neither active -> null', () => {
    assert.equal(resolveProcedureSubType(false, false, 'full'), null);
  });
});

// ── getMaskProcedure (synthetic project, via saveMasterXml/readMasterXml) ──

describe('getMaskProcedure', () => {
  it('resolves a real hex mask string to the matching decimal MaskVersion', () => {
    const pid = `${uid}_a`;
    tempIds.push(pid);
    saveMasterXml(pid, fixtureXml(1968)); // 0x07B0 = 1968
    const ops = getMaskProcedure(pid, '07b0', 'Load', 'all');
    assert.ok(ops);
    assert.equal(ops![0]!.type, 'Connect');
  });

  it('returns null for a mask/procedure combination genuinely not declared', () => {
    const pid = `${uid}_b`;
    tempIds.push(pid);
    saveMasterXml(pid, fixtureXml(1968));
    assert.equal(getMaskProcedure(pid, '07b0', 'Load', 'par'), null);
    assert.equal(getMaskProcedure(pid, '0705', 'Load', 'all'), null);
  });

  it('returns null when no project id, or no master XML on record, is given', () => {
    assert.equal(getMaskProcedure(null, '07b0', 'Load', 'all'), null);
    assert.equal(
      getMaskProcedure(`${uid}_missing`, '07b0', 'Load', 'all'),
      null,
    );
  });

  it('caches per project id - a stale cache entry is not silently reused across unrelated ids', () => {
    const pidA = `${uid}_c1`;
    const pidB = `${uid}_c2`;
    tempIds.push(pidA, pidB);
    saveMasterXml(pidA, fixtureXml(1968));
    assert.ok(getMaskProcedure(pidA, '07b0', 'Load', 'all'));
    // A different project id that never got a master XML saved must not
    // see pidA's cached result.
    assert.equal(getMaskProcedure(pidB, '07b0', 'Load', 'all'), null);
  });
});

// ── Validation against real KNX Master Data (data/knx_master_1.xml) ──────
// Same source koolenex's write path trusts elsewhere (getDptInfo/
// getMaskVersions/etc, server/routes/shared.ts). Not a synthetic fixture.

describe('getMaskProcedure against real master data', () => {
  const REAL_MASTER_XML_PATH = 'data/knx_master_1.xml';
  const hasRealMasterData = fs.existsSync(REAL_MASTER_XML_PATH);

  it(
    'mask 0x07B0 (System B) declares a real Load:all Procedure with the confirmed descending Unload order',
    { skip: !hasRealMasterData },
    () => {
      const pid = `${uid}_real_07b0`;
      tempIds.push(pid);
      saveMasterXml(pid, fs.readFileSync(REAL_MASTER_XML_PATH, 'utf8'));
      const ops = getMaskProcedure(pid, '07b0', 'Load', 'all');
      assert.ok(ops, 'expected a real Load:all Procedure for mask 07B0');
      const unloadOrder = ops!
        .filter((op) => op.type === 'Unload')
        .map((op) => op.lsmIdx);
      assert.deepEqual(unloadOrder, [5, 4, 3, 2, 1]);
    },
  );

  it(
    'mask 0x0705 (Gira) declares NO Load Procedure at all',
    { skip: !hasRealMasterData },
    () => {
      // A Gira smoke-alarm device (DevDescrResp $0705) unloads/loads objects
      // 1,2,3 in ASCENDING order, opposite mask 07B0's descending convention.
      // Master data has no Load Procedure for this mask, for any subtype -
      // so the fallback-to-natural-declared-order path is correct here: the
      // application program's own steps already declare ascending order.
      const pid = `${uid}_real_0705`;
      tempIds.push(pid);
      saveMasterXml(pid, fs.readFileSync(REAL_MASTER_XML_PATH, 'utf8'));
      for (const subtype of ['all', 'grp', 'par', 'par,grp', 'ap1', 'cfg']) {
        assert.equal(
          getMaskProcedure(pid, '0705', 'Load', subtype),
          null,
          `expected no Load:${subtype} Procedure for mask 0705`,
        );
      }
      // A real Unload:all Procedure does exist for this mask, confirming this
      // isn't a parse failure.
      assert.ok(getMaskProcedure(pid, '0705', 'Unload', 'all'));
    },
  );
});

// ── duplicate procedures (LegacyVersion) and unrecognised directives ─────────

function duplicateXml(maskVersionDecimal: number): string {
  return `<?xml version="1.0"?>
<KNX>
  <MasterData>
    <MaskVersions>
      <MaskVersion Id="MV-DUP" MaskVersion="${maskVersionDecimal}" Name="Dup Mask">
        <HawkConfigurationData>
          <Procedures>
            <Procedure ProcedureType="Load" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlLoad LsmIdx="1" />
              <LdCtrlRestart />
            </Procedure>
          </Procedures>
        </HawkConfigurationData>
        <HawkConfigurationData LegacyVersion="1">
          <Procedures>
            <Procedure ProcedureType="Load" ProcedureSubType="all">
              <LdCtrlConnect />
              <LdCtrlLoad LsmIdx="2" />
              <LdCtrlLoad LsmIdx="3" />
              <LdCtrlRestart />
            </Procedure>
          </Procedures>
        </HawkConfigurationData>
      </MaskVersion>
    </MaskVersions>
  </MasterData>
</KNX>`;
}

describe('duplicate mask procedures (plain and LegacyVersion)', () => {
  it('keeps every revision instead of letting the last one silently win', () => {
    const entries = parseMaskProcedures(duplicateXml(2000));
    const revisions = entries[0]!.procedures.get('Load:all')!;
    assert.equal(revisions.length, 2);
    assert.deepEqual(
      revisions.map((r) => r.isLegacy),
      [false, true],
    );
    assert.equal(revisions[0]!.ops.length, 3);
    assert.equal(revisions[1]!.ops.length, 4);
  });

  it('getMaskProcedure uses the non-legacy revision by default, the legacy one only when asked', () => {
    const pid = `${uid}_dup`;
    tempIds.push(pid);
    saveMasterXml(pid, duplicateXml(2000)); // 0x07D0
    assert.equal(getMaskProcedure(pid, '07d0', 'Load', 'all')!.length, 3);
    assert.equal(
      getMaskProcedure(pid, '07d0', 'Load', 'all', false)!.length,
      3,
    );
    assert.equal(getMaskProcedure(pid, '07d0', 'Load', 'all', true)!.length, 4);
  });
});

describe('unrecognised mask directives', () => {
  const xml = `<?xml version="1.0"?>
<KNX><MasterData><MaskVersions>
  <MaskVersion Id="MV-UNK" MaskVersion="2001" Name="Legacy Mask">
    <HawkConfigurationData><Procedures>
      <Procedure ProcedureType="Load" ProcedureSubType="all">
        <LdCtrlConnect />
        <LdCtrlWriteMem Address="256" Size="2" InlineData="0102" />
        <LdCtrlDelay MilliSeconds="100" />
        <LdCtrlSetControlVariable Name="EnableVerifyOnWriteDirect" Value="true" />
        <LdCtrlRestart />
      </Procedure>
    </Procedures></HawkConfigurationData>
  </MaskVersion>
</MaskVersions></MasterData></KNX>`;

  it('are carried through as Unhandled (not silently dropped), with the tag', () => {
    const ops =
      parseMaskProcedures(xml)[0]!.procedures.get('Load:all')![0]!.ops;
    assert.deepEqual(
      ops.map((o) => o.type),
      ['Connect', 'Unhandled', 'Unhandled', 'SetControlVariable', 'Restart'],
    );
    assert.deepEqual(
      ops.filter((o) => o.type === 'Unhandled').map((o) => o.tag),
      ['LdCtrlWriteMem', 'LdCtrlDelay'],
    );
    const scv = ops.find((o) => o.type === 'SetControlVariable')!;
    assert.equal(scv.name, 'EnableVerifyOnWriteDirect');
    assert.equal(scv.value, 'true');
  });
});
