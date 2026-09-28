// ── KNX table builders ────────────────────────────────────────────────────────

// Shared with the client's parameter UI - see shared/ets-dyn.ts. Re-exported
// because routes/index.ts (and its test importers) take it from here.
import {
  etsTestMatch,
  type DynWhen,
  type DynItem,
  type DynTree,
} from '../../shared/ets-dyn.ts';
export { etsTestMatch };
export type { DynWhen, DynItem, DynTree };
import { logger } from '../log.ts';

// ── ETS dynamic tree types (matches ets-app.ts DynItem emission) ────────────
// The stored model shape is a single recursive `items` array of tagged
// DynItems: dynTree.main.items -> DynItem[], where each item's `type` is one
// of cib/channel/block/choose/paramRef/assign/comRef/rename/separator. This
// mirrors the `DynItem` union in server/ets-app.ts — NOT the legacy
// channels/cib/pb + paramRefs/blocks/choices shape that emission never
// actually produces.

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
  /**
   * Address of the AbsoluteSegment `offset` is relative to - see
   * ets-app.ts's ParamMemLayoutEntry.segmentAddress. Undefined on
   * RelSegment devices, on parameters naming no segment, and on app
   * models cached before segment tracking was added; consumers must then
   * behave as they did before segments were tracked.
   */
  segmentAddress?: number;
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
  // See ParamMemLayoutEntry.refValue's own doc comment (ets-app.ts).
  refValue?: string;
  // See ParamMemLayoutEntry.isDefaultUnionParam's own doc comment.
  isDefaultUnionParam?: boolean;
  // See ParamMemLayoutEntry.baseOffsetArgId's own doc comment - buildParamMem()
  // uses its presence (post-expansion, carried through the resolver's own
  // `...info` spread) as the marker for "this module-instanced entry was
  // already correctly gated per-instance", not just for offset expansion.
  baseOffsetArgId?: string;
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
  // See ets-app.ts's ParamModel.parameterByteOrder's own doc comment.
  parameterByteOrder?: 'LittleEndian' | 'BigEndian';
}

