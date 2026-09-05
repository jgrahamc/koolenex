/**
 * Tests for KNX protocol helpers: KNXnet/IP packet builders, USB HID framing,
 * APDU builders, GA/association table encoding, and ETS helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── KNXnet/IP packet builders ───────────────────────────────────────────────

import {
  _hdr as hdr,
  _hpai as hpai,
  _pktConnect as pktConnect,
  _pktConnState as pktConnState,
  _pktDisconnect as pktDisconnect,
  _pktDisconnectRes as pktDisconnectRes,
  _pktTunnelingReq as pktTunnelingReq,
  _SVC as SVC,
  _HOST_PROTOCOL as HOST_PROTOCOL,
} from '../server/knx-protocol.ts';

describe('KNXnet/IP: hdr', () => {
  it('builds a 6-byte header with protocol version 0x06 0x10', () => {
    const h = hdr(0x0205, 26);
    assert.equal(h.length, 6);
    assert.equal(h[0], 0x06);
    assert.equal(h[1], 0x10);
    assert.equal(h.readUInt16BE(2), 0x0205);
    assert.equal(h.readUInt16BE(4), 26);
  });
});

describe('KNXnet/IP: hpai', () => {
  it('encodes IP and port into 8-byte HPAI', () => {
    const h = hpai('192.168.1.100', 3671);
    assert.equal(h.length, 8);
    assert.equal(h[0], 0x08); // length
    assert.equal(h[1], 0x01); // protocol code (UDP)
    assert.equal(h[2], 192);
    assert.equal(h[3], 168);
    assert.equal(h[4], 1);
    assert.equal(h[5], 100);
    assert.equal(h.readUInt16BE(6), 3671);
  });

  it('encodes 0.0.0.0:0', () => {
    const h = hpai('0.0.0.0', 0);
    assert.deepEqual([...h.slice(2, 6)], [0, 0, 0, 0]);
    assert.equal(h.readUInt16BE(6), 0);
  });

  it('encodes protocol code 0x02 for TCP - confirmed against Calimero HPAI.IPV4_TCP', () => {
    const h = hpai('0.0.0.0', 0, HOST_PROTOCOL.TCP);
    assert.equal(h[1], 0x02);
  });
});

describe('KNXnet/IP: pktConnect', () => {
  it('builds a 26-byte CONNECT_REQ', () => {
    const pkt = pktConnect('192.168.1.10', 50000);
    assert.equal(pkt.length, 26);
    // Header
    assert.equal(pkt.readUInt16BE(2), SVC.CONNECT_REQ);
    assert.equal(pkt.readUInt16BE(4), 26);
    // CRI at end: tunnel connection, layer 2
    assert.equal(pkt[22], 0x04); // CRI length
    assert.equal(pkt[23], 0x04); // tunnel connection
    assert.equal(pkt[24], 0x02); // link layer
  });

  it('embeds the real local IP/port in the HPAI for UDP (default)', () => {
    const pkt = pktConnect('192.168.1.10', 50000);
    // control endpoint HPAI starts at byte 6
    assert.equal(pkt[7], 0x01); // protocol code UDP
    assert.deepEqual([...pkt.slice(8, 12)], [192, 168, 1, 10]);
    assert.equal(pkt.readUInt16BE(12), 50000);
  });

  it('uses the placeholder HPAI (0.0.0.0:0, protocol TCP) when hostProtocol=TCP - matches Calimero\'s HPAI.Tcp', () => {
    const pkt = pktConnect('192.168.1.10', 50000, HOST_PROTOCOL.TCP);
    assert.equal(pkt[7], 0x02); // protocol code TCP
    assert.deepEqual([...pkt.slice(8, 12)], [0, 0, 0, 0]);
    assert.equal(pkt.readUInt16BE(12), 0);
  });
});

describe('KNXnet/IP: pktConnState', () => {
  it('builds a 16-byte CONNSTATE_REQ', () => {
    const pkt = pktConnState(0x42, '192.168.1.10', 50000);
    assert.equal(pkt.length, 16);
    assert.equal(pkt.readUInt16BE(2), SVC.CONNSTATE_REQ);
    assert.equal(pkt[6], 0x42); // channel ID
  });
});

describe('KNXnet/IP: pktDisconnect', () => {
  it('builds a 16-byte DISCONNECT_REQ', () => {
    const pkt = pktDisconnect(0x42, '192.168.1.10', 50000);
    assert.equal(pkt.length, 16);
    assert.equal(pkt.readUInt16BE(2), SVC.DISCONNECT_REQ);
    assert.equal(pkt[6], 0x42);
    assert.equal(pkt[9], 0x01); // HPAI protocol code defaults to UDP
  });

  it('uses the placeholder HPAI (0.0.0.0:0, protocol TCP) when hostProtocol=TCP', () => {
    const pkt = pktDisconnect(0x42, '0.0.0.0', 0, HOST_PROTOCOL.TCP);
    assert.equal(pkt[9], 0x02); // HPAI protocol code
    assert.deepEqual([...pkt.slice(10, 14)], [0, 0, 0, 0]);
    assert.equal(pkt.readUInt16BE(14), 0);
  });
});

describe('KNXnet/IP: pktDisconnectRes', () => {
  it('builds an 8-byte DISCONNECT_RES', () => {
    const pkt = pktDisconnectRes(0x42);
    assert.equal(pkt.length, 8);
    assert.equal(pkt.readUInt16BE(2), SVC.DISCONNECT_RES);
    assert.equal(pkt[6], 0x42);
    assert.equal(pkt[7], 0x00); // status OK
  });
});

describe('KNXnet/IP: pktTunnelingReq', () => {
  it('wraps CEMI in a tunneling request', () => {
    const cemi = Buffer.from([
      0x11, 0x00, 0xbc, 0xe0, 0x00, 0x00, 0x08, 0x00, 0x01, 0x00, 0x81,
    ]);
    const pkt = pktTunnelingReq(0x42, 5, cemi);
    assert.equal(pkt.readUInt16BE(2), SVC.TUNNELING_REQ);
    assert.equal(pkt.readUInt16BE(4), 10 + cemi.length);
    // Connection header
    assert.equal(pkt[6], 0x04); // header length
    assert.equal(pkt[7], 0x42); // channel ID
    assert.equal(pkt[8], 5); // sequence
    assert.equal(pkt[9], 0x00); // reserved
    // CEMI follows
    assert.deepEqual([...pkt.slice(10)], [...cemi]);
  });

  it('wraps sequence number to 8 bits', () => {
    const cemi = Buffer.from([0x11, 0x00]);
    const pkt = pktTunnelingReq(1, 256, cemi);
    assert.equal(pkt[8], 0); // 256 & 0xFF
  });
});

// ── USB HID framing ─────────────────────────────────────────────────────────

import {
  _buildHidReports as buildHidReports,
  _parseHidReport as parseHidReport,
  _parseTransferHeader as parseTransferHeader,
  _buildFeatureGet as buildFeatureGet,
  _buildFeatureSet as buildFeatureSet,
  _PROTO_KNX_TUNNEL as PROTO_KNX_TUNNEL,
  _PROTO_BUS_FEATURE as PROTO_BUS_FEATURE,
  _EMI_ID as EMI_ID,
  _FEATURE as FEATURE,
  _FEATURE_SVC as FEATURE_SVC,
  _PKT as PKT,
} from '../server/knx-usb.ts';

describe('USB HID: buildHidReports', () => {
  it('builds a single 64-byte report for small frames', () => {
    const body = Buffer.from([0x11, 0x00, 0xbc]);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].length, 64);
    assert.equal(reports[0][0], 0x01); // report ID
    assert.equal(reports[0][1] & 0x0f, PKT.START_END);
    assert.equal(reports[0][2], 8 + body.length); // header + body
  });

  it('transfer header has correct fields', () => {
    const body = Buffer.from([0xaa]);
    const reports = buildHidReports(
      PROTO_KNX_TUNNEL,
      EMI_ID.COMMON,
      body,
      0x1234,
    );
    const hdr = parseTransferHeader(reports[0].slice(3));
    assert.equal(hdr.protocolId, PROTO_KNX_TUNNEL);
    assert.equal(hdr.emiId, EMI_ID.COMMON);
    assert.equal(hdr.bodyLength, 1);
    assert.equal(hdr.mfrCode, 0x1234);
  });

  it('splits large frames into multiple reports', () => {
    const body = Buffer.alloc(120, 0xbb); // 120 + 8 header = 128 > 61
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert(
      reports.length > 1,
      `should need multiple reports, got ${reports.length}`,
    );
    for (const r of reports) assert.equal(r.length, 64);
    // First report is START
    assert.equal(reports[0][1] & 0x0f, PKT.START);
    // Last report is END
    assert.equal(reports[reports.length - 1][1] & 0x0f, PKT.END);
  });

  it('handles null body', () => {
    const reports = buildHidReports(PROTO_BUS_FEATURE, FEATURE_SVC.GET, null);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][2], 8); // header only, no body
  });
});

describe('USB HID: parseHidReport', () => {
  it('parses a report built by buildHidReports', () => {
    const body = Buffer.from([0x11, 0x00, 0xbc]);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    const parsed = parseHidReport(reports[0]);
    assert(parsed);
    assert.equal(parsed.pktType, PKT.START_END);
    assert.equal(parsed.dataLength, 8 + body.length);
  });

  it('returns null for too-short buffer', () => {
    assert.equal(parseHidReport(Buffer.alloc(2)), null);
    assert.equal(parseHidReport(null), null);
  });

  it('extracts sequence number', () => {
    const body = Buffer.from([0xaa]);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    const parsed = parseHidReport(reports[0]);
    assert.equal(parsed.seq, 1);
  });
});

describe('USB HID: parseTransferHeader', () => {
  it('parses an 8-byte transfer header', () => {
    const buf = Buffer.from([0x00, 0x08, 0x00, 0x03, 0x01, 0x03, 0x00, 0x00]);
    const h = parseTransferHeader(buf);
    assert.equal(h.protocolVersion, 0x00);
    assert.equal(h.headerLength, 0x08);
    assert.equal(h.bodyLength, 3);
    assert.equal(h.protocolId, PROTO_KNX_TUNNEL);
    assert.equal(h.emiId, EMI_ID.COMMON);
    assert.equal(h.mfrCode, 0);
  });

  it('returns null for too-short buffer', () => {
    assert.equal(parseTransferHeader(Buffer.alloc(5)), null);
    assert.equal(parseTransferHeader(null), null);
  });
});

describe('USB HID: buildFeatureGet / buildFeatureSet', () => {
  it('buildFeatureGet creates a bus feature GET request', () => {
    const reports = buildFeatureGet(FEATURE.BUS_STATUS);
    assert.equal(reports.length, 1);
    const hdr = parseTransferHeader(reports[0].slice(3));
    assert.equal(hdr.protocolId, PROTO_BUS_FEATURE);
    assert.equal(hdr.emiId, FEATURE_SVC.GET);
    assert.equal(hdr.bodyLength, 1);
    // Body = feature ID
    assert.equal(reports[0][3 + 8], FEATURE.BUS_STATUS);
  });

  it('buildFeatureSet creates a bus feature SET request', () => {
    const data = Buffer.from([EMI_ID.COMMON]);
    const reports = buildFeatureSet(FEATURE.ACTIVE_EMI, data);
    assert.equal(reports.length, 1);
    const hdr = parseTransferHeader(reports[0].slice(3));
    assert.equal(hdr.protocolId, PROTO_BUS_FEATURE);
    assert.equal(hdr.emiId, FEATURE_SVC.SET);
    assert.equal(hdr.bodyLength, 2); // featureId + data
  });
});

// ── APDU builders ───────────────────────────────────────────────────────────

import {
  parseCEMI,
  _apduGroupRead as apduGroupRead,
  _apduGroupWrite as apduGroupWrite,
  _apduGroupResponse as apduGroupResponse,
  _apduControl as apduControl,
  _apduPropertyValueRead as apduPropertyValueRead,
  _apduPropertyValueWrite as apduPropertyValueWrite,
  _TPCI as TPCI,
  _APCI as APCI,
  buildCEMI,
  encodeDpt,
} from '../server/knx-connection.ts';

describe('APDU: apduGroupRead', () => {
  it('builds a 2-byte GroupValue_Read APDU', () => {
    const apdu = apduGroupRead();
    assert.equal(apdu.length, 2);
    // TPCI=DATA_GROUP(0), APCI=GroupValue_Read(0) → 0x0000
    assert.equal(apdu.readUInt16BE(0), 0x0000);
  });

  it('parseCEMI identifies it as GroupValue_Read', () => {
    const cemi = buildCEMI('1.1.1', '1/0/0', apduGroupRead(), true);
    const p = parseCEMI(cemi);
    assert.equal(p.apciName, 'GroupValue_Read');
  });
});

describe('APDU: apduGroupWrite', () => {
  it('encodes DPT 1 boolean as short data', () => {
    const apdu = apduGroupWrite(true, '1.001');
    assert.equal(apdu.length, 2);
    // APCI=GroupValue_Write(2) → bits 3-2 = 10, short data = 1
    assert.equal(apdu[1] & 0x3f, 1); // short data
  });

  it('encodes DPT 9 float as extended data', () => {
    const apdu = apduGroupWrite(21.0, '9.001');
    assert.equal(apdu.length, 4); // 2-byte header + 2-byte float
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const p = parseCEMI(cemi);
    assert.equal(p.apciName, 'GroupValue_Write');
    assert.equal(p.apduData.length, 2);
  });

  it('encodes DPT 5 value ≤ 0x3F as short data', () => {
    const apdu = apduGroupWrite(63, '5.001');
    assert.equal(apdu.length, 2);
    assert.equal(apdu[1] & 0x3f, 63);
  });

  it('encodes DPT 5 value > 0x3F as extended data', () => {
    const apdu = apduGroupWrite(64, '5.001');
    assert.equal(apdu.length, 3); // 2-byte header + 1-byte payload
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const p = parseCEMI(cemi);
    assert.equal(p.apciName, 'GroupValue_Write');
    assert.equal(p.apduData.length, 1);
    assert.equal(p.apduData[0], 64);
  });
});

describe('APDU: apduGroupResponse', () => {
  it('encodes short data for single-byte values ≤ 0x3F', () => {
    const apdu = apduGroupResponse(Buffer.from([1]));
    assert.equal(apdu.length, 2);
    assert.equal(apdu[1] & 0x3f, 1);
  });

  it('encodes extended data for multi-byte values', () => {
    const enc = encodeDpt(21.0, '9.001');
    const apdu = apduGroupResponse(enc);
    assert.equal(apdu.length, 4); // 2 header + 2 payload
  });

  it('encodes extended data for single-byte values > 0x3F', () => {
    const apdu = apduGroupResponse(Buffer.from([0x80]));
    assert.equal(apdu.length, 3); // 2 header + 1 payload
  });
});

describe('APDU: apduControl', () => {
  it('builds T_CONNECT', () => {
    const apdu = apduControl(TPCI.CONNECT);
    assert.equal(apdu.length, 1);
    assert.equal(apdu[0], TPCI.CONNECT << 2);
  });

  it('builds T_DISCONNECT (0x81 per KNX spec)', () => {
    const apdu = apduControl(TPCI.DISCONNECT);
    assert.equal(apdu.length, 1);
    assert.equal(apdu[0], 0x81);
  });

  it('builds T_ACK with sequence number (0b11 SSSS 10)', () => {
    // T_Ack(seq0) = 0xC2 on the wire (confirmed against ETS bus trace).
    assert.equal(apduControl(TPCI.ACK, 0)[0], 0xc2);
    assert.equal(apduControl(TPCI.ACK, 7)[0], 0xc2 | (7 << 2));
  });

  it('builds T_NAK with sequence number (0b11 SSSS 11)', () => {
    assert.equal(apduControl(TPCI.NAK, 3)[0], 0xc3 | (3 << 2));
  });
});

describe('APDU: apduPropertyValueRead', () => {
  it('builds a property read request', () => {
    const apdu = apduPropertyValueRead(0, 0, 56); // seq=0, objIdx=0, propId=56 (PID_TABLE_REFERENCE)
    assert.equal(apdu.length, 6); // 2 header + 4 meta
    // Meta: objIdx, propId, 0x10, 0x01
    assert.equal(apdu[2], 0); // objIdx
    assert.equal(apdu[3], 56); // propId
    assert.equal(apdu[4], 0x10);
    assert.equal(apdu[5], 0x01);
  });
});

describe('APDU: apduPropertyValueWrite', () => {
  it('builds a property write request with data', () => {
    const data = Buffer.from([0xaa, 0xbb]);
    const apdu = apduPropertyValueWrite(1, 0, 56, data);
    assert.equal(apdu.length, 8); // 2 header + 4 meta + 2 data
    assert.equal(apdu[2], 0);
    assert.equal(apdu[3], 56);
    assert.equal(apdu[6], 0xaa);
    assert.equal(apdu[7], 0xbb);
  });

  it('builds a property write request without data', () => {
    const apdu = apduPropertyValueWrite(0, 0, 56, null);
    assert.equal(apdu.length, 6); // 2 header + 4 meta only
  });
});

// ── Serial-number individual-address addressing ─────────────────────────────
// NM_IndividualAddress_SerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4) - see
// docs/knx-device-write-protocol.md §9 for the real sourcing (Falcon
// SDK doc comments + Calimero's real implementation). No real-hardware
// capture exists for this service yet - these tests only pin down the wire
// format against the two independent sources it was derived from.

import {
  APCI_EXT,
  apduIndividualAddressSerialNumberWrite,
  apduIndividualAddressSerialNumberRead,
  parseIndividualAddressSerialNumberResponse,
  apduSystemNetworkParamRead,
  parseSystemNetworkParamResponse,
} from '../server/knx-connection.ts';

describe('APDU: apduIndividualAddressSerialNumberWrite', () => {
  it('builds a 14-byte APDU: 2 header + 6 serial + 2 address + 4 reserved', () => {
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);
    const apdu = apduIndividualAddressSerialNumberWrite(serial, '1.1.20');
    assert.equal(apdu.length, 14);
    // TPCI=DATA_GROUP (unnumbered) + full APCI 0x3DE
    const fullApci = ((apdu[0]! & 0x03) << 8) | apdu[1]!;
    assert.equal(fullApci, APCI_EXT.IndividualAddressSerialNumber_Write);
    assert.deepEqual([...apdu.slice(2, 8)], [...serial]);
    assert.equal(apdu[8], (1 << 4) | 1); // area.line
    assert.equal(apdu[9], 20); // device
    assert.deepEqual([...apdu.slice(10, 14)], [0, 0, 0, 0]); // reserved
  });

  it('rejects a serial number that is not 6 bytes', () => {
    assert.throws(() =>
      apduIndividualAddressSerialNumberWrite(Buffer.from([1, 2, 3]), '1.1.1'),
    );
  });
});

describe('APDU: apduIndividualAddressSerialNumberRead', () => {
  it('builds an 8-byte APDU: 2 header + 6 serial, no address/reserved', () => {
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);
    const apdu = apduIndividualAddressSerialNumberRead(serial);
    assert.equal(apdu.length, 8);
    const fullApci = ((apdu[0]! & 0x03) << 8) | apdu[1]!;
    assert.equal(fullApci, APCI_EXT.IndividualAddressSerialNumber_Read);
    assert.deepEqual([...apdu.slice(2, 8)], [...serial]);
  });
});

describe('parseIndividualAddressSerialNumberResponse', () => {
  it('decodes the serial from payload bytes 0-6, address from frame.src', () => {
    // Real payload shape confirmed against ETS traffic (tshark capture,
    // 2026-08-30): [serial(6)][4 reserved zero bytes] - there is no
    // address field in the payload, the device's address is carried by
    // frame.src instead. See docs/knx-device-write-protocol.md §9.
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const frame = { apduData, src: '1.1.20' } as any;
    const resp = parseIndividualAddressSerialNumberResponse(frame);
    assert.deepEqual([...resp.serial], [...serial]);
    assert.equal(resp.address, '1.1.20');
  });
});

describe('APDU: apduSystemNetworkParamRead', () => {
  it('builds the exact APDU real ETS sends for NM_Read_SerialNumber_By_ProgrammingMode', () => {
    // Confirmed byte-for-byte against a real tshark capture of ETS's own
    // commissioning flow, 2026-08-30 - see
    // docs/knx-device-write-protocol.md §9.
    const apdu = apduSystemNetworkParamRead(0, 11, 1);
    assert.deepEqual(
      [...apdu],
      [0x01, 0xc8, 0x00, 0x00, 0x00, 0xb0, 0x01],
    );
    const fullApci = ((apdu[0]! & 0x03) << 8) | apdu[1]!;
    assert.equal(fullApci, APCI_EXT.SystemNetworkParam_Read);
  });

  it('appends additionalTestInfo after the operand byte', () => {
    const apdu = apduSystemNetworkParamRead(0, 11, 1, Buffer.from([0xaa]));
    assert.equal(apdu.length, 8);
    assert.equal(apdu[7], 0xaa);
  });
});

describe('parseSystemNetworkParamResponse', () => {
  it('skips the echoed operand byte before the value - real captured shape', () => {
    // Real captured response payload:
    // [objType(2)=0000][pidField(2)=00b0][echoedOperand=01][serial(6)]
    const apduData = Buffer.from([
      0x00, 0x00, 0x00, 0xb0, 0x01, 0x00, 0x0a, 0x57, 0x82, 0x04, 0x19,
    ]);
    const frame = { apduData } as any;
    const resp = parseSystemNetworkParamResponse(frame);
    assert.equal(resp.objectType, 0);
    assert.equal(resp.pid, 11);
    assert.deepEqual(
      [...resp.value],
      [0x00, 0x0a, 0x57, 0x82, 0x04, 0x19],
    );
  });

  it('returns an empty value when the payload is too short (unsupported)', () => {
    const apduData = Buffer.from([0x00, 0x00, 0x00, 0xb0]);
    const frame = { apduData } as any;
    const resp = parseSystemNetworkParamResponse(frame);
    assert.equal(resp.value.length, 0);
  });
});

describe('buildCEMI: priority and systemBroadcast options', () => {
  it('leaves every existing call site byte-for-byte unchanged (default ctrl1)', () => {
    const cemi = buildCEMI('1.1.1', '1/0/0', apduGroupRead(), true);
    assert.equal(cemi[2], 0xbc);
  });

  it('sets ctrl1 = 0xB0 (ordinary broadcast, System priority) for priority: "system" - confirmed against real ETS traffic', () => {
    const cemi = buildCEMI('1.1.1', '0/0/0', apduGroupRead(), true, {
      priority: 'system',
    });
    assert.equal(cemi[2], 0xb0);
  });

  it('sets ctrl1 = 0xA0 (system broadcast, System priority) when both options combined', () => {
    const cemi = buildCEMI('1.1.1', '0.0.0', apduGroupRead(), false, {
      priority: 'system',
      systemBroadcast: true,
    });
    assert.equal(cemi[2], 0xa0);
  });
});

// ── GA and association table builders ───────────────────────────────────────

import { buildGATable, buildAssocTable } from '../server/routes/index.ts';

describe('buildGATable', () => {
  // Wire format corrected 2026-08-29: [count:2 BE][GA:2 BE]*count - was
  // previously a 1-byte count field, which doesn't match what real ETS
  // actually writes. Found and fixed by testing this function's real
  // output against real hardware for the first time (see
  // docs/knx-device-write-protocol.md §2.6/§1.1 - a real captured write of
  // `000249014904` decodes cleanly as `[count=2][GA 9/1/1][GA 9/1/4]` with
  // a 2-byte count, never a 1-byte one).
  it('encodes group addresses into binary table', () => {
    const gaLinks: any[] = [
      { main_g: 1, middle_g: 0, sub_g: 0 },
      { main_g: 1, middle_g: 0, sub_g: 1 },
      { main_g: 11, middle_g: 0, sub_g: 0 },
    ];
    const buf = buildGATable(gaLinks);
    assert.equal(buf.readUInt16BE(0), 3); // count (2-byte BE)
    assert.equal(buf.length, 2 + 3 * 2);
    // GA 1/0/0 = 0x08, 0x00
    assert.equal(buf[2], 0x08);
    assert.equal(buf[3], 0x00);
    // GA 1/0/1 = 0x08, 0x01
    assert.equal(buf[4], 0x08);
    assert.equal(buf[5], 0x01);
    // GA 11/0/0 = 0x58, 0x00
    assert.equal(buf[6], 0x58);
    assert.equal(buf[7], 0x00);
  });

  it('handles empty list', () => {
    const buf = buildGATable([]);
    assert.equal(buf.length, 2);
    assert.equal(buf.readUInt16BE(0), 0);
  });
});

describe('buildAssocTable', () => {
  // Wire format corrected 2026-08-29: [count:2 BE][gaIndex:2 BE]
  // [coNumber:2 BE]*count (GA index BEFORE com-object number, both 2-byte
  // fields, 1-based gaIndex) - was previously a 1-byte count field and
  // 1-byte [CO_num, GA_idx] entries with CO first, matching neither the
  // real field widths nor the real field order. Confirmed via direct byte
  // decode of a real captured Full Download - see
  // docs/knx-device-write-protocol.md §2.6/§1.1 (`00020001000500020008`
  // decodes as `[count=2][gaIndex=1,coNumber=5][gaIndex=2,coNumber=8]`).
  it('preserves the real declared entry order (coRows order, then a com object\'s own GA list order) - does NOT re-sort by GA index', () => {
    // Real bug, found live 2026-08-30: this used to sort entries by GA
    // index then CO number, discarding the real declared order entirely -
    // a real captured ETS association table for a live device came back
    // reordered by koolenex. Entry order is not incidental: it's the only
    // encoding of which link a communication object actively sends on
    // (docs/knx-device-write-protocol.md §6.3). `coRows` is already
    // fetched `ORDER BY object_number` by the real caller (routes/bus.ts),
    // which already matches real ETS's own order directly - this function
    // must preserve that push order, not re-sort it.
    const gaLinks: any[] = [
      { address: '1/0/0', main_g: 1, middle_g: 0, sub_g: 0 },
      { address: '1/0/1', main_g: 1, middle_g: 0, sub_g: 1 },
    ];
    const coRows: any[] = [
      { object_number: 7, ga_address: '1/0/0 1/0/1' },
      { object_number: 8, ga_address: '1/0/0' },
    ];
    const buf = buildAssocTable(coRows, gaLinks);
    assert.equal(buf.readUInt16BE(0), 3); // 3 entries: GA1→CO7, GA2→CO7, GA1→CO8
    assert.equal(buf.length, 2 + 3 * 4);
    // Declared order: CO 7's own two links first (in the order its own
    // ga_address list lists them), then CO 8's one link.
    assert.equal(buf.readUInt16BE(2), 1); // gaIndex 1 (1/0/0)
    assert.equal(buf.readUInt16BE(4), 7); // coNumber 7
    assert.equal(buf.readUInt16BE(6), 2); // gaIndex 2 (1/0/1)
    assert.equal(buf.readUInt16BE(8), 7); // coNumber 7
    assert.equal(buf.readUInt16BE(10), 1); // gaIndex 1 (1/0/0)
    assert.equal(buf.readUInt16BE(12), 8); // coNumber 8
  });

  it('handles empty inputs', () => {
    const buf = buildAssocTable([], []);
    assert.equal(buf.length, 2);
    assert.equal(buf.readUInt16BE(0), 0);
  });

  it('skips GAs not in the link table', () => {
    const gaLinks: any[] = [
      { address: '1/0/0', main_g: 1, middle_g: 0, sub_g: 0 },
    ];
    const coRows: any[] = [{ object_number: 1, ga_address: '1/0/0 9/9/9' }];
    const buf = buildAssocTable(coRows, gaLinks);
    assert.equal(buf.readUInt16BE(0), 1); // only 1/0/0 matched
  });
});

// ── ETS parser helpers ──────────────────────────────────────────────────────

import { looksEncrypted, inferType, buildFlags } from '../server/ets-parser.ts';

describe('looksEncrypted', () => {
  it('returns false for UTF-8 BOM + XML', () => {
    assert.equal(looksEncrypted(Buffer.from([0xef, 0xbb, 0xbf, 0x3c])), false);
  });

  it('returns false for plain XML starting with <', () => {
    assert.equal(looksEncrypted(Buffer.from('<KNX')), false);
  });

  it('returns true for binary data', () => {
    assert.equal(looksEncrypted(Buffer.from([0x00, 0x01, 0x02, 0x03])), true);
  });

  it('returns false for null/empty', () => {
    assert.equal(looksEncrypted(null), false);
    assert.equal(looksEncrypted(Buffer.alloc(0)), false);
    assert.equal(looksEncrypted(Buffer.alloc(1)), false);
  });

  it('returns false for XML with leading whitespace', () => {
    assert.equal(looksEncrypted(Buffer.from(' <KNX')), false);
    assert.equal(looksEncrypted(Buffer.from('\t<KNX')), false);
    assert.equal(looksEncrypted(Buffer.from('\n<KNX')), false);
    assert.equal(looksEncrypted(Buffer.from('\r\n<KNX')), false);
  });
});

describe('inferType', () => {
  it('detects routers', () => {
    assert.equal(inferType('IP Router', '', ''), 'router');
    assert.equal(inferType('KNXip interface', '', ''), 'router');
    assert.equal(inferType('Backbone coupler', '', ''), 'router');
    assert.equal(inferType('', '', '', { isCoupler: true }), 'router');
  });

  it('detects sensors', () => {
    assert.equal(inferType('Push-button 4-gang', '', ''), 'sensor');
    assert.equal(inferType('Temperature sensor', '', ''), 'sensor');
    assert.equal(inferType('Presence detector', '', ''), 'sensor');
    assert.equal(inferType('Weather station', '', ''), 'sensor');
    assert.equal(inferType('CO2 sensor', '', ''), 'sensor');
    assert.equal(inferType('Motion detector', '', ''), 'sensor');
    assert.equal(inferType('Keypad', '', ''), 'sensor');
    assert.equal(inferType('Scene panel', '', ''), 'sensor');
  });

  it('defaults to actuator', () => {
    assert.equal(inferType('Switch actuator 8-fold', '', ''), 'actuator');
    assert.equal(inferType('Dimmer 4x210W', '', ''), 'actuator');
    assert.equal(inferType('Power supply', '', ''), 'actuator');
  });

  it('checks all three text fields', () => {
    assert.equal(inferType('', 'router-ref', ''), 'router');
    assert.equal(inferType('', '', 'button model'), 'sensor');
  });
});

describe('buildFlags', () => {
  it('builds CRWTU for all flags set', () => {
    assert.equal(
      buildFlags({ comm: true, read: true, write: true, tx: true, u: true }),
      'CRWTU',
    );
  });

  it('builds CW for comm + write', () => {
    assert.equal(
      buildFlags({ comm: true, read: false, write: true, tx: false, u: false }),
      'CW',
    );
  });

  it('defaults to CW when no flags set', () => {
    assert.equal(buildFlags({}), 'CW');
    assert.equal(
      buildFlags({
        comm: false,
        read: false,
        write: false,
        tx: false,
        u: false,
      }),
      'CW',
    );
  });

  it('builds CR for comm + read', () => {
    assert.equal(buildFlags({ comm: true, read: true }), 'CR');
  });

  it('builds CRT for comm + read + transmit', () => {
    assert.equal(buildFlags({ comm: true, read: true, tx: true }), 'CRT');
  });

  it('includes U flag for update', () => {
    assert.equal(buildFlags({ comm: true, write: true, u: true }), 'CWU');
  });
});
