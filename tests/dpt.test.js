'use strict';
/**
 * Tests for DPT encoding/decoding, KNX float16, bit packing,
 * address encoding/decoding, and CEMI frame building/parsing.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeDpt, decodeDptBuffer,
  encodePhysical, decodePhysical,
  encodeGroup, decodeGroup,
  buildCEMI, parseCEMI,
  MC,
} = require('../server/knx-connection');

const {
  writeKnxFloat16, writeBits, normalizeDptKey, decodeRawValue,
} = require('../server/routes');

// ── DPT encoding ────────────────────────────────────────────────────────────

describe('encodeDpt', () => {
  it('DPT 1 — boolean on/off', () => {
    assert.deepEqual([...encodeDpt(true, '1.001')],  [1]);
    assert.deepEqual([...encodeDpt(false, '1.001')], [0]);
    assert.deepEqual([...encodeDpt('true', '1')],    [1]);
    assert.deepEqual([...encodeDpt('false', '1')],   [0]);
    assert.deepEqual([...encodeDpt(1, '1.001')],     [1]);
    assert.deepEqual([...encodeDpt(0, '1.001')],     [0]);
    assert.deepEqual([...encodeDpt('1', '1.003')],   [1]);
    assert.deepEqual([...encodeDpt('0', '1.003')],   [0]);
  });

  it('DPT 5 — 8-bit unsigned', () => {
    assert.deepEqual([...encodeDpt(0, '5.001')],   [0x00]);
    assert.deepEqual([...encodeDpt(127, '5.001')], [0x7F]);
    assert.deepEqual([...encodeDpt(255, '5.010')], [0xFF]);
  });

  it('DPT 5 — clamps to 0–255', () => {
    assert.deepEqual([...encodeDpt(-10, '5.001')], [0x00]);
    assert.deepEqual([...encodeDpt(999, '5.001')], [0xFF]);
  });

  it('DPT 9 — 2-byte KNX float: zero', () => {
    const buf = encodeDpt(0, '9.001');
    assert.equal(buf.length, 2);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1, exp = (raw >> 11) & 0xF, mant = raw & 0x7FF;
    assert.equal(sign, 0);
    assert.equal(0.01 * mant * Math.pow(2, exp), 0);
  });

  it('DPT 9 — 2-byte KNX float: 21.0°C', () => {
    const buf = encodeDpt(21.0, '9.001');
    assert.equal(buf.length, 2);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1, exp = (raw >> 11) & 0xF, mant = raw & 0x7FF;
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
    assert(Math.abs(buf.readFloatBE(0) - (-273.15)) < 0.01);
  });

  it('DPT 14 — zero', () => {
    const buf = encodeDpt(0, '14.000');
    assert.equal(buf.readFloatBE(0), 0);
  });

  it('unknown DPT falls back to single byte', () => {
    assert.deepEqual([...encodeDpt(42, '99')], [42]);
    assert.deepEqual([...encodeDpt(256, '99')], [0]); // masked to 0xFF → 0
  });
});

// ── DPT decoding ────────────────────────────────────────────────────────────

describe('decodeDptBuffer', () => {
  it('empty buffer returns empty string', () => {
    assert.equal(decodeDptBuffer(Buffer.alloc(0)), '');
    assert.equal(decodeDptBuffer(null), '');
  });

  it('single byte 0 → Off', () => {
    assert.equal(decodeDptBuffer(Buffer.from([0])), 'Off');
  });

  it('single byte 1 → On', () => {
    assert.equal(decodeDptBuffer(Buffer.from([1])), 'On');
  });

  it('single byte >1 → numeric string', () => {
    assert.equal(decodeDptBuffer(Buffer.from([42])), '42');
    assert.equal(decodeDptBuffer(Buffer.from([255])), '255');
  });

  it('2-byte KNX float decodes correctly', () => {
    // Encode 21.0 then decode — round-trip
    const buf = encodeDpt(21.0, '9.001');
    const decoded = parseFloat(decodeDptBuffer(buf));
    assert(Math.abs(decoded - 21.0) < 0.1, `round-trip: ${decoded} should be ~21.0`);
  });

  it('2-byte KNX float zero', () => {
    const decoded = parseFloat(decodeDptBuffer(Buffer.from([0x00, 0x00])));
    assert.equal(decoded, 0);
  });

  it('4+ bytes returns hex string', () => {
    const buf = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    assert.equal(decodeDptBuffer(buf), 'deadbeef');
  });
});

// ── DPT 9 encode/decode round-trip ──────────────────────────────────────────

describe('DPT 9 round-trip', () => {
  const testValues = [0, 0.5, 1.0, 10.0, 20.5, 21.0, 25.6, -5.0, -10.5, -20.0, -30.0, 40.96, 100.0, 500.0, -500.0];

  for (const v of testValues) {
    it(`${v}`, () => {
      const buf = encodeDpt(v, '9.001');
      const decoded = parseFloat(decodeDptBuffer(buf));
      // DPT 9 has limited precision — tolerance depends on exponent
      const tolerance = Math.max(0.5, Math.abs(v) * 0.02);
      assert(Math.abs(decoded - v) < tolerance, `encode(${v}) → decode = ${decoded}, diff ${Math.abs(decoded - v)}`);
    });
  }
});

// ── writeKnxFloat16 ─────────────────────────────────────────────────────────

describe('writeKnxFloat16', () => {
  it('encodes zero', () => {
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, 0);
    assert.equal(buf.readUInt16BE(0) & 0x7FF, 0, 'mantissa should be 0');
  });

  it('encodes 21.0°C and round-trips', () => {
    const buf = Buffer.alloc(2);
    writeKnxFloat16(buf, 0, 21.0);
    const raw = buf.readUInt16BE(0);
    const sign = (raw >> 15) & 1, exp = (raw >> 11) & 0xF, mant = raw & 0x7FF;
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
    const exp = (raw >> 11) & 0xF, mant = raw & 0x7FF;
    const signedMant = mant - 2048;
    const v = 0.01 * signedMant * Math.pow(2, exp);
    assert(Math.abs(v - (-10.0)) < 0.5, `decoded ${v}`);
  });

  it('writes at correct byte offset', () => {
    const buf = Buffer.alloc(6, 0xFF);
    writeKnxFloat16(buf, 2, 0);
    assert.equal(buf[0], 0xFF, 'byte 0 untouched');
    assert.equal(buf[1], 0xFF, 'byte 1 untouched');
    assert.equal(buf[4], 0xFF, 'byte 4 untouched');
    assert.equal(buf[5], 0xFF, 'byte 5 untouched');
  });

  it('does not write past buffer end', () => {
    const buf = Buffer.alloc(1, 0xAA);
    writeKnxFloat16(buf, 0, 21.0);
    assert.equal(buf[0], 0xAA, 'too-small buffer should be unchanged');
  });
});

// ── writeBits ───────────────────────────────────────────────────────────────

describe('writeBits', () => {
  it('writes full byte at offset 0', () => {
    const buf = Buffer.alloc(1);
    writeBits(buf, 0, 0, 8, 0xAB);
    assert.equal(buf[0], 0xAB);
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
    const buf = Buffer.from([0xFF]);
    writeBits(buf, 0, 2, 4, 0x00);
    // bits: 11 0000 11 = 0xC3
    assert.equal(buf[0], 0xC3);
  });

  it('writes 4-bit nibble at offset 4', () => {
    const buf = Buffer.from([0x00]);
    writeBits(buf, 0, 4, 4, 0x0F);
    assert.equal(buf[0], 0x0F);
  });

  it('writes 16-bit big-endian value', () => {
    const buf = Buffer.alloc(2);
    writeBits(buf, 0, 0, 16, 0x1234);
    assert.equal(buf[0], 0x12);
    assert.equal(buf[1], 0x34);
  });

  it('writes 32-bit big-endian value', () => {
    const buf = Buffer.alloc(4);
    writeBits(buf, 0, 0, 32, 0xDEADBEEF);
    assert.deepEqual([...buf], [0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('handles sub-byte spanning two bytes', () => {
    const buf = Buffer.from([0x00, 0x00]);
    writeBits(buf, 0, 6, 4, 0x0F);
    // byte 0 bits 6-7: 11 → 0x03, byte 1 bits 0-1: 11 → 0xC0
    assert.equal(buf[0], 0x03);
    assert.equal(buf[1], 0xC0);
  });

  it('does not write past buffer end', () => {
    const buf = Buffer.alloc(1, 0xAA);
    writeBits(buf, 5, 0, 8, 0xFF);
    assert.equal(buf[0], 0xAA, 'out-of-bounds write should be no-op');
  });
});

// ── normalizeDptKey (server) ────────────────────────────────────────────────

describe('normalizeDptKey (server)', () => {
  it('DPST-9-1 → 9.001', () => assert.equal(normalizeDptKey('DPST-9-1'), '9.001'));
  it('DPT-9-1 → 9.001', () => assert.equal(normalizeDptKey('DPT-9-1'), '9.001'));
  it('DPST-14-68 → 14.068', () => assert.equal(normalizeDptKey('DPST-14-68'), '14.068'));
  it('DPST-1-1 → 1.001', () => assert.equal(normalizeDptKey('DPST-1-1'), '1.001'));
  it('9.001 passes through', () => assert.equal(normalizeDptKey('9.001'), '9.001'));
  it('9.1 → 9.001', () => assert.equal(normalizeDptKey('9.1'), '9.001'));
  it('null → null', () => assert.equal(normalizeDptKey(null), null));
  it('empty → null', () => assert.equal(normalizeDptKey(''), null));
  it('case insensitive', () => assert.equal(normalizeDptKey('dpst-5-1'), '5.001'));
});

// ── Address encoding/decoding ───────────────────────────────────────────────

describe('encodePhysical / decodePhysical', () => {
  const cases = [
    ['0.0.0', [0x00, 0x00]],
    ['1.1.1', [0x11, 0x01]],
    ['1.1.5', [0x11, 0x05]],
    ['1.0.60', [0x10, 0x3C]],
    ['15.15.255', [0xFF, 0xFF]],
    ['2.3.128', [0x23, 0x80]],
  ];

  for (const [addr, bytes] of cases) {
    it(`${addr} → [${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, () => {
      const buf = encodePhysical(addr);
      assert.deepEqual([...buf], bytes);
    });

    it(`[${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}] → ${addr}`, () => {
      assert.equal(decodePhysical(Buffer.from(bytes)), addr);
    });
  }

  it('round-trips all test addresses', () => {
    for (const [addr] of cases) {
      assert.equal(decodePhysical(encodePhysical(addr)), addr);
    }
  });
});

describe('encodeGroup / decodeGroup', () => {
  const cases = [
    ['0/0/0',   [0x00, 0x00]],
    ['1/0/0',   [0x08, 0x00]],
    ['1/0/1',   [0x08, 0x01]],
    ['11/0/0',  [0x58, 0x00]],
    ['31/7/255', [0xFF, 0xFF]],
    ['2/1/10',  [0x11, 0x0A]],
  ];

  for (const [addr, bytes] of cases) {
    it(`${addr} → [${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, () => {
      const buf = encodeGroup(addr);
      assert.deepEqual([...buf], bytes);
    });

    it(`[${bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}] → ${addr}`, () => {
      assert.equal(decodeGroup(Buffer.from(bytes)), addr);
    });
  }

  it('round-trips all test addresses', () => {
    for (const [addr] of cases) {
      assert.equal(decodeGroup(encodeGroup(addr)), addr);
    }
  });
});

// ── CEMI frame building/parsing ─────────────────────────────────────────────

describe('buildCEMI', () => {
  it('builds a group write frame with correct structure', () => {
    const apdu = Buffer.from([0x00, 0x81]); // GroupValue_Write, data=1
    const cemi = buildCEMI('1.1.5', '1/0/0', apdu, true);
    assert.equal(cemi[0], MC.REQ, 'message code = L_Data.req');
    assert.equal(cemi[1], 0x00, 'additional info length = 0');
    assert.equal(cemi[2], 0xBC, 'ctrl1');
    assert.equal(cemi[3], 0xE0, 'ctrl2 group flag set');
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
    assert.equal(parsed.apduData.length, 2, 'should extract 2-byte float payload');
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
    const padded = Buffer.concat([Buffer.alloc(4, 0xFF), cemi]);
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
    assert.equal(decodeRawValue('03e8', '7.002', info), '100');  // 1000 * 0.1
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
    assert.equal(decodeRawValue('ff9c', '8.002', info), '-1');   // -100 * 0.01
    assert.equal(decodeRawValue('0064', '8.002', info), '1');    // 100 * 0.01
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
    assert(Math.abs(decoded - (-5.0)) < 0.5, `decoded ${decoded}`);
  });

  // DPT 14 — 4-byte IEEE float
  it('DPT 14: decodes 4-byte float', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(3.14);
    const decoded = parseFloat(decodeRawValue(buf.toString('hex'), '14.068', {}));
    assert(Math.abs(decoded - 3.14) < 0.01, `decoded ${decoded}`);
  });

  it('DPT 14: decodes negative float', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(-273.15);
    const decoded = parseFloat(decodeRawValue(buf.toString('hex'), '14.069', {}));
    assert(Math.abs(decoded - (-273.15)) < 0.1, `decoded ${decoded}`);
  });

  // DPT 20 — HVAC enum
  it('DPT 20: decodes enum value', () => {
    const info = { enums: { 0: 'Auto', 1: 'Comfort', 2: 'Standby', 3: 'Economy', 4: 'Protection' } };
    assert.equal(decodeRawValue('01', '20.102', info), 'Comfort');
    assert.equal(decodeRawValue('03', '20.102', info), 'Economy');
  });

  // Unknown buffer size returns null
  it('returns null for 3-byte buffer with non-DPT-14 type', () => {
    assert.equal(decodeRawValue('aabbcc', '5.001', {}), null);
  });

  it('returns null for 4-byte buffer with non-DPT-14 type', () => {
    assert.equal(decodeRawValue('aabbccdd', '7.001', {}), null);
  });
});