/** One parameter-carrying AbsoluteSegment, as the application declares it. */
export interface ParamSegment {
  /** Absolute address the segment loads at. */
  address: number;
  /** Its declared Size. */
  size: number;
  /** Fill byte for bytes no parameter writes. */
  fill: number;
  /** Its factory seed data, hex, or null. */
  seedHex: string | null;
  /** The paramMemLayout keys whose offsets are relative to this segment. */
  keys: string[];
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

// GA table wire format: [count:2 BE][GA:2 BE]*count (2-byte count, not 1-byte
// - see docs/knx-device-write-protocol.md §2.6/§1.1). Written even for apps
// with no own LoadProcedure step for it - see downloadDevice()'s WriteRelMem case.
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

// Association table wire format: [count:2 BE][gaIndex:2 BE][coNumber:2 BE] x
// count, gaIndex before coNumber, all 2-byte BE fields (docs/knx-device-
// write-protocol.md §2.6/§1.1).
//
// Entry order encodes which link a comm object actively transmits on: for a
// multi-linked object, the first entry in table order is the active-transmit
// link (§6.3) - never re-sort `entries` by GA index.
//
// Real ETS defers every link past an object's first to a separate pass at
// the end of the table, rather than keeping each object's full GA list
// together: pass 1 is every comm object's primary GA link in object_number
// order; pass 2 is every object's remaining links, again in object_number
// order, each object's own extra links kept consecutive. Single-link objects
// are unaffected - only multi-linked objects need this split.
export function buildAssocTable(coRows: CoRow[], gaLinks: GaLink[]): Buffer {
  const gaIndexMap: Record<string, number> = {};
  gaLinks.forEach((ga, i) => {
    if (ga.address) gaIndexMap[ga.address] = i;
  });

  const primary: [number, number][] = [];
  const extra: [number, number][] = [];
  for (const co of coRows) {
    const gas = (co.ga_address || '').split(/\s+/).filter(Boolean);
    gas.forEach((gaAddr, i) => {
      const gaIdx = gaIndexMap[gaAddr];
      if (gaIdx == null) return;
      // Real table is 1-based (gaIndex 0 in our own array -> real index 1).
      const entry: [number, number] = [gaIdx + 1, co.object_number];
      if (i === 0) primary.push(entry);
      else extra.push(entry);
    });
  }
  const entries: [number, number][] = [...primary, ...extra];

  const buf = Buffer.alloc(2 + entries.length * 4);
  buf.writeUInt16BE(entries.length & 0xffff, 0);
  entries.forEach(([gaIdx, co], i) => {
    buf.writeUInt16BE(gaIdx & 0xffff, 2 + i * 4);
    buf.writeUInt16BE(co & 0xffff, 4 + i * 4);
  });
  return buf;
}

// Decode raw GA table bytes (inverse of buildGATable) into an ordered list
// of "main/mid/sub" address strings.
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
// See docs/knx-device-write-protocol.md §10.1 for the evidence trail. System B mask family only.
//
//   byte offset within the table = 2 × communication-object number (does not reindex when
//   objects are disabled/unlinked elsewhere in the app)
//
//   bit 7 = Update flag
//   bit 6 = Transmit flag
//   bit 5 = Read-On-Init flag
//   bit 4 = Write flag
//   bit 3 = Read flag
//   bit 2 = Communication flag AND has at least one real GA link - both required. Link-count-
//           and direction-independent; which link is the Send GA lives in the Association
//           table's entry order instead (see buildAssocTable above), not here.
//   bits 1:0 = Priority: Low=`11`, Alarm=`10`, High=`01`, System=`00` (System is unreachable
//           from ETS per KNX's own spec, so never exercised on a real project)
//
// Untested on mask families other than System B.
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

// The byte immediately after each object's flag byte is the KNX standard "Group Object Size"
// 4-bit code, fixed by the object's DPT/ObjectSize - not a flag-derived value, and not padding.
// String keys are ETS's exact `ObjectSize` attribute text: singular "Bit"/"Byte" for 1, plural
// for 2+.
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
 * Maps an ETS `ObjectSize` string to Object 3's companion-byte size code (0-15). Unrecognized or
 * missing input defaults to `0` (1 Bit) rather than throwing, same degrade-to-common-case
 * convention as `computeGroupObjectByte()`'s priority default.
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
 * Builds Object 3 (Group Object Table): a zero-filled buffer of the device's real per-app table
 * size (resolved via PID_TABLE_REFERENCE, not computed here), with each communication object's
 * flag byte at `2 × object_number` and its size-code byte at `2 × object_number + 1`. Objects not
 * present in `comObjects` are left zero-filled (size-code 0 = "1 Bit").
 *
 * Bytes 0-1 are a big-endian header holding the app's total declared communication-object count
 * (`maxComObjectNumber` in ets-app.ts, same value the caller used to compute `size` as
 * `2 × maxComObjectNumber + 2`) - derived here as `(size - 2) / 2` rather than passed separately.
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
 * Reads one communication object's raw 2-byte entry out of an Object 3 buffer - the inverse of
 * `buildGroupObjectTable()`'s placement, for verify/compare. Returns `null` when the object's
 * offset falls outside the buffer. Returns raw bytes, not a re-decoded `GroupObjectFlags` -
 * verify only needs a byte comparison, not re-derived semantic flags.
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
 * Formats one Object 3 entry (from `decodeGroupObjectEntry()`) into a human-readable line for
 * the device-compare page, covering every bit `computeGroupObjectByte()` writes plus the size
 * code. Bit 2 is shown as a single `Comm+Linked` value since the byte can't distinguish which of
 * the two conditions is false when the bit is clear.
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
 * Structured decode of one Object 3 entry: the same bits `describeGroupObjectEntry()` formats
 * into a sentence, plus Priority/Size, as real booleans for per-flag chip rendering. `commLinked`
 * is bit 2 - see `describeGroupObjectEntry()` for why it's one combined value.
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
    priority:
      GROUP_OBJECT_PRIORITY_NAMES[b & 0b11] ?? `0b${(b & 0b11).toString(2)}`,
    size:
      GROUP_OBJECT_SIZE_NAMES[entry.sizeCodeByte] ??
      `code ${entry.sizeCodeByte}`,
  };
}

const CONTAINER_TYPES = new Set(['block', 'channel', 'cib']);

// Build the set of paramRefs that are unconditionally reachable from the
// top-level `items` tree without passing through any `choose` branch.
//
// Also walks every ModuleDef's own Dynamic section (`dynTree.moduleDefs[]`),
// not just the App's top-level tree (`dynTree.main`) - a `<choose>` deciding
// a module's own behavior can live inside the ModuleDef itself. Safe to walk
// unconditionally since paramRef ids are globally unique (carry the full
// MD-x prefix).
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
  for (const md of dynTree?.moduleDefs ?? []) walk(md.items);
  return s;
}

