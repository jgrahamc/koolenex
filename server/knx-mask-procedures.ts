/**
 * Central source of KNX device download/unload ordering.
 *
 * Both download executors (the inline RelSegment/System-B path and the pure
 * `planDownload()`/AbsSegment path in knx-download-plan.ts) previously used
 * hand-written ordering rules per capture - Unload descending by object
 * index, StartLoading in a fixed dependency order. These are not universal:
 * a Gira smoke-alarm capture (mask `0x0705`) uses ASCENDING object order
 * where System B (`$07B0`) is DESCENDING.
 *
 * The authoritative ordering source is the project's own KNX Master Data,
 * in two halves connected by this module:
 *
 *  1. Every mask version (e.g. `MV-07B0`/"System B") declares, in the KNX
 *     Master Data XML saved per project (`knx_master_<projectId>.xml` - see
 *     `routes/shared.ts`'s `readMasterXml()`), a `<Procedures>` section
 *     under its `<MaskVersion>`: `<Procedure ProcedureType="Load"
 *     ProcedureSubType="all|grp|par|par,grp|cfg|ap1">` and `<Procedure
 *     ProcedureType="Unload" ProcedureSubType="all">`, each an ordered
 *     sequence of `LdCtrl*` operations, with `<LdCtrlMerge MergeId="N">`
 *     markers where an application program's declared steps get spliced in.
 *  2. Every application program's XML declares its device-specific steps
 *     grouped into `<LoadProcedure MergeId="N">` blocks (see `ets-app.ts`'s
 *     LoadProcedures parsing, which carries `mergeId` through on every
 *     parsed step) - each group's `MergeId` says which mask merge point it
 *     belongs at.
 *
 * This module reads (1) and splices in (2), deriving execution order from
 * real KNX data rather than a hand-picked constant. Not every mask version
 * declares a `Load` Procedure for every subtype (the Gira mask above only
 * declares `Unload:all`) - `getMaskProcedure()` returns `null` for a
 * combination that isn't declared, and every caller has a fallback (see
 * `orderByMergedOps()`'s doc comment below).
 */

import { readMasterXml } from './routes/shared.ts';
import { logger } from './log.ts';
import {
  orderedXmlParser,
  ordAttr,
  ordTagName,
  ordChildNodes,
  type OrdXmlNode,
} from './ets-parser.ts';

// A mask-declared operation is either a wire-action step (same vocabulary as
// an application program's own parsed load-procedure steps -
// Unload/Load/RelSegment/WriteRelMem/WriteProp/LoadCompleted/Restart/
// Connect/Disconnect/CompareProp/LoadImageProp/TaskSegment/AbsSegment), or
// one of two mask-only markers never seen in an app program's declared
// steps: `Merge` (a splice point consumed by `spliceAppSteps()`, never
// itself executed) and `MapError` (an `LdCtrlMapError` directive, parsed and
// carried through but not acted on by either executor yet).
export interface MaskOp {
  type: string;
  lsmIdx?: number;
  objIdx?: number;
  propId?: number;
  mergeId?: number;
  originalError?: number;
  mappedError?: number;
  // `Unhandled`: the tag of an LdCtrl* directive this module does not
  // recognise. `SetControlVariable`: a mask-level control variable directive.
  tag?: string;
  name?: string;
  value?: string;
}

// Minimal shape both `DownloadStep` (knx-connection.ts) and `PlanStep`
// (knx-download-plan.ts) already satisfy - this module only reads
// `type`/`lsmIdx`/`objIdx`/`mergeId` off a declared step, never
// download-content-specific fields.
export interface MaskProcedureAppStep {
  type: string;
  lsmIdx?: number;
  objIdx?: number;
  mergeId?: number;
}

export interface MaskProcedureCacheEntry {
  maskVersionDecimal: number;
  // Master data can declare the same `${ProcedureType}:${ProcedureSubType}`
  // more than once for one mask, in different `<HawkConfigurationData>`
  // revisions (plain + `LegacyVersion` - line-coupler masks do this for
  // Load, System B for Unload:all). Every revision is kept;
  // getMaskProcedure() chooses explicitly rather than picking the last one.
  procedures: Map<string, { ops: MaskOp[]; isLegacy: boolean }[]>;
}

const _cache = new Map<string, MaskProcedureCacheEntry[] | null>();

