/**
 * Tests for parsing the Albrecht Jung LS-Touch .knxprod file.
 * Verifies catalog extraction, parameter model, translations,
 * dynamic tree, and load procedures.
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

// ── Parameter model ─────────────────────────────────────────────────────────

const model = parsed.paramModels['M-0004_A-5017-51-218F'] as Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

describe('LS-Touch: parameter model', () => {
  it('model exists', () => {
    assert(model, 'param model for M-0004_A-5017-51-218F should exist');
  });

  it('has 2762 parameters', () => {
    assert.equal(Object.keys(model.params).length, 2762);
  });

  it('has 3194 paramMemLayout entries', () => {
    assert.equal(Object.keys(model.paramMemLayout).length, 3194);
  });

  it('has 6 load procedures', () => {
    assert.equal(model.loadProcedures.length, 6);
  });

  it('load procedures include CompareProp and WriteRelMem', () => {
    const types = model.loadProcedures.map(
      (lp: Record<string, unknown>) => lp.type,
    );
    assert(types.includes('CompareProp'), 'should have CompareProp');
    assert(types.includes('RelSegment'), 'should have RelSegment');
    assert(types.includes('WriteRelMem'), 'should have WriteRelMem');
  });

  it('WriteRelMem step has size 8178', () => {
    const wrm = model.loadProcedures.find(
      (lp: Record<string, unknown>) => lp.type === 'WriteRelMem',
    );
    assert(wrm, 'WriteRelMem step should exist');
    assert.equal(wrm.size, 8178);
  });
});

// ── Specific parameters ─────────────────────────────────────────────────────

describe('LS-Touch: parameter details', () => {
  it('"Device language" is an enum with 9 languages', () => {
    const p = model.params['M-0004_A-5017-51-218F_P-1_R-1'];
    assert(p, 'Device language param should exist');
    assert.equal(p.label, 'Device language');
    assert.equal(p.section, 'General');
    assert.equal(p.typeKind, 'enum');
    assert.equal(p.defaultValue, '0');

    const enums = p.enums;
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

  it('"Device language" has correct memory layout', () => {
    const p = model.params['M-0004_A-5017-51-218F_P-1_R-1'];
    assert.equal(p.offset, 55);
    assert.equal(p.bitOffset, 0);
    assert.equal(p.bitSize, 8);
  });

  it('"Screen saver" is a checkbox', () => {
    const p = model.params['M-0004_A-5017-51-218F_P-2_R-2'];
    assert(p, 'Screen saver param should exist');
    assert.equal(p.label, 'Screen saver');
    assert.equal(p.typeKind, 'checkbox');
    assert.equal(p.defaultValue, '1');
  });

  it('"QR code" params exist in Image section', () => {
    const qrKeys = Object.keys(model.params).filter(
      (k) => model.params[k].label === 'QR code',
    );
    assert(
      qrKeys.length >= 3,
      `should have at least 3 QR code params, got ${qrKeys.length}`,
    );
    for (const k of qrKeys) {
      assert.equal(model.params[k].section, 'Image');
    }
  });
});

// ── Dynamic tree ────────────────────────────────────────────────────────────

describe('LS-Touch: dynamic tree', () => {
  it('has a main dynamic tree', () => {
    assert(model.dynTree, 'dynTree should exist');
    assert(model.dynTree.main, 'dynTree.main should exist');
    assert(
      model.dynTree.main.items.length > 0,
      'dynTree.main should have items',
    );
  });

  it('has no module definitions (not a modular device)', () => {
    assert.equal(
      model.dynTree.moduleDefs.length,
      0,
      'should have no module defs',
    );
  });
});

// ── paramMemLayout ──────────────────────────────────────────────────────────

describe('LS-Touch: paramMemLayout', () => {
  it('"Device language" has matching layout entry', () => {
    const layout = model.paramMemLayout['M-0004_A-5017-51-218F_P-1_R-1'];
    assert(layout, 'layout entry should exist');
    assert.equal(layout.offset, 55);
    assert.equal(layout.bitOffset, 0);
    assert.equal(layout.bitSize, 8);
    assert.equal(layout.defaultValue, '0');
    assert.equal(layout.isVisible, true);
  });
});