// paramRefs reachable through the CURRENTLY-ACTIVE `choose` branches.
//
// `qualify` resolves a module-instanced choose selector's per-instance value:
// its value is stored under an instance-qualified key
// (`..._MD-8_M-6_MI-1_P-58_R-67`), not the bare template key - without this,
// resolution silently falls back to the template's static XML default and
// picks the wrong Union alternative for real instances. Tried before the
// bare template key, which remains the fallback for an un-instanced selector.
//
// `resolveBaseValue`: a choose's selector Parameter can carry `BaseValue=`,
// whose real per-instance value comes from the module instantiation's own
// `<NumericArg>`, not any ParameterInstanceRef override (see
// ParamDef.baseValueArgId). Tried after currentValues checks, before the
// static XML default.
//
// `isExcludedSelector`: a choose's selector Parameter can itself be a Union
// member (several Parameters sharing one memory address, only one active -
// see buildParamMem's Union pre-pass). Without this, a losing Union
// sibling's own choose still evaluates against its stale factory default,
// wrongly marking its branch's refs as active. When supplied, a choose
// whose own `paramRefId` is a known-losing Union member is skipped.
export function evalConditionallyActiveParamRefs(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
  /**
   * ParamModel.paramRefValues - declared value of every ParameterRef,
   * including ones `params` filters out. A `<choose>` controlled by a
   * parameter with no UI presence would otherwise read as empty and send
   * the branch to `default`. Optional: app models cached before this field
   * was tracked don't carry it.
   */
  paramRefValues?: Record<string, string>,
  qualify?: (templateKey: string) => string,
  resolveBaseValue?: (templateKey: string) => string | undefined,
  isExcludedSelector?: (templateKey: string) => boolean,
): Set<string> {
  const conditional = new Set<string>();
  const getVal = (prKey: string): string => {
    const qualified = qualify?.(prKey);
    if (qualified && qualified in currentValues)
      return String(currentValues[qualified]);
    if (prKey in currentValues) return String(currentValues[prKey]);
    const baseValue = resolveBaseValue?.(prKey);
    if (baseValue !== undefined) return baseValue;
    // `params` first so a ParameterRef that IS in the editor keeps
    // resolving exactly as before; paramRefValues carries the same
    // declared value for those, and is the only source for the rest.
    const fromParams = params[prKey]?.defaultValue;
    if (fromParams !== undefined && fromParams !== null && fromParams !== '')
      return String(fromParams);
    return String(paramRefValues?.[prKey] ?? '');
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
    if (ch.paramRefId && isExcludedSelector?.(ch.paramRefId)) return;
    const raw = getVal(ch.paramRefId!);
    const val = String(
      raw !== '' && raw != null ? raw : (ch.defaultValue ?? ''),
    );
    // Empty value: a <TypeNone/> controller has no value by declaration -
    // a <choose> on one always means its `default` <when>, so taking it is
    // correct and silent. A controller with a real type but no resolvable
    // value is different: the default branch is a guess, so warn (same
    // reasoning as buildParamMem()'s collision report).
    if (val === '' && ch.controllerValueless !== true) {
      logger.warn(
        'ets',
        'Dynamic tree: no value for a <choose> controller, taking the default branch',
        { paramRefId: ch.paramRefId },
      );
    }
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
  for (const md of dynTree?.moduleDefs ?? []) walk(md.items, false);
  return conditional;
}

// Every `paramRef.refId` appearing anywhere in the Dynamic tree, reachable or
// not - unlike evalConditionallyActiveParamRefs/buildUnconditionalChannelSet,
// which only report currently-reachable refs. Distinguishes a selector gated
// by a hardware-presence condition elsewhere (absent from the reachable set,
// present here) from one never independently rendered at all (absent from
// both) - see buildParamMem's isSelectorUnreachableElsewhere.
export function collectAllParamRefIds(
  dynTree: DynTree | null | undefined,
): Set<string> {
  const all = new Set<string>();
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'paramRef' && it.refId) all.add(it.refId);
      else if (CONTAINER_TYPES.has(it.type)) walk(it.items);
      else if (it.type === 'choose')
        for (const w of it.whens || []) walk(w.items);
    }
  }
  walk(dynTree?.main?.items);
  for (const md of dynTree?.moduleDefs ?? []) walk(md.items);
  return all;
}

/**
 * Which Module instances (App-level ids, "{appId}_MD-x_M-y") are genuinely
 * active for a device - mirrors evalConditionallyActiveParamRefs's
 * choose/when walk and getVal() fallback logic, collecting `type ===
 * 'module'` items instead of `type === 'paramRef'`.
 *
 * Resolves the App's own `<choose ParamRefId="...">` directly, rather than
 * inferring activity from ComObjectInstanceRef/ParameterInstanceRef
 * presence - a module with no comm-objects and an unoverridden parameter can
 * be genuinely active while both of those signals stay silent.
 *
 * Walks both `dynTree.main.items` and every `dynTree.moduleDefs[].items`,
 * since a Module-selecting `<choose>` can live inside a ModuleDef's own
 * Dynamic section.
 */
