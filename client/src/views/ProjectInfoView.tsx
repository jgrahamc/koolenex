import { useState, useEffect, useCallback } from 'react';
import { Btn, Spinner } from '../primitives.tsx';
import { api } from '../api.ts';
import styles from './ProjectInfoView.module.css';

interface ProjectInfoViewProps {
  project: any;
  data: any;
  lang: string;
  onLangChange: (lang: string) => void;
  languages: any[] | null;
  busStatus: any;
  onConnect: (host: string, port: number) => Promise<unknown>;
  onConnectUsb: (path: string) => Promise<unknown>;
  onDisconnect: () => void;
}

export function ProjectInfoView({
  project,
  data,
  lang,
  onLangChange,
  languages,
  busStatus,
  onConnect,
  onConnectUsb,
  onDisconnect,
}: ProjectInfoViewProps) {
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

  const [tab, setTab] = useState(busStatus.type === 'usb' ? 'usb' : 'ip');
  const [host, setHost] = useState(busStatus.host || '');
  const [port, setPort] = useState(String(busStatus.port || '3671'));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // USB state
  const [usbDevices, setUsbDevices] = useState<any[] | null>(null);
  const [usbLoading, setUsbLoading] = useState(false);
  const [selectedUsb, setSelectedUsb] = useState('');

  useEffect(() => {
    if (busStatus.connected) return;
    api
      .getSettings()
      .then((s: any) => {
        if (s.knxip_host) setHost(s.knxip_host);
        if (s.knxip_port) setPort(s.knxip_port);
      })
      .catch(() => {});
  }, []);

  const doConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await onConnect(host, parseInt(port));
    } catch (e: any) {
      setError(e.message);
    }
    setConnecting(false);
  };

  const doConnectUsb = async () => {
    if (!selectedUsb) return;
    setConnecting(true);
    setError(null);
    try {
      await onConnectUsb(selectedUsb);
    } catch (e: any) {
      setError(e.message);
    }
    setConnecting(false);
  };

  const scanUsb = async () => {
    setUsbLoading(true);
    setError(null);
    try {
      const res = (await api.busUsbDevices()) as {
        devices?: any[];
        error?: string;
      };
      setUsbDevices(res.devices || []);
      if (res.error) setError(res.error);
      if (res.devices?.length === 1) setSelectedUsb(res.devices[0].path);
    } catch (e: any) {
      setError(e.message);
      setUsbDevices([]);
    }
    setUsbLoading(false);
  };

  const tabClass = (id: string) =>
    tab === id ? styles.tabActive : styles.tabInactive;

  return (
    <div className={`fi ${styles.root}`}>
      <div className={styles.inner}>
        <div className={styles.heading}>Project</div>

        <div className={styles.card}>
          <div className={styles.sectionTitle}>BUS CONNECTION</div>

          {!busStatus.connected && (
            <div className={styles.tabRow}>
              <button
                className={`${styles.tabBtn} ${tabClass('ip')}`}
                onClick={() => setTab('ip')}
              >
                KNXnet/IP
              </button>
              <button
                className={`${styles.tabBtn} ${tabClass('usb')}`}
                onClick={() => setTab('usb')}
              >
                USB
              </button>
            </div>
          )}

          {busStatus.connected ? (
            <div className={styles.connectedRow}>
              <span className={styles.connectedLabel}>
                {busStatus.type === 'usb'
                  ? '● Connected via USB'
                  : `● Connected to ${busStatus.host}:${busStatus.port || 3671}`}
              </span>
              <Btn onClick={onDisconnect} color="var(--red)" bg="#1a0a0a">
                Disconnect
              </Btn>
            </div>
          ) : tab === 'ip' ? (
            <>
              <div className={styles.ipRow}>
                <div className={styles.ipCol}>
                  <div className={styles.fieldLabel}>IP ADDRESS</div>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className={styles.textInput}
                  />
                </div>
                <div className={styles.portCol}>
                  <div className={styles.fieldLabel}>PORT</div>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className={styles.textInput}
                  />
                </div>
              </div>
              {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}
              <Btn onClick={doConnect} disabled={connecting}>
                {connecting ? (
                  <>
                    <Spinner /> Connecting...
                  </>
                ) : (
                  '⟲ Connect'
                )}
              </Btn>
            </>
          ) : (
            <>
              <div className={styles.usbScanBtn}>
                <Btn onClick={scanUsb} disabled={usbLoading}>
                  {usbLoading ? (
                    <>
                      <Spinner /> Scanning...
                    </>
                  ) : (
                    '⟲ Scan for USB devices'
                  )}
                </Btn>
              </div>

              {usbDevices !== null &&
                usbDevices.length === 0 &&
                !usbLoading && (
                  <div className={styles.noUsbMsg}>
                    No KNX USB devices found. Make sure the device is plugged in
                    and <code className={styles.codeBg}>node-hid</code> is
                    installed.
                  </div>
                )}

              {usbDevices && usbDevices.length > 0 && (
                <div className={styles.usbList}>
                  <div className={styles.fieldLabel}>SELECT DEVICE</div>
                  {usbDevices.map((d: any) => {
                    const label =
                      d.knxName ||
                      [d.manufacturer, d.product].filter(Boolean).join(' ') ||
                      `USB ${d.vendorId?.toString(16)}:${d.productId?.toString(16)}`;
                    const subtitle = d.knxName
                      ? [d.manufacturer, d.product].filter(Boolean).join(' ')
                      : '';
                    const sel = selectedUsb === d.path;
                    return (
                      <div
                        key={d.path}
                        onClick={() => setSelectedUsb(d.path)}
                        className={`${styles.usbDevice} ${sel ? styles.usbDeviceSelected : styles.usbDeviceUnselected}`}
                      >
                        <div
                          className={`${styles.usbDevLabel} ${sel ? styles.usbDevLabelSelected : styles.usbDevLabelUnselected}`}
                        >
                          {label}
                        </div>
                        {subtitle && (
                          <div className={styles.usbDevSub}>{subtitle}</div>
                        )}
                        {d.serialNumber && (
                          <div className={styles.usbDevSerial}>
                            SN: {d.serialNumber}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}
              {usbDevices && usbDevices.length > 0 && (
                <Btn
                  onClick={doConnectUsb}
                  disabled={connecting || !selectedUsb}
                >
                  {connecting ? (
                    <>
                      <Spinner /> Connecting...
                    </>
                  ) : (
                    '⟲ Connect USB'
                  )}
                </Btn>
              )}
            </>
          )}

          {!busStatus.hasLib && (
            <div className={`${styles.warningBox} ${styles.warningBorder}`}>
              &#x26A0; KNX package not installed. Run{' '}
              <code className={styles.warningCodeBg}>npm install knx</code> in
              the server directory.
            </div>
          )}
        </div>

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
