/**
 * Cross-validation tests for the LS-Touch .knxprod parser.
 *
 * These tests read the raw XML from the .knxprod ZIP independently
 * and verify our parser's output matches the source data. This catches
 * parser bugs that self-referential tests miss — the expected values
 * come from the XML, not from running our parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { XMLParser } from 'fast-xml-parser';

const KNXPROD = path.join(import.meta.dirname, '4295-LS-Touch-v5.1.knxprod');
if (!fs.existsSync(KNXPROD)) {
  describe('LS-Touch cross-check', () => {
    it('skipped — file not found', () => {});
  });
  process.exit(0);
}

// @ts-expect-error TS1470
const require_ = createRequire(import.meta.url);
const Minizip = require_('minizip-asm.js') as new (data: Buffer) => {
  list(): { filepath: string }[];
  extract(f: string): Uint8Array;
};

// ── Read raw XML from the ZIP ───────────────────────────────────────────────

const knxprodBuf = fs.readFileSync(KNXPROD);
const mz = new Minizip(knxprodBuf);
const appXmlBuf = Buffer.from(mz.extract('M-0004/M-0004_A-5017-51-218F.xml'));
const appXml = appXmlBuf.toString('utf8');

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
  'Language',
  'TranslationUnit',
  'TranslationElement',
  'Translation',
]);
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAY_TAGS.has(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const xml = xmlParser.parse(appXml) as any;
const mfr = xml.KNX.ManufacturerData.Manufacturer;
const ap = mfr.ApplicationPrograms.ApplicationProgram;
const st = ap.Static;

// Collect all raw parameters (top-level + union children)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allRawParams: any[] = [...(st.Parameters?.Parameter || [])];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const u of (st.Parameters?.Union || []) as any[]) {
  allRawParams.push(...(u.Parameter || []));
}
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

// ── Parse with our parser ───────────────────────────────────────────────────

const { parseKnxproj } = await import('../server/ets-parser.ts');
const parsed = parseKnxproj(knxprodBuf);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = parsed.paramModels['M-0004_A-5017-51-218F'] as Record<
  string,
  any
>;
const ourParams: Record<string, Record<string, unknown>> = model.params;
const ourLayout: Record<string, Record<string, unknown>> = model.paramMemLayout;

// ── Cross-validation tests ──────────────────────────────────────────────────

describe('LS-Touch cross-check: param count derivation', () => {
  it('raw XML has 3367 parameters (1201 top-level + 2166 in unions)', () => {
    const topLevel = (st.Parameters?.Parameter || []).length;
    const unions = (st.Parameters?.Union || []) as unknown[];
    let unionParams = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const u of unions) unionParams += ((u as any).Parameter || []).length;
    assert.equal(topLevel + unionParams, 3367);
  });

  it('raw XML has 3883 ParameterRefs', () => {
    assert.equal(rawRefs.length, 3883);
  });

  it('1121 ParameterRefs have no label — filtered out by parser', () => {
    let noLabel = 0;
    for (const ref of rawRefs) {
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const label = ref['@_Text'] || param['@_Text'];
      if (!label) noLabel++;
    }
    assert.equal(noLabel, 1121);
  });

  it('parser output has exactly 2762 params (3883 refs - 1121 no-label)', () => {
    assert.equal(Object.keys(ourParams).length, 2762);
  });
});

describe('LS-Touch cross-check: parameter values from XML', () => {
  it('every parser param label matches the raw XML Text attribute', () => {
    // Build translation map from XML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trans: Record<string, Record<string, string>> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const lang of (mfr.Languages?.Language || []) as any[]) {
      if (!/^en/i.test(lang['@_Identifier'] || '')) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const tu of (lang.TranslationUnit || []) as any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const te of (tu.TranslationElement || []) as any[]) {
          const refId = te['@_RefId'];
          if (!refId) continue;
          if (!trans[refId]) trans[refId] = {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const t of (te.Translation || []) as any[]) {
            if (t['@_AttributeName'] && t['@_Text'])
              trans[refId][t['@_AttributeName']] = t['@_Text'];
          }
        }
      }
    }

    let checked = 0;
    let mismatches = 0;
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!ourParams[refId]) continue; // filtered out
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;

      // Expected label: translation > ref Text > param Text
      const paramId = param['@_Id'];
      const expectedLabel =
        trans[refId]?.Text ||
        ref['@_Text'] ||
        trans[paramId]?.Text ||
        param['@_Text'] ||
        '';

      const ourLabel = ourParams[refId].label as string;
      if (expectedLabel && ourLabel !== expectedLabel) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `Label mismatch for ${refId}: expected "${expectedLabel}", got "${ourLabel}"`,
          );
        }
      }
      checked++;
    }
    assert(checked > 2000, `should check >2000 params, checked ${checked}`);
    assert.equal(mismatches, 0, `${mismatches} label mismatches`);
  });

  it('every parser param defaultValue matches the raw XML Value attribute', () => {
    let checked = 0;
    let mismatches = 0;
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!ourParams[refId]) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;

      // Default: ParameterRef Value overrides Parameter Value
      const expectedDefault = ref['@_Value'] ?? param['@_Value'] ?? '';
      const ourDefault = ourParams[refId].defaultValue as string;

      if (String(expectedDefault) !== String(ourDefault)) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `Default mismatch for ${refId}: expected "${expectedDefault}", got "${ourDefault}"`,
          );
        }
      }
      checked++;
    }
    assert(checked > 2000);
    assert.equal(mismatches, 0, `${mismatches} default value mismatches`);
  });
});

describe('LS-Touch cross-check: memory offsets from XML', () => {
  it('params with Memory child have correct offset in our layout', () => {
    let checked = 0;
    let mismatches = 0;
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      const entry = ourLayout[refId];
      if (!entry) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;

      // Non-union params: offset comes from Memory child
      const mem = Array.isArray(param.Memory) ? param.Memory[0] : param.Memory;
      if (!mem) continue; // union param or no memory mapping

      const expectedOffset = parseInt(mem['@_Offset'], 10);
      const expectedBitOffset = parseInt(mem['@_BitOffset'] || '0', 10);
      if (isNaN(expectedOffset)) continue;

      if (entry.offset !== expectedOffset) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `Offset mismatch for ${refId}: expected ${expectedOffset}, got ${entry.offset}`,
          );
        }
      }
      if (entry.bitOffset !== expectedBitOffset) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `BitOffset mismatch for ${refId}: expected ${expectedBitOffset}, got ${entry.bitOffset}`,
          );
        }
      }
      checked++;
    }
    assert(
      checked > 500,
      `should check >500 params with Memory, checked ${checked}`,
    );
    assert.equal(mismatches, 0, `${mismatches} offset mismatches`);
  });
});

describe('LS-Touch cross-check: enum types from XML', () => {
  it('enum values match raw XML TypeRestriction/Enumeration', () => {
    let checked = 0;
    let mismatches = 0;
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!ourParams[refId]) continue;
      if (ourParams[refId].typeKind !== 'enum') continue;

      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const typeId = param['@_ParameterType'];
      const rawType = rawTypeById[typeId];
      if (!rawType?.TypeRestriction?.Enumeration) continue;

      const rawEnums = rawType.TypeRestriction.Enumeration;
      const ourEnums = ourParams[refId].enums as Record<string, string>;

      // Check count
      if (Object.keys(ourEnums).length !== rawEnums.length) {
        mismatches++;
        if (mismatches <= 3) {
          assert.fail(
            `Enum count mismatch for ${refId}: XML has ${rawEnums.length}, we have ${Object.keys(ourEnums).length}`,
          );
        }
      }

      // Check values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of rawEnums as any[]) {
        const val = e['@_Value'];
        const text = e['@_Text'] || '';
        if (val !== undefined && text && ourEnums[val] !== text) {
          // Might be translated — skip if text is empty in XML
          mismatches++;
          if (mismatches <= 3) {
            assert.fail(
              `Enum value mismatch for ${refId} val=${val}: XML="${text}", ours="${ourEnums[val]}"`,
            );
          }
        }
      }
      checked++;
    }
    assert(checked > 100, `should check >100 enum params, checked ${checked}`);
    assert.equal(mismatches, 0, `${mismatches} enum mismatches`);
  });
});

describe('LS-Touch cross-check: parameter type sizes from XML', () => {
  it('bitSize matches raw XML SizeInBit for all typed params', () => {
    let checked = 0;
    let mismatches = 0;
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      const entry = ourLayout[refId];
      if (!entry) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const typeId = param['@_ParameterType'];
      const rawType = rawTypeById[typeId];
      if (!rawType) continue;

      // Extract SizeInBit from whichever type child exists
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
        if (mismatches <= 3) {
          assert.fail(
            `SizeInBit mismatch for ${refId}: XML=${expectedSize}, ours=${entry.bitSize}`,
          );
        }
      }
      checked++;
    }
    assert(checked > 1000, `should check >1000 params, checked ${checked}`);
    assert.equal(mismatches, 0, `${mismatches} bitSize mismatches`);
  });
});

describe('LS-Touch cross-check: load procedures from XML', () => {
  it('load procedure steps match raw XML', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lps = (st.LoadProcedures?.LoadProcedure || []) as any[];
    // Flatten all LdCtrl* elements from all LoadProcedure elements
    const rawSteps: Array<{
      type: string;
      objIdx?: number;
      propId?: number;
      size?: number;
    }> = [];
    for (const lp of lps) {
      for (const key of Object.keys(lp)) {
        if (!key.startsWith('LdCtrl')) continue;
        const items = Array.isArray(lp[key]) ? lp[key] : [lp[key]];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of items as any[]) {
          const type = key.replace('LdCtrl', '');
          rawSteps.push({
            type,
            objIdx:
              item['@_ObjIdx'] !== undefined
                ? parseInt(item['@_ObjIdx'], 10)
                : undefined,
            propId:
              item['@_PropId'] !== undefined
                ? parseInt(item['@_PropId'], 10)
                : undefined,
            size:
              item['@_Size'] !== undefined
                ? parseInt(item['@_Size'], 10)
                : undefined,
          });
        }
      }
    }

    assert.equal(
      model.loadProcedures.length,
      rawSteps.length,
      `step count: parser=${model.loadProcedures.length}, xml=${rawSteps.length}`,
    );

    for (let i = 0; i < rawSteps.length; i++) {
      const raw = rawSteps[i]!;
      const ours = model.loadProcedures[i]!;
      // Our type names include the full prefix (e.g. "CompareProp" not just "CompareProp")
      assert(
        ours.type.includes(raw.type),
        `step ${i} type: ours="${ours.type}", xml="${raw.type}"`,
      );
      if (raw.size !== undefined) {
        assert.equal(ours.size, raw.size, `step ${i} size`);
      }
    }
  });
});
