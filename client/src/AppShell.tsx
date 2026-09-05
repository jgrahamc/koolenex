import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AppState, Action } from './state.ts';
import type { DptMode } from './contexts.ts';
import { PinContext, useUndo } from './contexts.ts';
import {
  IconLocations,
  IconTopology,
  IconGroupAddr,
  IconComObjects,
  IconMonitor,
  IconScan,
  IconProgramming,
  IconManufacturers,
  DeviceTypeIcon,
  IconProject,
  IconFloorPlan,
  IconCatalog,
  IconOffline,
  IconAttention,
} from './icons.tsx';
import { Spinner, Toast, Btn } from './primitives.tsx';
import primStyles from './primitives.module.css';
import { buildSpaceMap, spacePath as spacePathFn } from './hooks/spaces.ts';
import { GlobalSearch } from './search.tsx';
import { BusConnectionPanel } from './BusConnectionPanel.tsx';

import { ProjectsView } from './views/ProjectsView.tsx';
import { TopologyView } from './views/TopologyView.tsx';
import { DevicesView } from './views/DevicesView.tsx';
import { GroupAddressesView } from './views/GroupAddressesView.tsx';
import { ComObjectsView } from './views/ComObjectsView.tsx';
import { ManufacturersView } from './views/ManufacturersView.tsx';
import { BusMonitorView } from './views/BusMonitorView.tsx';
import { ProgrammingView } from './views/ProgrammingView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ProjectInfoView } from './views/ProjectInfoView.tsx';
import { LocationsView } from './views/LocationsView.tsx';
import { FloorPlanView } from './views/FloorPlanView.tsx';
import { BusScanView } from './views/BusScanView.tsx';
import { CatalogView } from './views/CatalogView.tsx';
import { PrintLabelsView } from './views/PrintLabelsView.tsx';
import { PinDetailView } from './detail/PinDetailView.tsx';
import { GROUP_WTYPES } from './state.ts';
import { api } from './api.ts';
import { pinUrl, viewFromPath, pinKeyFromPath } from './routes.ts';
import appStyles from './App.module.css';

// ── Views manifest ─────────────────────────────────────────────────────────────
interface ViewEntry {
  id: string;
  slug: string;
  Icon: React.ComponentType<{ size: number }>;
  label: string;
  wip?: boolean;
}

const VIEWS: ViewEntry[] = [
  {
    id: 'locations',
    slug: 'locations',
    Icon: IconLocations,
    label: 'Locations',
  },
  {
    id: 'floorplan',
    slug: 'floorplan',
    Icon: IconFloorPlan,
    label: 'Floor Plan',
  },
  { id: 'topology', slug: 'topology', Icon: IconTopology, label: 'Topology' },
  {
    id: 'devices',
    slug: 'devices',
    Icon: ({ size }: { size: number }) => (
      <DeviceTypeIcon type="generic" size={size} />
    ),
    label: 'Devices',
  },
  { id: 'groups', slug: 'gas', Icon: IconGroupAddr, label: 'Group Addresses' },
  {
    id: 'comobjects',
    slug: 'comobjects',
    Icon: IconComObjects,
    label: 'Group Objects',
  },
  {
    id: 'manufacturers',
    slug: 'manufacturers',
    Icon: IconManufacturers,
    label: 'Manufacturers',
  },
  { id: 'catalog', slug: 'catalog', Icon: IconCatalog, label: 'Catalog' },
  { id: 'monitor', slug: 'monitor', Icon: IconMonitor, label: 'Monitor' },
  { id: 'scan', slug: 'scan', Icon: IconScan, label: 'Scan' },
  {
    // wip: true removed 2026-08-31 - stale from when this page genuinely
    // was a work-in-progress placeholder; it's had extensive real work
    // since (device addressing, download modes, log panel, etc.) and no
    // longer belongs dimmed out next to the other, fully real nav items.
    id: 'programming',
    slug: 'programming',
    Icon: IconProgramming,
    label: 'Programming',
  },
];

/** Derive active view from the current URL path */
function useActiveView(): string {
  return viewFromPath(useLocation().pathname);
}

function usePinKey(): string | null {
  return pinKeyFromPath(useLocation().pathname);
}

