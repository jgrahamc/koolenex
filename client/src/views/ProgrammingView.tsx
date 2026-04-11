import { useState } from 'react';
import { STATUS_COLOR } from '../theme.ts';
import {
  Btn,
  Spinner,
  TH,
  TD,
  SectionHeader,
  PinAddr,
  Badge,
} from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import { api } from '../api.ts';
import type { DeviceStatus } from '../../../shared/types.ts';
import styles from './ProgrammingView.module.css';

import type { ProjectFull } from '../../../shared/types.ts';

interface ProgrammingViewProps {
  data: ProjectFull | null;
  onDeviceStatus: (deviceId: number, status: DeviceStatus) => void;
}

export function ProgrammingView({
  data,
  onDeviceStatus,
}: ProgrammingViewProps) {
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
  };
  const [progress, setProgress] = useState<
    Record<string, { state: string; pct: number }>
  >({});
  const [log, setLog] = useState<string[]>([]);
  const { devices = [] } = data || {};

  const programDevice = async (deviceId: any, devAddr: string) => {
    setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct: 5 } }));
    setLog((l) => [
      `[${new Date().toLocaleTimeString()}] Downloading → ${devAddr}`,
      ...l,
    ]);
    let pct = 5;
    const iv = setInterval(() => {
      pct = Math.min(pct + (Math.random() * 6 + 2), 90);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct } }));
    }, 300);
    try {
      const pid = data?.project?.id;
      await api.busProgramDevice(devAddr, pid!, deviceId);
      clearInterval(iv);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'done', pct: 100 } }));
      setLog((l) => [
        `[${new Date().toLocaleTimeString()}] ✓ ${devAddr} — programmed`,
        ...l,
      ]);
      onDeviceStatus(deviceId, 'programmed');
    } catch (err: any) {
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
      .filter((d: any) => d.status !== 'programmed')
      .forEach((d: any) => programDevice(d.id, d.individual_address));

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <SectionHeader
          title="Programming"
          actions={[
            <Btn key="all" onClick={programmAll} color="var(--amber)">
              ▷ Program All Modified
            </Btn>,
          ]}
        />
        <div className={styles.content}>
          <div className={styles.statGrid}>
            {[
              [
                'Programmed',
                devices.filter((d: any) => d.status === 'programmed').length,
                STATUS_COLOR.programmed,
              ],
              [
                'Modified',
                devices.filter((d: any) => d.status === 'modified').length,
                STATUS_COLOR.modified,
              ],
              [
                'Unassigned',
                devices.filter((d: any) => d.status === 'unassigned').length,
                STATUS_COLOR.unassigned,
              ],
            ].map(([label, count, col]) => (
              <div key={label as string} className={styles.statCard}>
                <div
                  className={styles.statNumber}
                  style={{ color: col as string }}
                >
                  {count}
                </div>
                <div className={styles.statLabel}>{label}</div>
              </div>
            ))}
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <TH className={styles.thAddr}>ADDRESS</TH>
                <TH>DEVICE</TH>
                <TH className={styles.thStatus}>STATUS</TH>
                <TH className={styles.thProgress}>PROGRESS</TH>
                <TH className={styles.thActions}></TH>
              </tr>
            </thead>
            <tbody>
              {devices.map((d: any) => {
                const prog = progress[d.id];
                return (
                  <tr key={d.id} className="rh">
                    <TD>
                      <PinAddr
                        address={d.individual_address}
                        wtype="device"
                        className={styles.accentMono}
                      />
                    </TD>
                    <TD>
                      <span className={styles.devName}>
                        <DeviceTypeIcon
                          type={d.device_type}
                          style={{
                            color: COLMAP[d.device_type] || 'var(--muted)',
                          }}
                        />
                        {d.name}
                        {d.manufacturer && (
                          <span className={styles.mfrLabel}>
                            {d.manufacturer}
                          </span>
                        )}
                      </span>
                    </TD>
                    <TD>
                      {prog?.state === 'done' ? (
                        <Badge label="PROGRAMMED" color="var(--green)" />
                      ) : (
                        <Badge
                          label={d.status.toUpperCase()}
                          color={STATUS_COLOR[d.status] || 'var(--dim)'}
                        />
                      )}
                    </TD>
                    <TD>
                      {prog ? (
                        <div className={styles.progressWrap}>
                          <div className={styles.progressTrack}>
                            <div
                              className={styles.progressBar}
                              style={{
                                width: `${prog.pct}%`,
                                background:
                                  prog.state === 'done'
                                    ? 'var(--green)'
                                    : prog.state === 'error'
                                      ? 'var(--red)'
                                      : 'var(--accent)',
                              }}
                            />
                          </div>
                          {prog.state !== 'error' && (
                            <span className={styles.progressPct}>
                              {Math.round(prog.pct)}%
                            </span>
                          )}
                          {prog.state === 'error' && (
                            <span className={styles.progressErr}>ERR</span>
                          )}
                        </div>
                      ) : (
                        <span className={styles.progressDash}>—</span>
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
      <div className={styles.sidebar}>
        <div className={styles.logHeader}>LOG</div>
        <div className={styles.logBody}>
          {log.length === 0 ? (
            <span className={styles.logEmpty}>No operations yet</span>
          ) : (
            log.map((l, i) => (
              <div
                key={i}
                className={
                  l.includes('✓')
                    ? styles.logEntrySuccess
                    : styles.logEntryNormal
                }
              >
                {l}
              </div>
            ))
          )}
        </div>
        <div className={styles.logFooter}>
          <Btn
            onClick={() => setLog([])}
            color="var(--dim)"
            bg="var(--bg)"
            className={styles.logFooterBtn}
          >
            Clear Log
          </Btn>
        </div>
      </div>
    </div>
  );
}
