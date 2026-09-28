/**
 * Parameter memory layout for module-architecture apps.
 *
 * A module-instanced Parameter declares a small, module-relative Offset plus
 * a BaseOffset Argument whose value differs per instance. Building the
 * parameter image correctly then depends on a chain of decisions, all
 * covered here without a bus:
 *
 *  - expandParamMemLayoutForActiveModules(): one entry per genuinely active
 *    instance, at base + offset, with the conditional gate re-evaluated per
 *    instance (selector values looked up under the instance-qualified key,
 *    or taken from the instance's BaseValue argument).
 *  - evalConditionallyActiveParamRefs(): qualified > bare > BaseValue >
 *    static-default lookup order, ModuleDef trees walked, excluded selectors.
 *  - buildParamMem(): a ParameterRef's own Value only applies when the entry
 *    is reached by the dynamic tree; only one member of a <Union> is written;
 *    a losing Union member's own <choose> does not mark anything reachable.
 *
 * Most fixtures are plain object literals in the shape ets-app.ts emits;
 * a few are built from application XML to cover the parser-to-image chain.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAppIndex } from '../server/ets-app.ts';
import {
  buildParamMem,
  buildUnconditionalChannelSet,
  evalConditionallyActiveParamRefs,
  type DynTree,
  type ParamDef,
  type ParamMemEntry,
} from '../server/routes/knx-tables.ts';
import {
  expandParamMemLayoutForActiveModules,
  type ModuleAwareParamMemLayoutEntry,
} from '../server/resolveModuleParamMemLayout.ts';

const APP = 'M-0001_A-T2';
const MD1 = `${APP}_MD-1`;
const ARG_BASE = `${MD1}_A-1`;

const tree = (
  main: unknown[],
  moduleDefs: { id: string; items: unknown[] }[] = [],
) => ({ main: { items: main }, moduleDefs }) as unknown as DynTree;

const pref = (refId: string) => ({ type: 'paramRef', refId });
const mod = (modId: string) => ({ type: 'module', modId });
const choose = (
  paramRefId: string,
  defaultValue: string | null,
  branches: [string[] | 'default', unknown[]][],
) => ({
  type: 'choose',
  paramRefId,
  defaultValue,
  whens: branches.map(([test, items]) =>
    test === 'default'
      ? { isDefault: true, items }
      : { test, isDefault: false, items },
  ),
});

/** A plain, visible 8-bit parameter. */
function entry(
  offset: number,
  over: Partial<ModuleAwareParamMemLayoutEntry> & Record<string, unknown> = {},
): ModuleAwareParamMemLayoutEntry & ParamMemEntry {
  return {
    offset,
    bitOffset: 0,
    bitSize: 8,
    defaultValue: '0',
    isVisible: true,
    ...over,
  } as ModuleAwareParamMemLayoutEntry & ParamMemEntry;
}

const defaults = (m: Record<string, string>): Record<string, ParamDef> =>
  Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { defaultValue: v }]),
  );

// ─── evalConditionallyActiveParamRefs ────────────────────────────────────────

