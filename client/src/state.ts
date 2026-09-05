// ── App state reducer ─────────────────────────────────────────────────────────

import { buildGAMaps } from '../../shared/ga-maps.ts';
import type { ImportSummary, VerifyDeviceResult } from './api.ts';
import type {
  Project,
  Device,
  EnrichedGA,
  ComObjectWithDevice,
  Space,
  Topology,
  ProjectFull,
  BusTelegram,
  DeviceStatus,
} from '../../shared/types.ts';

interface WindowEntry {
  key: string;
  wtype: string;
  address: string;
}

export const loadWindows = (pid: number | null): WindowEntry[] => {
  try {
    return JSON.parse(
      localStorage.getItem(pid ? `knx-windows-${pid}` : 'knx-windows') || '[]',
    );
  } catch {
    return [];
  }
};
export const saveWindows = (pid: number | null, w: WindowEntry[]): void => {
  try {
    localStorage.setItem(
      pid ? `knx-windows-${pid}` : 'knx-windows',
      JSON.stringify(w),
    );
  } catch {}
};

// Verify-device results (Programming's "Verify" button, the Device vs
// Project comparison page) persisted across reloads - a relmem read takes
// up to ~2 minutes, so losing it to a page refresh is worth avoiding. Each
// entry already carries its own fetchedAt so staleness stays visible
// ("cached · read Xm ago") regardless of storage lifetime.
//
// Uses IndexedDB, not localStorage: a single device's decoded result is
// routinely >1MB (confirmed empirically - a full relmem decode came to
// ~1.4MB), and localStorage's ~5MB-per-origin quota was silently exceeded
// with just a couple of devices cached (writes failed inside a swallowed
// try/catch, so the cache appeared to "never persist" with no visible
// error). IndexedDB's quota is effectively hundreds of MB, more than
// sufficient here.
const VERIFY_DB_NAME = 'knx-verify-cache';
const VERIFY_STORE = 'results';
const VERIFY_DB_KEY = 'all'; // one record holding the whole cache map

function openVerifyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VERIFY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VERIFY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadVerifyCache(): Promise<
  Record<number, VerifyCacheEntry>
> {
  try {
    const db = await openVerifyDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(VERIFY_STORE, 'readonly');
      const req = tx.objectStore(VERIFY_STORE).get(VERIFY_DB_KEY);
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => resolve({});
    });
  } catch {
    return {};
  }
}

export async function saveVerifyCache(
  cache: Record<number, VerifyCacheEntry>,
): Promise<void> {
  try {
    const db = await openVerifyDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(VERIFY_STORE, 'readwrite');
      tx.objectStore(VERIFY_STORE).put(cache, VERIFY_DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}

interface ScanProgress {
  address?: string;
  descriptor?: string;
  reachable?: boolean;
  done?: number;
  total?: number;
}

interface ScanResult {
  address: string;
  descriptor: string;
}

export interface ScanState {
  results: ScanResult[];
  running: boolean;
  progress: ScanProgress | null;
}

export type ImportClientStatus =
  | 'idle'
  | 'uploading'
  | 'parsing'
  | 'password-required'
  | 'done'
  | 'failed';

export interface ImportState {
  importId: string | null;
  mode: 'import' | 'reimport' | null;
  fileName: string | null;
  status: ImportClientStatus;
  projectId: number | null;
  summary: ImportSummary | null;
  error: string | null;
  passwordRetry: boolean;
}

const IMPORT_LS_KEY = 'knx-active-import';
const persistImportId = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(IMPORT_LS_KEY, id);
    else localStorage.removeItem(IMPORT_LS_KEY);
  } catch {}
};

