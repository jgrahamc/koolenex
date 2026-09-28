/**
 * planDownload — pure telegram planner for the AbsoluteSegment (MDT-style)
 * device download / load-state-machine sequence.
 *
 * No I/O: takes parsed load-procedure steps plus prebuilt GA/association/
 * parameter memory images and returns an ordered list of `PlannedOp`s for
 * the executor (`KnxConnection.downloadDevice`) to send. Side-effect-free so
 * it can be diffed byte-for-byte against captured ETS6 telegrams (see
 * tests/knx-download-plan.test.ts) with no socket involved.
 *
 * ── Protocol notes ──────────────────────────────────────────────────────
 *
 * PID 5 (LoadStateControl) payload on each load-controllable interface
 * object is 10 bytes: `[event][9-byte LoadControlData]`:
 *   - event 4 (Unload):        `04 00000000 00 000000`
 *   - event 1 (Load):          `01 00000000 00 000000`
 *   - event 3 (segment/task descriptor): see `buildSegmentDescriptor` /
 *     `buildTaskDescriptor` below.
 *   - event 2 (LoadCompleted): `02 00000000 00 000000`
 *
 * Order: unload every LSM object, then per object: Load(1) -> segment
 * descriptor(s) (event 3) with A_Memory_Write interleaved -> TaskSegment
 * descriptor (event 3, different sub-format) -> LoadCompleted(2).
 *
 * AbsSegment descriptor (event 3), 9 bytes:
 *   `[kind][addrHi][addrLo][sizeHi][sizeLo][footer(4)]`
 *   kind   = 1 iff size === 1 (single-byte pointer segment), else 0.
 *   footer = `FF 03 80 00` for address >= 0x4000 (flash/EEPROM, real data
 *            follows), else `00 02 00 00` (low-address RAM/task-pointer
 *            segment, declared but never streamed).
 *
 * TaskSegment descriptor (event 3), 9 bytes:
 *   `[0x02][addrHi][addrLo][0x01][0x00][mfgLo][mfgHi][appNumLow][versionByte]`
 *   Trailing 6 bytes identify the application program, parsed from the
 *   device's `appId` ("M-<mfg>_A-<appNum>-<ver>-<cookie>").
 *
 * Address-table layout: index 0 is reserved for the device's own physical
 * address (never transmitted), so the written count byte is
 * `gaTable[0] + 1`, and GA entries start 3 bytes after the segment base
 * (skipping the 2 reserved bytes).
 */

import { orderByMergedOps, type MaskOp } from './knx-mask-procedures.ts';

// ── Plan step input type ────────────────────────────────────────────────────

export interface PlanStep {
  type: string;
  lsmIdx?: number;
  address?: number;
  size?: number;
  offset?: number;
  objIdx?: number;
  propId?: number;
  data?: Buffer;
  // `SegFlags` declared by an AbsSegment step, when present.
  segFlags?: number;
  // LoadProcedure's MergeId attribute (see knx-mask-procedures.ts). Only
  // meaningful when a mask op list is passed as planDownload()'s
  // `mergedOps` parameter; unused otherwise.
  mergeId?: number;
}

// ── Planned operation output type ───────────────────────────────────────────

export type PlannedOp =
  | { kind: 'connect' }
  | { kind: 'disconnect' }
  | { kind: 'restart' }
  | { kind: 'propWrite'; obj: number; pid: number; data: Buffer }
  | { kind: 'memWrite'; addr: number; bytes: Buffer };

export interface AbsSegSeed {
  size: number;
  hex?: string | null;
}

const ZERO9 = Buffer.alloc(9, 0);
const EVENT_UNLOAD = 4;
const EVENT_LOAD = 1;
const EVENT_SEGMENT = 3;
const EVENT_LOAD_COMPLETED = 2;
const FLASH_FOOTER = Buffer.from([0xff, 0x03, 0x80, 0x00]);
const RAM_FOOTER = Buffer.from([0x00, 0x02, 0x00, 0x00]);
const FLASH_BOUNDARY = 0x4000;

function loadStateWrite(
  objIdx: number,
  event: number,
  data9: Buffer,
): PlannedOp {
  return {
    kind: 'propWrite',
    obj: objIdx,
    pid: 5,
    data: Buffer.concat([Buffer.from([event]), data9]),
  };
}

