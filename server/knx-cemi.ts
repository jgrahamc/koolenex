/**
 * KNX CEMI frame building/parsing, APDU builders, and address encoding.
 */

import { encodeDpt } from './knx-dpt.ts';
import { parseIA, parseGA } from '../shared/address.ts';

// Extended 10-bit APCI codes (used for property/memory management services)
export const APCI_EXT = {
  Authorize_Request: 0x03d1,
  Authorize_Response: 0x03d2,
  PropertyValue_Read: 0x03d5,
  PropertyValue_Response: 0x03d6,
  PropertyValue_Write: 0x03d7,
  // Extended memory services (System B / System 7 devices; share the ADC 4-bit
  // group and are disambiguated by exact 10-bit match).
  MemoryExtended_Write: 0x01fb,
  MemoryExtended_Write_Response: 0x01fc,
  MemoryExtended_Read: 0x01fd,
  MemoryExtended_Read_Response: 0x01fe,
  // A_IndividualAddressSerialNumber_{Write,Read,Response} - NM_IndividualAddress_
  // SerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4): assign/query a device's
  // individual address by its 6-byte KNX serial, no programming-button press
  // needed. GROUP-type broadcast to 0/0/0 at System priority, never
  // point-to-point. Wire format: docs/knx-device-write-protocol.md §9.
  IndividualAddressSerialNumber_Read: 0x03dc,
  IndividualAddressSerialNumber_Response: 0x03dd,
  IndividualAddressSerialNumber_Write: 0x03de,
  // A_SystemNetworkParameter_{Read,Response,Write} - implements
  // NM_Read_SerialNumber_By_ProgrammingMode via PID_SERIAL_NUMBER (11) on
  // object type 0 (Device): queries the serial of whichever device is
  // currently in physical programming mode. Codes per Calimero's
  // ManagementClientImpl.java. Unlike the individual-address services above,
  // this is an individual-type broadcast (dst 0.0.0, system-broadcast bit
  // clear), not group-address 0/0/0.
  SystemNetworkParam_Read: 0x01c8,
  SystemNetworkParam_Response: 0x01c9,
  SystemNetworkParam_Write: 0x01ca,
  // A_PropertyDescription_Read/_Response, A_FunctionPropertyExtState_Read -
  // sent purely for capture parity with real ETS (see
  // apduPropertyDescriptionRead()/apduFuncPropExtStateRead() and their call
  // sites in readDeviceInfo()/downloadDevice()); no decision is gated on
  // either response.
  PropertyDescription_Read: 0x03d8,
  PropertyDescription_Response: 0x03d9,
  FunctionPropertyExtState_Read: 0x01d5,
  FunctionPropertyExt_Response: 0x01d6,
  // A_Restart, Extended form, WITH response - distinct from the plain
  // unconfirmed basic Restart (APCI 14). Real ETS uses this for System-B-mask
  // devices, waiting for `RestartResp $000000` before disconnecting; sends
  // plain basic Restart to at least one confirmed non-System-B device
  // instead. Payload/response byte semantics aren't spec-confirmed - sent/
  // matched byte-for-byte as captured.
  Restart_Extended: 0x0381,
  Restart_Extended_Response: 0x03a1,
} as const;

// 10-bit extended APCIs that need exact-match decoding (name by full code).
const APCI_EXT_NAMES: Record<number, string> = {
  0x01fb: 'MemoryExtended_Write',
  0x01fc: 'MemoryExtended_Write_Response',
  0x01fd: 'MemoryExtended_Read',
  0x01fe: 'MemoryExtended_Read_Response',
  0x0381: 'Restart_Extended',
  0x03a1: 'Restart_Extended_Response',
  // The answer to A_FunctionPropertyExtState_Read. Without an entry it is
  // named after its 4-bit base APCI ('ADC_Response') and a wait for it never
  // matches.
  0x01d6: 'FunctionPropertyExt_Response',
};

// CEMI message codes
export const MC = { REQ: 0x11, IND: 0x29, CON: 0x2e } as const;