export interface AppShellProps {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  theme: string;
  onThemeChange: (t: string) => void;
  dptMode: DptMode;
  onDptModeChange: (m: string) => void;
  i18nLang: string;
  onLangChange: (l: string) => void;
  i18nLanguages: any[];
}

export function AppShell(props: AppShellProps) {
  const {
    state,
    dispatch,
    theme,
    onThemeChange,
    dptMode,
    onDptModeChange,
    i18nLang,
    onLangChange,
    i18nLanguages,
  } = props;

  const {
    undoStackRef,
    undoCount,
    undoOpen,
    setUndoOpen,
    performUndo,
    toast,
    setToast,
  } = useUndo();

  const navigate = useNavigate();
  const activeView = useActiveView();
  const activePinKey = usePinKey();
  const projectId = state.activeProjectId;

  const reimportRef = useRef<HTMLInputElement | null>(null);
  const [reimportPassword, setReimportPassword] = useState('');
  const lastHandledReimportRef = useRef<string | null>(null);

  // Quick-connect popover on the top-bar bus status badge (2026-08-29, per
  // explicit request) - clicking the badge (which now also actually reflects
  // disconnection, see the busStatus render below and the WS onOpen re-sync
  // in App.tsx) opens the same real connect UI ProjectInfoView already had,
  // extracted into BusConnectionPanel so both places share one
  // implementation instead of a second, thinner one.
  const [connectPopoverOpen, setConnectPopoverOpen] = useState(false);
  const connectPopoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!connectPopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!connectPopoverRef.current?.contains(e.target as Node)) {
        setConnectPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [connectPopoverOpen]);

  const reimportInFlight =
    state.import.mode === 'reimport' &&
    (state.import.status === 'uploading' || state.import.status === 'parsing');
  const reimportPwOpen =
    state.import.mode === 'reimport' &&
    state.import.status === 'password-required';

  const handleReimport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !state.activeProjectId) return;
    dispatch({
      type: 'IMPORT_UPLOADING',
      mode: 'reimport',
      fileName: file.name,
    });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const result = await api.reimportETS(state.activeProjectId, fd);
      dispatch({
        type: 'IMPORT_STARTED',
        importId: result.importId,
        mode: 'reimport',
        fileName: file.name,
      });
    } catch (err: any) {
      dispatch({
        type: 'IMPORT_FAILED',
        importId: '',
        error: err.message || 'Reimport failed',
        code: err.code,
      });
    }
  };

  const submitReimportPassword = async () => {
    const importId = state.import.importId;
    if (!importId || !reimportPassword) return;
    try {
      await api.submitImportPassword(importId, reimportPassword);
      setReimportPassword('');
      dispatch({ type: 'IMPORT_PARSING', importId });
    } catch (err: any) {
      dispatch({
        type: 'IMPORT_FAILED',
        importId,
        error: err.message || 'Failed to submit password',
        code: err.code,
      });
    }
  };

  // When a reimport completes, reload the active project so the UI shows
  // the new data. (The project list refresh is handled in App.tsx.)
  useEffect(() => {
    if (state.import.mode !== 'reimport') return;
    const importId = state.import.importId;
    if (!importId || lastHandledReimportRef.current === importId) return;

    if (state.import.status === 'done' && state.import.projectId) {
      lastHandledReimportRef.current = importId;
      const pid = state.import.projectId;
      (async () => {
        try {
          const data = await api.getProject(pid);
          dispatch({ type: 'SET_ACTIVE', id: pid, data });
          const tgs = await api.listTelegrams(pid);
          dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
          setToast(`Reimported ${state.import.fileName ?? ''}`.trim());
        } catch (e: any) {
          setToast(`Reload failed: ${e.message}`);
        } finally {
          dispatch({ type: 'IMPORT_RESET' });
        }
      })();
    } else if (state.import.status === 'failed') {
      lastHandledReimportRef.current = importId;
      setToast(`Reimport failed: ${state.import.error ?? 'unknown error'}`);
      dispatch({ type: 'IMPORT_RESET' });
    }
  }, [
    state.import.mode,
    state.import.status,
    state.import.importId,
    state.import.projectId,
    state.import.fileName,
    state.import.error,
    dispatch,
    setToast,
  ]);

  const handlePin = useCallback(
    (wtype: string, address: string) => {
      dispatch({ type: 'OPEN_WINDOW', wtype, address });
      if (projectId) navigate(pinUrl(projectId, wtype, address));
    },
    [projectId, navigate, dispatch],
  );

  const handleCloseWindow = useCallback(
    (key: string) => {
      dispatch({ type: 'CLOSE_WINDOW', key });
    },
    [dispatch],
  );

  const [sidebarWidth, setSidebarWidth] = useState<number>(
    () => Number(localStorage.getItem('knx-sidebar-width')) || 150,
  );
  useEffect(() => {
    localStorage.setItem('knx-sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);
  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX,
        startW = sidebarWidth;
      const onMove = (ev: MouseEvent) =>
        setSidebarWidth(
          Math.max(120, Math.min(320, startW + ev.clientX - startX)),
        );
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth],
  );

  const hasProject = !!state.projectData;

  return (
    <div className={appStyles.appShell}>
      {/* Title bar */}
      <div className={appStyles.titleBar}>
        <span
          className={appStyles.homeIcon}
          onClick={() => navigate('/')}
          title="Home"
        >
          <img src="/icon.svg" alt="koolenex" className={appStyles.homeLogo} />
        </span>
        <span onClick={() => navigate('/')} className={appStyles.brandName}>
          KOOLENEX
        </span>
        {undoCount > 0 && (
          <div className={appStyles.undoWrap}>
            <button
              onClick={() => performUndo()}
              title={`Undo (Ctrl+Z)`}
              className={`${appStyles.undoBtn} bg`}
            >
              ↩ {undoCount}
            </button>
            <div className={appStyles.undoDropdownWrap}>
              <button
                onClick={() => setUndoOpen((p: boolean) => !p)}
                title="Show undo history"
                className={`${appStyles.undoDropdownBtn} bg`}
              >
                ▾
              </button>
              {undoOpen && (
                <>
                  <div
                    onClick={() => setUndoOpen(false)}
                    className={appStyles.undoBackdrop}
                  />
                  <div className={appStyles.undoDropdown}>
                    <div className={appStyles.undoDropdownTitle}>
                      UNDO HISTORY
                    </div>
                    {[...undoStackRef.current].reverse().map((item, i) => (
                      <div
                        key={i}
                        onClick={() => performUndo(i + 1)}
                        className={`rh ${appStyles.undoItem} ${appStyles.undoItemBorder}`}
                      >
                        <div className={appStyles.undoItemRow}>
                          <span className={appStyles.undoItemDesc}>
                            {item.desc}
                          </span>
                          {i > 0 && (
                            <span className={appStyles.undoItemIndex}>
                              +{i}
                            </span>
                          )}
                        </div>
                        {item.detail && (
                          <div className={appStyles.undoItemDetail}>
                            {item.detail}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {state.projectData?.project && (
          <>
            <span className={appStyles.breadcrumbSep}>/</span>
            <span
              onClick={() => navigate(`/projects/${projectId}/locations`)}
              className={appStyles.projectName}
              title="Back to project"
            >
              {state.projectData.project.name}
            </span>
            <input
              ref={reimportRef}
              type="file"
              accept=".knxproj"
              onChange={handleReimport}
              className={appStyles.fileInput}
            />
            <span
              onClick={() => reimportRef.current?.click()}
              title="Re-import .knxproj to refresh project data"
              className={`${appStyles.reimportBadge} ${reimportInFlight ? appStyles.reimportBadgeDisabled : `bg ${appStyles.reimportBadgeActive}`}`}
            >
              {reimportInFlight ? 'REIMPORTING…' : 'REIMPORT'}
            </span>
          </>
        )}
        {state.projectData && (
          <GlobalSearch projectData={state.projectData} onPin={handlePin} />
        )}
        <div className={appStyles.rightArea}>
          <div className={appStyles.busStatusWrap} ref={connectPopoverRef}>
            <button
              type="button"
              onClick={() => setConnectPopoverOpen((o) => !o)}
              className={`${appStyles.busStatus} ${
                state.busStatus.connected
                  ? appStyles.busConnected
                  : state.busStatus.needsAttention
                    ? appStyles.busNeedsAttention
                    : appStyles.busIdle
              }`}
              title={
                state.busStatus.connected
                  ? 'Click to manage the bus connection'
                  : state.busStatus.needsAttention
                    ? 'A reconnect attempt failed - check the connection settings (address, etc.) and reconnect manually'
                    : 'Not connected to the bus — most work here doesn’t need it. Click to connect.'
              }
            >
              {state.busStatus.connected ? (
                <span className={`${appStyles.busDot} pulse ${appStyles.busDotConnected}`} />
              ) : state.busStatus.needsAttention ? (
                <IconAttention size={11} />
              ) : (
                <IconOffline size={11} />
              )}
              {state.busStatus.connected
                ? state.busStatus.type === 'usb'
                  ? 'USB'
                  : `${state.busStatus.host}`
                : state.busStatus.needsAttention
                  ? 'Disconnected'
                  : 'Idle'}
            </button>
            {connectPopoverOpen && (
              <div className={appStyles.busStatusPopover}>
                <BusConnectionPanel
                  onConnected={() => setConnectPopoverOpen(false)}
                />
              </div>
            )}
          </div>
          <button
            onClick={() => navigate('/settings')}
            className={`${appStyles.toolbarBtn} bg`}
          >
            ⚙
          </button>
          <button
            onClick={() => navigate('/')}
            className={`${appStyles.toolbarBtn} bg`}
          >
            ⊠ Projects
          </button>
        </div>
      </div>

      <div className={appStyles.bodyRow}>
        {/* Sidebar */}
        {hasProject &&
          activeView !== 'projects' &&
          activeView !== 'settings' &&
          projectId && (
            <div className={appStyles.sidebar} style={{ width: sidebarWidth }}>
              <div className={appStyles.sidebarInner}>
                <div className={appStyles.navItems}>
                  {VIEWS.map((v) => (
                    <div
                      key={v.id}
                      className={`ni ${activeView === v.id ? 'active' : ''} ${appStyles.navItem}`}
                      onClick={() =>
                        navigate(`/projects/${projectId}/${v.slug}`)
                      }
                    >
                      <v.Icon size={15} />
                      <span
                        className={v.wip ? appStyles.navItemWip : undefined}
                      >
                        {v.label}
                      </span>
                    </div>
                  ))}
                </div>
                {state.windows.length > 0 && (
                  <div className={appStyles.pinSection}>
                    {(
                      [
                        ['device', 'DEVICES', 'var(--accent)'],
                        ['ga', 'GROUP ADDRESSES', 'var(--purple)'],
                        ['compare', 'COMPARISONS', 'var(--purple)'],
                        ['multicompare', 'MULTI-COMPARE', 'var(--purple)'],
                        ['manufacturer', 'BY MANUFACTURER', 'var(--amber)'],
                        ['model', 'BY MODEL', 'var(--amber)'],
                        ['order_number', 'BY ORDER #', 'var(--amber)'],
                        ['space', 'BY LOCATION', 'var(--amber)'],
                      ] as const
                    ).map(([wtype, label, col]) => {
                      const cmpPhys = (a: string, b: string) => {
                        const p = (s: string) => s.split('.').map(Number);
                        const [x, y] = [p(a), p(b)];
                        for (let i = 0; i < 3; i++) {
                          const d = (x[i] ?? 0) - (y[i] ?? 0);
                          if (d) return d;
                        }
                        return 0;
                      };
                      const cmpGA = (a: string, b: string) => {
                        const ga = (addr: string) => {
                          const g = state.projectData?.gas?.find(
                            (ga) => ga.address === addr,
                          );
                          return [
                            g?.main_g ?? 0,
                            g?.middle_g ?? 0,
                            g?.sub_g ?? 0,
                          ];
                        };
                        const [x, y] = [ga(a), ga(b)];
                        for (let i = 0; i < 3; i++) {
                          const d = (x[i] ?? 0) - (y[i] ?? 0);
                          if (d) return d;
                        }
                        return 0;
                      };
                      const group = [
                        ...state.windows.filter((w) => w.wtype === wtype),
                      ].sort((a, b) =>
                        wtype === 'device'
                          ? cmpPhys(a.address, b.address)
                          : wtype === 'ga'
                            ? cmpGA(a.address, b.address)
                            : 0,
                      );
                      if (!group.length) return null;
                      const spaceMap = buildSpaceMap(
                        state.projectData?.spaces || [],
                      );
                      const spacePath = (spaceId: number) =>
                        spacePathFn(spaceId, spaceMap);
                      return (
                        <div key={wtype}>
                          <div className={appStyles.pinGroupLabel}>{label}</div>
                          {group.map((w) => {
                            let displayAddr: string = w.address,
                              displayLabel: string | null = null;
                            if (wtype === 'multicompare') {
                              const addrs = w.address.split('|');
                              displayAddr = `${addrs.length} devices`;
                              displayLabel = addrs.join(', ');
                            } else if (wtype === 'compare') {
                              const [a, b] = w.address.split('|');
                              const nA = state.projectData?.devices?.find(
                                (d) => d.individual_address === a,
                              )?.name;
                              const nB = state.projectData?.devices?.find(
                                (d) => d.individual_address === b,
                              )?.name;
                              displayAddr = `${a} ⇄ ${b}`;
                              displayLabel = [nA, nB]
                                .filter(Boolean)
                                .join(' / ');
                            } else if (wtype === 'ga') {
                              displayLabel =
                                state.projectData?.gas?.find(
                                  (g) => g.address === w.address,
                                )?.name ?? null;
                            } else if (wtype === 'space') {
                              const sp = state.projectData?.spaces?.find(
                                (s) => s.id === parseInt(w.address),
                              );
                              displayAddr = sp?.name ?? w.address;
                              displayLabel = sp?.type ?? null;
                            } else if (
                              GROUP_WTYPES[wtype as keyof typeof GROUP_WTYPES]
                            ) {
                              displayAddr = w.address; // already the human-readable value
                            } else {
                              const dev = state.projectData?.devices?.find(
                                (d) => d.individual_address === w.address,
                              );
                              // A device with no real project address at all
                              // (has_address=0, a synthetic placeholder -
                              // see ets-parser.ts) should never surface its
                              // synthetic individual_address anywhere a
                              // person reads it - matches DeviceAddr's
                              // "-.-.-" convention (primitives.tsx).
                              if (wtype === 'device' && dev && !dev.has_address)
                                displayAddr = '-.-.-';
                              displayLabel = dev?.name ?? null;
                              const location = dev?.space_id
                                ? spacePath(dev.space_id)
                                : null;
                              if (location)
                                displayLabel = displayLabel
                                  ? `${displayLabel} — ${location}`
                                  : location;
                            }
                            const tooltip = [displayAddr, displayLabel]
                              .filter(Boolean)
                              .join(' — ');
                            return (
                              <div
                                key={w.key}
                                className={`${appStyles.pinItem} ${activePinKey === w.key ? appStyles.pinItemActive : ''}`}
                              >
                                <span
                                  className={`rh ${appStyles.pinItemLabel}`}
                                  onClick={() =>
                                    navigate(
                                      pinUrl(projectId, w.wtype, w.address),
                                    )
                                  }
                                  title={tooltip}
                                >
                                  <span
                                    className={appStyles.pinAddr}
                                    style={{ color: col }}
                                  >
                                    {displayAddr}
                                  </span>
                                  {displayLabel && (
                                    <span className={appStyles.pinName}>
                                      {displayLabel}
                                    </span>
                                  )}
                                </span>
                                <button
                                  onClick={() => handleCloseWindow(w.key)}
                                  className={appStyles.pinCloseBtn}
                                >
                                  ×
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className={appStyles.sidebarBottom}>
                <div
                  className={`ni ${activeView === 'project' ? 'active' : ''} ${appStyles.navItem}`}
                  onClick={() => navigate(`/projects/${projectId}/info`)}
                >
                  <IconProject size={15} />
                  <span>Project</span>
                </div>
              </div>
              {/* Resize handle */}
              <div
                onMouseDown={startSidebarResize}
                className={appStyles.resizeHandle}
              />
            </div>
          )}

        {/* View */}
        <PinContext.Provider value={handlePin}>
          <div
            key={activeView + (activePinKey || '')}
            className={`fi ${appStyles.viewWrap}`}
          >
            {activeView === 'projects' && (
              <ProjectsView state={state} dispatch={dispatch} />
            )}
            {activeView === 'settings' && (
              <SettingsView
                theme={theme}
                onThemeChange={onThemeChange}
                dptMode={dptMode}
                onDptModeChange={onDptModeChange}
              />
            )}
            {activeView === 'project' && hasProject && (
              <ProjectInfoView
                lang={i18nLang}
                onLangChange={onLangChange}
                languages={i18nLanguages}
              />
            )}
            {activeView === 'topology' && hasProject && <TopologyView />}
            {activeView === 'devices' && hasProject && <DevicesView />}
            {activeView === 'groups' && hasProject && <GroupAddressesView />}
            {activeView === 'comobjects' && hasProject && (
              <ComObjectsView data={state.projectData} />
            )}
            {activeView === 'manufacturers' && hasProject && (
              <ManufacturersView />
            )}
            {activeView === 'locations' && hasProject && <LocationsView />}
            {activeView === 'floorplan' && hasProject && <FloorPlanView />}
            {activeView === 'monitor' && <BusMonitorView />}
            {activeView === 'scan' && (
              <BusScanView scan={state.scan} dispatch={dispatch} />
            )}
            {activeView === 'catalog' && hasProject && <CatalogView />}
            {activeView === 'printlabels' && hasProject && <PrintLabelsView />}
            {activeView === 'programming' && hasProject && <ProgrammingView />}
            {activeView === 'pin' && hasProject && activePinKey && (
              <PinDetailView pinKey={activePinKey} />
            )}
          </div>
        </PinContext.Provider>
      </div>

      {/* Status bar */}
      <div className={appStyles.statusBar}>
        {state.error && (
          <span className={appStyles.statusError}>✗ {state.error}</span>
        )}
        {state.loading && (
          <>
            <Spinner /> Loading…
          </>
        )}
        {state.projectData && (
          <>
            <span>{state.projectData.devices?.length ?? 0} devices</span>
            <span>·</span>
            <span>{state.projectData.gas?.length ?? 0} group addresses</span>
            <span>·</span>
            <span>
              {state.projectData.comObjects?.length ?? 0} group objects
            </span>
          </>
        )}
        <span className={appStyles.statusVersion}>koolenex v0.1.0-alpha</span>
      </div>
      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
      {reimportPwOpen && (
        <ReimportPasswordModal
          retry={state.import.passwordRetry}
          fileName={state.import.fileName}
          password={reimportPassword}
          onChange={setReimportPassword}
          onSubmit={submitReimportPassword}
          onCancel={() => {
            setReimportPassword('');
            dispatch({ type: 'IMPORT_RESET' });
          }}
        />
      )}
    </div>
  );
}

interface ReimportPasswordModalProps {
  retry: boolean;
  fileName: string | null;
  password: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function ReimportPasswordModal({
  retry,
  fileName,
  password,
  onChange,
  onSubmit,
  onCancel,
}: ReimportPasswordModalProps) {
  return (
    <div className={primStyles.modalOverlay}>
      <div className={primStyles.modalBox}>
        <div className={primStyles.modalTitle}>Password protected</div>
        <div className={primStyles.modalBody}>
          <div>
            {fileName
              ? `${fileName} is password-protected.`
              : 'Enter password.'}
          </div>
          {retry && (
            <div style={{ color: 'var(--red)', marginTop: 8 }}>
              Incorrect password — try again
            </div>
          )}
          <input
            type="password"
            value={password}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSubmit();
              else if (e.key === 'Escape') onCancel();
            }}
            placeholder="Project password…"
            autoFocus
            style={{
              width: '100%',
              marginTop: 12,
              padding: '6px 8px',
              background: 'var(--bg2)',
              border: '1px solid var(--border2)',
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: 12,
            }}
          />
        </div>
        <div className={primStyles.modalActions}>
          <Btn onClick={onCancel} color="var(--dim)">
            Cancel
          </Btn>
          <Btn onClick={onSubmit} disabled={!password}>
            Unlock
          </Btn>
        </div>
      </div>
    </div>
  );
}