function parseOp(elNode: OrdXmlNode): MaskOp | null {
  const tag = ordTagName(elNode);
  if (!tag) return null;
  const numAttr = (name: string): number =>
    parseInt(ordAttr(elNode, name), 10) || 0;
  const numAttrOrUndef = (name: string): number | undefined => {
    const raw = ordAttr(elNode, name);
    return raw ? parseInt(raw, 10) : undefined;
  };
  switch (tag) {
    case 'LdCtrlConnect':
      return { type: 'Connect' };
    case 'LdCtrlDisconnect':
      return { type: 'Disconnect' };
    case 'LdCtrlRestart':
      return { type: 'Restart' };
    case 'LdCtrlMerge': {
      const mergeId = numAttrOrUndef('MergeId');
      return mergeId != null ? { type: 'Merge', mergeId } : null;
    }
    case 'LdCtrlMapError':
      return {
        type: 'MapError',
        originalError: numAttr('OriginalError'),
        mappedError: numAttr('MappedError'),
      };
    case 'LdCtrlUnload':
      return { type: 'Unload', lsmIdx: numAttr('LsmIdx') };
    case 'LdCtrlLoad':
      return { type: 'Load', lsmIdx: numAttr('LsmIdx') };
    case 'LdCtrlLoadCompleted':
      return { type: 'LoadCompleted', lsmIdx: numAttr('LsmIdx') };
    case 'LdCtrlRelSegment':
      return { type: 'RelSegment', lsmIdx: numAttr('LsmIdx') || 4 };
    case 'LdCtrlWriteRelMem':
      return { type: 'WriteRelMem', objIdx: numAttr('ObjIdx') || 4 };
    case 'LdCtrlWriteProp':
      return {
        type: 'WriteProp',
        objIdx: numAttr('ObjIdx'),
        propId: numAttr('PropId'),
      };
    case 'LdCtrlCompareProp':
      return {
        type: 'CompareProp',
        objIdx: numAttr('ObjIdx'),
        propId: numAttr('PropId'),
      };
    case 'LdCtrlLoadImageProp':
      return {
        type: 'LoadImageProp',
        objIdx: numAttr('ObjIdx'),
        propId: numAttr('PropId') || 27,
      };
    case 'LdCtrlAbsSegment':
      return {
        type: 'AbsSegment',
        lsmIdx: numAttr('LsmIdx'),
        objIdx: undefined,
      };
    case 'LdCtrlTaskSegment':
      return { type: 'TaskSegment', lsmIdx: numAttr('LsmIdx') };
    case 'LdCtrlSetControlVariable':
      return {
        type: 'SetControlVariable',
        name: ordAttr(elNode, 'Name'),
        value: ordAttr(elNode, 'Value'),
      };
    default:
      // Whitespace and text nodes between elements are not directives.
      if (!tag.startsWith('LdCtrl')) return null;
      // An unrecognized directive (e.g. LdCtrlWriteMem, LdCtrlDelay,
      // LdCtrlMasterReset on legacy masks). Carry it through as `Unhandled`
      // so downloadDevice() can refuse a procedure that needs a step it
      // can't perform, rather than silently skipping it.
      logger.warn(
        'knx',
        `Mask Procedure declares an unrecognized ${tag} step - carrying it through as 'Unhandled'`,
        { tag },
      );
      return { type: 'Unhandled', tag };
  }
}

/**
 * Pure parse: KNX Master Data XML (a whole `knx_master.xml`'s content) ->
 * every MaskVersion's ordered Procedure op lists. No file I/O, no caching.
 */