// APCI codes — index into this array is the 4-bit APCI field
const APCI_NAMES = [
  'GroupValue_Read', // 0
  'GroupValue_Response', // 1
  'GroupValue_Write', // 2
  'PhysicalAddress_Write', // 3
  'PhysicalAddress_Read', // 4
  'PhysicalAddress_Response', // 5
  'ADC_Read', // 6
  'ADC_Response', // 7
  'Memory_Read', // 8
  'Memory_Response', // 9
  'Memory_Write', // 10
  'UserMemory', // 11
  'DeviceDescriptor_Read', // 12
  'DeviceDescriptor_Response', // 13
  'Restart', // 14
  'OTHER', // 15
] as const;
const APCI: Record<string, number> = Object.fromEntries(
  APCI_NAMES.map((n, i) => [n, i]),
);

// TPCI 6-bit codes (placed in bits 15-10 of the APDU 16-bit word)
export const TPCI = {
  DATA_GROUP: 0x00, // unnumbered group data
  DATA_CONNECTED: 0x10, // connection-oriented data, seq in bits 3-0
  CONNECT: 0x20, // T_CONNECT  (standalone 1-byte APDU)
  DISCONNECT: 0x21, // T_DISCONNECT (standalone 1-byte APDU)
  ACK: 0x30, // T_ACK, seq in bits 3-0
  NAK: 0x31, // T_NAK
} as const;

// ── Address encoding ───────────────────────────────────────────────────────────

/**
 * Refuse rather than mask an out-of-range address - silently wrapping it
 * (e.g. 99/99/999 -> 3/3/231) sends the telegram to an unrelated device,
 * worse than not writing at all.
 */
export function encodePhysical(addr: string): Buffer {
  const ia = parseIA(addr);
  if (!ia) throw new Error(`Invalid individual address: ${addr}`);
  return Buffer.from([(ia.area << 4) | ia.line, ia.device]);
}

export function encodeGroup(addr: string): Buffer {
  const ga = parseGA(addr);
  if (ga) return Buffer.from([(ga.main << 3) | ga.middle, ga.sub]);
  // Two-level ('1/2') is padded to three levels ('1/2/0'), not KNX's actual
  // two-level scheme (main + 11-bit sub, i.e. 1/0/2) - decodeGroup() only
  // ever produces three levels, and changing this changes which device
  // receives the telegram. Left as-is deliberately.
  const two = /^(\d+)\/(\d+)$/.exec(addr);
  if (two) {
    const main = Number(two[1]);
    const middle = Number(two[2]);
    if (main >= 0 && main <= 31 && middle >= 0 && middle <= 7)
      return Buffer.from([(main << 3) | middle, 0]);
  }
  throw new Error(`Invalid group address: ${addr}`);
}

export function decodePhysical(buf: Buffer, off: number = 0): string {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  return `${b0 >> 4}.${b0 & 0xf}.${b1}`;
}

export function decodeGroup(buf: Buffer, off: number = 0): string {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  return `${(b0 >> 3) & 0x1f}/${b0 & 0x7}/${b1}`;
}

// ── APDU builders ──────────────────────────────────────────────────────────────

export function apduGroup(
  apciName: string,
  shortData: number = 0,
  extraBuf: Buffer | null = null,
): Buffer {
  const apciIdx = APCI[apciName] ?? APCI.OTHER!;
  const word = TPCI.DATA_GROUP * 0x400 + apciIdx * 0x40 + (shortData & 0x3f);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(word & 0xffff);
  return extraBuf ? Buffer.concat([header, extraBuf]) : header;
}

export function apduGroupRead(): Buffer {
  return apduGroup('GroupValue_Read');
}
export function apduGroupResponse(encoded: Buffer): Buffer {
  if (encoded.length === 1 && encoded[0]! <= 0x3f)
    return apduGroup('GroupValue_Response', encoded[0]);
  return apduGroup('GroupValue_Response', 0, encoded);
}
export function apduGroupWrite(value: unknown, dpt: string | number): Buffer {
  const enc = encodeDpt(value, dpt);
  if (enc.length === 1 && enc[0]! <= 0x3f)
    return apduGroup('GroupValue_Write', enc[0]);
  return apduGroup('GroupValue_Write', 0, enc);
}

