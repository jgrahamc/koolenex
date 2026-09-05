// ── KNX table builders ────────────────────────────────────────────────────────

// ── ETS dynamic tree types (matches ets-app.ts DynItem emission) ────────────
// The stored model shape is a single recursive `items` array of tagged
// DynItems: dynTree.main.items -> DynItem[], where each item's `type` is one
// of cib/channel/block/choose/paramRef/assign/comRef/rename/separator. This
// mirrors the `DynItem` union in server/ets-app.ts — NOT the legacy
// channels/cib/pb + paramRefs/blocks/choices shape that emission never
// actually produces.

export interface DynWhen {
  test?: string[];
  isDefault?: boolean;
  items?: DynItem[];
}

export interface DynItem {
  type:
    | 'paramRef'
    | 'block'
    | 'channel'
    | 'cib'
    | 'choose'
    | 'assign'
    | 'comRef'
    | 'rename'
    | 'separator';
  // paramRef
  refId?: string;
  // block / channel / cib
  items?: DynItem[];
  // choose
  paramRefId?: string;
  defaultValue?: string | null;
  whens?: DynWhen[];
  // assign
  target?: string;
  source?: string | null;
  value?: string | null;
}

export interface DynTree {
  main?: { items?: DynItem[] } | null;
  moduleDefs?: { id: string; items: DynItem[] }[];
}

export interface ParamDef {
  defaultValue?: string;
  [key: string]: unknown;
}

export interface ParamMemEntry {
  offset: number | null;
  bitOffset: number;
  bitSize: number;
  defaultValue?: string;
  isText?: boolean;
  isFloat?: boolean;
  coefficient?: number;
  fromMemoryChild?: boolean;
  isVisible?: boolean;
  // Display metadata for entries `params` (ParamDef, below) doesn't cover -
  // e.g. Access="None" download-only params, which are excluded from
  // `params` for its own (UI-editing) purposes but still get read/written
  // and deserve a real label in a decode. See ets-app.ts's paramMemLayout
  // construction for how these are derived (generically, from the same ETS
  // product data every other label comes from - not a per-param lookup).
  label?: string;
  section?: string;
  group?: string;
  unit?: string;
  enums?: Record<string, string>;
}

export interface LoadProcedureStep {
  type: string;
  size?: number;
  fill?: number;
  lsmIdx?: number;
  data?: string | null;
  [key: string]: unknown;
}

export interface AbsSegData {
  size: number;
  hex?: string | null;
}

export interface DeviceModel {
  loadProcedures?: LoadProcedureStep[];
  relSegData?: Record<number, string>;
  absSegData?: Record<string, AbsSegData>;
  paramMemLayout?: Record<string, ParamMemEntry>;
  dynTree?: DynTree;
  params?: Record<string, ParamDef>;
  // Object 3 (Group Object Table) real buffer size - see ets-app.ts's
  // ParamModel.groupObjectTableSize's doc comment for the formula/rationale.
  groupObjectTableSize?: number;
}

export interface ParamSegmentResult {
  paramSize: number;
  paramFill: number;
  relSegHex: string | null;
  /**
   * Absolute base address of the resolved AbsoluteSegment (null for
   * RelSegment/WriteRelMem devices, which address memory relatively).
   */
  paramBase: number | null;
}

export interface GaLink {
  address?: string;
  main_g: number;
  middle_g: number;
  sub_g: number;
}

export interface CoRow {
  object_number: number;
  ga_address: string;
}

// Build GA table bytes: [count(1)] + [GA_encoded(2) x count]
export interface MemoryDiffChunk {
  address: number;
  expected: string;
  actual: string;
}

export interface MemoryDiffResult {
  total: number;
  matching: number;
  differing: number;
  chunks: MemoryDiffChunk[];
}

/**
 * Byte-compare a computed image against actual device memory read back from the
 * bus. Compares over the shorter of the two lengths and coalesces consecutive
 * differing bytes into chunks, each tagged with its absolute device address
 * (baseAddress + offset). Used by the read-first verification flow — no writes.
 */
export function diffMemory(
  expected: Buffer,
  actual: Buffer,
  baseAddress: number,
): MemoryDiffResult {
  const total = Math.min(expected.length, actual.length);
  const chunks: MemoryDiffChunk[] = [];
  let differing = 0;
  let run: { start: number; exp: number[]; act: number[] } | null = null;

  const flush = (): void => {
    if (!run) return;
    chunks.push({
      address: baseAddress + run.start,
      expected: Buffer.from(run.exp).toString('hex'),
      actual: Buffer.from(run.act).toString('hex'),
    });
    run = null;
  };

  for (let i = 0; i < total; i++) {
    if (expected[i] !== actual[i]) {
      differing++;
      if (!run) run = { start: i, exp: [], act: [] };
      run.exp.push(expected[i]!);
      run.act.push(actual[i]!);
    } else {
      flush();
    }
  }
  flush();

  return { total, matching: total - differing, differing, chunks };
}

// GA table wire format: [count:2 BE][GA:2 BE]*count. Corrected 2026-08-29 -
// previously used a 1-byte count field (`buf[0] = count & 0xff`), which
// doesn't match what real ETS actually writes (confirmed via direct byte
// decode of a real captured Full Download - see
// docs/knx-device-write-protocol.md §2.6/§1.1's Stage 3 table: a real
// captured write of `000249014904` decodes cleanly as
// `[count=2][GA 9/1/1][GA 9/1/4]` with a 2-byte count, never as a 1-byte
// count). Found by testing this exact function's real output against real
// hardware for the first time (2026-08-29, alongside the fix that made
// koolenex write these tables at all for apps that don't declare their own
// LoadProcedure step for them - see downloadDevice()'s WriteRelMem case) -
// the per-GA byte packing itself (`b0`/`b1` below) was already correct, only
// the count field width was wrong.
export function buildGATable(gaLinks: GaLink[]): Buffer {
  const count = gaLinks.length;
  const buf = Buffer.alloc(2 + count * 2);
  buf.writeUInt16BE(count & 0xffff, 0);
  gaLinks.forEach((ga, i) => {
    const b0 = ((ga.main_g & 0x1f) << 3) | (ga.middle_g & 0x07);
    const b1 = ga.sub_g & 0xff;
    buf[2 + i * 2] = b0;
    buf[3 + i * 2] = b1;
  });
  return buf;
}

