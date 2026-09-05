import { createContext, useContext } from 'react';
import { normalizeDpt, dptInfo, dptToRefId, _i18nT } from './dpt.ts';
import type {
  DeviceStatus,
  ProjectFull,
  BusTelegram,
  Device,
} from '../../shared/types.ts';
import type { VerifyDeviceResult } from './api.ts';
import type { VerifyCacheEntry } from './state.ts';

export type DptMode = 'numeric' | 'formal' | 'friendly';

export const DptCtx = createContext<DptMode>('numeric');
export type PinFn = ((wtype: string, address: string) => void) | null;
export const PinContext = createContext<PinFn>(null);

/**
 * Three display modes for DPT:
 *   numeric  — "DPST-9-1"
 *   formal   — "DPT_Value_Temp"
 *   friendly — "temperature (°C)"
 * Hover shows the other two.
 */
export function useDpt(): {
  display: (raw: string | number) => string;
  hover: (raw: string | number) => string | undefined;
} {
  const mode = useContext(DptCtx);

  const formats = (raw: string | number) => {
    if (!raw) return { numeric: '', formal: '', friendly: '' };
    const norm = normalizeDpt(raw);
    const info = dptInfo(raw);
    const refId = dptToRefId(raw);
    const translated = refId && _i18nT(refId);

    const numeric = String(raw); // keep original format (e.g., "DPST-9-1" or "9.001")
    const formal = info.name || norm;
    const friendly = translated || info.text || '';
    return { numeric, formal, friendly };
  };

  return {
    display: (raw: string | number) => {
      if (!raw) return '—';
      const f = formats(raw);
      if (mode === 'formal') return f.formal || String(raw);
      if (mode === 'friendly') return f.friendly || f.formal || String(raw);
      return f.numeric;
    },
    hover: (raw: string | number) => {
      if (!raw) return undefined;
      const f = formats(raw);
      const parts: string[] = [];
      if (mode !== 'numeric') parts.push(f.numeric);
      if (mode !== 'formal') parts.push(f.formal);
      if (mode !== 'friendly' && f.friendly) parts.push(f.friendly);
      return parts.filter(Boolean).join(' — ') || undefined;
    },
  };
}

