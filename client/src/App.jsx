import { useState, useEffect, useRef, useCallback, useReducer, useMemo } from 'react';
import { api, createWS } from './api.js';
import { DARK_C, LIGHT_C, ThemeCtx, MediumCtx, MaskCtx, I18nCtx } from './theme.js';
import { DptCtx, PinContext } from './contexts.js';
import { setI18nT, setI18nLang as setI18nLangGlobal, setDptInfo, setSpaceUsages } from './dpt.js';
import { initialState, reducer } from './state.js';
import {
  IconLocations, IconTopology, IconGroupAddr, IconComObjects,
  IconMonitor, IconScan, IconProgramming, IconManufacturers, DeviceTypeIcon,
  IconProject, IconFloorPlan, IconCatalog,
} from './icons.jsx';
import { Spinner, Toast } from './primitives.jsx';
import { GlobalSearch } from './search.jsx';

import { ProjectsView }       from './views/ProjectsView.jsx';
import { TopologyView }       from './views/TopologyView.jsx';
import { DevicesView }        from './views/DevicesView.jsx';
import { GroupAddressesView } from './views/GroupAddressesView.jsx';
import { ComObjectsView }     from './views/ComObjectsView.jsx';
import { ManufacturersView }  from './views/ManufacturersView.jsx';
import { BusMonitorView }     from './views/BusMonitorView.jsx';
import { ProgrammingView }    from './views/ProgrammingView.jsx';
import { SettingsView }       from './views/SettingsView.jsx';
import { ProjectInfoView }    from './views/ProjectInfoView.jsx';
import { LocationsView }      from './views/LocationsView.jsx';
import { FloorPlanView }     from './views/FloorPlanView.jsx';
import { BusScanView }        from './views/BusScanView.jsx';
import { CatalogView }        from './views/CatalogView.jsx';
import { PrintLabelsView }    from './views/PrintLabelsView.jsx';
import { PinDetailView }      from './detail/PinDetailView.jsx';
import { GROUP_WTYPES }       from './state.js';

// ── Global styles ─────────────────────────────────────────────────────────────
const makeGS = (C) => `
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-track{background:${C.bg}}
  ::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
  input,select,textarea{outline:none;font-family:inherit}
  input:focus,select:focus{border-color:#3d8ef0!important}
  .rh:hover{background:${C.hover}!important;cursor:pointer}
  .rs{background:${C.selected}!important;border-left:2px solid #3d8ef0!important}
  .ni{transition:all .12s;cursor:pointer}
  .ni:hover{background:${C.hover}!important}
  .ni.active{background:${C.selected}!important;border-left:2px solid #3d8ef0!important;color:#3d8ef0!important}
  .bg:hover{opacity:.75;cursor:pointer}
  .pa[data-pin]:hover{text-decoration:underline;text-underline-offset:2px;opacity:.85}
  @keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
  .fi{animation:fi .18s ease-out}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .pulse{animation:pulse 2s ease-in-out infinite}
  @keyframes tgnew{from{opacity:0;background:${C.selected}}to{opacity:1;background:transparent}}
  .tgnew{animation:tgnew .6s ease-out}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spin{animation:spin .8s linear infinite;display:inline-block}
  @keyframes flowin{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
  .flowin{animation:flowin .35s ease-out}
  @keyframes dk-dot-travel{from{offset-distance:0%;opacity:1}70%{opacity:1}to{offset-distance:100%;opacity:0}}
`;