// Association table wire format: [count:2 BE][gaIndex:2 BE][coNumber:2 BE]
// x count (GA index first, then com-object number - both 2-byte fields).
// Corrected 2026-08-29 alongside buildGATable() above, same real-hardware
// evidence and same root cause: this previously used a 1-byte count field
// and 1-byte [CO_num, GA_idx] entries (CO first) - matches neither the real
// field widths nor the real field order. Confirmed via direct byte decode
// of a real captured Full Download (docs/knx-device-write-protocol.md
// §2.6/§1.1: `00020001000500020008` decodes as
// `[count=2][gaIndex=1,coNumber=5][gaIndex=2,coNumber=8]`, all 2-byte BE
// fields, gaIndex before coNumber).
//
// Entry ORDER is not incidental - it's the only encoding of which link a
// communication object actively sends on (docs/knx-device-write-protocol.md
// §6.3: "the first entry in table order... is the one it actively
// transmits on"). Real bug, found live 2026-08-30 via a byte-for-byte
// replay of koolenex's own write against a real ETS capture of the same
// device: this function used to re-sort `entries` by GA index (ascending),
// discarding the real declared order entirely - a real captured ETS table
// for 1.1.9 (`0003 0002 0003 0003 0004 0004 0001 0005`, CO order 3,4,5)
// came back reordered by koolenex as CO order 5,3,4 (GA-index order
// instead). `coRows` is already fetched `ORDER BY object_number` (see this
// function's caller in routes/bus.ts), which already matches the real ETS
// order directly - the extra sort was pure, unnecessary damage. Removed;
// entries now keep the push order they're built in.
export function buildAssocTable(coRows: CoRow[], gaLinks: GaLink[]): Buffer {
  const gaIndexMap: Record<string, number> = {};
  gaLinks.forEach((ga, i) => {
    if (ga.address) gaIndexMap[ga.address] = i;
  });

  const entries: [number, number][] = [];
  for (const co of coRows) {
    const gas = (co.ga_address || '').split(/\s+/).filter(Boolean);
    for (const gaAddr of gas) {
      const gaIdx = gaIndexMap[gaAddr];
      // Real table is 1-based (gaIndex 0 in our own array -> real index 1).
      if (gaIdx != null) entries.push([gaIdx + 1, co.object_number]);
    }
  }

  const buf = Buffer.alloc(2 + entries.length * 4);
  buf.writeUInt16BE(entries.length & 0xffff, 0);
  entries.forEach(([gaIdx, co], i) => {
    buf.writeUInt16BE(gaIdx & 0xffff, 2 + i * 4);
    buf.writeUInt16BE(co & 0xffff, 4 + i * 4);
  });
  return buf;
}

// Decode raw GA table bytes (the inverse of buildGATable) back into an
// ordered list of "main/mid/sub" address strings. Format confirmed via
// direct byte decode of a real captured Full Download - see
// docs/knx-device-write-protocol.md §2.6/§1.1 (koolenex repo).
export function decodeGATable(buf: Buffer): string[] {
  if (buf.length < 2) return [];
  const count = buf.readUInt16BE(0);
  const gas: string[] = [];
  for (let i = 0; i < count && 2 + i * 2 + 2 <= buf.length; i++) {
    const raw = buf.readUInt16BE(2 + i * 2);
    const main = (raw >> 11) & 0x1f;
    const mid = (raw >> 8) & 0x07;
    const sub = raw & 0xff;
    gas.push(`${main}/${mid}/${sub}`);
  }
  return gas;
}

// Decode raw Association table bytes (the inverse of buildAssocTable) into
// a map of communication-object number -> its GA address (resolved via the
// paired GA table's own decode, 1-based gaIndex). A com object with
// multiple GA links gets multiple entries in the returned array.
export function decodeAssocTable(
  buf: Buffer,
  gas: string[],
): Array<{ coNumber: number; ga: string | null }> {
  if (buf.length < 2) return [];
  const count = buf.readUInt16BE(0);
  const out: Array<{ coNumber: number; ga: string | null }> = [];
  for (let i = 0; i < count && 2 + i * 4 + 4 <= buf.length; i++) {
    const gaIndex = buf.readUInt16BE(2 + i * 4); // 1-based
    const coNumber = buf.readUInt16BE(2 + i * 4 + 2);
    out.push({ coNumber, ga: gas[gaIndex - 1] ?? null });
  }
  return out;
}