describe('evalConditionallyActiveParamRefs: selector value lookup and tree walk', () => {
  const SEL = `${APP}_P-1_R-1`;
  const X = `${APP}_P-2_R-2`;
  const Y = `${APP}_P-3_R-3`;
  const dyn = tree([
    choose(SEL, null, [
      [['1'], [pref(X)]],
      ['default', [pref(Y)]],
    ]),
  ]);
  const qualify = (k: string) => k.replace('_P-1', '_M-1_MI-1_P-1');
  const QUAL = qualify(SEL);

  it('uses the static default when nothing else supplies the selector', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '0' }),
      {},
    );
    assert.deepEqual([...active], [Y]);
    const other = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '1' }),
      {},
    );
    assert.deepEqual([...other], [X]);
  });

  it('prefers a resolveBaseValue result over the static default', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '0' }),
      {},
      undefined,
      undefined,
      (k) => (k === SEL ? '1' : undefined),
    );
    assert.deepEqual([...active], [X]);
  });

  it('falls back to the static default when resolveBaseValue has no answer', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '0' }),
      {},
      undefined,
      undefined,
      () => undefined,
    );
    assert.deepEqual([...active], [Y]);
  });

  it('prefers a bare currentValues entry over resolveBaseValue', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '1' }),
      { [SEL]: '0' },
      undefined,
      undefined,
      () => '1',
    );
    assert.deepEqual([...active], [Y]);
  });

  it('prefers the instance-qualified currentValues entry over the bare one', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '0' }),
      { [SEL]: '0', [QUAL]: '1' },
      undefined,
      qualify,
    );
    assert.deepEqual([...active], [X]);
  });

  it('falls back to the bare key when the qualified one has no value', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '0' }),
      { [SEL]: '1' },
      undefined,
      qualify,
    );
    assert.deepEqual([...active], [X]);
  });

  it("walks a ModuleDef's own Dynamic tree, not just the application's", () => {
    const inModule = tree(
      [],
      [{ id: MD1, items: [choose(SEL, '1', [[['1'], [pref(X)]]])] }],
    );
    assert.deepEqual(
      [...evalConditionallyActiveParamRefs(inModule, {}, {})],
      [X],
    );
  });

  it('skips a choose whose selector is excluded: neither the matching nor the default branch counts', () => {
    const active = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '1' }),
      {},
      undefined,
      undefined,
      undefined,
      (id) => id === SEL,
    );
    assert.equal(active.size, 0);
    // Excluding some other selector changes nothing.
    const untouched = evalConditionallyActiveParamRefs(
      dyn,
      defaults({ [SEL]: '1' }),
      {},
      undefined,
      undefined,
      undefined,
      (id) => id === 'other',
    );
    assert.deepEqual([...untouched], [X]);
  });
});

describe('buildUnconditionalChannelSet', () => {
  it('collects unconditional refs from ModuleDef trees, ignoring anything under a choose', () => {
    const dyn = tree(
      [{ type: 'channel', id: 'c', label: '', items: [pref('A')] }],
      [
        {
          id: MD1,
          items: [
            pref('B'),
            { type: 'cib', items: [pref('C')] },
            choose('SEL', '0', [[['0'], [pref('D')]]]),
          ],
        },
      ],
    );
    assert.deepEqual([...buildUnconditionalChannelSet(dyn)].sort(), [
      'A',
      'B',
      'C',
    ]);
  });
});

// ─── expandParamMemLayoutForActiveModules ───────────────────────────────────

