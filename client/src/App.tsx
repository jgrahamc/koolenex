import { useState, useEffect, useRef, useReducer, useMemo } from 'react';
import {
  Routes,
  Route,
  Navigate,
  useParams,
  useNavigate,
} from 'react-router-dom';
import './global.css';
import { api, createWS } from './api.ts';
import { MediumCtx, MaskCtx, I18nCtx } from './theme.ts';
import type {
  DptMode,
  ProjectActions,
  BusActions,
  UndoActions,
  AppData,
  LiveData,
} from './contexts.ts';
import {
  DptCtx,
  ProjectActionsCtx,
  BusActionsCtx,
  UndoCtx,
  AppDataCtx,
  LiveDataCtx,
  VerifyCacheCtx,
  ProgrammingLogCtx,
  PROGRAMMING_LOG_CAP,
} from './contexts.ts';
import type {
  VerifyCache,
  VerifyProgress,
  ProgramProgress,
  ProgrammingLog,
} from './contexts.ts';
import {
  setI18nT,
  setI18nLang as setI18nLangGlobal,
  setDptInfo,
  setSpaceUsages,
} from './dpt.ts';
import {
  initialState,
  reducer,
  loadVerifyCache,
  saveVerifyCache,
} from './state.ts';
import type { BusTelegram } from '../../shared/types.ts';
import { useProjectHandlers } from './hooks/useProjectHandlers.ts';
import { useBusHandlers } from './hooks/useBusHandlers.ts';
import { AppShell } from './AppShell.tsx';
import type { AppShellProps } from './AppShell.tsx';

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('knx-theme') || 'dark',
  );
  const handleThemeChange = (t: string) => {
    setTheme(t);
    localStorage.setItem('knx-theme', t);
  };
  // Sync theme to document root so CSS custom properties apply globally
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [dptMode, setDptMode] = useState<DptMode>(() => {
    const saved = localStorage.getItem('knx-dpt-mode');
    const valid: DptMode[] = ['numeric', 'formal', 'friendly'];
    return valid.includes(saved as DptMode) ? (saved as DptMode) : 'numeric';
  });
  const handleDptModeChange = (m: string) => {
    setDptMode(m as DptMode);
    localStorage.setItem('knx-dpt-mode', m);
  };

  const [state, dispatch] = useReducer(reducer, initialState);
  // Persist verify results across reloads - see loadVerifyCache/saveVerifyCache
  // in state.ts (IndexedDB, not localStorage - a single device's decoded
  // result routinely exceeds localStorage's whole quota). Both are async;
  // load once on mount, save (fire-and-forget) on every change thereafter.
  useEffect(() => {
    loadVerifyCache().then((cache) =>
      dispatch({ type: 'HYDRATE_VERIFY_CACHE', cache }),
    );
  }, []);
  useEffect(() => {
    saveVerifyCache(state.verifyCache);
  }, [state.verifyCache]);
  const wsRef = useRef<{
    close: () => void;
    send: (data: Record<string, unknown>) => void;
  } | null>(null);
  // Live verify-read progress, keyed by device address. Transient/high-
  // frequency (one WS message per bus chunk, up to ~900 per relmem verify) -
  // kept out of the main reducer deliberately so it doesn't churn state
  // updates that unrelated views would also re-render for.
  const [verifyProgress, setVerifyProgress] = useState<
    Record<string, VerifyProgress>
  >({});
  // Live Program (write) progress, keyed by device address - see
  // ProgramProgress's doc comment (contexts.ts) for why this exists.
  const [programProgress, setProgramProgress] = useState<
    Record<string, ProgramProgress>
  >({});
  // Programming page's operation log - lifted up here (rather than local
  // state in ProgrammingView) so it survives navigating away and back. See
  // the comment on ProgrammingLogCtx for the retention policy.
  const [programmingLogEntries, setProgrammingLogEntries] = useState<
    string[]
  >([]);
  // Whether to include server-tagged debug messages in the programming
  // log (see ProgrammingLog's own doc comment, contexts.ts). Read via a
  // ref inside the WebSocket handler below (a `[]`-deps effect - see its
  // own comment) so a later toggle isn't stuck reading a stale closure
  // value.
  const [showDebugLog, setShowDebugLog] = useState<boolean>(
    () => localStorage.getItem('knx-programming-debug-log') === 'true',
  );
  const showDebugLogRef = useRef(showDebugLog);
  useEffect(() => {
    showDebugLogRef.current = showDebugLog;
  }, [showDebugLog]);
  const toggleShowDebugLog = () => {
    setShowDebugLog((v) => {
      const next = !v;
      try {
        localStorage.setItem('knx-programming-debug-log', String(next));
      } catch {}
      return next;
    });
  };
  const [mediumTypes, setMediumTypes] = useState<Record<string, any>>({});
  const [maskVersions, setMaskVersions] = useState<Record<string, any>>({});
  const [i18nLang, setI18nLang] = useState<string>(
    () => localStorage.getItem('knx-lang') || 'en-US',
  );
  const [i18nData, setI18nData] = useState<{
    languages: any[];
    translations: Record<string, any>;
  }>({ languages: [], translations: {} });
  const handleLangChange = (l: string) => {
    setI18nLang(l);
    localStorage.setItem('knx-lang', l);
    dispatch({ type: 'DPT_LOADED' });
  };
  const i18n = useMemo(() => {
    const texts = i18nData.translations[i18nLang] || {};
    const enTexts = i18nData.translations['en-US'] || {};
    const t = (refId: string) => texts[refId] || enTexts[refId] || null;
    setI18nT(t); // update module-level reference for dptName/dptTitle
    setI18nLangGlobal(i18nLang); // update module-level language for localizedModel
    return { lang: i18nLang, languages: i18nData.languages, t };
  }, [i18nLang, i18nData]);

  /** Load DPT info, space usages, medium types, mask versions, and translations. */
  function loadMasterData(pid?: number) {
    const warn = (label: string) => (e: Error) =>
      console.warn(`[app] ${label} failed`, e.message);
    api
      .getDptInfo(pid)
      .then((data: any) => {
        if (data && Object.keys(data).length > 0) {
          setDptInfo(data);
          dispatch({ type: 'DPT_LOADED' });
        }
      })
      .catch(warn('getDptInfo'));
    api
      .getSpaceUsages(pid)
      .then((data: any) => {
        if (data?.length) setSpaceUsages(data);
      })
      .catch(warn('getSpaceUsages'));
    api
      .getMediumTypes(pid)
      .then((d) => setMediumTypes(d as Record<string, any>))
      .catch(warn('getMediumTypes'));
    api
      .getMaskVersions(pid)
      .then((d) => setMaskVersions(d as Record<string, any>))
      .catch(warn('getMaskVersions'));
    api
      .getTranslations(pid)
      .then((d) =>
        setI18nData(
          d as { languages: any[]; translations: Record<string, any> },
        ),
      )
      .catch(warn('getTranslations'));
  }

  // Persist active project, notify server, reload master data
  useEffect(() => {
    if (state.activeProjectId) {
      localStorage.setItem('knx-active-project', String(state.activeProjectId));
      api.busSetProject(state.activeProjectId).catch(() => {});
      loadMasterData(state.activeProjectId);
    }
  }, [state.activeProjectId]);

  // Boot: load projects + bus status, then auto-restore last session
  useEffect(() => {
    loadMasterData();

    (async () => {
      try {
        const projects = await api.listProjects();
        dispatch({ type: 'SET_PROJECTS', projects });
      } catch {}
    })();
    // Shared by the initial boot fetch AND every WebSocket (re)connect (see
    // createWS's onOpen below) - a reconnect used to never re-check real bus
    // status at all, so a connection change that happened while the socket
    // was down (e.g. the server restarting) left the UI showing stale state
    // indefinitely. Fixed 2026-08-29.
    const syncBusStatus = () =>
      api
        .busStatus()
        .then((s) => dispatch({ type: 'SET_BUS', status: s }))
        .catch(() => {});
    syncBusStatus();

    // WebSocket for live telegrams + bus events
    const ws = createWS((msg: Record<string, unknown>) => {
      if (msg.type === 'knx:telegram') {
        dispatch({
          type: 'ADD_TELEGRAM',
          telegram: msg.telegram as BusTelegram,
        });
      } else if (msg.type === 'knx:connected') {
        dispatch({
          type: 'SET_BUS',
          status: {
            connected: true,
            type:
              msg.connectionType === 'usb'
                ? 'usb'
                : msg.connectionType === 'tcp'
                  ? 'tcp'
                  : 'udp',
            host: (msg.host as string | null) ?? null,
            port: msg.port as number | undefined,
            path: msg.path as string | undefined,
            hasLib: true,
          },
        });
      } else if (msg.type === 'knx:disconnected') {
        // needsAttention deliberately absent (defaults falsy) - a fresh
        // drop reads as calm/idle first; only 'knx:reconnect-failed'
        // (below), sent once a reconnect attempt genuinely fails, escalates
        // it. See state.ts's BusStatus.needsAttention doc comment.
        dispatch({
          type: 'SET_BUS',
          status: { connected: false, host: null, hasLib: true },
        });
      } else if (msg.type === 'knx:reconnect-failed') {
        dispatch({ type: 'SET_BUS_ATTENTION', needsAttention: true });
      } else if (msg.type === 'verify:progress') {
        const deviceAddress = msg.deviceAddress as string;
        setVerifyProgress((p) => ({
          ...p,
          [deviceAddress]: {
            bytesRead: msg.bytesRead as number,
            totalBytes: msg.totalBytes as number,
            pct: msg.pct as number,
          },
        }));
      } else if (msg.type === 'program:progress') {
        const deviceAddress = msg.deviceAddress as string;
        setProgramProgress((p) => ({
          ...p,
          [deviceAddress]: {
            msg: msg.msg as string,
            pct: msg.pct as number | undefined,
            done: msg.done as boolean | undefined,
            error: msg.error as boolean | undefined,
            // Real request, 2026-08-31: a dedicated "press the button"
            // modal needs a reliable signal distinct from every other
            // progress message - see /bus/program-device's own pre-
            // flight (server/routes/bus.ts) and DownloadProgress's own
            // doc comment (server/knx-connection.ts) for why this is only
            // ever true on the one message announcing the wait.
            awaitingButton: msg.awaitingButton as boolean | undefined,
          },
        }));
        // Real request, 2026-08-31: "each step should also show in the
        // log, with reasonable details" - every program:progress message
        // previously only ever updated the button's own inline text/
        // percentage, never the actual log panel. `msg.debug` (see
        // DownloadProgress's own doc comment, knx-connection.ts) filters
        // this at the source, not just at render time, when the debug-log
        // preference is off - `programProgress` above still gets every
        // message regardless (the live progress bar/awaitingButton modal
        // must never depend on this display preference).
        if (!msg.debug || showDebugLogRef.current) {
          setProgrammingLogEntries((l) =>
            [
              `[${new Date().toLocaleTimeString()}] ${deviceAddress}: ${msg.msg as string}`,
              ...l,
            ].slice(0, PROGRAMMING_LOG_CAP),
          );
        }
      } else if (msg.type === 'scan:progress') {
        dispatch({
          type: 'SCAN_PROGRESS',
          progress: msg as Record<string, unknown> & {
            address?: string;
            descriptor?: string;
            reachable?: boolean;
            done?: number;
            total?: number;
          },
        });
      } else if (msg.type === 'scan:done') {
        dispatch({
          type: 'SCAN_DONE',
          results:
            (msg.results as Array<{ address: string; descriptor: string }>) ||
            [],
        });
      } else if (msg.type === 'scan:error') {
        dispatch({ type: 'SCAN_RESET' });
      } else if (msg.type === 'import:started') {
        dispatch({
          type: 'IMPORT_STARTED',
          importId: msg.importId as string,
          mode: msg.mode as 'import' | 'reimport',
          fileName: (msg.fileName as string) || '',
        });
      } else if (msg.type === 'import:password-required') {
        dispatch({
          type: 'IMPORT_PASSWORD_REQUIRED',
          importId: msg.importId as string,
          retry: !!msg.retry,
        });
      } else if (msg.type === 'import:done') {
        dispatch({
          type: 'IMPORT_DONE',
          importId: msg.importId as string,
          projectId: msg.projectId as number,
          summary: msg.summary as {
            devices: number;
            groupAddresses: number;
            comObjects: number;
            links: number;
          },
        });
        api
          .listProjects()
          .then((projects) => dispatch({ type: 'SET_PROJECTS', projects }))
          .catch(() => {});
      } else if (msg.type === 'import:failed') {
        dispatch({
          type: 'IMPORT_FAILED',
          importId: msg.importId as string,
          error: (msg.error as string) || 'Import failed',
          code: msg.code as string | undefined,
        });
      }
    }, syncBusStatus);
    wsRef.current = ws;

    // Re-attach to an in-flight import if the user refreshed mid-parse.
    const savedImportId = (() => {
      try {
        return localStorage.getItem('knx-active-import');
      } catch {
        return null;
      }
    })();
    if (savedImportId) {
      api
        .getImportStatus(savedImportId)
        .then((s) => {
          if (s.status === 'done' && s.projectId && s.summary) {
            dispatch({
              type: 'IMPORT_DONE',
              importId: s.importId,
              projectId: s.projectId,
              summary: s.summary,
            });
          } else if (s.status === 'failed') {
            dispatch({
              type: 'IMPORT_FAILED',
              importId: s.importId,
              error: s.error || 'Import failed',
              code: s.code,
            });
          } else if (s.status === 'password-required') {
            dispatch({
              type: 'IMPORT_PASSWORD_REQUIRED',
              importId: s.importId,
              retry: !!s.passwordRetry,
            });
          } else if (s.status === 'parsing') {
            dispatch({
              type: 'IMPORT_STARTED',
              importId: s.importId,
              mode: s.mode,
              fileName: s.fileName,
            });
          }
        })
        .catch(() => {
          try {
            localStorage.removeItem('knx-active-import');
          } catch {}
        });
    }

    return () => ws.close();
  }, []);

  const projectHandlers = useProjectHandlers(state, dispatch);
  const busHandlers = useBusHandlers(state, dispatch);

  const projectActions: ProjectActions = useMemo(
    () => ({
      updateGA: projectHandlers.handleUpdateGA,
      renameGAGroup: projectHandlers.handleRenameGAGroup,
      updateDevice: projectHandlers.handleUpdateDevice,
      unassignDevice: projectHandlers.handleUnassignDevice,
      updateSpace: projectHandlers.handleUpdateSpace,
      createTopology: projectHandlers.handleCreateTopology,
      updateTopology: projectHandlers.handleUpdateTopology,
      deleteTopology: projectHandlers.handleDeleteTopology,
      createSpace: projectHandlers.handleCreateSpace,
      deleteSpace: projectHandlers.handleDeleteSpace,
      createGA: projectHandlers.handleCreateGA,
      deleteGA: projectHandlers.handleDeleteGA,
      addDevice: projectHandlers.handleAddDevice,
      updateComObjectGAs: projectHandlers.handleUpdateComObjectGAs,
      updateComObjectFlags: projectHandlers.handleUpdateComObjectFlags,
      addScannedDevice: projectHandlers.handleAddScannedDevice,
      applyDeviceStatus: projectHandlers.applyDeviceStatus,
      applyDeviceVerifyCleared: projectHandlers.applyDeviceVerifyCleared,
      applyDeviceVerifyResult: projectHandlers.applyDeviceVerifyResult,
    }),
    [projectHandlers],
  );

  const busActions: BusActions = useMemo(
    () => ({
      connect: busHandlers.handleConnect,
      connectUsb: busHandlers.handleConnectUsb,
      disconnect: busHandlers.handleDisconnect,
      deviceStatus: busHandlers.handleDeviceStatus,
      write: busHandlers.handleWrite,
      clearTelegrams: busHandlers.handleClearTelegrams,
      watchStart: () => wsRef.current?.send({ type: 'watch:start' }),
      watchStop: () => wsRef.current?.send({ type: 'watch:stop' }),
    }),
    [busHandlers],
  );

  const undoActions: UndoActions = useMemo(
    () => ({
      undoStackRef: projectHandlers.undoStackRef,
      undoCount: projectHandlers.undoCount,
      undoOpen: projectHandlers.undoOpen,
      setUndoOpen: projectHandlers.setUndoOpen,
      performUndo: projectHandlers.performUndo,
      toast: projectHandlers.toast,
      setToast: projectHandlers.setToast,
    }),
    [projectHandlers],
  );

  const appData: AppData = useMemo(
    () => ({
      projectData: state.projectData,
      activeProjectId: state.activeProjectId,
    }),
    [state.projectData, state.activeProjectId],
  );

  const liveData: LiveData = useMemo(
    () => ({
      busStatus: state.busStatus,
      telegrams: state.telegrams,
    }),
    [state.busStatus, state.telegrams],
  );

  const verifyCache: VerifyCache = useMemo(
    () => ({
      cache: state.verifyCache,
      setResult: (deviceId, result) =>
        dispatch({ type: 'SET_VERIFY_RESULT', deviceId, result }),
      clearResult: (deviceId) =>
        dispatch({ type: 'CLEAR_VERIFY_RESULT', deviceId }),
      progress: verifyProgress,
      programProgress,
      clearProgramProgress: (deviceAddress: string) =>
        setProgramProgress((p) => {
          if (!(deviceAddress in p)) return p;
          const next = { ...p };
          delete next[deviceAddress];
          return next;
        }),
    }),
    [state.verifyCache, verifyProgress, programProgress],
  );

  const programmingLog: ProgrammingLog = useMemo(
    () => ({
      entries: programmingLogEntries,
      add: (line) =>
        setProgrammingLogEntries((l) =>
          [line, ...l].slice(0, PROGRAMMING_LOG_CAP),
        ),
      clear: () => setProgrammingLogEntries([]),
      showDebug: showDebugLog,
      toggleShowDebug: toggleShowDebugLog,
    }),
    [programmingLogEntries, showDebugLog],
  );

  const shellProps = {
    state,
    dispatch,
    theme,
    onThemeChange: handleThemeChange,
    dptMode,
    onDptModeChange: handleDptModeChange,
    i18nLang,
    onLangChange: handleLangChange,
    i18nLanguages: i18nData.languages,
  };

  return (
    <DptCtx.Provider value={dptMode}>
      <MediumCtx.Provider value={mediumTypes}>
        <MaskCtx.Provider value={maskVersions}>
          <I18nCtx.Provider value={i18n}>
            <AppDataCtx.Provider value={appData}>
              <LiveDataCtx.Provider value={liveData}>
                <VerifyCacheCtx.Provider value={verifyCache}>
                  <ProgrammingLogCtx.Provider value={programmingLog}>
                    <ProjectActionsCtx.Provider value={projectActions}>
                      <BusActionsCtx.Provider value={busActions}>
                        <UndoCtx.Provider value={undoActions}>
                          <Routes>
                            <Route
                              path="/"
                              element={<AppShell {...shellProps} />}
                            />
                            <Route
                              path="/settings"
                              element={<AppShell {...shellProps} />}
                            />
                            <Route
                              path="/projects/:id/*"
                              element={<ProjectLoader {...shellProps} />}
                            />
                            <Route
                              path="*"
                              element={<Navigate to="/" replace />}
                            />
                          </Routes>
                        </UndoCtx.Provider>
                      </BusActionsCtx.Provider>
                    </ProjectActionsCtx.Provider>
                  </ProgrammingLogCtx.Provider>
                </VerifyCacheCtx.Provider>
              </LiveDataCtx.Provider>
            </AppDataCtx.Provider>
          </I18nCtx.Provider>
        </MaskCtx.Provider>
      </MediumCtx.Provider>
    </DptCtx.Provider>
  );
}

/** Loads project data when the URL contains a project ID, then renders AppShell */
function ProjectLoader(props: AppShellProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, dispatch } = props;
  const projectId = Number(id);
  const loadedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!projectId || isNaN(projectId)) {
      navigate('/', { replace: true });
      return;
    }
    // Already loaded this project
    if (state.activeProjectId === projectId && state.projectData) return;
    // Already loading this project
    if (loadedRef.current === projectId) return;
    loadedRef.current = projectId;

    (async () => {
      dispatch({ type: 'SET_LOADING', loading: true });
      try {
        // Make sure projects list is available
        if (!state.projects.length) {
          const projects = await api.listProjects();
          dispatch({ type: 'SET_PROJECTS', projects });
        }
        const data = await api.getProject(projectId);
        dispatch({ type: 'SET_ACTIVE', id: projectId, data });
        const tgs = await api.listTelegrams(projectId);
        dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
      } catch {
        navigate('/', { replace: true });
      }
      dispatch({ type: 'SET_LOADING', loading: false });
    })();
  }, [
    projectId,
    state.activeProjectId,
    state.projectData,
    state.projects.length,
    dispatch,
    navigate,
  ]);

  return <AppShell {...props} />;
}
