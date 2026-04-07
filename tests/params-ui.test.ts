/**
 * Tests that the parameter UI structure for device 1.1.2 (SAH/S8.6.7.1)
 * matches the expected section layout. This catches regressions in the
 * Dynamic section parser, ordered tree serialization, Rename handling,
 * conditional visibility, Access=None block handling, and separator/table
 * layout preservation.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.2', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  process.exit(0);
}

const { parseKnxproj } = await import('../server/ets-parser.ts');

// ── Helpers (replicate client logic) ─────────────────────────────────────────

function etsTestMatch(val: string, tests: any[]) {
  const n = parseFloat(val);
  for (const t of tests || []) {
    const rm =
      typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]);
      const op = rm[1];
      if (op === '<' && n < rv) return true;
      if (op === '>' && n > rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '=' && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) return true;
  }
  return false;
}

function buildParamUI(model: any) {
  const { params, dynTree } = model;
  const values: Record<string, any> = {};
  for (const [k, v] of Object.entries(model.currentValues || {})) values[k] = v;
  const getVal = (prKey: string) =>
    values[prKey] ?? params[prKey]?.defaultValue ?? '';

  // Phase 1: determine active params
  const active = new Set<string>();
  function evalChoiceActive(c: any) {
    if (c.paramRefId && !c.accessNone && !active.has(c.paramRefId)) return;
    const raw = getVal(c.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (c.defaultValue ?? ''),
    );
    let matched = false,
      defItems: any = null;
    for (const w of c.whens || []) {
      if (w.isDefault) {
        defItems = w.items;
        continue;
      }
      if (etsTestMatch(val, w.test)) {
        matched = true;
        walkActive(w.items);
      }
    }
    if (!matched && defItems) walkActive(defItems);
  }
  function walkActive(items: any[]) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') active.add(item.refId);
      else if (
        item.type === 'block' ||
        item.type === 'channel' ||
        item.type === 'cib'
      )
        walkActive(item.items);
      else if (item.type === 'choose') evalChoiceActive(item);
    }
  }
  walkActive(dynTree?.main?.items);

  // Phase 2: build sections
  const sections: string[] = [];
  const secMap: Record<string, any[]> = {};
  const blockRenames: Record<string, string> = {};

  function collectRenames(items: any[]) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'rename' && item.refId && item.text)
        blockRenames[item.refId] = item.text;
      else if (item.type === 'choose') {
        if (item.paramRefId && !item.accessNone && !active.has(item.paramRefId))
          continue;
        const raw = getVal(item.paramRefId);
        const val = String(
          raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
        );
        let matched = false,
          defItems: any = null;
        for (const w of item.whens || []) {
          if (w.isDefault) {
            defItems = w.items;
            continue;
          }
          if (etsTestMatch(val, w.test)) {
            matched = true;
            collectRenames(w.items);
          }
        }
        if (!matched && defItems) collectRenames(defItems);
      } else if (item.items) collectRenames(item.items);
    }
  }

  function addItem(sec: string, label: string, type?: string) {
    if (!secMap[sec]) {
      secMap[sec] = [];
      sections.push(sec);
    }
    secMap[sec].push({ label, type: type || 'param' });
  }

  function evalChooseUI(item: any, secLabel: string, walkFn: Function) {
    if (item.paramRefId && !item.accessNone && !active.has(item.paramRefId))
      return;
    const raw = getVal(item.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
    );
    let matched = false,
      defItems: any = null;
    for (const w of item.whens || []) {
      if (w.isDefault) {
        defItems = w.items;
        continue;
      }
      if (etsTestMatch(val, w.test)) {
        matched = true;
        walkFn(w.items, secLabel);
      }
    }
    if (!matched && defItems) walkFn(defItems, secLabel);
  }

  function walkItems(items: any[], secLabel: string) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') {
        if (!params[item.refId] || !active.has(item.refId)) continue;
        addItem(
          secLabel,
          params[item.refId].label,
          item.cell ? 'cell:' + item.cell : 'param',
        );
      } else if (item.type === 'separator') {
        addItem(secLabel, item.text || '', 'sep:' + item.uiHint);
      } else if (item.type === 'block') {
        collectRenames(item.items);
        if (item.access === 'None') {
          /* hidden */
        } else if (item.inline) walkItems(item.items, secLabel);
        else {
          const renamed = item.id ? blockRenames[item.id] : null;
          const blockLabel = renamed || item.text || item.name || secLabel;
          walkItems(item.items, blockLabel);
        }
      } else if (item.type === 'choose') {
        evalChooseUI(item, secLabel, walkItems);
      } else if (item.type === 'channel') {
        collectRenames(item.items);
        walkChannelItems(item.items, item.label);
      } else if (item.type === 'cib') {
        walkItems(item.items, '');
      }
    }
  }

  function walkChannelItems(items: any[], chLabel: string) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'block' && item.access === 'None') {
        collectRenames(item.items);
      } else if (item.type === 'block' && !item.inline) {
        collectRenames(item.items);
        const renamed = item.id ? blockRenames[item.id] : null;
        const blockLabel = renamed || item.text || item.name || chLabel;
        walkItems(item.items, blockLabel);
      } else if (item.type === 'choose') {
        evalChooseUI(item, chLabel, walkChannelItems);
      }
    }
  }

  walkItems(dynTree?.main?.items, '');

  return { sections, secMap };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let parsed: any, model: any, ui: any;