export function apduConnected(
  seq: number,
  apciName: string,
  extraBuf: Buffer | null = null,
): Buffer {
  const apciIdx = APCI[apciName] ?? APCI.OTHER!;
  const tpci = TPCI.DATA_CONNECTED + (seq & 0xf);
  const word = tpci * 0x400 + apciIdx * 0x40;
  const header = Buffer.alloc(2);
  header.writeUInt16BE(word & 0xffff);
  return extraBuf ? Buffer.concat([header, extraBuf]) : header;
}

export function apduConnectedFull(
  seq: number,
  fullApci: number,
  extraBuf: Buffer | null = null,
): Buffer {
  const tpci = TPCI.DATA_CONNECTED + (seq & 0xf);
  const word = ((tpci << 10) | (fullApci & 0x3ff)) & 0xffff;
  const header = Buffer.alloc(2);
  header.writeUInt16BE(word);
  return extraBuf ? Buffer.concat([header, extraBuf]) : header;
}

// count/startIndex default to 1/1 - most property accesses here are
// single-element. A few are array-style (e.g. PID 27 on objIdx4 for some
// apps: read as one N=2 from index 1, written as two separate elements at
// startIndex 1 and 2) and need both passed explicitly.
export function apduPropertyValueWrite(
  seq: number,
  objIdx: number,
  propId: number,
  data: Buffer,
  count = 1,
  startIndex = 1,
): Buffer {
  const meta = Buffer.from([
    objIdx & 0xff,
    propId & 0xff,
    ((count & 0x0f) << 4) | ((startIndex >> 8) & 0x0f),
    startIndex & 0xff,
  ]);
  return apduConnectedFull(
    seq,
    APCI_EXT.PropertyValue_Write,
    data && data.length ? Buffer.concat([meta, data]) : meta,
  );
}

export function apduPropertyValueRead(
  seq: number,
  objIdx: number,
  propId: number,
  count = 1,
  startIndex = 1,
): Buffer {
  const meta = Buffer.from([
    objIdx & 0xff,
    propId & 0xff,
    ((count & 0x0f) << 4) | ((startIndex >> 8) & 0x0f),
    startIndex & 0xff,
  ]);
  return apduConnectedFull(seq, APCI_EXT.PropertyValue_Read, meta);
}

// 5-byte (ObjType-hi, ObjType-lo, OI-1, const 0x10, PropId) meta prefix used
// by both OT/OI-addressed extended-property services below - only ever
// called with OI=1 (the only instance either real caller here needs).
function extPropMeta(objType: number, propId: number): Buffer {
  const OI = 1;
  return Buffer.from([
    (objType >> 8) & 0xff,
    objType & 0xff,
    (OI - 1) & 0xff,
    0x10,
    propId & 0xff,
  ]);
}

/**
 * A_FunctionPropertyExtState_Read - real ETS reads this (OT=17/OI=1/P=51,
 * PID_SECURITY_MODE, KNX Security Object) right after DeviceDescriptor_Read
 * to check Data Secure status before any plaintext write. Informational
 * probe only (see readDeviceInfo()) - logged, not gated on.
 */
export function apduFuncPropExtStateRead(
  seq: number,
  objType: number,
  propId: number,
): Buffer {
  return apduConnectedFull(
    seq,
    APCI_EXT.FunctionPropertyExtState_Read,
    Buffer.concat([extPropMeta(objType, propId), Buffer.from([0x00, 0x00])]),
  );
}

/**
 * A_PropertyDescription_Read - real ETS reads this on the Association table
 * (OX=2 P=23) right before its load cycle begins, most plausibly to discover
 * the property's max array size before writing it. Request shape:
 * [objIdx][propId][propIndex] (propIndex=0 requests by PropertyId, not list
 * position). Informational probe only (see downloadDevice()) - this codebase
 * already knows its table sizes statically.
 */
export function apduPropertyDescriptionRead(
  seq: number,
  objIdx: number,
  propId: number,
  propIndex = 0,
): Buffer {
  const meta = Buffer.from([objIdx & 0xff, propId & 0xff, propIndex & 0xff]);
  return apduConnectedFull(seq, APCI_EXT.PropertyDescription_Read, meta);
}