describe('expandParamMemLayoutForActiveModules: per-instance conditional gate', () => {
  const SEL = `${MD1}_P-1_R-1`;
  const A = `${MD1}_UP-2_R-2`;
  const B = `${MD1}_UP-3_R-3`;
  const M1 = `${MD1}_M-1`;
  const M2 = `${MD1}_M-2`;
  const dyn = tree(
    [mod(M1), mod(M2)],
    [
      {
        id: MD1,
        items: [
          choose(SEL, '0', [
            [['0'], [pref(A)]],
            [['1'], [pref(B)]],
          ]),
        ],
      },
    ],
  );
  const modArgs = { [M1]: { Base: '10' }, [M2]: { Base: '20' } };
  const argDefs = { [ARG_BASE]: 'Base' };
  const layout = (): Record<string, ModuleAwareParamMemLayoutEntry> => ({
    [A]: entry(4, { fromMemoryChild: true, baseOffsetArgId: ARG_BASE }),
    [B]: entry(4, { fromMemoryChild: true, baseOffsetArgId: ARG_BASE }),
  });
  const q = (mk: string, pr: string) => pr.replace(`${MD1}_`, `${mk}_MI-1_`);
  const expand = (
    cv: Record<string, unknown>,
    baseValueArgIds: Record<string, string> = {},
    args: typeof modArgs = modArgs,
  ) =>
    expandParamMemLayoutForActiveModules(
      layout(),
      baseValueArgIds,
      argDefs,
      args,
      dyn,
      defaults({ [SEL]: '0' }),
      cv,
    );

  it('emits, for each instance, only the alternative its own selector value chooses', () => {
    const out = expand({ [q(M2, SEL)]: '1' });
    assert.deepEqual(Object.keys(out).sort(), [q(M1, A), q(M2, B)].sort());
    assert.equal(out[q(M1, A)]!.offset, 14);
    assert.equal(out[q(M2, B)]!.offset, 24);
  });

  it('clears fromMemoryChild on what it emits, so the image builder does not re-gate it device-wide', () => {
    const out = expand({});
    for (const e of Object.values(out)) assert.equal(e.fromMemoryChild, false);
    // Untouched fields are carried through.
    assert.equal(out[q(M1, A)]!.baseOffsetArgId, ARG_BASE);
  });

  it('with no instance overriding the selector, every instance takes the default branch', () => {
    const out = expand({});
    assert.deepEqual(Object.keys(out).sort(), [q(M1, A), q(M2, A)].sort());
  });

  it('prefers the instance-qualified selector value over the bare one, per instance', () => {
    const out = expand({ [SEL]: '1', [q(M1, SEL)]: '0' });
    assert.deepEqual(Object.keys(out).sort(), [q(M1, A), q(M2, B)].sort());
  });

  it('emits a hidden entry whenever its own qualified override exists, whatever the selector says', () => {
    const lay: Record<string, ModuleAwareParamMemLayoutEntry> = {
      [B]: entry(4, {
        fromMemoryChild: true,
        isVisible: false,
        baseOffsetArgId: ARG_BASE,
      }),
    };
    const out = expandParamMemLayoutForActiveModules(
      lay,
      {},
      argDefs,
      modArgs,
      dyn,
      defaults({ [SEL]: '0' }),
      { [q(M1, B)]: '5' },
    );
    assert.deepEqual(Object.keys(out), [q(M1, B)]);
  });

  it('emits an entry for both instances when its ref is reached unconditionally', () => {
    const always = tree([mod(M1), mod(M2)], [{ id: MD1, items: [pref(A)] }]);
    const out = expandParamMemLayoutForActiveModules(
      { [A]: entry(4, { fromMemoryChild: true, baseOffsetArgId: ARG_BASE }) },
      {},
      argDefs,
      modArgs,
      always,
      {},
      {},
    );
    assert.deepEqual(Object.keys(out).sort(), [q(M1, A), q(M2, A)].sort());
  });

  it('skips only the instance that lacks the offset argument', () => {
    const out = expand({}, {}, { [M1]: { Base: '10' }, [M2]: {} as never });
    assert.deepEqual(Object.keys(out), [q(M1, A)]);
  });

  it('drops an entry whose BaseOffset argument id has no declared name', () => {
    const out = expandParamMemLayoutForActiveModules(
      { [A]: entry(4, { baseOffsetArgId: `${MD1}_A-42` }), keep: entry(1) },
      {},
      argDefs,
      modArgs,
      dyn,
      {},
      {},
    );
    assert.deepEqual(Object.keys(out), ['keep']);
  });

  it('keeps ordinary entries and reads a numeric string argument as a number', () => {
    const out = expandParamMemLayoutForActiveModules(
      {
        [`${MD1}_P-9_R-9`]: entry(2, { baseOffsetArgId: ARG_BASE }),
        plain: entry(60),
      },
      {},
      argDefs,
      { [M1]: { Base: '340' } },
      tree([mod(M1)]),
      {},
      {},
    );
    assert.equal(out.plain!.offset, 60);
    assert.equal(out[`${M1}_MI-1_P-9_R-9`]!.offset, 342);
  });

  it('accepts a Union member (UP-) key as readily as a plain (P-) one', () => {
    const out = expandParamMemLayoutForActiveModules(
      { [`${MD1}_UP-7_R-7`]: entry(2, { baseOffsetArgId: ARG_BASE }) },
      {},
      argDefs,
      { [M1]: { Base: '8' } },
      tree([mod(M1)]),
      {},
      {},
    );
    assert.deepEqual(Object.keys(out), [`${M1}_MI-1_UP-7_R-7`]);
    assert.equal(out[`${M1}_MI-1_UP-7_R-7`]!.offset, 10);
  });
});