// Object 3 (KNX standard type 9, "Group Object Table") per-communication-object flag byte.
// Full record layout decoded via a systematic real-hardware bit-mapping session (2026-08-29,
// System B mask family only) - see docs/knx-device-write-protocol.md §10.1 for the full evidence
// trail (every bit independently confirmed, reproduced, and cross-checked on a second object, a
// third object with a different DPT/size, and a second device/app entirely, blind).
//
//   byte offset within the table = 2 × communication-object number (confirmed not to reindex
//   when objects are disabled/unlinked elsewhere in the app - §10.1)
//
//   bit 7 = Update flag
//   bit 6 = Transmit flag
//   bit 5 = Read-On-Init flag
//   bit 4 = Write flag
//   bit 3 = Read flag
//   bit 2 = Communication flag AND has at least one real GA link - BOTH required (§10.1; a real
//           correction during this investigation - Communication alone, on an unlinked object,
//           produces no visible effect, which is what looked like "zero representation" until
//           retested on a linked object). Confirmed link-count-independent (1 vs 2 links, same
//           result) and direction-independent (which link is the Send GA lives in the
//           Association table's own entry order instead - see buildAssocTable above - not here).
//   bits 1:0 = Priority: Low=`11`, Alarm=`10`, High=`01`, System=`00` (System not empirically
//           confirmed - not settable from ETS at all per KNX's own documentation, so unreachable
//           for any real project; the pattern-inferred bits are the correct value regardless)
//
// Untested: mask families other than System B (only System B hardware available to this
// project throughout).
export interface GroupObjectFlags {
  object_number: number;
  update?: boolean;
  transmit?: boolean;
  readOnInit?: boolean;
  write?: boolean;
  read?: boolean;
  communication?: boolean;
  /** Whether this communication object has at least one real GA link (see bit 2 above). */
  linked?: boolean;
  priority?: 'low' | 'alarm' | 'high' | 'system';
  /**
   * The object's real ETS `ObjectSize` string (e.g. "1 Bit", "4 Bit", "1 Byte", "3 Bytes",
   * "8 Bytes") - drives the companion byte immediately after the flag byte (see
   * `groupObjectSizeCode()` below). Optional only because a caller with no size data at all
   * still gets a usable (if incomplete) table - the companion byte simply stays `0` (= "1 Bit"),
   * matching every object this project has seen that genuinely IS 1 Bit.
   */
  objectSize?: string;
}

// The companion byte immediately after each object's flag byte (2026-08-29, real-hardware
// confirmed) is the KNX standard "Group Object Size" 4-bit code - NOT unused padding, as
// originally assumed when Object 3's format was first decoded (§10.1). Confirmed by a real,
// independent cross-device/cross-manufacturer test: pulled real ComObject/ComObjectRef
// `ObjectSize` declarations from both testbed apps' own XML and checked them against the real
// captured companion byte at that object's offset - 4 for 4 matches, on two completely different
// devices (1.1.9: DPST-10-1/DPST-11-1, both 3 bytes -> 0x09 on both; DPST-19-1, 8 bytes -> 0x0C.
// 1.1.10: DPST-3-7, 4 bit -> 0x03; DPST-5-1, 1 byte -> 0x07), plus the 1-bit case confirmed
// extensively on both devices by every ordinary object showing companion byte 0. This also
// explains why toggling Read-On-Init (a flag) never moved the mystery byte (docs/knx-device-
// write-protocol.md Part 16) - it isn't flag-derived at all, it's fixed by the object's DPT.
// String keys are ETS's own exact `ObjectSize` attribute text (confirmed against real project
// XML) - singular "Bit"/"Byte" for 1, plural for 2+, matching ETS's own wording.
const GROUP_OBJECT_SIZE_CODES: Record<string, number> = {
  '1 Bit': 0,
  '2 Bit': 1,
  '3 Bit': 2,
  '4 Bit': 3,
  '5 Bit': 4,
  '6 Bit': 5,
  '7 Bit': 6,
  '1 Byte': 7,
  '2 Bytes': 8,
  '3 Bytes': 9,
  '4 Bytes': 10,
  '6 Bytes': 11,
  '8 Bytes': 12,
  '10 Bytes': 13,
  '14 Bytes': 14,
  'Variable length': 15,
};

/**
 * Maps a real ETS `ObjectSize` string to Object 3's companion-byte size code (0-15). Only 4 of
 * the 16 codes have been directly confirmed against real captured hardware bytes so far (4 Bit,
 * 1 Byte, 3 Bytes, 8 Bytes - see the doc comment above); the rest follow the same well-known KNX
 * standard size-code sequence but haven't individually been checked against a real device.
 * Unrecognized/missing input defaults to `0` (1 Bit) rather than throwing - matches this
 * project's own convention elsewhere (e.g. `computeGroupObjectByte()`'s priority default) of
 * degrading to the most common real-world case rather than failing the whole table build.
 */
export function groupObjectSizeCode(objectSize: string | undefined): number {
  return GROUP_OBJECT_SIZE_CODES[(objectSize ?? '').trim()] ?? 0;
}

const GROUP_OBJECT_PRIORITY_BITS: Record<string, number> = {
  low: 0b11,
  alarm: 0b10,
  high: 0b01,
  system: 0b00,
};

/** Computes one communication object's Object-3 flag byte. See the format comment above. */
export function computeGroupObjectByte(co: GroupObjectFlags): number {
  let b = GROUP_OBJECT_PRIORITY_BITS[co.priority ?? 'low']!;
  if (co.update) b |= 1 << 7;
  if (co.transmit) b |= 1 << 6;
  if (co.readOnInit) b |= 1 << 5;
  if (co.write) b |= 1 << 4;
  if (co.read) b |= 1 << 3;
  if (co.communication && co.linked) b |= 1 << 2;
  return b;
}