/**
 * A_Authorize_Request (0x3D1): [reserved(1)][key(4, BE)]. ETS sends this
 * with the well-known/default key 0xFFFFFFFF before property/memory writes
 * needing elevated access. Response (A_Authorize_Response, 0x3D2) carries a
 * single access-level byte (0 = full access).
 */
export function apduAuthorizeRequest(
  seq: number,
  key: number = 0xffffffff,
): Buffer {
  const extra = Buffer.alloc(5);
  extra.writeUInt32BE(key >>> 0, 1); // byte 0 stays reserved/0
  return apduConnectedFull(seq, APCI_EXT.Authorize_Request, extra);
}

export function apduMemoryRead(
  seq: number,
  count: number,
  address: number,
): Buffer {
  // APCI Memory_Read = 0b1000; the 6-bit byte count sits in octet7[5:0].
  const fullApci = (APCI.Memory_Read! << 6) | (count & 0x3f);
  const addr = Buffer.from([(address >> 8) & 0xff, address & 0xff]);
  return apduConnectedFull(seq, fullApci, addr);
}

export function apduMemoryWrite(
  seq: number,
  address: number,
  data: Buffer,
): Buffer {
  // APCI Memory_Write = 0b1010; the 6-bit byte count sits in octet7[5:0] -
  // must go through apduConnectedFull(), not apduConnected() + a manually
  // tacked-on count byte: apduConnected() never sets those low 6 bits, so a
  // count byte added that way is parsed as the address's high byte instead,
  // corrupting the target address.
  const fullApci = (APCI.Memory_Write! << 6) | (data.length & 0x3f);
  const addr = Buffer.from([(address >> 8) & 0xff, address & 0xff]);
  return apduConnectedFull(seq, fullApci, Buffer.concat([addr, data]));
}

export function apduMemoryExtendedRead(
  seq: number,
  count: number,
  address: number,
): Buffer {
  // A_MemoryExtended_Read (0x1FD): [count(1)] + [address(3, big-endian)].
  const extra = Buffer.from([
    count & 0xff,
    (address >> 16) & 0xff,
    (address >> 8) & 0xff,
    address & 0xff,
  ]);
  return apduConnectedFull(seq, APCI_EXT.MemoryExtended_Read, extra);
}

export function apduMemoryExtendedWrite(
  seq: number,
  address: number,
  data: Buffer,
): Buffer {
  // A_MemoryExtended_Write (0x1FB): [count(1)] + [address(3, big-endian)] + [data...].
  // Same header shape as the read (minus returned data). See docs/knx-device-write-protocol.md.
  const extra = Buffer.concat([
    Buffer.from([
      data.length & 0xff,
      (address >> 16) & 0xff,
      (address >> 8) & 0xff,
      address & 0xff,
    ]),
    data,
  ]);
  return apduConnectedFull(seq, APCI_EXT.MemoryExtended_Write, extra);
}

/**
 * A_Restart (Extended, with response) - see APCI_EXT.Restart_Extended.
 * Payload is the literal 2 bytes real ETS sends ($01, $00), replayed
 * byte-for-byte; not derived from the KNX spec's Restart Type/Erase
 * Code/Channel Number field layout.
 */
export function apduRestartExtended(seq: number): Buffer {
  return apduConnectedFull(
    seq,
    APCI_EXT.Restart_Extended,
    Buffer.from([0x01, 0x00]),
  );
}

/**
 * Build an APDU carrying a 10-bit extended APCI with UNNUMBERED transport
 * (TPCI_DATA_GROUP, no sequence number) - the shape used for broadcast
 * destinations, which don't carry a transport-layer connection the way a
 * point-to-point managementSession() does. `apduConnectedFull` is the
 * numbered/connected equivalent used by every other extended-APCI service
 * in this module.
 */
export function apduExtUnnumbered(
  fullApci: number,
  extraBuf: Buffer | null = null,
): Buffer {
  const word = ((TPCI.DATA_GROUP << 10) | (fullApci & 0x3ff)) & 0xffff;
  const header = Buffer.alloc(2);
  header.writeUInt16BE(word);
  return extraBuf ? Buffer.concat([header, extraBuf]) : header;
}

