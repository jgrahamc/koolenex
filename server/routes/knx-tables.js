'use strict';

// ── KNX table builders ────────────────────────────────────────────────────────

// Build GA table bytes: [count(1)] + [GA_encoded(2) x count]
// gaLinks: array of { main_g, middle_g, sub_g }
function buildGATable(gaLinks) {
  const count = gaLinks.length;
  const buf = Buffer.alloc(1 + count * 2);
  buf[0] = count & 0xFF;
  gaLinks.forEach((ga, i) => {
    const b0 = ((ga.main_g & 0x1F) << 3) | (ga.middle_g & 0x07);
    const b1 = ga.sub_g & 0xFF;
    buf[1 + i * 2] = b0;
    buf[2 + i * 2] = b1;
  });
  return buf;
}


// Build association table bytes: [count(1)] + [CO_num(1), GA_idx(1)] x count
// coRows: array of { object_number, ga_address } from com_objects
// gaLinks: sorted GA list (GA index = position in sorted list)
function buildAssocTable(coRows, gaLinks) {
  const gaIndexMap = {};
  gaLinks.forEach((ga, i) => { gaIndexMap[ga.address] = i; });

  const entries = [];
  for (const co of coRows) {
    const gas = (co.ga_address || '').split(/\s+/).filter(Boolean);
    for (const gaAddr of gas) {
      const gaIdx = gaIndexMap[gaAddr];
      if (gaIdx != null) entries.push([co.object_number & 0xFF, gaIdx & 0xFF]);
    }
  }

  entries.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const buf = Buffer.alloc(1 + entries.length * 2);
  buf[0] = entries.length & 0xFF;
  entries.forEach(([co, ga], i) => { buf[1 + i * 2] = co; buf[2 + i * 2] = ga; });
  return buf;
}

// Test whether a numeric/string value matches an ETS when-test condition.
// Tests can be exact values or relational operators (<, >, <=, >=).
function etsTestMatch(val, tests) {
  const n = parseFloat(val);
  for (const t of tests || []) {
    const rm = typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]);
      const op = rm[1];
      if (op === '<'  && n <  rv) return true;
      if (op === '>'  && n >  rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '='  && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) { return true; }
  }
  return false;
}

// Walk the ETS dynamic parameter tree (stored as app.dynTree) and collect paramRef IDs
// that are CONDITIONALLY active — i.e., reachable only through at least one choose/when branch.
// Unconditionally-visible params (always shown regardless of other param values) are excluded.
//
// ETS programming convention for RelSeg devices:
//   - Unconditionally-visible params: ETS leaves the RelSeg blob value in place.
//   - Conditionally-visible params (inside a choose/when that evaluates true):
//       if the param IS in the project XML -> write that value (handled by currentValues)
//       if NOT in project XML -> write the XML default (this function identifies these).
// Build the set of paramRefs that are unconditionally reachable from top-level channels/cib/pb
// without passing through any choice/when branch. These are always-active params.
function buildUnconditionalChannelSet(dynTree) {
  const s = new Set();
  function walk(node) {
    if (!node) return;
    for (const r of node.paramRefs || []) s.add(r);
    for (const b of node.blocks   || []) walk(b);
    // Do NOT walk into choices — params inside choices are conditional
  }
  for (const ch of dynTree?.main?.channels || []) walk(ch.node);
  for (const ci of dynTree?.main?.cib      || []) walk(ci);
  for (const pb of dynTree?.main?.pb       || []) walk(pb);
  return s;
}

function evalConditionallyActiveParamRefs(dynTree, params, currentValues) {
  const conditional = new Set();
  const getVal = (prKey) => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function evalChoice(choice, inChoice) {
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node, true); }
    }
    if (!matched && defNode) walkNode(defNode, true);
  }
  function walkNode(node, inChoice) {
    if (!node) return;
    for (const r of node.paramRefs || []) { if (inChoice) conditional.add(r); }
    for (const b of node.blocks || []) walkNode(b, inChoice);
    for (const choice of node.choices || []) evalChoice(choice, inChoice);
  }
  function walkDynSection(section) {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node, false);
    for (const ci of section.cib || []) walkNode(ci, false);
    for (const pb of section.pb || []) walkNode(pb, false);
    for (const choice of section.choices || []) evalChoice(choice, false);
  }
  walkDynSection(dynTree?.main);
  return conditional;
}

