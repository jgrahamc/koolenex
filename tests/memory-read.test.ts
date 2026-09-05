/**
 * Tests for A_Memory_Read: the connected-mode APDU builder and the
 * A_Memory_Response parser. These are the safety-critical pure functions for the
 * read-first device validation path (no writes to hardware).
 *
 * KNX A_Memory_Read/Response wire layout (connected-mode PDU):
 *   octet6 [7:2]=TPCI  [1:0]=APCI bits 3-2
 *   octet7 [7:6]=APCI bits 1-0  [5:0]=number (byte count, max 63)
 *   octet8 = address high, octet9 = address low
 *   (Response only) octet10.. = `number` data bytes
 * APCI: Memory_Read = 0b1000 (8), Memory_Response = 0b1001 (9).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apduMemoryRead,
  apduMemoryWrite,
  parseMemoryResponse,
  apduMemoryExtendedRead,
  apduMemoryExtendedWrite,
  parseMemoryExtendedResponse,
  buildCEMI,
  parseCEMI,
  apduConnectedFull,
  apduGroup,
  TPCI,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection, maxChunkFromApduLength } from '../server/knx-connection.ts';

/**
 * A fake device: answers every A_Memory_Read with the corresponding slice of a
 * backing memory buffer, so readMemory() can be exercised without hardware.
 * Also answers A_MemoryExtended_Read (24-bit address) the same way, since a
 * resolved relmem base + offset can legitimately land above 0xFFFF — see
 * readRegionInSession() in knx-connection.ts, which is the code under test
 * for the "reads above 0xFFFF" cases below.
 */
class FakeMemoryDevice extends KnxConnection {
  sent: Buffer[] = [];
  // NOTE: explicit fields + body assignment — constructor parameter properties
  // (`private readonly x`) are unsupported by Node's strip-only type stripping
  // (`node --test`) and would make this whole file fail to load.
  private readonly deviceAddr: string;
  private readonly memory: Buffer;
  // Configurable per-test - see the PID_MAX_APDULENGTH-specific describe
  // block below. Defaults generously high (never caps anything, and
  // answers immediately) so every existing/unrelated test in this file
  // keeps its pre-existing chunking behavior AND stays fast - only a test
  // that explicitly sets a smaller value exercises real capping, and only
  // a test that explicitly sets `null` exercises the (real, but
  // deliberately rare/slow - a genuine 3s protocol timeout) "device never
  // answers this property at all" fallback path.
  maxApduLength: number | null = 1000;
  constructor(deviceAddr: string, memory: Buffer) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
  }
  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();
    // Real request, 2026-08-31: answer DeviceDescriptor_Read immediately
    // (KnxConnection._resolveMemoryServiceForSession(), added earlier the
    // same session) - previously unanswered here, silently costing every
    // test in this file a real 3s protocol timeout. Mask 0x07B0 (System B)
    // matches every real device this project has tested; the resolved
    // value isn't currently used to gate the read-service decision itself
    // (see readRegionInSession()'s own "reverted" note), so answering it
    // doesn't change any existing test's chunking behavior - it only
    // removes a wasted wait.
    if (frame.apciName === 'DeviceDescriptor_Read') {
      const respApdu = apduGroup(
        'DeviceDescriptor_Response',
        0,
        Buffer.from([0x07, 0xb0]),
      );
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }
    // Extended APCIs (10-bit) don't reliably resolve through
    // `frame.apciName` for dispatch purposes here - compute the raw
    // numeric APCI directly instead, matching the proven-working pattern
    // used elsewhere in this test suite (e.g. ga-assoc-table-write.test.ts).
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    // PID_MAX_APDULENGTH (property 56, objIdx 0) - real request, 2026-08-31:
    // readMemory()/readMemoryMany() now resolve this once per session
    // (KnxConnection._resolveMaxApduLength()) to compute the real per-
    // device chunk-size ceiling instead of trusting a fixed constant. Only
    // answered when `maxApduLength` is non-null (defaults to a generous
    // value - see the field's own doc comment above - so every existing/
    // unrelated test keeps its pre-existing chunking behavior and stays
    // fast; a test that explicitly sets `null` opts into the real,
    // deliberately rare "device never answers this property" timeout).
    if (fullApci === 0x3d5 /* PropertyValue_Read */ && this.maxApduLength != null) {
      const objIdx = frame.apduData[0]!;
      const propId = frame.apduData[1]!;
      if (objIdx === 0 && propId === 56) {
        const meta = Buffer.from([objIdx, propId, 0x10, 0x01]); // echo count=1/startIndex=1
        const value = Buffer.from([
          (this.maxApduLength >> 8) & 0xff,
          this.maxApduLength & 0xff,
        ]);
        const respApdu = apduConnectedFull(
          0,
          APCI_EXT.PropertyValue_Response,
          Buffer.concat([meta, value]),
        );
        const resp = parseCEMI(
          buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
        )!;
        setImmediate(() => this._onCEMI(resp));
      }
      return Promise.resolve();
    }
    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = this.memory.slice(address, address + count);
      const word = (TPCI.DATA_CONNECTED << 10) | (9 << 6) | count;
      const respApdu = Buffer.concat([
        Buffer.from([
          (word >> 8) & 0xff,
          word & 0xff,
          (address >> 8) & 0xff,
          address & 0xff,
        ]),
        data,
      ]);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    } else if (frame && frame.apciName === 'MemoryExtended_Read') {
      // [count(1)][address(3, BE)] — same shape apduMemoryExtendedRead sends.
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const data = this.memory.slice(address, address + count);
      // Matches the legacy branch above: waitResponse() only checks src +
      // apciName, not the sequence number, so a fixed TPCI (no seq bits) is
      // sufficient here too.
      const word =
        ((TPCI.DATA_CONNECTED << 10) |
          APCI_EXT.MemoryExtended_Read_Response) &
        0xffff;
      const respApdu = Buffer.concat([
        Buffer.from([
          (word >> 8) & 0xff,
          word & 0xff,
          0x00, // returnCode = 0 (success)
          (address >> 16) & 0xff,
          (address >> 8) & 0xff,
          address & 0xff,
        ]),
        data,
      ]);
      const resp = parseCEMI(
        buildCEMI(this.deviceAddr, this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
    }
    return Promise.resolve();
  }
  disconnect(): void {
    this.connected = false;
  }
}