function buildSegmentDescriptor(address: number, size: number): Buffer {
  const kind = size === 1 ? 1 : 0;
  const footer = address >= FLASH_BOUNDARY ? FLASH_FOOTER : RAM_FOOTER;
  return Buffer.concat([
    Buffer.from([
      kind,
      (address >> 8) & 0xff,
      address & 0xff,
      (size >> 8) & 0xff,
      size & 0xff,
    ]),
    footer,
  ]);
}

// Parse "M-<mfg hex4>_A-<appNum hex4>-<ver hex2>-<cookie>" into the fields
// ETS bakes into every TaskSegment descriptor's trailing 6 bytes.
function parseAppId(
  appId: string,
): { mfg: number; appNum: number; ver: number } | null {
  const m = /^M-([0-9A-Fa-f]{4})_A-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{2})-/.exec(
    appId,
  );
  if (!m) return null;
  return {
    mfg: parseInt(m[1]!, 16),
    appNum: parseInt(m[2]!, 16),
    ver: parseInt(m[3]!, 16),
  };
}

function buildTaskDescriptor(address: number, appId: string): Buffer {
  const parsed = parseAppId(appId) ?? { mfg: 0, appNum: 0, ver: 0 };
  return Buffer.from([
    0x02,
    (address >> 8) & 0xff,
    address & 0xff,
    0x01,
    0x00,
    parsed.mfg & 0xff, // manufacturer id, little-endian low byte
    (parsed.mfg >> 8) & 0xff, // manufacturer id, little-endian high byte
    parsed.appNum & 0xff, // low byte of the app number
    parsed.ver & 0xff, // version byte
  ]);
}

function pickSourceBuffer(
  address: number,
  lsmIdx: number,
  addrTableLsm: number | undefined,
  assocTableLsm: number | undefined,
  paramBase: number | null,
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  paramMem: Buffer | null,
  absSegData: Record<number, AbsSegSeed>,
  paramMemBySegment?: Map<number, Buffer> | null,
): Buffer | null {
  if (lsmIdx === addrTableLsm) return gaTable;
  if (lsmIdx === assocTableLsm) return assocTable;
  // Multiple parameter segments each number offsets from zero; resolve by
  // matching this address to its own segment buffer before falling back to
  // the single paramBase (used by models with no segment tracking).
  const bySeg = paramMemBySegment?.get(address);
  if (bySeg) return bySeg;
  if (paramBase != null && address === paramBase) return paramMem;
  const seed = absSegData[address];
  if (seed?.hex) return Buffer.from(seed.hex, 'hex');
  return null;
}

/**
 * Plan the full AbsoluteSegment (MDT-style) download sequence. Pure: no I/O.
 *
 * @param steps       Parsed LoadProcedureStep[] for the device (Connect,
 *                     Unload, Load, AbsSegment, TaskSegment, LoadCompleted,
 *                     Restart, Disconnect, ...).
 * @param gaTable      Address-table source buffer (buildGATable).
 * @param assocTable   Association-table source buffer (buildAssocTable).
 * @param paramMem     Parameter-memory source buffer (buildParamMem).
 * @param paramBase    Base address of the parameter AbsSegment
 *                     (resolveParamSegment().paramBase).
 * @param absSegData   App model's factory-seed map (address -> {size, hex})
 *                     for AbsSegments other than the address/association/
 *                     parameter tables (e.g. the group-object/flags table).
 * @param appId        Device's application-program id string, used to derive
 *                     the TaskSegment descriptor's identity bytes.
 */
