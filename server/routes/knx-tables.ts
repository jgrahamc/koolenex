// ── KNX table builders ────────────────────────────────────────────────────────

// ── ETS dynamic tree types ───────────────────────────────────────────────────

export interface DynNode {
  paramRefs?: string[];
  blocks?: DynNode[];
  choices?: DynChoice[];
  assigns?: DynAssign[];
}

export interface DynWhen {
  test?: string[];
  isDefault?: boolean;
  node?: DynNode;
}

export interface DynChoice {
  paramRefId: string;
  defaultValue?: string;
  whens?: DynWhen[];
}

export interface DynAssign {
  target: string;
  source: string | null;
  value: string | null;
}

export interface DynChannel {
  node?: DynNode;
}

export interface DynSection {
  channels?: DynChannel[];
  cib?: DynNode[];
  pb?: DynNode[];
  choices?: DynChoice[];
}

export interface DynTree {
  main?: DynSection;
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
}

export interface ParamSegmentResult {
  paramSize: number;
  paramFill: number;
  relSegHex: string | null;
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
export function buildGATable(gaLinks: GaLink[]): Buffer {
  const count = gaLinks.length;
  const buf = Buffer.alloc(1 + count * 2);
  buf[0] = count & 0xff;
  gaLinks.forEach((ga, i) => {
    const b0 = ((ga.main_g & 0x1f) << 3) | (ga.middle_g & 0x07);
    const b1 = ga.sub_g & 0xff;
    buf[1 + i * 2] = b0;
    buf[2 + i * 2] = b1;
  });
  return buf;
}

// Build association table bytes: [count(1)] + [CO_num(1), GA_idx(1)] x count
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
      if (gaIdx != null) entries.push([co.object_number & 0xff, gaIdx & 0xff]);
    }
  }

  entries.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const buf = Buffer.alloc(1 + entries.length * 2);
  buf[0] = entries.length & 0xff;
  entries.forEach(([co, ga], i) => {
    buf[1 + i * 2] = co;
    buf[2 + i * 2] = ga;
  });
  return buf;
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

// Build the set of paramRefs that are unconditionally reachable from top-level
// channels/cib/pb without passing through any choice/when branch.
export function buildUnconditionalChannelSet(
  dynTree: DynTree | null | undefined,
): Set<string> {
  const s = new Set<string>();
  function walk(node: DynNode | undefined): void {
    if (!node) return;
    for (const r of node.paramRefs || []) s.add(r);
    for (const b of node.blocks || []) walk(b);
    // Do NOT walk into choices — params inside choices are conditional
  }
  for (const ch of dynTree?.main?.channels || []) walk(ch.node);
  for (const ci of dynTree?.main?.cib || []) walk(ci);
  for (const pb of dynTree?.main?.pb || []) walk(pb);
  return s;
}

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
  function evalChoice(choice: DynChoice, _inChoice: boolean): void {
    const raw = getVal(choice.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''),
    );
    let matched = false;
    let defNode: DynNode | undefined;
    for (const w of choice.whens || []) {
      if (w.isDefault) {
        defNode = w.node;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walkNode(w.node, true);
      }
    }
    if (!matched && defNode) walkNode(defNode, true);
  }
  function walkNode(node: DynNode | undefined, inChoice: boolean): void {
    if (!node) return;
    for (const r of node.paramRefs || []) {
      if (inChoice) conditional.add(r);
    }
    for (const b of node.blocks || []) walkNode(b, inChoice);
    for (const choice of node.choices || []) evalChoice(choice, inChoice);
  }
  function walkDynSection(section: DynSection | undefined): void {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node, false);
    for (const ci of section.cib || []) walkNode(ci, false);
    for (const pb of section.pb || []) walkNode(pb, false);
    for (const choice of section.choices || []) evalChoice(choice, false);
  }
  walkDynSection(dynTree?.main);
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
  function walkNode(node: DynNode | undefined): void {
    if (!node) return;
    for (const ass of node.assigns || []) result.push(ass);
    for (const b of node.blocks || []) walkNode(b);
    for (const choice of node.choices || []) evalChoice(choice);
  }
  function evalChoice(choice: DynChoice): void {
    const raw = getVal(choice.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''),
    );
    let matched = false;
    let defNode: DynNode | undefined;
    for (const w of choice.whens || []) {
      if (w.isDefault) {
        defNode = w.node;
        continue;
      }
      if (etsTestMatch(val, w.test ?? null)) {
        matched = true;
        walkNode(w.node);
      }
    }
    if (!matched && defNode) walkNode(defNode);
  }
  function walkDynSection(section: DynSection | undefined): void {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node);
    for (const ci of section.cib || []) walkNode(ci);
    for (const pb of section.pb || []) walkNode(pb);
    for (const choice of section.choices || []) evalChoice(choice);
  }
  walkDynSection(dynTree?.main);
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
    return { paramSize, paramFill, relSegHex };
  }
  // Try AbsoluteSegment path
  const absSegs = model.absSegData ?? {};
  const layout = model.paramMemLayout ?? {};
  const paramOffsets = Object.values(layout)
    .map((v) => v.offset)
    .filter((v): v is number => v != null);
  if (paramOffsets.length === 0 || Object.keys(absSegs).length === 0) {
    return { paramSize: 0, paramFill: 0xff, relSegHex: null };
  }
  const maxOffset = Math.max(...paramOffsets);
  for (const seg of Object.values(absSegs)) {
    if (seg.size > maxOffset) {
      return {
        paramSize: seg.size,
        paramFill: 0x00,
        relSegHex: seg.hex ?? null,
      };
    }
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
    };
  }
  return { paramSize: 0, paramFill: 0xff, relSegHex: null };
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
          conditionallyActive &&
          conditionallyActive.has(prId) &&
          info.isVisible;
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
