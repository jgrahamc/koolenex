/**
 * Tests that the parameter UI structure for device 1.1.4 (US/U2.2 Universal Interface)
 * matches the expected section layout. This device uses ParamRefId on ParameterBlocks
 * to derive section labels from TypeNone dummy parameters with translations — testing
 * that the translation pipeline produces English labels, not German internal names.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildParamUI as realBuildParamUI } from '../client/src/detail/paramUI.ts';
import path from 'path';
import fs from 'fs';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.4', () => {
    it('skipped — smoke-test.knxproj not found', () => {});
  });
  process.exit(0);
}

const { parseKnxproj } = await import('../server/ets-parser.ts');

// ── Helpers ──────────────────────────────────────────────────────────────────

// The real, shipped builder - no longer replicated here. These tests
// assert a simplified projection of it (sections keyed by plain label,
// items reduced to label + kind), which `projectUI` derives below.
function buildParamUI(model: any) {
  const ui = realBuildParamUI(model, { ...(model.currentValues || {}) });
  const sections: string[] = [];
  const secMap: Record<string, any[]> = {};
  for (const key of ui.sections) {
    const label = ui.secLabelMap[key] ?? '';
    for (const it of ui.secMap[key] ?? []) {
      if (!secMap[label]) {
        secMap[label] = [];
        sections.push(label);
      }
      secMap[label].push(
        it.type === 'separator'
          ? { label: it.text ?? '', type: 'sep:' + it.uiHint }
          : {
              label: it.label,
              type: it.cell ? 'cell:' + it.cell : 'param',
            },
      );
    }
  }
  return { sections, secMap };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let parsed: any, model: any, ui: any;

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
