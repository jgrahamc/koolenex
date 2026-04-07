/**
 * Tests for DPT encoding/decoding, KNX float16, bit packing,
 * address encoding/decoding, and CEMI frame building/parsing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeDpt,
  decodeDptBuffer,
  encodePhysical,
  decodePhysical,
  encodeGroup,
  decodeGroup,
  buildCEMI,
  parseCEMI,
  MC,
} from '../server/knx-connection.ts';

import {
  writeKnxFloat16,
  writeBits,
  normalizeDptKey,
  decodeRawValue,
  etsTestMatch,
} from '../server/routes/index.ts';

// ── DPT encoding ────────────────────────────────────────────────────────────

describe('encodeDpt', () => {
  it('DPT 1 — boolean on/off', () => {
    assert.deepEqual([...encodeDpt(true, '1.001')], [1]);
    assert.deepEqual([...encodeDpt(false, '1.001')], [0]);
    assert.deepEqual([...encodeDpt('true', '1')], [1]);
    assert.deepEqual([...encodeDpt('false', '1')], [0]);
    assert.deepEqual([...encodeDpt(1, '1.001')], [1]);
    assert.deepEqual([...encodeDpt(0, '1.001')], [0]);
    assert.deepEqual([...encodeDpt('1', '1.003')], [1]);
    assert.deepEqual([...encodeDpt('0', '1.003')], [0]);
  });

  it('DPT 1 — string variants on/off/yes/no/enable', () => {
    assert.deepEqual([...encodeDpt('on', '1.001')], [1]);
    assert.deepEqual([...encodeDpt('off', '1.001')], [0]);
    assert.deepEqual([...encodeDpt('ON', '1.001')], [1]);
    assert.deepEqual([...encodeDpt('OFF', '1.001')], [0]);
    assert.deepEqual([...encodeDpt('yes', '1.001')], [1]);
    assert.deepEqual([...encodeDpt('no', '1.001')], [0]);
    assert.deepEqual([...encodeDpt('enable', '1.001')], [1]);
    assert.deepEqual([...encodeDpt(' On ', '1.001')], [1]);
  });

  it('DPT 5 — 8-bit unsigned', () => {
    assert.deepEqual([...encodeDpt(0, '5.001')], [0x00]);
    assert.deepEqual([...encodeDpt(127, '5.001')], [0x7f]);
    assert.deepEqual([...encodeDpt(255, '5.010')], [0xff]);
  });

  it('DPT 5 — clamps to 0–255', () => {
    assert.deepEqual([...encodeDpt(-10, '5.001')], [0x00]);
    assert.deepEqual([...encodeDpt(999, '5.001')], [0xff]);
  });

  it('DPT 9 — 2-byte KNX float: zero', () => {
    const buf = encodeDpt(0, '9.001');
    assert.equal(buf.length, 2);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1,
      exp = (raw >> 11) & 0xf,
      mant = raw & 0x7ff;
    assert.equal(sign, 0);
    assert.equal(0.01 * mant * Math.pow(2, exp), 0);
  });

  it('DPT 9 — 2-byte KNX float: 21.0°C', () => {
    const buf = encodeDpt(21.0, '9.001');
    assert.equal(buf.length, 2);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1,
      exp = (raw >> 11) & 0xf,
      mant = raw & 0x7ff;
    const v = 0.01 * mant * Math.pow(2, exp) * (sign ? -1 : 1);
    assert(Math.abs(v - 21.0) < 0.1, `decoded ${v} should be ~21.0`);
  });

  it('DPT 9 — 2-byte KNX float: negative value', () => {
    const buf = encodeDpt(-10.5, '9.001');
    assert.equal(buf.length, 2);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1;
    assert.equal(sign, 1, 'sign bit should be set for negative');
  });

  it('DPT 14 — 4-byte IEEE float', () => {
    const buf = encodeDpt(3.14, '14.068');
    assert.equal(buf.length, 4);
    assert(Math.abs(buf.readFloatBE(0) - 3.14) < 0.001);
  });

  it('DPT 14 — negative float', () => {
    const buf = encodeDpt(-273.15, '14.069');
    assert.equal(buf.length, 4);
    assert(Math.abs(buf.readFloatBE(0) - -273.15) < 0.01);
  });

  it('DPT 14 — zero', () => {
    const buf = encodeDpt(0, '14.000');
    assert.equal(buf.readFloatBE(0), 0);
  });

  it('unknown DPT falls back to single byte', () => {
    assert.deepEqual([...encodeDpt(42, '99')], [42]);
    assert.deepEqual([...encodeDpt(256, '99')], [0]); // masked to 0xFF → 0
  });

  it('DPT 9 — NaN input produces a valid buffer', () => {
    const buf = encodeDpt(NaN, '9.001');
    assert.equal(buf.length, 2);
  });

  it('DPT 5 — NaN input clamps to 0', () => {
    assert.deepEqual([...encodeDpt(NaN, '5.001')], [0]);
  });

  it('DPT 14 — NaN input produces NaN float', () => {
    const buf = encodeDpt(NaN, '14.068');
    assert.equal(buf.length, 4);
    assert(isNaN(buf.readFloatBE(0)));
  });
});

// ── DPT decoding ────────────────────────────────────────────────────────────

describe('decodeDptBuffer', () => {
  it('empty buffer returns empty string', () => {
    assert.equal(decodeDptBuffer(Buffer.alloc(0)), '');
    assert.equal(decodeDptBuffer(null), '');
  });

  it('returns hex for any non-empty buffer', () => {
    assert.equal(decodeDptBuffer(Buffer.from([0])), '00');
    assert.equal(decodeDptBuffer(Buffer.from([1])), '01');
    assert.equal(decodeDptBuffer(Buffer.from([42])), '2a');
    assert.equal(decodeDptBuffer(Buffer.from([0x00, 0x00])), '0000');
    assert.equal(decodeDptBuffer(Buffer.from([0xff, 0x80, 0x00])), 'ff8000');
    assert.equal(
      decodeDptBuffer(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
      'deadbeef',
    );
  });
});

// ── DPT 9 encode/decode round-trip ──────────────────────────────────────────

describe('DPT 9 round-trip', () => {
  const testValues = [
    0, 0.5, 1.0, 10.0, 20.5, 21.0, 25.6, -5.0, -10.5, -20.0, -30.0, 40.96,
    100.0, 500.0, -500.0,
  ];

  for (const v of testValues) {
    it(`${v}`, () => {
      const buf = encodeDpt(v, '9.001');
      const decoded = parseFloat(
        decodeRawValue(buf.toString('hex'), '9.001', {}),
      );
      // DPT 9 has limited precision — tolerance depends on exponent
      const tolerance = Math.max(0.5, Math.abs(v) * 0.02);
      assert(
        Math.abs(decoded - v) < tolerance,
        `encode(${v}) → decode = ${decoded}, diff ${Math.abs(decoded - v)}`,
      );
    });
  }
});

// ── writeKnxFloat16 ─────────────────────────────────────────────────────────

describe('writeKnxFloat16', () => {
  it('encodes zero', () => {
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, 0);
    assert.equal(buf.readUInt16BE(0) & 0x7ff, 0, 'mantissa should be 0');
  });

  it('encodes 21.0°C and round-trips', () => {
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, 21.0);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1,
      exp = (raw >> 11) & 0xf,
      mant = raw & 0x7ff;
    const signedMant = sign ? mant - 2048 : mant;
    const v = 0.01 * signedMant * Math.pow(2, exp);
    assert(Math.abs(v - 21.0) < 0.1, `decoded ${v}`);
  });

  it('encodes negative values', () => {
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, -10.0);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1;
    assert.equal(sign, 1, 'sign bit should be set');
    const exp = (raw >> 11) & 0xf,
      mant = raw & 0x7ff;
    const signedMant = mant - 2048;
    const v = 0.01 * signedMant * Math.pow(2, exp);
    assert(Math.abs(v - -10.0) < 0.5, `decoded ${v}`);
  });

  it('writes at correct byte offset', () => {
    const buf = Buffer.alloc(6, 0xff);
    writeKnxFloat16(buf, 2, 0);
    assert.equal(buf[0], 0xff, 'byte 0 untouched');
    assert.equal(buf[1], 0xff, 'byte 1 untouched');
    assert.equal(buf[4], 0xff, 'byte 4 untouched');
    assert.equal(buf[5], 0xff, 'byte 5 untouched');
  });

  it('does not write past buffer end', () => {
    const buf = Buffer.alloc(1, 0xaa);
    writeKnxFloat16(buf, 0, 21.0);
    assert.equal(buf[0], 0xaa, 'too-small buffer should be unchanged');
  });

  it('clamps at exp=15 for values outside DPT 9 range', () => {
    // DPT 9 range is roughly -671088.64 to 670760.96
    // Values beyond this hit the exp>15 guard — result is wrong but shouldn't crash
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, 1e10);
    assert.equal(buf.length, 2, 'should produce 2 bytes without crashing');
  });

  it('handles NaN without crashing', () => {
    const buf = Buffer.alloc(2, 0x00);
    writeKnxFloat16(buf, 0, NaN);
    assert.equal(buf.length, 2);
  });

  it('handles Infinity without crashing', () => {
    const buf = Buffer.alloc(2, 0x00);
    writeKnxFloat16(buf, 0, Infinity);
    assert.equal(buf.length, 2);
  });
});

// ── writeBits ───────────────────────────────────────────────────────────────

describe('writeBits', () => {
  it('writes full byte at offset 0', () => {
    const buf = Buffer.alloc(1);
    writeBits(buf, 0, 0, 8, 0xab);
    assert.equal(buf[0], 0xab);
  });

  it('writes single bit (MSB)', () => {
    const buf = Buffer.from([0x00]);
    writeBits(buf, 0, 0, 1, 1);
    assert.equal(buf[0], 0x80);
  });

  it('writes single bit (LSB)', () => {
    const buf = Buffer.from([0x00]);
    writeBits(buf, 0, 7, 1, 1);
    assert.equal(buf[0], 0x01);
  });

  it('preserves other bits', () => {
    const buf = Buffer.from([0xff]);
    writeBits(buf, 0, 2, 4, 0x00);
    // bits: 11 0000 11 = 0xC3
    assert.equal(buf[0], 0xc3);
  });

  it('writes 4-bit nibble at offset 4', () => {
    const buf = Buffer.from([0x00]);
    writeBits(buf, 0, 4, 4, 0x0f);
    assert.equal(buf[0], 0x0f);
  });

  it('writes 16-bit big-endian value', () => {
    const buf = Buffer.alloc(2);
    writeBits(buf, 0, 0, 16, 0x1234);
    assert.equal(buf[0], 0x12);
    assert.equal(buf[1], 0x34);
  });

  it('writes 32-bit big-endian value', () => {
    const buf = Buffer.alloc(4);
    writeBits(buf, 0, 0, 32, 0xdeadbeef);
    assert.deepEqual([...buf], [0xde, 0xad, 0xbe, 0xef]);
  });

  it('handles sub-byte spanning two bytes', () => {
    const buf = Buffer.from([0x00, 0x00]);
    writeBits(buf, 0, 6, 4, 0x0f);
    // byte 0 bits 6-7: 11 → 0x03, byte 1 bits 0-1: 11 → 0xC0
    assert.equal(buf[0], 0x03);
    assert.equal(buf[1], 0xc0);
  });

  it('does not write past buffer end', () => {
    const buf = Buffer.alloc(1, 0xaa);
    writeBits(buf, 5, 0, 8, 0xff);
    assert.equal(buf[0], 0xaa, 'out-of-bounds write should be no-op');
  });

  it('bitSize 0 is a no-op', () => {
    const buf = Buffer.from([0xaa]);
    writeBits(buf, 0, 0, 0, 0xff);
    assert.equal(buf[0], 0xaa);
  });

  it('negative bitSize is a no-op', () => {
    const buf = Buffer.from([0xaa]);
    writeBits(buf, 0, 0, -1, 0xff);
    assert.equal(buf[0], 0xaa);
  });
});

// ── normalizeDptKey (server) ────────────────────────────────────────────────

describe('normalizeDptKey (server)', () => {
  it('DPST-9-1 → 9.001', () =>
    assert.equal(normalizeDptKey('DPST-9-1'), '9.001'));
  it('DPT-9-1 → 9.001', () =>
    assert.equal(normalizeDptKey('DPT-9-1'), '9.001'));
  it('DPST-14-68 → 14.068', () =>
    assert.equal(normalizeDptKey('DPST-14-68'), '14.068'));
  it('DPST-1-1 → 1.001', () =>
    assert.equal(normalizeDptKey('DPST-1-1'), '1.001'));
  it('9.001 passes through', () =>
    assert.equal(normalizeDptKey('9.001'), '9.001'));
  it('9.1 → 9.001', () => assert.equal(normalizeDptKey('9.1'), '9.001'));
  it('null → null', () => assert.equal(normalizeDptKey(null), null));
  it('empty → null', () => assert.equal(normalizeDptKey(''), null));
  it('case insensitive', () =>
    assert.equal(normalizeDptKey('dpst-5-1'), '5.001'));
});

// ── Address encoding/decoding ───────────────────────────────────────────────

describe('encodePhysical / decodePhysical', () => {
  const cases = [
    ['0.0.0', [0x00, 0x00]],
    ['1.1.1', [0x11, 0x01]],
    ['1.1.5', [0x11, 0x05]],
    ['1.0.60', [0x10, 0x3c]],
    ['15.15.255', [0xff, 0xff]],
    ['2.3.128', [0x23, 0x80]],
  ];

  for (const [addr, bytes] of cases) {
    it(`${addr} → [${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, () => {
      const buf = encodePhysical(addr);
      assert.deepEqual([...buf], bytes);
    });

    it(`[${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}] → ${addr}`, () => {
      assert.equal(decodePhysical(Buffer.from(bytes)), addr);
    });
  }

  it('round-trips all test addresses', () => {
    for (const [addr] of cases) {
      assert.equal(decodePhysical(encodePhysical(addr)), addr);
    }
  });

  it('decodes at a non-zero offset', () => {
    const buf = Buffer.from([0xff, 0xff, 0x11, 0x05, 0xaa]);
    assert.equal(decodePhysical(buf, 2), '1.1.5');
  });

  it('decodes at offset 0 by default', () => {
    const buf = Buffer.from([0x11, 0x05, 0xff, 0xff]);
    assert.equal(decodePhysical(buf), '1.1.5');
  });
});

describe('encodeGroup / decodeGroup', () => {
  const cases = [
    ['0/0/0', [0x00, 0x00]],
    ['1/0/0', [0x08, 0x00]],
    ['1/0/1', [0x08, 0x01]],
    ['11/0/0', [0x58, 0x00]],
    ['31/7/255', [0xff, 0xff]],
    ['2/1/10', [0x11, 0x0a]],
  ];

  for (const [addr, bytes] of cases) {
    it(`${addr} → [${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, () => {
      const buf = encodeGroup(addr);
      assert.deepEqual([...buf], bytes);
    });

    it(`[${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}] → ${addr}`, () => {
      assert.equal(decodeGroup(Buffer.from(bytes)), addr);
    });
  }

  it('round-trips all test addresses', () => {
    for (const [addr] of cases) {
      assert.equal(decodeGroup(encodeGroup(addr)), addr);
    }
  });

  it('decodes at a non-zero offset', () => {
    const buf = Buffer.from([0xaa, 0xbb, 0x08, 0x00, 0xff]);
    assert.equal(decodeGroup(buf, 2), '1/0/0');
  });

  it('decodes at offset 0 by default', () => {
    const buf = Buffer.from([0x08, 0x01, 0xff, 0xff]);
    assert.equal(decodeGroup(buf), '1/0/1');
  });
});

// ── CEMI frame building/parsing ─────────────────────────────────────────────

describe('buildCEMI', () => {
  it('builds a group write frame with correct structure', () => {
    const apdu = Buffer.from([0x00, 0x81]); // GroupValue_Write, data=1
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    assert.equal(cemi[0], MC.REQ, 'message code = L_Data.req');
    assert.equal(cemi[1], 0x00, 'additional info length = 0');
    assert.equal(cemi[2], 0xbc, 'ctrl1');
    assert.equal(cemi[3], 0xe0, 'ctrl2 group flag set');
    // src = 1.1.5 = 0x11, 0x05
    assert.equal(cemi[4], 0x11);
    assert.equal(cemi[5], 0x05);
    // dst = 1/0/0 = 0x08, 0x00
    assert.equal(cemi[6], 0x08);
    assert.equal(cemi[7], 0x00);
    // data length = apdu.length - 1
    assert.equal(cemi[8], apdu.length - 1);
    // APDU follows
    assert.deepEqual([...cemi.slice(9)], [...apdu]);
  });

  it('builds a physical (non-group) frame', () => {
    const apdu = Buffer.from([0x00, 0x00]); // GroupValue_Read
    const cemi = buildCEMI('0.0.0', '1.1.5', apdu, false);
    assert.equal(cemi[3], 0x60, 'ctrl2 group flag not set');
    // dst = 1.1.5 physical = 0x11, 0x05
    assert.equal(cemi[6], 0x11);
    assert.equal(cemi[7], 0x05);
  });

  it('defaults src to 0.0.0 when null', () => {
    const apdu = Buffer.from([0x00, 0x80]);
    const cemi = buildCEMI(null, '1/0/0', apdu, true);
    assert.equal(cemi[4], 0x00);
    assert.equal(cemi[5], 0x00);
  });
});

describe('parseCEMI', () => {
  it('round-trips a group write frame', () => {
    const apdu = Buffer.from([0x00, 0x81]); // GroupValue_Write, data=1
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert(parsed, 'should parse successfully');
    assert.equal(parsed.msgCode, MC.REQ);
    assert.equal(parsed.src, '1.1.5');
    assert.equal(parsed.dst, '1/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'GroupValue_Write');
  });

  it('round-trips a physical frame', () => {
    const apdu = Buffer.from([0x00, 0x00]); // GroupValue_Read
    const cemi = buildCEMI('0.0.0', '1.1.5', apdu, false);
    const parsed = parseCEMI(cemi);
    assert(parsed);
    assert.equal(parsed.src, '0.0.0');
    assert.equal(parsed.dst, '1.1.5');
    assert.equal(parsed.isGroup, false);
    assert.equal(parsed.apciName, 'GroupValue_Read');
  });

  it('extracts APDU data from GroupValue_Write with payload', () => {
    // GroupValue_Write with 2-byte DPT 9 payload
    const enc = encodeDpt(21.0, '9.001');
    const apdu = Buffer.concat([Buffer.from([0x00, 0x80]), enc]); // Write + data
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert(parsed);
    assert.equal(
      parsed.apduData.length,
      2,
      'should extract 2-byte float payload',
    );
  });

  it('extracts short data from GroupValue_Write with 6-bit value', () => {
    const apdu = Buffer.from([0x00, 0x81]); // Write, short data = 1
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert(parsed);
    assert.equal(parsed.apduData.length, 1);
    assert.equal(parsed.apduData[0], 1);
  });

  it('returns null for too-short buffer', () => {
    assert.equal(parseCEMI(Buffer.alloc(5)), null);
  });

  it('returns null for unknown message code', () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0x99; // invalid MC
    assert.equal(parseCEMI(buf), null);
  });

  it('parses at a non-zero offset', () => {
    const apdu = Buffer.from([0x00, 0x81]);
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    const padded = Buffer.concat([Buffer.alloc(4, 0xff), cemi]);
    const parsed = parseCEMI(padded, 4);
    assert(parsed);
    assert.equal(parsed.src, '1.1.5');
    assert.equal(parsed.dst, '1/0/0');
  });

  it('identifies GroupValue_Read', () => {
    const apdu = Buffer.from([0x00, 0x00]);
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert.equal(parsed.apciName, 'GroupValue_Read');
  });

  it('identifies GroupValue_Response', () => {
    const apdu = Buffer.from([0x00, 0x41]); // Response, data=1
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert.equal(parsed.apciName, 'GroupValue_Response');
  });

  it('identifies tpciType as DATA_GROUP for group telegrams', () => {
    const apdu = Buffer.from([0x00, 0x81]);
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const parsed = parseCEMI(cemi);
    assert.equal(parsed.tpciType, 'DATA_GROUP');
  });

  it('parses MC.IND (0x29) frame', () => {
    const apdu = Buffer.from([0x00, 0x81]); // GroupValue_Write, data=1
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    cemi[0] = MC.IND; // patch to indication
    const parsed = parseCEMI(cemi);
    assert(parsed);
    assert.equal(parsed.msgCode, MC.IND);
    assert.equal(parsed.src, '1.1.5');
    assert.equal(parsed.dst, '1/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'GroupValue_Write');
  });

  it('parses MC.CON (0x2E) frame', () => {
    const apdu = Buffer.from([0x00, 0x81]);
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    cemi[0] = MC.CON; // patch to confirmation
    const parsed = parseCEMI(cemi);
    assert(parsed);
    assert.equal(parsed.msgCode, MC.CON);
    assert.equal(parsed.src, '1.1.5');
    assert.equal(parsed.dst, '1/0/0');
    assert.equal(parsed.apciName, 'GroupValue_Write');
  });
});

// ── decodeRawValue (pure DPT-aware decode) ──────────────────────────────────

describe('decodeRawValue', () => {
  it('returns null for missing inputs', () => {
    assert.equal(decodeRawValue(null, '1.001', {}), null);
    assert.equal(decodeRawValue('01', null, {}), null);
    assert.equal(decodeRawValue('', '1.001', {}), null);
  });

  // DPT 1 — boolean with enums
  it('DPT 1: decodes On/Off via enums', () => {
    const info = { enums: { 0: 'Off', 1: 'On' } };
    assert.equal(decodeRawValue('00', '1.001', info), 'Off');
    assert.equal(decodeRawValue('01', '1.001', info), 'On');
  });

  // DPT 1 — without enums
  it('DPT 1: decodes as numeric string without enums', () => {
    assert.equal(decodeRawValue('00', '1.001', {}), '0');
    assert.equal(decodeRawValue('01', '1.001', {}), '1');
  });

  // DPT 5 — 8-bit unsigned
  it('DPT 5: decodes 8-bit unsigned', () => {
    assert.equal(decodeRawValue('00', '5.001', {}), '0');
    assert.equal(decodeRawValue('ff', '5.010', {}), '255');
    assert.equal(decodeRawValue('80', '5.001', {}), '128');
  });

  // DPT 5 — with coefficient (e.g. DPT 5.001 scaling: 100/255)
  it('DPT 5: applies coefficient', () => {
    const info = { coefficient: 100 / 255 };
    assert.equal(decodeRawValue('ff', '5.001', info), '100');
    assert.equal(decodeRawValue('00', '5.001', info), '0');
    // 128 * (100/255) ≈ 50.2
    assert.equal(decodeRawValue('80', '5.001', info), '50.2');
  });

  it('DPT 5: coefficient 0 gives 0', () => {
    assert.equal(decodeRawValue('ff', '5.001', { coefficient: 0 }), '0');
    assert.equal(decodeRawValue('80', '5.001', { coefficient: 0 }), '0');
  });

  it('DPT 7: coefficient 0 gives 0', () => {
    assert.equal(decodeRawValue('ffff', '7.001', { coefficient: 0 }), '0');
  });

  it('DPT 8: coefficient 0 gives 0', () => {
    assert.equal(decodeRawValue('ff9c', '8.001', { coefficient: 0 }), '0');
  });

  // DPT 7 — 16-bit unsigned
  it('DPT 7: decodes 16-bit unsigned', () => {
    assert.equal(decodeRawValue('0000', '7.001', {}), '0');
    assert.equal(decodeRawValue('ffff', '7.001', {}), '65535');
    assert.equal(decodeRawValue('0100', '7.001', {}), '256');
  });

  it('DPT 7: applies coefficient', () => {
    const info = { coefficient: 0.1 };
    assert.equal(decodeRawValue('03e8', '7.002', info), '100'); // 1000 * 0.1
    assert.equal(decodeRawValue('0001', '7.002', info), '0.1');
  });

  // DPT 8 — 16-bit signed
  it('DPT 8: decodes 16-bit signed positive', () => {
    assert.equal(decodeRawValue('0001', '8.001', {}), '1');
    assert.equal(decodeRawValue('7fff', '8.001', {}), '32767');
  });

  it('DPT 8: decodes 16-bit signed negative', () => {
    assert.equal(decodeRawValue('ffff', '8.001', {}), '-1');
    assert.equal(decodeRawValue('8000', '8.001', {}), '-32768');
  });

  it('DPT 8: applies coefficient to signed', () => {
    const info = { coefficient: 0.01 };
    assert.equal(decodeRawValue('ff9c', '8.002', info), '-1'); // -100 * 0.01
    assert.equal(decodeRawValue('0064', '8.002', info), '1'); // 100 * 0.01
  });

  // DPT 9 — 2-byte KNX float
  it('DPT 9: decodes zero', () => {
    assert.equal(decodeRawValue('0000', '9.001', {}), '0.00');
  });

  it('DPT 9: decodes positive temperature', () => {
    // Encode 21.0 then verify decode
    const buf = encodeDpt(21.0, '9.001');
    const hex = buf.toString('hex');
    const decoded = parseFloat(decodeRawValue(hex, '9.001', {}));
    assert(Math.abs(decoded - 21.0) < 0.1, `decoded ${decoded}`);
  });

  it('DPT 9: decodes negative temperature', () => {
    const buf = encodeDpt(-5.0, '9.001');
    const hex = buf.toString('hex');
    const decoded = parseFloat(decodeRawValue(hex, '9.001', {}));
    assert(Math.abs(decoded - -5.0) < 0.5, `decoded ${decoded}`);
  });

  // DPT 14 — 4-byte IEEE float
  it('DPT 14: decodes 4-byte float', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(3.14);
    const decoded = parseFloat(
      decodeRawValue(buf.toString('hex'), '14.068', {}),
    );
    assert(Math.abs(decoded - 3.14) < 0.01, `decoded ${decoded}`);
  });

  it('DPT 14: decodes negative float', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(-273.15);
    const decoded = parseFloat(
      decodeRawValue(buf.toString('hex'), '14.069', {}),
    );
    assert(Math.abs(decoded - -273.15) < 0.1, `decoded ${decoded}`);
  });

  // DPT 20 — HVAC enum
  it('DPT 20: decodes enum value', () => {
    const info = {
      enums: {
        0: 'Auto',
        1: 'Comfort',
        2: 'Standby',
        3: 'Economy',
        4: 'Protection',
      },
    };
    assert.equal(decodeRawValue('01', '20.102', info), 'Comfort');
    assert.equal(decodeRawValue('03', '20.102', info), 'Economy');
  });

  // Unknown buffer size returns null
  it('returns null for 3-byte buffer with unhandled DPT', () => {
    assert.equal(decodeRawValue('aabbcc', '5.001', {}), null);
  });

  it('returns null for 4-byte buffer with unhandled DPT', () => {
    assert.equal(decodeRawValue('aabbccdd', '7.001', {}), null);
  });

  it('returns null for empty hex string', () => {
    assert.equal(decodeRawValue('', '9.001', {}), null);
  });

  it('returns null for invalid hex (odd length)', () => {
    // Buffer.from('f', 'hex') produces empty buffer
    assert.equal(decodeRawValue('f', '5.001', {}), null);
  });

  it('returns null for non-hex characters', () => {
    assert.equal(decodeRawValue('zzzz', '9.001', {}), null);
  });
});

// ── DPT 2 encode/decode ────────────────────────────────────────────────────

describe('DPT 2 — control boolean', () => {
  it('encode from object {control, value}', () => {
    assert.deepEqual([...encodeDpt({ control: 1, value: 1 }, '2.001')], [0x03]);
    assert.deepEqual([...encodeDpt({ control: 1, value: 0 }, '2.001')], [0x02]);
    assert.deepEqual([...encodeDpt({ control: 0, value: 1 }, '2.001')], [0x01]);
    assert.deepEqual([...encodeDpt({ control: 0, value: 0 }, '2.001')], [0x00]);
  });

  it('encode from number 0-3', () => {
    assert.deepEqual([...encodeDpt(3, '2.001')], [0x03]);
    assert.deepEqual([...encodeDpt(0, '2.001')], [0x00]);
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('03', '2.001', {}), 'c=1 v=1');
    assert.equal(decodeRawValue('02', '2.001', {}), 'c=1 v=0');
    assert.equal(decodeRawValue('01', '2.001', {}), 'c=0 v=1');
    assert.equal(decodeRawValue('00', '2.001', {}), 'c=0 v=0');
  });
});

// ── DPT 3 encode/decode ────────────────────────────────────────────────────

describe('DPT 3 — dimming control', () => {
  it('encode from object {control, stepcode}', () => {
    assert.deepEqual(
      [...encodeDpt({ control: 1, stepcode: 7 }, '3.007')],
      [0x0f],
    );
    assert.deepEqual(
      [...encodeDpt({ control: 0, stepcode: 3 }, '3.007')],
      [0x03],
    );
  });

  it('encode from number', () => {
    assert.deepEqual([...encodeDpt(15, '3.007')], [0x0f]);
    assert.deepEqual([...encodeDpt(0, '3.007')], [0x00]);
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('0f', '3.007', {}), 'c=1 step=7');
    assert.equal(decodeRawValue('03', '3.007', {}), 'c=0 step=3');
    assert.equal(decodeRawValue('00', '3.007', {}), 'c=0 step=0');
  });
});

// ── DPT 4 encode/decode ────────────────────────────────────────────────────

describe('DPT 4 — character', () => {
  it('encode single character', () => {
    assert.deepEqual([...encodeDpt('A', '4.001')], [0x41]);
    assert.deepEqual([...encodeDpt('z', '4.001')], [0x7a]);
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('41', '4.001', {}), 'A');
    assert.equal(decodeRawValue('7a', '4.001', {}), 'z');
  });

  it('round-trip', () => {
    const buf = encodeDpt('M', '4.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '4.001', {}), 'M');
  });
});

// ── DPT 6 encode/decode ────────────────────────────────────────────────────

describe('DPT 6 — signed int8', () => {
  it('encode positive', () => {
    const buf = encodeDpt(42, '6.001');
    assert.equal(buf.length, 1);
    assert.equal(buf.readInt8(0), 42);
  });

  it('encode negative', () => {
    const buf = encodeDpt(-100, '6.001');
    assert.equal(buf.readInt8(0), -100);
  });

  it('clamps to range', () => {
    assert.equal(encodeDpt(200, '6.001').readInt8(0), 127);
    assert.equal(encodeDpt(-200, '6.001').readInt8(0), -128);
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('9c', '6.001', {}), '-100'); // 0x9c = -100 signed
    assert.equal(decodeRawValue('2a', '6.001', {}), '42');
  });

  it('round-trip', () => {
    const buf = encodeDpt(-50, '6.010');
    assert.equal(decodeRawValue(buf.toString('hex'), '6.010', {}), '-50');
  });
});

// ── DPT 7 encode ───────────────────────────────────────────────────────────

describe('DPT 7 — encode (16-bit unsigned)', () => {
  it('encode values', () => {
    const buf = encodeDpt(1000, '7.001');
    assert.equal(buf.length, 2);
    assert.equal(buf.readUInt16BE(0), 1000);
  });

  it('clamps to range', () => {
    assert.equal(encodeDpt(70000, '7.001').readUInt16BE(0), 65535);
    assert.equal(encodeDpt(-1, '7.001').readUInt16BE(0), 0);
  });

  it('round-trip', () => {
    const buf = encodeDpt(12345, '7.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '7.001', {}), '12345');
  });
});

// ── DPT 8 encode ───────────────────────────────────────────────────────────

describe('DPT 8 — encode (16-bit signed)', () => {
  it('encode positive', () => {
    const buf = encodeDpt(1000, '8.001');
    assert.equal(buf.length, 2);
    assert.equal(buf.readInt16BE(0), 1000);
  });

  it('encode negative', () => {
    const buf = encodeDpt(-1000, '8.001');
    assert.equal(buf.readInt16BE(0), -1000);
  });

  it('clamps to range', () => {
    assert.equal(encodeDpt(40000, '8.001').readInt16BE(0), 32767);
    assert.equal(encodeDpt(-40000, '8.001').readInt16BE(0), -32768);
  });

  it('round-trip', () => {
    const buf = encodeDpt(-500, '8.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '8.001', {}), '-500');
  });
});

// ── DPT 10 encode/decode ──────────────────────────────────────────────────

describe('DPT 10 — time of day', () => {
  it('encode from object', () => {
    const buf = encodeDpt({ day: 1, hour: 14, min: 30, sec: 0 }, '10.001');
    assert.equal(buf.length, 3);
    assert.equal((buf[0] >> 5) & 0x07, 1); // Monday
    assert.equal(buf[0] & 0x1f, 14); // hour
    assert.equal(buf[1] & 0x3f, 30); // min
    assert.equal(buf[2] & 0x3f, 0); // sec
  });

  it('encode from string', () => {
    const buf = encodeDpt('Wed 08:15:30', '10.001');
    assert.equal((buf[0] >> 5) & 0x07, 3); // Wednesday
    assert.equal(buf[0] & 0x1f, 8);
    assert.equal(buf[1] & 0x3f, 15);
    assert.equal(buf[2] & 0x3f, 30);
  });

  it('decode via decodeRawValue', () => {
    const buf = encodeDpt({ day: 5, hour: 17, min: 45, sec: 10 }, '10.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '10.001', {}),
      'Fri 17:45:10',
    );
  });

  it('decode with no day', () => {
    const buf = encodeDpt({ day: 0, hour: 12, min: 0, sec: 0 }, '10.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '10.001', {}), '12:00:00');
  });

  it('round-trip', () => {
    const buf = encodeDpt('Mon 14:30:00', '10.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '10.001', {}),
      'Mon 14:30:00',
    );
  });
});

// ── DPT 11 encode/decode ──────────────────────────────────────────────────

describe('DPT 11 — date', () => {
  it('encode from object', () => {
    const buf = encodeDpt({ day: 15, month: 3, year: 2024 }, '11.001');
    assert.equal(buf.length, 3);
    assert.equal(buf[0] & 0x1f, 15);
    assert.equal(buf[1] & 0x0f, 3);
    assert.equal(buf[2] & 0x7f, 24); // 2024 - 2000
  });

  it('encode from string', () => {
    const buf = encodeDpt('2024-03-15', '11.001');
    assert.equal(buf[0] & 0x1f, 15);
    assert.equal(buf[1] & 0x0f, 3);
    assert.equal(buf[2] & 0x7f, 24);
  });

  it('encode 1990s date', () => {
    const buf = encodeDpt({ day: 1, month: 1, year: 1995 }, '11.001');
    assert.equal(buf[2] & 0x7f, 95); // 1995 - 1900
  });

  it('decode via decodeRawValue', () => {
    const buf = encodeDpt('2024-03-15', '11.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '11.001', {}),
      '2024-03-15',
    );
  });

  it('decode 1990s date', () => {
    const buf = encodeDpt({ day: 25, month: 12, year: 1995 }, '11.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '11.001', {}),
      '1995-12-25',
    );
  });

  it('round-trip', () => {
    const buf = encodeDpt('2025-06-01', '11.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '11.001', {}),
      '2025-06-01',
    );
  });
});

// ── DPT 12 encode/decode ──────────────────────────────────────────────────

describe('DPT 12 — 32-bit unsigned', () => {
  it('encode', () => {
    const buf = encodeDpt(100000, '12.001');
    assert.equal(buf.length, 4);
    assert.equal(buf.readUInt32BE(0), 100000);
  });

  it('decode via decodeRawValue', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(4294967295);
    assert.equal(
      decodeRawValue(buf.toString('hex'), '12.001', {}),
      '4294967295',
    );
  });

  it('round-trip', () => {
    const buf = encodeDpt(123456, '12.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '12.001', {}), '123456');
  });
});

// ── DPT 13 encode/decode ──────────────────────────────────────────────────

describe('DPT 13 — 32-bit signed', () => {
  it('encode positive', () => {
    const buf = encodeDpt(100000, '13.001');
    assert.equal(buf.length, 4);
    assert.equal(buf.readInt32BE(0), 100000);
  });

  it('encode negative', () => {
    const buf = encodeDpt(-100000, '13.001');
    assert.equal(buf.readInt32BE(0), -100000);
  });

  it('decode via decodeRawValue', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(-1);
    assert.equal(decodeRawValue(buf.toString('hex'), '13.001', {}), '-1');
  });

  it('round-trip', () => {
    const buf = encodeDpt(-999999, '13.002');
    assert.equal(decodeRawValue(buf.toString('hex'), '13.002', {}), '-999999');
  });
});

// ── DPT 16 encode/decode ──────────────────────────────────────────────────

describe('DPT 16 — 14-byte string', () => {
  it('encode pads to 14 bytes', () => {
    const buf = encodeDpt('Hello', '16.000');
    assert.equal(buf.length, 14);
    assert.equal(buf[0], 0x48); // 'H'
    assert.equal(buf[5], 0x00); // null padding
    assert.equal(buf[13], 0x00);
  });

  it('encode truncates to 14 bytes', () => {
    const buf = encodeDpt('This is a very long string!', '16.000');
    assert.equal(buf.length, 14);
  });

  it('decode via decodeRawValue', () => {
    const buf = encodeDpt('Hello', '16.000');
    assert.equal(decodeRawValue(buf.toString('hex'), '16.000', {}), 'Hello');
  });

  it('round-trip', () => {
    const buf = encodeDpt('KNX test 123', '16.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '16.001', {}),
      'KNX test 123',
    );
  });
});

// ── DPT 17 encode/decode ──────────────────────────────────────────────────

describe('DPT 17 — scene number', () => {
  it('encode', () => {
    assert.deepEqual([...encodeDpt(5, '17.001')], [5]);
    assert.deepEqual([...encodeDpt(63, '17.001')], [63]);
    assert.deepEqual([...encodeDpt(64, '17.001')], [0]); // masked to 6 bits
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('05', '17.001', {}), '5');
    assert.equal(decodeRawValue('3f', '17.001', {}), '63');
  });

  it('round-trip', () => {
    const buf = encodeDpt(42, '17.001');
    assert.equal(decodeRawValue(buf.toString('hex'), '17.001', {}), '42');
  });
});

// ── DPT 18 encode/decode ──────────────────────────────────────────────────

describe('DPT 18 — scene control', () => {
  it('encode from object — activate', () => {
    const buf = encodeDpt({ control: 0, scene: 5 }, '18.001');
    assert.deepEqual([...buf], [0x05]);
  });

  it('encode from object — learn', () => {
    const buf = encodeDpt({ control: 1, scene: 5 }, '18.001');
    assert.deepEqual([...buf], [0x85]);
  });

  it('decode via decodeRawValue — activate', () => {
    assert.equal(decodeRawValue('05', '18.001', {}), 'activate scene 5');
  });

  it('decode via decodeRawValue — learn', () => {
    assert.equal(decodeRawValue('85', '18.001', {}), 'learn scene 5');
  });

  it('round-trip activate', () => {
    const buf = encodeDpt({ control: 0, scene: 10 }, '18.001');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '18.001', {}),
      'activate scene 10',
    );
  });
});

// ── DPT 19 encode/decode ──────────────────────────────────────────────────

describe('DPT 19 — date/time', () => {
  it('encode from Date object', () => {
    const dt = new Date(2024, 2, 15, 14, 30, 45); // March 15, 2024
    const buf = encodeDpt(dt, '19.001');
    assert.equal(buf.length, 8);
    assert.equal(buf[0], 124); // 2024 - 1900
    assert.equal(buf[1] & 0x0f, 3); // March
    assert.equal(buf[2] & 0x1f, 15); // day 15
    assert.equal(buf[3] & 0x1f, 14); // hour
    assert.equal(buf[4] & 0x3f, 30); // min
    assert.equal(buf[5] & 0x3f, 45); // sec
  });

  it('decode via decodeRawValue', () => {
    const dt = new Date(2024, 2, 15, 14, 30, 45);
    const buf = encodeDpt(dt, '19.001');
    const decoded = decodeRawValue(buf.toString('hex'), '19.001', {});
    assert(decoded.startsWith('2024-03-15T14:30:45'), `got: ${decoded}`);
  });
});

// ── DPT 20 encode ─────────────────────────────────────────────────────────

describe('DPT 20 — 8-bit enum encode', () => {
  it('encode byte value', () => {
    assert.deepEqual([...encodeDpt(2, '20.102')], [0x02]);
    assert.deepEqual([...encodeDpt(0, '20.102')], [0x00]);
  });

  it('decode with enums', () => {
    const info = { enums: { 0: 'Auto', 1: 'Comfort', 2: 'Standby' } };
    assert.equal(decodeRawValue('02', '20.102', info), 'Standby');
  });

  it('decode without enums', () => {
    assert.equal(decodeRawValue('02', '20.102', {}), '2');
  });
});

// ── DPT 232 encode/decode ─────────────────────────────────────────────────

describe('DPT 232 — RGB colour', () => {
  it('encode from object', () => {
    const buf = encodeDpt({ r: 255, g: 128, b: 0 }, '232.600');
    assert.deepEqual([...buf], [255, 128, 0]);
  });

  it('encode from hex string', () => {
    const buf = encodeDpt('#ff8000', '232.600');
    assert.deepEqual([...buf], [255, 128, 0]);
  });

  it('encode from csv string', () => {
    const buf = encodeDpt('255,128,0', '232.600');
    assert.deepEqual([...buf], [255, 128, 0]);
  });

  it('decode via decodeRawValue', () => {
    assert.equal(decodeRawValue('ff8000', '232.600', {}), '#ff8000');
  });

  it('round-trip', () => {
    const buf = encodeDpt({ r: 10, g: 20, b: 30 }, '232.600');
    assert.equal(decodeRawValue(buf.toString('hex'), '232.600', {}), '#0a141e');
  });
});

// ── DPT 242 encode/decode ─────────────────────────────────────────────────

describe('DPT 242 — xyY colour', () => {
  it('encode from object', () => {
    const buf = encodeDpt({ x: 0.5, y: 0.5, brightness: 128 }, '242.600');
    assert.equal(buf.length, 6);
    // x = 0.5 * 65535 = 32768 (rounded)
    assert.equal(buf.readUInt16BE(0), 32768);
    assert.equal(buf.readUInt16BE(2), 32768);
    assert.equal(buf[4], 128);
    assert.equal(buf[5], 0x03); // both colour and brightness valid
  });

  it('decode via decodeRawValue', () => {
    const buf = Buffer.alloc(6);
    buf.writeUInt16BE(8061, 0); // x ~ 0.123
    buf.writeUInt16BE(29884, 2); // y ~ 0.456
    buf[4] = 199; // ~78%
    buf[5] = 0x03;
    const decoded = decodeRawValue(buf.toString('hex'), '242.600', {});
    assert(decoded.startsWith('xyY('), `got: ${decoded}`);
  });

  it('round-trip preserves approximate values', () => {
    const buf = encodeDpt({ x: 0.3, y: 0.6, brightness: 200 }, '242.600');
    const decoded = decodeRawValue(buf.toString('hex'), '242.600', {});
    assert(decoded.includes('xyY('), `got: ${decoded}`);
    // x should be ~0.300
    const m = decoded.match(/xyY\(([\d.]+), ([\d.]+), (\d+)%\)/);
    assert(m, `unexpected format: ${decoded}`);
    assert(Math.abs(parseFloat(m[1]) - 0.3) < 0.001);
    assert(Math.abs(parseFloat(m[2]) - 0.6) < 0.001);
  });
});

// ── DPT 251 encode/decode ─────────────────────────────────────────────────

describe('DPT 251 — RGBW colour', () => {
  it('encode from object', () => {
    const buf = encodeDpt({ r: 255, g: 128, b: 0, w: 200 }, '251.600');
    assert.equal(buf.length, 6);
    assert.equal(buf[0], 255);
    assert.equal(buf[1], 128);
    assert.equal(buf[2], 0);
    assert.equal(buf[3], 200);
    assert.equal(buf[4], 0); // reserved
    assert.equal(buf[5], 0x0f); // all valid
  });

  it('encode from hex string', () => {
    const buf = encodeDpt('#ff8000c8', '251.600');
    assert.deepEqual([buf[0], buf[1], buf[2], buf[3]], [255, 128, 0, 200]);
    assert.equal(buf[5], 0x0f);
  });

  it('decode via decodeRawValue', () => {
    const buf = encodeDpt({ r: 255, g: 128, b: 0, w: 200 }, '251.600');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '251.600', {}),
      'RGBW(255,128,0,200)',
    );
  });
});

// ── Edge cases for DPT encode/decode ───────────────────────────────────────

describe('DPT encode edge cases', () => {
  // DPT 2: missing object keys
  it('DPT 2: missing control/value keys default to 0', () => {
    assert.deepEqual([...encodeDpt({}, '2.001')], [0x00]);
    assert.deepEqual([...encodeDpt({ control: 1 }, '2.001')], [0x02]);
    assert.deepEqual([...encodeDpt({ value: 1 }, '2.001')], [0x01]);
  });

  // DPT 3: stepcode > 7 is masked
  it('DPT 3: stepcode > 7 is masked to 3 bits', () => {
    assert.deepEqual(
      [...encodeDpt({ control: 0, stepcode: 15 }, '3.007')],
      [0x07],
    );
    assert.deepEqual(
      [...encodeDpt({ control: 1, stepcode: 8 }, '3.007')],
      [0x08],
    ); // 8 & 0x07 = 0, so (1<<3)|0 = 8
  });

  // DPT 4: empty string
  it('DPT 4: empty string produces [0]', () => {
    assert.deepEqual([...encodeDpt('', '4.001')], [0x00]);
  });

  // DPT 10: invalid day name
  it('DPT 10: invalid day name defaults to day=0', () => {
    const buf = encodeDpt('Xyz 12:00:00', '10.001');
    assert.equal((buf[0] >> 5) & 0x07, 0); // day = 0 (no day)
    assert.equal(buf[0] & 0x1f, 12); // hour still parsed
  });

  // DPT 10: non-matching string
  it('DPT 10: non-matching string defaults to all zeros', () => {
    const buf = encodeDpt('garbage', '10.001');
    assert.deepEqual([...buf], [0, 0, 0]);
  });

  // DPT 11: year outside 1990-2089 range throws
  it('DPT 11: year < 1990 throws RangeError', () => {
    assert.throws(
      () => encodeDpt({ day: 1, month: 1, year: 1985 }, '11.001'),
      RangeError,
    );
  });

  it('DPT 11: day out of range throws RangeError', () => {
    assert.throws(
      () => encodeDpt({ day: 0, month: 1, year: 2000 }, '11.001'),
      RangeError,
    );
    assert.throws(
      () => encodeDpt({ day: 32, month: 1, year: 2000 }, '11.001'),
      RangeError,
    );
  });

  it('DPT 11: month out of range throws RangeError', () => {
    assert.throws(
      () => encodeDpt({ day: 1, month: 0, year: 2000 }, '11.001'),
      RangeError,
    );
    assert.throws(
      () => encodeDpt({ day: 1, month: 13, year: 2000 }, '11.001'),
      RangeError,
    );
  });

  it('DPT 11: year > 2089 throws RangeError', () => {
    assert.throws(
      () => encodeDpt({ day: 1, month: 1, year: 2090 }, '11.001'),
      RangeError,
    );
  });

  // DPT 12: negative input
  it('DPT 12: negative input clamps to 0', () => {
    const buf = encodeDpt(-5, '12.001');
    assert.equal(buf.readUInt32BE(0), 0);
  });

  // DPT 12: boundary values
  it('DPT 12: boundary values', () => {
    assert.equal(encodeDpt(0, '12.001').readUInt32BE(0), 0);
    assert.equal(encodeDpt(4294967295, '12.001').readUInt32BE(0), 4294967295);
  });

  // DPT 13: boundary values
  it('DPT 13: boundary values', () => {
    assert.equal(encodeDpt(2147483647, '13.001').readInt32BE(0), 2147483647);
    assert.equal(encodeDpt(-2147483648, '13.001').readInt32BE(0), -2147483648);
  });

  // DPT 16: empty string produces 14 null bytes
  it('DPT 16: empty string produces 14 null bytes', () => {
    const buf = encodeDpt('', '16.000');
    assert.equal(buf.length, 14);
    for (let i = 0; i < 14; i++) assert.equal(buf[i], 0x00);
  });

  // DPT 18: raw number input
  it('DPT 18: raw number input', () => {
    assert.deepEqual([...encodeDpt(0x85, '18.001')], [0x85]); // learn scene 5
    assert.deepEqual([...encodeDpt(5, '18.001')], [0x05]); // activate scene 5
  });

  // DPT 19: string date input
  it('DPT 19: encode from ISO string', () => {
    const buf = encodeDpt('2024-03-15T14:30:45', '19.001');
    assert.equal(buf[0], 124); // 2024 - 1900
    assert.equal(buf[1] & 0x0f, 3); // March
    assert.equal(buf[2] & 0x1f, 15);
    assert.equal(buf[3] & 0x1f, 14);
    assert.equal(buf[4] & 0x3f, 30);
    assert.equal(buf[5] & 0x3f, 45);
  });

  // DPT 232: values clamped by & 0xff
  it('DPT 232: values > 255 are masked', () => {
    const buf = encodeDpt({ r: 300, g: -10, b: 256 }, '232.600');
    assert.equal(buf[0], 300 & 0xff); // 44
    assert.equal(buf[1], -10 & 0xff); // 246
    assert.equal(buf[2], 256 & 0xff); // 0
  });

  // DPT 242: x/y outside 0-1 are clamped
  it('DPT 242: x/y outside 0-1 are clamped', () => {
    const buf = encodeDpt({ x: 1.5, y: -0.5, brightness: 128 }, '242.600');
    assert.equal(buf.readUInt16BE(0), 65535); // clamped to 1.0
    assert.equal(buf.readUInt16BE(2), 0); // clamped to 0.0
  });

  // DPT 251: partial hex string (< 9 chars)
  it('DPT 251: short hex string produces zeros', () => {
    const buf = encodeDpt('#ff80', '251.600');
    // too short for RGBW hex, falls through to alloc(6, 0)
    assert.equal(buf.length, 6);
    assert.deepEqual([...buf], [0, 0, 0, 0, 0, 0]);
  });
});

describe('DPT decode edge cases', () => {
  // DPT 6: coefficient application
  it('DPT 6: coefficient applied to signed value', () => {
    const buf = Buffer.alloc(1);
    buf.writeInt8(-100);
    // coefficient is applied in the generic 1-byte path, but DPT 6 returns signed first
    // DPT 6 has its own decode path returning signed string
    assert.equal(decodeRawValue(buf.toString('hex'), '6.001', {}), '-100');
  });

  // DPT 12: boundary decode
  it('DPT 12: decode 0 and max', () => {
    const zero = Buffer.alloc(4, 0);
    assert.equal(decodeRawValue(zero.toString('hex'), '12.001', {}), '0');
    const max = Buffer.alloc(4);
    max.writeUInt32BE(4294967295);
    assert.equal(
      decodeRawValue(max.toString('hex'), '12.001', {}),
      '4294967295',
    );
  });

  // DPT 13: boundary decode
  it('DPT 13: decode min and max', () => {
    const max = Buffer.alloc(4);
    max.writeInt32BE(2147483647);
    assert.equal(
      decodeRawValue(max.toString('hex'), '13.001', {}),
      '2147483647',
    );
    const min = Buffer.alloc(4);
    min.writeInt32BE(-2147483648);
    assert.equal(
      decodeRawValue(min.toString('hex'), '13.001', {}),
      '-2147483648',
    );
  });

  // DPT 12: coefficient
  it('DPT 12: applies coefficient', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(1000);
    assert.equal(
      decodeRawValue(buf.toString('hex'), '12.001', { coefficient: 0.001 }),
      '1',
    );
  });

  // DPT 13: coefficient
  it('DPT 13: applies coefficient', () => {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(-1000);
    assert.equal(
      decodeRawValue(buf.toString('hex'), '13.001', { coefficient: 0.01 }),
      '-10',
    );
  });

  // DPT 16: non-ASCII (Latin-1)
  it('DPT 16: decodes Latin-1 characters', () => {
    const buf = Buffer.alloc(14, 0x00);
    buf[0] = 0xc4; // Ä
    buf[1] = 0xd6; // Ö
    buf[2] = 0xdc; // Ü
    const decoded = decodeRawValue(buf.toString('hex'), '16.001', {});
    assert.equal(decoded, 'ÄÖÜ');
  });

  // DPT 16: full 14-byte string (no null terminator)
  it('DPT 16: decodes full 14-byte string without null', () => {
    const buf = Buffer.alloc(14);
    buf.write('12345678901234', 'latin1');
    assert.equal(
      decodeRawValue(buf.toString('hex'), '16.000', {}),
      '12345678901234',
    );
  });

  // DPT 19: direct hex decode (not via encode round-trip)
  it('DPT 19: decode from known hex', () => {
    // 2024-03-15 14:30:45 = year 124 (0x7c), month 3, day 15 (0x0f)
    // Octet 3: (dayOfWeek << 5) | dayOfMonth — skip dow: (0 << 5) | 15 = 0x0f
    // Hour 14 = 0x0e, min 30 = 0x1e, sec 45 = 0x2d
    const hex = '7c030f0e1e2d0000';
    const decoded = decodeRawValue(hex, '19.001', {});
    assert.equal(decoded, '2024-03-15T14:30:45');
  });

  // DPT 10: all day names
  it('DPT 10: decode all day names', () => {
    const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let d = 1; d <= 7; d++) {
      const buf = encodeDpt({ day: d, hour: 0, min: 0, sec: 0 }, '10.001');
      const decoded = decodeRawValue(buf.toString('hex'), '10.001', {});
      assert(decoded.startsWith(DAYS[d]), `day ${d}: got ${decoded}`);
    }
  });

  // DPT 17: decode masks upper bits
  it('DPT 17: upper bits ignored', () => {
    assert.equal(decodeRawValue('c5', '17.001', {}), '5'); // 0xC5 & 0x3F = 5
  });

  // DPT 18: decode all combinations
  it('DPT 18: decode scene 0 and 63', () => {
    assert.equal(decodeRawValue('00', '18.001', {}), 'activate scene 0');
    assert.equal(decodeRawValue('3f', '18.001', {}), 'activate scene 63');
    assert.equal(decodeRawValue('80', '18.001', {}), 'learn scene 0');
    assert.equal(decodeRawValue('bf', '18.001', {}), 'learn scene 63');
  });

  // DPT 232: decode black and white
  it('DPT 232: black and white', () => {
    assert.equal(decodeRawValue('000000', '232.600', {}), '#000000');
    assert.equal(decodeRawValue('ffffff', '232.600', {}), '#ffffff');
  });

  // DPT 242: decode with validity flags
  it('DPT 242: decode with all zeros', () => {
    assert.equal(
      decodeRawValue('000000000000', '242.600', {}),
      'xyY(0.000, 0.000, 0%)',
    );
  });

  // DPT 251: decode all zeros
  it('DPT 251: decode all zeros', () => {
    assert.equal(
      decodeRawValue('000000000000', '251.600', {}),
      'RGBW(0,0,0,0)',
    );
  });

  // DPT 251: decode max values
  it('DPT 251: decode max RGBW', () => {
    assert.equal(
      decodeRawValue('ffffffff000f', '251.600', {}),
      'RGBW(255,255,255,255)',
    );
  });
});

// ── etsTestMatch ────────────────────────────────────────────────────────────

describe('etsTestMatch', () => {
  it('exact string match', () => {
    assert.equal(etsTestMatch('1', ['1']), true);
    assert.equal(etsTestMatch('0', ['1']), false);
    assert.equal(etsTestMatch('hello', ['hello']), true);
    assert.equal(etsTestMatch('hello', ['world']), false);
  });

  it('matches any in list', () => {
    assert.equal(etsTestMatch('2', ['1', '2', '3']), true);
    assert.equal(etsTestMatch('5', ['1', '2', '3']), false);
  });

  it('= operator', () => {
    assert.equal(etsTestMatch('5', ['=5']), true);
    assert.equal(etsTestMatch('5', ['=6']), false);
    assert.equal(etsTestMatch('0', ['=0']), true);
  });

  it('!= operator', () => {
    assert.equal(etsTestMatch('5', ['!=5']), false);
    assert.equal(etsTestMatch('5', ['!=6']), true);
    assert.equal(etsTestMatch('0', ['!=0']), false);
    assert.equal(etsTestMatch('0', ['!=1']), true);
  });

  it('< operator', () => {
    assert.equal(etsTestMatch('3', ['<5']), true);
    assert.equal(etsTestMatch('5', ['<5']), false);
    assert.equal(etsTestMatch('7', ['<5']), false);
  });

  it('> operator', () => {
    assert.equal(etsTestMatch('7', ['>5']), true);
    assert.equal(etsTestMatch('5', ['>5']), false);
    assert.equal(etsTestMatch('3', ['>5']), false);
  });

  it('<= operator', () => {
    assert.equal(etsTestMatch('3', ['<=5']), true);
    assert.equal(etsTestMatch('5', ['<=5']), true);
    assert.equal(etsTestMatch('7', ['<=5']), false);
  });

  it('>= operator', () => {
    assert.equal(etsTestMatch('7', ['>=5']), true);
    assert.equal(etsTestMatch('5', ['>=5']), true);
    assert.equal(etsTestMatch('3', ['>=5']), false);
  });

  it('negative values', () => {
    assert.equal(etsTestMatch('-1', ['=-1']), true);
    assert.equal(etsTestMatch('-5', ['>-3']), false);
    assert.equal(etsTestMatch('-5', ['<-3']), true);
    assert.equal(etsTestMatch('-3', ['>=-3']), true);
    assert.equal(etsTestMatch('-3', ['<=-3']), true);
  });

  it('decimal values', () => {
    assert.equal(etsTestMatch('2.5', ['>2']), true);
    assert.equal(etsTestMatch('2.5', ['<3']), true);
    assert.equal(etsTestMatch('2.5', ['=2.5']), true);
    assert.equal(etsTestMatch('2.5', ['!=2.5']), false);
  });

  it('returns false for empty/null tests', () => {
    assert.equal(etsTestMatch('1', []), false);
    assert.equal(etsTestMatch('1', null), false);
    assert.equal(etsTestMatch('1', undefined), false);
  });

  it('skips relational ops when value is NaN', () => {
    assert.equal(etsTestMatch('abc', ['>0']), false);
    assert.equal(etsTestMatch('abc', ['<0']), false);
    assert.equal(etsTestMatch('abc', ['=0']), false);
    assert.equal(etsTestMatch('abc', ['!=0']), false);
  });

  it('NaN still matches exact string', () => {
    assert.equal(etsTestMatch('abc', ['abc']), true);
  });

  it('mixed relational and exact tests', () => {
    assert.equal(etsTestMatch('5', ['>10', '5']), true); // fails >10, matches exact '5'
    assert.equal(etsTestMatch('5', ['>10', '<3']), false); // fails both
    assert.equal(etsTestMatch('5', ['!=5', '>4']), true); // fails !=5, matches >4
  });
});