export function parseMaskProcedures(xml: string): MaskProcedureCacheEntry[] {
  const ordered = orderedXmlParser.parse(xml) as OrdXmlNode[];
  const findMaskVersions = (
    items: OrdXmlNode[] | OrdXmlNode | null,
  ): OrdXmlNode[] | null => {
    if (!items) return null;
    for (const elNode of Array.isArray(items) ? items : [items]) {
      const tag = ordTagName(elNode);
      if (tag === 'MaskVersions') return ordChildNodes(elNode);
      for (const key of ['KNX', 'MasterData']) {
        if (tag === key) {
          const r = findMaskVersions(ordChildNodes(elNode));
          if (r) return r;
        }
      }
    }
    return null;
  };
  const maskVersions = findMaskVersions(ordered) ?? [];
  const entries: MaskProcedureCacheEntry[] = [];
  for (const mv of maskVersions) {
    if (ordTagName(mv) !== 'MaskVersion') continue;
    const maskVersionDecimal = parseInt(ordAttr(mv, 'MaskVersion'), 10);
    if (!maskVersionDecimal) continue;
    const procedures = new Map<
      string,
      { ops: MaskOp[]; isLegacy: boolean }[]
    >();
    // Navigate MaskVersion -> HawkConfigurationData -> Procedures -> Procedure*
    for (const child of ordChildNodes(mv)) {
      if (ordTagName(child) !== 'HawkConfigurationData') continue;
      const isLegacy = ordAttr(child, 'LegacyVersion') !== '';
      for (const grandchild of ordChildNodes(child)) {
        if (ordTagName(grandchild) !== 'Procedures') continue;
        for (const proc of ordChildNodes(grandchild)) {
          if (ordTagName(proc) !== 'Procedure') continue;
          const procType = ordAttr(proc, 'ProcedureType');
          const procSubType = ordAttr(proc, 'ProcedureSubType');
          if (!procType) continue;
          const ops: MaskOp[] = [];
          for (const elNode of ordChildNodes(proc)) {
            const op = parseOp(elNode);
            if (op) ops.push(op);
          }
          const key = `${procType}:${procSubType}`;
          const list = procedures.get(key) ?? [];
          list.push({ ops, isLegacy });
          procedures.set(key, list);
        }
      }
    }
    entries.push({ maskVersionDecimal, procedures });
  }
  return entries;
}

function loadMaskProcedureCache(
  projectId: string | number,
): MaskProcedureCacheEntry[] | null {
  const cacheKey = String(projectId);
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)!;
  const xml = readMasterXml(projectId);
  if (!xml) return (_cache.set(cacheKey, null), null);
  let entries: MaskProcedureCacheEntry[] | null;
  try {
    entries = parseMaskProcedures(xml);
  } catch {
    entries = null;
  }
  _cache.set(cacheKey, entries);
  return entries;
}

/** Drops a project's cached mask Procedures (e.g. after a project reimport). */
export function clearMaskProcedureCache(projectId?: string | number): void {
  if (projectId === undefined) {
    _cache.clear();
  } else {
    _cache.delete(String(projectId));
  }
}

/**
 * Device mask (e.g. "07b0", from DeviceDescriptor_Read) -> the decimal
 * MaskVersion attribute KNX Master Data uses (0x07B0 = 1968).
 */
