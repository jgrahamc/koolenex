/**
 * Tests for computeGroupObjectByte()/buildGroupObjectTable() (server/routes/knx-tables.ts) -
 * Object 3's per-communication-object flag byte, decoded via a systematic real-hardware
 * bit-mapping session (2026-08-29, System B mask family only). See
 * docs/knx-device-write-protocol.md §10.1 for the full evidence trail.
 *
 * Every case below is a real byte captured on the wire during that investigation (device 1.1.9,
 * except where noted) - this is a golden-image validation against real hardware, not synthetic
 * data, following the same pattern as tests/relmem-real-device-fixtures.test.ts and
 * tests/ga-assoc-table-write.test.ts elsewhere in this project. One case (marked explicitly) is
 * NOT independently verified against a real capture - see its own comment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeGroupObjectByte,
  buildGroupObjectTable,
  groupObjectSizeCode,
  describeGroupObjectEntry,
  decodeGroupObjectEntryFlags,
} from '../server/routes/knx-tables.ts';
import type { GroupObjectFlags } from '../server/routes/knx-tables.ts';

// Manufacturer defaults for the real communication objects used throughout the investigation
// (M-0004_A-0025-10-1BA6-O00A6, 1.1.9's app - confirmed against the real app XML).
const DEF_OBJ67: Omit<GroupObjectFlags, 'object_number' | 'linked'> = {
  update: false,
  transmit: true,
  readOnInit: false,
  write: true,
  read: false,
  communication: true,
  priority: 'low',
};
// Object 5's real defaults differ (Read=Enabled, Write=Disabled - opposite of 6/7).
const DEF_OBJ5: Omit<GroupObjectFlags, 'object_number' | 'linked'> = {
  update: false,
  transmit: true,
  readOnInit: false,
  write: false,
  read: true,
  communication: true,
  priority: 'low',
};

describe('computeGroupObjectByte() - real captured bytes, device 1.1.9 unless noted', () => {
  // ── Object 7 (offset 14), never linked to a GA throughout the investigation ──
  it('object 7: manufacturer default -> 0x53', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false }),
      0x53,
    );
  });
  it('object 7: Update=on -> 0xD3', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false, update: true }),
      0xd3,
    );
  });
  it('object 7: Update=off, Read=on -> 0x5B', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false, read: true }),
      0x5b,
    );
  });
  it('object 7: +Write=off (Read still on) -> 0x4B', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
      }),
      0x4b,
    );
  });
  it('object 7: +Transmit=off -> 0x0B', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
      }),
      0x0b,
    );
  });
  it('object 7: Communication=off while unlinked -> no change (0x0B) - the confound that caused the original wrong "Communication has zero representation" claim', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        communication: false,
      }),
      0x0b,
    );
  });
  it('object 7: Priority=Alarm -> 0x0A', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        priority: 'alarm',
      }),
      0x0a,
    );
  });
  it('object 7: Priority=High -> 0x09', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        priority: 'high',
      }),
      0x09,
    );
  });

  // ── Object 6 (offset 12), never linked to a GA throughout the investigation ──
  it('object 6: manufacturer default -> 0x53', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 6, ...DEF_OBJ67, linked: false }),
      0x53,
    );
  });
  it('object 6: Read-On-Init=on -> 0x73', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 6,
        ...DEF_OBJ67,
        linked: false,
        readOnInit: true,
      }),
      0x73,
    );
  });
  it('object 6: Update=on (Read-On-Init reverted) -> 0xD3', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 6, ...DEF_OBJ67, linked: false, update: true }),
      0xd3,
    );
  });
  it('object 6: Update=on + Read=on (additive, predicted before capture) -> 0xDB', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 6,
        ...DEF_OBJ67,
        linked: false,
        update: true,
        read: true,
      }),
      0xdb,
    );
  });

  // ── Object 5 (offset 10), linked throughout (1 or 2 GAs) - different DPT/size (8-byte
  // DPST-19-1 date/time) than every other object tested, and the object used to isolate bit 2's
  // real Communication-AND-linked meaning. ──
  it('object 5: manufacturer default, linked -> 0x4F', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 5: Read-On-Init=on -> 0x6F', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true, readOnInit: true }),
      0x6f,
    );
  });
  it('object 5: Communication=off, GA link left untouched -> 0x4B (the decisive correction test)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 5,
        ...DEF_OBJ5,
        linked: true,
        communication: false,
      }),
      0x4b,
    );
  });
  it('object 5: Communication back on, 2 GA links -> 0x4F, identical to the 1-link case (link count doesn\'t matter)', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 5: swapping which of 2 links sends -> no change (0x4F) - direction lives in the Association table, not here', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });

  // ── Object 8 (offset 16) ──
  it('object 8: default, linked -> 0x4F', () => {
    assert.equal(computeGroupObjectByte({ object_number: 8, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 8: GA link removed -> 0x4B', () => {
    assert.equal(computeGroupObjectByte({ object_number: 8, ...DEF_OBJ5, linked: false }), 0x4b);
  });

  // ── Object 96, device 1.1.10 (M-0004_A-3030-23-F0EA-O000A) - a completely different
  // manufacturer app, the blind cross-device confirmation test. ──
  it('object 96 (1.1.10): manufacturer default, computed - NOT independently verified against a real capture (only the post-change byte below was actually observed on the wire; this one is back-computed from the same app XML the test itself used, so it is internally consistent, not an independent cross-check)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 96,
        update: true,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
      }),
      0xcb,
    );
  });
  it('object 96 (1.1.10): Write=on - the real blind test (computed here without knowing the answer, then checked against the capture, which showed 0xDB)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 96,
        update: true,
        transmit: true,
        readOnInit: false,
        write: true,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
      }),
      0xdb,
    );
  });
});

// The companion (size-code) byte - real captured values, confirmed 2026-08-29 by pulling
// ComObject/ComObjectRef `ObjectSize` declarations from both testbed apps' own real XML and
// checking them against the real captured companion byte at that object's offset. See
// groupObjectSizeCode()'s own doc comment (server/routes/knx-tables.ts) and docs/knx-device-
// write-protocol.md Part 17 for the full evidence trail (4 independent DPT/size matches, plus
// the header-count finding below).
describe('groupObjectSizeCode() - real captured companion bytes, cross-device', () => {
  it('"1 Bit" -> 0 (real, extensively confirmed on every ordinary object on both devices)', () => {
    assert.equal(groupObjectSizeCode('1 Bit'), 0);
  });
  it('"4 Bit" -> 3 (real, 1.1.10 object 34 / DPST-3-7 dimming control)', () => {
    assert.equal(groupObjectSizeCode('4 Bit'), 3);
  });
  it('"1 Byte" -> 7 (real, 1.1.10 objects 35/36 / DPST-5-1)', () => {
    assert.equal(groupObjectSizeCode('1 Byte'), 7);
  });
  it('"3 Bytes" -> 9 (real, 1.1.9 objects 3/4 / DPST-10-1 + DPST-11-1 - two different DPTs, same size, same real byte)', () => {
    assert.equal(groupObjectSizeCode('3 Bytes'), 9);
  });
  it('"8 Bytes" -> 12 (real, 1.1.9 object 5 / DPST-19-1)', () => {
    assert.equal(groupObjectSizeCode('8 Bytes'), 12);
  });
  it('unrecognized/missing input defaults to 0 (1 Bit), not a thrown error', () => {
    assert.equal(groupObjectSizeCode(undefined), 0);
    assert.equal(groupObjectSizeCode(''), 0);
    assert.equal(groupObjectSizeCode('not a real ETS size string'), 0);
  });
  it('the remaining codes (not yet directly confirmed against real hardware) still follow the well-known KNX size-code sequence', () => {
    assert.equal(groupObjectSizeCode('2 Bit'), 1);
    assert.equal(groupObjectSizeCode('3 Bit'), 2);
    assert.equal(groupObjectSizeCode('5 Bit'), 4);
    assert.equal(groupObjectSizeCode('6 Bit'), 5);
    assert.equal(groupObjectSizeCode('7 Bit'), 6);
    assert.equal(groupObjectSizeCode('2 Bytes'), 8);
    assert.equal(groupObjectSizeCode('4 Bytes'), 10);
    assert.equal(groupObjectSizeCode('6 Bytes'), 11);
    assert.equal(groupObjectSizeCode('10 Bytes'), 13);
    assert.equal(groupObjectSizeCode('14 Bytes'), 14);
    assert.equal(groupObjectSizeCode('Variable length'), 15);
  });
});

describe('buildGroupObjectTable() - full-buffer placement, real device sizes', () => {
  it('writes the 2-byte header (total declared object count), real captured value for 1.1.9 (0x0030 = 48)', () => {
    const buf = buildGroupObjectTable(98, []);
    assert.equal(buf.readUInt16BE(0), 48);
  });

  it('writes the 2-byte header, real captured value for 1.1.10 (0x01D6 = 470)', () => {
    const buf = buildGroupObjectTable(942, []);
    assert.equal(buf.readUInt16BE(0), 470);
  });

  it('places each communication object\'s flag byte at 2×object_number and its size-code companion byte right after, leaves everything else zero (1.1.9\'s real 98-byte size)', () => {
    const buf = buildGroupObjectTable(98, [
      { object_number: 6, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
      { object_number: 7, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
    ]);
    assert.equal(buf.length, 98);
    assert.equal(buf.readUInt16BE(0), 48); // header
    assert.equal(buf[12], 0x53); // object 6 flag byte
    assert.equal(buf[13], 0x00); // object 6 companion (1 Bit -> code 0)
    assert.equal(buf[14], 0x53); // object 7 flag byte
    assert.equal(buf[15], 0x00); // object 7 companion (1 Bit -> code 0)
    // Everything else stays zero - matches every real device's own mostly-empty Object 3.
    const rest = Buffer.from(buf);
    rest.writeUInt16BE(0, 0);
    rest[12] = 0;
    rest[14] = 0;
    assert.ok(rest.every((b) => b === 0), 'every byte outside the header and the two placed objects should be 0');
  });

  it('reproduces the real 4-object layout observed on the wire (objects 5/6/7/8, 1.1.9), including companion bytes', () => {
    const buf = buildGroupObjectTable(98, [
      { object_number: 5, ...DEF_OBJ5, linked: true, objectSize: '8 Bytes' },
      { object_number: 6, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
      { object_number: 7, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
      { object_number: 8, ...DEF_OBJ5, linked: true, objectSize: '1 Bit' },
    ]);
    assert.equal(buf[10], 0x4f); // object 5 flag byte
    assert.equal(buf[11], 0x0c); // object 5 companion (8 Bytes -> code 12)
    assert.equal(buf[12], 0x53); // object 6
    assert.equal(buf[14], 0x53); // object 7
    assert.equal(buf[16], 0x4f); // object 8 flag byte
    assert.equal(buf[17], 0x00); // object 8 companion (1 Bit -> code 0)
  });

  it('reproduces the real 1.1.9 object 3/4 case: two different DPTs, same real size, same real companion byte', () => {
    const buf = buildGroupObjectTable(98, [
      {
        object_number: 3,
        update: false,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
        objectSize: '3 Bytes', // DPST-10-1 (UhrzeitGO, Time)
      },
      {
        object_number: 4,
        update: false,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
        objectSize: '3 Bytes', // DPST-11-1 (DatumGO, Date) - different DPT, same size
      },
    ]);
    assert.equal(buf[6], 0x4b); // object 3 flag byte, real captured value
    assert.equal(buf[7], 0x09); // object 3 companion, real captured value
    assert.equal(buf[8], 0x4b); // object 4 flag byte, real captured value
    assert.equal(buf[9], 0x09); // object 4 companion, real captured value - same as object 3
  });

  it('silently skips (leaves at zero) any object number that would fall outside the real buffer size, rather than throwing', () => {
    const buf = buildGroupObjectTable(10, [{ object_number: 96, ...DEF_OBJ5, linked: true, objectSize: '8 Bytes' }]);
    assert.equal(buf.length, 10);
    // Header still gets written (total count = (10-2)/2 = 4) - only the out-of-range object is skipped.
    assert.equal(buf.readUInt16BE(0), 4);
    const rest = Buffer.from(buf);
    rest.writeUInt16BE(0, 0);
    assert.ok(rest.every((b) => b === 0));
  });

  it('reproduces the ENTIRE real 98-byte 1.1.9 capture byte-for-byte, header included (2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng)', () => {
    // The full real com-object set this exact capture's Object 3 reflects - every object 1.1.9's
    // app actually declares and links for this device (objects 3/4/5 unlinked internal-clock
    // objects; object 5/8 linked at the time; objects 9-28 the "Mapper object" 1-bit channels).
    const REAL_HEX =
      '0030000000004b094b094f0c530053004f005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b0000000000000000000000000000000000000000000000000000000000000000000000000000000000';
    const mapperObj = (n: number): GroupObjectFlags => ({
      object_number: n,
      update: false,
      transmit: true,
      readOnInit: false,
      write: true,
      read: true,
      communication: true,
      linked: false,
      priority: 'low',
      objectSize: '1 Bit',
    });
    const comObjects: GroupObjectFlags[] = [
      {
        object_number: 3,
        update: false,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
        objectSize: '3 Bytes',
      },
      {
        object_number: 4,
        update: false,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
        objectSize: '3 Bytes',
      },
      { object_number: 5, ...DEF_OBJ5, linked: true, objectSize: '8 Bytes' },
      { object_number: 6, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
      { object_number: 7, ...DEF_OBJ67, linked: false, objectSize: '1 Bit' },
      { object_number: 8, ...DEF_OBJ5, linked: true, objectSize: '1 Bit' },
      ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].map(mapperObj),
    ];
    const buf = buildGroupObjectTable(98, comObjects);
    assert.equal(buf.toString('hex'), REAL_HEX);
  });
});

describe('describeGroupObjectEntry() - human-readable formatting for the device-compare page', () => {
  it('formats every flag bit, priority, and size - not just a raw hex byte pair', () => {
    // 0x6f = object 5 with Read-On-Init=on (0x4F | 0x20) - real captured value.
    const str = describeGroupObjectEntry({ flagByte: 0x6f, sizeCodeByte: 0x0c });
    assert.equal(
      str,
      'Update=No Transmit=Yes ReadOnInit=Yes Write=No Read=Yes Comm+Linked=Yes Priority=Low Size=8 Bytes',
    );
  });

  it('Comm+Linked reflects the combined bit 2 - Yes only when both Communication and a real GA link are true (the byte can\'t distinguish which, if either, is false)', () => {
    // 0x4B = object 5 default with Communication=off (or unlinked) - bit 2 clear either way.
    const str = describeGroupObjectEntry({ flagByte: 0x4b, sizeCodeByte: 0x00 });
    assert.match(str, /Comm\+Linked=No/);
  });

  it('all-zero byte (no com object here) decodes to a fully "No"/System/1 Bit baseline, not garbage - bits 0b00 are genuinely Priority=System (unreachable from ETS, but a real, correct decode of the literal bit pattern), not a default-to-Low guess', () => {
    const str = describeGroupObjectEntry({ flagByte: 0x00, sizeCodeByte: 0x00 });
    assert.equal(
      str,
      'Update=No Transmit=No ReadOnInit=No Write=No Read=No Comm+Linked=No Priority=System Size=1 Bit',
    );
  });

  it('Priority=Alarm/High/System decode correctly from their real bit patterns', () => {
    assert.match(describeGroupObjectEntry({ flagByte: 0b10, sizeCodeByte: 0 }), /Priority=Alarm/);
    assert.match(describeGroupObjectEntry({ flagByte: 0b01, sizeCodeByte: 0 }), /Priority=High/);
    assert.match(describeGroupObjectEntry({ flagByte: 0b00, sizeCodeByte: 0 }), /Priority=System/);
  });

  it('an unrecognized size code (never confirmed against real hardware, but the sequence is well-known) still shows its own real name, not garbage', () => {
    const str = describeGroupObjectEntry({ flagByte: 0, sizeCodeByte: 15 }); // 15 = Variable length
    assert.match(str, /Size=Variable length/);
  });
});

describe('decodeGroupObjectEntryFlags() - structured (not string) decode, for the per-flag chip display', () => {
  it('matches describeGroupObjectEntry() bit-for-bit - same real captured value (0x6f object 5, Read-On-Init on)', () => {
    const flags = decodeGroupObjectEntryFlags({ flagByte: 0x6f, sizeCodeByte: 0x0c });
    assert.deepEqual(flags, {
      update: false,
      transmit: true,
      readOnInit: true,
      write: false,
      read: true,
      commLinked: true,
      priority: 'Low',
      size: '8 Bytes',
    });
  });

  it('every bit independently toggleable - all-set byte (0xFF, priority bits included) decodes every flag true', () => {
    const flags = decodeGroupObjectEntryFlags({ flagByte: 0xff, sizeCodeByte: 7 });
    assert.equal(flags.update, true);
    assert.equal(flags.transmit, true);
    assert.equal(flags.readOnInit, true);
    assert.equal(flags.write, true);
    assert.equal(flags.read, true);
    assert.equal(flags.commLinked, true);
    assert.equal(flags.priority, 'Low'); // 0xFF's low 2 bits are 0b11 = Low
    assert.equal(flags.size, '1 Byte');
  });

  it('all-clear byte decodes every flag false, priority System (the real bit pattern, not a Low default)', () => {
    const flags = decodeGroupObjectEntryFlags({ flagByte: 0x00, sizeCodeByte: 0x00 });
    assert.equal(flags.update, false);
    assert.equal(flags.transmit, false);
    assert.equal(flags.readOnInit, false);
    assert.equal(flags.write, false);
    assert.equal(flags.read, false);
    assert.equal(flags.commLinked, false);
    assert.equal(flags.priority, 'System');
    assert.equal(flags.size, '1 Bit');
  });
});