/**
 * A_IndividualAddressSerialNumber_Write (0x3DE). Payload: 6-byte serial +
 * 2-byte new individual address + 4 reserved/zero bytes. Caller sends it as
 * a system broadcast (buildCEMI's `systemBroadcast` option); this only
 * builds the APDU.
 */
export function apduIndividualAddressSerialNumberWrite(
  serial: Buffer,
  newAddr: string,
): Buffer {
  if (serial.length !== 6) {
    throw new Error(`KNX serial number must be 6 bytes, got ${serial.length}`);
  }
  const extra = Buffer.concat([
    serial,
    encodePhysical(newAddr),
    Buffer.alloc(4),
  ]);
  return apduExtUnnumbered(APCI_EXT.IndividualAddressSerialNumber_Write, extra);
}

/**
 * A_IndividualAddressSerialNumber_Read (0x3DC). Payload: just the 6-byte
 * serial number. Sent as a system broadcast; only the device whose own
 * serial number matches is expected to answer with
 * A_IndividualAddressSerialNumber_Response.
 */
export function apduIndividualAddressSerialNumberRead(serial: Buffer): Buffer {
  if (serial.length !== 6) {
    throw new Error(`KNX serial number must be 6 bytes, got ${serial.length}`);
  }
  return apduExtUnnumbered(APCI_EXT.IndividualAddressSerialNumber_Read, serial);
}

export interface IndividualAddressSerialNumberResponse {
  serial: Buffer;
  address: string;
}

/**
 * Decode an A_IndividualAddressSerialNumber_Response payload: 6-byte serial
 * + 4 reserved/zero bytes - no address field. The address is communicated
 * by *which device replies* (`frame.src`), same convention as
 * A_IndividualAddress_Response. Caller should verify `serial` matches the
 * one queried before trusting `address` - a broadcast reply isn't
 * request-correlated.
 */
export function parseIndividualAddressSerialNumberResponse(
  frame: CemiFrame,
): IndividualAddressSerialNumberResponse {
  const d = frame.apduData;
  return { serial: d.slice(0, 6), address: frame.src };
}

/**
 * A_SystemNetworkParameter_Read (0x1C8). Payload: [objectType(2, BE)]
 * [pid<<4 (2, BE)][operand(1)][...additionalTestInfo]. Used for
 * NM_Read_SerialNumber_By_ProgrammingMode: objectType=0 (Device), pid=11
 * (PID_SERIAL_NUMBER), operand=1. Real ETS repeats this roughly every 3s
 * while waiting for a device to enter programming mode. Sent as a
 * GROUP-type frame to `0/0/0` with `{ priority: 'system' }` (ctrl1 `0xB0`).
 */
export function apduSystemNetworkParamRead(
  objectType: number,
  pid: number,
  operand: number,
  additionalTestInfo: Buffer = Buffer.alloc(0),
): Buffer {
  const asdu = Buffer.concat([
    Buffer.from([
      (objectType >> 8) & 0xff,
      objectType & 0xff,
      ((pid << 4) >> 8) & 0xff,
      (pid << 4) & 0xff,
    ]),
    Buffer.from([operand & 0xff]),
    additionalTestInfo,
  ]);
  return apduExtUnnumbered(APCI_EXT.SystemNetworkParam_Read, asdu);
}

export interface SystemNetworkParamResponse {
  objectType: number;
  pid: number;
  value: Buffer;
}

/**
 * Decode an A_SystemNetworkParameter_Response payload: [objectType(2,
 * BE)][pid<<4 (2, BE)][echoedOperand(1)][...value]. The response echoes the
 * request's operand byte before the value. `value` is empty when the
 * object type/PID is unsupported - treat as "no data", not a fixed length.
 */
export function parseSystemNetworkParamResponse(
  frame: CemiFrame,
): SystemNetworkParamResponse {
  const d = frame.apduData;
  const objectType = (d[0]! << 8) | d[1]!;
  const pid = ((d[2]! << 8) | d[3]!) >> 4;
  const value = d.length > 5 ? d.slice(5) : Buffer.alloc(0);
  return { objectType, pid, value };
}

