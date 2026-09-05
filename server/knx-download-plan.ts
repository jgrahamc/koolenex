/**
 * planDownload — PURE telegram-planning function for the AbsoluteSegment
 * (MDT-style) device download / load-state-machine sequence.
 *
 * This module performs NO I/O: it takes the parsed load-procedure steps plus
 * the already-built GA/association/parameter memory images and returns an
 * ordered list of `PlannedOp`s describing exactly what the executor
 * (`KnxConnection.downloadDevice`) must send. Keeping this logic side-effect
 * free is what makes it possible to validate byte-for-byte against captured
 * ETS6 telegrams (see tests/knx-download-plan.test.ts) without ever opening a
 * socket to a bus or device.
 *
 * ── Protocol notes (reverse-engineered from ETS6 gold telegrams) ──────────
 *
 * ETS drives PID 5 (LoadStateControl) on each load-controllable interface
 * object with a 10-byte payload `[event][9-byte LoadControlData]`:
 *   - event 4 (Unload):        `04 00000000 00 000000`
 *   - event 1 (Load):          `01 00000000 00 000000`
 *   - event 3 (Additional Load Controls / segment): 9-byte descriptor, see
 *     `buildSegmentDescriptor` / `buildTaskDescriptor` below.
 *   - event 2 (LoadCompleted): `02 00000000 00 000000`
 *
 * Order: unload every LSM object first, then per object: Load(1) ->
 * segment descriptor(s) (event 3) with their A_Memory_Write payload
 * interleaved -> TaskSegment descriptor (event 3, different sub-format) ->
 * LoadCompleted(2).
 *
 * AbsSegment descriptor (event 3) 9-byte payload:
 *   [kind(1)][addrHi][addrLo][sizeHi][sizeLo][footer(4)]
 *   kind   = 1 iff segment size === 1 (a single-byte "pointer" segment),
 *            else 0.
 *   footer = FF 03 80 00 when address >= 0x4000 (Flash/EEPROM segment with
 *            real data to transfer), else 00 02 00 00 (low-address RAM/task
 *            pointer segment ETS declares but never streams memory for).
 *   Verified against ETS gold for both 1.1.2 and 1.1.3: every (addr, size,
 *   kind, footer) tuple matches exactly.
 *
 * TaskSegment descriptor (event 3) 9-byte payload:
 *   [0x02][addrHi][addrLo][0x01][0x00][mfgLo][mfgHi][appNumLow][versionByte]
 *   addr = the TaskSegment step's address. The trailing 6 bytes identify the
 *   application program itself (manufacturer id little-endian, low byte of
 *   the app number, and the version byte) — parsed directly from the
 *   device's `appId` string ("M-<mfg>_A-<appNum>-<ver>-<cookie>"), not
 *   hardcoded. Verified against both 1.1.2 (`...14 21`) and 1.1.3
 *   (`...16 21`).
 *
 * Address-table memory layout: the classic KNX address table reserves index
 * 0 for the device's own physical address, which ETS never transmits (the
 * device already knows it). So the count byte written is
 * `gaTable[0] + 1` (not `gaTable[0]`), and the GA entries are written
 * starting 3 bytes after the segment base (skipping the 2 reserved bytes),
 * not immediately after the count byte. Verified against 1.1.3 gold: count
 * byte 0x0B (= 10 GAs + 1 reserved slot), entries starting at 0x4003.
 */

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
): Buffer | null {
  if (lsmIdx === addrTableLsm) return gaTable;
  if (lsmIdx === assocTableLsm) return assocTable;
  if (paramBase != null && address === paramBase) return paramMem;
  const seed = absSegData[address];
  if (seed?.hex) return Buffer.from(seed.hex, 'hex');
  return null;
}