// Write `bitSize` bits of `value` into buf at byte `byteOffset`, starting from bit `bitOffset`.
// KNX/ETS6 convention:
//   - Multi-byte aligned values (bitOffset=0, bitSize multiple of 8): big-endian (MSB first).
//   - Sub-byte values: bitOffset is from the MSB of the byte (bit 0 = MSB = bit 7 in LSB notation).
//     A field at bitOffset=k, bitSize=n occupies byte bits [7-k .. 8-k-n] (LSB indexing).
//     value bit 0 (LSB) maps to byte bit (8 - bitOffset - bitSize).
// Encode a value as KNX 2-byte float (DPT 9.x) and write big-endian at byteOffset.
// Format: sign(1) + exponent(4) + mantissa(11). value = 0.01 x mantissa x 2^exponent
function writeKnxFloat16(buf, byteOffset, value) {
  if (byteOffset + 2 > buf.length) return;
  // Encode: find exponent such that mantissa fits in 11-bit signed range [-2048..2047]
  let m = Math.round(value * 100); // 0.01 factor
  let e = 0;
  while (m < -2048 || m > 2047) {
    m = Math.round(m / 2);
    e++;
    if (e > 15) break;
  }
  const sign = m < 0 ? 1 : 0;
  if (sign) m = m + 2048; // two's complement 11-bit: negative mantissa stored as 2048 + m
  const raw = (sign << 15) | ((e & 0xF) << 11) | (m & 0x7FF);
  buf[byteOffset]     = (raw >> 8) & 0xFF;
  buf[byteOffset + 1] = raw & 0xFF;
}

function writeBits(buf, byteOffset, bitOffset, bitSize, value) {
  if (byteOffset >= buf.length || bitSize <= 0) return;
  const mask = bitSize >= 32 ? 0xFFFFFFFF : (1 << bitSize) - 1;
  value = value & mask;
  // Byte-aligned multi-byte: write big-endian (KNX/ETS standard)
  if (bitOffset === 0 && bitSize % 8 === 0) {
    const byteCount = bitSize / 8;
    for (let i = 0; i < byteCount; i++) {
      const bIdx = byteOffset + i;
      if (bIdx >= buf.length) continue;
      buf[bIdx] = (value >>> ((byteCount - 1 - i) * 8)) & 0xFF;
    }
    return;
  }
  // Sub-byte: bitOffset from MSB (KNX convention: bitOffset=0 is bit 7 of the byte).
  // Handle spanning two bytes by splitting recursively (matches ETS DptValueConverter.WriteBits).
  if (bitOffset + bitSize > 8) {
    const bitsInFirstByte = 8 - bitOffset;
    writeBits(buf, byteOffset,     bitOffset, bitsInFirstByte, value >>> (bitSize - bitsInFirstByte));
    writeBits(buf, byteOffset + 1, 0,         bitSize - bitsInFirstByte, value);
    return;
  }
  const shift = 8 - bitOffset - bitSize;
  const bmask = ((1 << bitSize) - 1) << shift;
  buf[byteOffset] = (buf[byteOffset] & ~bmask) | ((value << shift) & bmask);
}


