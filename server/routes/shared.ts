import path from 'path';
import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import type { DptInfoEntry } from '../../shared/types.ts';
import { logger } from '../log.ts';
import * as db from '../db.ts';

/** Max upload size for .knxproj / .knxprod / floor-plan files (200 MB). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// ── Per-project knx_master.xml ─────────────────────────────────────────────────
export const DATA_DIR = path.join(process.cwd(), 'data');
export const APPS_DIR = path.join(DATA_DIR, 'apps');
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

function masterXmlPath(projectId: string | number): string {
  return path.join(DATA_DIR, `knx_master_${projectId}.xml`);
}

export function saveMasterXml(
  projectId: string | number,
  xml: string | null | undefined,
): void {
  if (!xml) return;
  fs.writeFileSync(masterXmlPath(projectId), xml);
}

export function readMasterXml(
  projectId: string | number | null | undefined,
): string | null {
  if (!projectId) return null;
  const p = masterXmlPath(projectId);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// ── Cache value types ─────────────────────────────────────────────────────────
export interface SpaceUsageEntry {
  id: string;
  number: number;
  text: string;
}

export interface TranslationResult {
  languages: Array<{ id: string; name: string }>;
  translations: Record<string, Record<string, string>>;
}

export interface MaskVersionEntry {
  name: string;
  managementModel: string;
  medium: string;
}

// Caches keyed by projectId
const _dptInfoCache: Record<string | number, Record<string, DptInfoEntry>> = {};
export const _spaceUsageCache: Record<string | number, SpaceUsageEntry[]> = {};
export const _translationCache: Record<string | number, TranslationResult> = {};
export const _mediumTypeCache: Record<
  string | number,
  Record<string, string>
> = {};
export const _maskVersionCache: Record<
  string | number,
  Record<string, MaskVersionEntry>
> = {};

export const toArr = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export function parseMasterXml(xml: string): Record<string, unknown> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) =>
      [
        'DatapointType',
        'DatapointSubtype',
        'Float',
        'UnsignedInteger',
        'SignedInteger',
        'Enumeration',
        'EnumValue',
        'Bit',
        'MaskVersion',
        'Language',
        'TranslationUnit',
        'TranslationElement',
        'Translation',
        'SpaceUsage',
        'MediumType',
        'FunctionType',
        'FunctionPoint',
      ].includes(name),
  });
  return parser.parse(xml) as Record<string, unknown>;
}

interface XmlElement {
  [key: string]: unknown;
}

export function getDptInfo(
  projectId: string | number,
): Record<string, DptInfoEntry> {
  if (_dptInfoCache[projectId]) return _dptInfoCache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (_dptInfoCache[projectId] = {});
  const root = parseMasterXml(xml) as {
    KNX?: {
      MasterData?: { DatapointTypes?: { DatapointType?: XmlElement[] } };
    };
  };
  const dptTypes = root?.KNX?.MasterData?.DatapointTypes?.DatapointType ?? [];
  const result: Record<string, DptInfoEntry> = {};
  for (const dpt of dptTypes) {
    const mainNum = dpt['@_Number'] as string;
    const sizeInBit = parseInt(dpt['@_SizeInBit'] as string, 10) || 0;
    for (const sub of toArr(
      (dpt as { DatapointSubtypes?: { DatapointSubtype?: XmlElement[] } })
        ?.DatapointSubtypes?.DatapointSubtype,
    )) {
      const key = `${mainNum}.${String((sub as XmlElement)['@_Number']).padStart(3, '0')}`;
      const fmt = ((sub as XmlElement)?.Format ?? {}) as XmlElement;
      let unit = '';
      let enums: Record<number, string> | undefined;
      let coefficient: number | undefined;

      for (const tag of ['Float', 'UnsignedInteger', 'SignedInteger']) {
        const arr = toArr(fmt[tag] as XmlElement[] | XmlElement | null);
        if (arr.length) {
          unit = ((arr[0] as XmlElement)['@_Unit'] as string) || '';
          const coeff = (arr[0] as XmlElement)['@_Coefficient'];
          if (coeff) coefficient = parseFloat(coeff as string);
          break;
        }
      }

      const bits = toArr(fmt.Bit as XmlElement[] | XmlElement | null);
      if (bits.length) {
        const b = bits[0] as XmlElement;
        enums = {
          0: (b['@_Cleared'] as string) || '0',
          1: (b['@_Set'] as string) || '1',
        };
      }

      const enumEl = toArr(fmt.Enumeration as XmlElement[] | XmlElement | null);
      if (enumEl.length) {
        enums = {};
        for (const ev of toArr(
          (enumEl[0] as XmlElement).EnumValue as
            | XmlElement[]
            | XmlElement
            | null,
        )) {
          const e = ev as XmlElement;
          enums[Number(e['@_Value'])] =
            (e['@_Text'] as string) || String(e['@_Value']);
        }
      }

      result[key] = {
        name: ((sub as XmlElement)['@_Name'] as string) || '',
        text: ((sub as XmlElement)['@_Text'] as string) || '',
        unit,
        sizeInBit,
        ...(coefficient != null ? { coefficient } : {}),
        ...(enums ? { enums } : {}),
      };
    }
  }
  return (_dptInfoCache[projectId] = result);
}

export interface UpdateBuilder {
  track: (col: string, newVal: unknown) => void;
  sets: string[];
  vals: unknown[];
  diffs: string[];
}

export function makeUpdateBuilder<T extends object>(old: T): UpdateBuilder {
  const rec = old as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const diffs: string[] = [];
  const track = (col: string, newVal: unknown): void => {
    sets.push(`${col}=?`);
    vals.push(newVal);
    diffs.push(`${col}: "${rec[col] ?? ''}" → "${newVal}"`);
  };
  return { track, sets, vals, diffs };
}

// ── Pending-change tracking (device_pending_changes) ────────────────────────────
// Real request, 2026-09-01, replacing an earlier same-day design that read the
// device's current memory content and diffed it against the computed target:
// "I don't want to store a device memory cache. I want to log changes in our
// DB (e.g. by edits). That is all I am interested in." - see the table's own
// doc comment (db.ts) for the full data-model reasoning.
export interface PendingChangeInput {
  kind: string;
  key: string;
  oldVal: unknown;
  newVal: unknown;
}

// Upserts one (device, kind, key) row. `baseline_value` is set ONCE, from
// `oldVal`, the first time this key is edited since its last successful
// download - never overwritten by a later edit to the SAME key, so it always
// reflects "what this key held before any of today's pending edits", not
// "what it held before the most recent one". Real request, verbatim: "if
// user re-edits a previous change back to original value, we clear the
// tracking/undo modified status" - if a later edit's `newVal` matches that
// preserved baseline, the row is deleted outright rather than left as a
// stale no-op entry.
function trackPendingChange(
  deviceId: number,
  kind: string,
  key: string,
  oldVal: unknown,
  newVal: unknown,
): void {
  const oldJson = JSON.stringify(oldVal ?? null);
  const newJson = JSON.stringify(newVal ?? null);
  const existing = db.get<{ id: number; baseline_value: string }>(
    'SELECT id, baseline_value FROM device_pending_changes WHERE device_id=? AND kind=? AND key=?',
    [deviceId, kind, key],
  );
  if (existing) {
    if (newJson === existing.baseline_value) {
      db.run('DELETE FROM device_pending_changes WHERE id=?', [existing.id]);
    } else {
      db.run(
        "UPDATE device_pending_changes SET current_value=?, updated_at=datetime('now','localtime') WHERE id=?",
        [newJson, existing.id],
      );
    }
    return;
  }
  if (newJson === oldJson) return; // not a real change - nothing to track
  db.run(
    'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
    [deviceId, kind, key, oldJson, newJson],
  );
}

export function hasPendingChanges(deviceId: number): boolean {
  const row = db.get<{ c: number }>(
    'SELECT COUNT(*) as c FROM device_pending_changes WHERE device_id=?',
    [deviceId],
  );
  return !!row && row.c > 0;
}

/** All pending rows for a device - used by resolvePendingWriteRanges() (routes/bus.ts) to build a partial download's write set. */
export function getPendingChanges(
  deviceId: number,
): Array<{ kind: string; key: string }> {
  return db.all<{ kind: string; key: string }>(
    'SELECT kind, key FROM device_pending_changes WHERE device_id=?',
    [deviceId],
  );
}

