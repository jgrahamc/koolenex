'use strict';
/**
 * Tests that the parameter UI structure for device 1.1.4 (US/U2.2 Universal Interface)
 * matches the expected section layout. This device uses ParamRefId on ParameterBlocks
 * to derive section labels from TypeNone dummy parameters with translations — testing
 * that the translation pipeline produces English labels, not German internal names.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SMOKE_PROJECT = path.join(__dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.4', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  return;
}

const { parseKnxproj } = require('../server/ets-parser');

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    if (
      c.paramRefId &&
      !c.accessNone &&
      params[c.paramRefId] &&
      !active.has(c.paramRefId)
    )
      return;
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
  const dev = parsed.devices.find((d) => d.individual_address === '1.1.4');
  model = parsed.paramModels[dev.app_ref];
  ui = buildParamUI(model);
});

describe('Params UI: 1.1.4 (US/U2.2 Universal Interface)', () => {
  it('has exactly the expected sections in the correct order', () => {
    assert.deepEqual(ui.sections, ['General', 'Channel A', 'Channel B']);
  });

  it('section labels are English translations, not German internal names', () => {
    // The XML has Name="R_Allgemein", "R_Kanal A", "R_Kanal B" as internal names.
    // The labels must come from ParamRefId → TypeNone parameter translations.
    for (const sec of ui.sections) {
      assert(
        !sec.startsWith('R_'),
        `"${sec}" looks like a German internal name`,
      );
    }
    assert(
      ui.sections.includes('General'),
      'should have "General" not "R_Allgemein"',
    );
    assert(
      ui.sections.includes('Channel A'),
      'should have "Channel A" not "R_Kanal A"',
    );
    assert(
      ui.sections.includes('Channel B'),
      'should have "Channel B" not "R_Kanal B"',
    );
  });

  it('parser resolves block labels via ParamRefId translations', () => {
    // Verify the dynTree itself has translated text, not just the UI walk
    const ch = model.dynTree.main.items[0];
    const blocks = ch.items.filter((i) => i.type === 'block');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text, 'General');
    assert.equal(blocks[0].name, 'R_Allgemein');
    assert.equal(blocks[1].text, 'Channel A');
    assert.equal(blocks[1].name, 'R_Kanal A');
    assert.equal(blocks[2].text, 'Channel B');
    assert.equal(blocks[2].name, 'R_Kanal B');
  });

  it('General section has 5 params', () => {
    const items = ui.secMap['General'];
    assert(items);
    const paramCount = items.filter((i) => !i.type.startsWith('sep:')).length;
    assert.equal(paramCount, 5);
  });

  it('General section params include expected labels', () => {
    const items = ui.secMap['General'];
    const labels = items
      .filter((i) => !i.type.startsWith('sep:'))
      .map((i) => i.label);
    assert(labels.some((l) => l.includes('Transmission delay')));
    assert(labels.some((l) => l.includes('Limit number of telegrams')));
  });

  it('Channel A has 1 param (Function of the channel)', () => {
    const items = ui.secMap['Channel A'];
    assert(items);
    const params = items.filter((i) => !i.type.startsWith('sep:'));
    assert.equal(params.length, 1);
    assert.equal(params[0].label, 'Function of the channel');
  });

  it('Channel B has 1 param (Function of the channel)', () => {
    const items = ui.secMap['Channel B'];
    assert(items);
    const params = items.filter((i) => !i.type.startsWith('sep:'));
    assert.equal(params.length, 1);
    assert.equal(params[0].label, 'Function of the channel');
  });

  it('no sections have German internal names', () => {
    const bad = ['R_Allgemein', 'R_Kanal A', 'R_Kanal B', 'Generic'];
    for (const name of bad) {
      assert(!ui.sections.includes(name), `"${name}" should not be a section`);
    }
  });

  it('per-section param and separator counts are correct', () => {
    const expected = {
      General: { params: 5, seps: 0 },
      'Channel A': { params: 1, seps: 0 },
      'Channel B': { params: 1, seps: 0 },
    };
    for (const [sec, counts] of Object.entries(expected)) {
      const items = ui.secMap[sec];
      assert(items, `section "${sec}" should exist`);
      assert.equal(
        items.filter((i) => !i.type.startsWith('sep:')).length,
        counts.params,
        `${sec} params`,
      );
      assert.equal(
        items.filter((i) => i.type.startsWith('sep:')).length,
        counts.seps,
        `${sec} separators`,
      );
    }
  });
});
