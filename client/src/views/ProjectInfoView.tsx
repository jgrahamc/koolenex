import { useState, useEffect, useCallback } from 'react';
import { Btn } from '../primitives.tsx';
import { api } from '../api.ts';
import { BusConnectionPanel } from '../BusConnectionPanel.tsx';
import { useAppData } from '../contexts.ts';
import styles from './ProjectInfoView.module.css';

interface ProjectInfoViewProps {
  lang: string;
  onLangChange: (lang: string) => void;
  languages: Array<{ id: string; name: string }> | null;
}

export function ProjectInfoView({
  lang,
  onLangChange,
  languages,
}: ProjectInfoViewProps) {
  const { projectData: data } = useAppData();
  const project = data?.project;
  const info = (() => {
    try {
      return JSON.parse(project?.project_info || '{}');
    } catch {
      return {};
    }
  })();
  const fmt = (iso: string | undefined) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className={`fi ${styles.root}`}>
      <div className={styles.inner}>
        <div className={styles.heading}>Project</div>

        <BusConnectionPanel />

        <div className={styles.card}>
          <div className={styles.sectionTitleWide}>ETS PROJECT</div>
          {[
            ['Project', project?.name],
            ['File', project?.file_name],
            ['Started', fmt(info.projectStart)],
            ['Last Modified', fmt(info.lastModified)],
            ['Archived', fmt(info.archivedVersion)],
            ['Status', info.completionStatus],
            ['GA Style', info.groupAddressStyle],
            ['GUID', info.guid],
          ]
            .filter(([, v]) => v && v !== '—')
            .map(([label, value]) => (
              <div key={label} className={styles.infoRow}>
                <span className={styles.infoLabel}>{label}</span>
                <span className={styles.infoValue}>{value}</span>
              </div>
            ))}
          {project?.thumbnail && (
            <div className={styles.thumbnailWrap}>
              <img
                src={`data:image/jpeg;base64,${project.thumbnail}`}
                alt=""
                className={styles.thumbnailImg}
              />
            </div>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.sectionTitleWide}>SUMMARY</div>
          {[
            ['Devices', data?.devices?.length],
            ['Group Addresses', data?.gas?.length],
            ['Group Objects', data?.comObjects?.length],
            ['Spaces', data?.spaces?.length],
          ].map(([label, value]) => (
            <div key={label as string} className={styles.summaryRow}>
              <span className={styles.summaryLabel}>{label}</span>
              <span className={styles.summaryValue}>{value ?? '—'}</span>
            </div>
          ))}
        </div>

        <AuditLogSection projectId={project?.id} />

        {languages && languages.length > 1 && (
          <div className={styles.card}>
            <div className={styles.sectionTitleWide}>LANGUAGE</div>
            <div className={styles.langLabel}>KNX DATA LANGUAGE</div>
            <select
              value={lang}
              onChange={(e) => onLangChange(e.target.value)}
              className={styles.langSelect}
            >
              {languages.map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.id})
                </option>
              ))}
            </select>
            <div className={styles.langHint}>
              Translates KNX data types, space usages, and function types.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AuditLogSectionProps {
  projectId: any;
}

function AuditLogSection({ projectId }: AuditLogSectionProps) {
  const [logs, setLogs] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    api
      .getAuditLog(projectId, 200)
      .then((data) => setLogs(data))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (expanded && logs === null) load();
  }, [expanded, logs, load]);

  const actionColor = (a: string) => {
    if (a === 'create' || a === 'import') return 'var(--green)';
    if (a === 'delete') return 'var(--red)';
    if (a === 'update' || a === 'reimport') return 'var(--amber)';
    return 'var(--muted)';
  };

  return (
    <div className={styles.card}>
      <div
        className={styles.auditHeader}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={styles.auditTitle}>AUDIT LOG</div>
        <span className={styles.auditToggle}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className={styles.auditContent}>
          <div className={styles.auditActions}>
            <Btn onClick={load} disabled={loading}>
              {loading ? 'Loading...' : '↻ Refresh'}
            </Btn>
            {projectId && (
              <a
                href={api.auditLogCsvUrl(projectId)}
                download
                className={`${styles.csvLink} ${styles.csvLinkThemed}`}
              >
                ↓ Download CSV
              </a>
            )}
          </div>

          {logs && logs.length === 0 && (
            <div className={styles.auditEmpty}>No audit log entries yet.</div>
          )}

          {logs && logs.length > 0 && (
            <div className={styles.auditTableWrap}>
              <table className={styles.auditTable}>
                <thead>
                  <tr className={styles.auditTheadRow}>
                    {['Time', 'Action', 'Entity', 'ID', 'Detail'].map((h) => (
                      <th key={h} className={styles.auditTh}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map((r: any) => (
                    <tr key={r.id} className={styles.auditRowBorder}>
                      <td
                        className={`${styles.auditTd} ${styles.auditTimestamp}`}
                      >
                        {r.timestamp}
                      </td>
                      <td
                        className={`${styles.auditTd} ${styles.auditAction}`}
                        style={{ color: actionColor(r.action) }}
                      >
                        {r.action}
                      </td>
                      <td className={`${styles.auditTd} ${styles.auditEntity}`}>
                        {r.entity}
                      </td>
                      <td
                        className={`${styles.auditTd} ${styles.auditEntityId}`}
                      >
                        {r.entity_id}
                      </td>
                      <td className={`${styles.auditTd} ${styles.auditDetail}`}>
                        {r.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
