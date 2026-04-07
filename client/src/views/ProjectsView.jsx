import { useState, useRef } from 'react';
import { useC } from '../theme.ts';
import { Btn, Spinner } from '../primitives.jsx';
import { api } from '../api.ts';

export function ProjectsView({ state, dispatch }) {
  const C = useC();
  const [newName, setNewName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [importPassword, setImportPassword] = useState('');
  const fileRef = useRef(null);

  const loadProject = async (id) => {
    dispatch({ type: 'SET_LOADING', loading: true });
    try {
      const data = await api.getProject(id);
      dispatch({ type: 'SET_ACTIVE', id, data });
      // Load telegrams
      const tgs = await api.listTelegrams(id);
      dispatch({ type: 'SET_TELEGRAMS', telegrams: tgs });
    } catch (e) {
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

  const deleteProject = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this project and all its data?')) return;
    await api.deleteProject(id);
    dispatch({
      type: 'SET_PROJECTS',
      projects: state.projects.filter((p) => p.id !== id),
    });
  };

  const doImport = async (file, password = null) => {
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

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      await doImport(file);
    } catch (err) {
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
    } catch (err) {
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
    <div
      className="fi"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
      }}
    >
      <div style={{ width: 560 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <img
            src="/icon.svg"
            alt="koolenex"
            style={{ width: 64, height: 64, marginBottom: 10 }}
          />
          <div
            style={{
              fontFamily: "'Syne',sans-serif",
              fontWeight: 800,
              fontSize: 28,
              color: C.text,
              letterSpacing: '0.06em',
            }}
          >
            KOOLENEX
          </div>
        </div>

        {/* Import ETS */}
        <div
          style={{
            background: C.surface,
            border: `1px dashed ${C.border2}`,
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
            Import an ETS6 project file (.knxproj)
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".knxproj"
            onChange={handleImport}
            style={{ display: 'none' }}
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
              style={{
                marginTop: 12,
                padding: '10px 14px',
                background: importResult.ok
                  ? '#0a1a0e'
                  : importResult.passwordRequired
                    ? '#0e0e00'
                    : '#1a0a0a',
                border: `1px solid ${importResult.ok ? C.green : importResult.passwordRequired ? C.amber : C.red}33`,
                borderRadius: 6,
                fontSize: 11,
                textAlign: 'left',
              }}
            >
              {importResult.ok ? (
                <>
                  <div
                    style={{ fontWeight: 600, color: C.green, marginBottom: 5 }}
                  >
                    ✓ Imported: {importResult.name}
                  </div>
                  <div style={{ color: C.muted }}>
                    {importResult.summary.devices} devices ·{' '}
                    {importResult.summary.groupAddresses} GAs ·{' '}
                    {importResult.summary.comObjects} group objects ·{' '}
                    {importResult.summary.links} links
                  </div>
                  <Btn
                    onClick={() => loadProject(importResult.projectId)}
                    style={{ marginTop: 8 }}
                  >
                    Open Project →
                  </Btn>
                </>
              ) : importResult.passwordRequired ? (
                <>
                  <div
                    style={{ fontWeight: 600, color: C.amber, marginBottom: 6 }}
                  >
                    ⚿ Password protected
                  </div>
                  {importResult.error && (
                    <div
                      style={{ color: C.red, marginBottom: 8, fontSize: 10 }}
                    >
                      {importResult.error}
                    </div>
                  )}
                  <div
                    style={{ display: 'flex', gap: 8, alignItems: 'center' }}
                  >
                    <input
                      type="password"
                      value={importPassword}
                      onChange={(e) => setImportPassword(e.target.value)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && handleImportWithPassword()
                      }
                      placeholder="Project password…"
                      autoFocus
                      style={{
                        flex: 1,
                        background: C.inputBg,
                        border: `1px solid ${C.border2}`,
                        borderRadius: 4,
                        padding: '6px 10px',
                        color: C.text,
                        fontSize: 11,
                        fontFamily: 'inherit',
                      }}
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
                  <div style={{ fontWeight: 600, color: C.red }}>
                    ✗ Import failed
                  </div>
                  <div style={{ color: C.muted, marginTop: 3 }}>
                    {importResult.error}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* New project */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createProject()}
            placeholder="New project name…"
            style={{
              flex: 1,
              background: C.inputBg,
              border: `1px solid ${C.border2}`,
              borderRadius: 4,
              padding: '6px 10px',
              color: C.text,
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
          <Btn onClick={createProject}>⊕ Create</Btn>
        </div>

        {/* Projects list */}
        {state.projects.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.1em',
                marginBottom: 8,
              }}
            >
              RECENT PROJECTS
            </div>
            {state.projects.map((p) => (
              <div
                key={p.id}
                className="rh fi"
                onClick={() => loadProject(p.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '12px 16px',
                  borderRadius: 8,
                  marginBottom: 6,
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  cursor: 'pointer',
                  gap: 14,
                }}
              >
                {p.thumbnail && (
                  <img
                    src={`data:image/jpeg;base64,${p.thumbnail}`}
                    alt=""
                    style={{
                      width: 64,
                      height: 48,
                      objectFit: 'cover',
                      borderRadius: 4,
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
                    {p.file_name && (
                      <span style={{ color: C.muted }}>{p.file_name} · </span>
                    )}
                    {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => deleteProject(e, p.id)}
                  className="bg"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: C.dim,
                    fontSize: 14,
                    cursor: 'pointer',
                    padding: '4px 8px',
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {state.projects.length === 0 && !importing && (
          <div style={{ textAlign: 'center', color: C.dim, fontSize: 12 }}>
            No projects yet. Import a .knxproj or create a blank project.
          </div>
        )}
      </div>
    </div>
  );
}
