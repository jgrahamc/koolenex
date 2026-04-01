// ── App state reducer ─────────────────────────────────────────────────────────

export const loadWindows = (pid) => { try { return JSON.parse(localStorage.getItem(pid ? `knx-windows-${pid}` : 'knx-windows') || '[]'); } catch { return []; } };
export const saveWindows = (pid, w) => { try { localStorage.setItem(pid ? `knx-windows-${pid}` : 'knx-windows', JSON.stringify(w)); } catch {} };

export const initialState = {
  projects: [], activeProjectId: null, projectData: null,
  busStatus: { connected: false, host: null, hasLib: false },
  telegrams: [], view: 'projects',
  loading: false, error: null,
  windows: [],
  activePinKey: null,
  scan: { results: [], running: false, progress: null },
  navHistory: [{ view: 'projects', activePinKey: null }],
  navIndex: 0,
};

export const GROUP_WTYPES = {
  manufacturer: { field: 'manufacturer', label: 'MANUFACTURER' },
  model:        { field: 'model',        label: 'MODEL' },
  order_number: { field: 'order_number', label: 'ORDER #' },
};

// Push a navigation entry, truncating any forward history
export function pushNav(state, entry) {
  const cur = state.navHistory[state.navIndex];
  if (cur?.view === entry.view && cur?.activePinKey === (entry.activePinKey ?? null)) return {};
  const hist = [...state.navHistory.slice(0, state.navIndex + 1), entry];
  return { navHistory: hist, navIndex: hist.length - 1 };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'SET_PROJECTS':     return { ...state, projects: action.projects };
    case 'DPT_LOADED':       return { ...state }; // triggers re-render so DPT_INFO is used
    case 'SET_ACTIVE': {
      const targetView = action.view || 'locations';
      const nav = pushNav(state, { view: targetView, activePinKey: null });
      return { ...state, activeProjectId: action.id, projectData: action.data, view: targetView, windows: loadWindows(action.id), activePinKey: null, ...nav };
    }
    case 'SET_VIEW': {
      const nav = pushNav(state, { view: action.view, activePinKey: action.view === 'pin' ? state.activePinKey : null });
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
      const jt = { main: action.main, middle: action.middle ?? null, ts: Date.now() };
      const nav = pushNav(state, { view: 'groups', activePinKey: null });
      return { ...state, view: 'groups', gaJumpTo: jt, ...nav };
    }
    case 'CATALOG_JUMP': {
      const nav = pushNav(state, { view: 'catalog', activePinKey: null });
      return { ...state, view: 'catalog', catalogJumpTo: { manufacturer: action.manufacturer, ts: Date.now() }, ...nav };
    }
    case 'FLOORPLAN_JUMP': {
      const nav = pushNav(state, { view: 'floorplan', activePinKey: null });
      return { ...state, view: 'floorplan', floorplanJumpTo: { spaceId: action.spaceId, ts: Date.now() }, ...nav };
    }
    case 'SET_BUS':          return { ...state, busStatus: action.status };
    case 'ADD_TELEGRAM':     return { ...state, telegrams: [action.telegram, ...state.telegrams].slice(0, 500) };
    case 'SET_TELEGRAMS':    return { ...state, telegrams: action.telegrams };
    case 'PIN_VIEW': {
      const nav = pushNav(state, { view: 'pin', activePinKey: action.key });
      return { ...state, view: 'pin', activePinKey: action.key, ...nav };
    }
    case 'OPEN_WINDOW': {
      const key = `${action.wtype}:${action.address}`;
      const exists = state.windows.find(w => w.key === key);
      const next = exists ? state.windows : [...state.windows, { key, wtype: action.wtype, address: action.address }];
      if (!exists) saveWindows(state.activeProjectId, next);
      const nav = pushNav(state, { view: 'pin', activePinKey: key });
      return { ...state, windows: next, view: 'pin', activePinKey: key, ...nav };
    }
    case 'NAV_BACK': {
      if (state.navIndex <= 0) return state;
      const idx = state.navIndex - 1;
      const e = state.navHistory[idx];
      return { ...state, navIndex: idx, view: e.view, activePinKey: e.activePinKey ?? null };
    }
    case 'NAV_FORWARD': {
      if (state.navIndex >= state.navHistory.length - 1) return state;
      const idx = state.navIndex + 1;
      const e = state.navHistory[idx];
      return { ...state, navIndex: idx, view: e.view, activePinKey: e.activePinKey ?? null };
    }
    case 'CLOSE_WINDOW': {
      const next = state.windows.filter(w => w.key !== action.key);
      saveWindows(state.activeProjectId, next);
      return { ...state, windows: next };
    }
    case 'SET_LOADING':      return { ...state, loading: action.loading };
    case 'SET_ERROR':        return { ...state, error: action.error };
    case 'PATCH_PROJECT':    return { ...state, projectData: { ...state.projectData, ...action.patch } };
    case 'SET_DEVICE_STATUS':{
      if (!state.projectData) return state;
      const devices = state.projectData.devices.map(d => d.id === action.deviceId ? { ...d, status: action.status } : d);
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_DEVICE': {
      if (!state.projectData) return state;
      const devices = state.projectData.devices.map(d => d.id === action.id ? { ...d, ...action.patch } : d);
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_GA': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.map(g => g.id === action.id ? { ...g, ...action.patch } : g);
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'RENAME_GA_GROUP': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.map(g => {
        if (action.field === 'main_group_name' && g.main === action.main)
          return { ...g, main_group_name: action.name };
        if (action.field === 'middle_group_name' && g.main === action.main && g.middle === action.middle)
          return { ...g, middle_group_name: action.name };
        return g;
      });
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'PATCH_SPACE': {
      if (!state.projectData) return state;
      const spaces = state.projectData.spaces.map(s => s.id === action.id ? { ...s, ...action.patch } : s);
      return { ...state, projectData: { ...state.projectData, spaces } };
    }
    case 'ADD_SPACE': {
      if (!state.projectData) return state;
      const spaces = [...state.projectData.spaces, action.space];
      return { ...state, projectData: { ...state.projectData, spaces } };
    }
    case 'DELETE_SPACE': {
      if (!state.projectData) return state;
      const spaces = state.projectData.spaces.filter(s => s.id !== action.id)
        .map(s => s.parent_id === action.id ? { ...s, parent_id: action.newParentId } : s);
      const devices = state.projectData.devices.map(d => d.space_id === action.id ? { ...d, space_id: null } : d);
      return { ...state, projectData: { ...state.projectData, spaces, devices } };
    }
    case 'DELETE_GA': {
      if (!state.projectData) return state;
      const gas = state.projectData.gas.filter(g => g.id !== action.id);
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'ADD_GA': {
      if (!state.projectData) return state;
      const ga = { ...action.ga, main: action.ga.main_g || 0, middle: action.ga.middle_g || 0, sub: action.ga.sub_g ?? null, devices: [] };
      const gas = [...state.projectData.gas, ga].sort((a, b) => a.main - b.main || a.middle - b.middle || (a.sub ?? -1) - (b.sub ?? -1));
      return { ...state, projectData: { ...state.projectData, gas } };
    }
    case 'ADD_DEVICE': {
      if (!state.projectData) return state;
      const devices = [...state.projectData.devices, action.device];
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'DELETE_DEVICE': {
      if (!state.projectData) return state;
      const devices = state.projectData.devices.filter(d => d.id !== action.id);
      return { ...state, projectData: { ...state.projectData, devices } };
    }
    case 'PATCH_COMOBJECT': {
      if (!state.projectData) return state;
      const comObjects = state.projectData.comObjects.map(co =>
        co.id === action.id ? { ...co, ...action.patch } : co
      );
      // Rebuild deviceGAMap and gaDeviceMap from updated com objects
      const deviceGAMap = {}, gaDeviceMap = {};
      for (const co of comObjects) {
        const da = co.device_address;
        for (const ga of (co.ga_address || '').split(/\s+/).filter(Boolean)) {
          if (!deviceGAMap[da]) deviceGAMap[da] = [];
          if (!deviceGAMap[da].includes(ga)) deviceGAMap[da].push(ga);
          if (!gaDeviceMap[ga]) gaDeviceMap[ga] = [];
          if (!gaDeviceMap[ga].includes(da)) gaDeviceMap[ga].push(da);
        }
      }
      // Update GA device counts
      const gas = (state.projectData.gas || []).map(g => ({ ...g, devices: gaDeviceMap[g.address] || [] }));
      return { ...state, projectData: { ...state.projectData, comObjects, deviceGAMap, gaDeviceMap, gas } };
    }
    case 'SCAN_PROGRESS': {
      const prog = action.progress;
      const results = prog.reachable
        ? [...state.scan.results, { address: prog.address, descriptor: prog.descriptor }]
        : state.scan.results;
      return { ...state, scan: { ...state.scan, running: true, progress: prog, results } };
    }
    case 'SCAN_DONE':
      return { ...state, scan: { results: action.results, running: false, progress: null } };
    case 'SCAN_RESET':
      return { ...state, scan: { results: [], running: false, progress: null } };
    default: return state;
  }
}