describe('expandParamMemLayoutForActiveModules: BaseValue selects the alternative per instance', () => {
  const PID = `${MD1}_P-4`; // the selector Parameter (no ParameterInstanceRef exists for it)
  const SEL = `${PID}_R-4`; // its ParameterRef
  const REL = `${MD1}_UP-1_R-1`;
  const ABS = `${MD1}_UP-2_R-2`;
  const ARG_MODE = `${MD1}_A-3`;
  const M1 = `${MD1}_M-1`;
  const M2 = `${MD1}_M-2`;
  const dyn = tree(
    [mod(M1), mod(M2)],
    [
      {
        id: MD1,
        items: [
          choose(SEL, '0', [
            [['0'], [pref(REL)]],
            [['1'], [pref(ABS)]],
          ]),
        ],
      },
    ],
  );
  const argDefs = { [ARG_BASE]: 'Base', [ARG_MODE]: 'Mode' };
  const modArgs = {
    [M1]: { Base: '10', Mode: '0' },
    [M2]: { Base: '20', Mode: '1' },
  };
  const layout = () => ({
    [REL]: entry(4, { fromMemoryChild: true, baseOffsetArgId: ARG_BASE }),
    [ABS]: entry(4, { fromMemoryChild: true, baseOffsetArgId: ARG_BASE }),
  });
  const run = (
    baseValueArgIds: Record<string, string>,
    cv: Record<string, unknown> = {},
    args: Record<string, Record<string, string | number>> = modArgs,
  ) =>
    Object.keys(
      expandParamMemLayoutForActiveModules(
        layout(),
        baseValueArgIds,
        argDefs,
        args,
        dyn,
        defaults({ [SEL]: '0' }),
        cv,
      ),
    ).sort();
  const q = (mk: string, pr: string) => pr.replace(`${MD1}_`, `${mk}_MI-1_`);

  it("reads each instance's own NumericArg through the selector Parameter's BaseValue", () => {
    assert.deepEqual(run({ [PID]: ARG_MODE }), [q(M1, REL), q(M2, ABS)].sort());
  });

  it('without a BaseValue mapping every instance falls back to the static default', () => {
    assert.deepEqual(run({}), [q(M1, REL), q(M2, REL)].sort());
  });

  it('a genuine per-instance override still beats the BaseValue argument', () => {
    assert.deepEqual(
      run({ [PID]: ARG_MODE }, { [q(M1, SEL)]: '1' }),
      [q(M1, ABS), q(M2, ABS)].sort(),
    );
  });

  it('falls back to the static default for an instance that lacks the BaseValue argument', () => {
    const args = { [M1]: { Base: '10' }, [M2]: { Base: '20', Mode: '1' } };
    assert.deepEqual(
      run({ [PID]: ARG_MODE }, {}, args),
      [q(M1, REL), q(M2, ABS)].sort(),
    );
  });

  it('falls back to the static default when the BaseValue argument id has no declared name', () => {
    assert.deepEqual(
      run({ [PID]: `${MD1}_A-77` }),
      [q(M1, REL), q(M2, REL)].sort(),
    );
  });
});

// ─── buildParamMem ───────────────────────────────────────────────────────────

