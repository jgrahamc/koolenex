/**
 * KNX Datapoint Type (DPT) encoding and decoding.
 */

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
      return Buffer.from([parseInt(value as string, 10) & 0x03]);
    }
    case '3': {
      // DPT 3: 1 byte, 4 bits — control + 3-bit stepcode
      if (typeof value === 'object' && value !== null) {
        const c = (value as Record<string, unknown>).control ? 1 : 0;
        const s =
          parseInt((value as Record<string, unknown>).stepcode as string, 10) &
          0x07;
        return Buffer.from([(c << 3) | s]);
      }
      return Buffer.from([parseInt(value as string, 10) & 0x0f]);
    }
    case '4': {
      // DPT 4: 1 byte — ASCII/8859-1 character
      const ch =
        typeof value === 'string'
          ? value.charCodeAt(0) || 0
          : parseInt(value as string, 10) & 0xff;
      return Buffer.from([ch & 0xff]);
    }
    case '5':
      return Buffer.from([
        Math.min(255, Math.max(0, parseInt(value as string, 10))),
      ]);
    case '6': {
      // DPT 6: 1 byte — signed int8 (-128..127)
      const b = Buffer.alloc(1);
      b.writeInt8(Math.min(127, Math.max(-128, parseInt(value as string, 10))));
      return b;
    }
    case '7': {
      // DPT 7: 2 bytes — 16-bit unsigned
      const b = Buffer.alloc(2);
      b.writeUInt16BE(
        Math.min(65535, Math.max(0, parseInt(value as string, 10))),
      );
      return b;
    }
    case '8': {
      // DPT 8: 2 bytes — 16-bit signed
      const b = Buffer.alloc(2);
      b.writeInt16BE(
        Math.min(32767, Math.max(-32768, parseInt(value as string, 10))),
      );
      return b;
    }
    case '9': {
      const v = parseFloat(value as string);
      if (!Number.isFinite(v)) return Buffer.from([0, 0]);
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
        day = parseInt(obj.day as string, 10) || 0;
        hour = parseInt(obj.hour as string, 10) || 0;
        min = parseInt(obj.min as string, 10) || 0;
        sec = parseInt(obj.sec as string, 10) || 0;
      } else if (typeof value === 'string') {
        const m = value.match(/^(\w+)\s+(\d+):(\d+):(\d+)$/);
        if (m) {
          day = DAYS[m[1]!.toLowerCase()] || 0;
          hour = parseInt(m[2]!, 10);
          min = parseInt(m[3]!, 10);
          sec = parseInt(m[4]!, 10);
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
        day = parseInt(obj.day as string, 10);
        month = parseInt(obj.month as string, 10);
        year = parseInt(obj.year as string, 10);
      } else if (typeof value === 'string') {
        const parts = value.split('-');
        if (parts.length === 3) {
          year = parseInt(parts[0]!, 10);
          month = parseInt(parts[1]!, 10);
          day = parseInt(parts[2]!, 10);
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
      b.writeUInt32BE(Math.max(0, parseInt(value as string, 10)) >>> 0);
      return b;
    }
    case '13': {
      // DPT 13: 4 bytes — 32-bit signed
      const b = Buffer.alloc(4);
      b.writeInt32BE(parseInt(value as string, 10) | 0);
      return b;
    }
    case '14': {
      const b = Buffer.alloc(4);
      const fv = parseFloat(value as string);
      if (!Number.isFinite(fv)) return Buffer.alloc(4, 0);
      b.writeFloatBE(fv);
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
      return Buffer.from([parseInt(value as string, 10) & 0x3f]);
    }
    case '18': {
      // DPT 18: 1 byte — scene control
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        const c = obj.control ? 1 : 0;
        const s = parseInt(obj.scene as string, 10) & 0x3f;
        return Buffer.from([(c << 7) | s]);
      }
      return Buffer.from([parseInt(value as string, 10) & 0xff]);
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
      return Buffer.from([parseInt(value as string, 10) & 0xff]);
    }
    case '232': {
      // DPT 232: 3 bytes — RGB colour
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>;
        return Buffer.from([
          parseInt(obj.r as string, 10) & 0xff,
          parseInt(obj.g as string, 10) & 0xff,
          parseInt(obj.b as string, 10) & 0xff,
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
        const parts = value.split(',').map((s) => parseInt(s.trim(), 10));
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
          Math.max(0, parseInt(obj.brightness as string, 10) || 0),
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
        b[0] = parseInt(obj.r as string, 10) & 0xff;
        b[1] = parseInt(obj.g as string, 10) & 0xff;
        b[2] = parseInt(obj.b as string, 10) & 0xff;
        b[3] = parseInt(obj.w as string, 10) & 0xff;
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
      return Buffer.from([parseInt(value as string, 10) & 0xff]);
  }
}

export function decodeDptBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  return buf.toString('hex');
}
