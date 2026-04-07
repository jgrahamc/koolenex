/**
 * Tests that the parameter UI structure for device 1.1.5 (6108/07-500 Push-button coupler)
 * matches the expected section layout.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.5', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  process.exit(0);
}

const { parseKnxproj } = await import('../server/ets-parser.ts');

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const values = {};
  for (const [k, v] of Object.entries(model.currentValues || {})) values[k] = v;
  const getVal = (prKey) => values[prKey] ?? params[prKey]?.defaultValue ?? '';

  const active = new Set();
  function evalChoiceActive(c) {
    if (
      c.paramRefId &&
      !c.accessNone &&
      params[c.paramRefId] &&
      !active.has(c.paramRefId)
    )
      process.exit(0);
    const raw = getVal(c.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (c.defaultValue ?? ''),
    );
    let matched = false,
      defItems = null;
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
  function walkActive(items) {
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

  const sections = [];
  const secMap = {};
  const blockRenames = {};

  function collectRenames(items) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'rename' && item.refId && item.text)
        blockRenames[item.refId] = item.text;
      else if (item.type === 'choose') {
        if (
          item.paramRefId &&
          !item.accessNone &&
          params[item.paramRefId] &&
          !active.has(item.paramRefId)
        )
          continue;
        const raw = getVal(item.paramRefId);
        const val = String(
          raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
        );
        let matched = false,
          defItems = null;
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

  function addItem(sec, label, type) {
    if (!secMap[sec]) {
      secMap[sec] = [];
      sections.push(sec);
    }
    secMap[sec].push({ label, type: type || 'param' });
  }

  function evalChooseUI(item, secLabel, walkFn) {
    if (
      item.paramRefId &&
      !item.accessNone &&
      params[item.paramRefId] &&
      !active.has(item.paramRefId)
    )
      process.exit(0);
    const raw = getVal(item.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
    );
    let matched = false,
      defItems = null;
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

  function walkItems(items, secLabel) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') {
        if (!params[item.refId] || !active.has(item.refId)) continue;
        addItem(secLabel, params[item.refId].label, 'param');
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

  function walkChannelItems(items, chLabel) {
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
  const dev = parsed.devices.find((d) => d.individual_address === '1.1.5');
  model = parsed.paramModels[dev.app_ref];
  ui = buildParamUI(model);
});

describe('Params UI: 1.1.5 (6108/07-500 Push-button coupler)', () => {
  it('has exactly the expected sections in the correct order', () => {
    assert.deepEqual(ui.sections, [
      'Common parameter',
      'General parameters',
      'Extended parameters',
    ]);
  });

  it('per-section param counts are correct', () => {
    const expected = {
      'Common parameter': 10,
      'General parameters': 8,
      'Extended parameters': 6,
    };
    for (const [sec, count] of Object.entries(expected)) {
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const paramCount = items.filter((i) => !i.type.startsWith('sep:')).length;
      assert.equal(
        paramCount,
        count,
        `${sec}: expected ${count} params, got ${paramCount}`,
      );
    }
  });

  it('per-section separator counts are correct', () => {
    const expected = {
      'Common parameter': 2,
      'General parameters': 2,
      'Extended parameters': 0,
    };
    for (const [sec, count] of Object.entries(expected)) {
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const sepCount = items.filter((i) => i.type.startsWith('sep:')).length;
      assert.equal(
        sepCount,
        count,
        `${sec}: expected ${count} separators, got ${sepCount}`,
      );
    }
  });

  it('does NOT have phantom sections', () => {
    for (const sec of ui.sections) {
      assert(!sec.includes('Par_'), `"${sec}" looks like an internal name`);
    }
  });
});