describe('buildParamMem: instance-qualified entries', () => {
  const M1 = `${MD1}_M-1`;
  const M2 = `${MD1}_M-2`;
  const P = `${MD1}_P-1_R-1`;
  const template: Record<string, ModuleAwareParamMemLayoutEntry> = {
    [P]: entry(2, {
      defaultValue: '7',
      fromMemoryChild: false,
      baseOffsetArgId: ARG_BASE,
    }),
  };
  const dyn = tree([mod(M1), mod(M2)]);
  const expanded = (cv: Record<string, unknown> = {}) =>
    expandParamMemLayoutForActiveModules(
      template,
      {},
      { [ARG_BASE]: 'Base' },
      { [M1]: { Base: '10' }, [M2]: { Base: '20' } },
      dyn,
      {},
      cv,
    );

  it('writes each instance at its own address, an override taking effect for that instance only', () => {
    const cv = { [`${M2}_MI-1_P-1_R-1`]: '9' };
    const buf = buildParamMem(
      40,
      expanded(cv) as Record<string, ParamMemEntry>,
      cv,
      0xff,
      null,
      dyn,
      {},
    );
    assert.equal(buf[12], 7);
    assert.equal(buf[22], 9);
    for (const i of [0, 2, 11, 13, 21, 23, 39])
      assert.equal(buf[i], 0xff, `byte ${i} untouched`);
  });

  it('the unexpanded template, by contrast, only ever touches the un-shifted offset', () => {
    const buf = buildParamMem(
      40,
      template as Record<string, ParamMemEntry>,
      {},
      0xff,
      null,
      dyn,
      {},
    );
    assert.equal(buf[2], 7);
    assert.equal(buf[12], 0xff);
    assert.equal(buf[22], 0xff);
  });
});

describe('buildParamMem: ParameterRef value versus Parameter default', () => {
  const T = `${APP}_P-1_R-1`;
  const build = (
    layout: Record<string, Partial<ParamMemEntry> & Record<string, unknown>>,
    dyn: DynTree,
    cv: Record<string, unknown> = {},
  ) => {
    const full = Object.fromEntries(
      Object.entries(layout).map(([k, v]) => [k, entry(v.offset as number, v)]),
    ) as Record<string, ParamMemEntry>;
    return buildParamMem(16, full, cv, 0xff, null, dyn, {});
  };

  it('an entry the dynamic tree never reaches takes the Parameter default, not the ref value', () => {
    const buf = build(
      { [T]: { offset: 1, defaultValue: '5', refValue: '9' } },
      tree([]),
    );
    assert.equal(buf[1], 5);
  });

  it('an entry reached unconditionally takes the ref value', () => {
    const buf = build(
      {
        [T]: {
          offset: 1,
          defaultValue: '5',
          refValue: '9',
          fromMemoryChild: true,
        },
      },
      tree([pref(T)]),
    );
    assert.equal(buf[1], 9);
  });

  it('an entry reached through the matching choose branch takes the ref value', () => {
    const SEL = `${APP}_P-2_R-2`;
    const dyn = tree([choose(SEL, '1', [[['1'], [pref(T)]]])]);
    const layout = {
      [T]: {
        offset: 1,
        defaultValue: '5',
        refValue: '9',
        fromMemoryChild: true,
      },
    };
    const buf = build(layout, dyn);
    assert.equal(buf[1], 9);
    // On a non-matching branch it is not written at all.
    const off = build(layout, tree([choose(SEL, '0', [[['1'], [pref(T)]]])]));
    assert.equal(off[1], 0xff);
  });

  it('a reached entry with no ref value falls back to the Parameter default', () => {
    const buf = build(
      { [T]: { offset: 1, defaultValue: '5', fromMemoryChild: true } },
      tree([pref(T)]),
    );
    assert.equal(buf[1], 5);
  });

  it('an explicit value beats both', () => {
    const buf = build(
      {
        [T]: {
          offset: 1,
          defaultValue: '5',
          refValue: '9',
          fromMemoryChild: true,
        },
      },
      tree([pref(T)]),
      { [T]: '3' },
    );
    assert.equal(buf[1], 3);
  });

  it('a module-instanced entry (already gated per instance) counts as reached', () => {
    const inst = `${MD1}_M-1_MI-1_P-1_R-1`;
    const buf = build(
      {
        [inst]: {
          offset: 1,
          defaultValue: '5',
          refValue: '9',
          fromMemoryChild: false,
          baseOffsetArgId: ARG_BASE,
        },
      },
      tree([]),
    );
    assert.equal(buf[1], 9);
  });
});

