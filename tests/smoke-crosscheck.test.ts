/**
 * Cross-validation tests for the ABB smoke test .knxproj parser.
 *
 * Reads the raw application program XML from the .knxproj ZIP and
 * verifies our parser's output matches the source data. Covers the
 * SAH/S8.6.7.1 (3285 params, 1560 union params) and UD/S4.210.2.1
 * (893 params) — both have large parameter sets and complex
 * choose/when dynamic trees but no module templates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { XMLParser } from 'fast-xml-parser';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Smoke cross-check', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  process.exit(0);
}

// @ts-expect-error TS1470
const require_ = createRequire(import.meta.url);
const Minizip = require_('minizip-asm.js') as new (data: Buffer) => {
  list(): { filepath: string }[];
  extract(f: string): Uint8Array;
};

const ARRAY_TAGS = new Set([
  'Parameter',
  'ParameterType',
  'ParameterRef',
  'Enumeration',
  'Union',
  'ComObject',
  'ComObjectRef',
  'LoadProcedure',
  'LdCtrlRelSegment',
  'LdCtrlWriteProp',
  'LdCtrlCompareProp',
  'LdCtrlWriteRelMem',
  'LdCtrlLoadImageProp',
  'LdCtrlAbsSegment',
  'Language',
  'TranslationUnit',
  'TranslationElement',
  'Translation',
]);
const rawParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAY_TAGS.has(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadRawApp(zipBuf: Buffer, appFile: string): any {
  const mz = new Minizip(zipBuf);
  const xmlBuf = Buffer.from(mz.extract(appFile));
  return rawParser.parse(xmlBuf.toString('utf8'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectRawParams(st: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [...(st.Parameters?.Parameter || [])];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const u of (st.Parameters?.Union || []) as any[]) {
    all.push(...(u.Parameter || []));
  }
  return all;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTranslations(mfr: any): Record<string, Record<string, string>> {
  const trans: Record<string, Record<string, string>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const lang of (mfr.Languages?.Language || []) as any[]) {
    if (!/^en/i.test(lang['@_Identifier'] || '')) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const tu of (lang.TranslationUnit || []) as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const te of (tu.TranslationElement || []) as any[]) {
        const refId = te['@_RefId'] as string | undefined;
        if (!refId) continue;
        if (!trans[refId]) trans[refId] = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const t of (te.Translation || []) as any[]) {
          if (t['@_AttributeName'] && t['@_Text'])
            trans[refId]![t['@_AttributeName'] as string] = t[
              '@_Text'
            ] as string;
        }
      }
    }
  }
  return trans;
}

function crossCheckApp(
  label: string,
  appFile: string,
  appId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsed: any,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = parsed.paramModels[appId] as Record<string, any>;
  const ourParams: Record<string, Record<string, unknown>> = model.params;
  const ourLayout: Record<
    string,
    Record<string, unknown>
  > = model.paramMemLayout;

  const zipBuf = fs.readFileSync(SMOKE_PROJECT);
  const xml = loadRawApp(zipBuf, appFile);
  const mfr = xml.KNX.ManufacturerData.Manufacturer;
  const ap = mfr.ApplicationPrograms.ApplicationProgram;
  const st = ap.Static;

  const allRawParams = collectRawParams(st);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawParamById: Record<string, any> = {};
  for (const p of allRawParams) rawParamById[p['@_Id']] = p;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawTypeById: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of (st.ParameterTypes?.ParameterType || []) as any[]) {
    rawTypeById[t['@_Id']] = t;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawRefs = (st.ParameterRefs?.ParameterRef || []) as any[];
  const trans = buildTranslations(mfr);

  describe(`${label}: param integrity`, () => {
    it('every output param has a valid ParameterRef in the XML', () => {
      const refById: Record<string, boolean> = {};
      for (const ref of rawRefs) refById[ref['@_Id']] = true;
      let orphans = 0;
      for (const key of Object.keys(ourParams)) {
        // Our parser strips module instance paths (_M-n_MI-n_)
        const stripped = key.replace(/_M-\d+_MI-\d+/g, '');
        if (!refById[key] && !refById[stripped]) {
          orphans++;
          if (orphans <= 3)
            assert.fail(`${key} not found in raw XML ParameterRefs`);
        }
      }
      assert.equal(orphans, 0, `${orphans} orphan params`);
    });

    it('every output param resolves to a real Parameter', () => {
      let missing = 0;
      for (const key of Object.keys(ourParams)) {
        const stripped = key.replace(/_M-\d+_MI-\d+/g, '');
        const ref = rawRefs.find(
          (r: Record<string, unknown>) =>
            r['@_Id'] === key || r['@_Id'] === stripped,
        );
        if (!ref) continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) {
          missing++;
          if (missing <= 3)
            assert.fail(`${key} ref ${ref['@_RefId']} has no Parameter`);
        }
      }
      assert.equal(missing, 0, `${missing} missing params`);
    });
  });

  describe(`${label}: labels`, () => {
    it('every label matches XML source', () => {
      let checked = 0;
      let mismatches = 0;
      for (const ref of rawRefs) {
        const refId = ref['@_Id'];
        if (!ourParams[refId]) continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) continue;
        const paramId = param['@_Id'];
        const rawExpected =
          trans[refId]?.Text ||
          ref['@_Text'] ||
          trans[paramId]?.Text ||
          param['@_Text'] ||
          '';
        const expected = sanitizeText(rawExpected);
        const ours = ourParams[refId].label as string;
        if (expected && ours !== expected) {
          mismatches++;
          if (mismatches <= 3)
            assert.fail(`${refId}: expected "${expected}", got "${ours}"`);
        }
        checked++;
      }
      assert(checked > Object.keys(ourParams).length * 0.9);
      assert.equal(mismatches, 0, `${mismatches} mismatches out of ${checked}`);
    });
  });

  describe(`${label}: default values`, () => {
    it('every default matches XML source', () => {
      let checked = 0;
      let mismatches = 0;
      for (const ref of rawRefs) {
        const refId = ref['@_Id'];
        if (!ourParams[refId]) continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) continue;
        const expected = ref['@_Value'] ?? param['@_Value'] ?? '';
        const ours = ourParams[refId].defaultValue as string;
        if (String(expected) !== String(ours)) {
          mismatches++;
          if (mismatches <= 3)
            assert.fail(`${refId}: expected "${expected}", got "${ours}"`);
        }
        checked++;
      }
      assert(checked > Object.keys(ourParams).length * 0.9);
      assert.equal(mismatches, 0, `${mismatches} mismatches`);
    });
  });

  describe(`${label}: memory offsets`, () => {
    it('offsets match XML Memory child elements', () => {
      let checked = 0;
      let mismatches = 0;
      for (const ref of rawRefs) {
        const refId = ref['@_Id'];
        const entry = ourLayout[refId];
        if (!entry) continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) continue;
        const mem = Array.isArray(param.Memory)
          ? param.Memory[0]
          : param.Memory;
        if (!mem) continue;
        const expectedOff = parseInt(mem['@_Offset'], 10);
        if (isNaN(expectedOff)) continue;
        const expectedBit = parseInt(mem['@_BitOffset'] || '0', 10);
        if (entry.offset !== expectedOff || entry.bitOffset !== expectedBit) {
          mismatches++;
          if (mismatches <= 3)
            assert.fail(
              `${refId}: expected ${expectedOff}:${expectedBit}, got ${entry.offset}:${entry.bitOffset}`,
            );
        }
        checked++;
      }
      assert(
        checked > 0,
        `should check at least 1 param with Memory child, got ${checked}`,
      );
      assert.equal(
        mismatches,
        0,
        `${mismatches} offset mismatches out of ${checked}`,
      );
    });
  });

  describe(`${label}: enum values`, () => {
    it('enum entries match XML TypeRestriction/Enumeration', () => {
      let checked = 0;
      let mismatches = 0;
      for (const ref of rawRefs) {
        const refId = ref['@_Id'];
        if (!ourParams[refId] || ourParams[refId].typeKind !== 'enum') continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) continue;
        const rawType = rawTypeById[param['@_ParameterType']];
        if (!rawType?.TypeRestriction?.Enumeration) continue;
        const rawEnums = rawType.TypeRestriction.Enumeration;
        const ourEnums = ourParams[refId].enums as Record<string, string>;
        if (Object.keys(ourEnums).length !== rawEnums.length) {
          mismatches++;
          if (mismatches <= 3)
            assert.fail(
              `${refId}: enum count XML=${rawEnums.length} ours=${Object.keys(ourEnums).length}`,
            );
        }
        checked++;
      }
      assert(checked > 50, `checked ${checked}`);
      assert.equal(mismatches, 0, `${mismatches} mismatches`);
    });
  });

  describe(`${label}: bitSize`, () => {
    it('matches XML SizeInBit', () => {
      let checked = 0;
      let mismatches = 0;
      for (const ref of rawRefs) {
        const refId = ref['@_Id'];
        const entry = ourLayout[refId];
        if (!entry) continue;
        const param = rawParamById[ref['@_RefId']];
        if (!param) continue;
        const rawType = rawTypeById[param['@_ParameterType']];
        if (!rawType) continue;
        let expectedSize: number | undefined;
        for (const child of [
          'TypeNumber',
          'TypeRestriction',
          'TypeFloat',
          'TypeText',
          'TypeTime',
        ]) {
          if (rawType[child]) {
            const sib = rawType[child]['@_SizeInBit'];
            if (sib !== undefined) expectedSize = parseInt(sib, 10);
            break;
          }
        }
        if (expectedSize === undefined || isNaN(expectedSize)) continue;
        if (entry.bitSize !== expectedSize) {
          mismatches++;
          if (mismatches <= 3)
            assert.fail(`${refId}: XML=${expectedSize} ours=${entry.bitSize}`);
        }
        checked++;
      }
      assert(checked > 200, `checked ${checked}`);
      assert.equal(mismatches, 0, `${mismatches} mismatches`);
    });
  });

  describe(`${label}: load procedures`, () => {
    it('every parsed step has a matching type in the raw XML', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lps = (st.LoadProcedures?.LoadProcedure || []) as any[];
      const rawSteps: Array<{ type: string; size?: number }> = [];
      for (const lp of lps) {
        for (const key of Object.keys(lp)) {
          if (!key.startsWith('LdCtrl')) continue;
          const items = Array.isArray(lp[key]) ? lp[key] : [lp[key]];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const item of items as any[]) {
            rawSteps.push({
              type: key.replace('LdCtrl', ''),
              size:
                item['@_Size'] !== undefined
                  ? parseInt(item['@_Size'], 10)
                  : undefined,
            });
          }
        }
      }
      // Parser may skip WriteProp steps with no InlineData — count can differ
      assert(
        model.loadProcedures.length <= rawSteps.length,
        `parser has more steps (${model.loadProcedures.length}) than XML (${rawSteps.length})`,
      );
      // Verify each parsed step type exists in the raw steps
      const rawTypeCounts: Record<string, number> = {};
      for (const s of rawSteps)
        rawTypeCounts[s.type] = (rawTypeCounts[s.type] || 0) + 1;
      const ourTypeCounts: Record<string, number> = {};
      for (const s of model.loadProcedures)
        ourTypeCounts[s.type] = (ourTypeCounts[s.type] || 0) + 1;
      for (const [type, count] of Object.entries(ourTypeCounts)) {
        const shortType = type
          .replace('Prop', 'Prop')
          .replace('RelMem', 'RelMem');
        const rawCount = rawTypeCounts[shortType] || rawTypeCounts[type] || 0;
        assert(
          count <= rawCount,
          `parser has ${count} ${type} steps but XML has ${rawCount}`,
        );
      }
    });

    it('RelSegment/WriteRelMem sizes match XML', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lps = (st.LoadProcedures?.LoadProcedure || []) as any[];
      for (const lp of lps) {
        for (const key of ['LdCtrlRelSegment', 'LdCtrlWriteRelMem']) {
          if (!lp[key]) continue;
          const items = Array.isArray(lp[key]) ? lp[key] : [lp[key]];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const item of items as any[]) {
            const rawSize = parseInt(item['@_Size'], 10);
            if (isNaN(rawSize)) continue;
            const shortType = key.replace('LdCtrl', '');
            const ourStep = model.loadProcedures.find(
              (s: Record<string, unknown>) =>
                s.type.includes(shortType) && s.size === rawSize,
            );
            assert(
              ourStep,
              `${shortType} with size ${rawSize} not found in parser output`,
            );
          }
        }
      }
    });
  });
}

// ── Run cross-checks ────────────────────────────────────────────────────────

const { parseKnxproj, sanitizeText } = await import('../server/ets-parser.ts');
const parsed = parseKnxproj(fs.readFileSync(SMOKE_PROJECT));

crossCheckApp(
  'SAH/S8.6.7.1 cross-check',
  'smoke-test/M-0002/M-0002_A-A0C9-13-84CD.xml',
  'M-0002_A-A0C9-13-84CD',
  parsed,
);

crossCheckApp(
  'UD/S4.210.2.1 cross-check',
  'smoke-test/M-0002/M-0002_A-4A14-12-FB94-O0007.xml',
  'M-0002_A-4A14-12-FB94-O0007',
  parsed,
);

crossCheckApp(
  'US/U2.2 cross-check',
  'smoke-test/M-0002/M-0002_A-A002-13-2CF3.xml',
  'M-0002_A-A002-13-2CF3',
  parsed,
);

crossCheckApp(
  'Push-button cross-check',
  'smoke-test/M-0002/M-0002_A-0807-71-40F1-O0007.xml',
  'M-0002_A-0807-71-40F1-O0007',
  parsed,
);