export function evalConditionallyActiveModuleInstances(
  dynTree: DynTree | null | undefined,
  params: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
  paramRefValues?: Record<string, string>,
): Set<string> {
  const active = new Set<string>();
  const getVal = (prKey: string): string => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    const fromParams = params[prKey]?.defaultValue;
    if (fromParams !== undefined && fromParams !== null && fromParams !== '')
      return String(fromParams);
    return String(paramRefValues?.[prKey] ?? '');
  };
  function walk(items: DynItem[] | undefined): void {
    for (const it of items || []) {
      if (it.type === 'module') {
        if (it.modId) active.add(it.modId);
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
  for (const md of dynTree?.moduleDefs ?? []) walk(md.items);
  return active;
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
//
// `byteOrder` governs only a byte-aligned multi-byte field (bitOffset===0 &&
// bitSize%8===0) - a real, per-app ETS declaration
// (`<Static><Options ParameterByteOrder="LittleEndian"/"BigEndian">`), see
// ParamModel.parameterByteOrder (ets-app.ts). Defaults to big-endian when
// the attribute is absent. Sub-byte fields are unaffected: bit numbering
// inside a byte is always MSB-first (bitOffset 0 = bit 7).
export function writeBits(
  buf: Buffer,
  byteOffset: number,
  bitOffset: number,
  bitSize: number,
  value: number,
  byteOrder?: 'LittleEndian' | 'BigEndian',
): void {
  if (byteOffset >= buf.length || bitSize <= 0) return;
  const mask = bitSize >= 32 ? 0xffffffff : (1 << bitSize) - 1;
  value = value & mask;
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      if (bIdx >= buf.length) continue;
      const shiftBytes = byteOrder === 'LittleEndian' ? i : byteCount - 1 - i;
      buf[bIdx] = (value >>> (shiftBytes * 8)) & 0xff;
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
      byteOrder,
    );
    writeBits(
      buf,
      byteOffset + 1,
      0,
      bitSize - bitsInFirstByte,
      value,
      byteOrder,
    );
    return;
  }
  const shift = 8 - bitOffset - bitSize;
  const bmask = ((1 << bitSize) - 1) << shift;
  buf[byteOffset] = (buf[byteOffset]! & ~bmask) | ((value << shift) & bmask);
}

// Read `bitSize` bits from buf at byte `byteOffset`, starting from bit
// `bitOffset` (bitOffset=0 is bit 7, MSB first). Mirrors writeBits() above.
// Out-of-range bytes read as 0 rather than throwing.
export function readBits(
  buf: Buffer,
  byteOffset: number,
  bitOffset: number,
  bitSize: number,
  byteOrder?: 'LittleEndian' | 'BigEndian',
): number {
  if (bitSize <= 0) return 0;
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    let value = 0;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      const byte = bIdx < buf.length ? buf[bIdx]! : 0;
      const shiftBytes = byteOrder === 'LittleEndian' ? i : byteCount - 1 - i;
      value += byte * 256 ** shiftBytes;
    }
    return value;
  }
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    const high = readBits(
      buf,
      byteOffset,
      bitOffset,
      bitsInFirstByte,
      byteOrder,
    );
    const low = readBits(
      buf,
      byteOffset + 1,
      0,
      bitSize - bitsInFirstByte,
      byteOrder,
    );
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
  /**
   * False for a parameter declared `Access="None"` - a download-only value
   * ETS never shows in its own UI (see ParamMemLayoutEntry.isVisible,
   * ets-app.ts). Some such parameters are device-firmware sentinels that
   * legitimately change after a Download (e.g. a load-completion self-check
   * the device clears once processed) - a mismatch here isn't necessarily a
   * real problem the way an ordinary parameter mismatch is. Defaults to
   * `true` when the layout entry says nothing otherwise.
   */
  isVisible: boolean;
}