describe('buildParamMem: only one member of a Union group is written', () => {
  const A = `${APP}_UP-1_R-1`;
  const B = `${APP}_UP-2_R-2`;
  const SEL = `${APP}_P-9_R-9`;
  const member = (defaultValue: string, over: Record<string, unknown> = {}) =>
    entry(5, { fromMemoryChild: true, defaultValue, ...over });
  const build = (
    layout: Record<string, ParamMemEntry>,
    dyn: DynTree,
    cv: Record<string, unknown> = {},
    params: Record<string, ParamDef> = {},
  ) => buildParamMem(16, layout, cv, 0xff, null, dyn, params);

  it('the DefaultUnionParameter member wins when nothing is overridden, not the last one listed', () => {
    const buf = build(
      { [A]: member('1', { isDefaultUnionParam: true }), [B]: member('2') },
      tree([pref(A), pref(B)]),
    );
    assert.equal(buf[5], 1);
  });

  it('an explicit value on a reachable member beats the default-marked one', () => {
    const buf = build(
      { [A]: member('1', { isDefaultUnionParam: true }), [B]: member('2') },
      tree([pref(A), pref(B)]),
      { [B]: '9' },
    );
    assert.equal(buf[5], 9);
  });

  it('a stale value on a member that is not currently reachable does not displace the reachable default', () => {
    const dyn = tree([
      choose(SEL, '0', [
        [['0'], [pref(A)]],
        [['1'], [pref(B)]],
      ]),
    ]);
    const buf = build(
      { [A]: member('1', { isDefaultUnionParam: true }), [B]: member('2') },
      dyn,
      { [B]: '2' },
      defaults({ [SEL]: '0' }),
    );
    assert.equal(buf[5], 1);
  });

  it('a default-marked member that is not reachable does not claim the group from a reachable one', () => {
    const dyn = tree([pref(B), choose(SEL, '1', [[['0'], [pref(A)]]])]);
    const buf = build(
      { [A]: member('1', { isDefaultUnionParam: true }), [B]: member('2') },
      dyn,
      {},
      defaults({ [SEL]: '1' }),
    );
    assert.equal(buf[5], 2);
  });

  it('with no override and no default marker the group is left alone: the later member writes last', () => {
    const buf = build(
      { [A]: member('1'), [B]: member('2') },
      tree([pref(A), pref(B)]),
    );
    assert.equal(buf[5], 2);
  });

  it('a group of one is unaffected', () => {
    const buf = build({ [A]: member('4') }, tree([pref(A)]));
    assert.equal(buf[5], 4);
  });

  it('members that merely share a byte but not a bit position are separate groups', () => {
    const buf = build(
      {
        [A]: entry(5, {
          fromMemoryChild: true,
          defaultValue: '1',
          bitSize: 4,
          bitOffset: 0,
          isDefaultUnionParam: true,
        }),
        [B]: entry(5, {
          fromMemoryChild: true,
          defaultValue: '2',
          bitSize: 4,
          bitOffset: 4,
        }),
      },
      tree([pref(A), pref(B)]),
    );
    assert.equal(buf[5], 0x12);
  });
});

