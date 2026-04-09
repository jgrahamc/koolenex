import { useState, useRef } from 'react';
import { Btn, Spinner } from '../primitives.tsx';
import { api } from '../api.ts';
import styles from './ProjectsView.module.css';

interface ProjectsViewProps {
  state: any;
  dispatch: (action: any) => void;
}

export function ProjectsView({ state, dispatch }: ProjectsViewProps) {
  const [newName, setNewName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProject = async (id: any) => {
    dispatch({ type: 'SET_LOADING', loading: true });
    try {
      const data = await api.getProject(id);
      dispatch({ type: 'SET_ACTIVE', id, data });
      const tgs = await api.listTelegrams(id);
      dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
    } catch (e: any) {
      dispatch({ type: 'SET_ERROR', error: e.message });
    }
    dispatch({ type: 'SET_LOADING', loading: false });
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    const p = await api.createProject(newName.trim());
    dispatch({ type: 'SET_PROJECTS', projects: [p, ...state.projects] });
    setNewName('');
    loadProject(p.id);
  };

  const deleteProject = async (e: React.MouseEvent, id: any) => {
    e.stopPropagation();
    if (!confirm('Delete this project and all its data?')) return;
    await api.deleteProject(id);
    dispatch({
      type: 'SET_PROJECTS',
      projects: state.projects.filter((p: any) => p.id !== id),
    });
  };

  const doImport = async (file: File, password: string | null = null) => {
    const fd = new FormData();
    fd.append('file', file);
    if (password) fd.append('password', password);
    const result = await api.importETS(fd);
    setImportResult({
      ok: true,
      summary: result.summary,
      projectId: result.projectId,
      name: result.data?.project?.name,
    });
    const projs = await api.listProjects();
    dispatch({ type: 'SET_PROJECTS', projects: projs });
    setPendingFile(null);
    setImportPassword('');
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      await doImport(file);
    } catch (err: any) {
      if (err.code === 'PASSWORD_REQUIRED') {
        setPendingFile(file);
        setImportResult({ ok: false, passwordRequired: true });
      } else {
        setImportResult({ ok: false, error: err.message });
      }
    }
    setImporting(false);
    e.target.value = '';
  };

  const handleImportWithPassword = async () => {
    if (!pendingFile || !importPassword) return;
    setImporting(true);
    try {
      await doImport(pendingFile, importPassword);
    } catch (err: any) {
      if (
        err.code === 'PASSWORD_INCORRECT' ||
        err.code === 'PASSWORD_REQUIRED'
      ) {
        setImportResult({
          ok: false,
          passwordRequired: true,
          error: 'Incorrect password — try again',
        });
      } else {
        setImportResult({ ok: false, error: err.message });
      }
    }
    setImporting(false);
  };

  return (
    <div className={`fi ${styles.root}`}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <img src="/icon.svg" alt="koolenex" className={styles.logo} />
          <div className={styles.title}>KOOLENEX</div>
        </div>

        {/* Import ETS */}
        <div className={styles.importCard}>
          <div className={styles.importHint}>
            Import an ETS6 project file (.knxproj)
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".knxproj"
            onChange={handleImport}
            className={styles.hidden}
          />
          <Btn onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? (
              <>
                <Spinner /> Parsing…
              </>
            ) : (
              '⊠ Import .knxproj'
            )}
          </Btn>
          {importResult && (
            <div
              className={
                importResult.ok
                  ? styles.importResultOk
                  : importResult.passwordRequired
                    ? styles.importResultPassword
                    : styles.importResultError
              }
            >
              {importResult.ok ? (
                <>
                  <div className={styles.importSuccess}>
                    ✓ Imported: {importResult.name}
                  </div>
                  <div className={styles.importSummary}>
                    {importResult.summary.devices} devices ·{' '}
                    {importResult.summary.groupAddresses} GAs ·{' '}
                    {importResult.summary.comObjects} group objects ·{' '}
                    {importResult.summary.links} links
                  </div>
                  <Btn
                    onClick={() => loadProject(importResult.projectId)}
                    className={styles.openBtn}
                  >
                    Open Project →
                  </Btn>
                </>
              ) : importResult.passwordRequired ? (
                <>
                  <div className={styles.passwordTitle}>
                    ⚿ Password protected
                  </div>
                  {importResult.error && (
                    <div className={styles.passwordError}>
                      {importResult.error}
                    </div>
                  )}
                  <div className={styles.passwordRow}>
                    <input
                      type="password"
                      value={importPassword}
                      onChange={(e) => setImportPassword(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && handleImportWithPassword()
                      }
                      placeholder="Project password…"
                      autoFocus
                      className={styles.passwordInput}
                    />
                    <Btn
                      onClick={handleImportWithPassword}
                      disabled={!importPassword || importing}
                    >
                      {importing ? <Spinner /> : 'Unlock'}
                    </Btn>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.importError}>✗ Import failed</div>
                  <div className={styles.importErrorDetail}>
                    {importResult.error}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* New project */}
        <div className={styles.newRow}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createProject()}
            placeholder="New project name…"
            className={styles.newInput}
          />
          <Btn onClick={createProject}>⊕ Create</Btn>
        </div>

        {/* Projects list */}
        {state.projects.length > 0 && (
          <div>
            <div className={styles.listLabel}>RECENT PROJECTS</div>
            {state.projects.map((p: any) => (
              <div
                key={p.id}
                className={`rh fi ${styles.projectCard}`}
                onClick={() => loadProject(p.id)}
              >
                {p.thumbnail && (
                  <img
                    src={`data:image/jpeg;base64,${p.thumbnail}`}
                    alt=""
                    className={styles.thumbnail}
                  />
                )}
                <div className={styles.projectInfo}>
                  <div className={styles.projectName}>{p.name}</div>
                  <div className={styles.projectMeta}>
                    {p.file_name && (
                      <span className={styles.projectFileName}>
                        {p.file_name} ·{' '}
                      </span>
                    )}
                    {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => deleteProject(e, p.id)}
                  className={`bg ${styles.deleteBtn}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {state.projects.length === 0 && !importing && (
          <div className={styles.emptyMsg}>
            No projects yet. Import a .knxproj or create a blank project.
          </div>
        )}
      </div>
    </div>
  );
}
