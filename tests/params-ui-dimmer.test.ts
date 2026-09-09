/**
 * Tests that the parameter UI structure for device 1.1.3 (UD/S4.210.2.1 LED Dimmer)
 * matches the expected section layout.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildParamUI as realBuildParamUI } from '../client/src/detail/paramUI.ts';
import path from 'path';
import fs from 'fs';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('Params UI: 1.1.3', () => {
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
