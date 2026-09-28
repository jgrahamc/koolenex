/**
 * Module-architecture apps declare each module-instanced Parameter's
 * absolute memory offset as `Offset` (small, module-template-relative)
 * plus `BaseOffset` - an <Argument> Id reference whose numeric value
 * differs per module instance. Before this fix, `paramMemLayout` had
 * exactly one entry per template ParameterRef, at the un-shifted relative
 * offset - never one per device instance, so different, unrelated module
 * instances' parameters collided on the same address. See
 * server/resolveModuleParamMemLayout.ts's own header comment for the
 * full explanation.
 *
 * These fixtures use the same synthetic-dynTree style as
 * dyn-choose-values.test.ts - plain object literals matching the shape
 * ets-app.ts emits, not a parsed XML fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evalConditionallyActiveModuleInstances,
  type DynTree,
  type ParamDef,
} from '../server/routes/knx-tables.ts';
import {
  expandParamMemLayoutForActiveModules,
  type ModuleAwareParamMemLayoutEntry,
} from '../server/resolveModuleParamMemLayout.ts';

const APP = 'M-0000_A-TEST';

describe('evalConditionallyActiveModuleInstances', () => {
  it('finds a module instance reachable unconditionally, outside any choose', () => {
    const dynTree = {
      main: {
        items: [
          {
            type: 'channel',
            id: 'CH-1',
            label: '',
            items: [{ type: 'module', modId: `${APP}_MD-1_M-1` }],
          },
        ],
      },
      moduleDefs: [],
    } as unknown as DynTree;
    const active = evalConditionallyActiveModuleInstances(dynTree, {}, {});
    assert.deepEqual([...active], [`${APP}_MD-1_M-1`]);
  });

  it('only includes the module instance in the currently-active choose branch', () => {
    const SEL = `${APP}_P-382_R-327`;
    const dynTree = {
      main: {
        items: [
          {
            type: 'choose',
            paramRefId: SEL,
            defaultValue: '0',
            whens: [
              {
                test: ['0'],
                isDefault: false,
                items: [{ type: 'module', modId: `${APP}_MD-3_M-1` }],
              },
              {
                test: ['1'],
                isDefault: false,
                items: [{ type: 'module', modId: `${APP}_MD-3_M-2` }],
              },
              { isDefault: true, items: [] },
            ],
          },
        ],
      },
      moduleDefs: [],
    } as unknown as DynTree;

    const paramDefs: Record<string, ParamDef> = {};
    const activeDefault = evalConditionallyActiveModuleInstances(
      dynTree,
      paramDefs,
      {},
    );
    assert.deepEqual([...activeDefault], [`${APP}_MD-3_M-1`]);

    const activeOverridden = evalConditionallyActiveModuleInstances(
      dynTree,
      paramDefs,
      { [SEL]: '1' },
    );
    assert.deepEqual([...activeOverridden], [`${APP}_MD-3_M-2`]);
  });
});

describe('expandParamMemLayoutForActiveModules', () => {
  it('passes non-module parameters through unchanged', () => {
    const layout: Record<string, ModuleAwareParamMemLayoutEntry> = {
      [`${APP}_P-1_R-1`]: { offset: 10, bitOffset: 0, bitSize: 8 },
    };
    const dynTree = {
      main: { items: [] },
      moduleDefs: [],
    } as unknown as DynTree;
    const result = expandParamMemLayoutForActiveModules(
      layout,
      {},
      {},
      {},
      dynTree,
      {},
      {},
    );
    assert.strictEqual(result, layout); // fast path: same object, not a copy
  });

  it('expands one template parameter into two correctly-offset, non-colliding entries for two real active instances', () => {
    // Two Module instances of the same ModuleDef, each with its own
    // resolved BaseOffset argument value (340 and 360, matching values
    // observed in real ETS-exported project data).
    const dynTree = {
      main: {
        items: [
          { type: 'module', modId: `${APP}_MD-1_M-1` },
          { type: 'module', modId: `${APP}_MD-1_M-2` },
        ],
      },
      moduleDefs: [],
    } as unknown as DynTree;
    const modArgs = {
      [`${APP}_MD-1_M-1`]: { ArgBase: 340 },
      [`${APP}_MD-1_M-2`]: { ArgBase: 360 },
    };
    const argDefs = { [`${APP}_MD-1_A-1`]: 'ArgBase' };
    // Template-level layout: ONE entry for the whole ModuleDef's own
    // Parameter, at its small, module-relative offset (2) - exactly the
    // shape buildParamModel() produces before this fix.
    const layout: Record<string, ModuleAwareParamMemLayoutEntry> = {
      [`${APP}_MD-1_P-5_R-5`]: {
        offset: 2,
        bitOffset: 0,
        bitSize: 8,
        fromMemoryChild: false,
        baseOffsetArgId: `${APP}_MD-1_A-1`,
      },
    };
    const result = expandParamMemLayoutForActiveModules(
      layout,
      {},
      argDefs,
      modArgs,
      dynTree,
      {},
      {},
    );
    // Real, per-instance qualified keys - MI-1 is the evidence-based
    // default (see resolveMi's own doc comment).
    const key1 = `${APP}_MD-1_M-1_MI-1_P-5_R-5`;
    const key2 = `${APP}_MD-1_M-2_MI-1_P-5_R-5`;
    assert.deepEqual(Object.keys(result).sort(), [key1, key2].sort());
    assert.strictEqual(result[key1]!.offset, 342); // 2 + 340
    assert.strictEqual(result[key2]!.offset, 362); // 2 + 360
    // The two real instances must NOT land on the same address - the
    // actual bug this whole fix exists to close.
    assert.notStrictEqual(result[key1]!.offset, result[key2]!.offset);
  });

  it('drops the template entry entirely for a ModuleDef with no genuinely active instance', () => {
    const dynTree = {
      main: { items: [] },
      moduleDefs: [],
    } as unknown as DynTree; // no 'module' item anywhere - MD-1 is declared but never instantiated on this device
    const modArgs = { [`${APP}_MD-1_M-1`]: { ArgBase: 340 } };
    const argDefs = { [`${APP}_MD-1_A-1`]: 'ArgBase' };
    const layout: Record<string, ModuleAwareParamMemLayoutEntry> = {
      [`${APP}_MD-1_P-5_R-5`]: {
        offset: 2,
        bitOffset: 0,
        bitSize: 8,
        baseOffsetArgId: `${APP}_MD-1_A-1`,
      },
    };
    const result = expandParamMemLayoutForActiveModules(
      layout,
      {},
      argDefs,
      modArgs,
      dynTree,
      {},
      {},
    );
    assert.deepEqual(result, {});
  });

  it('resolves a real per-device override MI (not the "1" default) from currentValues', () => {
    const dynTree = {
      main: { items: [{ type: 'module', modId: `${APP}_MD-1_M-1` }] },
      moduleDefs: [],
    } as unknown as DynTree;
    const modArgs = { [`${APP}_MD-1_M-1`]: { ArgBase: 340 } };
    const argDefs = { [`${APP}_MD-1_A-1`]: 'ArgBase' };
    const layout: Record<string, ModuleAwareParamMemLayoutEntry> = {
      [`${APP}_MD-1_P-5_R-5`]: {
        offset: 2,
        bitOffset: 0,
        bitSize: 8,
        baseOffsetArgId: `${APP}_MD-1_A-1`,
      },
    };
    // A real override elsewhere reveals this instance's true MI is 2, not
    // the "1" fallback.
    const currentValues = { [`${APP}_MD-1_M-1_MI-2_P-9_R-9`]: 'x' };
    const result = expandParamMemLayoutForActiveModules(
      layout,
      {},
      argDefs,
      modArgs,
      dynTree,
      {},
      currentValues,
    );
    assert.ok(`${APP}_MD-1_M-1_MI-2_P-5_R-5` in result);
    assert.ok(!(`${APP}_MD-1_M-1_MI-1_P-5_R-5` in result));
  });
});
