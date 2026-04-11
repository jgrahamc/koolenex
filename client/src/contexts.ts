import { createContext, useContext } from 'react';
import { normalizeDpt, dptInfo, dptToRefId, _i18nT } from './dpt.ts';
import type { DeviceStatus } from '../../shared/types.ts';

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
  addScannedDevice: (address: string) => Promise<void>;
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
  connect: (host: string, port: number) => Promise<unknown>;
  connectUsb: (devicePath: string) => Promise<unknown>;
  disconnect: () => Promise<void>;
  deviceStatus: (deviceId: number, status: DeviceStatus) => Promise<void>;
  write: (ga: string, value: unknown, dpt: unknown) => Promise<void>;
  clearTelegrams: () => Promise<void>;
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
