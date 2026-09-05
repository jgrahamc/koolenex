/**
 * Tests for KNX table builder functions: buildUnconditionalChannelSet,
 * evalConditionallyActiveParamRefs, collectActiveAssigns, resolveParamSegment,
 * and buildParamMem.
 *
 * dynTree fixtures use the REAL emitted schema (matches DynItem in
 * server/ets-app.ts): a single recursive `items` array of tagged nodes,
 * `dynTree.main.items -> DynItem[]`, where `type` is one of
 * cib/channel/block/choose/paramRef/assign/... — NOT the legacy
 * channels/cib/pb + paramRefs/blocks/choices shape (that shape is never
 * actually produced by the parser).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUnconditionalChannelSet,
  evalConditionallyActiveParamRefs,
  collectActiveAssigns,
  resolveParamSegment,
  buildParamMem,
  diffMemory,
} from '../server/routes/knx-tables.ts';

// ── diffMemory ──────────────────────────────────────────────────────────────

describe('diffMemory', () => {
  it('reports no differences for identical buffers', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const d = diffMemory(buf, Buffer.from(buf), 0x0100);
    assert.equal(d.total, 4);
    assert.equal(d.differing, 0);
    assert.equal(d.matching, 4);
    assert.deepEqual(d.chunks, []);
  });

  it('coalesces consecutive differing bytes into one chunk with absolute address', () => {
    const expected = Buffer.from([0x00, 0xaa, 0xbb, 0x00, 0x00]);
    const actual = Buffer.from([0x00, 0x11, 0x22, 0x00, 0x00]);
    const d = diffMemory(expected, actual, 0x0100);
    assert.equal(d.differing, 2);
    assert.equal(d.matching, 3);
    assert.equal(d.chunks.length, 1);
    assert.deepEqual(d.chunks[0], {
      address: 0x0101,
      expected: 'aabb',
      actual: '1122',
    });
  });

  it('separates non-adjacent differences into distinct chunks', () => {
    const expected = Buffer.from([0xaa, 0x00, 0x00, 0xbb]);
    const actual = Buffer.from([0x11, 0x00, 0x00, 0x22]);
    const d = diffMemory(expected, actual, 0x2000);
    assert.equal(d.differing, 2);
    assert.equal(d.chunks.length, 2);
    assert.equal(d.chunks[0]!.address, 0x2000);
    assert.equal(d.chunks[1]!.address, 0x2003);
  });

  it('compares only up to the shorter buffer length', () => {
    const expected = Buffer.from([0x01, 0x02, 0x03]);
    const actual = Buffer.from([0x01, 0x99]);
    const d = diffMemory(expected, actual, 0);
    assert.equal(d.total, 2);
    assert.equal(d.differing, 1);
    assert.equal(d.chunks[0]!.address, 1);
  });
});

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

  it('collects paramRefs from channel items', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              { type: 'paramRef', refId: 'pr1' },
              { type: 'paramRef', refId: 'pr2' },
            ],
          },
          { type: 'channel', items: [{ type: 'paramRef', refId: 'pr3' }] },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['pr1', 'pr2', 'pr3']);
  });

  it('collects paramRefs from nested blocks', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              { type: 'paramRef', refId: 'pr1' },
              {
                type: 'block',
                items: [
                  { type: 'paramRef', refId: 'pr2' },
                  {
                    type: 'block',
                    items: [{ type: 'paramRef', refId: 'pr3' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['pr1', 'pr2', 'pr3']);
  });

  it('does NOT walk into choose — paramRefs inside choose excluded', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              { type: 'paramRef', refId: 'pr1' },
              {
                type: 'choose',
                paramRefId: 'pr1',
                whens: [
                  {
                    test: ['1'],
                    isDefault: false,
                    items: [{ type: 'paramRef', refId: 'pr_hidden' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.equal(s.has('pr1'), true);
    assert.equal(s.has('pr_hidden'), false);
  });

  it('collects paramRefs from cib items', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'cib',
            items: [
              { type: 'paramRef', refId: 'cib1' },
              { type: 'paramRef', refId: 'cib2' },
            ],
          },
        ],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s].sort(), ['cib1', 'cib2']);
  });

  it('collects paramRefs from a top-level block', () => {
    const dynTree: any = {
      main: {
        items: [{ type: 'block', items: [{ type: 'paramRef', refId: 'pb1' }] }],
      },
    };
    const s = buildUnconditionalChannelSet(dynTree);
    assert.deepEqual([...s], ['pb1']);
  });

  it('collects from channel, cib, and block items combined', () => {
    const dynTree: any = {
      main: {
        items: [
          { type: 'channel', items: [{ type: 'paramRef', refId: 'ch1' }] },
          { type: 'cib', items: [{ type: 'paramRef', refId: 'cib1' }] },
          { type: 'block', items: [{ type: 'paramRef', refId: 'pb1' }] },
        ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'selector',
                whens: [
                  {
                    test: ['1'],
                    items: [{ type: 'paramRef', refId: 'active_pr' }],
                  },
                  {
                    test: ['2'],
                    items: [{ type: 'paramRef', refId: 'inactive_pr' }],
                  },
                ],
              },
            ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'selector',
                whens: [
                  {
                    test: ['99'],
                    items: [{ type: 'paramRef', refId: 'no_match_pr' }],
                  },
                  {
                    isDefault: true,
                    items: [{ type: 'paramRef', refId: 'default_pr' }],
                  },
                ],
              },
            ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'selector',
                whens: [
                  { test: ['99'], items: [{ type: 'paramRef', refId: 'pr1' }] },
                ],
              },
            ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'selector',
                whens: [
                  {
                    test: ['1'],
                    items: [{ type: 'paramRef', refId: 'branch1' }],
                  },
                  {
                    test: ['2'],
                    items: [{ type: 'paramRef', refId: 'branch2' }],
                  },
                ],
              },
            ],
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

  it('evaluates nested choose recursively', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'outer',
                whens: [
                  {
                    test: ['1'],
                    items: [
                      { type: 'paramRef', refId: 'outer_pr' },
                      {
                        type: 'choose',
                        paramRefId: 'inner',
                        whens: [
                          {
                            test: ['5'],
                            items: [{ type: 'paramRef', refId: 'inner_pr' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
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

  it('handles choose at top level (not inside a channel item)', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'choose',
            paramRefId: 'sec_sel',
            whens: [
              { test: ['1'], items: [{ type: 'paramRef', refId: 'sec_pr' }] },
            ],
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
      main: {
        items: [
          { type: 'channel', items: [{ type: 'paramRef', refId: 'pr1' }] },
        ],
      },
    };
    const result = collectActiveAssigns(dynTree, {}, {});
    assert.deepEqual(result, []);
  });

  it('returns empty array for null dynTree', () => {
    const result = collectActiveAssigns(null, {}, {});
    assert.deepEqual(result, []);
  });

  it('collects assigns from active when branch', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  {
                    test: ['1'],
                    items: [
                      {
                        type: 'assign',
                        target: 'tgt',
                        source: 'src',
                        value: null,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '1' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 1);
    assert.equal(result[0]!.target, 'tgt');
    assert.equal(result[0]!.source, 'src');
  });

  it('does not collect assigns from inactive when branch', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  {
                    test: ['99'],
                    items: [
                      {
                        type: 'assign',
                        target: 'tgt',
                        source: null,
                        value: '42',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '0' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 0);
  });

  it('collects assigns from default when branch when no match', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  { test: ['99'], items: [] },
                  {
                    isDefault: true,
                    items: [
                      {
                        type: 'assign',
                        target: 'tgt',
                        source: null,
                        value: '10',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const params: any = { sel: { defaultValue: '0' } };
    const result = collectActiveAssigns(dynTree, params, {});
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, '10');
  });

  it('collects assigns from top-level channel items (not inside choose)', () => {
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              { type: 'assign', target: 'tgt', source: null, value: '7' },
            ],
          },
        ],
      },
    };
    const result = collectActiveAssigns(dynTree, {}, {});
    assert.equal(result.length, 1);
    assert.equal(result[0]!.value, '7');
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
      paramBase: null,
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
    assert.equal(result.paramBase, null);
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
    assert.equal(result.paramBase, null);
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
        10: { size: 10, hex: 'aa' },
        256: { size: 256, hex: 'bb' },
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
    assert.equal(result.paramBase, 256);
  });

  it('picks the tightest-fitting segment, not merely the first larger one', () => {
    // Reproduces the 1.1.3 (MDT AKS-0416.03) bug: a big, unrelated segment
    // (the address table at 0x4000, size 513) also happens to be larger than
    // maxOffset, but the real parameter segment is the smaller one whose
    // range actually contains the parameter offsets (0x44EC, size 304).
    const model: any = {
      loadProcedures: [],
      absSegData: {
        1792: { size: 132, hex: '' },
        1924: { size: 1, hex: '' },
        16384: { size: 513, hex: 'aa' }, // address table — larger, but wrong
        16897: { size: 511, hex: 'bb' }, // association table
        17408: { size: 236, hex: 'cc' }, // GO table
        17644: { size: 304, hex: 'dd' }, // the real parameter segment
      },
      paramMemLayout: {
        pr1: { offset: 0 },
        pr2: { offset: 302 },
      },
    };
    const result = resolveParamSegment(model);
    assert.equal(result.paramSize, 304);
    assert.equal(result.paramBase, 17644); // 0x44EC
    assert.equal(result.relSegHex, 'dd');
    assert.equal(result.paramFill, 0x00);
  });

  it('falls back to largest AbsoluteSegment when none covers max offset', () => {
    const model: any = {
      loadProcedures: [],
      absSegData: {
        10: { size: 10, hex: 'aa' },
        50: { size: 50, hex: 'bb' },
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
    assert.equal(result.paramBase, 50);
  });

  it('returns fallback when absSegData exists but paramMemLayout is empty', () => {
    const model: any = {
      loadProcedures: [],
      absSegData: { 100: { size: 100, hex: 'ff' } },
      paramMemLayout: {},
    };
    const result = resolveParamSegment(model);
    assert.deepEqual(result, {
      paramSize: 0,
      paramFill: 0xff,
      relSegHex: null,
      paramBase: null,
    });
  });

  it('picks the tightest-fitting AbsoluteSegment when several exceed maxOffset', () => {
    // Two segments both larger than the largest param offset (200): the address
    // table (0x4000, size 512) and the real parameter segment (0x44EC, size
    // 304). resolveParamSegment must pick the SMALLEST covering segment, not
    // the first — otherwise the param image lands at the wrong base.
    const model = {
      loadProcedures: [
        { type: 'Load', lsmIdx: 1 },
        { type: 'AbsSegment', lsmIdx: 1, address: 0x4000, size: 512 },
        { type: 'AbsSegment', lsmIdx: 3, address: 0x44ec, size: 304 },
      ],
      absSegData: {
        '16384': { size: 512, hex: '00' },
        '17644': { size: 304, hex: '00' },
      },
      paramMemLayout: {
        p1: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '0' },
        p2: { offset: 200, bitOffset: 0, bitSize: 8, defaultValue: '0' },
      },
    };
    const result = resolveParamSegment(model as never);
    assert.equal(result.paramBase, 0x44ec);
    assert.equal(result.paramSize, 304);
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  {
                    test: ['1'],
                    items: [
                      {
                        type: 'assign',
                        target: 'tgt',
                        source: null,
                        value: '77',
                      },
                    ],
                  },
                ],
              },
            ],
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
        items: [
          {
            type: 'channel',
            items: [
              { type: 'assign', target: 'tgt', source: 'src', value: null },
            ],
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
        items: [
          { type: 'channel', items: [{ type: 'paramRef', refId: 'pr1' }] },
        ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  {
                    test: ['1'],
                    items: [{ type: 'paramRef', refId: 'cond_pr' }],
                  },
                ],
              },
            ],
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

  // Patch 2 regression test: ETS writes every resolved-ACTIVE parameter
  // regardless of the ParameterRef's UI visibility. A param can be
  // Access="None" (isVisible:false) yet still sit in the currently-active
  // `choose` branch — e.g. MDT P-5014/P-8 (block offset +0x1c) and P-5030
  // (offset +0x31) from the real 1.1.3 gold-data investigation. Before the
  // fix, the gate ANDed in `info.isVisible` and silently dropped these.
  it('conditional visibility: ACTIVE param is written even when isVisible is false', () => {
    const layout: any = {
      sel: { offset: 0, bitOffset: 0, bitSize: 8, defaultValue: '1' },
      cond_pr: {
        offset: 1,
        bitOffset: 0,
        bitSize: 8,
        defaultValue: '88',
        fromMemoryChild: true,
        isVisible: false,
      },
    };
    const dynTree: any = {
      main: {
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  {
                    test: ['1'],
                    items: [{ type: 'paramRef', refId: 'cond_pr' }],
                  },
                ],
              },
            ],
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
        items: [
          {
            type: 'channel',
            items: [
              {
                type: 'choose',
                paramRefId: 'sel',
                whens: [
                  // cond_pr only active when sel=1, but sel defaults to 2
                  {
                    test: ['1'],
                    items: [{ type: 'paramRef', refId: 'cond_pr' }],
                  },
                ],
              },
            ],
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
      main: { items: [] },
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

  // TypeRawData-shaped defaults ("Characteristic curve value domain" and
  // similar) - a manufacturer-shipped, pre-baked binary blob as the whole
  // parameter value, rather than a scalar. Confirmed 2026-08-28 against a
  // real device + its real .knxproj XML: the true wire format is a 4-byte
  // big-endian length prefix followed by the payload (`declaredBytes ===
  // blob.length + 4`, matching `<TypeRawData MaxSize="...">` in the
  // source XML once ets-app.ts's TypeRawData handling reads it correctly -
  // see docs/knx-device-write-protocol.md Part 9 and
  // docs/follow-ups/2026-08-28-full-download-history-and-blob-params.md).
  describe('blob-shaped (TypeRawData) default values', () => {
    it('frames a blob with a 4-byte BE length prefix when declaredBytes matches payload+4', () => {
      // Must decode to enough bytes that its base64 form is >=20 chars (the
      // blob-detection heuristic's own threshold, guarding against
      // mistaking an ordinary short scalar for a blob) - real curve tables
      // are hundreds of bytes, this is just the smallest realistic size
      // for a clean test.
      const payload = Buffer.from(
        Array.from({ length: 20 }, (_, i) => i * 3 + 1),
      ); // 20 bytes
      const layout: any = {
        curve: {
          offset: 2,
          bitOffset: 0,
          bitSize: (payload.length + 4) * 8, // real MaxSize-derived size
          defaultValue: payload.toString('base64'),
        },
      };
      const buf = buildParamMem(30, layout, {}, 0x00);
      // [len:4 BE][payload] starting at offset 2
      assert.equal(buf.readUInt32BE(2), payload.length);
      assert.deepEqual(buf.subarray(6, 6 + payload.length), payload);
    });

    it('writes the raw payload with no framing when declaredBytes does not match a length-prefixed shape (e.g. a stale bitSize=8 cache)', () => {
      const payload = Buffer.from(Array.from({ length: 30 }, (_, i) => i));
      const layout: any = {
        curve: {
          offset: 1,
          bitOffset: 0,
          bitSize: 8, // pre-fix cached value - not payload.length+4
          defaultValue: payload.toString('base64'),
        },
      };
      const buf = buildParamMem(40, layout, {}, 0x00);
      assert.deepEqual(buf.subarray(1, 1 + payload.length), payload);
    });

    it('a short base64-looking scalar (not a real blob) falls through to the generic numeric path unchanged', () => {
      // "12345678901234567890" is >=20 chars and technically valid base64
      // charset, but decodes to only a few bytes - must not be mistaken
      // for a blob and must still be treated as a plain scalar value.
      const layout: any = {
        pr1: {
          offset: 0,
          bitOffset: 0,
          bitSize: 8,
          defaultValue: '99',
        },
      };
      const buf = buildParamMem(4, layout, {}, 0xff);
      assert.equal(buf[0], 99);
    });

    it('conditional-activation gate still governs which of several blob alternates gets written', () => {
      // >=20 bytes each so their base64 form clears the blob-detection
      // heuristic's own length threshold (see the first test above).
      const payloadA = Buffer.from(Array.from({ length: 20 }, () => 0x01));
      const payloadB = Buffer.from(Array.from({ length: 20 }, () => 0x04));
      const layout: any = {
        curveA: {
          offset: 0,
          bitOffset: 0,
          bitSize: (payloadA.length + 4) * 8,
          defaultValue: payloadA.toString('base64'),
          fromMemoryChild: true,
          isVisible: false,
        },
        curveB: {
          offset: 0,
          bitOffset: 0,
          bitSize: (payloadB.length + 4) * 8,
          defaultValue: payloadB.toString('base64'),
          fromMemoryChild: true,
          isVisible: false,
        },
      };
      const dynTree: any = { main: { items: [] } };
      const params: any = {
        curveA: { defaultValue: payloadA.toString('base64') },
        curveB: { defaultValue: payloadB.toString('base64') },
      };
      // Neither is unconditional and neither is explicitly set in
      // currentValues, so neither passes the conditional gate - the
      // segment should be left at its fill value, not either blob.
      const buf = buildParamMem(20, layout, {}, 0x00, null, dynTree, params);
      assert.equal(buf.readUInt32BE(0), 0);
    });
  });

  // Root-caused 2026-08-28 (docs/follow-ups/2026-08-28-write-path-missing-
  // load-sequence.md's "wrong padding-bit fill" section), fixed 2026-08-29
  // as part of working through the write-path capability status memory's
  // open items. Real evidence: a real 1-bit boolean at offset 69 (bitOffset
  // 0, bitSize 1) - real device/ETS value is 0x80 when the flag is on (bit
  // 7 set, all other 7 bits CLEAR), not 0xFF as this function previously
  // computed with the default fill.
  describe('padding-bit fill for sub-byte params (fixed 2026-08-29)', () => {
    it('a 1-bit boolean sharing its byte with unnamed bits: real captured case (offset 69-equivalent), flag ON -> 0x80, not 0xFF', () => {
      const layout: any = {
        flag: { offset: 0, bitOffset: 0, bitSize: 1, defaultValue: '1' },
      };
      const buf = buildParamMem(1, layout, {});
      assert.equal(buf[0], 0x80, 'bit 7 set, all other bits clear - not 0xFF');
    });

    it('same case, flag OFF -> 0x00, not 0x7F', () => {
      const layout: any = {
        flag: { offset: 0, bitOffset: 0, bitSize: 1, defaultValue: '0' },
      };
      const buf = buildParamMem(1, layout, {});
      assert.equal(buf[0], 0x00, 'all bits clear when the flag is off, including the flag bit itself');
    });

    it('genuinely UNNAMED bytes (no parameter touches them at all) still use `fill`, unaffected by the padding-bit fix', () => {
      const layout: any = {
        flag: { offset: 0, bitOffset: 0, bitSize: 1, defaultValue: '1' },
      };
      const buf = buildParamMem(3, layout, {}, 0xff);
      assert.equal(buf[0], 0x80, 'the sub-byte param\'s own byte still gets zero-padding, not fill');
      assert.equal(buf[1], 0xff, 'a byte no parameter touches at all keeps the real fill value');
      assert.equal(buf[2], 0xff);
    });

    it('multiple sub-byte fields sharing one byte: each field\'s own bits are set correctly, the rest is zero', () => {
      // Two independent 1-bit flags packed into the same byte at different
      // bit positions (bitOffset 0 = MSB/bit7, bitOffset 3 = bit4).
      const layout: any = {
        flagA: { offset: 0, bitOffset: 0, bitSize: 1, defaultValue: '1' },
        flagB: { offset: 0, bitOffset: 3, bitSize: 1, defaultValue: '1' },
      };
      const buf = buildParamMem(1, layout, {});
      assert.equal(buf[0], 0x90, 'bit 7 (flagA) and bit 4 (flagB) set, everything else clear');
    });

    it('a byte-aligned (non-sub-byte) param is completely unaffected - keeps using `fill` for its own untouched bytes as before', () => {
      const layout: any = {
        val: { offset: 1, bitOffset: 0, bitSize: 8, defaultValue: '42' },
      };
      const buf = buildParamMem(4, layout, {}, 0xff);
      assert.equal(buf[0], 0xff, 'byte before the param: untouched, real fill');
      assert.equal(buf[1], 42, 'the byte-aligned param itself: fully its own value, not zero-padded');
      assert.equal(buf[3], 0xff, 'byte after the param: untouched, real fill');
    });

    it('a byte already seeded by relSegHex (a real captured default) is NOT re-zeroed by the padding fix - relSegBase already has the real correct value', () => {
      // relSegHex seeds byte 0 with a real captured 0x55 - if a sub-byte
      // param also declared at offset 0 tried to zero-pad it, that would
      // destroy real, already-correct content from an actual device
      // capture, not fix anything.
      const layout: any = {
        flag: { offset: 0, bitOffset: 0, bitSize: 1, defaultValue: '' }, // empty -> skipped by the main loop, only the pre-pass matters here
      };
      const buf = buildParamMem(2, layout, {}, 0xff, '55');
      assert.equal(buf[0], 0x55, 'relSegHex-seeded byte must survive untouched by the padding-bit pre-pass');
    });
  });
});