// ── Views manifest ─────────────────────────────────────────────────────────────
const VIEWS = [
  { id: 'locations',   Icon: IconLocations,  label: 'Locations' },
  { id: 'floorplan',   Icon: IconFloorPlan,  label: 'Floor Plan' },
  { id: 'topology',    Icon: IconTopology,   label: 'Topology' },
  { id: 'devices',     Icon: ({ size }) => <DeviceTypeIcon type="generic" size={size} />, label: 'Devices' },
  { id: 'groups',      Icon: IconGroupAddr,  label: 'Group Addresses' },
  { id: 'comobjects',     Icon: IconComObjects,    label: 'Group Objects' },
  { id: 'manufacturers', Icon: IconManufacturers, label: 'Manufacturers' },
  { id: 'catalog',     Icon: IconCatalog,     label: 'Catalog' },
  { id: 'monitor',       Icon: IconMonitor,       label: 'Monitor' },
  { id: 'scan',        Icon: IconScan,       label: 'Scan' },
  { id: 'programming', Icon: IconProgramming,label: 'Programming', wip: true },
];

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('knx-theme') || 'dark');
  const C = theme === 'dark' ? DARK_C : LIGHT_C;
  const handleThemeChange = (t) => { setTheme(t); localStorage.setItem('knx-theme', t); };

  const [dptMode, setDptMode] = useState(() => localStorage.getItem('knx-dpt-mode') || 'numeric');
  const handleDptModeChange = (m) => { setDptMode(m); localStorage.setItem('knx-dpt-mode', m); };

  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef(null);
  const [mediumTypes, setMediumTypes] = useState({});
  const [maskVersions, setMaskVersions] = useState({});
  const [i18nLang, setI18nLang] = useState(() => localStorage.getItem('knx-lang') || 'en-US');
  const [i18nData, setI18nData] = useState({ languages: [], translations: {} });
  const handleLangChange = (l) => { setI18nLang(l); localStorage.setItem('knx-lang', l); dispatch({ type: 'DPT_LOADED' }); };
  const i18n = useMemo(() => {
    const texts = i18nData.translations[i18nLang] || {};
    const enTexts = i18nData.translations['en-US'] || {};
    const t = (refId) => texts[refId] || enTexts[refId] || null;
    setI18nT(t); // update module-level reference for dptName/dptTitle
    setI18nLangGlobal(i18nLang); // update module-level language for localizedModel
    return { lang: i18nLang, languages: i18nData.languages, t };
  }, [i18nLang, i18nData]);

  // Persist active project + view across sessions, notify server, reload master data
  useEffect(() => {
    if (state.activeProjectId) {
      localStorage.setItem('knx-active-project', String(state.activeProjectId));
      api.busSetProject(state.activeProjectId).catch(() => {});
      // Reload per-project master data
      const pid = state.activeProjectId;
      api.getDptInfo(pid).then(data => {
        if (data && Object.keys(data).length > 0) { setDptInfo(data); dispatch({ type: 'DPT_LOADED' }); }
      }).catch(() => {});
      api.getSpaceUsages(pid).then(data => { if (data?.length) setSpaceUsages(data); }).catch(() => {});
      api.getMediumTypes(pid).then(setMediumTypes).catch(() => {});
      api.getMaskVersions(pid).then(setMaskVersions).catch(() => {});
      api.getTranslations(pid).then(setI18nData).catch(() => {});
    }
  }, [state.activeProjectId]);
  useEffect(() => {
    if (state.view && state.view !== 'projects') localStorage.setItem('knx-last-view', state.view);
  }, [state.view]);

  // Boot: load projects + bus status, then auto-restore last session
  useEffect(() => {
    // Load DPT info from knx_master.xml (replaces hardcoded DPT_INFO table)
    api.getDptInfo().then(data => {
      if (data && Object.keys(data).length > 0) {
        setDptInfo(data);
        dispatch({ type: 'DPT_LOADED' }); // trigger re-render
      }
    }).catch(() => {});
    api.getSpaceUsages().then(data => {
      if (data?.length) setSpaceUsages(data);
    }).catch(() => {});
    api.getMediumTypes().then(setMediumTypes).catch(() => {});
    api.getMaskVersions().then(setMaskVersions).catch(() => {});
    api.getTranslations().then(setI18nData).catch(() => {});

    (async () => {
      try {
        const projects = await api.listProjects();
        dispatch({ type: 'SET_PROJECTS', projects });
        const savedPid = Number(localStorage.getItem('knx-active-project'));
        if (savedPid && projects.find(p => p.id === savedPid)) {
          dispatch({ type: 'SET_LOADING', loading: true });
          try {
            const data = await api.getProject(savedPid);
            const savedView = localStorage.getItem('knx-last-view') || 'locations';
            dispatch({ type: 'SET_ACTIVE', id: savedPid, data, view: savedView });
            const tgs = await api.listTelegrams(savedPid);
            dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
          } catch {}
          dispatch({ type: 'SET_LOADING', loading: false });
        }
      } catch {}
    })();
    api.busStatus().then(s => dispatch({ type: 'SET_BUS', status: s })).catch(() => {});

    // WebSocket for live telegrams + bus events
    const ws = createWS((msg) => {
      if (msg.type === 'knx:telegram') {
        dispatch({ type: 'ADD_TELEGRAM', telegram: msg.telegram });
      } else if (msg.type === 'knx:connected') {
        dispatch({ type: 'SET_BUS', status: { connected: true, type: msg.type === 'usb' ? 'usb' : 'udp', host: msg.host, port: msg.port, path: msg.path, hasLib: true } });
      } else if (msg.type === 'knx:disconnected') {
        dispatch({ type: 'SET_BUS', status: { connected: false, host: null, hasLib: true } });
      } else if (msg.type === 'scan:progress') {
        dispatch({ type: 'SCAN_PROGRESS', progress: msg });
      } else if (msg.type === 'scan:done') {
        dispatch({ type: 'SCAN_DONE', results: msg.results || [] });
      } else if (msg.type === 'scan:error') {
        dispatch({ type: 'SCAN_RESET' });
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  const handleDeviceStatus = useCallback(async (deviceId, status) => {
    if (!state.activeProjectId) return;
    await api.setDeviceStatus(state.activeProjectId, deviceId, status);
    dispatch({ type: 'SET_DEVICE_STATUS', deviceId, status });
  }, [state.activeProjectId]);

  const handleWrite = useCallback(async (ga, value, dpt) => {
    await api.busWrite(ga, value, dpt, state.activeProjectId);
  }, [state.activeProjectId]);

  const reimportRef = useRef(null);
  const [reimporting, setReimporting] = useState(false);
  const handleReimport = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !state.activeProjectId) return;
    setReimporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await api.reimportETS(state.activeProjectId, fd);
      dispatch({ type: 'SET_ACTIVE', id: state.activeProjectId, data: result.data });
      const tgs = await api.listTelegrams(state.activeProjectId);
      dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
      const projs = await api.listProjects();
      dispatch({ type: 'SET_PROJECTS', projects: projs });
    } catch (err) {
      alert(`Reimport failed: ${err.message}`);
    }
    setReimporting(false);
    e.target.value = '';
  };

  const handleConnect = useCallback(async (host, port) => {
    const result = await api.busConnect(host, port, state.activeProjectId);
    dispatch({ type: 'SET_BUS', status: { connected: true, type: 'udp', host, port, hasLib: true } });
    return result;
  }, [state.activeProjectId]);

  const handleConnectUsb = useCallback(async (devicePath) => {
    const result = await api.busConnectUsb(devicePath, state.activeProjectId);
    dispatch({ type: 'SET_BUS', status: { connected: true, type: 'usb', path: devicePath, hasLib: true } });
    return result;
  }, [state.activeProjectId]);

  const handleDisconnect = useCallback(async () => {
    await api.busDisconnect();
    dispatch({ type: 'SET_BUS', status: { connected: false, host: null, hasLib: state.busStatus.hasLib } });
  }, [state.busStatus.hasLib]);

  const handleDeviceJump = useCallback((address) => {
    dispatch({ type: 'DEVICE_JUMP', address });
  }, []);
  const handleGAGroupJump = useCallback((main, middle) => {
    dispatch({ type: 'GA_GROUP_JUMP', main, middle });
  }, []);
  const handlePin = useCallback((wtype, address) => {
    dispatch({ type: 'OPEN_WINDOW', wtype, address });
  }, []);
  const handleCloseWindow = useCallback((key) => {
    dispatch({ type: 'CLOSE_WINDOW', key });
  }, []);

  // Keyboard back/forward: Alt+Left / Alt+Right
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); dispatch({ type: 'NAV_BACK' }); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); dispatch({ type: 'NAV_FORWARD' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('knx-sidebar-width')) || 150);
  useEffect(() => { localStorage.setItem('knx-sidebar-width', sidebarWidth); }, [sidebarWidth]);
  const startSidebarResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX, startW = sidebarWidth;
    const onMove = ev => setSidebarWidth(Math.max(120, Math.min(320, startW + ev.clientX - startX)));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  const handleClearTelegrams = useCallback(async () => {
    if (state.activeProjectId) await api.clearTelegrams(state.activeProjectId);
    dispatch({ type: 'SET_TELEGRAMS', telegrams: [] });
  }, [state.activeProjectId]);

  // ── Undo system ─────────────────────────────────────────────────────────────
  const undoStackRef = useRef([]);
  const [undoCount, setUndoCount] = useState(0);
  const [undoOpen, setUndoOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const pushUndo = useCallback((desc, detail, undoFn) => {
    const stack = undoStackRef.current;
    stack.push({ desc, detail, undo: undoFn });
    if (stack.length > 50) stack.splice(0, stack.length - 50);
    setUndoCount(stack.length);
  }, []);

  const performUndo = useCallback(async (count = 1) => {
    setUndoOpen(false);
    const stack = undoStackRef.current;
    const n = Math.min(count, stack.length);
    const descs = [];
    for (let i = 0; i < n; i++) {
      const item = stack.pop();
      if (!item) break;
      try {
        await item.undo();
        descs.push(item.desc);
      } catch (e) {
        setToast(`Undo failed: ${e.message}`);
        break;
      }
    }
    setUndoCount(stack.length);
    if (descs.length) setToast(`Undone: ${descs.join(', ')}`);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [performUndo]);

  const diffDetail = (prev, patch) =>
    Object.keys(patch).filter(k => String(prev[k] ?? '') !== String(patch[k] ?? ''))
      .map(k => `${k}: "${prev[k] ?? ''}" → "${patch[k]}"`).join('; ');

  const handleUpdateGA = useCallback(async (gaId, patch) => {
    if (!state.activeProjectId) return;
    const prev = state.projectData?.gas?.find(g => g.id === gaId);
    if (!prev) return;
    const prevPatch = {};
    for (const k of Object.keys(patch)) prevPatch[k] = prev[k] ?? '';
    const detail = diffDetail(prev, patch);
    await api.updateGA(state.activeProjectId, gaId, patch);
    dispatch({ type: 'PATCH_GA', id: gaId, patch });
    const pid = state.activeProjectId;
    pushUndo(`Edit GA ${prev.address}`, detail, async () => {
      await api.updateGA(pid, gaId, prevPatch);
      dispatch({ type: 'PATCH_GA', id: gaId, patch: prevPatch });
    });
  }, [state.activeProjectId, state.projectData, pushUndo]);

  const handleRenameGAGroup = useCallback(async (main, middle, name) => {
    if (!state.activeProjectId) return;
    const midVal = middle !== null && middle !== undefined ? middle : undefined;
    await api.renameGAGroup(state.activeProjectId, { main, middle: midVal, name });
    // Update local state: patch all GAs in this group
    const field = midVal !== undefined ? 'middle_group_name' : 'main_group_name';
    dispatch({ type: 'RENAME_GA_GROUP', main, middle: midVal, field, name });
  }, [state.activeProjectId]);

  const handleUpdateDevice = useCallback(async (deviceId, patch) => {
    if (!state.activeProjectId) return;
    const prev = state.projectData?.devices?.find(d => d.id === deviceId);
    if (!prev) return;
    const prevPatch = {};
    for (const k of Object.keys(patch)) prevPatch[k] = prev[k] ?? '';
    const detail = diffDetail(prev, patch);
    await api.updateDevice(state.activeProjectId, deviceId, patch);
    dispatch({ type: 'PATCH_DEVICE', id: deviceId, patch });
    const pid = state.activeProjectId;
    pushUndo(`Edit device ${prev.individual_address}`, detail, async () => {
      await api.updateDevice(pid, deviceId, prevPatch);
      dispatch({ type: 'PATCH_DEVICE', id: deviceId, patch: prevPatch });
    });
  }, [state.activeProjectId, state.projectData, pushUndo]);

  const handleUpdateSpace = useCallback(async (spaceId, patch) => {
    if (!state.activeProjectId) return;
    const prev = state.projectData?.spaces?.find(s => s.id === spaceId);
    if (!prev) return;
    const prevPatch = {};
    for (const k of Object.keys(patch)) prevPatch[k] = prev[k] ?? '';
    const detail = diffDetail(prev, patch);
    await api.updateSpace(state.activeProjectId, spaceId, patch);
    dispatch({ type: 'PATCH_SPACE', id: spaceId, patch });
    const pid = state.activeProjectId;
    pushUndo(`Edit space "${prev.name}"`, detail, async () => {
      await api.updateSpace(pid, spaceId, prevPatch);
      dispatch({ type: 'PATCH_SPACE', id: spaceId, patch: prevPatch });
    });
  }, [state.activeProjectId, state.projectData, pushUndo]);

  const handleCreateSpace = useCallback(async (body) => {
    if (!state.activeProjectId) return null;
    const space = await api.createSpace(state.activeProjectId, body);
    dispatch({ type: 'ADD_SPACE', space });
    const pid = state.activeProjectId;
    pushUndo(`Create space "${space.name}"`, `${space.type}`, async () => {
      await api.deleteSpace(pid, space.id);
      dispatch({ type: 'DELETE_SPACE', id: space.id, newParentId: space.parent_id });
    });
    return space;
  }, [state.activeProjectId, pushUndo]);

  const handleDeleteSpace = useCallback(async (spaceId) => {
    if (!state.activeProjectId) return;
    const space = state.projectData?.spaces?.find(s => s.id === spaceId);
    if (!space) return;
    await api.deleteSpace(state.activeProjectId, spaceId);
    dispatch({ type: 'DELETE_SPACE', id: spaceId, newParentId: space.parent_id });
    const pid = state.activeProjectId;
    const spaceData = { name: space.name, type: space.type, parent_id: space.parent_id, sort_order: space.sort_order };
    pushUndo(`Delete space "${space.name}"`, `${space.type}`, async () => {
      const restored = await api.createSpace(pid, spaceData);
      dispatch({ type: 'ADD_SPACE', space: restored });
    });
  }, [state.activeProjectId, state.projectData, pushUndo]);

  const handleCreateGA = useCallback(async (body) => {
    if (!state.activeProjectId) return null;
    const ga = await api.createGA(state.activeProjectId, body);
    dispatch({ type: 'ADD_GA', ga });
    const pid = state.activeProjectId;
    pushUndo(`Create GA ${ga.address}`, `"${ga.name}"`, async () => {
      await api.deleteGA(pid, ga.id);
      dispatch({ type: 'DELETE_GA', id: ga.id });
    });
    return ga;
  }, [state.activeProjectId, pushUndo]);

  const handleDeleteGA = useCallback(async (gaId) => {
    if (!state.activeProjectId) return;
    const ga = state.projectData?.gas?.find(g => g.id === gaId);
    if (!ga) return;
    await api.deleteGA(state.activeProjectId, gaId);
    dispatch({ type: 'DELETE_GA', id: gaId });
    const pid = state.activeProjectId;
    const gaData = { address: ga.address, name: ga.name, dpt: ga.dpt };
    pushUndo(`Delete GA ${ga.address}`, `"${ga.name}"`, async () => {
      const newGa = await api.createGA(pid, gaData);
      dispatch({ type: 'ADD_GA', ga: newGa });
    });
  }, [state.activeProjectId, state.projectData, pushUndo]);

  const handleAddScannedDevice = useCallback(async (address) => {
    if (!state.activeProjectId) return;
    const [a, l] = address.split('.').map(Number);
    const device = await api.createDevice(state.activeProjectId, {
      individual_address: address, name: address, area: a, line: l, device_type: 'generic',
    });
    dispatch({ type: 'ADD_DEVICE', device });
  }, [state.activeProjectId]);

  const handleUpdateComObjectGAs = useCallback(async (coId, body) => {
    if (!state.activeProjectId) return;
    const updated = await api.updateComObjectGAs(state.activeProjectId, coId, body);
    dispatch({ type: 'PATCH_COMOBJECT', id: coId, patch: { ga_address: updated.ga_address, ga_send: updated.ga_send, ga_receive: updated.ga_receive } });
  }, [state.activeProjectId]);

  const handleAddDevice = useCallback(async (body) => {
    if (!state.activeProjectId) return null;
    const device = await api.createDevice(state.activeProjectId, body);
    dispatch({ type: 'ADD_DEVICE', device });
    const pid = state.activeProjectId;
    pushUndo(`Add device ${device.individual_address}`, `"${device.name}"`, async () => {
      await api.deleteDevice(pid, device.id);
      dispatch({ type: 'DELETE_DEVICE', id: device.id });
    });
    return device;
  }, [state.activeProjectId, pushUndo]);

  const hasProject = !!state.projectData;

  return (
    <ThemeCtx.Provider value={C}>
    <DptCtx.Provider value={dptMode}>
    <MediumCtx.Provider value={mediumTypes}>
    <MaskCtx.Provider value={maskVersions}>
    <I18nCtx.Provider value={i18n}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg, color: C.text, fontFamily: "'DM Mono',monospace", overflow: 'hidden', zoom: 1.45 }}>
      <style>{makeGS(C)}</style>

      {/* Title bar */}
      <div style={{ height: 40, background: C.sidebar, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 14, flexShrink: 0 }}>
        <span style={{ cursor: 'pointer' }} onClick={() => dispatch({ type: 'SET_VIEW', view: 'projects' })} title="Home">
          <img src="/icon.svg" alt="koolenex" style={{ width: 22, height: 22, verticalAlign: 'middle' }} />
        </span>
        <span onClick={() => dispatch({ type: 'SET_VIEW', view: 'projects' })} style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 13, letterSpacing: '0.1em', color: C.text, cursor: 'pointer' }}>KOOLENEX</span>
        {/* Back / Forward */}
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => dispatch({ type: 'NAV_BACK' })} disabled={state.navIndex <= 0}
            style={{ background: 'none', border: 'none', color: state.navIndex <= 0 ? C.dim : C.muted, fontSize: 14, cursor: state.navIndex <= 0 ? 'default' : 'pointer', padding: '0 4px', lineHeight: 1 }}
            title="Back (Alt+←)">‹</button>
          <button onClick={() => dispatch({ type: 'NAV_FORWARD' })} disabled={state.navIndex >= state.navHistory.length - 1}
            style={{ background: 'none', border: 'none', color: state.navIndex >= state.navHistory.length - 1 ? C.dim : C.muted, fontSize: 14, cursor: state.navIndex >= state.navHistory.length - 1 ? 'default' : 'pointer', padding: '0 4px', lineHeight: 1 }}
            title="Forward (Alt+→)">›</button>
        </div>
        {undoCount > 0 && (
          <div style={{ display: 'inline-flex', alignItems: 'center' }}>
            <button onClick={() => performUndo()} title={`Undo (Ctrl+Z)`}
              style={{ background: 'none', border: 'none', color: C.amber, fontSize: 11, cursor: 'pointer', padding: '0 2px 0 6px', lineHeight: 1 }}
              className="bg">↩ {undoCount}</button>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setUndoOpen(p => !p)} title="Show undo history"
                style={{ background: 'none', border: 'none', color: C.amber, fontSize: 8, cursor: 'pointer', padding: '0 4px', lineHeight: 1, opacity: 0.7 }}
                className="bg">▾</button>
              {undoOpen && (
                <>
                  <div onClick={() => setUndoOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
                  <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 6, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 1000, minWidth: 240, maxHeight: 320, overflow: 'auto' }}>
                  <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 9, color: C.dim, fontWeight: 600, letterSpacing: '0.08em' }}>UNDO HISTORY</div>
                  {[...undoStackRef.current].reverse().map((item, i) => (
                    <div key={i} onClick={() => performUndo(i + 1)}
                      className="rh"
                      style={{ padding: '6px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}11` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: C.text }}>{item.desc}</span>
                        {i > 0 && <span style={{ fontSize: 9, color: C.dim, marginLeft: 8, whiteSpace: 'nowrap' }}>+{i}</span>}
                      </div>
                      {item.detail && <div style={{ fontSize: 9, color: C.dim, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{item.detail}</div>}
                    </div>
                  ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {state.projectData?.project && <>
          <span style={{ color: C.border2 }}>/</span>
          <span onClick={() => dispatch({ type: 'SET_VIEW', view: 'locations' })} style={{ fontSize: 11, color: C.muted, cursor: 'pointer' }} title="Back to project">{state.projectData.project.name}</span>
          <input ref={reimportRef} type="file" accept=".knxproj" onChange={handleReimport} style={{ display: 'none' }} />
          <span onClick={() => reimportRef.current?.click()} title="Re-import .knxproj to refresh project data"
            style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: `${C.accent}15`, color: reimporting ? C.dim : C.accent, border: `1px solid ${C.accent}30`, cursor: reimporting ? 'default' : 'pointer', letterSpacing: '0.06em' }}
            className={reimporting ? '' : 'bg'}>{reimporting ? 'REIMPORTING…' : 'REIMPORT'}</span>
        </>}
        {state.projectData && (
          <GlobalSearch projectData={state.projectData} onPin={handlePin} C={C} />
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: state.busStatus.connected ? C.green : C.dim }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: state.busStatus.connected ? C.green : C.dim }} className={state.busStatus.connected ? 'pulse' : ''} />
            {state.busStatus.connected ? (state.busStatus.type === 'usb' ? 'USB' : `${state.busStatus.host}`) : 'No bus'}
          </div>
          <button onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })} className="bg"
            style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.muted, padding: '3px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit', cursor: 'pointer' }}>⚙</button>
          <button onClick={() => dispatch({ type: 'SET_VIEW', view: 'projects' })} className="bg"
            style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.muted, padding: '3px 10px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit', cursor: 'pointer' }}>⊠ Projects</button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        {hasProject && state.view !== 'projects' && (
          <div style={{ width: sidebarWidth, borderRight: `1px solid ${C.border}`, background: C.sidebar, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div style={{ padding: '8px 0' }}>
                {VIEWS.map(v => (
                  <div key={v.id} className={`ni ${state.view === v.id ? 'active' : ''}`}
                    onClick={() => dispatch({ type: 'SET_VIEW', view: v.id })}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', fontSize: 11, color: state.view === v.id ? C.accent : C.muted, borderLeft: '2px solid transparent' }}>
                    <v.Icon size={15} />
                    <span style={{ textDecoration: v.wip ? 'line-through' : 'none', opacity: v.wip ? 0.5 : 1 }}>{v.label}</span>
                  </div>
                ))}
              </div>
              {state.windows.length > 0 && (
                <div style={{ borderTop: `1px solid ${C.border}`, overflow: 'auto', flex: 1 }}>
                  {[['device', 'DEVICES', C.accent], ['ga', 'GROUP ADDRESSES', C.purple], ['compare', 'COMPARISONS', C.purple], ['multicompare', 'MULTI-COMPARE', C.purple],
                    ['manufacturer', 'BY MANUFACTURER', C.amber], ['model', 'BY MODEL', C.amber], ['order_number', 'BY ORDER #', C.amber],
                    ['space', 'BY LOCATION', C.amber]].map(([wtype, label, col]) => {
                    const cmpPhys = (a, b) => { const p = s => s.split('.').map(Number); const [x,y]=[p(a),p(b)]; for(let i=0;i<3;i++){const d=(x[i]??0)-(y[i]??0);if(d)return d;}return 0; };
                    const cmpGA   = (a, b) => { const ga = addr => { const g = state.projectData?.gas?.find(g=>g.address===addr); return [g?.main??0,g?.middle??0,g?.sub??0]; }; const [x,y]=[ga(a),ga(b)]; for(let i=0;i<3;i++){const d=x[i]-y[i];if(d)return d;}return 0; };
                    const group = [...state.windows.filter(w => w.wtype === wtype)].sort((a,b) => wtype==='device' ? cmpPhys(a.address, b.address) : wtype==='ga' ? cmpGA(a.address, b.address) : 0);
                    if (!group.length) return null;
                    const spaceMap = Object.fromEntries((state.projectData?.spaces || []).map(s => [s.id, s]));
                    const spacePath = (spaceId) => { const parts = []; let cur = spaceMap[spaceId]; while (cur) { if (cur.type !== 'Building') parts.unshift(cur.name); cur = cur.parent_id ? spaceMap[cur.parent_id] : null; } return parts.join(' › '); };
                    return (
                      <div key={wtype}>
                        <div style={{ padding: '6px 14px 2px', fontSize: 9, color: C.dim, letterSpacing: '0.08em' }}>{label}</div>
                        {group.map(w => {
                          let displayAddr = w.address, displayLabel = null;
                          if (wtype === 'multicompare') {
                            const addrs = w.address.split('|');
                            displayAddr = `${addrs.length} devices`;
                            displayLabel = addrs.join(', ');
                          } else if (wtype === 'compare') {
                            const [a, b] = w.address.split('|');
                            const nA = state.projectData?.devices?.find(d => d.individual_address === a)?.name;
                            const nB = state.projectData?.devices?.find(d => d.individual_address === b)?.name;
                            displayAddr = `${a} ⇄ ${b}`;
                            displayLabel = [nA, nB].filter(Boolean).join(' / ');
                          } else if (wtype === 'ga') {
                            displayLabel = state.projectData?.gas?.find(g => g.address === w.address)?.name;
                          } else if (wtype === 'space') {
                            const sp = state.projectData?.spaces?.find(s => s.id === parseInt(w.address));
                            displayAddr = sp?.name ?? w.address;
                            displayLabel = sp?.type;
                          } else if (GROUP_WTYPES[wtype]) {
                            displayAddr = w.address; // already the human-readable value
                          } else {
                            const dev = state.projectData?.devices?.find(d => d.individual_address === w.address);
                            displayLabel = dev?.name;
                            const location = dev?.space_id ? spacePath(dev.space_id) : null;
                            if (location) displayLabel = displayLabel ? `${displayLabel} — ${location}` : location;
                          }
                          const tooltip = [w.address, displayLabel].filter(Boolean).join(' — ');
                          return (
                          <div key={w.key} style={{ display: 'flex', alignItems: 'center', padding: '3px 6px 3px 14px', gap: 4, background: state.activePinKey === w.key ? C.border : 'transparent' }}>
                            <span className="rh" onClick={() => dispatch({ type: 'PIN_VIEW', key: w.key })}
                              title={tooltip}
                              style={{ flex: 1, fontSize: 10, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '2px 0' }}>
                                <span style={{ fontFamily: 'monospace', color: col }}>{displayAddr}</span>
                              {displayLabel && <span style={{ color: C.muted, marginLeft: 5 }}>{displayLabel}</span>}
                            </span>
                            <button onClick={() => handleCloseWindow(w.key)}
                              style={{ background: 'transparent', border: 'none', color: C.dim, fontSize: 12, cursor: 'pointer', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
                          </div>
                        ); })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 0' }}>
              <div className={`ni ${state.view === 'project' ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'SET_VIEW', view: 'project' })}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', fontSize: 11, color: state.view === 'project' ? C.accent : C.muted, borderLeft: '2px solid transparent', cursor: 'pointer' }}>
                <IconProject size={15} />
                <span>Project</span>
              </div>
            </div>
          {/* Resize handle */}
          <div onMouseDown={startSidebarResize}
            style={{ position: 'absolute', top: 0, right: 0, width: 4, height: '100%', cursor: 'col-resize', zIndex: 10 }}
            onMouseEnter={e => e.currentTarget.style.background = C.border2}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'} />
          </div>
        )}

        {/* View */}
        <PinContext.Provider value={handlePin}>
        <div key={state.view} className="fi" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {state.view === 'projects' && <ProjectsView state={state} dispatch={dispatch} />}
          {state.view === 'settings' && <SettingsView theme={theme} onThemeChange={handleThemeChange} dptMode={dptMode} onDptModeChange={handleDptModeChange} />}
          {state.view === 'project'     && hasProject && <ProjectInfoView project={state.projects.find(p => p.id === state.activeProjectId)} data={state.projectData} lang={i18nLang} onLangChange={handleLangChange} languages={i18nData.languages} busStatus={state.busStatus} onConnect={handleConnect} onConnectUsb={handleConnectUsb} onDisconnect={handleDisconnect} />}
          {state.view === 'topology'    && hasProject && <TopologyView    data={state.projectData} onPin={handlePin} busConnected={state.busStatus.connected} dispatch={dispatch} onAddDevice={handleAddDevice} />}
          {state.view === 'devices'     && hasProject && <DevicesView     data={state.projectData} onDeviceStatus={handleDeviceStatus} jumpTo={state.deviceJumpTo} onPin={handlePin} onAddDevice={handleAddDevice} onUpdateDevice={handleUpdateDevice} dispatch={dispatch} />}
          {state.view === 'groups'      && hasProject && <GroupAddressesView data={state.projectData} busConnected={state.busStatus.connected} activeProjectId={state.activeProjectId} onWrite={handleWrite} onDeviceJump={handleDeviceJump} onPin={handlePin} onCreateGA={handleCreateGA} onDeleteGA={handleDeleteGA} onUpdateGA={handleUpdateGA} onRenameGAGroup={handleRenameGAGroup} jumpTo={state.gaJumpTo} />}
          {state.view === 'comobjects'     && hasProject && <ComObjectsView     data={state.projectData} onPin={handlePin} />}
          {state.view === 'manufacturers' && hasProject && <ManufacturersView  data={state.projectData} onAddDevice={handleAddDevice} dispatch={dispatch} />}
          {state.view === 'locations'   && hasProject && <LocationsView   data={state.projectData} onPin={handlePin} dispatch={dispatch} onAddDevice={handleAddDevice} onUpdateDevice={handleUpdateDevice} onUpdateSpace={handleUpdateSpace} onCreateSpace={handleCreateSpace} onDeleteSpace={handleDeleteSpace} />}
          {state.view === 'floorplan'   && hasProject && <FloorPlanView   data={state.projectData} activeProjectId={state.activeProjectId} onUpdateDevice={handleUpdateDevice} jumpTo={state.floorplanJumpTo} onAddDevice={handleAddDevice} />}
          {state.view === 'monitor'     && <BusMonitorView telegrams={state.telegrams} busConnected={state.busStatus.connected} activeProjectId={state.activeProjectId} onClear={handleClearTelegrams} onWrite={handleWrite} data={state.projectData} onPin={handlePin} />}
          {state.view === 'scan'        && <BusScanView scan={state.scan} busConnected={state.busStatus.connected} projectData={state.projectData} activeProjectId={state.activeProjectId} dispatch={dispatch} onAddDevice={handleAddScannedDevice} />}
          {state.view === 'catalog'     && hasProject && <CatalogView activeProjectId={state.activeProjectId} data={state.projectData} onAddDevice={handleAddDevice} onPin={handlePin} jumpTo={state.catalogJumpTo} />}
          {state.view === 'printlabels' && hasProject && <PrintLabelsView data={state.projectData} dispatch={dispatch} />}
          {state.view === 'programming' && hasProject && <ProgrammingView data={state.projectData} onDeviceStatus={handleDeviceStatus} />}
          {state.view === 'pin'         && hasProject && <PinDetailView pinKey={state.activePinKey} data={state.projectData} busStatus={state.busStatus} telegrams={state.telegrams} onWrite={handleWrite} activeProjectId={state.activeProjectId} onUpdateGA={handleUpdateGA} onUpdateDevice={handleUpdateDevice} onGroupJump={handleGAGroupJump} onAddDevice={handleAddDevice} onUpdateComObjectGAs={handleUpdateComObjectGAs} dispatch={dispatch} />}
        </div>
        </PinContext.Provider>
      </div>

      {/* Status bar */}
      <div style={{ height: 22, background: C.sidebar, borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 16, fontSize: 10, color: C.dim, flexShrink: 0 }}>
        {state.error && <span style={{ color: C.red }}>✗ {state.error}</span>}
        {state.loading && <><Spinner /> Loading…</>}
        {state.projectData && <>
          <span>{state.projectData.devices?.length ?? 0} devices</span>
          <span>·</span>
          <span>{state.projectData.gas?.length ?? 0} group addresses</span>
          <span>·</span>
          <span>{state.projectData.comObjects?.length ?? 0} group objects</span>
        </>}
        <span style={{ marginLeft: 'auto' }}>koolenex v0.1.0-alpha</span>
      </div>
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
    </I18nCtx.Provider>
    </MaskCtx.Provider>
    </MediumCtx.Provider>
    </DptCtx.Provider>
    </ThemeCtx.Provider>
  );
}