before(() => {
  const buf = fs.readFileSync(SMOKE_PROJECT);
  parsed = parseKnxproj(buf);
  const dev = parsed.devices.find((d: any) => d.individual_address === '1.1.2');
  model = parsed.paramModels[dev.app_ref];
  ui = buildParamUI(model);
});

describe('Params UI: 1.1.2 (SAH/S8.6.7.1)', () => {
  it('has exactly the expected sections in the correct order', () => {
    assert.deepEqual(ui.sections, [
      'Configuration',
      'Device settings',
      'Manual operation',
      'Safety/Weather alarms',
      'Logic/Threshold 1',
      'Logic/Threshold 2',
      'Logic/Threshold 3',
      'Logic/Threshold 4',
      'Logic/Threshold 5',
      'Logic/Threshold 6',
      'Logic/Threshold 7',
      'Logic/Threshold 8',
      'Basic settings',
      'Safety',
      'Load shedding',
      'Delay for switching on and off',
      'Staircase lighting',
      'Flashing',
      'Scene assignments',
      'Drive',
      'Blind/Shutter',
      'Automatic sun protection',
      'Status Messages',
      'Shutter Actuator functions',
    ]);
  });

  it('does NOT have phantom sections', () => {
    const bad = [
      'Par_TableApplications',
      'Common parameter',
      'Channel parameter',
      'Switch Actuator functions',
      'Shutter Actuator A+B',
    ];
    for (const name of bad) {
      assert(!ui.sections.includes(name), `"${name}" should not be a section`);
    }
  });

  it('Configuration starts with firmware info box', () => {
    const items = ui.secMap['Configuration'];
    assert(items.length > 0);
    assert.equal(items[0].type, 'sep:Information');
    assert(items[0].label.includes('Firmware V0.2.0'));
  });

  it('Configuration has Channel configuration headline and table cells', () => {
    const items = ui.secMap['Configuration'];
    const headline = items.find(
      (i: any) =>
        i.type === 'sep:Headline' && i.label === 'Channel configuration',
    );
    assert(headline, 'should have Channel configuration headline');
    const cells = items.filter((i: any) => i.type.startsWith('cell:'));
    assert(cells.length === 8, `expected 8 table cells, got ${cells.length}`);
    // 4 enable cells (col 1) and 4 application cells (col 2)
    const col1 = cells.filter((i: any) => i.type.endsWith(',1'));
    const col2 = cells.filter((i: any) => i.type.endsWith(',2'));
    assert.equal(col1.length, 4);
    assert.equal(col2.length, 4);
  });

  it('Configuration has Enable Logic/Threshold headline after ruler', () => {
    const items = ui.secMap['Configuration'];
    const rulerIdx = items.findIndex(
      (i: any) => i.type === 'sep:HorizontalRuler',
    );
    assert(rulerIdx > -1, 'should have a HorizontalRuler');
    const headlineIdx = items.findIndex(
      (i: any) =>
        i.type === 'sep:Headline' && i.label === 'Enable Logic/Threshold',
    );
    assert(
      headlineIdx > rulerIdx,
      'Enable Logic/Threshold should come after the ruler',
    );
  });

  it('Configuration has correct param count', () => {
    const items = ui.secMap['Configuration'];
    const paramCount = items.filter(
      (i: any) => !i.type.startsWith('sep:'),
    ).length;
    assert.equal(paramCount, 17);
  });

  it('Logic/Threshold sections each have exactly 1 param (Function of the logic gate)', () => {
    for (let i = 1; i <= 8; i++) {
      const sec = `Logic/Threshold ${i}`;
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const params = items.filter((it: any) => !it.type.startsWith('sep:'));
      assert.equal(
        params.length,
        1,
        `${sec} should have 1 param, got ${params.length}`,
      );
      assert.equal(params[0].label, 'Function of the logic gate');
    }
  });

  it('no threshold params are visible (Function of logic gate defaults to None)', () => {
    for (const sec of ui.sections) {
      const items = ui.secMap[sec];
      for (const item of items) {
        assert(
          !item.label?.includes('threshold'),
          `"${item.label}" should not be visible when logic gate is None (in section "${sec}")`,
        );
      }
    }
  });

  it('Shutter Actuator functions section exists (renamed from Common parameter)', () => {
    assert(ui.sections.includes('Shutter Actuator functions'));
    const items = ui.secMap['Shutter Actuator functions'];
    assert(items.length > 0);
  });

  it('Shutter Actuator functions has correct param count', () => {
    const items = ui.secMap['Shutter Actuator functions'];
    const paramCount = items.filter(
      (i: any) => !i.type.startsWith('sep:'),
    ).length;
    assert.equal(paramCount, 24);
  });

  it('per-section param counts are correct', () => {
    const expected: Record<string, number> = {
      Configuration: 17,
      'Device settings': 9,
      'Manual operation': 4,
      'Safety/Weather alarms': 15,
      'Basic settings': 15,
      Safety: 3,
      'Load shedding': 7,
      'Delay for switching on and off': 3,
      'Staircase lighting': 9,
      Flashing: 5,
      'Scene assignments': 34,
      Drive: 10,
      'Blind/Shutter': 15,
      'Automatic sun protection': 9,
      'Status Messages': 9,
      'Shutter Actuator functions': 24,
    };
    for (const [sec, count] of Object.entries(expected)) {
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const paramCount = items.filter(
        (i: any) => !i.type.startsWith('sep:'),
      ).length;
      assert.equal(
        paramCount,
        count,
        `${sec}: expected ${count} params, got ${paramCount}`,
      );
    }
  });

  it('per-section separator counts are correct', () => {
    const expected: Record<string, number> = {
      Configuration: 5,
      'Device settings': 5,
      'Manual operation': 3,
      'Safety/Weather alarms': 15,
      'Basic settings': 19,
      Safety: 5,
      'Load shedding': 2,
      'Delay for switching on and off': 2,
      'Staircase lighting': 3,
      Flashing: 3,
      'Scene assignments': 7,
      Drive: 17,
      'Blind/Shutter': 19,
      'Automatic sun protection': 5,
      'Status Messages': 14,
      'Shutter Actuator functions': 28,
    };
    for (const [sec, count] of Object.entries(expected)) {
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const sepCount = items.filter((i: any) =>
        i.type.startsWith('sep:'),
      ).length;
      assert.equal(
        sepCount,
        count,
        `${sec}: expected ${count} separators, got ${sepCount}`,
      );
    }
  });
});