describe("buildParamMem: a losing Union member's own choose marks nothing reachable", () => {
  const SA = `${APP}_UP-1_R-1`;
  const SB = `${APP}_UP-2_R-2`;
  const T = `${APP}_P-3_R-3`;
  const T2 = `${APP}_P-4_R-4`;
  const layout = (): Record<string, ParamMemEntry> => ({
    [SA]: entry(10, {
      fromMemoryChild: true,
      defaultValue: '0',
      isDefaultUnionParam: true,
    }),
    [SB]: entry(10, { fromMemoryChild: true, defaultValue: '1' }),
    [T]: entry(20, { fromMemoryChild: true, defaultValue: '77' }),
    [T2]: entry(30, { fromMemoryChild: true, defaultValue: '88' }),
  });
  // Both members are always shown; each one also owns an independent choose.
  const dyn = tree([
    pref(SA),
    pref(SB),
    choose(SA, '0', [[['0'], [pref(T2)]]]),
    choose(SB, '1', [[['1'], [pref(T)]]]),
  ]);
  const params = defaults({ [SA]: '0', [SB]: '1' });

  it("the default member wins: its own choose is honoured, the loser's is not", () => {
    const buf = buildParamMem(40, layout(), {}, 0xff, null, dyn, params);
    assert.equal(buf[10], 0);
    assert.equal(buf[30], 88, "the winner's branch target is written");
    assert.equal(
      buf[20],
      0xff,
      "the loser's stale-default branch target is not",
    );
  });

  it('when an explicit value makes the other member win, the roles swap', () => {
    const cv = { [SB]: '1' };
    const buf = buildParamMem(40, layout(), cv, 0xff, null, dyn, params);
    assert.equal(buf[10], 1);
    assert.equal(buf[20], 77);
    assert.equal(buf[30], 0xff);
  });
});

// ─── Parser to image ─────────────────────────────────────────────────────────