/**
 * Builds Object 3 (Group Object Table) content: a zero-filled buffer of the device's real,
 * per-app table size (98 bytes for 1.1.9, 942 for 1.1.10 - resolved via PID_TABLE_REFERENCE, not
 * computed here) with each communication object's flag byte placed at `2 × object_number` and its
 * companion size-code byte at `2 × object_number + 1` (see `groupObjectSizeCode()` above).
 * Communication objects not present in `comObjects` are left at the buffer's zero fill, matching
 * every real device default observed (§10.1 - Object 3's content is almost entirely zero-filled;
 * a zero-filled companion byte correctly means "1 Bit", the size of every such absent/unmodeled
 * object seen so far).
 *
 * Bytes 0-1 (the table's first 2 bytes) are a real, confirmed 2-byte big-endian header - NOT a
 * slot for a nonexistent "object 0" as originally assumed - holding the app's total declared
 * communication-object count. Confirmed against real captures on both testbed devices: `0x0030`
 * (48) for 1.1.9, `0x01D6` (470) for 1.1.10 - both exactly matching `maxComObjectNumber`
 * (ets-app.ts), the same value the caller already used to compute `size` itself
 * (`size = 2 × maxComObjectNumber + 2`), so it's derived here from `size` directly rather than
 * requiring a separate parameter (`(size - 2) / 2` recovers the original count exactly).
 */
export function buildGroupObjectTable(
  size: number,
  comObjects: GroupObjectFlags[],
): Buffer {
  const buf = Buffer.alloc(size);
  if (size >= 2) buf.writeUInt16BE((size - 2) / 2, 0);
  for (const co of comObjects) {
    const offset = co.object_number * 2;
    if (offset < 0 || offset >= size) continue; // out of range for this device's real table
    buf[offset] = computeGroupObjectByte(co);
    if (offset + 1 < size) buf[offset + 1] = groupObjectSizeCode(co.objectSize);
  }
  return buf;
}

/**
 * Reads one communication object's raw 2-byte entry back out of a real (or expected) Object 3
 * buffer - the inverse lookup `buildGroupObjectTable()` performs, for verify/compare purposes.
 * Returns `null` when the object's offset falls outside the buffer (never declared/allocated).
 * Deliberately returns the raw bytes, not a re-decoded `GroupObjectFlags` - verify-device only
 * needs to show "does this object's real bytes match what we computed", not re-derive semantic
 * flags from them (that direction, buffer -> flags, hasn't been needed anywhere in this project).
 */
export function decodeGroupObjectEntry(
  buf: Buffer,
  objectNumber: number,
): { flagByte: number; sizeCodeByte: number } | null {
  const offset = objectNumber * 2;
  if (offset < 0 || offset + 1 >= buf.length) return null;
  return { flagByte: buf[offset]!, sizeCodeByte: buf[offset + 1]! };
}

// Reverse of GROUP_OBJECT_PRIORITY_BITS above, for human-readable display.
const GROUP_OBJECT_PRIORITY_NAMES: Record<number, string> = {
  0b11: 'Low',
  0b10: 'Alarm',
  0b01: 'High',
  0b00: 'System',
};

// Reverse of GROUP_OBJECT_SIZE_CODES above, for human-readable display.
const GROUP_OBJECT_SIZE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(GROUP_OBJECT_SIZE_CODES).map(([name, code]) => [code, name]),
);

/**
 * Formats one Object 3 entry (as returned by `decodeGroupObjectEntry()`) into a single
 * human-readable line for display - added 2026-08-29 for the device-compare page (previously
 * showed only the raw hex byte pair, e.g. "4f 0c"), covering every bit `computeGroupObjectByte()`
 * writes plus the size code, not just the ones already shown elsewhere (GA links).
 * `bit2` is shown as a single `Comm+Linked` value, not split into "Communication" and "Linked"
 * separately - the byte itself can't distinguish them (§10.1: both are required to set the bit,
 * and a real device capture alone can't tell you which one, if either, is false when it's clear).
 */
export function describeGroupObjectEntry(entry: {
  flagByte: number;
  sizeCodeByte: number;
}): string {
  const f = decodeGroupObjectEntryFlags(entry);
  return (
    `Update=${f.update ? 'Yes' : 'No'} Transmit=${f.transmit ? 'Yes' : 'No'} ` +
    `ReadOnInit=${f.readOnInit ? 'Yes' : 'No'} Write=${f.write ? 'Yes' : 'No'} ` +
    `Read=${f.read ? 'Yes' : 'No'} Comm+Linked=${f.commLinked ? 'Yes' : 'No'} ` +
    `Priority=${f.priority} Size=${f.size}`
  );
}

/**
 * Structured (not string-formatted) decode of one Object 3 entry - the same six boolean bits
 * `describeGroupObjectEntry()` formats into a sentence, plus Priority/Size, but as real booleans
 * a client can render individually (compact letter chips, ETS-order) or later use as the basis
 * for click-to-edit toggling (2026-08-29 - the device-compare page's flags display was redesigned
 * from one long sentence to per-flag chips, which need real per-flag data, not a string to
 * re-parse). `commLinked` is bit 2 - see `describeGroupObjectEntry()`'s own doc comment for why
 * it's one combined value, not split into "Communication"/"Linked" separately.
 */
export interface GroupObjectEntryFlags {
  update: boolean;
  transmit: boolean;
  readOnInit: boolean;
  write: boolean;
  read: boolean;
  commLinked: boolean;
  priority: string;
  size: string;
}

export function decodeGroupObjectEntryFlags(entry: {
  flagByte: number;
  sizeCodeByte: number;
}): GroupObjectEntryFlags {
  const b = entry.flagByte;
  const has = (bit: number): boolean => !!(b & bit);
  return {
    update: has(1 << 7),
    transmit: has(1 << 6),
    readOnInit: has(1 << 5),
    write: has(1 << 4),
    read: has(1 << 3),
    commLinked: has(1 << 2),
    priority: GROUP_OBJECT_PRIORITY_NAMES[b & 0b11] ?? `0b${(b & 0b11).toString(2)}`,
    size: GROUP_OBJECT_SIZE_NAMES[entry.sizeCodeByte] ?? `code ${entry.sizeCodeByte}`,
  };
}