// Called once a download (full or partial) actually completes - "log
// changes... until we have programmed successfully" (real request,
// verbatim). A download that throws/fails never reaches this, so pending
// rows correctly survive a failed attempt for the next try.
export function clearPendingChanges(deviceId: number): void {
  db.run('DELETE FROM device_pending_changes WHERE device_id=?', [deviceId]);
}

// Real request, 2026-08-31: editing a com object's flags/priority, GA
// links, or parameter values previously left the device's own PROGRAMMED/
// MODIFIED badge untouched - that badge (devices.status) was only ever
// written by an explicit Verify/Program call, so a local edit that a
// Verify hadn't yet run against sat silently unreflected in the UI. User
// feedback, verbatim: "If we make a change, we need to indicate this
// somehow" - waiting for a live Verify to reveal the drift isn't good
// enough; the moment we know a target diverges from the last-known-good
// state, the UI should say so. Called from every route that edits data
// feeding into a real device write (com-object flags, GA links, param
// values) right after it confirms a genuine change was made. Only flips
// 'programmed' -> 'modified' - 'unassigned'/other statuses are left alone
// (nothing to mark dirty if the device was never programmed in the first
// place), and it's a no-op (no audit spam) if the device is already
// 'modified'.
//
// Extended 2026-09-01, same real reasoning applied to the new persisted
// verify indicator: a manual edit invalidates whatever the last verify
// found, whether or not the status transition above actually fires (a
// device already 'modified' from an earlier edit can still carry a real
// last_verify_match from a verify that ran since - editing it again must
// still clear that). Real user instruction, verbatim: "Yes to clear last
// verify on each download AND if any changes made (edits) manually after
// verification." Unconditional (not gated on dev.status), since this
// function is only ever called after a caller has already confirmed a
// genuine change was made - the caller doesn't need to also predict
// whether a verify result exists first.
//
// Extended 2026-09-01: now also the single choke-point for pending-change
// tracking (device_pending_changes) - every caller below passes its own
// per-key before/after values here instead of tracking them itself.
// Real request, verbatim: "please build in logic such that if user re-edits
// a previous change back to original value, we clear the tracking/undo
// modified status" - this now handles BOTH directions, not just
// programmed->modified: if tracking the given changes leaves the device
// with zero pending rows (every outstanding edit has been reverted back to
// its own baseline), a 'modified' device reverts to 'programmed' too, with
// its own audit entry. Deliberately does NOT try to restore a previously-
// cleared last_verify_match on a revert - the right call, since
// verify describes a real bus round-trip; a net-zero edit
// history doesn't recreate the evidence a real Verify would have to
// provide fresh) - `verifyCleared` reports what happened in THIS call only.
//
// Returns the resulting status (for the frontend's SET_DEVICE_STATUS) and
// whether a verify result was actually cleared (for the frontend to also
// null out its own cached last_verify_match/last_verify_at without a
// separate reload).
export function markDeviceModifiedIfProgrammed(
  pid: number,
  deviceId: number,
  pendingChanges: PendingChangeInput[] = [],
): { status: string | null; verifyCleared: boolean } {
  const dev = db.get<{
    status: string;
    name: string;
    individual_address: string;
    last_verify_match: number | null;
  }>(
    'SELECT status, name, individual_address, last_verify_match FROM devices WHERE id=? AND project_id=?',
    [deviceId, pid],
  );
  if (!dev) return { status: null, verifyCleared: false };

  for (const c of pendingChanges) {
    trackPendingChange(deviceId, c.kind, c.key, c.oldVal, c.newVal);
  }

  const verifyCleared = dev.last_verify_match !== null;
  if (verifyCleared) {
    db.run(
      'UPDATE devices SET last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
      [deviceId],
    );
  }

  const stillPending = hasPendingChanges(deviceId);

  if (stillPending) {
    if (dev.status !== 'programmed') {
      return { status: dev.status, verifyCleared };
    }
    db.run('UPDATE devices SET status=? WHERE id=?', ['modified', deviceId]);
    db.audit(
      pid,
      'update',
      'device',
      dev.individual_address || String(deviceId),
      `status: "programmed" → "modified" on "${dev.name || deviceId}" (edited while programmed)`,
    );
    return { status: 'modified', verifyCleared };
  }

  // No pending changes remain - if THIS call's own tracking was what
  // brought the count to zero (every outstanding edit reverted to its own
  // baseline), undo the modified status. A device not currently 'modified'
  // (e.g. 'unassigned') is left alone, same as the forward direction above.
  if (dev.status === 'modified') {
    db.run('UPDATE devices SET status=? WHERE id=?', ['programmed', deviceId]);
    db.audit(
      pid,
      'update',
      'device',
      dev.individual_address || String(deviceId),
      `status: "modified" → "programmed" on "${dev.name || deviceId}" (all pending edits reverted to their last-downloaded values)`,
    );
    return { status: 'programmed', verifyCleared };
  }
  return { status: dev.status, verifyCleared };
}

export function saveModelsAndMasterXml(
  paramModels: Record<string, unknown> | null | undefined,
  knxMasterXml: string | null | undefined,
  projectId: string | number,
): void {
  if (paramModels) {
    for (const [appId, model] of Object.entries(paramModels)) {
      const safe = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        fs.writeFileSync(
          path.join(APPS_DIR, safe + '.json'),
          JSON.stringify(model),
        );
      } catch (e) {
        logger.warn('ets', `failed to write model ${safe}.json`, {
          error: (e as Error).message,
        });
      }
    }
  }
  if (knxMasterXml) saveMasterXml(projectId, knxMasterXml);
}
