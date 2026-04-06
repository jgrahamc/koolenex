'use strict';
/**
 * Tests that the parameter UI structure for device 1.1.3 (UD/S4.210.2.1 LED Dimmer)
 * matches the expected section layout.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SMOKE_PROJECT = path.join(__dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.3', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  return;
}

const { parseKnxproj } = require('../server/ets-parser');

// ── Helpers (same logic as params-ui.test.js) ────────────────────────────────

function etsTestMatch(val, tests) {
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

function buildParamUI(model) {
  const { params, dynTree } = model;
  const values = {};
  for (const [k, v] of Object.entries(model.currentValues || {})) values[k] = v;
  const getVal = (prKey) => values[prKey] ?? params[prKey]?.defaultValue ?? '';

  const active = new Set();
  function evalChoiceActive(c) {
    if (c.paramRefId && !c.accessNone && !active.has(c.paramRefId)) return;
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
        if (item.paramRefId && !item.accessNone && !active.has(item.paramRefId))
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
    if (item.paramRefId && !item.accessNone && !active.has(item.paramRefId))
      return;
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

let parsed, model, ui;

before(() => {
  const buf = fs.readFileSync(SMOKE_PROJECT);
  parsed = parseKnxproj(buf);
  const dev = parsed.devices.find((d) => d.individual_address === '1.1.3');
  model = parsed.paramModels[dev.app_ref];
  ui = buildParamUI(model);
});

describe('Params UI: 1.1.3 (UD/S4.210.2.1 LED Dimmer)', () => {
  it('has exactly the expected sections in the correct order', () => {
    assert.deepEqual(ui.sections, [
      'Channel allocation',
      'General',
      'Configure scenes',
      'Basic settings',
      'Feedback and error messages',
      'Block and forced function',
      'Faults',
      'Central objects',
      'Correction of characteristic',
      'Channel 1',
      'Channel 2',
      'Channel 3',
      'Channel 4',
      'Channel 5',
    ]);
  });

  it('does NOT have phantom sections', () => {
    for (const sec of ui.sections) {
      assert(!sec.includes('Par_'), `"${sec}" looks like an internal name`);
    }
  });

  it('Channel allocation has correct structure', () => {
    const items = ui.secMap['Channel allocation'];
    assert(items);
    const params = items.filter((i) => !i.type.startsWith('sep:'));
    assert.equal(params.length, 5);
    assert(
      params.some((p) => p.label === 'Bundling outputs (parallel switching)'),
    );
    assert(params.some((p) => p.label === 'Output A'));
    assert(params.some((p) => p.label === 'Output B'));
    assert(params.some((p) => p.label === 'Output C'));
    assert(params.some((p) => p.label === 'Output D'));
  });

  it('General has 3 params', () => {
    const items = ui.secMap['General'];
    assert(items);
    const params = items.filter((i) => !i.type.startsWith('sep:'));
    assert.equal(params.length, 3);
  });

  it('Configure scenes has 32 params', () => {
    const items = ui.secMap['Configure scenes'];
    assert(items);
    const params = items.filter((i) => !i.type.startsWith('sep:'));
    assert.equal(params.length, 32);
  });

  it('per-section param counts are correct', () => {
    const expected = {
      'Channel allocation': 5,
      General: 3,
      'Configure scenes': 32,
      'Basic settings': 21,
      'Feedback and error messages': 8,
      'Block and forced function': 5,
      Faults: 9,
      'Central objects': 7,
      'Correction of characteristic': 5,
      'Channel 1': 1,
      'Channel 2': 1,
      'Channel 3': 1,
      'Channel 4': 1,
      'Channel 5': 1,
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
      'Channel allocation': 2,
      General: 2,
      'Configure scenes': 0,
      'Basic settings': 12,
      'Feedback and error messages': 7,
      'Block and forced function': 4,
      Faults: 9,
      'Central objects': 4,
      'Correction of characteristic': 4,
      'Channel 1': 0,
      'Channel 2': 0,
      'Channel 3': 0,
      'Channel 4': 0,
      'Channel 5': 0,
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

  it('Channel 1-5 each have exactly 1 param (Application)', () => {
    for (let i = 1; i <= 5; i++) {
      const sec = `Channel ${i}`;
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      const params = items.filter((it) => !it.type.startsWith('sep:'));
      assert.equal(params.length, 1, `${sec} should have 1 param`);
      assert.equal(params[0].label, 'Application');
    }
  });
});