// Like FakeMemoryDevice, but deliberately echoes the WRONG address in every
// response — used to prove readMemory rejects a mismatched Memory_Response
// instead of copying it into the wrong offset.
class MisaddressingDevice extends FakeMemoryDevice {
  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (frame && frame.apciName === 'Memory_Read') {
      this.sent.push(cemi);
      const count = frame.apdu[1]! & 0x3f;
      const reqAddr = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const badAddr = (reqAddr + 1) & 0xffff; // off-by-one, wrong on purpose
      const word = (TPCI.DATA_CONNECTED << 10) | (9 << 6) | count;
      const respApdu = Buffer.concat([
        Buffer.from([
          (word >> 8) & 0xff,
          word & 0xff,
          (badAddr >> 8) & 0xff,
          badAddr & 0xff,
        ]),
        Buffer.alloc(count),
      ]);
      const resp = parseCEMI(
        buildCEMI('1.1.4', this.localAddr, respApdu, false),
      )!;
      setImmediate(() => this._onCEMI(resp));
      return Promise.resolve();
    }
    // Delegate everything else (DeviceDescriptor_Read, PID_MAX_APDULENGTH)
    // to the base class's own fast-answering handling - avoids paying
    // both real 3s protocol timeouts on every test using this device, for
    // requests this device doesn't itself need to special-case.
    return super.sendCEMI(cemi);
  }
}

describe('apduMemoryRead', () => {
  it('encodes seq, byte-count in octet7, and 2-byte address (standard layout)', () => {
    // seq=0 → TPCI DATA_CONNECTED = 0x10; count=3; address=0x1234
    // word = (0x10<<10) | (8<<6) | 3 = 0x4203
    const apdu = apduMemoryRead(0, 3, 0x1234);
    assert.deepEqual([...apdu], [0x42, 0x03, 0x12, 0x34]);
  });

  it('places the sequence number in the TPCI field', () => {
    // seq=5 → TPCI = 0x15; count=3; address=0x1234
    // word = (0x15<<10) | 0x200 | 3 = 0x5603
    const apdu = apduMemoryRead(5, 3, 0x1234);
    assert.deepEqual([...apdu], [0x56, 0x03, 0x12, 0x34]);
  });

  it('caps the count into the low 6 bits of octet7', () => {
    // count=63 (0x3f) is the max; address 0x00A0
    const apdu = apduMemoryRead(0, 63, 0x00a0);
    assert.deepEqual([...apdu], [0x42, 0x3f, 0x00, 0xa0]);
  });
});

