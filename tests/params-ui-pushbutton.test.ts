/**
 * Tests that the parameter UI structure for device 1.1.5 (6108/07-500 Push-button coupler)
 * matches the expected section layout.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildParamUI as realBuildParamUI } from '../client/src/detail/paramUI.ts';
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
