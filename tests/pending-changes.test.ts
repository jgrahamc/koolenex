/**
 * Tests for the device_pending_changes edit log (server/routes/shared.ts,
 * server/db.ts) and its resolution into byte ranges for a partial download
 * (server/routes/bus.ts's resolvePendingWriteRanges()) - added 2026-09-01,
 * replacing an earlier same-day design that peeked the device's own current
 * memory content and diffed it against the target. Real user correction:
 * "I don't want to store a device memory cache. I want to log changes in
 * our DB (e.g. by edits). That is all I am interested in." - and: "please
 * build in logic such that if user re-edits a previous change back to
 * original value, we clear the tracking/undo modified status."
 *
 * markDeviceModifiedIfProgrammed() itself is exercised indirectly, through
 * the real routes that call it (param-values PATCH, GA-link PATCH, flags
 * PATCH) - these are the actual choke points a real edit goes through, and
 * the ones the "re-edit back to original" behavior has to hold for.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, req, type TestServer } from './helpers.ts';
import { _resolvePendingWriteRanges } from '../server/routes/bus.ts';

let ts: TestServer;

before(async () => {
  ts = await createTestServer();
});

after(() => {
  ts.close();
});

// Seeds a project + one device (status 'programmed', a real serial/address
// so the device looks like a genuinely commissioned unit) + one com object.
// Returns {pid, did, coid}.
function seedProject(name: string): { pid: number; did: number; coid: number } {
  ts.db.run(`INSERT INTO projects (name) VALUES (?)`, [name]);
  const pid = ts.db.get<{ id: number }>(
    'SELECT id FROM projects WHERE name=?',
    [name],
  )!.id;
  ts.db.run(
    `INSERT INTO devices (project_id, individual_address, name, has_address, status, param_values) VALUES (?,?,?,?,?,?)`,
    [pid, '1.1.50', 'dev-1.1.50', 1, 'programmed', '{}'],
  );
  const did = ts.db.get<{ id: number }>(
    'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
    [pid, '1.1.50'],
  )!.id;
  ts.db.run(
    `INSERT INTO com_objects (project_id, device_id, object_number, name) VALUES (?,?,?,?)`,
    [pid, did, 3, 'Test CO'],
  );
  const coid = ts.db.get<{ id: number }>(
    'SELECT id FROM com_objects WHERE device_id=? AND object_number=3',
    [did],
  )!.id;
  return { pid, did, coid };
}

function pendingRows(did: number): Array<Record<string, unknown>> {
  return ts.db.all(
    'SELECT * FROM device_pending_changes WHERE device_id=?',
    [did],
  );
}

// ── param_value: create, further-edit, revert-to-original ─────────────────

describe('device_pending_changes via param-values PATCH', () => {
  it('a real edit on a programmed device creates one pending row and flips status to modified', async () => {
    const { pid, did } = seedProject('pv-basic');
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 42,
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as { device_status?: string }).device_status, 'modified');
    const dev = ts.db.get<{ status: string }>('SELECT status FROM devices WHERE id=?', [did]);
    assert.equal(dev!.status, 'modified');
    const rows = pendingRows(did);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'param_value');
    assert.equal(rows[0]!.key, 'ref-1');
    // oldVal was `undefined` (key never existed) - trackPendingChange()
    // stores `oldVal ?? null` (JSON.stringify(undefined) isn't a valid
    // string), so the baseline round-trips as `null`, not `undefined`.
    assert.equal(JSON.parse(rows[0]!.baseline_value as string), null);
    assert.equal(JSON.parse(rows[0]!.current_value as string), 42);
  });

  it('editing the same key again (still not original) updates current_value, keeps baseline, status stays modified', async () => {
    const { pid, did } = seedProject('pv-re-edit');
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 42,
    });
    const r2 = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 77,
    });
    assert.equal((r2.data as { device_status?: string }).device_status, 'modified');
    const rows = pendingRows(did);
    assert.equal(rows.length, 1, 'still exactly one row for this key, not a duplicate');
    assert.equal(JSON.parse(rows[0]!.current_value as string), 77);
  });

  it('real request: editing back to the original value clears the pending row AND undoes modified -> programmed', async () => {
    const { pid, did } = seedProject('pv-revert');
    // Establish a real baseline (10), then change it (42) - the pending
    // row's baseline_value is set from the value seen at THAT first edit,
    // not from whatever the key held before the device existed.
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 10,
    });
    // Downloading resets the baseline for future edits - simulate that
    // directly (the download route itself is covered separately, in
    // bus-routes.test.ts) so this test isolates just the revert logic.
    ts.db.run("DELETE FROM device_pending_changes WHERE device_id=?", [did]);
    ts.db.run("UPDATE devices SET status='programmed' WHERE id=?", [did]);

    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 42,
    });
    assert.equal(pendingRows(did).length, 1);
    assert.equal(
      ts.db.get<{ status: string }>('SELECT status FROM devices WHERE id=?', [did])!.status,
      'modified',
    );

    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 10, // back to the real, last-downloaded value
    });
    assert.equal((r.data as { device_status?: string }).device_status, 'programmed');
    assert.equal(pendingRows(did).length, 0, 'the pending row should be gone');
    assert.equal(
      ts.db.get<{ status: string }>('SELECT status FROM devices WHERE id=?', [did])!.status,
      'programmed',
    );
  });

  it('reverting one of two pending keys leaves the device modified (the other key is still pending)', async () => {
    const { pid, did } = seedProject('pv-two-keys');
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 10,
      'ref-2': 20,
    });
    ts.db.run("DELETE FROM device_pending_changes WHERE device_id=?", [did]);
    ts.db.run("UPDATE devices SET status='programmed' WHERE id=?", [did]);

    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 99,
      'ref-2': 88,
    });
    assert.equal(pendingRows(did).length, 2);

    // Revert ref-1 only - ref-2 is still changed, so the device must stay
    // modified with exactly one pending row remaining.
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 10,
      'ref-2': 88,
    });
    assert.equal((r.data as { device_status?: string }).device_status, 'modified');
    const rows = pendingRows(did);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.key, 'ref-2');

    // Now revert ref-2 too - the device should finally flip back.
    const r2 = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-2': 20,
    });
    assert.equal((r2.data as { device_status?: string }).device_status, 'programmed');
    assert.equal(pendingRows(did).length, 0);
  });

  it('verifyCleared only reports true once - a subsequent edit finds it already cleared', async () => {
    const { pid, did } = seedProject('pv-verify-once');
    ts.db.run('UPDATE devices SET last_verify_match=1, last_verify_at=? WHERE id=?', [
      new Date().toISOString(),
      did,
    ]);
    const r1 = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 5,
    });
    assert.equal((r1.data as { last_verify_match?: null }).last_verify_match, null);
    const r2 = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 9,
    });
    // Second edit: verify was already null, so the route's own
    // `last_verify_match: null` echo should be absent this time (nothing
    // NEW was cleared) - confirms no attempt to "re-clear" or otherwise
    // treat this as a fresh clear event.
    assert.equal('last_verify_match' in (r2.data as object), false);
  });
});

// ── ga_link ─────────────────────────────────────────────────────────────

describe('device_pending_changes via com-object GA-link PATCH', () => {
  it('adding a GA link tracks a ga_link row keyed by object_number and marks modified', async () => {
    const { pid, did, coid } = seedProject('ga-basic');
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/gas`, {
      add: '1/2/3',
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as { device_status?: string }).device_status, 'modified');
    const rows = pendingRows(did);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'ga_link');
    assert.equal(rows[0]!.key, '3');
  });

  it('removing the same link back to the original state clears the row and undoes modified', async () => {
    const { pid, did, coid } = seedProject('ga-revert');
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/gas`, {
      add: '1/2/3',
    });
    assert.equal(pendingRows(did).length, 1);
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/gas`, {
      remove: '1/2/3',
    });
    assert.equal((r.data as { device_status?: string }).device_status, 'programmed');
    assert.equal(pendingRows(did).length, 0);
  });
});

// ── group_object_flag ──────────────────────────────────────────────────────

describe('device_pending_changes via com-object flags PATCH', () => {
  it('changing a flag tracks a group_object_flag row keyed by object_number, composite value', async () => {
    const { pid, did, coid } = seedProject('flags-basic');
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/flags`, {
      write: true,
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as { device_status?: string }).device_status, 'modified');
    const rows = pendingRows(did);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'group_object_flag');
    assert.equal(rows[0]!.key, '3');
    const current = JSON.parse(rows[0]!.current_value as string);
    assert.equal(current.write, true);
  });

  it('flipping the flag back to its original value clears the row and undoes modified', async () => {
    const { pid, did, coid } = seedProject('flags-revert');
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/flags`, {
      write: true,
    });
    assert.equal(pendingRows(did).length, 1);
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/comobjects/${coid}/flags`, {
      write: false,
    });
    assert.equal((r.data as { device_status?: string }).device_status, 'programmed');
    assert.equal(pendingRows(did).length, 0);
  });
});

// ── unassign clears pending changes ────────────────────────────────────────

describe('unassign clears device_pending_changes', () => {
  it('unassigning a device with pending changes clears the tracking table for it', async () => {
    const { pid, did } = seedProject('unassign-clears');
    await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/param-values`, {
      'ref-1': 1,
    });
    assert.equal(pendingRows(did).length, 1);
    const r = await req(ts.baseUrl, 'PATCH', `/projects/${pid}/devices/${did}/unassign`);
    assert.equal(r.status, 200);
    assert.equal(pendingRows(did).length, 0);
  });
});

// ── resolvePendingWriteRanges() ─────────────────────────────────────────────

describe('resolvePendingWriteRanges()', () => {
  it('resolves a param_value key via paramMemLayout to its exact byte offset/length', () => {
    const { did } = seedProject('resolve-param');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-1', 'null', '5'],
    );
    const layout = { 'P-1': { offset: 172, bitOffset: 0, bitSize: 8 } };
    const ranges = _resolvePendingWriteRanges(did, layout);
    assert.deepEqual(ranges[4], [{ offset: 172, length: 1 }]);
  });

  // Real ETS quirk, confirmed 2026-09-01 via a byte-for-byte capture of a
  // genuine real ETS Partial Download: it wrote both the edited byte AND
  // the parameter object's own final byte (a device-required trailer),
  // unconditionally. See resolvePendingWriteRanges()'s own doc comment.
  it('appends the parameter object\'s own final byte (trailer) alongside a real edit, when paramSize is given', () => {
    const { did } = seedProject('resolve-param-trailer');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-1', 'null', '5'],
    );
    const layout = { 'P-1': { offset: 172, bitOffset: 0, bitSize: 8 } };
    const ranges = _resolvePendingWriteRanges(did, layout, 10433);
    assert.deepEqual(ranges[4], [
      { offset: 172, length: 1 },
      { offset: 10432, length: 1 },
    ]);
  });

  it('does not duplicate the trailer byte when the real edit already covers it', () => {
    const { did } = seedProject('resolve-param-trailer-dup');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-1', 'null', '5'],
    );
    const layout = { 'P-1': { offset: 10432, bitOffset: 0, bitSize: 8 } };
    const ranges = _resolvePendingWriteRanges(did, layout, 10433);
    assert.deepEqual(ranges[4], [{ offset: 10432, length: 1 }]);
  });

  it('does not append a trailer byte when paramSize is not given (backward-compatible)', () => {
    const { did } = seedProject('resolve-param-trailer-no-size');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-1', 'null', '5'],
    );
    const layout = { 'P-1': { offset: 172, bitOffset: 0, bitSize: 8 } };
    const ranges = _resolvePendingWriteRanges(did, layout);
    assert.deepEqual(ranges[4], [{ offset: 172, length: 1 }]);
  });

  it('does not append a trailer byte when objIdx 4 has nothing pending at all (e.g. a ga_link-only change)', () => {
    const { did } = seedProject('resolve-param-trailer-no-obj4-activity');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'ga_link', '5', '""', '"1/2/3"'],
    );
    const ranges = _resolvePendingWriteRanges(did, {}, 10433);
    assert.equal(ranges[4], undefined);
  });

  it('spans multiple bytes for a bitfield crossing a byte boundary', () => {
    const { did } = seedProject('resolve-param-multibyte');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-2', 'null', '5'],
    );
    // bitOffset=4, bitSize=12 -> spans from byte `offset` through byte
    // `offset+1` (16 bits total window, 4 used as padding).
    const layout = { 'P-2': { offset: 10, bitOffset: 4, bitSize: 12 } };
    const ranges = _resolvePendingWriteRanges(did, layout);
    assert.deepEqual(ranges[4], [{ offset: 10, length: 2 }]);
  });

  it('a param_value key with no paramMemLayout entry (or offset: null) contributes nothing', () => {
    const { did } = seedProject('resolve-param-missing');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'param_value', 'P-not-mapped', 'null', '5'],
    );
    const ranges = _resolvePendingWriteRanges(did, {});
    assert.equal(ranges[4], undefined);
  });

  it('a ga_link change marks objIdx 1 and 2 with the -1 (whole-table) sentinel, plus the comm object\'s own Object 3 entry', () => {
    const { did } = seedProject('resolve-ga');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'ga_link', '5', '""', '"1/2/3"'],
    );
    const ranges = _resolvePendingWriteRanges(did, {});
    assert.deepEqual(ranges[1], [{ offset: 0, length: -1 }]);
    assert.deepEqual(ranges[2], [{ offset: 0, length: -1 }]);
    assert.deepEqual(ranges[3], [{ offset: 10, length: 2 }]); // object_number 5 * 2
  });

  it('a group_object_flag change marks only the comm object\'s own Object 3 entry (not GA/Association)', () => {
    const { did } = seedProject('resolve-flag');
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [did, 'group_object_flag', '9', '{}', '{"write":true}'],
    );
    const ranges = _resolvePendingWriteRanges(did, {});
    assert.equal(ranges[1], undefined);
    assert.equal(ranges[2], undefined);
    assert.deepEqual(ranges[3], [{ offset: 18, length: 2 }]); // object_number 9 * 2
  });

  it('returns {} when nothing is pending for the device', () => {
    const { did } = seedProject('resolve-empty');
    const ranges = _resolvePendingWriteRanges(did, {});
    assert.deepEqual(ranges, {});
  });
});