/**
 * Decode a raw parameter-memory buffer (e.g. /bus/verify-device's actualHex)
 * into human-readable parameter values - the inverse of buildParamMem().
 * Reuses the same paramMemLayout/params definitions used to build the
 * download image, so a decoded reading is directly comparable to verify's
 * "expected" value. Operates purely on an already-fetched buffer.
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
  byteOrder?: 'LittleEndian' | 'BigEndian',
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
      const raw = readBits(
        buf,
        info.offset,
        info.bitOffset,
        info.bitSize,
        byteOrder,
      );
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
      isVisible: info.isVisible ?? true,
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

/**
 * Every parameter-carrying segment the application declares, from the
 * parameters' own <Memory CodeSegment="..."/> bindings rather than guessed
 * from offsets. An application may declare more than one, each numbering
 * its own offsets from zero - flattening them into one buffer would overlap
 * unrelated segments. See ParamMemLayoutEntry.segmentAddress (ets-app.ts).
 *
 * Returns an empty list when no entry carries a segmentAddress: a
 * RelSegment/WriteRelMem device (relative addressing, no absolute segments)
 * or an app model cached before segments were tracked. Callers fall back to
 * resolveParamSegment() for those.
 */
export function resolveParamSegments(model: DeviceModel): ParamSegment[] {
  const layout = model.paramMemLayout ?? {};
  const absSegs = model.absSegData ?? {};
  const keysByAddress = new Map<number, string[]>();
  for (const [key, entry] of Object.entries(layout)) {
    const addr = entry.segmentAddress;
    if (addr === undefined || entry.offset == null) continue;
    const list = keysByAddress.get(addr);
    if (list) list.push(key);
    else keysByAddress.set(addr, [key]);
  }
  const out: ParamSegment[] = [];
  for (const [address, keys] of keysByAddress) {
    const seg = absSegs[address];
    // A segment the parameters name but the application never declared
    // would be a contradiction in the product data; skip it rather than
    // invent a size for it.
    if (!seg) continue;
    out.push({
      address,
      size: seg.size,
      // Absolute segments ship a factory seed; unwritten bytes come from
      // that, not an 0xFF fill (matches resolveParamSegment()).
      fill: 0x00,
      seedHex: seg.hex ?? null,
      keys,
    });
  }
  return out.sort((a, b) => a.address - b.address);
}

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
  // Pick the tightest-fitting segment covering every parameter offset, not
  // merely the first one larger than maxOffset - an unrelated larger segment
  // (e.g. an address table) can also exceed maxOffset by coincidence.
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

/**
 * One parameter buffer per declared segment, each built by buildParamMem()
 * from only the parameters that segment owns. Multi-segment form of the
 * single buffer buildParamMem() produces - each segment numbers its own
 * offsets from zero, so flattening into one buffer would overlap segments.
 *
 * Returns an empty map when the model declares no parameter segments
 * (every RelSegment device, or a model cached before segments were
 * tracked) - callers fall back to the single-buffer path for those.
 */
export function buildParamMemBySegment(
  model: DeviceModel,
  currentValues: Record<string, unknown>,
  dynTree: DynTree | null = null,
  params: Record<string, ParamDef> | null = null,
  paramRefValues?: Record<string, string>,
): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  const layout = model.paramMemLayout ?? {};
  for (const seg of resolveParamSegments(model)) {
    // Only this segment's own parameters, so a collision inside
    // buildParamMem() means two Union members are both live, not two
    // segments overlapping.
    const segLayout: Record<string, ParamMemEntry> = {};
    for (const key of seg.keys) {
      const entry = layout[key];
      if (entry) segLayout[key] = entry;
    }
    out.set(
      seg.address,
      buildParamMem(
        seg.size,
        segLayout,
        currentValues,
        seg.fill,
        seg.seedHex,
        dynTree,
        params,
        paramRefValues,
        model.parameterByteOrder,
      ),
    );
  }
  return out;
}

/**
 * Whether buildParamMem() actually writes a given parameter's bytes.
 *
 * Not every entry in paramMemLayout ends up in the image: a
 * `fromMemoryChild` parameter is written only when it's the active
 * alternative for its channel, and a parameter with neither a current
 * value nor a default is skipped. Skipped bytes keep whatever `fill` value
 * is there - decoding them as "expected" and comparing to a real device
 * produces meaningless mismatches, so verify must apply this same rule
 * rather than a second copy that can drift.
 */
export function paramMemWritesParam(
  prId: string,
  info: ParamMemEntry,
  currentValues: Record<string, unknown>,
  conditionallyActive: Set<string> | null,
  unconditionalChannel: Set<string> | null,
): boolean {
  if (info.offset === null || info.offset === undefined) return false;

  if (info.fromMemoryChild) {
    if (!info.isVisible && prId in currentValues) {
      // User explicitly set a hidden param — write it
    } else if (unconditionalChannel && unconditionalChannel.has(prId)) {
      // Unconditionally visible — write it
    } else if (!(conditionallyActive && conditionallyActive.has(prId))) {
      return false;
    }
  }

  const rawVal =
    prId in currentValues
      ? (currentValues[prId] as string | number | null)
      : info.defaultValue;
  return !(rawVal === '' || rawVal === null || rawVal === undefined);
}