describe('parseMemoryResponse', () => {
  it('decodes address and exactly `count` data bytes from a device response', () => {
    // Build the A_Memory_Response the device would send: count=3, addr=0x1234,
    // data=[0xAA,0xBB,0xCC]. word = (0x10<<10)|(9<<6)|3 = 0x4243.
    const apdu = Buffer.from([0x42, 0x43, 0x12, 0x34, 0xaa, 0xbb, 0xcc]);
    const cemi = buildCEMI('1.1.4', '0.0.1', apdu, false);
    const frame = parseCEMI(cemi);
    assert.ok(frame);
    assert.equal(frame.apciName, 'Memory_Response');

    const parsed = parseMemoryResponse(frame);
    assert.equal(parsed.address, 0x1234);
    assert.deepEqual([...parsed.data], [0xaa, 0xbb, 0xcc]);
  });

  it('ignores trailing bytes beyond the reported count', () => {
    // count=2 but 3 data bytes present → only the first 2 are the payload.
    const apdu = Buffer.from([0x42, 0x42, 0x00, 0x60, 0x01, 0x02, 0x99]);
    const frame = parseCEMI(buildCEMI('1.1.4', '0.0.1', apdu, false));
    assert.ok(frame);
    const parsed = parseMemoryResponse(frame);
    assert.equal(parsed.address, 0x0060);
    assert.deepEqual([...parsed.data], [0x01, 0x02]);
  });

  it('clamps a count that exceeds the actual payload (short/malformed response)', () => {
    // count field claims 5 bytes but only 2 are present after the address.
    const apdu = Buffer.from([0x42, 0x45, 0x00, 0x60, 0x01, 0x02]);
    const frame = parseCEMI(buildCEMI('1.1.4', '0.0.1', apdu, false));
    assert.ok(frame);
    const parsed = parseMemoryResponse(frame);
    assert.equal(parsed.address, 0x0060);
    // Must not fabricate bytes: return only what the payload actually holds.
    assert.deepEqual([...parsed.data], [0x01, 0x02]);
  });
});

describe('apduMemoryExtendedRead', () => {
  it('encodes the 0x1FD APCI with count + 3-byte address (System B/7)', () => {
    // seq=0 → TPCI 0x10; word = (0x10<<10)|0x1FD = 0x41FD → [0x41,0xFD]
    // then count=8, address=0x123456 (3 bytes)
    const apdu = apduMemoryExtendedRead(0, 8, 0x123456);
    assert.deepEqual([...apdu], [0x41, 0xfd, 0x08, 0x12, 0x34, 0x56]);
  });

  it('carries the sequence number in the TPCI field', () => {
    const apdu = apduMemoryExtendedRead(3, 1, 0x000060);
    // tpci = 0x13 → word = (0x13<<10)|0x1FD = 0x4DFD
    assert.deepEqual([...apdu], [0x4d, 0xfd, 0x01, 0x00, 0x00, 0x60]);
  });
});

describe('apduMemoryExtendedWrite', () => {
  it('encodes the 0x1FB APCI with count + 3-byte address + data (System B/7)', () => {
    // seq=0 → TPCI 0x10; word = (0x10<<10)|0x1FB = 0x41FB → [0x41,0xFB]
    // then count=2 (data.length), address=0x123456, data=[0xAA,0xBB]
    const apdu = apduMemoryExtendedWrite(0, 0x123456, Buffer.from([0xaa, 0xbb]));
    assert.deepEqual(
      [...apdu],
      [0x41, 0xfb, 0x02, 0x12, 0x34, 0x56, 0xaa, 0xbb],
    );
  });

  it('carries the sequence number in the TPCI field', () => {
    const apdu = apduMemoryExtendedWrite(3, 0x000060, Buffer.from([0x01]));
    // tpci = 0x13 → word = (0x13<<10)|0x1FB = 0x4DFB
    assert.deepEqual([...apdu], [0x4d, 0xfb, 0x01, 0x00, 0x00, 0x60, 0x01]);
  });

  it('derives count from the data length, not a separate parameter', () => {
    const apdu = apduMemoryExtendedWrite(
      0,
      0x000000,
      Buffer.from([1, 2, 3, 4, 5]),
    );
    assert.equal(apdu[2], 5);
    assert.equal(apdu.length, 2 + 1 + 3 + 5); // header(2) + count(1) + addr(3) + data(5)
  });
});