function maskHexToDecimal(maskHex: string): number | null {
  const n = parseInt(maskHex.replace(/^0x/i, ''), 16);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The authoritative ordered operation list for one mask/procedure
 * combination, e.g. `getMaskProcedure(projectId, '07b0', 'Load', 'all')`.
 * Returns `null` when the mask/procedure isn't declared in this project's
 * master data (see this module's header comment) - callers must have a
 * fallback, not a guess.
 */
export function getMaskProcedure(
  projectId: string | number | null | undefined,
  maskHex: string,
  procedureType: 'Load' | 'Unload',
  procedureSubType: string,
  // When the master data declares this procedure in more than one revision,
  // the non-legacy one is used unless this is true. Pass true only when the
  // application explicitly asks for the legacy programming style
  // (LineCoupler0912NewProgrammingStyle="false").
  preferLegacy = false,
): MaskOp[] | null {
  if (projectId == null) return null;
  const maskDecimal = maskHexToDecimal(maskHex);
  if (maskDecimal == null) return null;
  const cache = loadMaskProcedureCache(projectId);
  if (!cache) return null;
  const entry = cache.find((e) => e.maskVersionDecimal === maskDecimal);
  if (!entry) return null;
  const candidates = entry.procedures.get(
    `${procedureType}:${procedureSubType}`,
  );
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.ops;
  const nonLegacy = candidates.find((c) => !c.isLegacy);
  const legacy = candidates.find((c) => c.isLegacy);
  if (preferLegacy && legacy) return legacy.ops;
  return (nonLegacy ?? legacy ?? candidates[0]!).ops;
}

/**
 * Splices an application program's declared steps (grouped by `mergeId`, as
 * `ets-app.ts`'s LoadProcedures parser extracts it) into the mask's ordered
 * op list at each `Merge` marker. Other mask ops pass through unchanged. A
 * `Merge` marker with no matching declared group contributes nothing -
 * matches ETS behavior for a program with no steps at that merge point.
 *
 * Steps with no `mergeId` are appended at the very end, past `Restart` -
 * visibly wrong rather than silently dropped or mistaken for a real
 * mid-sequence position.
 */
export function spliceAppSteps<T extends MaskProcedureAppStep>(
  maskOps: MaskOp[],
  appSteps: T[],
): MaskOp[] {
  const byMergeId = new Map<number, T[]>();
  const orphaned: T[] = [];
  for (const s of appSteps) {
    if (s.mergeId == null) {
      orphaned.push(s);
      continue;
    }
    const list = byMergeId.get(s.mergeId) ?? [];
    list.push(s);
    byMergeId.set(s.mergeId, list);
  }
  const result: MaskOp[] = [];
  const consumed = new Set<number>();
  for (const op of maskOps) {
    if (op.type === 'Merge') {
      const group = byMergeId.get(op.mergeId!) ?? [];
      consumed.add(op.mergeId!);
      result.push(...group);
      continue; // the Merge marker itself is never a real wire action
    }
    result.push(op);
  }
  for (const [mergeId, group] of byMergeId) {
    if (consumed.has(mergeId)) continue;
    result.push(...group);
  }
  if (orphaned.length) result.push(...orphaned);
  return result;
}

/**
 * Derives an ordering for one op kind (Unload/Load/WriteRelMem) from a
 * merged mask+app op list - the single source both download executors draw
 * their Unload/StartLoading/content-write ordering from, instead of
 * independent hand-picked sorts.
 *
 * `rankField` is which attribute the mask op declares this index under
 * (`LdCtrlUnload`/`LdCtrlLoad` carry `LsmIdx`; `LdCtrlWriteRelMem` carries
 * `ObjIdx`). `getJobKey` reads the matching numeric key off each job/step -
 * KNX Master Data's LsmIdx and ObjIdx numbering coincide for the four
 * relmem-style objects (1-4) the RelSegment executor uses, so that caller
 * always keys by `objIdx` regardless of `rankField`; the AbsSegment executor
 * keys by `lsmIdx` directly.
 *
 * Falls back to `fallbackCompare` (each executor's pre-existing ordering)
 * when `mergedOps` is `null`, or has no occurrence of this op kind for some
 * job's key - never silently drops an object from the sequence.
 */
export function orderByMergedOps<T>(
  jobs: T[],
  mergedOps: MaskOp[] | null,
  opType: 'Unload' | 'Load' | 'WriteRelMem',
  rankField: 'objIdx' | 'lsmIdx',
  getJobKey: (job: T) => number | undefined,
  fallbackCompare: (a: T, b: T) => number,
): T[] {
  if (!mergedOps) return [...jobs].sort(fallbackCompare);
  const rank = new Map<number, number>();
  let nextRank = 0;
  for (const op of mergedOps) {
    if (op.type !== opType) continue;
    const idx = op[rankField];
    if (idx == null || rank.has(idx)) continue;
    rank.set(idx, nextRank++);
  }
  if (
    jobs.some((j) => {
      const k = getJobKey(j);
      return k == null || !rank.has(k);
    })
  )
    return [...jobs].sort(fallbackCompare);
  return [...jobs].sort(
    (a, b) => rank.get(getJobKey(a)!)! - rank.get(getJobKey(b)!)!,
  );
}

/**
 * Which `ProcedureSubType` applies to a download session, derived from which
 * relmem-style objects the session touches (param object 4 vs. group
 * objects 1/2/3):
 *
 *  - param AND group active -> "all" (full mode) or "par,grp" (partial mode)
 *    - the KNX Master Data names for "everything gets touched".
 *  - param active only -> "par".
 *  - group active only -> "grp".
 *
 * A combination with neither active should never reach this function (the
 * caller's active-job check would already be empty).
 *
 * Only "all" is confirmed against a real capture (see
 * docs/knx-device-write-protocol.md); "grp"/"par"/"par,grp" are structurally
 * derived from the same mask XML but not separately live-tested.
 */
export function resolveProcedureSubType(
  paramActive: boolean,
  groupActive: boolean,
  mode: 'full' | 'partial',
): string | null {
  if (paramActive && groupActive) return mode === 'full' ? 'all' : 'par,grp';
  if (paramActive) return 'par';
  if (groupActive) return 'grp';
  return null;
}