/**
 * Every parameter buildParamMem() would actually write, for the same
 * inputs. See paramMemWritesParam() for why a caller wants this.
 */
export function writtenParamKeys(
  paramMemLayout: Record<string, ParamMemEntry>,
  currentValues: Record<string, unknown>,
  dynTree: DynTree | null,
  params: Record<string, ParamDef> | null,
  paramRefValues?: Record<string, string>,
): Set<string> {
  const conditionallyActive =
    dynTree && params
      ? evalConditionallyActiveParamRefs(
          dynTree,
          params,
          currentValues,
          paramRefValues,
        )
      : null;
  const unconditionalChannel = dynTree
    ? buildUnconditionalChannelSet(dynTree)
    : null;
  const keys = new Set<string>();
  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (
      paramMemWritesParam(
        prId,
        info,
        currentValues,
        conditionallyActive,
        unconditionalChannel,
      )
    )
      keys.add(prId);
  }
  return keys;
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
  /** ParamModel.paramRefValues - see evalConditionallyActiveParamRefs. */
  paramRefValues?: Record<string, string>,
  /** ParamModel.parameterByteOrder - see its own doc comment (ets-app.ts). */
  byteOrder?: 'LittleEndian' | 'BigEndian',
): Buffer {
  const relSegBase = relSegHex ? Buffer.from(relSegHex, 'hex') : null;

  let buf: Buffer;
  if (relSegBase) {
    buf = Buffer.alloc(size, fill);
    relSegBase.copy(buf, 0, 0, Math.min(relSegBase.length, size));
  } else {
    buf = Buffer.alloc(size, fill);
  }

  // A byte only partly occupied by a named parameter (a sub-byte field like
  // a 1-bit boolean sharing its byte with reserved bits) has those other
  // bits zeroed on a real device, not left at `fill` (0xFF). `fill` itself
  // is correct for genuinely unnamed bytes. This re-zeroes only the bytes a
  // sub-byte field's own layout occupies, before the per-param writeBits()
  // calls below set that field's real bits. Skips bytes relSegBase already
  // seeded with real device-default content.
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

  const unconditionalChannel = dynTree
    ? buildUnconditionalChannelSet(dynTree)
    : null;

  // "Raw" pass - the same evaluation this function has always done, with no
  // knowledge of Union-member exclusivity. Used ONLY to determine which
  // Union member genuinely wins below (`skipAsLosingUnionMember`) - a real,
  // self-consistent computation that predates this fix and stays correct on
  // its own. NOT used for the actual write decision below - see the
  // corrected re-pass after `skipAsLosingUnionMember` is known, and
  // `evalConditionallyActiveParamRefs`'s own `isExcludedSelector` doc
  // comment for why a second pass is necessary (computing who wins a Union
  // selection requires the uncorrected reachability first; correcting
  // reachability requires knowing who won - genuinely sequential, not
  // simultaneously solvable in one pass).
  const conditionallyActiveRaw =
    dynTree && params
      ? evalConditionallyActiveParamRefs(
          dynTree,
          params,
          currentValues,
          paramRefValues,
        )
      : null;

  // A <Union>'s member <Parameter>s share the exact same (offset, bitOffset,
  // bitSize) by design - only one is ever genuinely active. Resolved here as
  // one pre-pass: for every group of memory-mapped siblings sharing an
  // address, keep whichever has a real currentValues override; failing
  // that, the one marked `isDefaultUnionParam`; failing that, leave the
  // group alone rather than guess.
  const unionGroups = new Map<string, string[]>();
  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (
      !info.fromMemoryChild ||
      info.offset === null ||
      info.offset === undefined
    )
      continue;
    const groupKey = `${info.offset}:${info.bitOffset}:${info.bitSize}`;
    (
      unionGroups.get(groupKey) ?? unionGroups.set(groupKey, []).get(groupKey)!
    ).push(prId);
  }
  // A Union sibling's currentValues entry only means "this one is active"
  // when it also passes the same choose-governed visibility gate the main
  // loop applies - a Union behind a <choose> can carry a stale currentValues
  // entry for a currently-inactive member. `templateKeyOf` strips a
  // module-instanced entry's "_M-y_MI-z" segment before the reachability
  // lookup, since conditionallyActiveRaw/unconditionalChannel are always
  // App-level/template-only ids.
  const templateKeyOf = (prId: string): string =>
    prId.replace(/_M-\d+_MI-\d+_/, '_');
  const passesVisibilityGate = (prId: string, info: ParamMemEntry): boolean => {
    const templateKey = templateKeyOf(prId);
    if (
      !info.isVisible &&
      (prId in currentValues || templateKey in currentValues)
    )
      return true;
    if (
      unconditionalChannel &&
      (unconditionalChannel.has(prId) || unconditionalChannel.has(templateKey))
    )
      return true;
    return !!(
      conditionallyActiveRaw &&
      (conditionallyActiveRaw.has(prId) ||
        conditionallyActiveRaw.has(templateKey))
    );
  };
  const skipAsLosingUnionMember = new Set<string>();
  // A losing Union member can still own an independent, always-reachable
  // <choose> subtree elsewhere in the app's Dynamic tree. Excluding that
  // choose needs every non-winning group member, not just the ones that
  // separately passed their own reachability gate.
  const unionGroupNonWinners = new Set<string>();
  for (const members of unionGroups.values()) {
    if (members.length < 2) continue;
    const reachable = members.filter((prId) =>
      passesVisibilityGate(prId, paramMemLayout[prId]!),
    );
    // None of this group's members are even reachable via any real
    // choose/unconditional path - leave the group alone entirely (every
    // member still gets its own chance to pass the main loop's own gate
    // below, unchanged from this function's prior behavior).
    if (!reachable.length) continue;
    const hasOverride = (prId: string) =>
      prId in currentValues || templateKeyOf(prId) in currentValues;
    const overridden = reachable.filter(hasOverride);
    const markedDefault = reachable.find(
      (prId) => paramMemLayout[prId]!.isDefaultUnionParam,
    );
    // Among the reachable members, no real signal either way (no override,
    // no isDefaultUnionParam marker) - deliberately leave this group alone
    // rather than guess a winner among them.
    if (!overridden.length && !markedDefault) continue;
    const winner = overridden[0] ?? markedDefault!;
    for (const prId of reachable)
      if (prId !== winner) skipAsLosingUnionMember.add(prId);
    for (const prId of members)
      if (prId !== winner) unionGroupNonWinners.add(prId);
  }

  // A choose selector can be genuinely unreachable via its own primary
  // declaration - not because it lost a Union selection, but because its
  // only standalone rendering point elsewhere in the tree sits behind an
  // unrelated condition (e.g. an optional module's presence flag). Trusting
  // its bare XML default there picks whatever branch the default happens to
  // match. A selector is unreachable-elsewhere when its ref is known to the
  // app (present in collectAllParamRefIds, distinguishing "gated elsewhere"
  // from "never independently rendered") but not currently reachable via
  // its primary declaration. A genuine per-device override always wins.
  const allDeclaredRefs = dynTree ? collectAllParamRefIds(dynTree) : null;
  const isSelectorUnreachableElsewhere = (paramRefId: string): boolean => {
    if (!allDeclaredRefs || !conditionallyActiveRaw || !unconditionalChannel)
      return false;
    if (!allDeclaredRefs.has(paramRefId)) return false;
    const templateKey = templateKeyOf(paramRefId);
    if (paramRefId in currentValues || templateKey in currentValues)
      return false;
    return (
      !conditionallyActiveRaw.has(paramRefId) &&
      !unconditionalChannel.has(paramRefId)
    );
  };

  // Corrected pass: now that Union winners are known, re-evaluate
  // reachability excluding any choose whose selector is a losing Union
  // member or is unreachable elsewhere in the tree. This is the version the
  // write decision below uses, not the raw pass above.
  const conditionallyActive =
    dynTree && params
      ? evalConditionallyActiveParamRefs(
          dynTree,
          params,
          currentValues,
          paramRefValues,
          undefined,
          undefined,
          (paramRefId) =>
            unionGroupNonWinners.has(paramRefId) ||
            isSelectorUnreachableElsewhere(paramRefId),
        )
      : null;

  // Which parameter last claimed each byte - a defensive diagnostic for
  // anything the Union pre-pass above didn't resolve.
  const byteOwner = new Map<number, string>();
  const collisions: string[] = [];

  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (skipAsLosingUnionMember.has(prId)) continue;
    // Repeated from paramMemWritesParam() only to narrow info.offset for
    // the writes below; the predicate is still the authority on whether
    // this parameter is written at all.
    if (info.offset === null || info.offset === undefined) continue;
    if (
      !paramMemWritesParam(
        prId,
        info,
        currentValues,
        conditionallyActive,
        unconditionalChannel,
      )
    )
      continue;

    {
      const spanBytes = Math.max(
        1,
        Math.ceil((info.bitOffset + info.bitSize) / 8),
      );
      for (let i = 0; i < spanBytes; i++) {
        const byteIdx = info.offset + i;
        const prev = byteOwner.get(byteIdx);
        if (prev !== undefined && prev !== prId && collisions.length < 20)
          collisions.push(`0x${byteIdx.toString(16)}: ${prev} then ${prId}`);
        byteOwner.set(byteIdx, prId);
      }
    }

    // A ParameterRef's own literal value (see ParamMemLayoutEntry.refValue)
    // is written whenever this entry is reached by the dynTree walk, whether
    // unconditionally or via a matched choose branch. Entries the walk never
    // reaches fall back to the Parameter's own factory `defaultValue`.
    let reachedViaTree = false;
    if (info.fromMemoryChild) {
      const templateKey = templateKeyOf(prId);
      if (
        !info.isVisible &&
        (prId in currentValues || templateKey in currentValues)
      ) {
        // User explicitly set a hidden param — write it
      } else if (
        unconditionalChannel &&
        (unconditionalChannel.has(prId) ||
          unconditionalChannel.has(templateKey))
      ) {
        reachedViaTree = true;
      } else {
        const passConditional =
          conditionallyActive &&
          (conditionallyActive.has(prId) ||
            conditionallyActive.has(templateKey));
        if (passConditional) reachedViaTree = true;
      }
    } else if (info.baseOffsetArgId) {
      // A module-instanced parameter emitted by
      // expandParamMemLayoutForActiveModules() deliberately carries
      // `fromMemoryChild: false` so the gate above does NOT re-evaluate it
      // - that resolver already ran the equivalent, more-correct
      // per-instance version of this exact gate before emitting the entry
      // at all. It is therefore already "reached by the tree", just via a
      // different code path. `baseOffsetArgId` (carried through the
      // resolver's own `...info` spread, never cleared) is this
      // codebase's own marker for that - a genuine non-module parameter
      // never carries it.
      reachedViaTree = true;
    }

    const rawVal =
      prId in currentValues
        ? (currentValues[prId] as string | number | null)
        : reachedViaTree && info.refValue !== undefined
          ? info.refValue
          : info.defaultValue;

    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      if (info.offset + byteSize > buf.length) continue;
      const strBuf = Buffer.from(String(rawVal), 'latin1');
      strBuf.copy(buf, info.offset, 0, Math.min(strBuf.length, byteSize));
      continue;
    }
    // TypeRawData-shaped default values (e.g. "Characteristic curve value
    // domain"): the manufacturer ships a whole pre-baked lookup table as the
    // parameter's DefaultValue, base64-encoded, rather than a scalar. Real
    // ETS writes the whole table.
    //
    // Wire format: a 4-byte big-endian length prefix followed by the
    // payload (`<TypeRawData MaxSize="516" />` for a 512-byte table,
    // 516 = 4 + 512). ets-app.ts reads MaxSize into `bitSize`
    // (`sizeInBit = maxSize*8`), so `declaredBytes` below is the real total
    // allocation (prefix + payload) once reparsed; detection is based on
    // the value itself, not a specific bitSize, so a stale cache with the
    // old bitSize=8 still works.
    if (
      typeof rawVal === 'string' &&
      /^[A-Za-z0-9+/]+=*$/.test(rawVal) &&
      rawVal.length >= 20
    ) {
      let blob: Buffer;
      try {
        blob = Buffer.from(rawVal, 'base64');
      } catch (_e) {
        blob = Buffer.alloc(0);
      }
      const declaredBytes = Math.ceil(info.bitSize / 8);
      if (declaredBytes === blob.length + 4) {
        // Declared allocation is "4-byte length prefix + payload" - frame it.
        const framed = Buffer.alloc(4 + blob.length);
        framed.writeUInt32BE(blob.length, 0);
        blob.copy(framed, 4);
        framed.copy(
          buf,
          info.offset,
          0,
          Math.min(framed.length, buf.length - info.offset),
        );
        continue;
      }
      if (blob.length > declaredBytes + 1) {
        // Declared size doesn't match the prefix+payload shape (e.g. a
        // stale cache, or an unverified blob shape) - write the raw
        // payload with no framing as a best-effort fallback.
        blob.copy(
          buf,
          info.offset,
          0,
          Math.min(blob.length, buf.length - info.offset),
        );
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
    writeBits(
      buf,
      info.offset,
      info.bitOffset,
      info.bitSize,
      intVal,
      byteOrder,
    );
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
        byteOrder,
      );
    }
  }

  if (collisions.length)
    logger.warn(
      'ets',
      `Parameter memory: ${collisions.length} byte(s) claimed by more than one parameter - ` +
        'two members of a <Union> cannot both be live, so the dynamic tree selected ' +
        'contradictory branches and the later writer silently won',
      { collisions },
    );

  return buf;
}