export function planDownload(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  paramMem: Buffer | null,
  paramBase: number | null,
  absSegData: Record<number, AbsSegSeed> = {},
  appId: string = '',
  /**
   * One parameter buffer per declared segment (buildParamMemBySegment).
   * Takes precedence over `paramMem`/`paramBase`, which remain the path for
   * RelSegment devices and app models that predate segment tracking.
   */
  paramMemBySegment?: Map<number, Buffer> | null,
  /**
   * The mask-Procedure op list (knx-mask-procedures.ts's
   * `getMaskProcedure()` + `spliceAppSteps()`) for this device's mask, if
   * available. `null` (default): Unload/Load follow `steps`' own declared
   * order. When provided, order instead comes from the mask's own
   * `LdCtrlUnload`/`LdCtrlLoad` positions (falling back to natural order for
   * any lsmIdx the mask doesn't cover), via `orderByMergedOps()`.
   */
  mergedOps: MaskOp[] | null = null,
): PlannedOp[] {
  const ops: PlannedOp[] = [];

  if (steps.some((s) => s.type === 'Connect')) ops.push({ kind: 'connect' });

  const naturalOrder = (a: PlanStep, b: PlanStep): number =>
    steps.indexOf(a) - steps.indexOf(b);
  const unloadSteps = orderByMergedOps(
    steps.filter((s) => s.type === 'Unload'),
    mergedOps,
    'Unload',
    'lsmIdx',
    (s) => s.lsmIdx,
    naturalOrder,
  );
  for (const u of unloadSteps) {
    if (u.lsmIdx == null) continue;
    ops.push(loadStateWrite(u.lsmIdx, EVENT_UNLOAD, ZERO9));
  }

  const loadSteps = orderByMergedOps(
    steps.filter((s) => s.type === 'Load'),
    mergedOps,
    'Load',
    'lsmIdx',
    (s) => s.lsmIdx,
    naturalOrder,
  );
  const lsmOrder = loadSteps
    .map((s) => s.lsmIdx)
    .filter((v): v is number => v != null);
  // KNX interface-object numbering convention: first LSM object loaded is
  // the address table, second is the association table; further objects
  // (typically the application program) carry the group-object/flags table
  // and parameter data.
  const addrTableLsm = lsmOrder[0];
  const assocTableLsm = lsmOrder[1];

  for (const lsmIdx of lsmOrder) {
    ops.push(loadStateWrite(lsmIdx, EVENT_LOAD, ZERO9));

    const segSteps = steps.filter(
      (s) => s.type === 'AbsSegment' && s.lsmIdx === lsmIdx,
    );
    for (const seg of segSteps) {
      if (seg.address == null || seg.size == null) continue;
      // Footer is derived from address alone (RAM vs flash). Refuse if a
      // declared SegFlags disagrees - untested descriptor combination.
      if (seg.segFlags != null) {
        const predictedSegFlags = seg.address >= FLASH_BOUNDARY ? 0x80 : 0x00;
        if (seg.segFlags !== predictedSegFlags) {
          throw new Error(
            `Refusing AbsSegment download: segment at address ${seg.address} (LsmIdx=${lsmIdx}) declares SegFlags=${seg.segFlags}, but the address-only rule used to build its descriptor predicts ${predictedSegFlags}. A descriptor for that combination has never been validated on a device, so the download was refused.`,
          );
        }
      }
      ops.push(
        loadStateWrite(
          lsmIdx,
          EVENT_SEGMENT,
          buildSegmentDescriptor(seg.address, seg.size),
        ),
      );

      const buf = pickSourceBuffer(
        seg.address,
        lsmIdx,
        addrTableLsm,
        assocTableLsm,
        paramBase,
        gaTable,
        assocTable,
        paramMem,
        absSegData,
        paramMemBySegment,
      );
      if (!buf || buf.length === 0) continue;

      if (lsmIdx === addrTableLsm) {
        // Slot 0 (2 bytes after the count byte) is reserved for the
        // device's own physical address, never transmitted; the count byte
        // includes it.
        ops.push({
          kind: 'memWrite',
          addr: seg.address,
          bytes: Buffer.from([(buf[0] ?? 0) + 1]),
        });
        const entries = buf.subarray(1);
        if (entries.length)
          ops.push({ kind: 'memWrite', addr: seg.address + 3, bytes: entries });
      } else {
        ops.push({ kind: 'memWrite', addr: seg.address, bytes: buf });
      }
    }

    const taskSteps = steps.filter(
      (s) => s.type === 'TaskSegment' && s.lsmIdx === lsmIdx,
    );
    for (const t of taskSteps) {
      if (t.address == null) continue;
      ops.push(
        loadStateWrite(
          lsmIdx,
          EVENT_SEGMENT,
          buildTaskDescriptor(t.address, appId),
        ),
      );
    }

    ops.push(loadStateWrite(lsmIdx, EVENT_LOAD_COMPLETED, ZERO9));
  }

  if (steps.some((s) => s.type === 'Restart')) ops.push({ kind: 'restart' });
  if (steps.some((s) => s.type === 'Disconnect'))
    ops.push({ kind: 'disconnect' });

  return ops;
}