// Collect Assign operations whose when-branch is currently active.
// Returns array of { target, source, value } where source is a paramRef key (or null for literal assigns).
function collectActiveAssigns(dynTree, params, currentValues) {
  const result = [];
  const getVal = (prKey) => {
    if (prKey in currentValues) return String(currentValues[prKey]);
    return String(params[prKey]?.defaultValue ?? '');
  };
  function walkNode(node) {
    if (!node) return;
    for (const ass of node.assigns || []) result.push(ass);
    for (const b of node.blocks || []) walkNode(b);
    for (const choice of node.choices || []) evalChoice(choice);
  }
  function evalChoice(choice) {
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node); }
    }
    if (!matched && defNode) walkNode(defNode);
  }
  function walkDynSection(section) {
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
// Handles both RelativeSegment (System B) and AbsoluteSegment (ProductProcedure) devices.
function resolveParamSegment(model) {
  const lps = model.loadProcedures || [];
  // Try RelativeSegment path first (most common)
  const writeMemStep = lps.find(s => s.type === 'WriteRelMem');
  const relSegStep   = lps.find(s => s.type === 'RelSegment');
  if (writeMemStep || relSegStep) {
    const paramSize   = writeMemStep?.size || relSegStep?.size || 0;
    const paramFill   = relSegStep?.fill ?? 0xFF;
    const paramLsmIdx = relSegStep?.lsmIdx ?? 4;
    const relSegHex   = model.relSegData?.[paramLsmIdx] || null;
    return { paramSize, paramFill, relSegHex };
  }
  // Try AbsoluteSegment path: find the segment whose address range covers the parameter offsets.
  const absSegs = model.absSegData || {};
  const layout = model.paramMemLayout || {};
  const paramOffsets = Object.values(layout).map(v => v.offset).filter(v => v != null);
  if (paramOffsets.length === 0 || Object.keys(absSegs).length === 0) {
    return { paramSize: 0, paramFill: 0xFF, relSegHex: null };
  }
  const maxOffset = Math.max(...paramOffsets);
  // Find the AbsoluteSegment that contains the parameter range.
  for (const [addr, seg] of Object.entries(absSegs)) {
    if (seg.size > maxOffset) {
      return { paramSize: seg.size, paramFill: 0x00, relSegHex: seg.hex || null };
    }
  }
  // Fallback: use the largest segment
  const largest = Object.entries(absSegs).sort((a, b) => b[1].size - a[1].size)[0];
  if (largest) {
    return { paramSize: largest[1].size, paramFill: 0x00, relSegHex: largest[1].hex || null };
  }
  return { paramSize: 0, paramFill: 0xFF, relSegHex: null };
}

// Build parameter memory segment from the paramMemLayout (all params, including hidden ones).
// currentValues: { [paramRefId]: rawValue } — user overrides (may be sparse)
// fill: byte value to initialize the buffer with (from LdCtrlRelSegment.@Fill)
// relSegHex: optional hex string from Static/Code/RelativeSegment/Data — when present,
//   used as the base buffer (encodes factory defaults) instead of a fill byte.
function buildParamMem(size, paramMemLayout, currentValues, fill = 0xFF, relSegHex = null, dynTree = null, params = null) {
  // Detect convention: when all directly-mapped params (Union children with Offset attr) have
  // offset=0, the device uses the relSeg blob as a monolithic default.
  const hasPerParamOffsets = Object.values(paramMemLayout).some(
    i => !i.isText && !i.fromMemoryChild && i.offset > 0
  );
  const relSegConvention = !!relSegHex && !hasPerParamOffsets;

  const relSegBase = relSegHex ? Buffer.from(relSegHex, 'hex') : null;

  let buf;
  let paramShift = 0; // offset adjustment for param writes
  if (relSegHex) {
    const base = relSegBase;
    if (relSegConvention) {
      buf = Buffer.alloc(size, 0x00);
      base.copy(buf, 0, 0, Math.min(base.length, size));
      paramShift = 0;
    } else {
      buf = Buffer.alloc(size, fill);
      base.copy(buf, 0, 0, Math.min(base.length, size));
      paramShift = 0;
    }
  } else {
    buf = Buffer.alloc(size, fill);
  }
  const conditionallyActive = (relSegHex && dynTree && params)
    ? evalConditionallyActiveParamRefs(dynTree, params, currentValues)
    : null;
  const unconditionalChannel = (relSegHex && dynTree)
    ? buildUnconditionalChannelSet(dynTree)
    : null;

  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (info.offset === null || info.offset === undefined) continue;
    if (relSegHex && info.offset === 0) continue;
    if (info.fromMemoryChild) {
      if (!info.isVisible && prId in currentValues) { /* allow */ }
      else if (unconditionalChannel && unconditionalChannel.has(prId)) { /* allow */ }
      else {
        const passConditional = conditionallyActive && conditionallyActive.has(prId) && info.isVisible;
        if (!passConditional) continue;
      }
    }
    const rawVal = prId in currentValues ? currentValues[prId] : info.defaultValue;
    if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
    const writeOff = (relSegConvention && info.fromMemoryChild) ? info.offset + paramShift : info.offset;
    if (info.isText) {
      const byteSize = Math.floor(info.bitSize / 8);
      if (writeOff + byteSize > buf.length) continue;
      const strBuf = Buffer.from(rawVal, 'latin1');
      strBuf.copy(buf, writeOff, 0, Math.min(strBuf.length, byteSize));
      continue;
    }
    if (info.isFloat) {
      const fVal = parseFloat(rawVal);
      if (isNaN(fVal)) continue;
      const scaledVal = info.coefficient ? fVal / info.coefficient : fVal;
      if (info.bitSize === 16) {
        writeKnxFloat16(buf, writeOff, scaledVal);
      } else if (info.bitSize === 32) {
        if (writeOff + 4 <= buf.length) buf.writeFloatBE(scaledVal, writeOff);
      } else if (info.bitSize === 64) {
        if (writeOff + 8 <= buf.length) buf.writeDoubleBE(scaledVal, writeOff);
      }
      continue;
    }
    const numVal = parseFloat(rawVal);
    if (isNaN(numVal)) continue;
    const intVal = info.coefficient ? Math.round(numVal / info.coefficient) : Math.round(numVal);
    writeBits(buf, writeOff, info.bitOffset, info.bitSize, intVal);
  }

  // Process Assign operations
  if (dynTree && params) {
    const activeAssigns = collectActiveAssigns(dynTree, params, currentValues);
    for (const { target, source, value } of activeAssigns) {
      const targetInfo = paramMemLayout[target];
      if (!targetInfo || targetInfo.offset === null || targetInfo.offset === undefined) continue;
      if (relSegHex && targetInfo.offset === 0) continue;
      let rawVal;
      if (source) {
        const sourceParam = params[source];
        if (!sourceParam) continue;
        rawVal = source in currentValues ? currentValues[source] : sourceParam.defaultValue;
      } else {
        rawVal = value;
      }
      if (rawVal === '' || rawVal === null || rawVal === undefined) continue;
      const intVal = parseInt(rawVal);
      if (isNaN(intVal)) continue;
      const writeOff = (relSegConvention && targetInfo.fromMemoryChild) ? targetInfo.offset + paramShift : targetInfo.offset;
      writeBits(buf, writeOff, targetInfo.bitOffset, targetInfo.bitSize, intVal);
    }
  }

  return buf;
}

module.exports = {
  buildGATable,
  buildAssocTable,
  etsTestMatch,
  buildUnconditionalChannelSet,
  evalConditionallyActiveParamRefs,
  writeKnxFloat16,
  writeBits,
  collectActiveAssigns,
  resolveParamSegment,
  buildParamMem,
};
