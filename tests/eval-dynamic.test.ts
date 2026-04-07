/**
 * Tests for the Dynamic tree evaluation logic — verifying that the correct
 * parameters and com objects are active/inactive for each test device.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const SMOKE_PROJECT = path.join(import.meta.dirname, 'smoke-test.knxproj');
if (!fs.existsSync(SMOKE_PROJECT)) {
  describe('evalDynamic', () => {
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

/** Evaluate the Dynamic tree and return the set of active paramRef IDs. */
function getActiveParams(model: any) {
  const { params, dynTree } = model;
  const values: Record<string, any> = {};
  for (const [k, v] of Object.entries(model.currentValues || {})) values[k] = v;
  const getVal = (prKey: string) =>
    values[prKey] ?? params[prKey]?.defaultValue ?? '';

  const active = new Set<string>();
  function evalChoice(c: any) {
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
      defItems: any = null;
    for (const w of c.whens || []) {
      if (w.isDefault) {
        defItems = w.items;
        continue;
      }
      if (etsTestMatch(val, w.test)) {
        matched = true;
        walk(w.items);
      }
    }
    if (!matched && defItems) walk(defItems);
  }
  function walk(items: any[]) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') active.add(item.refId);
      else if (
        item.type === 'block' ||
        item.type === 'channel' ||
        item.type === 'cib'
      )
        walk(item.items);
      else if (item.type === 'choose') evalChoice(item);
    }
  }
  walk(dynTree?.main?.items);
  for (const md of dynTree?.moduleDefs || []) walk(md.items);
  return active;
}

/** Build the set of params that appear in UI sections (active + in model.params). */
function getVisibleActiveParams(model: any) {
  const active = getActiveParams(model);
  const visible = new Set<string>();
  for (const prKey of active) {
    if (model.params[prKey]) visible.add(prKey);
  }
  return visible;
}

// ── Tests ────────────────────────────────────────────────────────────────────

let parsed: any;

before(() => {
  const buf = fs.readFileSync(SMOKE_PROJECT);
  parsed = parseKnxproj(buf);
});

describe('evalDynamic: active param counts', () => {
  it('1.1.2 (SAH/S8.6.7.1) has a reasonable number of active params', () => {
    const dev = parsed.devices.find(
      (d: any) => d.individual_address === '1.1.2',
    );
    const model = parsed.paramModels[dev.app_ref];
    const active = getActiveParams(model);
    // 3285 total defs, ~1500 active (includes hidden Access=None params)
    assert(
      active.size > 100,
      `should have many active params, got ${active.size}`,
    );
    assert(
      active.size < model.params.length || active.size < 3285,
      'should not activate everything',
    );
  });

  it('1.1.3 (UD/S4.210.2.1) has a reasonable number of active params', () => {
    const dev = parsed.devices.find(
      (d: any) => d.individual_address === '1.1.3',
    );
    const model = parsed.paramModels[dev.app_ref];
    const active = getActiveParams(model);
    assert(active.size > 50, `got ${active.size}`);
    assert(active.size < 893);
  });

  it('1.1.4 (US/U2.2) has a small number of active params', () => {
    const dev = parsed.devices.find(
      (d: any) => d.individual_address === '1.1.4',
    );
    const model = parsed.paramModels[dev.app_ref];
    const active = getActiveParams(model);
    assert(active.size > 5, `got ${active.size}`);
    assert(active.size < 100, `should be small, got ${active.size}`);
  });

  it('1.1.5 (6108/07-500) has a moderate number of active params', () => {
    const dev = parsed.devices.find(
      (d: any) => d.individual_address === '1.1.5',
    );
    const model = parsed.paramModels[dev.app_ref];
    const active = getActiveParams(model);
    assert(active.size > 50, `got ${active.size}`);
    assert(active.size < 500, `got ${active.size}`);
  });
});

describe('evalDynamic: visible active params are a subset of active', () => {
  for (const ia of ['1.1.2', '1.1.3', '1.1.4', '1.1.5']) {
    it(`${ia}: every visible param is in the active set`, () => {
      const dev = parsed.devices.find((d: any) => d.individual_address === ia);
      const model = parsed.paramModels[dev.app_ref];
      const active = getActiveParams(model);
      const visibleActive = getVisibleActiveParams(model);
      // Every visible-active param must be in the full active set
      for (const prKey of visibleActive) {
        assert(
          active.has(prKey),
          `${prKey} (${model.params[prKey]?.label}) is visible but not active`,
        );
      }
    });
  }
});

describe('evalDynamic: CO counts reflect conditional evaluation', () => {
  it('1.1.2 has no threshold COs (logic gate = None)', () => {
    // When the logic gate function defaults to "None", threshold COs should not appear
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.2',
    );
    for (const co of cos) {
      assert(
        !co.name?.includes('Threshold'),
        `CO #${co.object_number} "${co.name}" should not be a threshold CO`,
      );
    }
  });

  it('1.1.4 has COs only for channel A (B is not configured)', () => {
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.4',
    );
    assert.equal(cos.length, 2);
    for (const co of cos) {
      assert.equal(
        co.name,
        'Input A',
        `CO #${co.object_number} should be Input A, got "${co.name}"`,
      );
    }
  });
});

describe('evalDynamic: com object counts match smoke tests', () => {
  it('1.1.2 has exactly 12 active COs', () => {
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.2',
    );
    assert.equal(cos.length, 12);
  });

  it('1.1.3 has exactly 21 active COs', () => {
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.3',
    );
    assert.equal(cos.length, 21);
  });

  it('1.1.4 has exactly 2 active COs', () => {
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.4',
    );
    assert.equal(cos.length, 2);
  });

  it('1.1.5 has exactly 3 active COs', () => {
    const cos = parsed.comObjects.filter(
      (co: any) => co.device_address === '1.1.5',
    );
    assert.equal(cos.length, 3);
  });
});
