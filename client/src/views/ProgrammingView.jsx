import { useState } from 'react';
import { useC, STATUS_COLOR } from '../theme.ts';
import {
  Btn,
  Spinner,
  TH,
  TD,
  SectionHeader,
  PinAddr,
  Badge,
} from '../primitives.jsx';
import { DeviceTypeIcon } from '../icons.jsx';
import { api } from '../api.ts';

export function ProgrammingView({ data, onDeviceStatus }) {
  const C = useC();
  const COLMAP = {
    actuator: C.actuator,
    sensor: C.sensor,
    router: C.router,
    generic: C.muted,
  };
  const [progress, setProgress] = useState({});
  const [log, setLog] = useState([]);
  const { devices = [] } = data || {};

  const programDevice = async (deviceId, devAddr) => {
    setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct: 5 } }));
    setLog((l) => [
      `[${new Date().toLocaleTimeString()}] Downloading → ${devAddr}`,
      ...l,
    ]);
    // Animate progress while waiting for the real download to complete
    let pct = 5;
    const iv = setInterval(() => {
      pct = Math.min(pct + (Math.random() * 6 + 2), 90);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct } }));
    }, 300);
    try {
      const pid = data?.project?.id;
      await api.busProgramDevice(devAddr, pid, deviceId);
      clearInterval(iv);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'done', pct: 100 } }));
      setLog((l) => [
        `[${new Date().toLocaleTimeString()}] ✓ ${devAddr} — programmed`,
        ...l,
      ]);
      onDeviceStatus(deviceId, 'programmed');
    } catch (err) {
      clearInterval(iv);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'error', pct: 0 } }));
      setLog((l) => [
        `[${new Date().toLocaleTimeString()}] ✗ ${devAddr} — ${err.message}`,
        ...l,
      ]);
    }
  };

  const programmAll = () =>
    devices
      .filter((d) => d.status !== 'programmed')
      .forEach((d) => programDevice(d.id, d.individual_address));

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <SectionHeader
          title="Programming"
          actions={[
            <Btn key="all" onClick={programmAll} color={C.amber}>
              ▷ Program All Modified
            </Btn>,
          ]}
        />
        <div style={{ overflow: 'auto', flex: 1, padding: 20 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4,1fr)',
              gap: 12,
              marginBottom: 24,
            }}
          >
            {[
              [
                'Programmed',
                devices.filter((d) => d.status === 'programmed').length,
                STATUS_COLOR.programmed,
              ],
              [
                'Modified',
                devices.filter((d) => d.status === 'modified').length,
                STATUS_COLOR.modified,
              ],
              [
                'Unassigned',
                devices.filter((d) => d.status === 'unassigned').length,
                STATUS_COLOR.unassigned,
              ],
            ].map(([label, count, col]) => (
              <div
                key={label}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  padding: '14px 16px',
                }}
              >
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: col,
                    fontFamily: "'Syne',sans-serif",
                  }}
                >
                  {count}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH style={{ width: 90 }}>ADDRESS</TH>
                <TH>DEVICE</TH>
                <TH style={{ width: 120 }}>STATUS</TH>
                <TH style={{ width: 200 }}>PROGRESS</TH>
                <TH style={{ width: 110 }}></TH>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const prog = progress[d.id];
                return (
                  <tr key={d.id} className="rh">
                    <TD>
                      <PinAddr
                        address={d.individual_address}
                        wtype="device"
                        style={{ color: C.accent, fontFamily: 'monospace' }}
                      />
                    </TD>
                    <TD>
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                        }}
                      >
                        <DeviceTypeIcon
                          type={d.device_type}
                          style={{ color: COLMAP[d.device_type] || C.muted }}
                        />
                        {d.name}
                        {d.manufacturer && (
                          <span style={{ color: C.dim, fontSize: 9 }}>
                            {d.manufacturer}
                          </span>
                        )}
                      </span>
                    </TD>
                    <TD>
                      {prog?.state === 'done' ? (
                        <Badge label="PROGRAMMED" color={C.green} />
                      ) : (
                        <Badge
                          label={d.status.toUpperCase()}
                          color={STATUS_COLOR[d.status] || C.dim}
                        />
                      )}
                    </TD>
                    <TD>
                      {prog ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                              height: 3,
                              background: '#1a2030',
                              borderRadius: 2,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${prog.pct}%`,
                                height: '100%',
                                background:
                                  prog.state === 'done'
                                    ? C.green
                                    : prog.state === 'error'
                                      ? C.red
                                      : C.accent,
                                transition: 'width 0.15s',
                                borderRadius: 2,
                              }}
                            />
                          </div>
                          {prog.state !== 'error' && (
                            <span
                              style={{
                                fontSize: 10,
                                color: C.muted,
                                width: 32,
                              }}
                            >
                              {Math.round(prog.pct)}%
                            </span>
                          )}
                          {prog.state === 'error' && (
                            <span style={{ fontSize: 10, color: C.red }}>
                              ERR
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: C.dim, fontSize: 10 }}>—</span>
                      )}
                    </TD>
                    <TD>
                      <Btn
                        onClick={() =>
                          programDevice(d.id, d.individual_address)
                        }
                        disabled={prog?.state === 'running'}
                      >
                        {prog?.state === 'running' ? (
                          <Spinner />
                        ) : prog?.state === 'done' ? (
                          'Re-program'
                        ) : prog?.state === 'error' ? (
                          'Retry'
                        ) : (
                          'Program'
                        )}
                      </Btn>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div
        style={{
          width: 220,
          borderLeft: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderBottom: `1px solid ${C.border}`,
            fontSize: 9,
            color: C.dim,
            letterSpacing: '0.1em',
          }}
        >
          LOG
        </div>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          {log.length === 0 ? (
            <span style={{ fontSize: 10, color: C.dim }}>
              No operations yet
            </span>
          ) : (
            log.map((l, i) => (
              <div
                key={i}
                style={{
                  fontSize: 10,
                  color: l.includes('✓') ? C.green : C.muted,
                  lineHeight: 1.5,
                }}
              >
                {l}
              </div>
            ))
          )}
        </div>
        <div
          style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}` }}
        >
          <Btn
            onClick={() => setLog([])}
            color={C.dim}
            bg={C.bg}
            style={{ width: '100%' }}
          >
            Clear Log
          </Btn>
        </div>
      </div>
    </div>
  );
}
