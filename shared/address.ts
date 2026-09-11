/**
 * KNX address parsing, formatting and ordering.
 *
 * An individual address is `area.line.device` (4 bits, 4 bits, 8 bits) and a
 * group address is `main/middle/sub` (5, 3, 8). Both were being pulled apart
 * with ad-hoc `split()` and `Number()` in fifteen-odd places across the
 * client and the server, each with its own idea of what was valid - which is
 * how `POST /projects/:id/gas` came to accept `99/99/999` while the
 * group-name PATCH beside it enforced 0-31 and 0-7.
 *
 * The ranges here are the wire format's, not a policy: they are exactly what
 * fits in the bits.
 */

export interface IndividualAddress {
  area: number;
  line: number;
  device: number;
}

export interface GroupAddress {
  main: number;
  middle: number;
  sub: number;
}

const inRange = (n: number, max: number) =>
  Number.isInteger(n) && n >= 0 && n <= max;

/**
 * `'1.1.10'` -> its parts, or null if it is not an individual address that
 * can be put on the wire. Strict: no whitespace, no empty parts, no
 * out-of-range values - `'99.99.999'` is null rather than something that
 * masks down to a different, real device.
 */
export function parseIA(
  addr: string | null | undefined,
): IndividualAddress | null {
  if (!addr) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return null;
  const area = Number(m[1]);
  const line = Number(m[2]);
  const device = Number(m[3]);
  if (!inRange(area, 15) || !inRange(line, 15) || !inRange(device, 255))
    return null;
  return { area, line, device };
}

export function formatIA(a: IndividualAddress): string {
  return `${a.area}.${a.line}.${a.device}`;
}

/** True for an individual address the wire format can carry. */
export function isValidIA(addr: string | null | undefined): boolean {
  return parseIA(addr) !== null;
}

/**
 * `'1/2/3'` -> its parts, or null if it is not a three-level group address
 * that can be put on the wire.
 *
 * Two-level (`'1/2'`) is deliberately NOT accepted here. The project stores
 * such addresses and the UI shows them, but the wire path has only ever
 * handled three levels - decodeGroup() always produces three - so what a
 * two-level address means on the bus is an open question rather than
 * something to answer in a parser. See knx-cemi.ts's encodeGroup().
 */
export function parseGA(addr: string | null | undefined): GroupAddress | null {
  if (!addr) return null;
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(addr);
  if (!m) return null;
  const main = Number(m[1]);
  const middle = Number(m[2]);
  const sub = Number(m[3]);
  if (!inRange(main, 31) || !inRange(middle, 7) || !inRange(sub, 255))
    return null;
  return { main, middle, sub };
}

export function formatGA(g: GroupAddress): string {
  return `${g.main}/${g.middle}/${g.sub}`;
}

/** True for a three-level group address the wire format can carry. */
export function isValidGA(addr: string | null | undefined): boolean {
  return parseGA(addr) !== null;
}

/**
 * Order two addresses the way a person reads them: by each part as a
 * number, so 1.1.2 comes before 1.1.10, which a string sort gets wrong.
 *
 * Takes the raw strings and splits on either separator, so it orders
 * individual and group addresses alike, and does not reject what it cannot
 * parse - sorting a list is no place to be strict. Anything unparseable
 * sorts last, in a stable order.
 */
export function compareAddr(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const parts = (s: string | null | undefined): number[] =>
    (s || '').split(/[./]/).map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
    });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}
