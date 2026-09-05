/**
 * Tests for planDownload — the pure AbsoluteSegment (MDT-style) download
 * telegram planner. Fully synthetic: every step list, table, and address here
 * is fictional and constructed inline. No bus, socket, hardware, imported
 * project, or manufacturer product data is involved — planDownload is a pure
 * function and these tests only call it in-process and assert its structural
 * behavior against constructed literals.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planDownload,
  planRelmemWrites,
  planVerify,
  isAbsSegmentProcedure,
  type PlanStep,
  type PlannedOp,
} from '../server/knx-download-plan.ts';

// ── isAbsSegmentProcedure ────────────────────────────────────────────────

describe('isAbsSegmentProcedure', () => {
  it('is false for the legacy RelSegment/WriteRelMem/LoadImageProp style', () => {
    const steps: PlanStep[] = [
      { type: 'WriteProp' },
      { type: 'CompareProp' },
      { type: 'WriteRelMem' },
      { type: 'LoadImageProp' },
    ];
    assert.equal(isAbsSegmentProcedure(steps), false);
  });

  it('is true when Unload/Load/AbsSegment/TaskSegment/LoadCompleted appear', () => {
    assert.equal(isAbsSegmentProcedure([{ type: 'Unload' }]), true);
    assert.equal(isAbsSegmentProcedure([{ type: 'Load' }]), true);
    assert.equal(isAbsSegmentProcedure([{ type: 'AbsSegment' }]), true);
    assert.equal(isAbsSegmentProcedure([{ type: 'TaskSegment' }]), true);
    assert.equal(isAbsSegmentProcedure([{ type: 'LoadCompleted' }]), true);
  });
});

// ── planDownload — structural behavior (all synthetic) ─────────────────────

describe('planDownload synthetic behavior', () => {
  const steps: PlanStep[] = [
    { type: 'Connect' },
    { type: 'Unload', lsmIdx: 1 },
    { type: 'Unload', lsmIdx: 2 },
    { type: 'Load', lsmIdx: 1 },
    { type: 'AbsSegment', lsmIdx: 1, address: 0x4000, size: 3 },
    { type: 'TaskSegment', lsmIdx: 1, address: 0x4000 },
    { type: 'LoadCompleted', lsmIdx: 1 },
    { type: 'Load', lsmIdx: 2 },
    { type: 'AbsSegment', lsmIdx: 2, address: 0x4200, size: 2 },
    { type: 'TaskSegment', lsmIdx: 2, address: 0x4200 },
    { type: 'LoadCompleted', lsmIdx: 2 },
    { type: 'Restart' },
    { type: 'Disconnect' },
  ];

  it('unloads every LSM object before loading any', () => {
    const ops = planDownload(
      steps,
      Buffer.from([0x01, 0xaa, 0xbb]),
      Buffer.alloc(0),
      null,
      null,
    );
    const kinds = ops
      .filter((o) => o.kind === 'propWrite')
      .map((o) => (o as Extract<PlannedOp, { kind: 'propWrite' }>).data[0]);
    // First two propWrites are both UNLOAD (event 4)
    assert.deepEqual(kinds.slice(0, 2), [4, 4]);
  });

  it('address-table segment gets count+1 and a 3-byte-offset entries write', () => {
    const gaTable = Buffer.from([0x02, 0x08, 0x00, 0x08, 0x01]); // count=2, 2 GA entries
    const ops = planDownload(steps, gaTable, Buffer.alloc(0), null, null);
    const memWrites = ops.filter(
      (o): o is Extract<PlannedOp, { kind: 'memWrite' }> =>
        o.kind === 'memWrite',
    );
    assert.equal(memWrites.length, 2);
    assert.equal(memWrites[0]!.addr, 0x4000);
    assert.deepEqual([...memWrites[0]!.bytes], [0x03]); // count 2 + 1 reserved slot
    assert.equal(memWrites[1]!.addr, 0x4003);
    assert.deepEqual([...memWrites[1]!.bytes], [0x08, 0x00, 0x08, 0x01]);
  });

  it('association-table segment is written verbatim (no reserved-slot skip)', () => {
    const assocTable = Buffer.from([0x01, 0x00, 0x00]);
    const ops = planDownload(
      steps,
      Buffer.from([0x00]),
      assocTable,
      null,
      null,
    );
    const memWrites = ops.filter(
      (o): o is Extract<PlannedOp, { kind: 'memWrite' }> =>
        o.kind === 'memWrite',
    );
    const assocWrite = memWrites.find((o) => o.addr === 0x4200);
    assert.ok(assocWrite);
    assert.deepEqual([...assocWrite!.bytes], [0x01, 0x00, 0x00]);
  });

  it('emits connect/restart/disconnect markers when those steps are present', () => {
    const ops = planDownload(
      steps,
      Buffer.from([0x00]),
      Buffer.alloc(0),
      null,
      null,
    );
    assert.equal(ops[0]!.kind, 'connect');
    assert.equal(ops[ops.length - 1]!.kind, 'disconnect');
    assert.ok(ops.some((o) => o.kind === 'restart'));
  });

  it('skips memory writes for AbsSegments with no source buffer (RAM pointer segments)', () => {
    const noBufSteps: PlanStep[] = [
      { type: 'Load', lsmIdx: 3 },
      { type: 'AbsSegment', lsmIdx: 3, address: 0x0700, size: 132 },
      { type: 'LoadCompleted', lsmIdx: 3 },
    ];
    const ops = planDownload(noBufSteps, null, null, null, null, {});
    assert.equal(
      ops.some((o) => o.kind === 'memWrite'),
      false,
    );
    // The descriptor is still emitted
    assert.ok(ops.some((o) => o.kind === 'propWrite' && o.data[0] === 3));
  });

  it('uses absSegData factory seed for segments that are neither addr/assoc/param', () => {
    // Three distinct Load lsmIdx values: the first two are the address/
    // association table convention slots, so the AbsSegment under the third
    // (lsmIdx 3) must fall back to the absSegData factory seed.
    const goSteps: PlanStep[] = [
      { type: 'Load', lsmIdx: 1 },
      { type: 'LoadCompleted', lsmIdx: 1 },
      { type: 'Load', lsmIdx: 2 },
      { type: 'LoadCompleted', lsmIdx: 2 },
      { type: 'Load', lsmIdx: 3 },
      { type: 'AbsSegment', lsmIdx: 3, address: 0x4400, size: 3 },
      { type: 'LoadCompleted', lsmIdx: 3 },
    ];
    const ops = planDownload(goSteps, null, null, null, null, {
      17408: { size: 3, hex: 'aabbcc' },
    });
    const memWrite = ops.find(
      (o): o is Extract<PlannedOp, { kind: 'memWrite' }> =>
        o.kind === 'memWrite',
    );
    assert.ok(memWrite);
    assert.equal(memWrite!.addr, 0x4400);
    assert.deepEqual([...memWrite!.bytes], [0xaa, 0xbb, 0xcc]);
  });

  it('derives the TaskSegment identity bytes from appId, not hardcoded values', () => {
    const taskSteps: PlanStep[] = [
      { type: 'Load', lsmIdx: 1 },
      { type: 'TaskSegment', lsmIdx: 1, address: 0x4000 },
      { type: 'LoadCompleted', lsmIdx: 1 },
    ];
    const ops = planDownload(
      taskSteps,
      null,
      null,
      null,
      null,
      {},
      'M-00AB_A-CDEF-99-1234',
    );
    const desc = ops.find(
      (o): o is Extract<PlannedOp, { kind: 'propWrite' }> =>
        o.kind === 'propWrite' && o.data[0] === 3,
    );
    assert.ok(desc);
    // event=3, subtype=2, addr=0x4000, 01 00, mfg LE (00AB -> AB 00), appNum
    // low byte (CDEF -> EF), version byte (99)
    assert.equal(desc!.data.toString('hex'), '030240000100ab00ef99');
  });
});

describe('planRelmemWrites', () => {
  const STEPS: PlanStep[] = [
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 5 },
  ];
  const PARAM = Buffer.from('0102030405', 'hex');

  it('chunks param memory at base + offset', () => {
    const ops = planRelmemWrites(STEPS, PARAM, { 4: 0x0200 }, 2);
    assert.deepEqual(
      ops.map((o) => o.addr),
      [0x0200, 0x0202, 0x0204],
    );
    assert.equal(
      Buffer.concat(ops.map((o) => o.bytes)).toString('hex'),
      '0102030405',
    );
  });

  it('falls back to base 0 when the objIdx has no resolved base', () => {
    const ops = planRelmemWrites(STEPS, PARAM, {}, 2);
    assert.equal(ops[0]!.addr, 0x0000);
  });
});

// ── planVerify() - undeclaredTableMem (GA/Association/Object 3) ────────────
//
// No dedicated unit tests existed for planVerify() before this - its
// undeclaredTableMem construction was only ever exercised indirectly through
// tests/bus-routes.test.ts's HTTP-level verify-device tests. Added alongside
// Object 3 verify support (2026-08-29) and a real bug fix found while adding
// it (see below).

describe('planVerify() - undeclaredTableMem', () => {
  const GA_TABLE = Buffer.from('0002490149020000', 'hex'); // arbitrary, content doesn't matter for these tests
  const ASSOC_TABLE = Buffer.from('0001000100050000', 'hex');
  const OBJ3_TABLE = Buffer.from('0000000000000000', 'hex');
  const RELMEM_STEPS: PlanStep[] = [
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ];

  it('includes GA/Association/Object 3 regions when the model declares nothing for them (1.1.9\'s real shape)', () => {
    const plan = planVerify(
      RELMEM_STEPS,
      GA_TABLE,
      ASSOC_TABLE,
      Buffer.alloc(4),
      null,
      {},
      '',
      { 1: 0x4000, 2: 0x470a, 3: 0x570c },
      OBJ3_TABLE,
    );
    const labels = plan.undeclaredTableMem.map((r) => r.label);
    assert.ok(labels.some((l) => l.startsWith('gatable@0x4000')));
    assert.ok(labels.some((l) => l.startsWith('assoctable@0x470a')));
    assert.ok(labels.some((l) => l.startsWith('object3@0x570c')));
  });

  it('BUG FIX (2026-08-29): a declared LoadImageProp step must NOT suppress the undeclared-table entries - LoadImageProp is read-only (docs/knx-device-write-protocol.md Part 7), so a model declaring it never actually verifies the table content itself', () => {
    // Before the fix, buildUndeclaredTableMem() (then buildGaAssocMem())
    // counted LoadImageProp the same as WriteRelMem for "already declared" -
    // this silently made verify-device skip comparing GA/Association/
    // Object 3 for an app shaped like 1.1.10's (which declares
    // LoadImageProp for objIdx 1/2/3), the same latent bug already fixed on
    // the write side (knx-connection.ts, koolenex 9eaed85) and the route-
    // level gate (routes/bus.ts) - this was a third, previously-unfixed copy.
    const stepsWithLoadImageProp: PlanStep[] = [
      ...RELMEM_STEPS,
      { type: 'LoadImageProp', objIdx: 1, propId: 27 },
      { type: 'LoadImageProp', objIdx: 2, propId: 27 },
      { type: 'LoadImageProp', objIdx: 3, propId: 27 },
    ];
    const plan = planVerify(
      stepsWithLoadImageProp,
      GA_TABLE,
      ASSOC_TABLE,
      Buffer.alloc(4),
      null,
      {},
      '',
      { 1: 0x4000, 2: 0x470a, 3: 0x570c },
      OBJ3_TABLE,
    );
    const labels = plan.undeclaredTableMem.map((r) => r.label);
    assert.ok(
      labels.some((l) => l.startsWith('gatable@')),
      'GA table should still be verified despite the declared LoadImageProp step',
    );
    assert.ok(
      labels.some((l) => l.startsWith('assoctable@')),
      'Association table should still be verified despite the declared LoadImageProp step',
    );
    assert.ok(
      labels.some((l) => l.startsWith('object3@')),
      'Object 3 should still be verified despite the declared LoadImageProp step',
    );
  });

  it('a genuine WriteRelMem declaration for objIdx 3 correctly suppresses the undeclared Object 3 entry (real content write already covers it)', () => {
    const stepsWithDeclaredObj3: PlanStep[] = [
      ...RELMEM_STEPS,
      { type: 'WriteRelMem', objIdx: 3, offset: 0, size: 8 },
    ];
    const plan = planVerify(
      stepsWithDeclaredObj3,
      GA_TABLE,
      ASSOC_TABLE,
      Buffer.alloc(4),
      null,
      {},
      '',
      { 1: 0x4000, 2: 0x470a, 3: 0x570c },
      OBJ3_TABLE,
    );
    const labels = plan.undeclaredTableMem.map((r) => r.label);
    assert.ok(
      !labels.some((l) => l.startsWith('object3@')),
      'Object 3 should not appear in undeclaredTableMem when a WriteRelMem step already declares it',
    );
  });

  it('omits Object 3 entirely when groupObjectTable is null (app has no groupObjectTableSize)', () => {
    const plan = planVerify(
      RELMEM_STEPS,
      GA_TABLE,
      ASSOC_TABLE,
      Buffer.alloc(4),
      null,
      {},
      '',
      { 1: 0x4000, 2: 0x470a, 3: 0x570c },
      null,
    );
    assert.ok(!plan.undeclaredTableMem.some((r) => r.label.startsWith('object3@')));
    // GA/Association should be entirely unaffected by groupObjectTable being null.
    assert.ok(plan.undeclaredTableMem.some((r) => r.label.startsWith('gatable@')));
  });
});
