/**
 * KNX CEMI frame building/parsing, APDU builders, and address encoding.
 */

import { encodeDpt } from './knx-dpt.ts';

// Extended 10-bit APCI codes (used for property/memory management services)
export const APCI_EXT = {
  PropertyValue_Read: 0x03d5,
  PropertyValue_Response: 0x03d6,
  PropertyValue_Write: 0x03d7,
} as const;

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

export function encodePhysical(addr: string): Buffer {
  const [a, l, d] = addr.split('.').map(Number);
  return Buffer.from([(a! << 4) | (l! & 0xf), d! & 0xff]);
}

export function encodeGroup(addr: string): Buffer {
  const [m, mi, s] = addr.split('/').map(Number);
  return Buffer.from([(m! << 3) | (mi! & 0x7), s! & 0xff]);
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

export function apduPropertyValueWrite(
  seq: number,
  objIdx: number,
  propId: number,
  data: Buffer,
): Buffer {
  const meta = Buffer.from([objIdx & 0xff, propId & 0xff, 0x10, 0x01]);
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
): Buffer {
  const meta = Buffer.from([objIdx & 0xff, propId & 0xff, 0x10, 0x01]);
  return apduConnectedFull(seq, APCI_EXT.PropertyValue_Read, meta);
}

export function apduControl(tpciCode: number, seq: number = 0): Buffer {
  const tpci =
    tpciCode === TPCI.ACK || tpciCode === TPCI.NAK
      ? tpciCode + (seq & 0xf)
      : tpciCode;
  return Buffer.from([tpci << 2]);
}

// ── CEMI frame builder ─────────────────────────────────────────────────────────

export function buildCEMI(
  srcAddr: string,
  dstAddr: string,
  apdu: Buffer,
  isGroup: boolean,
): Buffer {
  const src = encodePhysical(srcAddr || '0.0.0');
  const dst = isGroup ? encodeGroup(dstAddr) : encodePhysical(dstAddr);
  const cf2 = isGroup ? 0xe0 : 0x60;
  const buf = Buffer.alloc(9 + apdu.length);
  buf[0] = MC.REQ;
  buf[1] = 0x00;
  buf[2] = 0xbc;
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
}

export function parseCEMI(buf: Buffer, off: number = 0): CemiFrame | null {
  if (buf.length < off + 8) return null;
  const msgCode = buf[off]!;
  if (msgCode !== MC.REQ && msgCode !== MC.IND && msgCode !== MC.CON)
    return null;
  const addInfoLen = buf[off + 1]!;
  const base = off + 2 + addInfoLen;
  if (buf.length < base + 6) return null;
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
    const tpciBits = (apdu[0]! >> 2) & 0x3f;
    if ((tpciBits & 0x30) === 0x00) tpciType = 'DATA_GROUP';
    else if ((tpciBits & 0x30) === 0x10) tpciType = 'DATA_CONNECTED';
    else if ((tpciBits & 0x30) === 0x20) tpciType = 'CONTROL';
    else tpciType = 'ACK';
  } else if (apdu.length === 1) {
    const tpciBits = (apdu[0]! >> 2) & 0x3f;
    if ((tpciBits & 0x30) === 0x20)
      tpciType = tpciBits === TPCI.CONNECT ? 'CONNECT' : 'DISCONNECT';
    else if ((tpciBits & 0x30) === 0x30) tpciType = 'ACK';
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
  };
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