describe('apduMemoryWrite', () => {
  it('encodes seq, byte-count in octet7, and 2-byte address (standard layout)', () => {
    // seq=0 → TPCI DATA_CONNECTED = 0x10; APCI Memory_Write = 0xA (10);
    // count=3; address=0x1234. fullApci = (0xA<<6)|3 = 0x283.
    // word = (0x10<<10)|0x283 = 0x4283.
    const apdu = apduMemoryWrite(0, 0x1234, Buffer.from([0xaa, 0xbb, 0xcc]));
    assert.deepEqual(
      [...apdu],
      [0x42, 0x83, 0x12, 0x34, 0xaa, 0xbb, 0xcc],
    );
  });

  it('carries the sequence number in the TPCI field', () => {
    // seq=5 → TPCI = 0x15; count=1; address=0x0060.
    // fullApci = (0xA<<6)|1 = 0x281; word = (0x15<<10)|0x281 = 0x5681.
    const apdu = apduMemoryWrite(5, 0x0060, Buffer.from([0x01]));
    assert.deepEqual([...apdu], [0x56, 0x81, 0x00, 0x60, 0x01]);
  });

  it('derives count from the data length, not a separate parameter', () => {
    const apdu = apduMemoryWrite(0, 0x0000, Buffer.from([1, 2, 3, 4, 5]));
    // header(2) + address(2) + data(5); count lives inside the header word,
    // not as a standalone byte - unlike apduMemoryExtendedWrite's layout.
    assert.equal(apdu.length, 2 + 2 + 5);
  });

  it('regression, 2026-09-01: reproduces the real captured HDL bug fix byte-for-byte', () => {
    // Real bug: every caller used to build this frame by hand via
    // apduConnected() + a leading count byte tacked onto extraBuf.
    // apduConnected() never sets the low 6 bits of the header word at all,
    // so that leading "count" byte was actually parsed by the receiving
    // device as the high byte of the memory address - shifting everything
    // by one byte. A real Full Download to 1.1.20 (HDL) sent a 52-byte
    // chunk meant for object 4's real relmem base (0x1766) and it went out
    // on the wire as address 0x3417 (0x34 = the stray count byte = 52
    // decimal, 0x17 = the real address's own high byte) with count=0 -
    // captured and manually decoded byte-for-byte from
    // captures/hdl-full-download-1120-2026-09-01.pcapng, frame 702. This
    // test locks in the fixed encoding: the real address (0x1766) and real
    // count (52, inside the header) must appear correctly, and the
    // previously-mis-parsed address (0x3417) must not appear anywhere in
    // the frame.
    const chunk = Buffer.alloc(52);
    chunk[0] = 0x66;
    const apdu = apduMemoryWrite(3, 0x1766, chunk);
    // fullApci = (0xA<<6)|52 = 0x2B4; tpci(seq=3) = 0x13;
    // word = (0x13<<10)|0x2B4 = 0x4EB4. Byte 0 (0x4E) matches the real
    // captured frame's own TPCI+seq+APCI-high byte exactly (same seq=3,
    // same object) - only byte 1 differs, since only the low 6 bits (count)
    // change between the real device's count=0 and this fix's count=52.
    assert.equal(apdu[0], 0x4e);
    assert.equal(apdu[1], 0xb4);
    assert.equal(apdu[2], 0x17);
    assert.equal(apdu[3], 0x66);
    assert.equal(apdu[4], 0x66); // first real data byte
    // The bug's garbage address must not be reachable from this encoding.
    assert.notEqual((apdu[2]! << 8) | apdu[3]!, 0x3417);
  });
});

