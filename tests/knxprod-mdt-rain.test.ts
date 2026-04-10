/**
 * Tests for parsing the MDT Rain Sensor .knxprod file.
 * Small device with 9 enum params, AbsoluteSegment load procedures,
 * and a simple dynamic tree — good for exhaustive verification.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { XMLParser } from 'fast-xml-parser';

const KNXPROD = path.join(
  import.meta.dirname,
  'MDT_KP_SCN_01_Rain_Sensor_V11.knxprod',
);
if (!fs.existsSync(KNXPROD)) {
  describe('MDT Rain Sensor', () => {
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

const { parseKnxproj, sanitizeText } = await import('../server/ets-parser.ts');
const knxprodBuf = fs.readFileSync(KNXPROD);
const parsed = parseKnxproj(knxprodBuf);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = parsed.paramModels['M-0083_A-004F-11-8F33'] as Record<
  string,
  any
>;
const params: Record<string, Record<string, unknown>> = model.params;
const layout: Record<string, Record<string, unknown>> = model.paramMemLayout;

// ── Raw XML for cross-validation ────────────────────────────────────────────

const mz = new Minizip(knxprodBuf);
const appXml = Buffer.from(
  mz.extract('M-0083/M-0083_A-004F-11-8F33.xml'),
).toString('utf8');

const ARRAY_TAGS = new Set([
  'Parameter',
  'ParameterType',
  'ParameterRef',
  'Enumeration',
  'Union',
  'LoadProcedure',
  'LdCtrlCompareProp',
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
const xml = rawParser.parse(appXml) as any;
const mfr = xml.KNX.ManufacturerData.Manufacturer;
const ap = mfr.ApplicationPrograms.ApplicationProgram;
const st = ap.Static;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawRefs = (st.ParameterRefs?.ParameterRef || []) as any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allRawParams: any[] = [...(st.Parameters?.Parameter || [])];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const u of (st.Parameters?.Union || []) as any[])
  allRawParams.push(...(u.Parameter || []));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawParamById: Record<string, any> = {};
for (const p of allRawParams) rawParamById[p['@_Id']] = p;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawTypeById: Record<string, any> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const t of (st.ParameterTypes?.ParameterType || []) as any[])
  rawTypeById[t['@_Id']] = t;

// ── Catalog ─────────────────────────────────────────────────────────────────

describe('MDT Rain Sensor: catalog', () => {
  it('extracts 2 sections and 1 item', () => {
    assert.equal(parsed.catalogSections.length, 2);
    assert.equal(parsed.catalogItems.length, 1);
  });

  it('sections are Weather sensors and Rain sensor from MDT', () => {
    const names = parsed.catalogSections
      .map((s: Record<string, unknown>) => s.name)
      .sort();
    assert.deepEqual(names, ['Rain sensor', 'Weather sensors']);
    for (const s of parsed.catalogSections) {
      assert.equal(s.manufacturer, 'MDT technologies');
      assert.equal(s.mfr_id, 'M-0083');
    }
  });

  it('item is SCN-RS1R.01 with 10mA bus current', () => {
    const item = parsed.catalogItems[0]!;
    assert.equal(item.name, 'SCN-RS1R.01 Rain sensor');
    assert.equal(item.order_number, 'SCN-RS1R.01');
    assert.equal(item.bus_current, 10);
    assert.equal(item.manufacturer, 'MDT technologies');
  });
});

// ── Parameter model ─────────────────────────────────────────────────────────

describe('MDT Rain Sensor: params', () => {
  it('has exactly 9 parameters, all enums', () => {
    assert.equal(Object.keys(params).length, 9);
    for (const p of Object.values(params)) {
      assert.equal(p.typeKind, 'enum', `${p.label} should be enum`);
    }
  });

  it('all params are in "Rain sensor" section', () => {
    for (const p of Object.values(params)) {
      assert.equal(p.section, 'Rain sensor');
    }
  });

  it('every param has matching layout entry', () => {
    for (const key of Object.keys(params)) {
      assert(layout[key], `${key} missing from layout`);
    }
  });
});

// ── Exhaustive param verification ───────────────────────────────────────────

describe('MDT Rain Sensor: exhaustive param check', () => {
  const EXPECTED = [
    {
      label: 'Startup timeout',
      default: '1',
      offset: 68,
      bits: 16,
      enumCount: 61,
    },
    {
      label: 'cyclic send "Operating" telegram',
      default: '0',
      offset: 70,
      bits: 8,
      enumCount: 8,
    },
    {
      label: 'Send object rain',
      default: '2',
      offset: 71,
      bits: 8,
      enumCount: 4,
    },
    {
      label: 'Sensitivity of rain sensor',
      default: '50',
      offset: 73,
      bits: 8,
      enumCount: 3,
    },
    {
      label: 'Info object for heating is active',
      default: '0',
      offset: 74,
      bits: 8,
      enumCount: 2,
    },
    {
      label: 'Delay for message rain ON',
      default: '20',
      offset: 75,
      bits: 8,
      enumCount: 12,
    },
    {
      label: 'Delay for message rain OFF',
      default: '30',
      offset: 76,
      bits: 8,
      enumCount: 9,
    },
  ];

  for (const exp of EXPECTED) {
    it(`"${exp.label}" has correct default, offset, and enum count`, () => {
      const p = Object.values(params).find((p) => p.label === exp.label);
      assert(p, `param "${exp.label}" not found`);
      assert.equal(p.defaultValue, exp.default, 'defaultValue');
      assert.equal(p.offset, exp.offset, 'offset');
      assert.equal(p.bitSize, exp.bits, 'bitSize');
      assert.equal(
        Object.keys(p.enums as Record<string, string>).length,
        exp.enumCount,
        'enum count',
      );
    });
  }

  it('"Sensitivity of rain sensor" has correct enum values', () => {
    const p = Object.values(params).find(
      (p) => p.label === 'Sensitivity of rain sensor',
    )!;
    const enums = p.enums as Record<string, string>;
    assert.equal(enums['25'], 'very high');
    assert.equal(enums['50'], 'high');
    assert.equal(enums['100'], 'low');
  });

  it('"Send object rain" has correct enum values', () => {
    const p = Object.values(params).find(
      (p) => p.label === 'Send object rain',
    )!;
    const enums = p.enums as Record<string, string>;
    assert.equal(enums['1'], 'only request');
    assert.equal(enums['2'], 'at changes');
    assert.equal(enums['4'], 'cyclic');
    assert.equal(enums['6'], 'at changes and cyclic');
  });
});

// ── Load procedures (AbsoluteSegment device) ────────────────────────────────

describe('MDT Rain Sensor: load procedures', () => {
  it('has 6 load procedures', () => {
    assert.equal(model.loadProcedures.length, 6);
  });

  it('uses CompareProp and AbsSegment (not RelSegment)', () => {
    const types = model.loadProcedures.map(
      (lp: Record<string, unknown>) => lp.type,
    );
    assert(types.includes('CompareProp'));
    assert(types.includes('AbsSegment'));
    assert(!types.includes('RelSegment'), 'should NOT have RelSegment');
    assert(!types.includes('WriteRelMem'), 'should NOT have WriteRelMem');
  });

  it('extracts CompareProp and AbsSegment steps from raw XML', () => {
    // This device uses ProductProcedure-style load procedures with
    // Connect/Unload/Load/TaskSegment/LoadCompleted/Restart/Disconnect
    // steps that our parser doesn't handle yet (TODO: AbsoluteSegment
    // devices). We only extract the CompareProp and AbsSegment steps.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lps = (st.LoadProcedures?.LoadProcedure || []) as any[];
    const rawSupported: string[] = [];
    for (const lp of lps) {
      for (const key of ['LdCtrlCompareProp', 'LdCtrlAbsSegment']) {
        if (!lp[key]) continue;
        const items = Array.isArray(lp[key]) ? lp[key] : [lp[key]];
        for (const _item of items) rawSupported.push(key.replace('LdCtrl', ''));
      }
    }
    assert.equal(model.loadProcedures.length, rawSupported.length);
    for (let i = 0; i < rawSupported.length; i++) {
      assert(
        model.loadProcedures[i].type.includes(rawSupported[i]!),
        `step ${i}: ours="${model.loadProcedures[i].type}" xml="${rawSupported[i]}"`,
      );
    }
  });
});

// ── Cross-validation against raw XML ────────────────────────────────────────

describe('MDT Rain Sensor: cross-validation', () => {
  it('every label matches raw XML (after sanitization)', () => {
    // Build translation map
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

    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!params[refId]) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const rawLabel =
        trans[refId]?.Text ||
        ref['@_Text'] ||
        trans[param['@_Id']]?.Text ||
        param['@_Text'] ||
        '';
      const expected = sanitizeText(rawLabel);
      const ours = params[refId].label as string;
      assert.equal(ours, expected, `label for ${refId}`);
    }
  });

  it('every default value matches raw XML', () => {
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!params[refId]) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const expected = ref['@_Value'] ?? param['@_Value'] ?? '';
      assert.equal(
        String(params[refId].defaultValue),
        String(expected),
        `default for ${refId}`,
      );
    }
  });

  it('every enum matches raw XML TypeRestriction', () => {
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      if (!params[refId] || params[refId].typeKind !== 'enum') continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const rawType = rawTypeById[param['@_ParameterType']];
      if (!rawType?.TypeRestriction?.Enumeration) continue;
      const rawEnums = rawType.TypeRestriction.Enumeration;
      const ourEnums = params[refId].enums as Record<string, string>;
      assert.equal(
        Object.keys(ourEnums).length,
        rawEnums.length,
        `enum count for ${refId}`,
      );
    }
  });

  it('every bitSize matches raw XML SizeInBit', () => {
    for (const ref of rawRefs) {
      const refId = ref['@_Id'];
      const entry = layout[refId];
      if (!entry) continue;
      const param = rawParamById[ref['@_RefId']];
      if (!param) continue;
      const rawType = rawTypeById[param['@_ParameterType']];
      if (!rawType?.TypeRestriction) continue;
      const expected = parseInt(rawType.TypeRestriction['@_SizeInBit'], 10);
      if (isNaN(expected)) continue;
      assert.equal(entry.bitSize, expected, `bitSize for ${refId}`);
    }
  });
});