export function apduControl(tpciCode: number, seq: number = 0): Buffer {
  // Control PDU octet: T_Connect=0x80, T_Disconnect=0x81,
  // T_Ack=0b11 SSSS 10, T_Nak=0b11 SSSS 11 (the low 2 bits mark the PDU type).
  let b: number;
  if (tpciCode === TPCI.CONNECT) b = 0x80;
  else if (tpciCode === TPCI.DISCONNECT) b = 0x81;
  else if (tpciCode === TPCI.ACK) b = 0xc2 | ((seq & 0xf) << 2);
  else if (tpciCode === TPCI.NAK) b = 0xc3 | ((seq & 0xf) << 2);
  else b = (tpciCode << 2) & 0xff;
  return Buffer.from([b]);
}

// ── CEMI frame builder ─────────────────────────────────────────────────────────

export function buildCEMI(
  srcAddr: string,
  dstAddr: string,
  apdu: Buffer,
  isGroup: boolean,
  opts?: { priority?: 'low' | 'system'; systemBroadcast?: boolean },
): Buffer {
  const src = encodePhysical(srcAddr || '0.0.0');
  const dst = isGroup ? encodeGroup(dstAddr) : encodePhysical(dstAddr);
  const cf2 = isGroup ? 0xe0 : 0x60;
  // Control Field 1 defaults to 0xBC (std frame / don't-repeat / ordinary
  // broadcast / Low priority). KNX network-management broadcasts need System
  // priority: ctrl1=0xB0 (bits3-2=00, ordinary-broadcast bit4=1 kept).
  // `systemBroadcast` additionally clears bit4 (the spec's separate "system
  // broadcast" bit) - opt-in, unused by any service here today.
  let ctrl1 = 0xbc;
  if (opts?.priority === 'system') ctrl1 &= ~0x0c; // bits3-2 -> 00 (System)
  if (opts?.systemBroadcast) ctrl1 &= ~0x10; // bit4 -> 0 (system broadcast)
  const buf = Buffer.alloc(9 + apdu.length);
  buf[0] = MC.REQ;
  buf[1] = 0x00;
  buf[2] = ctrl1;
  buf[3] = cf2;
  src.copy(buf, 4);
  dst.copy(buf, 6);
  buf[8] = apdu.length - 1;
  apdu.copy(buf, 9);
  return buf;
}

// ── CEMI parser ────────────────────────────────────────────────────────────────

export interface CemiFrame {
  msgCode: number;
  src: string;
  dst: string;
  isGroup: boolean;
  apciIdx: number | null;
  apciName: string | null;
  apduData: Buffer;
  apdu: Buffer;
  tpciType: string | null;
  /**
   * cEMI Control Field 1, bit 0. On an L_Data.con, reports whether the frame
   * reached the bus: 0 = positive, 1 = negative. Meaningless otherwise.
   */
  confirmBit?: number;
}