describe('parseMemoryExtendedResponse', () => {
  it('decodes return code, 3-byte address, and data', () => {
    // A_MemoryExtended_Read_Response 0x1FE: [rc][addr(3)][data]
    // word = (0x10<<10)|0x1FE = 0x41FE
    const apdu = Buffer.from([0x41, 0xfe, 0x00, 0x12, 0x34, 0x56, 0xaa, 0xbb]);
    const frame = parseCEMI(buildCEMI('1.1.2', '1.0.2', apdu, false));
    assert.ok(frame);
    // parseCEMI must recognise the 10-bit extended APCI, not mistake it for ADC
    assert.equal(frame.apciName, 'MemoryExtended_Read_Response');

    const parsed = parseMemoryExtendedResponse(frame);
    assert.equal(parsed.returnCode, 0);
    assert.equal(parsed.address, 0x123456);
    assert.deepEqual([...parsed.data], [0xaa, 0xbb]);
  });

  it('surfaces a non-zero return code (access error)', () => {
    const apdu = Buffer.from([0x41, 0xfe, 0x01, 0x00, 0x00, 0x60]);
    const frame = parseCEMI(buildCEMI('1.1.2', '1.0.2', apdu, false));
    assert.ok(frame);
    const parsed = parseMemoryExtendedResponse(frame);
    assert.equal(parsed.returnCode, 1);
    assert.equal(parsed.data.length, 0);
  });
});

describe('KnxConnection.readMemory', () => {
  it('reassembles a multi-chunk read from device memory', async () => {
    // Device memory: byte[address] == address & 0xff for a known region.
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.4', mem);

    // Read 20 bytes from 0x0100 in 8-byte chunks → spans 3 reads.
    const out = await dev.readMemory('1.1.4', 0x0100, 20, 8);

    assert.equal(out.length, 20);
    assert.deepEqual([...out], [...mem.slice(0x0100, 0x0100 + 20)]);
    // Read frames sent (excluding CONNECT/DISCONNECT control): 3 chunks.
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    assert.equal(reads.length, 3);
  });

  it('caps each legacy Memory_Read request at the real 6-bit count-field max (63), even when chunkSize is larger', async () => {
    // Real bug, found live 2026-08-30, same session as the short-response
    // fix above: `chunkSize` defaults to 228 (the real value confirmed for
    // the EXTENDED write/read service's full 1-byte count field) - but the
    // LEGACY A_Memory_Read packs its count into a 6-bit APCI field (max
    // 63). A request for 64+ bytes via the legacy service isn't rejected
    // or clamped anywhere upstream - `apduMemoryRead(seq, 64, addr)`
    // silently encodes `64 & 0x3f = 0`, a request for literally zero
    // bytes, which a real device correctly answers with... zero bytes,
    // looking exactly like a device malfunction rather than a malformed
    // request. This test's read (100 bytes at a legacy, sub-0xFFFF
    // address, with the real default chunkSize of 228) would have hit
    // `n=64` on some chunk without the cap in readRegionInSession().
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.4', mem);

    const out = await dev.readMemory('1.1.4', 0x0000, 100, 228);

    assert.equal(out.length, 100);
    assert.deepEqual([...out], [...mem.slice(0, 100)]);
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    // Every real request's own encoded count must never exceed 63.
    for (const f of reads) {
      const count = f!.apdu[1]! & 0x3f;
      assert.ok(
        count > 0 && count <= 63,
        `legacy Memory_Read count must be 1-63, got ${count}`,
      );
    }
  });

  it('rejects a Memory_Response whose address does not match the request', async () => {
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    // Device echoes a wrong address (off by one) — must never be copied blindly.
    const dev = new MisaddressingDevice('1.1.4', mem);
    await assert.rejects(
      dev.readMemory('1.1.4', 0x0100, 8, 8),
      /address mismatch/,
    );
  });

  it('readMemoryMany reads every region in one management session', async () => {
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.4', mem);

    const [a, b] = await dev.readMemoryMany(
      '1.1.4',
      [
        { address: 0x0100, length: 4 },
        { address: 0x0180, length: 3 },
      ],
      8,
    );
    assert.deepEqual([...a!], [...mem.slice(0x0100, 0x0104)]);
    assert.deepEqual([...b!], [...mem.slice(0x0180, 0x0183)]);
    // Both regions are read inside ONE management session: exactly one CONNECT
    // and one DISCONNECT for the whole batch (not one pair per region).
    const parsed = dev.sent.map((c) => parseCEMI(c));
    assert.equal(parsed.filter((f) => f?.tpciType === 'CONNECT').length, 1);
    assert.equal(parsed.filter((f) => f?.tpciType === 'DISCONNECT').length, 1);
  });
});