// Test whether a numeric/string value matches an ETS when-test condition.
export function etsTestMatch(
  val: string | number,
  tests: (string | number)[] | null | undefined,
): boolean {
  const n = parseFloat(String(val));
  for (const t of tests || []) {
    const rm =
      typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]!);
      const op = rm[1];
      if (op === '<' && n < rv) return true;
      if (op === '>' && n > rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '=' && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) {
      return true;
    }
  }
  return false;
}

const CONTAINER_TYPES = new Set(['block', 'channel', 'cib']);

// Build the set of paramRefs that are unconditionally reachable from the
// top-level `items` tree without passing through any `choose` branch.
export function buildUnconditionalChannelSet(
  dynTree: DynTree | null | undefined,
): Set<string> {
  const s = new Set<string>();
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'paramRef' && it.refId) s.add(it.refId);
      else if (CONTAINER_TYPES.has(it.type)) walk(it.items);
      // choose: skip — its contents are conditional
    }
  }
  walk(dynTree?.main?.items);
  return s;
}

// paramRefs reachable through the CURRENTLY-ACTIVE `choose` branches.
export function evalConditionallyActiveParamRefs(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
): Set<string> {
  const conditional = new Set<string>();
  const getVal = (prKey: string): string => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walk(items: DynItem[] | undefined, inChoice: boolean): void {
    for (const it of items || []) {
      if (it.type === 'paramRef') {
        if (inChoice && it.refId) conditional.add(it.refId);
      } else if (CONTAINER_TYPES.has(it.type)) {
        walk(it.items, inChoice);
      } else if (it.type === 'choose') {
        evalChoose(it);
      }
    }
  }
  function evalChoose(ch: DynItem): void {
    const raw = getVal(ch.paramRefId!);
    const val = String(
      raw !== '' && raw != null ? raw : (ch.defaultValue ?? ''),
    );
    let matched = false;
    let def: DynWhen | undefined;
    for (const w of ch.whens || []) {
      if (w.isDefault) {
        def = w;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walk(w.items, true);
      }
    }
    if (!matched && def) walk(def.items, true);
  }
  walk(dynTree?.main?.items, false);
  return conditional;
}

// Encode a value as KNX 2-byte float (DPT 9.x) and write big-endian at byteOffset.
// Format: sign(1) + exponent(4) + mantissa(11). value = 0.01 x mantissa x 2^exponent
export function writeKnxFloat16(
  buf: Buffer,
  byteOffset: number,
  value: number,
): void {
  if (byteOffset + 2 > buf.length) return;
  let m = Math.round(value * 100);
  let e = 0;
  while (m < -2048 || m > 2047) {
    m = Math.round(m / 2);
    e++;
    if (e > 15) break;
  }
  const sign = m < 0 ? 1 : 0;
  if (sign) m = m + 2048;
  const raw = (sign << 15) | ((e & 0xf) << 11) | (m & 0x7ff);
  buf[byteOffset] = (raw >> 8) & 0xff;
  buf[byteOffset + 1] = raw & 0xff;
}

// Write `bitSize` bits of `value` into buf at byte `byteOffset`, starting from bit `bitOffset`.
export function writeBits(
  buf: Buffer,
  byteOffset: number,
  bitOffset: number,
  bitSize: number,
  value: number,
): void {
  if (byteOffset >= buf.length || bitSize <= 0) return;
  const mask = bitSize >= 32 ? 0xffffffff : (1 << bitSize) - 1;
  value = value & mask;
  // Byte-aligned multi-byte: write big-endian (KNX/ETS standard)
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      if (bIdx >= buf.length) continue;
      buf[bIdx] = (value >>> ((byteCount - 1 - i) * 8)) & 0xff;
    }
    return;
  }
  // Sub-byte: bitOffset from MSB (KNX convention: bitOffset=0 is bit 7 of the byte).
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    writeBits(
      buf,
      byteOffset,
      bitOffset,
      bitsInFirstByte,
      value >>> (bitSize - bitsInFirstByte),
    );
    writeBits(buf, byteOffset + 1, 0, bitSize - bitsInFirstByte, value);
    return;
  }
  const shift = 8 - bitOffset - bitSize;
  const bmask = ((1 << bitSize) - 1) << shift;
  buf[byteOffset] = (buf[byteOffset]! & ~bmask) | ((value << shift) & bmask);
}

// Read `bitSize` bits from buf at byte `byteOffset`, starting from bit
// `bitOffset` (KNX convention: bitOffset=0 is bit 7 of the byte, i.e. MSB
// first). Exact structural mirror of writeBits() above - same recursion for
// the sub-byte-spanning-two-bytes case, same big-endian byte order for
// byte-aligned multi-byte fields. Out-of-range bytes read as 0 rather than
// throwing, matching writeBits()'s silent-clamp behavior.
export function readBits(
  buf: Buffer,
  byteOffset: number,
  bitOffset: number,
  bitSize: number,
): number {
  if (bitSize <= 0) return 0;
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    let value = 0;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      const byte = bIdx < buf.length ? buf[bIdx]! : 0;
      value = value * 256 + byte;
    }
    return value;
  }
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    const high = readBits(buf, byteOffset, bitOffset, bitsInFirstByte);
    const low = readBits(buf, byteOffset + 1, 0, bitSize - bitsInFirstByte);
    return high * 2 ** (bitSize - bitsInFirstByte) + low;
  }
  const shift = 8 - bitOffset - bitSize;
  const mask = ((1 << bitSize) - 1) << shift;
  const byte = byteOffset < buf.length ? buf[byteOffset]! : 0;
  return (byte & mask) >>> shift;
}

