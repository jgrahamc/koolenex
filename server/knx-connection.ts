/**
 * KnxConnection — base class for KNX bus communication.
 * Contains all shared protocol logic (CEMI, APDU, management sessions, etc.)
 * Transport-specific subclasses (UDP, USB) implement sendCEMI() and connect/disconnect.
 */

import EventEmitter from 'events';

// Extended 10-bit APCI codes (used for property/memory management services)
const APCI_EXT = {
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
const TPCI = {
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

// ── DPT encode / decode ────────────────────────────────────────────────────────

export function encodeDpt(value: unknown, dpt: string | number): Buffer {
  const d = String(dpt).split('.')[0];
  switch (d) {
    case '1': {
      const v = typeof value === 'string' ? value.toLowerCase().trim() : value;
      return Buffer.from([
        v === true ||
        v === 'true' ||
        v === '1' ||
        v === 1 ||
        v === 'on' ||
        v === 'yes' ||
        v === 'enable'
          ? 1
          : 0,
      ]);
    }
    case '2': {
      // DPT 2: 1 byte, 2 bits — control + value
      if (typeof value === 'object' && value !== null) {
        const c = (value as Record<string, unknown>).control ? 1 : 0;
        const v = (value as Record<string, unknown>).value ? 1 : 0;
        return Buffer.from([(c << 1) | v]);
      }
      return Buffer.from([parseInt(value as string) & 0x03]);
    }
    case '3': {
      // DPT 3: 1 byte, 4 bits — control + 3-bit stepcode
      if (typeof value === 'object' && value !== null) {
        const c = (value as Record<string, unknown>).control ? 1 : 0;
        const s =
          parseInt((value as Record<string, unknown>).stepcode as string) &
          0x07;
        return Buffer.from([(c << 3) | s]);
      }
      return Buffer.from([parseInt(value as string) & 0x0f]);
    }
    case '4': {
      // DPT 4: 1 byte — ASCII/8859-1 character
      const ch =
        typeof value === 'string'
          ? value.charCodeAt(0) || 0
          : parseInt(value as string) & 0xff;
      return Buffer.from([ch & 0xff]);
    }
    case '5':
      return Buffer.from([
        Math.min(255, Math.max(0, parseInt(value as string))),
      ]);
    case '6': {
      // DPT 6: 1 byte — signed int8 (-128..127)
      const b = Buffer.alloc(1);
      b.writeInt8(Math.min(127, Math.max(-128, parseInt(value as string))));
      return b;
    }
    case '7': {
      // DPT 7: 2 bytes — 16-bit unsigned
      const b = Buffer.alloc(2);
      b.writeUInt16BE(Math.min(65535, Math.max(0, parseInt(value as string))));
      return b;
    }
    case '8': {
      // DPT 8: 2 bytes — 16-bit signed
      const b = Buffer.alloc(2);
      b.writeInt16BE(
        Math.min(32767, Math.max(-32768, parseInt(value as string))),
      );
      return b;
    }
    case '9': {
      const v = parseFloat(value as string);
      let mant = Math.round(v * 100),
        exp = 0;
      while (mant < -2048 || mant > 2047) {
        mant = Math.round(mant / 2);
        exp++;
      }
      const sign = mant < 0 ? 1 : 0;
      if (sign) mant = mant + 2048; // sign-magnitude 11-bit: store absolute value
      const raw = ((sign & 1) << 15) | ((exp & 0xf) << 11) | (mant & 0x7ff);
      const b = Buffer.alloc(2);
      b.writeUInt16BE(raw & 0xffff);
      return b;
    }
    case '10': {
      // DPT 10: 3 bytes — time of day
      const DAYS: Record<string, number> = {
        mon: 1,
        tue: 2,
        wed: 3,
        thu: 4,
        fri: 5,
        sat: 6,
        sun: 7,
      };
      let day = 0,
        hour = 0,
        min = 0,
        sec = 0;
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        day = parseInt(obj.day as string) || 0;
        hour = parseInt(obj.hour as string) || 0;
        min = parseInt(obj.min as string) || 0;
        sec = parseInt(obj.sec as string) || 0;
      } else if (typeof value === 'string') {
        const m = value.match(/^(\w+)\s+(\d+):(\d+):(\d+)$/);
        if (m) {
          day = DAYS[m[1]!.toLowerCase()] || 0;
          hour = parseInt(m[2]!);
          min = parseInt(m[3]!);
          sec = parseInt(m[4]!);
        }
      }
      return Buffer.from([
        ((day & 0x07) << 5) | (hour & 0x1f),
        min & 0x3f,
        sec & 0x3f,
      ]);
    }
    case '11': {
      // DPT 11: 3 bytes — date
      let day: number | undefined,
        month: number | undefined,
        year: number | undefined;
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        day = parseInt(obj.day as string);
        month = parseInt(obj.month as string);
        year = parseInt(obj.year as string);
      } else if (typeof value === 'string') {
        const parts = value.split('-');
        if (parts.length === 3) {
          year = parseInt(parts[0]!);
          month = parseInt(parts[1]!);
          day = parseInt(parts[2]!);
        }
      }
      if (day! < 1 || day! > 31)
        throw new RangeError(`DPT 11 day must be 1-31, got ${day}`);
      if (month! < 1 || month! > 12)
        throw new RangeError(`DPT 11 month must be 1-12, got ${month}`);
      if (year! < 1990 || year! > 2089)
        throw new RangeError(`DPT 11 year must be 1990-2089, got ${year}`);
      const y = year! >= 2000 ? year! - 2000 : year! - 1900;
      return Buffer.from([day!, month!, y]);
    }
    case '12': {
      // DPT 12: 4 bytes — 32-bit unsigned
      const b = Buffer.alloc(4);
      b.writeUInt32BE(Math.max(0, parseInt(value as string)) >>> 0);
      return b;
    }
    case '13': {
      // DPT 13: 4 bytes — 32-bit signed
      const b = Buffer.alloc(4);
      b.writeInt32BE(parseInt(value as string) | 0);
      return b;
    }
    case '14': {
      const b = Buffer.alloc(4);
      b.writeFloatBE(parseFloat(value as string));
      return b;
    }
    case '16': {
      // DPT 16: 14 bytes — fixed-length string
      const b = Buffer.alloc(14, 0x00);
      const s = typeof value === 'string' ? value : String(value);
      for (let i = 0; i < Math.min(s.length, 14); i++) {
        b[i] = s.charCodeAt(i) & 0xff;
      }
      return b;
    }
    case '17': {
      // DPT 17: 1 byte — scene number (0-63)
      return Buffer.from([parseInt(value as string) & 0x3f]);
    }
    case '18': {
      // DPT 18: 1 byte — scene control
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        const c = obj.control ? 1 : 0;
        const s = parseInt(obj.scene as string) & 0x3f;
        return Buffer.from([(c << 7) | s]);
      }
      return Buffer.from([parseInt(value as string) & 0xff]);
    }
    case '19': {
      // DPT 19: 8 bytes — date/time
      let dt: Date;
      if (value instanceof Date) {
        dt = value;
      } else if (typeof value === 'string') {
        dt = new Date(value);
      } else {
        dt = new Date();
      }
      const dow = dt.getDay() === 0 ? 7 : dt.getDay(); // 1=Mon..7=Sun
      const b = Buffer.alloc(8, 0x00);
      b[0] = dt.getFullYear() - 1900;
      b[1] = (dt.getMonth() + 1) & 0x0f;
      b[2] = ((dow & 0x07) << 5) | (dt.getDate() & 0x1f);
      b[3] = dt.getHours() & 0x1f;
      b[4] = dt.getMinutes() & 0x3f;
      b[5] = dt.getSeconds() & 0x3f;
      // b[6], b[7] = status flags, left as 0
      return b;
    }
    case '20': {
      // DPT 20: 1 byte — 8-bit enum
      return Buffer.from([parseInt(value as string) & 0xff]);
    }
    case '232': {
      // DPT 232: 3 bytes — RGB colour
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        return Buffer.from([
          parseInt(obj.r as string) & 0xff,
          parseInt(obj.g as string) & 0xff,
          parseInt(obj.b as string) & 0xff,
        ]);
      }
      if (typeof value === 'string') {
        if (value.startsWith('#') && value.length >= 7) {
          return Buffer.from([
            parseInt(value.slice(1, 3), 16),
            parseInt(value.slice(3, 5), 16),
            parseInt(value.slice(5, 7), 16),
          ]);
        }
        const parts = value.split(',').map((s) => parseInt(s.trim()));
        if (parts.length >= 3) {
          return Buffer.from([
            parts[0]! & 0xff,
            parts[1]! & 0xff,
            parts[2]! & 0xff,
          ]);
        }
      }
      return Buffer.from([0, 0, 0]);
    }
    case '242': {
      // DPT 242: 6 bytes — xyY colour
      const b = Buffer.alloc(6, 0x00);
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        const xVal = Math.round(
          Math.min(1, Math.max(0, parseFloat(obj.x as string) || 0)) * 65535,
        );
        const yVal = Math.round(
          Math.min(1, Math.max(0, parseFloat(obj.y as string) || 0)) * 65535,
        );
        const bri = Math.min(
          255,
          Math.max(0, parseInt(obj.brightness as string) || 0),
        );
        b.writeUInt16BE(xVal, 0);
        b.writeUInt16BE(yVal, 2);
        b[4] = bri;
        let flags = 0;
        if (obj.x != null || obj.y != null) flags |= 0x02; // colour valid
        if (obj.brightness != null) flags |= 0x01; // brightness valid
        b[5] = flags;
      }
      return b;
    }
    case '251': {
      // DPT 251: 6 bytes — RGBW colour
      const b = Buffer.alloc(6, 0x00);
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        b[0] = parseInt(obj.r as string) & 0xff;
        b[1] = parseInt(obj.g as string) & 0xff;
        b[2] = parseInt(obj.b as string) & 0xff;
        b[3] = parseInt(obj.w as string) & 0xff;
        // b[4] = reserved
        let flags = 0;
        if (obj.r != null) flags |= 0x08;
        if (obj.g != null) flags |= 0x04;
        if (obj.b != null) flags |= 0x02;
        if (obj.w != null) flags |= 0x01;
        b[5] = flags;
      } else if (
        typeof value === 'string' &&
        value.startsWith('#') &&
        value.length >= 9
      ) {
        b[0] = parseInt(value.slice(1, 3), 16);
        b[1] = parseInt(value.slice(3, 5), 16);
        b[2] = parseInt(value.slice(5, 7), 16);
        b[3] = parseInt(value.slice(7, 9), 16);
        b[5] = 0x0f; // all valid
      }
      return b;
    }
    default:
      return Buffer.from([parseInt(value as string) & 0xff]);
  }
}