interface BusStatus {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
  // Distinguishes a calm "not connected, nothing needs it right now" idle
  // state from a genuine "this needs manual attention" one (wrong IP,
  // router down, etc.) - real request 2026-08-31. Absent/false by default
  // on every real SET_BUS (a fresh disconnect is assumed calm first - "if
  // auto-reconnect is possible, go to idle" - only escalated by a separate
  // SET_BUS_ATTENTION dispatch once a reconnect attempt genuinely fails).
  // See AppShell.tsx's connection badge and knx-bus.ts's
  // 'knx:reconnect-failed' broadcast.
  needsAttention?: boolean;
}

export interface VerifyCacheEntry {
  result: VerifyDeviceResult;
  // The last REAL bus read - never touched by RECOMPUTE_VERIFY_RESULT (see
  // below), only by a genuine /bus/verify-device round trip.
  fetchedAt: number;
  // Set only by RECOMPUTE_VERIFY_RESULT (never by SET_VERIFY_RESULT, a
  // real read, which clears it back to undefined) - the last time the
  // PROJECT/expected side was locally recomputed against fresh DB state
  // without a new device read, added 2026-08-31 (see the matching
  // reasoning in server/routes/bus.ts's /bus/verify-device/recompute).
  // Lets the UI say "recomputed just now, device last read 5m ago"
  // honestly, instead of implying a fresh bus round trip happened.
  recomputedAt?: number;
}

export interface AppState {
  projects: Project[];
  activeProjectId: number | null;
  projectData: ProjectFull | null;
  busStatus: BusStatus;
  telegrams: BusTelegram[];
  loading: boolean;
  error: string | null;
  windows: WindowEntry[];
  scan: ScanState;
  import: ImportState;
  // Last /bus/verify-device result per device id, shared across every view
  // that can trigger a verify (Programming's "Verify" button, the Device vs
  // Project comparison page) so re-selecting a device doesn't force a fresh
  // ~2-minute bus read unless explicitly requested.
  verifyCache: Record<number, VerifyCacheEntry>;
}

const initialImportState: ImportState = {
  importId: null,
  mode: null,
  fileName: null,
  status: 'idle',
  projectId: null,
  summary: null,
  error: null,
  passwordRetry: false,
};

export const initialState: AppState = {
  projects: [],
  activeProjectId: null,
  projectData: null,
  busStatus: { connected: false, host: null, hasLib: false },
  telegrams: [],
  loading: false,
  error: null,
  windows: [],
  scan: { results: [], running: false, progress: null },
  import: initialImportState,
  verifyCache: {},
};

export const GROUP_WTYPES = {
  manufacturer: { field: 'manufacturer', label: 'MANUFACTURER' },
  model: { field: 'model', label: 'MODEL' },
  order_number: { field: 'order_number', label: 'ORDER #' },
} as const;

// ── Action discriminated union ───────────────────────────────────────────────