// Decode a DPT 9 (2-byte KNX float) value. Exact inverse of
// writeKnxFloat16() above.
export function readKnxFloat16(buf: Buffer, byteOffset: number): number {
  if (byteOffset + 2 > buf.length) return 0;
  const raw = (buf[byteOffset]! << 8) | buf[byteOffset + 1]!;
  const sign = (raw >> 15) & 0x1;
  const exp = (raw >> 11) & 0xf;
  let mantissa = raw & 0x7ff;
  if (sign) mantissa = mantissa - 2048;
  return (mantissa * 2 ** exp) / 100;
}

export interface DecodedParam {
  key: string;
  label: string;
  section: string;
  group: string;
  unit: string;
  offset: number;
  bitOffset: number;
  bitSize: number;
  rawValue: number | string;
  value: string;
}

/**
 * Decode a raw parameter-memory buffer (as read back from a device, e.g. via
 * /bus/verify-device's actualHex) into human-readable parameter values -
 * the inverse of buildParamMem(). Reuses the SAME paramMemLayout/params
 * definitions used to build the download image and to compute verify's
 * "expected" value, so a decoded reading is directly comparable to what
 * that machinery already asserts. Does not re-read the bus - operates
 * purely on a buffer already fetched.
 *
 * Every entry with a resolvable byte offset is decoded, regardless of the
 * fromMemoryChild/conditional-activation gating buildParamMem() applies when
 * WRITING - a decode reflects "what these bits currently contain", not
 * "would this parameter have been written". Callers that want to mirror the
 * write-time gating should cross-reference the same conditionallyActive
 * logic on the output themselves.
 */
export function decodeParamMem(
  buf: Buffer,
  paramMemLayout: Record<string, ParamMemEntry>,
  params: Record<string, ParamDef> | null,
): DecodedParam[] {
  const out: DecodedParam[] = [];
  for (const [key, info] of Object.entries(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;
    // Prefer paramMemLayout's own label metadata (covers every param this
    // buffer actually has bits for, including Access="None" download-only
    // ones `params` deliberately excludes for its UI-editing purposes -
    // see ets-app.ts). Fall back to `params` for parity/older callers, then
    // the raw key if genuinely nothing was derivable from the ETS product
    // data either way.
    const def = params?.[key];
    const label = info.label ?? (def?.label as string) ?? key;
    const section = info.section ?? (def?.section as string) ?? '';
    const group = info.group ?? (def?.group as string) ?? '';
    const unit = info.unit ?? (def?.unit as string) ?? '';
    const enums =
      info.enums ?? (def?.enums as Record<string, string> | undefined) ?? {};

    let rawValue: number | string;
    let value: string;

    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      const strBuf = buf.subarray(info.offset, info.offset + byteSize);
      const text = strBuf.toString('latin1').replace(/\0+$/, '');
      rawValue = text;
      value = text;
    } else if (info.isFloat) {
      let f: number;
      if (info.bitSize === 16) f = readKnxFloat16(buf, info.offset);
      else if (info.bitSize === 32) f = buf.readFloatBE(info.offset);
      else if (info.bitSize === 64) f = buf.readDoubleBE(info.offset);
      else f = 0;
      const scaled = info.coefficient ? f * info.coefficient : f;
      rawValue = scaled;
      value = unit ? `${scaled}${unit}` : String(scaled);
    } else {
      const raw = readBits(buf, info.offset, info.bitOffset, info.bitSize);
      const scaled = info.coefficient ? raw * info.coefficient : raw;
      rawValue = scaled;
      const enumLabel = enums[String(raw)];
      value = enumLabel ?? (unit ? `${scaled}${unit}` : String(scaled));
    }

    out.push({
      key,
      label,
      section,
      group,
      unit,
      offset: info.offset,
      bitOffset: info.bitOffset,
      bitSize: info.bitSize,
      rawValue,
      value,
    });
  }
  return out;
}

export interface DynAssign {
  target: string;
  source: string | null;
  value: string | null;
}

// Collect Assign operations whose when-branch is currently active.
export function collectActiveAssigns(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
): DynAssign[] {
  const result: DynAssign[] = [];
  const getVal = (prKey: string): string => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'assign' && it.target) {
        result.push({
          target: it.target,
          source: it.source ?? null,
          value: it.value ?? null,
        });
      } else if (CONTAINER_TYPES.has(it.type)) {
        walk(it.items);
      } else if (it.type === 'choose') {
        evalChoose(it);
      }
    }
  }
  function evalChoose(ch: DynItem): void {
    const raw = getVal(ch.paramRefId!);
    const val = String(
      raw !== '' && raw != null ? raw : (ch.defaultValue ?? ''),
    );
    let matched = false;
    let def: DynWhen | undefined;
    for (const w of ch.whens || []) {
      if (w.isDefault) {
        def = w;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walk(w.items);
      }
    }
    if (!matched && def) walk(def.items);
  }
  walk(dynTree?.main?.items);
  return result;
}

