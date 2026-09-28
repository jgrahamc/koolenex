/**
 * Tests for planVerify — the pure read-back verification planner that is the
 * safe counterpart of planDownload. It is a PURE function; no bus, socket,
 * hardware, imported project, or manufacturer product data is touched. Every
 * step list, table, and address here is fictional and constructed inline.
 *
 * The central safety invariant proven here:
 *
 *   For an AbsSegment device, planVerify() enumerates exactly the same memory
 *   (address, bytes) that planDownload() would WRITE — so a passing read-back
 *   diff proves the computed bytes are correct without ever programming.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planDownload,
  planVerify,
  type PlanStep,
  type PlannedOp,
} from '../server/knx-download-plan.ts';

// A fully fictional AbsSegment (MDT-style) load procedure: address table under
// LSM 1, association table under LSM 2, and a parameter segment under LSM 3.
const ABS_STEPS: PlanStep[] = [
  { type: 'Connect' },
  { type: 'Unload', lsmIdx: 1 },
  { type: 'Unload', lsmIdx: 2 },
  { type: 'Unload', lsmIdx: 3 },
  { type: 'Load', lsmIdx: 1 },
  { type: 'AbsSegment', lsmIdx: 1, address: 0x4000, size: 7 },
  { type: 'TaskSegment', lsmIdx: 1, address: 0x4000 },
  { type: 'LoadCompleted', lsmIdx: 1 },
  { type: 'Load', lsmIdx: 2 },
  { type: 'AbsSegment', lsmIdx: 2, address: 0x4200, size: 4 },
  { type: 'TaskSegment', lsmIdx: 2, address: 0x4200 },
  { type: 'LoadCompleted', lsmIdx: 2 },
  { type: 'Load', lsmIdx: 3 },
  { type: 'AbsSegment', lsmIdx: 3, address: 0x4400, size: 8 },
  { type: 'TaskSegment', lsmIdx: 3, address: 0x4400 },
  { type: 'LoadCompleted', lsmIdx: 3 },
  { type: 'Restart' },
  { type: 'Disconnect' },
];
const GA_TABLE = Buffer.from([0x03, 0x08, 0x00, 0x08, 0x01, 0x10, 0x00]); // count 3 + 3 GA entries
const ASSOC_TABLE = Buffer.from([0x01, 0x00, 0x00, 0x00]);
const PARAM_MEM = Buffer.from('00112233445566aa', 'hex');
const PARAM_BASE = 0x4400;

describe('planVerify — AbsSegment read-back mirrors planDownload writes', () => {
  const args = [
    ABS_STEPS,
    GA_TABLE,
    ASSOC_TABLE,
    PARAM_MEM,
    PARAM_BASE,
    {},
    'M-00AB_A-CDEF-99-1234',
  ] as const;

  it('mem regions equal planDownload memWrite ops byte-for-byte', () => {
    const ops = planDownload(...args);
    const plan = planVerify(...args);

    assert.equal(plan.family, 'absmem');
    assert.equal(plan.props.length, 0);

    const writes = ops.filter(
      (o): o is Extract<PlannedOp, { kind: 'memWrite' }> =>
        o.kind === 'memWrite' && o.bytes.length > 0,
    );
    assert.ok(writes.length > 0);
    assert.equal(plan.mem.length, writes.length);
    for (let i = 0; i < writes.length; i++) {
      assert.equal(plan.mem[i]!.addr, writes[i]!.addr);
      assert.deepEqual(plan.mem[i]!.expected, writes[i]!.bytes);
    }
  });

  it('covers every byte planDownload would write (no gaps, address-exact)', () => {
    const writeMap = new Map<number, number>();
    for (const op of planDownload(...args))
      if (op.kind === 'memWrite')
        for (let i = 0; i < op.bytes.length; i++)
          writeMap.set(op.addr + i, op.bytes[i]!);

    const verifyMap = new Map<number, number>();
    for (const r of planVerify(...args).mem)
      for (let i = 0; i < r.expected.length; i++)
        verifyMap.set(r.addr + i, r.expected[i]!);

    assert.equal(verifyMap.size, writeMap.size);
    for (const [addr, byte] of writeMap)
      assert.equal(verifyMap.get(addr), byte);
  });
});

describe('planVerify — RelSegment reads paramMem at offsets', () => {
  it('produces a relmem region matching each WriteRelMem segment', () => {
    const steps: PlanStep[] = [
      { type: 'RelSegment' },
      { type: 'WriteRelMem', offset: 0, size: 16 },
    ];
    const paramMem = Buffer.from(
      '00112233445566778899aabbccddeeff0102030405',
      'hex',
    );
    const plan = planVerify(steps, null, null, paramMem, null);
    assert.equal(plan.family, 'relmem');
    assert.equal(plan.mem.length, 1);
    assert.equal(plan.mem[0]!.addr, 0);
    assert.deepEqual(plan.mem[0]!.expected, paramMem.subarray(0, 16));
  });
});

describe('planVerify — property-configured devices', () => {
  // 🟢 CompareProp is a manufacturer-identity
  // PRECONDITION check real ETS runs BEFORE attempting a download (e.g.
  // PID 78/hardware-type) — its own InlineData is a check constant, not
  // post-download configuration, so it must NOT become a verifiable prop
  // entry alongside WriteProp (a real bug, root-caused during a live router
  // test — see
  // `planVerify() - prop family` in knx-download-plan.test.ts for the
  // dedicated regression coverage, including the case where CompareProp and
  // WriteProp target the SAME (objIdx, propId), which is what actually
  // exposed the conflation). This test's title and assertions are updated
  // to match the fixed, correct behavior — only WriteProp is verifiable.
  it('enumerates WriteProp (with data) as property reads, excluding CompareProp', () => {
    const steps: PlanStep[] = [
      { type: 'Connect' },
      {
        type: 'CompareProp',
        objIdx: 0,
        propId: 78,
        data: Buffer.from('aabb', 'hex'),
      },
      {
        type: 'WriteProp',
        objIdx: 0,
        propId: 12,
        data: Buffer.from('01', 'hex'),
      },
      // Empty-payload trigger — not verifiable, must be dropped.
      { type: 'WriteProp', objIdx: 0, propId: 201, data: Buffer.alloc(0) },
      { type: 'Disconnect' },
    ];
    const plan = planVerify(steps, null, null, null, null);
    assert.equal(plan.family, 'prop');
    assert.equal(plan.mem.length, 0);
    assert.equal(
      plan.props.length,
      1,
      'only WriteProp is verifiable — CompareProp is a precondition check, not config',
    );
    assert.deepEqual(plan.props[0], {
      obj: 0,
      pid: 12,
      expected: Buffer.from('01', 'hex'),
      label: 'prop obj=0 pid=12',
    });
  });
});

describe('planVerify — degenerate input', () => {
  it('returns family "none" when nothing is verifiable', () => {
    const plan = planVerify([{ type: 'Connect' }], null, null, null, null);
    assert.equal(plan.family, 'none');
    assert.equal(plan.mem.length, 0);
    assert.equal(plan.props.length, 0);
  });
});

describe('planVerify relmem base resolution', () => {
  const REL_STEPS: PlanStep[] = [
    { type: 'RelSegment', lsmIdx: 4, size: 4 },
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ];
  const PARAM = Buffer.from('deadbeef', 'hex');

  it('reads at offset only when no base is supplied (legacy default)', () => {
    const plan = planVerify(REL_STEPS, null, null, PARAM, null);
    assert.equal(plan.family, 'relmem');
    assert.equal(plan.mem[0]!.addr, 0x0000);
  });

  it('reads at base + offset when a base is supplied for the objIdx', () => {
    const plan = planVerify(REL_STEPS, null, null, PARAM, null, {}, '', {
      4: 0x0200,
    });
    assert.equal(plan.mem[0]!.addr, 0x0200);
    assert.equal(plan.mem[0]!.expected.toString('hex'), 'deadbeef');
  });
});
