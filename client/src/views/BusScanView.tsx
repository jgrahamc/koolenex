import { useState, useEffect, useContext } from 'react';
import { MaskCtx } from '../theme.ts';
import { Btn, TH, TD, SectionHeader, PinAddr } from '../primitives.tsx';
import { api } from '../api.ts';
import styles from './BusScanView.module.css';

function decodeMask(descriptor: string | undefined, maskVersions: any) {
  if (!descriptor) return null;
  const key = descriptor.slice(0, 4).toLowerCase();
  return maskVersions[key] || null;
}

interface BusScanViewProps {
  scan: any;
  busConnected: boolean;
  projectData: any;
  activeProjectId: any;
  dispatch: (action: any) => void;
  onAddDevice: (address: string) => void;
}

export function BusScanView({
  scan,
  busConnected,
  projectData,
  activeProjectId,
  dispatch,
  onAddDevice,
}: BusScanViewProps) {
  const maskVersions = useContext(MaskCtx);
  const [area, setArea] = useState('1');
  const [line, setLine] = useState('1');
  const [scanTimeout, setScanTimeout] = useState('200');
  const [deviceInfos, setDeviceInfos] = useState<Record<string, any>>({});
  const [readingAddr, setReadingAddr] = useState<string | null>(null);

  const knownAddrs = new Set(
    (projectData?.devices || []).map((d: any) => d.individual_address),
  );

  const handleReadInfo = async (addr: string) => {
    setReadingAddr(addr);
    try {
      const info = await api.busDeviceInfo(addr);
      setDeviceInfos((prev) => ({ ...prev, [addr]: info }));
    } catch (_) {
      setDeviceInfos((prev) => ({ ...prev, [addr]: { error: 'Failed' } }));
    }
    setReadingAddr(null);
  };

  const handleScan = async () => {
    dispatch({ type: 'SCAN_RESET' });
    await api.busScan(parseInt(area), parseInt(line), parseInt(scanTimeout));
  };
  const handleAbort = async () => {
    await api.busScanAbort();
    dispatch({ type: 'SCAN_RESET' });
  };

  const progress = scan.progress;
  const pct = progress
    ? Math.round((progress.done / progress.total) * 100)
    : scan.results.length > 0
      ? 100
      : 0;
  const currentAddr = progress?.address || '';

  useEffect(() => {
    if (!scan.running || !progress?.address) return;
    const parts = progress.address.split('.');
    if (parts[0] !== area) setArea(parts[0]);
    if (parts[1] !== line) setLine(parts[1]);
  }, [scan.running, progress?.address]);

  return (
    <div className={styles.root}>
      <SectionHeader
        title="Scan"
        count={scan.results.length > 0 ? scan.results.length : undefined}
        actions={
          <div className={styles.actionRow}>
            <span className={styles.inputLabel}>Area</span>
            <input
              value={area}
              onChange={(e) => setArea(e.target.value)}
              className={`${styles.scanInput} ${styles.scanInputArea}`}
              disabled={scan.running}
            />
            <span className={styles.inputLabel}>Line</span>
            <input
              value={line}
              onChange={(e) => setLine(e.target.value)}
              className={`${styles.scanInput} ${styles.scanInputLine}`}
              disabled={scan.running}
            />
            <span className={styles.inputLabel}>Timeout (ms)</span>
            <input
              value={scanTimeout}
              onChange={(e) => setScanTimeout(e.target.value)}
              className={`${styles.scanInput} ${styles.scanInputTimeout}`}
              disabled={scan.running}
            />
            {!scan.running ? (
              <Btn
                onClick={handleScan}
                disabled={!busConnected}
                color="var(--accent)"
              >
                ⊙ Scan
              </Btn>
            ) : (
              <Btn onClick={handleAbort} color="var(--red)">
                ■ Abort
              </Btn>
            )}
          </div>
        }
      />

      {!busConnected && (
        <div className={styles.offlineMsg}>Connect to a KNX gateway first.</div>
      )}

      {busConnected && (scan.running || scan.results.length > 0) && (
        <>
          <div className={styles.progressWrap}>
            <div className={styles.progressInfo}>
              <span>
                {scan.running ? (
                  <>
                    <span>
                      Scanning{' '}
                      <span className={styles.scanAddr}>
                        {area}.{line}.*
                      </span>
                    </span>
                    {currentAddr && (
                      <span className={styles.progressAddrHint}>
                        · {currentAddr}
                      </span>
                    )}
                  </>
                ) : (
                  <span>
                    Scan complete —{' '}
                    <span className={styles.scanAddr}>
                      {area}.{line}.*
                    </span>
                  </span>
                )}
              </span>
              <span>{pct}%</span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressBar}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className={styles.resultsArea}>
            {scan.results.length === 0 &&
              !scan.running &&
              (() => {
                const scanA = parseInt(area),
                  scanL = parseInt(line);
                const missing = (projectData?.devices || []).filter(
                  (d: any) => d.area === scanA && d.line === scanL,
                );
                if (missing.length === 0)
                  return (
                    <div className={styles.noResults}>
                      No devices responded.
                    </div>
                  );
                return null;
              })()}
            {(() => {
              const foundAddrs = new Set(
                scan.results.map((r: any) => r.address),
              );
              const scanA = parseInt(area),
                scanL = parseInt(line);
              const missingDevs =
                !scan.running && (scan.results.length > 0 || pct === 100)
                  ? (projectData?.devices || []).filter(
                      (d: any) =>
                        d.area === scanA &&
                        d.line === scanL &&
                        !foundAddrs.has(d.individual_address),
                    )
                  : [];
              const rows: any[] = [
                ...scan.results.map((r: any) => ({
                  address: r.address,
                  descriptor: r.descriptor,
                  found: true,
                })),
                ...missingDevs.map((d: any) => ({
                  address: d.individual_address,
                  found: false,
                })),
              ];
              if (rows.length === 0) return null;
              const cmp = (a: any, b: any) => {
                const pa = a.address.split('.').map(Number),
                  pb = b.address.split('.').map(Number);
                for (let i = 0; i < 3; i++) {
                  const d = (pa[i] || 0) - (pb[i] || 0);
                  if (d) return d;
                }
                return 0;
              };
              rows.sort(cmp);
              return (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <TH className={styles.thAddr}>ADDRESS</TH>
                      <TH>IN PROJECT</TH>
                      <TH className={styles.thMask}>MASK</TH>
                      <TH className={styles.thStatus}>STATUS</TH>
                      <TH>SERIAL</TH>
                      <TH>MFR ID</TH>
                      <TH>ORDER</TH>
                      <TH className={styles.thActions}></TH>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const inProject = knownAddrs.has(r.address);
                      const projDev = inProject
                        ? (projectData?.devices || []).find(
                            (d: any) => d.individual_address === r.address,
                          )
                        : null;
                      const di = deviceInfos[r.address];
                      return (
                        <tr
                          key={r.address}
                          className={`rh${r.found ? '' : ` ${styles.rowMissing}`}`}
                        >
                          <TD>
                            <PinAddr
                              address={r.address}
                              wtype="device"
                              className={
                                r.found ? styles.scanAddr : styles.monoSmall
                              }
                            />
                          </TD>
                          <TD>
                            {inProject ? (
                              <span
                                className={
                                  r.found
                                    ? styles.inProjectFound
                                    : styles.inProjectMissing
                                }
                              >
                                {r.found ? '✓' : '✗'}{' '}
                                {projDev?.name || r.address}
                              </span>
                            ) : (
                              <span className={styles.inProjectNone}>—</span>
                            )}
                          </TD>
                          <TD>
                            {(() => {
                              const mask = decodeMask(
                                r.descriptor,
                                maskVersions,
                              );
                              return (
                                <span
                                  title={
                                    r.descriptor ? `0x${r.descriptor}` : ''
                                  }
                                  className={styles.monoSmall}
                                >
                                  {mask ? mask.name : r.descriptor || '—'}
                                </span>
                              );
                            })()}
                          </TD>
                          <TD>
                            {r.found ? (
                              <span className={styles.foundText}>found</span>
                            ) : (
                              <span className={styles.missingText}>
                                missing
                              </span>
                            )}
                          </TD>
                          <TD>
                            <span className={styles.monoSmall}>
                              {di?.serialNumber || '—'}
                            </span>
                          </TD>
                          <TD>
                            <span className={styles.monoSmall}>
                              {di?.manufacturerId != null
                                ? `0x${di.manufacturerId.toString(16).padStart(4, '0')}`
                                : '—'}
                            </span>
                          </TD>
                          <TD>
                            <span className={styles.monoSmall}>
                              {di?.orderInfo || '—'}
                            </span>
                          </TD>
                          <TD className={styles.tdNoWrap}>
                            {r.found && !di && (
                              <span
                                onClick={
                                  readingAddr !== r.address
                                    ? () => handleReadInfo(r.address)
                                    : undefined
                                }
                                title="Read device properties"
                                className={`bg ${readingAddr !== r.address ? styles.scanBadge : styles.scanBadgeDisabled}`}
                              >
                                {readingAddr === r.address
                                  ? 'SCANNING…'
                                  : 'SCAN'}
                              </span>
                            )}
                            {r.found && !inProject && activeProjectId && (
                              <span
                                onClick={() => onAddDevice(r.address)}
                                className={`bg ${styles.addBadge}`}
                              >
                                + ADD
                              </span>
                            )}
                          </TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
