import { useState, useEffect, useCallback } from 'react';
import { useC } from '../theme.ts';
import { Btn, Spinner } from '../primitives.jsx';
import { api } from '../api.ts';

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
}) {
  const C = useC();
  const info = (() => {
    try {
      return JSON.parse(project?.project_info || '{}');
    } catch {
      return {};
    }
  })();
  const fmt = (iso) => {
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
  const [error, setError] = useState(null);

  // USB state
  const [usbDevices, setUsbDevices] = useState(null);
  const [usbLoading, setUsbLoading] = useState(false);
  const [selectedUsb, setSelectedUsb] = useState('');

  useEffect(() => {
    if (busStatus.connected) return;
    api
      .getSettings()
      .then((s) => {
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
    } catch (e) {
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
    } catch (e) {
      setError(e.message);
    }
    setConnecting(false);
  };

  const scanUsb = async () => {
    setUsbLoading(true);
    setError(null);
    try {
      const res = await api.busUsbDevices();
      setUsbDevices(res.devices || []);
      if (res.error) setError(res.error);
      if (res.devices?.length === 1) setSelectedUsb(res.devices[0].path);
    } catch (e) {
      setError(e.message);
      setUsbDevices([]);
    }
    setUsbLoading(false);
  };

  const tabStyle = (id) => ({
    padding: '6px 16px',
    fontSize: 11,
    fontFamily: 'inherit',
    cursor: 'pointer',
    fontWeight: 600,
    background: tab === id ? C.accent + '18' : 'transparent',
    color: tab === id ? C.accent : C.dim,
    border: 'none',
    borderBottom:
      tab === id ? `2px solid ${C.accent}` : '2px solid transparent',
    letterSpacing: '0.04em',
  });

  return (
    <div className="fi" style={{ flex: 1, padding: 40, overflow: 'auto' }}>
      <div style={{ maxWidth: 480 }}>
        <div
          style={{
            fontFamily: "'Syne',sans-serif",
            fontWeight: 700,
            fontSize: 16,
            color: C.text,
            marginBottom: 24,
          }}
        >
          Project
        </div>

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: C.accent,
              fontWeight: 600,
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            BUS CONNECTION
          </div>

          {!busStatus.connected && (
            <div
              style={{
                display: 'flex',
                borderBottom: `1px solid ${C.border}`,
                marginBottom: 16,
              }}
            >
              <button style={tabStyle('ip')} onClick={() => setTab('ip')}>
                KNXnet/IP
              </button>
              <button style={tabStyle('usb')} onClick={() => setTab('usb')}>
                USB
              </button>
            </div>
          )}

          {busStatus.connected ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.green }}>
                {busStatus.type === 'usb'
                  ? '● Connected via USB'
                  : `● Connected to ${busStatus.host}:${busStatus.port || 3671}`}
              </span>
              <Btn onClick={onDisconnect} color={C.red} bg="#1a0a0a">
                Disconnect
              </Btn>
            </div>
          ) : tab === 'ip' ? (
            <>
              <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                <div style={{ flex: 2 }}>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 5 }}>
                    IP ADDRESS
                  </div>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    style={{
                      width: '100%',
                      background: C.inputBg,
                      border: `1px solid ${C.border2}`,
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: C.text,
                      fontSize: 12,
                      fontFamily: 'inherit',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 5 }}>
                    PORT
                  </div>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    style={{
                      width: '100%',
                      background: C.inputBg,
                      border: `1px solid ${C.border2}`,
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: C.text,
                      fontSize: 12,
                      fontFamily: 'inherit',
                    }}
                  />
                </div>
              </div>
              {error && (
                <div style={{ fontSize: 11, color: C.red, marginBottom: 10 }}>
                  &#x2717; {error}
                </div>
              )}
              <Btn onClick={doConnect} disabled={connecting}>
                {connecting ? (
                  <>
                    <Spinner /> Connecting...
                  </>
                ) : (
                  '\u27F2 Connect'
                )}
              </Btn>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 12 }}>
                <Btn onClick={scanUsb} disabled={usbLoading}>
                  {usbLoading ? (
                    <>
                      <Spinner /> Scanning...
                    </>
                  ) : (
                    '\u27F2 Scan for USB devices'
                  )}
                </Btn>
              </div>

              {usbDevices !== null &&
                usbDevices.length === 0 &&
                !usbLoading && (
                  <div
                    style={{
                      fontSize: 11,
                      color: C.dim,
                      marginBottom: 10,
                      padding: '8px 12px',
                      background: C.bg,
                      borderRadius: 4,
                      border: `1px solid ${C.border}`,
                    }}
                  >
                    No KNX USB devices found. Make sure the device is plugged in
                    and{' '}
                    <code
                      style={{
                        background: C.surface,
                        padding: '1px 5px',
                        borderRadius: 3,
                        fontSize: 10,
                      }}
                    >
                      node-hid
                    </code>{' '}
                    is installed.
                  </div>
                )}

              {usbDevices && usbDevices.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 5 }}>
                    SELECT DEVICE
                  </div>
                  {usbDevices.map((d) => {
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
                        style={{
                          padding: '8px 12px',
                          marginBottom: 4,
                          borderRadius: 4,
                          cursor: 'pointer',
                          background: sel ? C.accent + '18' : C.bg,
                          border: `1px solid ${sel ? C.accent + '55' : C.border}`,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: sel ? C.accent : C.text,
                            fontWeight: sel ? 600 : 400,
                          }}
                        >
                          {label}
                        </div>
                        {subtitle && (
                          <div
                            style={{ fontSize: 9, color: C.dim, marginTop: 2 }}
                          >
                            {subtitle}
                          </div>
                        )}
                        {d.serialNumber && (
                          <div
                            style={{ fontSize: 9, color: C.dim, marginTop: 1 }}
                          >
                            SN: {d.serialNumber}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {error && (
                <div style={{ fontSize: 11, color: C.red, marginBottom: 10 }}>
                  &#x2717; {error}
                </div>
              )}
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
                    '\u27F2 Connect USB'
                  )}
                </Btn>
              )}
            </>
          )}

          {!busStatus.hasLib && (
            <div
              style={{
                marginTop: 12,
                padding: '8px 12px',
                background: '#1a140a',
                border: `1px solid ${C.amber}33`,
                borderRadius: 4,
                fontSize: 11,
                color: C.amber,
              }}
            >
              &#x26A0; KNX package not installed. Run{' '}
              <code
                style={{
                  background: C.bg,
                  padding: '1px 5px',
                  borderRadius: 3,
                }}
              >
                npm install knx
              </code>{' '}
              in the server directory.
            </div>
          )}
        </div>

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: C.accent,
              fontWeight: 600,
              letterSpacing: '0.08em',
              marginBottom: 16,
            }}
          >
            ETS PROJECT
          </div>
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
              <div
                key={label}
                style={{ display: 'flex', fontSize: 11, marginBottom: 6 }}
              >
                <span style={{ color: C.dim, width: 110, flexShrink: 0 }}>
                  {label}
                </span>
                <span style={{ color: C.muted, wordBreak: 'break-all' }}>
                  {value}
                </span>
              </div>
            ))}
          {project?.thumbnail && (
            <div style={{ marginTop: 12 }}>
              <img
                src={`data:image/jpeg;base64,${project.thumbnail}`}
                alt=""
                style={{ maxWidth: '100%', borderRadius: 4 }}
              />
            </div>
          )}
        </div>

        <div
          style={{
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: C.accent,
              fontWeight: 600,
              letterSpacing: '0.08em',
              marginBottom: 16,
            }}
          >
            SUMMARY
          </div>
          {[
            ['Devices', data?.devices?.length],
            ['Group Addresses', data?.gas?.length],
            ['Group Objects', data?.comObjects?.length],
            ['Spaces', data?.spaces?.length],
          ].map(([label, value]) => (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                marginBottom: 6,
              }}
            >
              <span style={{ color: C.dim }}>{label}</span>
              <span style={{ color: C.muted }}>{value ?? '—'}</span>
            </div>
          ))}
        </div>

        <AuditLogSection projectId={project?.id} C={C} />

        {languages && languages.length > 1 && (
          <div
            style={{
              background: C.surface,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: 20,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: C.accent,
                fontWeight: 600,
                letterSpacing: '0.08em',
                marginBottom: 16,
              }}
            >
              LANGUAGE
            </div>
            <div style={{ fontSize: 9, color: C.dim, marginBottom: 8 }}>
              KNX DATA LANGUAGE
            </div>
            <select
              value={lang}
              onChange={(e) => onLangChange(e.target.value)}
              style={{
                width: '100%',
                background: C.inputBg,
                border: `1px solid ${C.border2}`,
                borderRadius: 4,
                padding: '6px 10px',
                color: C.text,
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            >
              {languages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.id})
                </option>
              ))}
            </select>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 8 }}>
              Translates KNX data types, space usages, and function types.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AuditLogSection({ projectId, C }) {
  const [logs, setLogs] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    api
      .getAuditLog(projectId, 200)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (expanded && logs === null) load();
  }, [expanded, logs, load]);

  const actionColor = (a) => {
    if (a === 'create' || a === 'import') return C.green;
    if (a === 'delete') return C.red;
    if (a === 'update' || a === 'reimport') return C.amber;
    return C.muted;
  };

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div
          style={{
            fontSize: 11,
            color: C.accent,
            fontWeight: 600,
            letterSpacing: '0.08em',
          }}
        >
          AUDIT LOG
        </div>
        <span style={{ fontSize: 10, color: C.dim }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Btn onClick={load} disabled={loading}>
              {loading ? 'Loading...' : '↻ Refresh'}
            </Btn>
            {projectId && (
              <a
                href={api.auditLogCsvUrl(projectId)}
                download
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 12px',
                  fontSize: 11,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  borderRadius: 4,
                  background: C.accent + '18',
                  color: C.accent,
                  textDecoration: 'none',
                  border: `1px solid ${C.accent}33`,
                }}
              >
                ↓ Download CSV
              </a>
            )}
          </div>

          {logs && logs.length === 0 && (
            <div style={{ fontSize: 11, color: C.dim, padding: '8px 0' }}>
              No audit log entries yet.
            </div>
          )}

          {logs && logs.length > 0 && (
            <div
              style={{
                maxHeight: 320,
                overflow: 'auto',
                border: `1px solid ${C.border}`,
                borderRadius: 4,
              }}
            >
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 10,
                  fontFamily: 'inherit',
                }}
              >
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: C.bg }}>
                    {['Time', 'Action', 'Entity', 'ID', 'Detail'].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: 'left',
                          padding: '6px 8px',
                          color: C.dim,
                          fontWeight: 600,
                          borderBottom: `1px solid ${C.border}`,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map((r) => (
                    <tr
                      key={r.id}
                      style={{ borderBottom: `1px solid ${C.border}22` }}
                    >
                      <td
                        style={{
                          padding: '4px 8px',
                          color: C.dim,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.timestamp}
                      </td>
                      <td
                        style={{
                          padding: '4px 8px',
                          color: actionColor(r.action),
                          fontWeight: 600,
                        }}
                      >
                        {r.action}
                      </td>
                      <td style={{ padding: '4px 8px', color: C.muted }}>
                        {r.entity}
                      </td>
                      <td
                        style={{
                          padding: '4px 8px',
                          color: C.text,
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 9,
                        }}
                      >
                        {r.entity_id}
                      </td>
                      <td style={{ padding: '4px 8px', color: C.muted }}>
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