// ── Addresses above 0xFFFF ───────────────────────────────────────────────────
//
// A resolved relmem base (via PID_TABLE_REFERENCE / PID 7) can legitimately
// land above 0xFFFF. A_Memory_Read only carries a 16-bit address, so
// readRegionInSession() must switch to A_MemoryExtended_Read (24-bit) for any
// chunk whose real address doesn't fit - using the legacy service there would
// silently truncate to the wrong (low) address and return unrelated memory
// instead of erroring. See fix/16bit-address-truncation's commit message for
// the real-hardware confidence level behind this fix; these tests lock in the
// protocol-level behavior only.
describe('KnxConnection.readMemory — addresses above 0xFFFF', () => {
  it('switches to A_MemoryExtended_Read for a region entirely above 0xFFFF', async () => {
    // Memory big enough to cover a base past 0xFFFF plus the read region.
    const mem = Buffer.alloc(0x10100);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.10', mem);

    const out = await dev.readMemory('1.1.10', 0x100a0, 20, 8);

    assert.equal(out.length, 20);
    assert.deepEqual([...out], [...mem.slice(0x100a0, 0x100a0 + 20)]);
    // Every chunk went out as MemoryExtended_Read, none as legacy Memory_Read.
    const frames = dev.sent.map((c) => parseCEMI(c));
    assert.equal(
      frames.filter((f) => f?.apciName === 'MemoryExtended_Read').length,
      3,
    );
    assert.equal(
      frames.filter((f) => f?.apciName === 'Memory_Read').length,
      0,
    );
  });

  it('only switches the chunks that actually need it, when a region straddles 0xFFFF', async () => {
    const mem = Buffer.alloc(0x10020);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.10', mem);

    // 16 bytes starting 8 below 0xFFFF, in 8-byte chunks: first chunk's
    // address (0xFFF8) fits in 16 bits, second chunk's (0x10000) doesn't.
    const out = await dev.readMemory('1.1.10', 0xfff8, 16, 8);

    assert.deepEqual([...out], [...mem.slice(0xfff8, 0xfff8 + 16)]);
    const frames = dev.sent.map((c) => parseCEMI(c));
    assert.equal(
      frames.filter((f) => f?.apciName === 'Memory_Read').length,
      1,
    );
    assert.equal(
      frames.filter((f) => f?.apciName === 'MemoryExtended_Read').length,
      1,
    );
  });

  it('rejects a MemoryExtended_Read_Response with a non-zero return code', async () => {
    class FailingExtendedDevice extends FakeMemoryDevice {
      sendCEMI(cemi: Buffer): Promise<void> {
        const frame = parseCEMI(cemi);
        if (frame && frame.apciName === 'MemoryExtended_Read') {
          this.sent.push(cemi);
          const word =
            ((TPCI.DATA_CONNECTED << 10) |
              APCI_EXT.MemoryExtended_Read_Response) &
            0xffff;
          const respApdu = Buffer.from([
            (word >> 8) & 0xff,
            word & 0xff,
            0x01, // returnCode = 1 (access error)
            0x01,
            0x00,
            0x00,
          ]);
          const resp = parseCEMI(
            buildCEMI('1.1.10', '1.0.1', respApdu, false),
          )!;
          setImmediate(() => this._onCEMI(resp));
          return Promise.resolve();
        }
        // See MisaddressingDevice's identical delegation for why.
        return super.sendCEMI(cemi);
      }
    }
    const dev = new FailingExtendedDevice('1.1.10', Buffer.alloc(0x10010));
    await assert.rejects(
      dev.readMemory('1.1.10', 0x10000, 4, 8),
      /MemoryExtended read error rc=1/,
    );
  });
});