export type Action =
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'DPT_LOADED' }
  | { type: 'SET_ACTIVE'; id: number; data: ProjectFull }
  | { type: 'SET_BUS'; status: BusStatus }
  | { type: 'SET_BUS_ATTENTION'; needsAttention: boolean }
  | { type: 'ADD_TELEGRAM'; telegram: BusTelegram }
  | { type: 'SET_TELEGRAMS'; telegrams: BusTelegram[] }
  | { type: 'OPEN_WINDOW'; wtype: string; address: string }
  | { type: 'CLOSE_WINDOW'; key: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | {
      type: 'PATCH_PROJECT';
      patch: Partial<ProjectFull> & Record<string, unknown>;
    }
  | { type: 'SET_DEVICE_STATUS'; deviceId: number; status: DeviceStatus }
  | {
      type: 'SET_VERIFY_RESULT';
      deviceId: number;
      result: VerifyDeviceResult;
    }
  | {
      // Local recompute (no bus access) - see VerifyCacheEntry.recomputedAt's
      // doc comment. No-ops (like CLEAR_VERIFY_RESULT already does) if
      // there's no cache entry for this device to recompute against.
      type: 'RECOMPUTE_VERIFY_RESULT';
      deviceId: number;
      result: VerifyDeviceResult;
    }
  | {
      type: 'HYDRATE_VERIFY_CACHE';
      cache: Record<number, VerifyCacheEntry>;
    }
  | { type: 'CLEAR_VERIFY_RESULT'; deviceId: number }
  | { type: 'PATCH_DEVICE'; id: number; patch: Partial<Device> }
  | { type: 'PATCH_GA'; id: number; patch: Partial<EnrichedGA> }
  | {
      type: 'RENAME_GA_GROUP';
      field: 'main_group_name' | 'middle_group_name';
      main_g: number;
      middle_g?: number;
      name: string;
    }
  | { type: 'PATCH_SPACE'; id: number; patch: Partial<Space> }
  | { type: 'ADD_SPACE'; space: Space }
  | { type: 'DELETE_SPACE'; id: number; newParentId: number | null }
  | { type: 'ADD_TOPOLOGY'; entry: Topology }
  | { type: 'PATCH_TOPOLOGY'; id: number; patch: Partial<Topology> }
  | { type: 'DELETE_TOPOLOGY'; id: number }
  | { type: 'DELETE_GA'; id: number }
  | { type: 'ADD_GA'; ga: EnrichedGA }
  | { type: 'ADD_DEVICE'; device: Device }
  | { type: 'DELETE_DEVICE'; id: number }
  | {
      type: 'PATCH_COMOBJECT';
      id: number;
      patch: Partial<ComObjectWithDevice>;
    }
  | { type: 'SCAN_PROGRESS'; progress: ScanProgress }
  | { type: 'SCAN_DONE'; results: ScanResult[] }
  | { type: 'SCAN_RESET' }
  | { type: 'IMPORT_RESET' }
  | {
      type: 'IMPORT_UPLOADING';
      mode: 'import' | 'reimport';
      fileName: string;
    }
  | {
      type: 'IMPORT_STARTED';
      importId: string;
      mode: 'import' | 'reimport';
      fileName: string;
    }
  | {
      type: 'IMPORT_PASSWORD_REQUIRED';
      importId: string;
      retry: boolean;
    }
  | {
      type: 'IMPORT_PARSING';
      importId: string;
    }
  | {
      type: 'IMPORT_DONE';
      importId: string;
      projectId: number;
      summary: ImportSummary;
    }
  | {
      type: 'IMPORT_FAILED';
      importId: string;
      error: string;
      code?: string;
    };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };
    case 'DPT_LOADED':
      return { ...state }; // triggers re-render so DPT_INFO is used
    case 'SET_ACTIVE': {
      return {
        ...state,
        activeProjectId: action.id,
        projectData: action.data,
        windows: loadWindows(action.id),
      };
    }
    case 'SET_BUS':
      return { ...state, busStatus: action.status };
    // Merges rather than replaces (unlike SET_BUS) - a 'knx:reconnect-failed'
    // WS message only carries the fact that a reconnect attempt failed, not
    // a full bus status snapshot; overwriting busStatus wholesale here
    // would clobber connected/host with whatever the action didn't specify.
    case 'SET_BUS_ATTENTION':
      return {
        ...state,
        busStatus: { ...state.busStatus, needsAttention: action.needsAttention },
      };
    case 'ADD_TELEGRAM':
      return {
        ...state,
        telegrams: [action.telegram, ...state.telegrams].slice(0, 500),
      };
    case 'SET_TELEGRAMS':
      return { ...state, telegrams: action.telegrams };
    case 'OPEN_WINDOW': {
      const key = `${action.wtype}:${action.address}`;
      const exists = state.windows.find((w) => w.key === key);
      const next = exists
        ? state.windows
        : [
            ...state.windows,
            { key, wtype: action.wtype, address: action.address },
          ];
      if (!exists) saveWindows(state.activeProjectId, next);
      return { ...state, windows: next };
    }
    case 'CLOSE_WINDOW': {
      const next = state.windows.filter((w) => w.key !== action.key);
      saveWindows(state.activeProjectId, next);
      return { ...state, windows: next };
    }
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'PATCH_PROJECT':
      return {
        ...state,
        projectData: state.projectData
          ? { ...state.projectData, ...action.patch }
          : state.projectData,
      };
    case 'SET_VERIFY_RESULT':
      return {
        ...state,
        verifyCache: {
          ...state.verifyCache,
          // A genuine new read - clears any stale recomputedAt from a
          // prior local recompute rather than carrying it forward.
          [action.deviceId]: { result: action.result, fetchedAt: Date.now() },
        },
      };
    case 'RECOMPUTE_VERIFY_RESULT': {
      const prior = state.verifyCache[action.deviceId];
      if (!prior) return state; // nothing cached to recompute against
      return {
        ...state,
        verifyCache: {
          ...state.verifyCache,
          [action.deviceId]: {
            result: action.result,
            fetchedAt: prior.fetchedAt, // the real device read time - unchanged
            recomputedAt: Date.now(),
          },
        },
      };
    }
    case 'HYDRATE_VERIFY_CACHE':
      // Loading from IndexedDB is async, so this lands after mount - merge
      // rather than overwrite in case a verify somehow completed first.
      return {
        ...state,
        verifyCache: { ...action.cache, ...state.verifyCache },
      };
    case 'CLEAR_VERIFY_RESULT': {
      const { [action.deviceId]: _drop, ...rest } = state.verifyCache;
      return { ...state, verifyCache: rest };
    }
    case 'SET_DEVICE_STATUS': {
      if (!state.projectData) return state;
      const devices = state.projectData.devices.map((d) =>
        d.id === action.deviceId ? { ...d, status: action.status } : d,
      );
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_DEVICE': {
      if (!state.projectData) return state;
      const devices = state.projectData.devices.map((d) =>
        d.id === action.id ? { ...d, ...action.patch } : d,
      );
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_GA': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.map((g) =>
        g.id === action.id ? { ...g, ...action.patch } : g,
      );
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'RENAME_GA_GROUP': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.map((g) => {
        if (action.field === 'main_group_name' && g.main_g === action.main_g)
          return { ...g, main_group_name: action.name };
        if (
          action.field === 'middle_group_name' &&
          g.main_g === action.main_g &&
          g.middle_g === action.middle_g
        )
          return { ...g, middle_group_name: action.name };
        return g;
      });
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'PATCH_SPACE': {
      if (!state.projectData) return state;
      const spaces = state.projectData.spaces.map((s) =>
        s.id === action.id ? { ...s, ...action.patch } : s,
      );
      return { ...state, projectData: { ...state.projectData, spaces } };
    }
    case 'ADD_SPACE': {
      if (!state.projectData) return state;
      const spaces = [...state.projectData.spaces, action.space];
      return { ...state, projectData: { ...state.projectData, spaces } };
    }
    case 'DELETE_SPACE': {
      if (!state.projectData) return state;
      const spaces = state.projectData.spaces
        .filter((s) => s.id !== action.id)
        .map((s) =>
          s.parent_id === action.id
            ? { ...s, parent_id: action.newParentId }
            : s,
        );
      const devices = state.projectData.devices.map((d) =>
        d.space_id === action.id ? { ...d, space_id: null } : d,
      );
      return {
        ...state,
        projectData: { ...state.projectData, spaces, devices },
      };
    }
    case 'ADD_TOPOLOGY': {
      if (!state.projectData) return state;
      const topology = [...(state.projectData.topology || []), action.entry];
      return { ...state, projectData: { ...state.projectData, topology } };
    }
    case 'PATCH_TOPOLOGY': {
      if (!state.projectData) return state;
      const topology = (state.projectData.topology || []).map((t) =>
        t.id === action.id ? { ...t, ...action.patch } : t,
      );
      return { ...state, projectData: { ...state.projectData, topology } };
    }
    case 'DELETE_TOPOLOGY': {
      if (!state.projectData) return state;
      const topology = (state.projectData.topology || []).filter(
        (t) => t.id !== action.id,
      );
      return { ...state, projectData: { ...state.projectData, topology } };
    }
    case 'DELETE_GA': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.filter((g) => g.id !== action.id);
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'ADD_GA': {
      if (!state.projectData) return state;
      const ga = {
        ...action.ga,
        devices: [],
      };
      const gas = [...state.projectData.gas, ga].sort(
        (a, b) =>
          a.main_g - b.main_g ||
          a.middle_g - b.middle_g ||
          (a.sub_g ?? -1) - (b.sub_g ?? -1),
      );
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'ADD_DEVICE': {
      if (!state.projectData) return state;
      const devices = [...state.projectData.devices, action.device];
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'DELETE_DEVICE': {
      if (!state.projectData) return state;
      const devices = state.projectData.devices.filter(
        (d) => d.id !== action.id,
      );
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_COMOBJECT': {
      if (!state.projectData) return state;
      const comObjects = state.projectData.comObjects.map((co) =>
        co.id === action.id ? { ...co, ...action.patch } : co,
      );
      const { deviceGAMap, gaDeviceMap } = buildGAMaps(comObjects);
      // Update GA device counts
      const gas = (state.projectData.gas || []).map((g) => ({
        ...g,
        devices: gaDeviceMap[g.address] || [],
      }));
      return {
        ...state,
        projectData: {
          ...state.projectData,
          comObjects,
          deviceGAMap,
          gaDeviceMap,
          gas,
        },
      };
    }
    case 'SCAN_PROGRESS': {
      const prog = action.progress;
      const results = prog.reachable
        ? [
            ...state.scan.results,
            {
              address: prog.address ?? '',
              descriptor: prog.descriptor ?? '',
            },
          ]
        : state.scan.results;
      return {
        ...state,
        scan: { ...state.scan, running: true, progress: prog, results },
      };
    }
    case 'SCAN_DONE':
      return {
        ...state,
        scan: { results: action.results, running: false, progress: null },
      };
    case 'SCAN_RESET':
      return {
        ...state,
        scan: { results: [], running: false, progress: null },
      };
    case 'IMPORT_RESET':
      persistImportId(null);
      return { ...state, import: initialImportState };
    case 'IMPORT_UPLOADING':
      return {
        ...state,
        import: {
          ...initialImportState,
          mode: action.mode,
          fileName: action.fileName,
          status: 'uploading',
        },
      };
    case 'IMPORT_STARTED':
      persistImportId(action.importId);
      return {
        ...state,
        import: {
          ...state.import,
          importId: action.importId,
          mode: action.mode,
          fileName: action.fileName || state.import.fileName,
          status: 'parsing',
          error: null,
          passwordRetry: false,
        },
      };
    case 'IMPORT_PARSING':
      if (state.import.importId !== action.importId) return state;
      return {
        ...state,
        import: { ...state.import, status: 'parsing', error: null },
      };
    case 'IMPORT_PASSWORD_REQUIRED':
      // Accept the event even if importId doesn't match — recovery flow
      return {
        ...state,
        import: {
          ...state.import,
          importId: action.importId,
          status: 'password-required',
          passwordRetry: action.retry,
        },
      };
    case 'IMPORT_DONE':
      persistImportId(null);
      return {
        ...state,
        import: {
          ...state.import,
          importId: action.importId,
          status: 'done',
          projectId: action.projectId,
          summary: action.summary,
          error: null,
        },
      };
    case 'IMPORT_FAILED':
      persistImportId(null);
      return {
        ...state,
        import: {
          ...state.import,
          importId: action.importId,
          status: 'failed',
          error: action.error,
        },
      };
    default:
      return state;
  }
}