// ── Project actions context ──────────────────────────────────────────────────
export interface ProjectActions {
  updateGA: (gaId: number, patch: Record<string, unknown>) => Promise<void>;
  renameGAGroup: (
    main: number,
    middle: number | null | undefined,
    name: string,
  ) => Promise<void>;
  updateDevice: (
    deviceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  unassignDevice: (deviceId: number) => Promise<void>;
  updateSpace: (
    spaceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  createTopology: (body: Record<string, unknown>) => Promise<unknown>;
  updateTopology: (
    topoId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  deleteTopology: (topoId: number) => Promise<void>;
  createSpace: (body: Record<string, unknown>) => Promise<unknown>;
  deleteSpace: (spaceId: number) => Promise<void>;
  createGA: (body: Record<string, unknown>) => Promise<unknown>;
  deleteGA: (gaId: number) => Promise<void>;
  addDevice: (body: Record<string, unknown>) => Promise<unknown>;
  updateComObjectGAs: (coId: number, body: unknown) => Promise<void>;
  updateComObjectFlags: (coId: number, body: unknown) => Promise<void>;
  // Returns the created row (previously void) - real request 2026-08-31,
  // AddressDeviceModal's "add as if it were a new unassigned device": the
  // caller needs the new device's own id to chain a serial-number record
  // onto it right after creation. Existing callers that ignore the return
  // value (BusScanView.tsx) are unaffected.
  addScannedDevice: (address: string) => Promise<Device>;
  // Local-only store update (no API call - the caller already got this
  // status from a server response that persisted it, e.g.
  // api.saveParamValues's device_status field). Lets components outside
  // useProjectHandlers.ts (DeviceParameters.tsx) reflect a server-side
  // markDeviceModifiedIfProgrammed() flip immediately without a redundant
  // second PATCH /devices/:id/status round trip.
  applyDeviceStatus: (deviceId: number, status: string) => void;
  // Same local-only pattern, added 2026-09-01 for the persisted verify
  // indicator (server/db.ts's last_verify_match/last_verify_at) - see
  // applyDeviceStatus's own doc comment above.
  applyDeviceVerifyCleared: (deviceId: number) => void;
  // The other side - records a real verify outcome the server already
  // persisted (see runVerifyDevice(), server/routes/bus.ts).
  applyDeviceVerifyResult: (deviceId: number, match: boolean) => void;
}

export const ProjectActionsCtx = createContext<ProjectActions | null>(null);

export function useProjectActions(): ProjectActions {
  const ctx = useContext(ProjectActionsCtx);
  if (!ctx)
    throw new Error('useProjectActions must be used within ProjectActionsCtx');
  return ctx;
}

// ── Bus actions context ──────────────────────────────────────────────────────
export interface BusActions {
  connect: (
    host: string,
    port: number,
    protocol?: 'udp' | 'tcp' | 'auto',
  ) => Promise<unknown>;
  connectUsb: (devicePath: string) => Promise<unknown>;
  disconnect: () => Promise<void>;
  deviceStatus: (deviceId: number, status: DeviceStatus) => Promise<void>;
  write: (ga: string, value: unknown, dpt: unknown) => Promise<void>;
  clearTelegrams: () => Promise<void>;
  // Tells the backend this client is actively watching live telegrams, so
  // it should proactively reconnect the bus across a gateway idle-timeout
  // drop rather than leaving recovery to the next bus operation - see
  // KnxBusManager.addKeepAliveRef(). Call watchStart() on mount and
  // watchStop() on unmount (BusMonitorView does this).
  watchStart: () => void;
  watchStop: () => void;
}

export const BusActionsCtx = createContext<BusActions | null>(null);

export function useBusActions(): BusActions {
  const ctx = useContext(BusActionsCtx);
  if (!ctx) throw new Error('useBusActions must be used within BusActionsCtx');
  return ctx;
}

// ── Undo context ─────────────────────────────────────────────────────────────
export interface UndoActions {
  undoStackRef: React.MutableRefObject<
    { desc: string; detail: string; undo: () => Promise<void> }[]
  >;
  undoCount: number;
  undoOpen: boolean;
  setUndoOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  performUndo: (count?: number) => Promise<void>;
  toast: string | null;
  setToast: (v: string | null) => void;
}

export const UndoCtx = createContext<UndoActions | null>(null);

export function useUndo(): UndoActions {
  const ctx = useContext(UndoCtx);
  if (!ctx) throw new Error('useUndo must be used within UndoCtx');
  return ctx;
}

// ── App data contexts (split to avoid re-renders) ──────────────────────────
// ProjectData changes on project load/edit — relatively infrequent.
// LiveData changes on every telegram/bus event — high frequency on active bus.
// Views that only need project data subscribe to AppDataCtx and won't
// re-render when telegrams arrive.

export interface BusStatus {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
}

export interface AppData {
  projectData: ProjectFull | null;
  activeProjectId: number | null;
}

export const AppDataCtx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const ctx = useContext(AppDataCtx);
  if (!ctx) throw new Error('useAppData must be used within AppDataCtx');
  return ctx;
}

export interface LiveData {
  busStatus: BusStatus;
  telegrams: BusTelegram[];
}

export const LiveDataCtx = createContext<LiveData | null>(null);

export function useLiveData(): LiveData {
  const ctx = useContext(LiveDataCtx);
  if (!ctx) throw new Error('useLiveData must be used within LiveDataCtx');
  return ctx;
}

// ── Verify-result cache — shared across every view that can trigger a
// /bus/verify-device call (Programming's "Verify" button, the Device vs
// Project comparison page), keyed by device id, so switching devices or
// views reuses the last real read instead of forcing a fresh ~2-minute bus
// read. Callers decide when to force a refresh (e.g. an explicit button).
export interface VerifyProgress {
  bytesRead: number;
  totalBytes: number;
  pct: number;
}

// Real, granular progress for an in-flight Program (write) action - the
// server has broadcast this over WebSocket (program:progress) all along
// (see server/routes/bus.ts's onProgress / knx-connection.ts's
// DownloadProgress), but the client never listened for it, faking its own
// progress instead (a setInterval climbing to a hardcoded 90% cap,
// completely disconnected from the real write - found live 2026-08-29:
// "shows 90% and then sits there for a few minutes" is exactly that fake
// climb hitting its cap while the real, much slower write continues
// underneath it). `pct` here is real: 0-80% tracks actual bytes written
// during the memory-write loop, the remaining steps (LoadCompleted,
// PID_PROGRAM_VERSION write-back, Restart) take it to 100.
export interface ProgramProgress {
  msg: string;
  pct?: number;
  done?: boolean;
  error?: boolean;
  // Real request, 2026-08-31: mirrors DownloadProgress.awaitingButton
  // (server/knx-connection.ts) - true only on the single message
  // announcing /bus/program-device's own "waiting for the programming
  // button" pre-flight wait; the client's cue to show a dedicated modal.
  awaitingButton?: boolean;
}

export interface VerifyCache {
  cache: Record<number, VerifyCacheEntry>;
  setResult: (deviceId: number, result: VerifyDeviceResult) => void;
  // Forgets a device's cached verify result (both in-memory and the
  // IndexedDB copy, via the same save effect that persists every other
  // verifyCache change). No equivalent "clear everything" - deliberately
  // per-device only, see the Programming page's row-level clear button.
  clearResult: (deviceId: number) => void;
  // Live progress while a verify read is in flight, keyed by device
  // *address* (progress events only carry the address, not the id) - not
  // persisted like `cache`, just transient UI state updated from the
  // verify:progress WebSocket messages a verify-device call now broadcasts.
  progress: Record<string, VerifyProgress>;
  // Same idea, for an in-flight Program (write) action - see
  // ProgramProgress's own doc comment above for why this exists now.
  programProgress: Record<string, ProgramProgress>;
  // Forgets a device's live program-progress entry (both the raw pct/msg
  // and, via ProgrammingView's own reset, the "never move backward" max
  // tracker). Call this when a NEW program run starts for a device -
  // otherwise a device that previously finished at 100% carries that
  // stale entry into the next run, where the ratchet immediately clamps
  // the fresh 0% right back up to it before any real new message arrives,
  // and stays stuck there for the whole download.
  clearProgramProgress: (deviceAddress: string) => void;
}

export const VerifyCacheCtx = createContext<VerifyCache | null>(null);

export function useVerifyCache(): VerifyCache {
  const ctx = useContext(VerifyCacheCtx);
  if (!ctx)
    throw new Error('useVerifyCache must be used within VerifyCacheCtx');
  return ctx;
}

// ── Programming page's operation log — lifted out of ProgrammingView's own
// state so it survives navigating away and back (that page previously reset
// its log to [] on every remount). In-memory only, not localStorage - a real
// page reload still clears it like everything else in the app, this just
// stops navigation between routes from doing the same thing. Capped at
// PROGRAMMING_LOG_CAP entries (oldest dropped) so a long-running session
// doesn't grow this unbounded; no time-based expiry, since the cap plus the
// natural reset on reload is enough for how this log is actually used.
export const PROGRAMMING_LOG_CAP = 300;

export interface ProgrammingLog {
  entries: string[];
  add: (line: string) => void;
  clear: () => void;
  // Real request, 2026-09-01: the write-service-resolution work added a
  // lot of low-level protocol detail to the log (per-step Unload/
  // StartLoading/WriteProp/mask-resolution messages etc.) - genuinely
  // useful for debugging, too much for a normal operator just watching a
  // download happen. Server-tagged messages (DownloadProgress.debug, see
  // knx-connection.ts) are filtered out of `entries` at the source
  // (App.tsx's program:progress handler) when this is false, not just
  // hidden at render time - toggling it doesn't retroactively reveal
  // messages from before it was turned on. Persisted (localStorage,
  // per-browser) like theme/dptMode, not the server-side `settings`
  // table - this is a personal display preference, not a shared
  // workflow-behavior default.
  showDebug: boolean;
  toggleShowDebug: () => void;
}

export const ProgrammingLogCtx = createContext<ProgrammingLog | null>(null);

export function useProgrammingLog(): ProgrammingLog {
  const ctx = useContext(ProgrammingLogCtx);
  if (!ctx)
    throw new Error('useProgrammingLog must be used within ProgrammingLogCtx');
  return ctx;
}