export function decodeDptBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  return buf.toString('hex');
}

// ── APDU builders ──────────────────────────────────────────────────────────────

function apduGroup(
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

function apduGroupRead(): Buffer {
  return apduGroup('GroupValue_Read');
}
function apduGroupResponse(encoded: Buffer): Buffer {
  if (encoded.length === 1 && encoded[0]! <= 0x3f)
    return apduGroup('GroupValue_Response', encoded[0]);
  return apduGroup('GroupValue_Response', 0, encoded);
}
function apduGroupWrite(value: unknown, dpt: string | number): Buffer {
  const enc = encodeDpt(value, dpt);
  if (enc.length === 1 && enc[0]! <= 0x3f)
    return apduGroup('GroupValue_Write', enc[0]);
  return apduGroup('GroupValue_Write', 0, enc);
}

function apduConnected(
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

function apduConnectedFull(
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

function apduPropertyValueWrite(
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

function apduPropertyValueRead(
  seq: number,
  objIdx: number,
  propId: number,
): Buffer {
  const meta = Buffer.from([objIdx & 0xff, propId & 0xff, 0x10, 0x01]);
  return apduConnectedFull(seq, APCI_EXT.PropertyValue_Read, meta);
}

function apduControl(tpciCode: number, seq: number = 0): Buffer {
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

function eventType(apciName: string): string {
  if (apciName === 'GroupValue_Read') return 'GroupValue_Read';
  if (apciName === 'GroupValue_Response') return 'GroupValue_Response';
  if (apciName === 'GroupValue_Write') return 'GroupValue_Write';
  return apciName || 'Unknown';
}

// ── Telegram type ──────────────────────────────────────────────────────────────

interface Telegram {
  timestamp: string;
  src: string;
  dst: string;
  type: string;
  raw_value: string;
  decoded: string;
  priority: string;
}

// ── Download step type ─────────────────────────────────────────────────────────

export interface DownloadStep {
  type: string;
  objIdx: number;
  propId: number;
  data?: Buffer;
  size?: number;
  offset?: number;
}

export interface DownloadProgress {
  msg: string;
  pct?: number;
  done?: boolean;
}

// ── Device info type ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  descriptor: string;
  address: string;
  serialNumber?: string;
  manufacturerId?: number;
  programVersion?: {
    manufacturerId: number;
    deviceType: number;
    appVersion: number;
  };
  orderInfo?: string;
  hardwareType?: string;
  firmwareRevision?: number;
  error?: string;
}

// ── Scan progress type ─────────────────────────────────────────────────────────

export interface ScanProgress {
  address: string;
  reachable: boolean;
  descriptor: string | null;
  done: number;
  total: number;
}

// ── Management session helpers ──────────────────────────────────────────────────

interface ManagementSessionFns {
  sendData: (apciName: string, extraBuf?: Buffer | null) => Promise<void>;
  waitResponse: (apciNameExpected: string, ms?: number) => Promise<CemiFrame>;
  nextSeq: () => number;
}

// ── KnxConnection base class ───────────────────────────────────────────────────

export class KnxConnection extends EventEmitter {
  localAddr: string;
  connected: boolean;
  _scanAbort: boolean;

  constructor() {
    super();
    this.localAddr = '0.0.0'; // physical addr (assigned by gateway or USB device)
    this.connected = false;
    this._scanAbort = false;
  }

  /**
   * Send a CEMI frame over the transport. Must be implemented by subclasses.
   * @param {Buffer} cemi - raw CEMI frame
   * @returns {Promise<void>}
   */
  sendCEMI(_cemi: Buffer): Promise<void> {
    throw new Error('sendCEMI() must be implemented by transport subclass');
  }

  /** Disconnect from the bus. Must be implemented by transport subclass. */
  disconnect(): void {
    throw new Error('disconnect() must be implemented by transport subclass');
  }

  /** Called by transport subclass when a CEMI frame is received from the bus. */
  _onCEMI(cemi: CemiFrame): void {
    if (cemi.isGroup && cemi.apciName) {
      const raw = cemi.apduData.toString('hex');
      const decoded = decodeDptBuffer(cemi.apduData);
      const telegram: Telegram = {
        timestamp: new Date().toISOString(),
        src: cemi.src,
        dst: cemi.dst,
        type: eventType(cemi.apciName),
        raw_value: raw,
        decoded,
        priority: 'low',
      };
      this.emit('telegram', telegram);
    } else if (!cemi.isGroup) {
      this.emit('_mgmt', cemi);
    }
  }

  // ── Group communication ───────────────────────────────────────────────────────

  async write(
    ga: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduGroupWrite(value, dpt);
    const cemi = buildCEMI(this.localAddr, ga, apdu, true);
    await this.sendCEMI(cemi);
    return { ok: true, ga, value, dpt };
  }

  // Note: no request correlation ID — concurrent reads to the same GA could
  // consume each other's responses. KNX has no request/response correlation
  // at the group level, so this is a protocol-level limitation, not a bug.
  read(
    ga: string,
    timeoutMs: number = 4000,
  ): Promise<{ ga: string; value: string }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onTelegram = (tg: Telegram): void => {
        if (tg.dst === ga && tg.type === 'GroupValue_Response') {
          clearTimeout(timer);
          this.off('telegram', onTelegram);
          resolve({ ga, value: tg.decoded });
        }
      };
      const timer = setTimeout(() => {
        this.off('telegram', onTelegram);
        reject(new Error('Read timeout'));
      }, timeoutMs);
      this.on('telegram', onTelegram);
      const cemi = buildCEMI(this.localAddr, ga, apduGroupRead(), true);
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        reject(err);
      });
    });
  }

  // ── Management session ────────────────────────────────────────────────────────

  async managementSession(
    deviceAddr: string,
    fn: (fns: ManagementSessionFns) => Promise<void>,
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    let seq = 0;

    const sendControl = async (
      tpciCode: number,
      s: number = 0,
    ): Promise<void> => {
      const apdu = apduControl(tpciCode, s);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const sendData = async (
      apciName: string,
      extraBuf: Buffer | null = null,
    ): Promise<void> => {
      const apdu = apduConnected(seq, apciName, extraBuf);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const waitResponse = (
      apciNameExpected: string,
      ms: number = timeoutMs,
    ): Promise<CemiFrame> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.off('_mgmt', handler);
          reject(
            new Error(`Management timeout waiting for ${apciNameExpected}`),
          );
        }, ms);
        const handler = (cemi: CemiFrame): void => {
          if (cemi.src === deviceAddr && cemi.apciName === apciNameExpected) {
            clearTimeout(timer);
            this.off('_mgmt', handler);
            resolve(cemi);
          }
        };
        this.on('_mgmt', handler);
      });

    await sendControl(TPCI.CONNECT);
    await delay(100);

    try {
      await fn({ sendData, waitResponse, nextSeq: () => seq++ });
    } finally {
      try {
        await sendControl(TPCI.DISCONNECT);
      } catch (_) {}
    }
  }

  // ── Ping ──────────────────────────────────────────────────────────────────────

  ping(
    gaAddresses: string[],
    deviceAddr: string,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      let done = false;
      const finish = (reachable: boolean, ga: string | null = null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        this.off('_mgmt', onMgmt);
        resolve({ reachable, ga });
      };

      const timer = setTimeout(() => finish(false), timeoutMs);

      const gaSet = new Set(gaAddresses);
      const onTelegram = (tg: Telegram): void => {
        if ((deviceAddr && tg.src === deviceAddr) || gaSet.has(tg.dst))
          finish(true, tg.dst);
      };
      this.on('telegram', onTelegram);

      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish(true, deviceAddr);
      };
      this.on('_mgmt', onMgmt);

      this.managementSession(
        deviceAddr,
        async ({ sendData, waitResponse }) => {
          await sendData('DeviceDescriptor_Read', null);
          await waitResponse('DeviceDescriptor_Response', timeoutMs - 200);
          finish(true, deviceAddr);
        },
        timeoutMs,
      ).catch(() => {});
    });
  }

  // ── Individual address programming ────────────────────────────────────────────

  async programIA(
    newAddr: string,
    _timeoutMs: number = 5000,
  ): Promise<{ ok: boolean; newAddr: string }> {
    if (!this.connected) throw new Error('Not connected');
    const addrBuf = encodePhysical(newAddr);
    const apdu = apduGroup('PhysicalAddress_Write', 0, addrBuf);
    const cemi = buildCEMI(this.localAddr, '0.0.0', apdu, false);
    await this.sendCEMI(cemi);
    return { ok: true, newAddr };
  }

  // ── Application download ──────────────────────────────────────────────────────

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const log = (msg: string): void => {
      if (onProgress) onProgress({ msg });
    };

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const MEM_CHUNK = 10;

      const propWrite = async (
        objIdx: number,
        propId: number,
        data: Buffer,
      ): Promise<void> => {
        const seq = nextSeq();
        const apdu = apduPropertyValueWrite(seq, objIdx, propId, data);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        await this.sendCEMI(cemi);
        await delay(50);
      };

      for (const step of steps) {
        switch (step.type) {
          case 'WriteProp': {
            log(`WriteProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            if (step.data && step.data.length) {
              await propWrite(step.objIdx, step.propId, step.data);
            }
            break;
          }
          case 'CompareProp': {
            log(`CompareProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            break;
          }
          case 'WriteRelMem': {
            log(`WriteRelMem ObjIdx=${step.objIdx} Size=${step.size}`);
            if (!paramMem) throw new Error('Parameter memory not available');
            const mem = paramMem.slice(0, step.size);
            for (let off = 0; off < mem.length; off += MEM_CHUNK) {
              const chunk = mem.slice(off, off + MEM_CHUNK);
              const seq = nextSeq();
              const extra = Buffer.concat([
                Buffer.from([
                  chunk.length,
                  ((step.offset! + off) >> 8) & 0xff,
                  (step.offset! + off) & 0xff,
                ]),
                chunk,
              ]);
              const apdu = apduConnected(seq, 'Memory_Write', extra);
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              await delay(30);
              if (onProgress)
                onProgress({
                  msg: `WriteRelMem ${off}/${mem.length}`,
                  pct: (off / mem.length) * 80,
                });
            }
            break;
          }
          case 'LoadImageProp': {
            log(`LoadImageProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            const imgData =
              step.objIdx === 1 && gaTable
                ? gaTable
                : step.objIdx === 2 && assocTable
                  ? assocTable
                  : Buffer.from([0x04]);
            await propWrite(step.objIdx, step.propId, imgData);
            break;
          }
        }
      }

      log('Download complete');
      if (onProgress)
        onProgress({ msg: 'Download complete', pct: 100, done: true });
    });
  }

  // ── Identify ──────────────────────────────────────────────────────────────────

  async identify(deviceAddr: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const memWrite = (seq: number, addr: number, dataByte: number): Buffer => {
      const extra = Buffer.from([
        0x01,
        (addr >> 8) & 0xff,
        addr & 0xff,
        dataByte,
      ]);
      return apduConnected(seq, 'Memory_Write', extra);
    };

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const seq0 = nextSeq();
      const on = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq0, 0x0060, 0x01),
        false,
      );
      await this.sendCEMI(on);
      await delay(3000);
      const seq1 = nextSeq();
      const off = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq1, 0x0060, 0x00),
        false,
      );
      await this.sendCEMI(off);
    });
  }

  // ── Device info ───────────────────────────────────────────────────────────────

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    if (!this.connected) throw new Error('Not connected');

    const probe = await this._probeSingle(deviceAddr, 2000);
    if (!probe) throw new Error(`Device ${deviceAddr} did not respond`);

    const info: DeviceInfo = {
      descriptor: probe.descriptor,
      address: deviceAddr,
    };

    try {
      await this.managementSession(
        deviceAddr,
        async ({ waitResponse, nextSeq }) => {
          const propRead = async (
            objIdx: number,
            propId: number,
          ): Promise<Buffer | null> => {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
            await this.sendCEMI(cemi);
            const res = await waitResponse('OTHER', 2000);
            return res?.apduData || null;
          };

          const tryProp = async (
            propId: number,
            label: string,
            handler: (data: Buffer) => void,
          ): Promise<void> => {
            try {
              const data = await propRead(0, propId);
              if (data) handler(data);
            } catch (e) {
              console.error(
                `[KNX] ${deviceAddr} prop ${label} (${propId}) read failed:`,
                (e as Error).message,
              );
            }
          };

          await tryProp(11, 'serialNumber', (data) => {
            if (data.length >= 10)
              info.serialNumber = data.slice(4).toString('hex');
          });
          await tryProp(12, 'manufacturerId', (data) => {
            if (data.length >= 6) info.manufacturerId = data.readUInt16BE(4);
          });
          await tryProp(13, 'programVersion', (data) => {
            if (data.length >= 9) {
              const pv = data.slice(4);
              info.programVersion = {
                manufacturerId: pv.readUInt16BE(0),
                deviceType: pv.readUInt16BE(2),
                appVersion: pv[4]!,
              };
            }
          });
          await tryProp(15, 'orderInfo', (data) => {
            if (data.length > 4) {
              const raw = data.slice(4);
              const nullIdx = raw.indexOf(0);
              const text = (nullIdx >= 0 ? raw.slice(0, nullIdx) : raw)
                .toString('ascii')
                .trim();
              info.orderInfo = text || raw.toString('hex');
            }
          });
          await tryProp(78, 'hardwareType', (data) => {
            if (data.length >= 10)
              info.hardwareType = data.slice(4).toString('hex');
          });
          await tryProp(9, 'firmwareRevision', (data) => {
            if (data.length >= 5) info.firmwareRevision = data[4];
          });
        },
      );
    } catch (e) {
      info.error = (e as Error).message;
    }

    return info;
  }

  // ── Bus scan ──────────────────────────────────────────────────────────────────

  _probeSingle(
    deviceAddr: string,
    timeoutMs: number,
  ): Promise<{ descriptor: string } | null> {
    if (!this.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: { descriptor: string } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish({ descriptor: cemi.apduData?.toString('hex') || '' });
      };
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('DeviceDescriptor_Read');
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      this.sendCEMI(cemi).catch(() => {});
    });
  }

  scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    this._scanAbort = false;
    return (async () => {
      const found: Array<{ address: string; descriptor: string }> = [];
      for (let dev = 0; dev <= 255; dev++) {
        if (this._scanAbort) break;
        const addr = `${area}.${line}.${dev}`;
        const result = await this._probeSingle(addr, timeoutMs);
        if (result)
          found.push({ address: addr, descriptor: result.descriptor });
        if (onProgress)
          onProgress({
            address: addr,
            reachable: !!result,
            descriptor: result?.descriptor || null,
            done: dev + 1,
            total: 256,
          });
      }
      return found;
    })();
  }

  abortScan(): void {
    this._scanAbort = true;
  }

  status(): { connected: boolean; hasLib: boolean } {
    return { connected: this.connected, hasLib: true };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
