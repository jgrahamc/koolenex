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
import type { DptMode } from './contexts.ts';
import { DptCtx } from './contexts.ts';
import {
  setI18nT,
  setI18nLang as setI18nLangGlobal,
  setDptInfo,
  setSpaceUsages,
} from './dpt.ts';
import { initialState, reducer } from './state.ts';
import type { BusTelegram } from '../../shared/types.ts';
import { useProjectHandlers } from './hooks/useProjectHandlers.ts';
import { useBusHandlers } from './hooks/useBusHandlers.ts';
import { AppShell } from './AppShell.tsx';

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
  const wsRef = useRef<{ close: () => void } | null>(null);
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
    api
      .busStatus()
      .then((s) => dispatch({ type: 'SET_BUS', status: s }))
      .catch(() => {});

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
            type: msg.connectionType === 'usb' ? 'usb' : 'udp',
            host: (msg.host as string | null) ?? null,
            port: msg.port as number | undefined,
            path: msg.path as string | undefined,
            hasLib: true,
          },
        });
      } else if (msg.type === 'knx:disconnected') {
        dispatch({
          type: 'SET_BUS',
          status: { connected: false, host: null, hasLib: true },
        });
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
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  const projectHandlers = useProjectHandlers(state, dispatch);
  const busHandlers = useBusHandlers(state, dispatch);

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
    ...busHandlers,
    ...projectHandlers,
  };

  return (
    <DptCtx.Provider value={dptMode}>
      <MediumCtx.Provider value={mediumTypes}>
        <MaskCtx.Provider value={maskVersions}>
          <I18nCtx.Provider value={i18n}>
            <Routes>
              <Route path="/" element={<AppShell {...shellProps} />} />
              <Route path="/settings" element={<AppShell {...shellProps} />} />
              <Route
                path="/projects/:id/*"
                element={<ProjectLoader {...shellProps} />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </I18nCtx.Provider>
        </MaskCtx.Provider>
      </MediumCtx.Provider>
    </DptCtx.Provider>
  );
}

/** Loads project data when the URL contains a project ID, then renders AppShell */
function ProjectLoader(props: any) {
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
