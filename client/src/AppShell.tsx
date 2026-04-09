import { useState, useRef, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AppState, Action } from './state.ts';
import type { DptMode } from './contexts.ts';
import { PinContext } from './contexts.ts';
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
} from './icons.tsx';
import { Spinner, Toast } from './primitives.tsx';
import { GlobalSearch } from './search.tsx';

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
    id: 'programming',
    slug: 'programming',
    Icon: IconProgramming,
    label: 'Programming',
    wip: true,
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
  // Bus handlers
  handleConnect: (host: string, port: number) => Promise<any>;
  handleConnectUsb: (devicePath: string) => Promise<any>;
  handleDisconnect: () => Promise<void>;
  handleDeviceStatus: (deviceId: number, status: any) => Promise<void>;
  handleWrite: (ga: string, value: any, dpt: any) => Promise<void>;
  handleClearTelegrams: () => Promise<void>;
  // Project handlers
  handleUpdateGA: (
    gaId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  handleRenameGAGroup: (
    main: number,
    middle: number | null | undefined,
    name: string,
  ) => Promise<void>;
  handleUpdateDevice: (
    deviceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  handleUpdateSpace: (
    spaceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  handleCreateTopology: (body: Record<string, unknown>) => Promise<any>;
  handleUpdateTopology: (
    topoId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  handleDeleteTopology: (topoId: number) => Promise<void>;
  handleCreateSpace: (body: Record<string, unknown>) => Promise<any>;
  handleDeleteSpace: (spaceId: number) => Promise<void>;
  handleCreateGA: (body: any) => Promise<any>;
  handleDeleteGA: (gaId: number) => Promise<void>;
  handleAddDevice: (body: any) => Promise<any>;
  handleUpdateComObjectGAs: (coId: number, body: any) => Promise<void>;
  handleAddScannedDevice: (address: string) => Promise<void>;
  // Undo
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
    handleConnect,
    handleConnectUsb,
    handleDisconnect,
    handleDeviceStatus,
    handleWrite,
    handleClearTelegrams,
    handleUpdateGA,
    handleRenameGAGroup,
    handleUpdateDevice,
    handleUpdateSpace,
    handleCreateTopology,
    handleUpdateTopology,
    handleDeleteTopology,
    handleCreateSpace,
    handleDeleteSpace,
    handleCreateGA,
    handleDeleteGA,
    handleAddDevice,
    handleUpdateComObjectGAs,
    handleAddScannedDevice,
    undoStackRef,
    undoCount,
    undoOpen,
    setUndoOpen,
    performUndo,
    toast,
    setToast,
  } = props;

  const navigate = useNavigate();
  const activeView = useActiveView();
  const activePinKey = usePinKey();
  const projectId = state.activeProjectId;

  const reimportRef = useRef<HTMLInputElement | null>(null);
  const [reimporting, setReimporting] = useState(false);
  const handleReimport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !state.activeProjectId) return;
    setReimporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = await api.reimportETS(state.activeProjectId, fd);
      dispatch({
        type: 'SET_ACTIVE',
        id: state.activeProjectId,
        data: result.data,
      });
      const tgs = await api.listTelegrams(state.activeProjectId);
      dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
      const projs = await api.listProjects();
      dispatch({ type: 'SET_PROJECTS', projects: projs });
    } catch (err: any) {
      alert(`Reimport failed: ${err.message}`);
    }
    setReimporting(false);
    e.target.value = '';
  };

  const handleDeviceJump = useCallback(
    (address: string) => {
      if (projectId)
        navigate(`/projects/${projectId}/devices`, {
          state: { jumpTo: address },
        });
    },
    [projectId, navigate],
  );

  const handleGAGroupJump = useCallback(
    (main_g: number, middle_g: number | null) => {
      if (projectId)
        navigate(`/projects/${projectId}/gas`, {
          state: { jumpTo: { main_g, middle_g } },
        });
    },
    [projectId, navigate],
  );

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
              className={`${appStyles.reimportBadge} ${reimporting ? appStyles.reimportBadgeDisabled : `bg ${appStyles.reimportBadgeActive}`}`}
            >
              {reimporting ? 'REIMPORTING…' : 'REIMPORT'}
            </span>
          </>
        )}
        {state.projectData && (
          <GlobalSearch projectData={state.projectData} onPin={handlePin} />
        )}
        <div className={appStyles.rightArea}>
          <div
            className={`${appStyles.busStatus} ${state.busStatus.connected ? appStyles.busConnected : appStyles.busDisconnected}`}
          >
            <span
              className={`${appStyles.busDot} ${state.busStatus.connected ? `pulse ${appStyles.busDotConnected}` : appStyles.busDotDisconnected}`}
            />
            {state.busStatus.connected
              ? state.busStatus.type === 'usb'
                ? 'USB'
                : `${state.busStatus.host}`
              : 'No bus'}
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
                      const spaceMap = Object.fromEntries(
                        (state.projectData?.spaces || []).map((s) => [s.id, s]),
                      );
                      const spacePath = (spaceId: number): string => {
                        const parts: string[] = [];
                        let cur = spaceMap[spaceId];
                        while (cur) {
                          if (cur.type !== 'Building') parts.unshift(cur.name);
                          cur = cur.parent_id
                            ? spaceMap[cur.parent_id]
                            : undefined;
                        }
                        return parts.join(' › ');
                      };
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
                              displayLabel = dev?.name ?? null;
                              const location = dev?.space_id
                                ? spacePath(dev.space_id)
                                : null;
                              if (location)
                                displayLabel = displayLabel
                                  ? `${displayLabel} — ${location}`
                                  : location;
                            }
                            const tooltip = [w.address, displayLabel]
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
                project={state.projects.find(
                  (p: any) => p.id === state.activeProjectId,
                )}
                data={state.projectData}
                lang={i18nLang}
                onLangChange={onLangChange}
                languages={i18nLanguages}
                busStatus={state.busStatus}
                onConnect={handleConnect}
                onConnectUsb={handleConnectUsb}
                onDisconnect={handleDisconnect}
              />
            )}
            {activeView === 'topology' && hasProject && (
              <TopologyView
                data={state.projectData}
                onPin={handlePin}
                busConnected={state.busStatus.connected}
                activeProjectId={state.activeProjectId}
                onAddDevice={handleAddDevice}
                onCreateTopology={handleCreateTopology}
                onUpdateTopology={handleUpdateTopology}
                onDeleteTopology={handleDeleteTopology}
              />
            )}
            {activeView === 'devices' && hasProject && (
              <DevicesView
                data={state.projectData}
                onDeviceStatus={handleDeviceStatus}
                onPin={handlePin}
                onAddDevice={handleAddDevice}
                onUpdateDevice={handleUpdateDevice}
              />
            )}
            {activeView === 'groups' && hasProject && (
              <GroupAddressesView
                data={state.projectData}
                busConnected={state.busStatus.connected}
                activeProjectId={state.activeProjectId}
                onWrite={handleWrite}
                onDeviceJump={handleDeviceJump}
                onPin={handlePin}
                onCreateGA={handleCreateGA}
                onDeleteGA={handleDeleteGA}
                onUpdateGA={handleUpdateGA}
                onRenameGAGroup={handleRenameGAGroup}
              />
            )}
            {activeView === 'comobjects' && hasProject && (
              <ComObjectsView data={state.projectData} />
            )}
            {activeView === 'manufacturers' && hasProject && (
              <ManufacturersView
                data={state.projectData}
                onAddDevice={handleAddDevice}
                projectId={projectId}
              />
            )}
            {activeView === 'locations' && hasProject && (
              <LocationsView
                data={state.projectData}
                projectId={projectId}
                onAddDevice={handleAddDevice}
                onUpdateDevice={handleUpdateDevice}
                onUpdateSpace={handleUpdateSpace}
                onCreateSpace={handleCreateSpace}
                onDeleteSpace={handleDeleteSpace}
              />
            )}
            {activeView === 'floorplan' && hasProject && (
              <FloorPlanView
                data={state.projectData}
                activeProjectId={state.activeProjectId}
                onUpdateDevice={handleUpdateDevice}
                onAddDevice={handleAddDevice}
              />
            )}
            {activeView === 'monitor' && (
              <BusMonitorView
                telegrams={state.telegrams}
                busConnected={state.busStatus.connected}
                activeProjectId={state.activeProjectId}
                onClear={handleClearTelegrams}
                onWrite={handleWrite}
                data={state.projectData}
              />
            )}
            {activeView === 'scan' && (
              <BusScanView
                scan={state.scan}
                busConnected={state.busStatus.connected}
                projectData={state.projectData}
                activeProjectId={state.activeProjectId}
                dispatch={dispatch}
                onAddDevice={handleAddScannedDevice}
              />
            )}
            {activeView === 'catalog' && hasProject && (
              <CatalogView
                activeProjectId={state.activeProjectId}
                data={state.projectData}
                onAddDevice={handleAddDevice}
                onPin={handlePin}
              />
            )}
            {activeView === 'printlabels' && hasProject && (
              <PrintLabelsView data={state.projectData} projectId={projectId} />
            )}
            {activeView === 'programming' && hasProject && (
              <ProgrammingView
                data={state.projectData}
                onDeviceStatus={handleDeviceStatus}
              />
            )}
            {activeView === 'pin' && hasProject && activePinKey && (
              <PinDetailView
                pinKey={activePinKey}
                data={state.projectData}
                busStatus={state.busStatus}
                telegrams={state.telegrams}
                onWrite={handleWrite}
                activeProjectId={state.activeProjectId}
                onUpdateGA={handleUpdateGA}
                onUpdateDevice={handleUpdateDevice}
                onUpdateSpace={handleUpdateSpace}
                onGroupJump={handleGAGroupJump}
                onAddDevice={handleAddDevice}
                onUpdateComObjectGAs={handleUpdateComObjectGAs}
                projectId={projectId}
              />
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
    </div>
  );
}