// Determine parameter segment size and base data for a device model.
export function resolveParamSegment(model: DeviceModel): ParamSegmentResult {
  const lps = model.loadProcedures ?? [];
  // Try RelativeSegment path first (most common)
  const writeMemStep = lps.find((s) => s.type === 'WriteRelMem');
  const relSegStep = lps.find((s) => s.type === 'RelSegment');
  if (writeMemStep || relSegStep) {
    const paramSize = writeMemStep?.size ?? relSegStep?.size ?? 0;
    const paramFill = relSegStep?.fill ?? 0xff;
    const paramLsmIdx = relSegStep?.lsmIdx ?? 4;
    const relSegHex = model.relSegData?.[paramLsmIdx] ?? null;
    return { paramSize, paramFill, relSegHex, paramBase: null };
  }
  // Try AbsoluteSegment path
  const absSegs = model.absSegData ?? {};
  const layout = model.paramMemLayout ?? {};
  const paramOffsets = Object.values(layout)
    .map((v) => v.offset)
    .filter((v): v is number => v != null);
  if (paramOffsets.length === 0 || Object.keys(absSegs).length === 0) {
    return { paramSize: 0, paramFill: 0xff, relSegHex: null, paramBase: null };
  }
  const maxOffset = Math.max(...paramOffsets);
  // Pick the TIGHTEST-fitting segment whose size covers every parameter
  // offset — not merely the first one larger than maxOffset. On multi-segment
  // AbsoluteSegment devices (e.g. MDT AKS-0416.03 / 1.1.3) an unrelated,
  // larger segment (the address table) can also exceed maxOffset by pure
  // coincidence; the real parameter segment is the smallest segment that
  // still contains the whole [0, maxOffset] range (confirmed against ETS's
  // own load-state "segment" (event 3) descriptor, which encodes the true
  // base/size).
  let best: [string, AbsSegData] | null = null;
  for (const entry of Object.entries(absSegs)) {
    const seg = entry[1];
    if (seg.size > maxOffset && (!best || seg.size < best[1].size)) {
      best = entry;
    }
  }
  if (best) {
    const [addrKey, seg] = best;
    return {
      paramSize: seg.size,
      paramFill: 0x00,
      relSegHex: seg.hex ?? null,
      paramBase: Number(addrKey),
    };
  }
  // Fallback: use the largest segment
  const largest = Object.entries(absSegs).sort(
    (a, b) => b[1].size - a[1].size,
  )[0];
  if (largest) {
    return {
      paramSize: largest[1].size,
      paramFill: 0x00,
      relSegHex: largest[1].hex ?? null,
      paramBase: Number(largest[0]),
    };
  }
  return { paramSize: 0, paramFill: 0xff, relSegHex: null, paramBase: null };
}

