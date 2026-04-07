// ── App state reducer ─────────────────────────────────────────────────────────

import { buildGAMaps } from '../../shared/ga-maps.ts';
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

interface NavEntry {
  view: string;
  activePinKey: string | null;
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

interface ScanState {
  results: ScanResult[];
  running: boolean;
  progress: ScanProgress | null;
}

interface BusStatus {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
}

export interface AppState {
  projects: Project[];
  activeProjectId: number | null;
  projectData: ProjectFull | null;
  busStatus: BusStatus;
  telegrams: BusTelegram[];
  view: string;
  loading: boolean;
  error: string | null;
  windows: WindowEntry[];
  activePinKey: string | null;
  scan: ScanState;
  navHistory: NavEntry[];
  navIndex: number;
  deviceJumpTo?: { address: string; ts: number };
  gaJumpTo?: { main_g: number; middle_g: number | null; ts: number };
  catalogJumpTo?: { manufacturer: string; ts: number };
  floorplanJumpTo?: { spaceId: number; ts: number };
}

export const initialState: AppState = {
  projects: [],
  activeProjectId: null,
  projectData: null,
  busStatus: { connected: false, host: null, hasLib: false },
  telegrams: [],
  view: 'projects',
  loading: false,
  error: null,
  windows: [],
  activePinKey: null,
  scan: { results: [], running: false, progress: null },
  navHistory: [{ view: 'projects', activePinKey: null }],
  navIndex: 0,
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
  | { type: 'SET_ACTIVE'; id: number; data: ProjectFull; view?: string }
  | { type: 'SET_VIEW'; view: string }
  | { type: 'GRAPH_JUMP' }
  | { type: 'DEVICE_JUMP'; address: string }
  | { type: 'GA_GROUP_JUMP'; main_g: number; middle_g?: number | null }
  | { type: 'CATALOG_JUMP'; manufacturer: string }
  | { type: 'FLOORPLAN_JUMP'; spaceId: number }
  | { type: 'SET_BUS'; status: BusStatus }
  | { type: 'ADD_TELEGRAM'; telegram: BusTelegram }
  | { type: 'SET_TELEGRAMS'; telegrams: BusTelegram[] }
  | { type: 'PIN_VIEW'; key: string }
  | { type: 'OPEN_WINDOW'; wtype: string; address: string }
  | { type: 'NAV_BACK' }
  | { type: 'NAV_FORWARD' }
  | { type: 'CLOSE_WINDOW'; key: string }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | {
      type: 'PATCH_PROJECT';
      patch: Partial<ProjectFull> & Record<string, unknown>;
    }
  | { type: 'SET_DEVICE_STATUS'; deviceId: number; status: DeviceStatus }
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
  | { type: 'SCAN_RESET' };

// Push a navigation entry, truncating any forward history
export function pushNav(state: AppState, entry: NavEntry): Partial<AppState> {
  const cur = state.navHistory[state.navIndex];
  if (
    cur?.view === entry.view &&
    cur?.activePinKey === (entry.activePinKey ?? null)
  )
    return {};
  const hist = [...state.navHistory.slice(0, state.navIndex + 1), entry];
  return { navHistory: hist, navIndex: hist.length - 1 };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };
    case 'DPT_LOADED':
      return { ...state }; // triggers re-render so DPT_INFO is used
    case 'SET_ACTIVE': {
      const targetView = action.view || 'locations';
      const nav = pushNav(state, { view: targetView, activePinKey: null });
      return {
        ...state,
        activeProjectId: action.id,
        projectData: action.data,
        view: targetView,
        windows: loadWindows(action.id),
        activePinKey: null,
        ...nav,
      };
    }
    case 'SET_VIEW': {
      const nav = pushNav(state, {
        view: action.view,
        activePinKey: action.view === 'pin' ? state.activePinKey : null,
      });
      return { ...state, view: action.view, ...nav };
    }
    case 'GRAPH_JUMP': {
      const nav = pushNav(state, { view: 'topology', activePinKey: null });
      return { ...state, view: 'topology', ...nav };
    }
    case 'DEVICE_JUMP': {
      const jt = { address: action.address, ts: Date.now() };
      const nav = pushNav(state, { view: 'devices', activePinKey: null });
      return { ...state, view: 'devices', deviceJumpTo: jt, ...nav };
    }
    case 'GA_GROUP_JUMP': {
      const jt = {
        main_g: action.main_g,
        middle_g: action.middle_g ?? null,
        ts: Date.now(),
      };
      const nav = pushNav(state, { view: 'groups', activePinKey: null });
      return { ...state, view: 'groups', gaJumpTo: jt, ...nav };
    }
    case 'CATALOG_JUMP': {
      const nav = pushNav(state, { view: 'catalog', activePinKey: null });
      return {
        ...state,
        view: 'catalog',
        catalogJumpTo: { manufacturer: action.manufacturer, ts: Date.now() },
        ...nav,
      };
    }
    case 'FLOORPLAN_JUMP': {
      const nav = pushNav(state, { view: 'floorplan', activePinKey: null });
      return {
        ...state,
        view: 'floorplan',
        floorplanJumpTo: { spaceId: action.spaceId, ts: Date.now() },
        ...nav,
      };
    }
    case 'SET_BUS':
      return { ...state, busStatus: action.status };
    case 'ADD_TELEGRAM':
      return {
        ...state,
        telegrams: [action.telegram, ...state.telegrams].slice(0, 500),
      };
    case 'SET_TELEGRAMS':
      return { ...state, telegrams: action.telegrams };
    case 'PIN_VIEW': {
      const nav = pushNav(state, { view: 'pin', activePinKey: action.key });
      return { ...state, view: 'pin', activePinKey: action.key, ...nav };
    }
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
      const nav = pushNav(state, { view: 'pin', activePinKey: key });
      return {
        ...state,
        windows: next,
        view: 'pin',
        activePinKey: key,
        ...nav,
      };
    }
    case 'NAV_BACK': {
      if (state.navIndex <= 0) return state;
      const idx = state.navIndex - 1;
      const e = state.navHistory[idx]!;
      return {
        ...state,
        navIndex: idx,
        view: e.view,
        activePinKey: e.activePinKey ?? null,
      };
    }
    case 'NAV_FORWARD': {
      if (state.navIndex >= state.navHistory.length - 1) return state;
      const idx = state.navIndex + 1;
      const e = state.navHistory[idx]!;
      return {
        ...state,
        navIndex: idx,
        view: e.view,
        activePinKey: e.activePinKey ?? null,
      };
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
    default:
      return state;
  }
}