// ── A response genuinely shorter than the requested count ──────────────────
//
// Real bug, found live 2026-08-30: a real device answered a large single
// MemoryExtended_Read (98 bytes requested) with a genuinely SHORT response
// (~34 real bytes) for reasons unrelated to the requested chunk size - the
// request was well-formed and the device ACKed it (returnCode=0), it just
// didn't return everything asked for in one response. The read loop used to
// advance `off` by the REQUESTED amount regardless of how much data actually
// came back, permanently losing the shortfall - every later byte silently
// stayed at zero, indistinguishable from genuine on-device content. Looked
// exactly like a real device-side data-loss/hardware-limitation bug until a
// deliberately smaller, separate re-read of the same address range came back
// with the real (non-zero) content the large read had silently dropped.
describe('KnxConnection.readMemory — a response shorter than requested', () => {
  it('retries for the remainder instead of silently accepting a short response as complete', async () => {
    class ShortResponseDevice extends FakeMemoryDevice {
      // Real hardware behavior being reproduced: however many bytes are
      // requested in one call, this device only ever returns at most 10 of
      // them - a hard per-response cap unrelated to what the caller asked
      // for, forcing the read loop to come back for more.
      static readonly MAX_PER_RESPONSE = 10;
      sendCEMI(cemi: Buffer): Promise<void> {
        const frame = parseCEMI(cemi);
        if (frame && frame.apciName === 'MemoryExtended_Read') {
          this.sent.push(cemi);
          const requested = frame.apduData[0]!;
          const address =
            (frame.apduData[1]! << 16) |
            (frame.apduData[2]! << 8) |
            frame.apduData[3]!;
          const actualCount = Math.min(
            requested,
            ShortResponseDevice.MAX_PER_RESPONSE,
          );
          const data = (this as any).memory.slice(
            address,
            address + actualCount,
          );
          const word =
            ((TPCI.DATA_CONNECTED << 10) |
              APCI_EXT.MemoryExtended_Read_Response) &
            0xffff;
          const respApdu = Buffer.concat([
            Buffer.from([
              (word >> 8) & 0xff,
              word & 0xff,
              0x00,
              (address >> 16) & 0xff,
              (address >> 8) & 0xff,
              address & 0xff,
            ]),
            data,
          ]);
          const resp = parseCEMI(
            buildCEMI('1.1.9', '1.0.1', respApdu, false),
          )!;
          setImmediate(() => this._onCEMI(resp));
          return Promise.resolve();
        }
        // See MisaddressingDevice's identical delegation for why.
        return super.sendCEMI(cemi);
      }
    }
    // Base above 0xFFFF so this exercises the extended-read branch, matching
    // where the real bug was found (a relmem base, e.g. Object 3's).
    const mem = Buffer.alloc(0x10100);
    for (let i = 0; i < mem.length; i++) mem[i] = (i * 7 + 3) & 0xff; // non-zero, non-trivial pattern
    const dev = new ShortResponseDevice('1.1.9', mem);

    // Ask for 98 bytes in ONE nominal chunk (chunkSize=98, matching the real
    // Object 3 read) - the device can only ever give back 10 at a time.
    const out = await dev.readMemory('1.1.9', 0x10000, 98, 98);

    assert.equal(out.length, 98);
    assert.deepEqual([...out], [...mem.slice(0x10000, 0x10000 + 98)]);
    // Every byte must be real content from `mem`, not a silently-accepted
    // zero for whatever a single response didn't cover.
    assert.ok(
      !out.equals(Buffer.alloc(98)),
      'must not be all-zero - that is exactly the silent-truncation bug',
    );
    // 98 bytes at 10 bytes/response takes 10 real round trips, not 1.
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'MemoryExtended_Read');
    assert.equal(reads.length, 10);
  });
});