// True if steps use the AbsoluteSegment (MDT-style) load procedure; selects
// planDownload vs. the legacy RelSegment/WriteRelMem/LoadImageProp path.
export function isAbsSegmentProcedure(steps: PlanStep[]): boolean {
  return steps.some((s) =>
    ['Unload', 'Load', 'AbsSegment', 'TaskSegment', 'LoadCompleted'].includes(
      s.type,
    ),
  );
}

// ── Legacy RelSegment download plan ─────────────────────────────────────────

/**
 * Pure planner for legacy RelSegment/WriteRelMem downloads: chunks the
 * parameter image into A_Memory_Write-sized pieces at the segment's absolute
 * address (resolved base + relative offset). Mirrors downloadDevice()'s
 * executor loop for offline diffing against a captured ETS download.
 */
export function planRelmemWrites(
  steps: PlanStep[],
  paramMem: Buffer | null,
  bases: Record<number, number>,
  chunkSize = 10,
): Array<{ addr: number; bytes: Buffer }> {
  const ops: Array<{ addr: number; bytes: Buffer }> = [];
  if (!paramMem) return ops;
  for (const s of steps) {
    if (
      s.type !== 'WriteRelMem' ||
      typeof s.offset !== 'number' ||
      typeof s.size !== 'number'
    )
      continue;
    const base = bases[s.objIdx ?? 4] ?? 0;
    const mem = paramMem.subarray(0, s.size);
    for (let off = 0; off < mem.length; off += chunkSize) {
      ops.push({
        addr: base + s.offset + off,
        bytes: mem.subarray(off, off + chunkSize),
      });
    }
  }
  return ops;
}

// ── Read-back verification plan ─────────────────────────────────────────────
//
// planVerify() derives, from the same artifacts as planDownload(), the set of
// device reads that prove the computed configuration matches a correctly-
// programmed device. Read-only counterpart of the download - nothing is ever
// written.
//
// Per family:
//   - absmem : each AbsSegment memory transfer becomes a read at the same
//              address/length.
//   - relmem : each WriteRelMem segment becomes a read of paramMem at its
//              relative offset.
//   - prop   : property-configured devices (KNX IP routers, some sensors)
//              have no downloadable memory image; CompareProp/WriteProp
//              steps become property reads compared to the expected data.

export interface VerifyMemRegion {
  addr: number;
  expected: Buffer;
  label: string;
}

export interface VerifyPropRead {
  obj: number;
  pid: number;
  expected: Buffer; // may be empty when ETS supplies no comparison value
  label: string;
}

export type VerifyFamily = 'absmem' | 'relmem' | 'prop' | 'none';

export interface VerifyPlan {
  family: VerifyFamily;
  mem: VerifyMemRegion[];
  props: VerifyPropRead[];
  // GA table (objIdx 1) / Association table (objIdx 2) / Group Object Table
  // (objIdx 3) regions, kept separate from `mem` - mirrors downloadDevice()'s
  // writeUndeclaredTable(). Only populated when the app model doesn't already
  // declare a WriteRelMem step for that object (see declaredObjIdxs below).
  // Kept out of `mem` so the "raw memory bytes match" scope (parameter
  // segment only) is unaffected; decoded and surfaced as named comparison
  // rows per communication object instead of raw bytes.
  undeclaredTableMem: VerifyMemRegion[];
}

