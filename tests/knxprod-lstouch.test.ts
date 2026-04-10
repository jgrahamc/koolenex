/**
 * Tests for parsing the Albrecht Jung LS-Touch .knxprod file.
 * Verifies catalog extraction, parameter model, translations,
 * dynamic tree, load procedures, and conditional visibility.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const KNXPROD = path.join(import.meta.dirname, '4295-LS-Touch-v5.1.knxprod');
if (!fs.existsSync(KNXPROD)) {
  describe('LS-Touch .knxprod', () => {
    it('skipped — 4295-LS-Touch-v5.1.knxprod not found', () => {});
  });
  process.exit(0);
}

const { parseKnxproj } = await import('../server/ets-parser.ts');
const parsed = parseKnxproj(fs.readFileSync(KNXPROD));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const model = parsed.paramModels['M-0004_A-5017-51-218F'] as Record<
  string,
  any
>;
const params: Record<string, Record<string, unknown>> = model.params;
const layout: Record<string, Record<string, unknown>> = model.paramMemLayout;

// ── Catalog ─────────────────────────────────────────────────────────────────

describe('LS-Touch: catalog', () => {
  it('extracts 1 section and 1 item', () => {
    assert.equal(parsed.catalogSections.length, 1);
    assert.equal(parsed.catalogItems.length, 1);
  });

  it('section is "Display device" from Albrecht Jung', () => {
    const sec = parsed.catalogSections[0]!;
    assert.equal(sec.name, 'Display device');
    assert.equal(sec.number, 'DI');
    assert.equal(sec.manufacturer, 'Albrecht Jung');
    assert.equal(sec.mfr_id, 'M-0004');
    assert.equal(sec.parent_id, null);
  });

  it('item is "LS-Touch" with 60mA bus current', () => {
    const item = parsed.catalogItems[0]!;
    assert.equal(item.name, 'LS-Touch');
    assert.equal(item.manufacturer, 'Albrecht Jung');
    assert.equal(item.order_number, '..459D1S..');
    assert.equal(item.bus_current, 60);
    assert.equal(item.is_power_supply, false);
    assert.equal(item.is_coupler, false);
  });
});

// ── Parameter model structure ───────────────────────────────────────────────

describe('LS-Touch: parameter model', () => {
  it('model exists', () => {
    assert(model, 'param model should exist');
  });

  it('has 2762 parameters', () => {
    assert.equal(Object.keys(params).length, 2762);
  });

  it('has 3194 paramMemLayout entries', () => {
    assert.equal(Object.keys(layout).length, 3194);
  });

  it('every param has a label, typeKind, and defaultValue', () => {
    for (const [key, p] of Object.entries(params)) {
      assert(typeof p.label === 'string', `${key} missing label`);
      assert(typeof p.typeKind === 'string', `${key} missing typeKind`);
      assert('defaultValue' in p, `${key} missing defaultValue`);
    }
  });

  it('type distribution matches expected counts', () => {
    const kinds: Record<string, number> = {};
    for (const p of Object.values(params)) {
      const k = p.typeKind as string;
      kinds[k] = (kinds[k] || 0) + 1;
    }
    assert.equal(kinds['enum'], 848, 'enum count');
    assert.equal(kinds['checkbox'], 552, 'checkbox count');
    assert.equal(kinds['number'], 919, 'number count');
    assert.equal(kinds['text'], 230, 'text count');
    assert.equal(kinds['float'], 199, 'float count');
    assert.equal(kinds['other'], 14, 'other count');
  });

  it('every paramMemLayout entry has offset, bitOffset, bitSize, defaultValue', () => {
    for (const [key, entry] of Object.entries(layout)) {
      assert(typeof entry.offset === 'number', `${key} missing offset`);
      assert(typeof entry.bitOffset === 'number', `${key} missing bitOffset`);
      assert(typeof entry.bitSize === 'number', `${key} missing bitSize`);
      assert('defaultValue' in entry, `${key} missing defaultValue`);
    }
  });

  it('all visible params have matching layout entries', () => {
    for (const [key, p] of Object.entries(params)) {
      if (p.offset === null) continue; // no memory mapping
      const entry = layout[key];
      assert(entry, `param ${key} (${p.label}) has no layout entry`);
      assert.equal(entry.offset, p.offset, `offset mismatch for ${key}`);
      assert.equal(
        entry.bitOffset,
        p.bitOffset,
        `bitOffset mismatch for ${key}`,
      );
    }
  });
});

// ── Load procedures ─────────────────────────────────────────────────────────

describe('LS-Touch: load procedures', () => {
  it('has 6 load procedures', () => {
    assert.equal(model.loadProcedures.length, 6);
  });

  it('procedure types in correct order', () => {
    const types = model.loadProcedures.map(
      (lp: Record<string, unknown>) => lp.type,
    );
    assert.deepEqual(types, [
      'CompareProp',
      'CompareProp',
      'CompareProp',
      'RelSegment',
      'RelSegment',
      'WriteRelMem',
    ]);
  });

  it('WriteRelMem step targets 8178 bytes', () => {
    const wrm = model.loadProcedures.find(
      (lp: Record<string, unknown>) => lp.type === 'WriteRelMem',
    );
    assert.equal(wrm.size, 8178);
  });

  it('RelSegment steps also specify 8178 bytes', () => {
    const segs = model.loadProcedures.filter(
      (lp: Record<string, unknown>) => lp.type === 'RelSegment',
    );
    assert.equal(segs.length, 2);
    for (const s of segs) {
      assert.equal(s.size, 8178, 'RelSegment size');
    }
  });
});

// ── Specific parameters: enums ──────────────────────────────────────────────

describe('LS-Touch: enum parameters', () => {
  it('"Device language" has 9 translated language options', () => {
    const p = params['M-0004_A-5017-51-218F_P-1_R-1'];
    assert(p, 'param should exist');
    assert.equal(p.label, 'Device language');
    assert.equal(p.section, 'General');
    assert.equal(p.typeKind, 'enum');
    assert.equal(p.defaultValue, '0');
    const enums = p.enums as Record<string, string>;
    assert.equal(Object.keys(enums).length, 9);
    assert.equal(enums['0'], 'German');
    assert.equal(enums['1'], 'English');
    assert.equal(enums['2'], 'Spanish');
    assert.equal(enums['3'], 'French');
    assert.equal(enums['4'], 'Russian');
    assert.equal(enums['5'], 'Dutch');
    assert.equal(enums['6'], 'Italian');
    assert.equal(enums['7'], 'Chinese');
    assert.equal(enums['8'], 'Korean');
  });

  it('"Device language" has correct memory layout (offset 55, 8-bit)', () => {
    const p = params['M-0004_A-5017-51-218F_P-1_R-1'];
    assert.equal(p.offset, 55);
    assert.equal(p.bitOffset, 0);
    assert.equal(p.bitSize, 8);
  });
});

// ── Specific parameters: checkbox ───────────────────────────────────────────

describe('LS-Touch: checkbox parameters', () => {
  it('"Screen saver" is a checkbox with default enabled', () => {
    const p = params['M-0004_A-5017-51-218F_P-2_R-2'];
    assert(p, 'param should exist');
    assert.equal(p.label, 'Screen saver');
    assert.equal(p.typeKind, 'checkbox');
    assert.equal(p.defaultValue, '1');
  });
});

// ── Specific parameters: number ─────────────────────────────────────────────

describe('LS-Touch: number parameters', () => {
  it('"Send time cyclically" has min 0, max 60, default 10', () => {
    const p = params['M-0004_A-5017-51-218F_P-371_R-371'];
    assert(p, 'param should exist');
    assert.equal(p.label, 'Send time cyclically');
    assert.equal(p.typeKind, 'number');
    assert.equal(p.min, 0);
    assert.equal(p.max, 60);
    assert.equal(p.defaultValue, '10');
  });

  it('all number params have min and max defined', () => {
    for (const [key, p] of Object.entries(params)) {
      if (p.typeKind !== 'number') continue;
      assert(
        p.min !== undefined && p.min !== null,
        `${key} (${p.label}) missing min`,
      );
      assert(
        p.max !== undefined && p.max !== null,
        `${key} (${p.label}) missing max`,
      );
    }
  });
});

// ── Sections ────────────────────────────────────────────────────────────────

describe('LS-Touch: sections', () => {
  const allSections = new Set(
    Object.values(params).map((p) => p.section as string),
  );

  it('has expected high-level sections', () => {
    for (const expected of [
      'General',
      'Display',
      'Image',
      'Menu',
      'Tones',
      'Areas',
      'Favourites',
      'Password protection',
      'Temperature measurement',
      'Channel functions',
      'Logic functions',
      'Timer switches',
      'Warnings',
      'Controller extensions',
      'Split units',
    ]) {
      assert(allSections.has(expected), `missing section "${expected}"`);
    }
  });

  it('has RTR sections with template patterns', () => {
    const rtrSections = [...allSections].filter((s) => s.startsWith('RTR'));
    assert(
      rtrSections.length >= 3,
      `expected RTR sections, got ${rtrSections.length}`,
    );
    assert(
      rtrSections.some((s) => s.includes('Setpoint values')),
      'should have RTR setpoint section',
    );
    assert(
      rtrSections.some((s) => s.includes('Fan control')),
      'should have RTR fan control section',
    );
    assert(
      rtrSections.some((s) => s.includes('Controller functionality')),
      'should have RTR controller section',
    );
  });

  it('"QR code" params are in Image section', () => {
    const qrParams = Object.values(params).filter((p) => p.label === 'QR code');
    assert(qrParams.length >= 3, `expected at least 3 QR code params`);
    for (const p of qrParams) {
      assert.equal(p.section, 'Image', `QR code should be in Image section`);
    }
  });
});

// ── Dynamic tree ────────────────────────────────────────────────────────────

describe('LS-Touch: dynamic tree', () => {
  it('has a main dynamic tree with items', () => {
    assert(model.dynTree?.main?.items?.length > 0);
  });

  it('has no module definitions', () => {
    assert.equal(model.dynTree.moduleDefs.length, 0);
  });

  it('top-level item is a ChannelIndependentBlock', () => {
    assert.equal(model.dynTree.main.items[0].type, 'cib');
  });

  it('dynamic tree contains choose/when conditionals', () => {
    function countChooses(items: Record<string, unknown>[]): number {
      let count = 0;
      for (const item of items || []) {
        if (item.type === 'choose') count++;
        const children = item.items as Record<string, unknown>[] | undefined;
        if (children) count += countChooses(children);
        const whens = item.whens as Record<string, unknown>[] | undefined;
        if (whens)
          for (const w of whens) {
            const wi = w.items as Record<string, unknown>[] | undefined;
            if (wi) count += countChooses(wi);
          }
      }
      return count;
    }
    const total = countChooses(model.dynTree.main.items);
    assert.equal(total, 1472, 'conditional count');
  });

  it('dynamic tree contains paramRef items', () => {
    function countRefs(items: Record<string, unknown>[]): number {
      let count = 0;
      for (const item of items || []) {
        if (item.type === 'paramRef') count++;
        const children = item.items as Record<string, unknown>[] | undefined;
        if (children) count += countRefs(children);
        const whens = item.whens as Record<string, unknown>[] | undefined;
        if (whens)
          for (const w of whens) {
            const wi = w.items as Record<string, unknown>[] | undefined;
            if (wi) count += countRefs(wi);
          }
      }
      return count;
    }
    const total = countRefs(model.dynTree.main.items);
    assert(total > 2000, `expected >2000 paramRefs, got ${total}`);
  });
});

// ── Memory layout consistency ───────────────────────────────────────────────

describe('LS-Touch: memory layout', () => {
  it('no param has offset beyond WriteRelMem size', () => {
    const maxOffset = 8178;
    for (const [key, entry] of Object.entries(layout)) {
      const off = entry.offset as number;
      const bits = entry.bitSize as number;
      const end = off + Math.ceil(bits / 8);
      assert(
        end <= maxOffset,
        `${key} extends to byte ${end}, beyond memory size ${maxOffset}`,
      );
    }
  });

  it('all offsets are non-negative', () => {
    for (const [key, entry] of Object.entries(layout)) {
      assert(
        (entry.offset as number) >= 0,
        `${key} has negative offset ${entry.offset}`,
      );
    }
  });

  it('bitOffset is always 0-7', () => {
    for (const [key, entry] of Object.entries(layout)) {
      const bo = entry.bitOffset as number;
      assert(bo >= 0 && bo <= 7, `${key} has bitOffset ${bo}, expected 0-7`);
    }
  });

  it('bitSize is reasonable (1-256)', () => {
    for (const [key, entry] of Object.entries(layout)) {
      const bs = entry.bitSize as number;
      assert(bs >= 1 && bs <= 256, `${key} has bitSize ${bs}`);
    }
  });
});
