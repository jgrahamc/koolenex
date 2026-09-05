/**
 * Real-device relmem fixtures for 1.1.9 and 1.1.10 — full param-segment
 * memory read back from live hardware via POST /bus/verify-device
 * (2026-08-26/27), alongside koolenex's own computed "expected" image for
 * the same segment and the specific real MemExtWrite ops ETS sent during a
 * genuine Full Download (captured via tshark; addresses/bytes documented in
 * docs/follow-ups/2026-08-27-relmem-write-scope-investigation.md).
 *
 * Unlike ets-capture-crosscheck.test.ts (which has a *complete* ETS
 * communication-log XML for 1.1.13 and can diff every offset), these two
 * devices only have specific named-parameter offsets confirmed via packet
 * capture, not a full write log. So this suite checks two narrower things:
 *
 *  1. Fixture self-consistency: the real on-device bytes at each captured
 *     write's offset match the captured write bytes exactly (sanity that
 *     the fixtures were saved correctly and ETS's writes actually landed).
 *  2. A regression trip-wire on the actual-vs-computed byte diff count, so
 *     a future change to the image builder gets flagged for review here
 *     even without a full capture log to diff against.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(import.meta.dirname, 'fixtures', 'relmem-real-devices');

function loadHex(name: string): Buffer {
  return Buffer.from(fs.readFileSync(path.join(FIX, name), 'utf8').trim(), 'hex');
}

function loadJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function countDiffs(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'buffers must be same length to diff');
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

describe('real-device relmem fixtures — 1.1.9', () => {
  const actual = loadHex('1.1.9-actual.hex');
  const expected = loadHex('1.1.9-expected-computed.hex');
  const writes = loadJson('full-download-1.1.9-writes.json');

  it('has the documented segment size (8178 bytes)', () => {
    assert.equal(actual.length, 8178);
    assert.equal(expected.length, 8178);
  });

  it('real on-device bytes match every captured ETS write at its offset', () => {
    for (const w of writes.paramWrites) {
      const got = actual
        .subarray(w.offsetFromBase, w.offsetFromBase + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `frame ${w.frame} @ offset ${w.offsetFromBase}: device has ${got}, capture said ${w.hex}`,
      );
    }
  });

  it('actual vs computed-image diff count matches the captured verify-device result (3)', () => {
    assert.equal(countDiffs(actual, expected), 3);
  });
});

describe('real-device relmem fixtures — 1.1.10', () => {
  const actual = loadHex('1.1.10-actual.hex');
  const expected = loadHex('1.1.10-expected-computed.hex');
  const writes = loadJson('full-download-1.1.10-writes.json');

  it('has the documented segment size (10433 bytes)', () => {
    assert.equal(actual.length, 10433);
    assert.equal(expected.length, 10433);
  });

  it('real on-device bytes match every captured ETS write at its offset', () => {
    for (const w of writes.paramWrites) {
      const got = actual
        .subarray(w.offsetFromBase, w.offsetFromBase + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `frame ${w.frame} @ offset ${w.offsetFromBase}: device has ${got}, capture said ${w.hex}`,
      );
    }
  });

  it('actual vs computed-image diff count matches the captured verify-device result (1984)', () => {
    // Large diff count is expected here (unlike 1.1.9). Confirmed 2026-08-29
    // (correcting an earlier, unverified comment here that wrongly blamed a
    // "blind 0xFF/0x00 fill" - buildParamMem() has used the real
    // manufacturer default blob (relSegData) as its base since April 2026,
    // not a blind fill; that comment was never actually checked against the
    // code before being written): every one of these 1984 offsets falls
    // outside any named parameter's byte range (data/apps/*.json
    // paramMemLayout has zero data for them, not wrong data), and their
    // real device values follow an incrementing pattern consistent with
    // device-internal operational/calibration state - not something ETS
    // itself ever writes either (confirmed absent from every real capture
    // this project has for this device, across two independent sessions).
    // This is a trip-wire, not a correctness assertion about the gap bytes.
    assert.equal(countDiffs(actual, expected), 1984);
  });
});

describe('real-device fixture — 1.1.0 (KNX IP router, system/prop device)', () => {
  it('is a prop-family device, not a relmem segment (different verify shape)', () => {
    const d = loadJson('1.1.0-prop-verify.json');
    assert.equal(d.family, 'prop');
    assert.equal(d.segments.length, 0);
    assert.ok(Array.isArray(d.props) && d.props.length > 0);
  });
});

// ── GA/Association table wire format — confirmed 2026-08-28 on real,
// non-degenerate GAs (main/middle both non-zero), settling Finding 3 of
// docs/follow-ups/2026-08-27-relmem-write-scope-investigation.md. These
// decode helpers are an executable spec of the confirmed format, not
// production code (buildGATable()/buildAssocTable() in
// server/routes/knx-tables.ts still use the OLD, wrong format as of this
// writing - implementing the fix is separate follow-up work).
//
// Caveat, don't overclaim: this is still a small sample (2 devices, both
// Albrecht Jung, one supplier) - real, but not proof the format never
// varies by manufacturer/app. Treat as confirmed for these devices/apps,
// a strong working assumption elsewhere, not gospel.

function decodeGaTable(hex: string): { count: number; gas: string[] } {
  const buf = Buffer.from(hex, 'hex');
  const count = buf.readUInt16BE(0);
  const gas: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = buf.readUInt16BE(2 + i * 2);
    const main = (raw >> 11) & 0x1f;
    const mid = (raw >> 8) & 0x07;
    const sub = raw & 0xff;
    gas.push(`${main}/${mid}/${sub}`);
  }
  return { count, gas };
}

function decodeAssocTable(
  hex: string,
): { count: number; entries: Array<{ gaIndex: number; coNumber: number }> } {
  const buf = Buffer.from(hex, 'hex');
  const count = buf.readUInt16BE(0);
  const entries: Array<{ gaIndex: number; coNumber: number }> = [];
  for (let i = 0; i < count; i++) {
    const gaIndex = buf.readUInt16BE(2 + i * 4);
    const coNumber = buf.readUInt16BE(2 + i * 4 + 2);
    entries.push({ gaIndex, coNumber });
  }
  return { count, entries };
}

describe('GA/Association table wire format — real, non-degenerate GAs (1.1.9)', () => {
  const fx = loadJson('ga-assoc-wire-format-1.1.9.json');

  it('GA table decodes to the real project GAs (9/1/1, 9/1/4)', () => {
    const { count, gas } = decodeGaTable(fx.gaTable.hex);
    assert.equal(count, 2);
    assert.deepEqual(gas, ['9/1/1', '9/1/4']);
  });

  it('association table decodes to [gaIndex, coNumber] pairs, 1-based', () => {
    const { count, entries } = decodeAssocTable(fx.associationTable.hex);
    assert.equal(count, 2);
    assert.deepEqual(entries, [
      { gaIndex: 1, coNumber: 5 },
      { gaIndex: 2, coNumber: 8 },
    ]);
  });
});

describe('GA/Association table wire format — real, non-degenerate GAs (1.1.10)', () => {
  const fx = loadJson('ga-assoc-wire-format-1.1.10.json');

  it('GA table decodes to the real project GAs (1/2/1, 1/2/2)', () => {
    const { count, gas } = decodeGaTable(fx.gaTable.hex);
    assert.equal(count, 2);
    assert.deepEqual(gas, ['1/2/1', '1/2/2']);
  });

  it('association table decodes to [gaIndex, coNumber] pairs, 1-based', () => {
    const { count, entries } = decodeAssocTable(fx.associationTable.hex);
    assert.equal(count, 2);
    assert.deepEqual(entries, [
      { gaIndex: 1, coNumber: 31 },
      { gaIndex: 2, coNumber: 32 },
    ]);
  });

  it('association bytes are identical to the earlier degenerate-GA capture', () => {
    // Same 2 GA-table slots (positions 1 and 2), just renumbered - proves
    // association entries reference GA-table POSITION, not raw GA value.
    assert.equal(fx.associationTable.hex, '00020001001F00020020');
  });
});