export function parseCEMI(buf: Buffer, off: number = 0): CemiFrame | null {
  if (buf.length < off + 8) return null;
  const msgCode = buf[off]!;
  if (msgCode !== MC.REQ && msgCode !== MC.IND && msgCode !== MC.CON)
    return null;
  const addInfoLen = buf[off + 1]!;
  const base = off + 2 + addInfoLen;
  if (buf.length < base + 6) return null;
  const cf1 = buf[base]!;
  const cf2 = buf[base + 1]!;
  const isGroup = !!(cf2 & 0x80);
  const srcBuf = buf.slice(base + 2, base + 4);
  const dstBuf = buf.slice(base + 4, base + 6);
  const dataLen = buf[base + 6]!;
  const apdu = buf.slice(base + 7, base + 7 + dataLen + 1);
  if (apdu.length < 1) return null;

  const src = decodePhysical(srcBuf);
  const dst = isGroup ? decodeGroup(dstBuf) : decodePhysical(dstBuf);

  let apciName: string | null = null,
    apciIdx: number | null = null,
    apduData: Buffer = Buffer.alloc(0),
    tpciType: string | null = null;
  if (apdu.length >= 2) {
    apciIdx = ((apdu[0]! & 0x03) << 2) | ((apdu[1]! & 0xc0) >> 6);
    apciName = APCI_NAMES[apciIdx] || 'OTHER';
    apduData = apdu.length > 2 ? apdu.slice(2) : Buffer.from([apdu[1]! & 0x3f]);
    // Extended 10-bit APCIs (e.g. MemoryExtended) overlap the ADC 4-bit group;
    // resolve by exact full-code match and keep the whole payload as apduData.
    const fullApci = ((apdu[0]! & 0x03) << 8) | apdu[1]!;
    if (APCI_EXT_NAMES[fullApci]) {
      apciName = APCI_EXT_NAMES[fullApci]!;
      apciIdx = fullApci;
      apduData = apdu.slice(2);
    }
    const tpciBits = (apdu[0]! >> 2) & 0x3f;
    if ((tpciBits & 0x30) === 0x00) tpciType = 'DATA_GROUP';
    else if ((tpciBits & 0x30) === 0x10) tpciType = 'DATA_CONNECTED';
    else if ((tpciBits & 0x30) === 0x20) tpciType = 'CONTROL';
    else tpciType = 'ACK';
  } else if (apdu.length === 1) {
    // Control PDUs: T_Connect=0x80 and T_Disconnect=0x81 differ only in bit 0,
    // which a `>> 2` would discard — match the whole byte. T_Ack/T_Nak carry
    // the sequence in bits 5-2 with 0b11xxxx10/11 framing.
    const b = apdu[0]!;
    if (b === 0x80) tpciType = 'CONNECT';
    else if (b === 0x81) tpciType = 'DISCONNECT';
    else if ((b & 0xc0) === 0xc0) tpciType = 'ACK';
  }

  return {
    msgCode,
    src,
    dst,
    isGroup,
    apciIdx,
    apciName,
    apduData,
    apdu,
    tpciType,
    confirmBit: cf1 & 0x01,
  };
}

// ── A_Memory_Response parsing ────────────────────────────────────────────────

export interface MemoryResponse {
  address: number;
  data: Buffer;
}

/** Decode an A_Memory_Response CemiFrame into { address, data }. */
export function parseMemoryResponse(frame: CemiFrame): MemoryResponse {
  const declaredCount = (frame.apdu[1] ?? 0) & 0x3f;
  const address = ((frame.apduData[0] ?? 0) << 8) | (frame.apduData[1] ?? 0);
  // Never trust the declared count past what the payload actually carries — a
  // malformed/short response must yield the bytes present, not a longer slice.
  const count = Math.min(declaredCount, Math.max(0, frame.apduData.length - 2));
  const data = frame.apduData.slice(2, 2 + count);
  return { address, data };
}

export interface MemoryExtendedResponse {
  returnCode: number;
  address: number;
  data: Buffer;
}

/**
 * Decode an A_MemoryExtended_Read_Response (System B / System 7).
 * Payload: [return_code(1)][address(3, big-endian)][data...]. returnCode 0 = OK.
 */
export function parseMemoryExtendedResponse(
  frame: CemiFrame,
): MemoryExtendedResponse {
  const d = frame.apduData;
  const returnCode = d[0]!;
  const address = (d[1]! << 16) | (d[2]! << 8) | d[3]!;
  const data = d.slice(4);
  return { returnCode, address, data };
}

// ── Event type from APCI ───────────────────────────────────────────────────────

export function eventType(apciName: string): string {
  if (apciName === 'GroupValue_Read') return 'GroupValue_Read';
  if (apciName === 'GroupValue_Response') return 'GroupValue_Response';
  if (apciName === 'GroupValue_Write') return 'GroupValue_Write';
  return apciName || 'Unknown';
}

// Export for testing
export const _apduGroupRead = apduGroupRead;
export const _apduGroupWrite = apduGroupWrite;
export const _apduGroupResponse = apduGroupResponse;
export const _apduControl = apduControl;
export const _apduPropertyValueRead = apduPropertyValueRead;
export const _apduPropertyValueWrite = apduPropertyValueWrite;
export const _TPCI = TPCI;
export const _APCI = APCI;