// Shared by every VerifyPlan branch - see the `undeclaredTableMem` field
// comment above.
function buildUndeclaredTableMem(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  groupObjectTable: Buffer | null,
  relBaseByObj: Record<number, number>,
): VerifyMemRegion[] {
  // Only a genuine WriteRelMem step counts as "already handled" -
  // LoadImageProp is read-only for every objIdx (see
  // docs/knx-device-write-protocol.md), so a model declaring it never
  // actually writes the table content. Matches the same check on the write
  // side (knx-connection.ts's downloadDevice()) and routes/bus.ts's
  // /bus/verify-device.
  const declaredObjIdxs = new Set(
    steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx),
  );
  const out: VerifyMemRegion[] = [];
  if (
    gaTable &&
    gaTable.length &&
    !declaredObjIdxs.has(1) &&
    relBaseByObj[1] != null
  ) {
    out.push({
      addr: relBaseByObj[1],
      expected: gaTable,
      label: `gatable@0x${relBaseByObj[1].toString(16)}`,
    });
  }
  if (
    assocTable &&
    assocTable.length &&
    !declaredObjIdxs.has(2) &&
    relBaseByObj[2] != null
  ) {
    out.push({
      addr: relBaseByObj[2],
      expected: assocTable,
      label: `assoctable@0x${relBaseByObj[2].toString(16)}`,
    });
  }
  if (
    groupObjectTable &&
    groupObjectTable.length &&
    !declaredObjIdxs.has(3) &&
    relBaseByObj[3] != null
  ) {
    out.push({
      addr: relBaseByObj[3],
      expected: groupObjectTable,
      label: `object3@0x${relBaseByObj[3].toString(16)}`,
    });
  }
  return out;
}

export function planVerify(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  paramMem: Buffer | null,
  paramBase: number | null,
  absSegData: Record<number, AbsSegSeed> = {},
  appId: string = '',
  relBaseByObj: Record<number, number> = {},
  groupObjectTable: Buffer | null = null,
  /** See planDownload's parameter of the same name. */
  paramMemBySegment?: Map<number, Buffer> | null,
): VerifyPlan {
  const undeclaredTableMem = buildUndeclaredTableMem(
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    relBaseByObj,
  );

  // AbsSegment (MDT-style): read back what planDownload would stream.
  if (isAbsSegmentProcedure(steps)) {
    const ops = planDownload(
      steps,
      gaTable,
      assocTable,
      paramMem,
      paramBase,
      absSegData,
      appId,
      paramMemBySegment,
    );
    const mem: VerifyMemRegion[] = [];
    for (const op of ops) {
      if (op.kind !== 'memWrite' || op.bytes.length === 0) continue;
      mem.push({
        addr: op.addr,
        expected: op.bytes,
        label: `mem@0x${op.addr.toString(16)}`,
      });
    }
    return { family: 'absmem', mem, props: [], undeclaredTableMem };
  }

  // Legacy RelSegment: read paramMem at each WriteRelMem segment's offset.
  const relSegs = steps.filter(
    (s) =>
      s.type === 'WriteRelMem' &&
      typeof s.offset === 'number' &&
      typeof s.size === 'number',
  );
  if (relSegs.length && paramMem) {
    const mem: VerifyMemRegion[] = [];
    for (const s of relSegs) {
      const offset = s.offset as number;
      const size = s.size as number;
      const objIdx = s.objIdx ?? 4;
      const base = relBaseByObj[objIdx] ?? 0;
      mem.push({
        addr: base + offset,
        expected: paramMem.subarray(0, size),
        label: `relmem@0x${(base + offset).toString(16)}`,
      });
    }
    return { family: 'relmem', mem, props: [], undeclaredTableMem };
  }

  // Property-configured device (e.g. KNX IP router): no downloadable
  // parameter memory image, just interface-object property steps. Only
  // CompareProp/WriteProp steps carrying a comparison value are verifiable
  // (empty payloads are load-state triggers) - typically the manufacturer-id
  // (PID 12) and hardware-type (PID 78) identity checks.
  const propSteps = steps.filter(
    (s) => s.type === 'CompareProp' || s.type === 'WriteProp',
  );
  if (propSteps.length) {
    const props: VerifyPropRead[] = [];
    for (const s of propSteps) {
      if (typeof s.objIdx !== 'number' || typeof s.propId !== 'number')
        continue;
      const expected = s.data ?? Buffer.alloc(0);
      if (expected.length === 0) continue; // trigger-only, nothing to read-diff
      props.push({
        obj: s.objIdx,
        pid: s.propId,
        expected,
        label: `prop obj=${s.objIdx} pid=${s.propId}`,
      });
    }
    if (props.length)
      return { family: 'prop', mem: [], props, undeclaredTableMem };
  }

  return { family: 'none', mem: [], props: [], undeclaredTableMem };
}