describe('module app XML through the parser, the expansion and the image builder', () => {
  const CO = `${APP}_CH-1`;
  const MODE = `${MD1}_A-3`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <ManufacturerData>
    <Manufacturer Id="M-0001">
      <ApplicationPrograms>
        <ApplicationProgram Id="${APP}">
          <Static>
            <ParameterTypes>
              <ParameterType Id="${APP}_PT-1"><TypeNumber SizeInBit="8" /></ParameterType>
              <ParameterType Id="${APP}_PT-F"><TypeFloat Encoding="IEEE-754 Single" /></ParameterType>
            </ParameterTypes>
          </Static>
          <ModuleDefs>
            <ModuleDef Id="${MD1}" Name="One">
              <Arguments>
                <Argument Id="${ARG_BASE}" Name="Base" />
                <Argument Id="${MODE}" Name="Mode" />
              </Arguments>
              <Static>
                <Parameters>
                  <Parameter Id="${MD1}_P-1" ParameterType="${APP}_PT-1" Text="Level" Value="7">
                    <Memory Offset="2" BitOffset="0" BaseOffset="${ARG_BASE}" />
                  </Parameter>
                  <Parameter Id="${MD1}_P-8" ParameterType="${APP}_PT-1" Text="Ref" Value="1">
                    <Memory Offset="3" BitOffset="0" BaseOffset="${ARG_BASE}" />
                  </Parameter>
                  <Parameter Id="${MD1}_P-9" ParameterType="${APP}_PT-F" Text="Gain" Value="0.2">
                    <Memory Offset="6" BitOffset="0" BaseOffset="${ARG_BASE}" />
                  </Parameter>
                  <Union SizeInBit="8">
                    <Memory Offset="4" BitOffset="0" BaseOffset="${ARG_BASE}" />
                    <Parameter Id="${MD1}_UP-3" ParameterType="${APP}_PT-1" Text="Rel" Value="1" Offset="0" BitOffset="0" DefaultUnionParameter="0" />
                    <Parameter Id="${MD1}_UP-4" ParameterType="${APP}_PT-1" Text="Abs" Value="2" Offset="0" BitOffset="0" />
                  </Union>
                  <Parameter Id="${MD1}_P-5" ParameterType="${APP}_PT-1" Text="Selector" Value="0" Access="None" BaseValue="${MODE}" />
                </Parameters>
                <ParameterRefs>
                  <ParameterRef Id="${MD1}_P-1_R-1" RefId="${MD1}_P-1" />
                  <ParameterRef Id="${MD1}_P-8_R-8" RefId="${MD1}_P-8" Value="5" />
                  <ParameterRef Id="${MD1}_P-9_R-9" RefId="${MD1}_P-9" />
                  <ParameterRef Id="${MD1}_UP-3_R-3" RefId="${MD1}_UP-3" />
                  <ParameterRef Id="${MD1}_UP-4_R-4" RefId="${MD1}_UP-4" />
                  <ParameterRef Id="${MD1}_P-5_R-5" RefId="${MD1}_P-5" />
                </ParameterRefs>
              </Static>
              <Dynamic>
                <ParameterRefRef RefId="${MD1}_P-1_R-1" />
                <ParameterRefRef RefId="${MD1}_P-8_R-8" />
                <ParameterRefRef RefId="${MD1}_P-9_R-9" />
                <choose ParamRefId="${MD1}_P-5_R-5">
                  <when test="0"><ParameterRefRef RefId="${MD1}_UP-3_R-3" /></when>
                  <when test="1"><ParameterRefRef RefId="${MD1}_UP-4_R-4" /></when>
                </choose>
              </Dynamic>
            </ModuleDef>
          </ModuleDefs>
          <Dynamic>
            <Channel Id="${CO}" Name="Channel">
              <Module Id="${MD1}_M-1" RefId="${MD1}">
                <NumericArg RefId="${ARG_BASE}" Value="10" />
                <NumericArg RefId="${MODE}" Value="0" />
              </Module>
              <Module Id="${MD1}_M-2" RefId="${MD1}">
                <NumericArg RefId="${ARG_BASE}" Value="20" />
                <NumericArg RefId="${MODE}" Value="1" />
              </Module>
            </Channel>
          </Dynamic>
        </ApplicationProgram>
      </ApplicationPrograms>
    </Manufacturer>
  </ManufacturerData>
</KNX>`;

  const idx = buildAppIndex(Buffer.from(xml, 'utf8'));
  assert.ok(idx);
  const model = idx!.buildParamModel();
  const dynTree = model.dynTree as unknown as DynTree;
  const image = (cv: Record<string, unknown> = {}) => {
    const layout = expandParamMemLayoutForActiveModules(
      model.paramMemLayout as Record<string, ModuleAwareParamMemLayoutEntry>,
      model.baseValueArgIds,
      model.argDefs,
      model.modArgs,
      dynTree,
      model.params as unknown as Record<string, ParamDef>,
      cv,
    );
    return buildParamMem(
      48,
      layout as Record<string, ParamMemEntry>,
      cv,
      0xff,
      null,
      dynTree,
      model.params as unknown as Record<string, ParamDef>,
      model.paramRefValues,
    );
  };

  it('puts every module parameter at base + offset for each instance', () => {
    const buf = image();
    assert.equal(buf[12], 7);
    assert.equal(buf[22], 7);
  });

  it('writes the ParameterRef value for a module parameter, not the Parameter default', () => {
    const buf = image();
    assert.equal(buf[13], 5);
    assert.equal(buf[23], 5);
  });

  it('writes an IEEE-754 Single parameter as four big-endian float bytes', () => {
    const buf = image();
    const expected = Buffer.alloc(4);
    expected.writeFloatBE(0.2);
    assert.deepEqual([...buf.subarray(16, 20)], [...expected]);
    assert.deepEqual([...buf.subarray(26, 30)], [...expected]);
  });

  it("selects the Union alternative for each instance from that instance's BaseValue argument", () => {
    const buf = image();
    assert.equal(buf[14], 1, 'instance 1 (Mode 0) is the default alternative');
    assert.equal(buf[24], 2, 'instance 2 (Mode 1) is the other one');
  });

  it('leaves every byte no instance owns at the fill value', () => {
    const buf = image();
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 20, 21, 30, 31, 47]) {
      assert.equal(buf[i], 0xff, `byte ${i}`);
    }
  });

  it("a per-instance override changes only that instance's bytes", () => {
    const buf = image({ [`${MD1}_M-2_MI-1_P-1_R-1`]: '42' });
    assert.equal(buf[12], 7);
    assert.equal(buf[22], 42);
  });
});
