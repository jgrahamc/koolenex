/**
 * Tests for KNX table builder functions: buildUnconditionalChannelSet,
 * evalConditionallyActiveParamRefs, collectActiveAssigns, resolveParamSegment,
 * and buildParamMem.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnconditionalChannelSet,
  evalConditionallyActiveParamRefs,
  collectActiveAssigns,
  resolveParamSegment,
  buildParamMem,
} from '../server/routes/knx-tables.ts';

// ── buildUnconditionalChannelSet ────────────────────────────────────────────

describe('buildUnconditionalChannelSet', () => {
  it('returns empty Set for empty dynTree', () => {
    const s = buildUnconditionalChannelSet({});
    assert.equal(s.size, 0);
  });

  it('returns empty Set for null/undefined dynTree', () => {
    assert.equal(buildUnconditionalChannelSet(null).size, 0);
    assert.equal(buildUnconditionalChannelSet(undefined).size, 0);
  });

  it('collects paramRefs from channels', () => {
    const dynTree: any = {
      main: {
        channels: [
          { node: { paramRefs: ['pr1', 'pr2'] } },
          { node: { paramRefs: ['pr3'] } },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['pr1', 'pr2', 'pr3']);
  });

  it('collects paramRefs from nested blocks', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              paramRefs: ['pr1'],
              blocks: [
                { paramRefs: ['pr2'], blocks: [{ paramRefs: ['pr3'] }] },
              ],
            },
          },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['pr1', 'pr2', 'pr3']);
  });

  it('does NOT walk into choices — paramRefs inside choices excluded', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              paramRefs: ['pr1'],
              choices: [
                {
                  paramRefId: 'pr1',
                  whens: [{ test: ['1'], node: { paramRefs: ['pr_hidden'] } }],
                },
              ],
            },
          },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.equal(s.has('pr1'), true);
    assert.equal(s.has('pr_hidden'), false);
  });

  it('collects paramRefs from cib section', () => {
    const dynTree: any = {
      main: {
        cib: [{ paramRefs: ['cib1', 'cib2'] }],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['cib1', 'cib2']);
  });

  it('collects paramRefs from pb section', () => {
    const dynTree: any = {
      main: {
        pb: [{ paramRefs: ['pb1'] }],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s], ['pb1']);
  });

  it('collects from channels, cib, and pb combined', () => {
    const dynTree: any = {
      main: {
        channels: [{ node: { paramRefs: ['ch1'] } }],
        cib: [{ paramRefs: ['cib1'] }],
        pb: [{ paramRefs: ['pb1'] }],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.equal(s.size, 3);
    assert.equal(s.has('ch1'), true);
    assert.equal(s.has('cib1'), true);
    assert.equal(s.has('pb1'), true);
  });
});

// ── evalConditionallyActiveParamRefs ────────────────────────────────────────

describe('evalConditionallyActiveParamRefs', () => {
  it('returns empty Set for empty dynTree', () => {
    const s = evalConditionallyActiveParamRefs({}, {}, {});
    assert.equal(s.size, 0);
  });

  it('returns empty Set for null dynTree', () => {
    const s = evalConditionallyActiveParamRefs(null, {}, {});
    assert.equal(s.size, 0);
  });

  it('marks paramRefs in matched when branch as conditional', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'selector',
                  whens: [
                    { test: ['1'], node: { paramRefs: ['active_pr'] } },
                    { test: ['2'], node: { paramRefs: ['inactive_pr'] } },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { selector: { defaultValue: '1' } };
    const s = evalConditionallyActiveParamRefs(dynTree, params, {});
    assert.equal(s.has('active_pr'), true);
    assert.equal(s.has('inactive_pr'), false);
  });

  it('walks default when if no match found', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'selector',
                  whens: [
                    { test: ['99'], node: { paramRefs: ['no_match_pr'] } },
                    { isDefault: true, node: { paramRefs: ['default_pr'] } },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { selector: { defaultValue: '0' } };
    const s = evalConditionallyActiveParamRefs(dynTree, params, {});
    assert.equal(s.has('default_pr'), true);
    assert.equal(s.has('no_match_pr'), false);
  });

  it('returns empty when no match and no default', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'selector',
                  whens: [{ test: ['99'], node: { paramRefs: ['pr1'] } }],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { selector: { defaultValue: '0' } };
    const s = evalConditionallyActiveParamRefs(dynTree, params, {});
    assert.equal(s.size, 0);
  });

  it('currentValues override defaultValue', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'selector',
                  whens: [
                    { test: ['1'], node: { paramRefs: ['branch1'] } },
                    { test: ['2'], node: { paramRefs: ['branch2'] } },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { selector: { defaultValue: '1' } };
    // currentValues overrides to 2
    const s = evalConditionallyActiveParamRefs(dynTree, params, {
      selector: '2',
    });
    assert.equal(s.has('branch1'), false);
    assert.equal(s.has('branch2'), true);
  });

  it('evaluates nested choices recursively', () => {
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'outer',
                  whens: [
                    {
                      test: ['1'],
                      node: {
                        paramRefs: ['outer_pr'],
                        choices: [
                          {
                            paramRefId: 'inner',
                            whens: [
                              {
                                test: ['5'],
                                node: { paramRefs: ['inner_pr'] },
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = {
      outer: { defaultValue: '1' },
      inner: { defaultValue: '5' },
    };
    const s = evalConditionallyActiveParamRefs(dynTree, params, {});
    assert.equal(s.has('outer_pr'), true);
    assert.equal(s.has('inner_pr'), true);
  });

  it('handles choices at section level (not inside channel node)', () => {
    const dynTree: any = {
      main: {
        choices: [
          {
            paramRefId: 'sec_sel',
            whens: [{ test: ['1'], node: { paramRefs: ['sec_pr'] } }],
          },
        ],
      },
    };
    const params: any = { sec_sel: { defaultValue: '1' } };
    const s = evalConditionallyActiveParamRefs(dynTree, params, {});
    assert.equal(s.has('sec_pr'), true);
  });
});

// ── collectActiveAssigns ────────────────────────────────────────────────────

describe('collectActiveAssigns', () => {
  it('returns empty array when no assigns exist', () => {
    const dynTree: any = {
      main: { channels: [{ node: { paramRefs: ['pr1'] } }] },
    };
    const result = collectActiveAssigns(dynTree, {}, {});
    assert.deepEqual(result, []);
  });

  it('returns empty array for null dynTree', () => {
    const result = collectActiveAssigns(null, {}, {});
    assert.deepEqual(result, []);
  });

  it('collects assigns from active when branch', () => {
    const assign = { target: 'tgt', source: 'src', value: null };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [{ test: ['1'], node: { assigns: [assign] } }],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '1' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].target, 'tgt');
    assert.equal(result[0].source, 'src');
  });

  it('does not collect assigns from inactive when branch', () => {
    const assign = { target: 'tgt', source: null, value: '42' };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [{ test: ['99'], node: { assigns: [assign] } }],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '0' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 0);
  });

  it('collects assigns from default when branch when no match', () => {
    const assign = { target: 'tgt', source: null, value: '10' };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [
                    { test: ['99'], node: { assigns: [] } },
                    { isDefault: true, node: { assigns: [assign] } },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '0' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].value, '10');
  });

  it('collects assigns from top-level channel nodes (not inside choice)', () => {
    const assign = { target: 'tgt', source: null, value: '7' };
    const dynTree: any = {
      main: {
        channels: [{ node: { assigns: [assign] } }],
      },
    };
    const result = collectActiveAssigns(dynTree, {}, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].value, '7');
  });
});

// ── resolveParamSegment ─────────────────────────────────────────────────────

describe('resolveParamSegment', () => {
  it('returns fallback for empty model', () => {
    const result = resolveParamSegment({});
    assert.deepEqual(result, {
      paramSize: 0,
      paramFill: 0xff,
      relSegHex: null,
    });
  });

  it('uses WriteRelMem step size and relSegData', () => {
    const model: any = {
      loadProcedures: [{ type: 'WriteRelMem', size: 64 }],
      relSegData: { 4: 'aabbccdd' },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramSize, 64);
    assert.equal(result.paramFill, 0xff);
    assert.equal(result.relSegHex, 'aabbccdd');
  });

  it('uses RelSegment step with size, fill, and lsmIdx', () => {
    const model: any = {
      loadProcedures: [{ type: 'RelSegment', size: 32, fill: 0x00, lsmIdx: 2 }],
      relSegData: { 2: '11223344' },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramSize, 32);
    assert.equal(result.paramFill, 0x00);
    assert.equal(result.relSegHex, '11223344');
  });

  it('defaults fill to 0xff and lsmIdx to 4 for RelSegment', () => {
    const model: any = {
      loadProcedures: [{ type: 'RelSegment', size: 16 }],
      relSegData: { 4: 'deadbeef' },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramFill, 0xff);
    assert.equal(result.relSegHex, 'deadbeef');
  });

  it('prefers WriteRelMem size over RelSegment size', () => {
    const model: any = {
      loadProcedures: [
        { type: 'WriteRelMem', size: 100 },
        { type: 'RelSegment', size: 50, lsmIdx: 4 },
      ],
      relSegData: { 4: 'aa' },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramSize, 100);
  });

  it('finds AbsoluteSegment covering max param offset', () => {
    const model: any = {
      loadProcedures: [],
      absSegData: {
        seg1: { size: 10, hex: 'aa' },
        seg2: { size: 256, hex: 'bb' },
      },
      paramMemLayout: {
        pr1: { offset: 5 },
        pr2: { offset: 100 },
      },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramSize, 256);
    assert.equal(result.paramFill, 0x00);
    assert.equal(result.relSegHex, 'bb');
  });

  it('falls back to largest AbsoluteSegment when none covers max offset', () => {
    const model: any = {
      loadProcedures: [],
      absSegData: {
        seg1: { size: 10, hex: 'aa' },
        seg2: { size: 50, hex: 'bb' },
      },
      paramMemLayout: {
        pr1: { offset: 200 },
      },
    };
    const result = resolveParamSegment(model);
    // Neither segment covers offset 200, so use largest (50)
    assert.equal(result.paramSize, 50);
    assert.equal(result.paramFill, 0x00);
    assert.equal(result.relSegHex, 'bb');
  });

  it('returns fallback when absSegData exists but paramMemLayout is empty', () => {
    const model: any = {
      loadProcedures: [],
      absSegData: { seg1: { size: 100, hex: 'ff' } },
      paramMemLayout: {},
    };
    const result = resolveParamSegment(model);
    assert.deepEqual(result, {
      paramSize: 0,
      paramFill: 0xff,
      relSegHex: null,
    });
  });
});

// ── buildParamMem ───────────────────────────────────────────────────────────

describe('buildParamMem', () => {
  it('writes basic integer param at correct offset', () => {
    const layout: any = {
      pr1: { offset: 2, bitOffset: 0, bitSize: 8, defaultValue: '42' },
    };
    const buf = buildParamMem(8, layout, {});
    assert.equal(buf[2], 42);
  });

  it('uses fill byte when no relSegHex', () => {
    const buf = buildParamMem(4, {}, {}, 0xab);
    assert.equal(buf[0], 0xab);
    assert.equal(buf[1], 0xab);
    assert.equal(buf[2], 0xab);
    assert.equal(buf[3], 0xab);
  });

  it('uses relSegHex as base buffer', () => {
    const layout: any = {};
    const buf = buildParamMem(4, layout, {}, 0xff, '01020304');
    assert.equal(buf[0], 0x01);
    assert.equal(buf[1], 0x02);
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
  });

  it('relSegHex shorter than size is padded with fill', () => {
    const buf = buildParamMem(6, {}, {}, 0xaa, '0102');
    assert.equal(buf[0], 0x01);
    assert.equal(buf[1], 0x02);
    assert.equal(buf[2], 0xaa);
    assert.equal(buf[3], 0xaa);
  });

  it('currentValues override defaultValue', () => {
    const layout: any = {
      pr1: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '10' },
    };
    const buf = buildParamMem(4, layout, { pr1: '99' });
    assert.equal(buf[0], 99);
  });

  it('skips params with empty/null/undefined values', () => {
    const layout: any = {
      pr1: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '' },
      pr2: { offset: 1, bitOffset: 0, bitSize: 8, defaultValue: null },
      pr3: { offset: 2, bitOffset: 0, bitSize: 8, defaultValue: undefined },
    };
    const buf = buildParamMem(4, layout, {}, 0xff);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xff);
    assert.equal(buf[2], 0xff);
  });

  it('skips params with null offset', () => {
    const layout: any = {
      pr1: { offset: null, bitOffset: 0, bitSize: 8, defaultValue: '42' },
    };
    const buf = buildParamMem(4, layout, {}, 0xff);
    assert.equal(buf[0], 0xff);
  });

  it('writes text param as latin1', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 40,
        defaultValue: 'Hello',
        isText: true,
      },
    };
    const buf = buildParamMem(8, layout, {});
    assert.equal(buf.toString('latin1', 0, 5), 'Hello');
  });

  it('writes float16 param via writeKnxFloat16', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 16,
        defaultValue: '21.0',
        isFloat: true,
      },
    };
    const buf = buildParamMem(4, layout, {});
    // Decode: sign(1) + exponent(4) + mantissa(11)
    const raw = (buf[0] << 8) | buf[1];
    const sign = (raw >> 15) & 1;
    const exp = (raw >> 11) & 0xf;
    const mantissa = raw & 0x7ff;
    const decoded = 0.01 * (sign ? mantissa - 2048 : mantissa) * (1 << exp);
    assert.ok(Math.abs(decoded - 21.0) < 0.1);
  });

  it('writes float32 param via writeFloatBE', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 32,
        defaultValue: '3.14',
        isFloat: true,
      },
    };
    const buf = buildParamMem(8, layout, {});
    const val = buf.readFloatBE(0);
    assert.ok(Math.abs(val - 3.14) < 0.01);
  });

  it('applies coefficient scaling (divides by coefficient)', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '100',
        coefficient: 10,
      },
    };
    const buf = buildParamMem(4, layout, {});
    // 100 / 10 = 10
    assert.equal(buf[0], 10);
  });

  it('applies coefficient scaling to float params', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 32,
        defaultValue: '6.28',
        isFloat: true,
        coefficient: 2,
      },
    };
    const buf = buildParamMem(8, layout, {});
    const val = buf.readFloatBE(0);
    // 6.28 / 2 = 3.14
    assert.ok(Math.abs(val - 3.14) < 0.01);
  });

  it('writes 16-bit integer big-endian', () => {
    const layout: any = {
      pr1: { offset: 0, bitOffset: 0, bitSize: 16, defaultValue: '258' },
    };
    const buf = buildParamMem(4, layout, {});
    assert.equal(buf[0], 1); // 258 >> 8
    assert.equal(buf[1], 2); // 258 & 0xff
  });

  it('processes Assign operations from active dynTree branches', () => {
    const layout: any = {
      sel: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '1' },
      tgt: { offset: 1, bitOffset: 0, bitSize: 8, defaultValue: '0' },
    };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [
                    {
                      test: ['1'],
                      node: {
                        assigns: [{ target: 'tgt', source: null, value: '77' }],
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = {
      sel: { defaultValue: '1' },
      tgt: { defaultValue: '0' },
    };
    const buf = buildParamMem(4, layout, {}, 0xff, null, dynTree, params);
    assert.equal(buf[1], 77);
  });

  it('assign with source reads from source param', () => {
    const layout: any = {
      sel: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '1' },
      src: { offset: 1, bitOffset: 0, bitSize: 8, defaultValue: '55' },
      tgt: { offset: 2, bitOffset: 0, bitSize: 8, defaultValue: '0' },
    };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              assigns: [{ target: 'tgt', source: 'src', value: null }],
            },
          },
        ],
      },
    };
    const params: any = {
      sel: { defaultValue: '1' },
      src: { defaultValue: '55' },
      tgt: { defaultValue: '0' },
    };
    const buf = buildParamMem(4, layout, {}, 0xff, null, dynTree, params);
    // tgt should get src's defaultValue = 55
    assert.equal(buf[2], 55);
  });

  it('conditional visibility: param in unconditional set is written', () => {
    const layout: any = {
      pr1: {
        offset: 0,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '42',
        fromMemoryChild: true,
        isVisible: true,
      },
    };
    const dynTree: any = {
      main: {
        channels: [{ node: { paramRefs: ['pr1'] } }],
      },
    };
    const params: any = { pr1: { defaultValue: '42' } };
    const buf = buildParamMem(4, layout, {}, 0x00, null, dynTree, params);
    assert.equal(buf[0], 42);
  });

  it('conditional visibility: param in conditional active set is written', () => {
    const layout: any = {
      sel: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '1' },
      cond_pr: {
        offset: 1,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '88',
        fromMemoryChild: true,
        isVisible: true,
      },
    };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [{ test: ['1'], node: { paramRefs: ['cond_pr'] } }],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = {
      sel: { defaultValue: '1' },
      cond_pr: { defaultValue: '88' },
    };
    const buf = buildParamMem(4, layout, {}, 0x00, null, dynTree, params);
    assert.equal(buf[1], 88);
  });

  it('conditional visibility: param not in either set is skipped (keeps fill/relSeg default)', () => {
    const layout: any = {
      sel: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '2' },
      cond_pr: {
        offset: 1,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '88',
        fromMemoryChild: true,
        isVisible: true,
      },
    };
    const dynTree: any = {
      main: {
        channels: [
          {
            node: {
              choices: [
                {
                  paramRefId: 'sel',
                  whens: [
                    // cond_pr only active when sel=1, but sel defaults to 2
                    { test: ['1'], node: { paramRefs: ['cond_pr'] } },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const params: any = {
      sel: { defaultValue: '2' },
      cond_pr: { defaultValue: '88' },
    };
    const buf = buildParamMem(4, layout, {}, 0xab, null, dynTree, params);
    // cond_pr should NOT be written because it's not in the active branch
    assert.equal(buf[1], 0xab);
  });

  it('hidden param with user override is written even if not in unconditional set', () => {
    const layout: any = {
      hidden_pr: {
        offset: 0,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '0',
        fromMemoryChild: true,
        isVisible: false,
      },
    };
    const dynTree: any = {
      main: { channels: [] },
    };
    const params: any = { hidden_pr: { defaultValue: '0' } };
    const buf = buildParamMem(
      4,
      layout,
      { hidden_pr: '77' },
      0xff,
      null,
      dynTree,
      params,
    );
    assert.equal(buf[0], 77);
  });
});