/**
 * Plan the full AbsoluteSegment (MDT-style) download telegram sequence.
 * Pure: no I/O, no bus, no side effects — safe to unit-test against gold
 * telegrams captured from ETS6.
 *
 * @param steps       Parsed LoadProcedureStep[] for the device (Connect,
 *                     Unload, Load, AbsSegment, TaskSegment, LoadCompleted,
 *                     Restart, Disconnect, ...).
 * @param gaTable      Address-table source buffer (from buildGATable).
 * @param assocTable   Association-table source buffer (from buildAssocTable).
 * @param paramMem     Parameter-memory source buffer (from buildParamMem).
 * @param paramBase    Base address of the parameter AbsSegment, as resolved
 *                     by resolveParamSegment().paramBase.
 * @param absSegData   The app model's factory-seed map (address -> {size,
 *                     hex}), used as the source for AbsSegments that are
 *                     neither the address table, association table, nor
 *                     parameter segment (e.g. the group-object/flags table).
 * @param appId        The device's application-program id string, used to
 *                     derive the TaskSegment descriptor's identity bytes.
 */
export function planDownload(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  paramMem: Buffer | null,
  paramBase: number | null,
  absSegData: Record<number, AbsSegSeed> = {},
  appId: string = '',
): PlannedOp[] {
  const ops: PlannedOp[] = [];

  if (steps.some((s) => s.type === 'Connect')) ops.push({ kind: 'connect' });

  const unloadSteps = steps.filter((s) => s.type === 'Unload');
  for (const u of unloadSteps) {
    if (u.lsmIdx == null) continue;
    ops.push(loadStateWrite(u.lsmIdx, EVENT_UNLOAD, ZERO9));
  }

  const loadSteps = steps.filter((s) => s.type === 'Load');
  const lsmOrder = loadSteps
    .map((s) => s.lsmIdx)
    .filter((v): v is number => v != null);
  // Convention (confirmed against ETS gold + the KNX interface-object
  // numbering standard): the first LSM object loaded is the address table,
  // the second is the association table, and any further objects (typically
  // the application program) carry the group-object/flags table and
  // parameter data.
  const addrTableLsm = lsmOrder[0];
  const assocTableLsm = lsmOrder[1];

  for (const lsmIdx of lsmOrder) {
    ops.push(loadStateWrite(lsmIdx, EVENT_LOAD, ZERO9));

    const segSteps = steps.filter(
      (s) => s.type === 'AbsSegment' && s.lsmIdx === lsmIdx,
    );
    for (const seg of segSteps) {
      if (seg.address == null || seg.size == null) continue;
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
      );
      if (!buf || buf.length === 0) continue;

      if (lsmIdx === addrTableLsm) {
        // Classic address table: slot 0 (2 bytes right after the count
        // byte) is reserved for the device's own physical address, which
        // ETS never transmits. The count byte therefore counts that
        // reserved slot too.
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

// Detect whether a step list uses the AbsoluteSegment (MDT-style) load
// procedure — i.e. it contains any step type the old inline downloadDevice
// loop does not understand. Used by the executor to choose between the
// planDownload path and the legacy RelSegment/WriteRelMem/LoadImageProp path.
export function isAbsSegmentProcedure(steps: PlanStep[]): boolean {
  return steps.some((s) =>
    ['Unload', 'Load', 'AbsSegment', 'TaskSegment', 'LoadCompleted'].includes(
      s.type,
    ),
  );
}

// ── Legacy RelSegment download plan ─────────────────────────────────────────

/**
 * Pure planner for legacy RelSegment/WriteRelMem downloads: chunk the parameter
 * image into A_Memory_Write-sized pieces at the segment's ABSOLUTE address
 * (resolved base + relative offset). Mirrors the executor loop in
 * downloadDevice so it can be diffed against a captured ETS download offline.
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
// planVerify() derives, from the *same* artifacts as planDownload(), the exact
// set of device reads whose results — when byte-diffed against the `expected`
// bytes here — prove koolenex's computed configuration matches what a
// correctly-programmed device would hold. This is the read-only counterpart of
// the download: NOTHING is ever written. If every region/prop matches, the
// device is "theoretically programmable" (we have proven our bytes are the
// right bytes) without touching a single memory cell.
//
// Every device family the project owns maps to a concrete verify plan:
//   - absmem : each AbsSegment memory transfer planDownload would emit becomes
//              a memory read at the same address for the same length.
//   - relmem : each WriteRelMem segment becomes a memory read of paramMem at
//              the segment's relative offset (unchanged from the original
//              verify-device behavior).
//   - prop   : property-configured devices (KNX IP routers, some sensors) have
//              no downloadable memory image; their CompareProp/WriteProp steps
//              become interface-object property reads compared to the step's
//              expected data.

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
  // (objIdx 3, added 2026-08-29) regions, kept separate from `mem`
  // deliberately - see downloadDevice()'s writeUndeclaredTable() for the
  // write-side twin of this same mechanism (hence the name). Only populated
  // when the app's own model doesn't already declare a WriteRelMem step for
  // that object (i.e. would otherwise never be verified at all, matching
  // the fact it'd otherwise never have been written either - see
  // declaredObjIdxs below for exactly which step type counts as "declared").
  // Kept out of `mem`/`totalBytes` so the existing "raw memory bytes match"
  // scope (parameter segment only) and the `segments.length === 1` decode
  // gate in the verify-device route are unaffected - these are decoded and
  // surfaced as their own named comparison rows instead (per communication
  // object, not per raw byte). Named `undeclaredTableMem` (not `gaAssocMem`,
  // its pre-Object-3 name) since it's no longer just the two GA/Assoc tables.
  undeclaredTableMem: VerifyMemRegion[];
}

// Shared by every VerifyPlan branch below - see the `undeclaredTableMem`
// field comment above for why this exists and is kept separate from `mem`.
function buildUndeclaredTableMem(
  steps: PlanStep[],
  gaTable: Buffer | null,
  assocTable: Buffer | null,
  groupObjectTable: Buffer | null,
  relBaseByObj: Record<number, number>,
): VerifyMemRegion[] {
  // Only a genuine WriteRelMem step (a real content write) counts as
  // "already handled" - LoadImageProp is confirmed read-only for every
  // objIdx (docs/knx-device-write-protocol.md Part 7), so a model
  // declaring it never actually reads/writes the table content itself.
  // Matches the identical fix already applied on the write side
  // (knx-connection.ts's downloadDevice(), Part 12) and the route-level
  // gate in routes/bus.ts's /bus/verify-device - this was a third,
  // previously-unfixed copy of the same latent bug, found 2026-08-29 while
  // extending this function to cover Object 3.
  const declaredObjIdxs = new Set(
    steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx),
  );
  const out: VerifyMemRegion[] = [];
  if (gaTable && gaTable.length && !declaredObjIdxs.has(1) && relBaseByObj[1] != null) {
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
): VerifyPlan {
  const undeclaredTableMem = buildUndeclaredTableMem(
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    relBaseByObj,
  );

  // AbsSegment (MDT-style): read back exactly what planDownload would stream.
  if (isAbsSegmentProcedure(steps)) {
    const ops = planDownload(
      steps,
      gaTable,
      assocTable,
      paramMem,
      paramBase,
      absSegData,
      appId,
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

  // Property-configured device (e.g. KNX IP router): no downloadable parameter
  // memory image — its load procedure is just interface-object property
  // steps. Only CompareProp/WriteProp steps that actually carry a comparison
  // value are verifiable (empty WriteProp payloads are load-state triggers,
  // not readable config); these are typically the manufacturer-id (PID 12) and
  // hardware-type (PID 78) identity checks ETS runs before a download.
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
    if (props.length) return { family: 'prop', mem: [], props, undeclaredTableMem };
  }

  return { family: 'none', mem: [], props: [], undeclaredTableMem };
}