// Build parameter memory segment from the paramMemLayout.
export function buildParamMem(
  size: number,
  paramMemLayout: Record<string, ParamMemEntry>,
  currentValues: Record<string, unknown>,
  fill = 0xff,
  relSegHex: string | null = null,
  dynTree: DynTree | null = null,
  params: Record<string, ParamDef> | null = null,
): Buffer {
  const relSegBase = relSegHex ? Buffer.from(relSegHex, 'hex') : null;

  let buf: Buffer;
  if (relSegBase) {
    buf = Buffer.alloc(size, fill);
    relSegBase.copy(buf, 0, 0, Math.min(relSegBase.length, size));
  } else {
    buf = Buffer.alloc(size, fill);
  }

  // Padding-bit fill fix (2026-08-29, root-caused 2026-08-28, docs/follow-
  // ups/2026-08-28-write-path-missing-load-sequence.md's "wrong padding-bit
  // fill" section): a byte that's only PARTLY a named parameter (a sub-byte
  // field like a 1-bit boolean sharing its byte with unnamed/reserved bits)
  // real ETS/the real device leaves those OTHER bits at 0, not `fill`.
  // Confirmed directly: a real 1-bit boolean at offset 69, bitOffset 0,
  // bitSize 1 - real device value is 0x80 when the flag is on (bit 7 set,
  // all other bits CLEAR), not 0xFF as this function previously computed
  // (it correctly toggled bit 7 via writeBits() below, but left the other 7
  // bits at whatever `fill` was - 0xFF's all-1s by default). `fill` itself
  // stays correct and unchanged for genuinely UNNAMED bytes (no parameter
  // touches them at all) - real captures have consistently shown 0xFF for
  // those (see e.g. docs/knx-device-write-protocol.md §1.1). This only
  // re-zeroes the specific bytes a sub-byte field's OWN declared layout
  // says it occupies, before the real per-param writeBits() calls below run
  // (which then correctly set that field's own bits from its real value,
  // on top of the now-zeroed padding). Skips any byte relSegBase already
  // seeded with real captured content (relSegBase IS a real device default
  // in the one app that uses it - overwriting it with 0 would destroy real,
  // already-correct padding bits, not fix anything).
  const relSegCoveredLen = relSegBase ? Math.min(relSegBase.length, size) : 0;
  for (const info of Object.values(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;
    const isSubByte = !(info.bitOffset === 0 && info.bitSize % 8 === 0);
    if (!isSubByte) continue;
    const spanBytes = Math.max(
      1,
      Math.ceil((info.bitOffset + info.bitSize) / 8),
    );
    for (let i = 0; i < spanBytes; i++) {
      const byteIdx = info.offset + i;
      if (byteIdx < relSegCoveredLen || byteIdx >= buf.length) continue;
      buf[byteIdx] = 0;
    }
  }

  const conditionallyActive =
    dynTree && params
      ? evalConditionallyActiveParamRefs(dynTree, params, currentValues)
      : null;
  const unconditionalChannel = dynTree
    ? buildUnconditionalChannelSet(dynTree)
    : null;

  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;

    if (info.fromMemoryChild) {
      if (!info.isVisible && prId in currentValues) {
        // User explicitly set a hidden param — write it
      } else if (unconditionalChannel && unconditionalChannel.has(prId)) {
        // Unconditionally visible — write it
      } else {
        const passConditional =
          conditionallyActive && conditionallyActive.has(prId);
        if (!passConditional) continue;
      }
    }

    const rawVal =
      prId in currentValues
        ? (currentValues[prId] as string | number | null)
        : info.defaultValue;
    if (rawVal === '' || rawVal === null || rawVal === undefined) continue;

    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      if (info.offset + byteSize > buf.length) continue;
      const strBuf = Buffer.from(String(rawVal), 'latin1');
      strBuf.copy(buf, info.offset, 0, Math.min(strBuf.length, byteSize));
      continue;
    }
    // TypeRawData-shaped default values ("Characteristic curve value
    // domain" and similar) - the manufacturer ships a whole pre-baked
    // lookup table as the parameter's raw DefaultValue, base64-encoded in
    // the source XML, rather than a single scalar. Real ETS writes the
    // WHOLE table (confirmed via a real Full Download capture,
    // byte-for-byte) - this is the root cause of a real, large gap
    // between this function's computed image and a real device (see
    // docs/knx-device-write-protocol.md Part 9 and
    // docs/follow-ups/2026-08-28-full-download-history-and-blob-params.md
    // for the full real-hardware + real-.knxproj-XML investigation this
    // fix is based on).
    //
    // The real wire format, confirmed against 1.1.10's actual .knxproj
    // XML and a real device capture, is a 4-byte big-endian LENGTH PREFIX
    // followed by the payload: `<TypeRawData MaxSize="516" />` for a
    // 512-byte curve table (516 = 4 + 512), and the real device's own
    // leading 4 bytes there decode as `0x00000200` = 512 - exactly the
    // payload length. ets-app.ts now reads MaxSize into `bitSize`
    // (`sizeInBit = maxSize*8`, previously TypeRawData wasn't handled at
    // all and silently fell back to bitSize=8/1 byte) - so
    // `declaredBytes` below is now the REAL total allocation (prefix +
    // payload) once a project has been re-parsed with that fix. Detect
    // and frame based on the *value itself* rather than trusting a
    // specific bitSize number, since data/apps/*.json caches generated
    // before the ets-app.ts fix still carry the old (wrong) bitSize=8 -
    // this stays correct either way.
    //
    // The existing conditional-activation gate above already selects
    // only the one genuinely active alternate among a conditional group
    // (e.g. one of a channel's several curve-type choices) - this branch
    // only needs to apply whichever value survives that gate.
    if (typeof rawVal === 'string' && /^[A-Za-z0-9+/]+=*$/.test(rawVal) && rawVal.length >= 20) {
      let blob: Buffer;
      try {
        blob = Buffer.from(rawVal, 'base64');
      } catch (_e) {
        blob = Buffer.alloc(0);
      }
      const declaredBytes = Math.ceil(info.bitSize / 8);
      if (declaredBytes === blob.length + 4) {
        // Declared allocation is exactly "4-byte length prefix + this
        // payload" - the confirmed real shape. Frame it that way.
        const framed = Buffer.alloc(4 + blob.length);
        framed.writeUInt32BE(blob.length, 0);
        blob.copy(framed, 4);
        framed.copy(buf, info.offset, 0, Math.min(framed.length, buf.length - info.offset));
        continue;
      }
      if (blob.length > declaredBytes + 1) {
        // Declared size doesn't match the confirmed prefix+payload shape
        // (e.g. an un-re-parsed cache still showing bitSize=8, or a
        // genuinely different blob shape this hasn't been verified
        // against) - write the raw payload with no framing as a
        // best-effort fallback, matching the offset ETS's own writes
        // used in every capture so far.
        blob.copy(buf, info.offset, 0, Math.min(blob.length, buf.length - info.offset));
        continue;
      }
      // Falls through to the generic numeric path below for genuinely
      // short base64-looking strings (a coincidence, not a real blob).
    }
    if (info.isFloat) {
      const fVal = parseFloat(String(rawVal));
      if (isNaN(fVal)) continue;
      const scaledVal = info.coefficient ? fVal / info.coefficient : fVal;
      if (info.bitSize === 16) {
        writeKnxFloat16(buf, info.offset, scaledVal);
      } else if (info.bitSize === 32) {
        if (info.offset + 4 <= buf.length)
          buf.writeFloatBE(scaledVal, info.offset);
      } else if (info.bitSize === 64) {
        if (info.offset + 8 <= buf.length)
          buf.writeDoubleBE(scaledVal, info.offset);
      }
      continue;
    }
    const numVal = parseFloat(String(rawVal));
    if (isNaN(numVal)) continue;
    const intVal = info.coefficient
      ? Math.round(numVal / info.coefficient)
      : Math.round(numVal);
    writeBits(buf, info.offset, info.bitOffset, info.bitSize, intVal);
  }

  // Process Assign operations
  if (dynTree && params) {
    const activeAssigns = collectActiveAssigns(dynTree, params, currentValues);
    for (const { target, source, value } of activeAssigns) {
      const targetInfo = paramMemLayout[target];
      if (
        !targetInfo ||
        targetInfo.offset === null ||
        targetInfo.offset === undefined
      )
        continue;
      let assignRawVal: string | number | null | undefined;
      if (source) {
        const sourceParam = params[source];
        if (!sourceParam) continue;
        assignRawVal =
          source in currentValues
            ? (currentValues[source] as string | number | null)
            : sourceParam.defaultValue;
      } else {
        assignRawVal = value;
      }
      if (
        assignRawVal === '' ||
        assignRawVal === null ||
        assignRawVal === undefined
      )
        continue;
      const intVal = parseInt(String(assignRawVal), 10);
      if (isNaN(intVal)) continue;
      writeBits(
        buf,
        targetInfo.offset,
        targetInfo.bitOffset,
        targetInfo.bitSize,
        intVal,
      );
    }
  }

  return buf;
}