// ── PID_MAX_APDULENGTH-derived chunk sizing ─────────────────────────────────
//
// Real request, 2026-08-31: a real Full Download to a real HDL device (mask
// 0x07B0) stalled silently - koolenex sent a single 152-byte
// MemoryExtended_Write, well under the previously-assumed-universal 228-byte
// "safe" ceiling (itself only ever confirmed against a DIFFERENT device,
// 1.1.10), and got no response at all. Real ETS never guesses this - it
// reads PID_MAX_APDULENGTH (property 56, objIdx 0) once and computes the
// exact safe size up front. Verified by decoding a real ETS-written frame's
// raw wire bytes against this exact device: PID_MAX_APDULENGTH read back 55;
// the real wire NPDU Length byte on ETS's own 52-byte MemWrite was 0x37=55
// too (the classic KNX convention that the wire Length field equals real
// octet count minus 1, so real capacity = 55+1 = 56 octets) - subtracting
// the real header size (4 bytes legacy, 2 TPCI+APCI+count + 2 address) gives
// exactly 52, the same number found by direct empirical bisection.
describe('maxChunkFromApduLength', () => {
  it('reproduces the real HDL device figure: declared 55 -> 52 usable legacy bytes', () => {
    assert.equal(maxChunkFromApduLength(55, false), 52);
  });

  it('computes the extended-service ceiling with its own real 6-byte header', () => {
    // (declared+1) - 6. Not independently confirmed against real hardware
    // for the extended service specifically (no captured PID_MAX_APDULENGTH
    // value for a device using extended chunks up to 228 was available at
    // the time this was written) - the header byte count itself is real,
    // read directly off apduMemoryExtendedRead/Write's own layout
    // (knx-cemi.ts), not a separate guess.
    assert.equal(maxChunkFromApduLength(233, true), 228);
  });

  it('never returns less than 1, even for a degenerate tiny declared value', () => {
    assert.equal(maxChunkFromApduLength(2, false), 1);
    assert.equal(maxChunkFromApduLength(0, true), 1);
  });
});

describe('KnxConnection.readMemory — real per-device PID_MAX_APDULENGTH capping', () => {
  it('caps every legacy chunk to the device\'s own declared real capacity, not the protocol max', async () => {
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.20', mem);
    // Matches the real HDL device this fix was built against.
    dev.maxApduLength = 55;

    // Ask for 100 bytes with the real default chunkSize (228) - without the
    // device's own real 52-byte ceiling applied, this would go out as
    // fewer, larger (up to 63-byte legacy-max) chunks.
    const out = await dev.readMemory('1.1.20', 0x0000, 100, 228);

    assert.equal(out.length, 100);
    assert.deepEqual([...out], [...mem.slice(0, 100)]);
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    for (const f of reads) {
      const count = f!.apdu[1]! & 0x3f;
      assert.ok(
        count > 0 && count <= 52,
        `chunk must respect this device's real 52-byte ceiling, got ${count}`,
      );
    }
    // 100 bytes at up to 52/chunk takes at least 2 real requests - proves
    // the cap actually changed the chunking, not just a no-op assertion.
    assert.ok(reads.length >= 2);
  });

  it('does not shrink chunks below the protocol max when the device declares a generous capacity', async () => {
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.10', mem);
    // A generous declared value (far above anything the protocol allows) -
    // the resolved cap must never exceed the legacy 63-byte protocol max
    // regardless, so this is still a single request.
    dev.maxApduLength = 1000;

    const out = await dev.readMemory('1.1.10', 0x0000, 40, 228);
    assert.deepEqual([...out], [...mem.slice(0, 40)]);
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    assert.equal(reads.length, 1);
  });

  it('falls back to the protocol-theoretical max when the device never answers PID_MAX_APDULENGTH', async () => {
    // A real, if deliberately rare, case: a device that simply doesn't
    // answer this property at all. Real 3s protocol timeout - kept as its
    // own explicit, named test rather than the file's default fake-device
    // behavior (which defaults to answering generously, so every other
    // test here stays fast and keeps its pre-existing chunking behavior).
    const mem = Buffer.alloc(0x0200);
    for (let i = 0; i < mem.length; i++) mem[i] = i & 0xff;
    const dev = new FakeMemoryDevice('1.1.4', mem);
    dev.maxApduLength = null;

    const out = await dev.readMemory('1.1.4', 0x0000, 100, 228);
    assert.deepEqual([...out], [...mem.slice(0, 100)]);
    const reads = dev.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Read');
    for (const f of reads) {
      const count = f!.apdu[1]! & 0x3f;
      assert.ok(count > 0 && count <= 63);
    }
  });
});
