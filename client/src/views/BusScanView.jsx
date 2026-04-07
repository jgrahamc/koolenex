import { useState, useEffect, useContext } from 'react';
import { useC, MaskCtx } from '../theme.ts';
import { Btn, TH, TD, SectionHeader, PinAddr } from '../primitives.jsx';
import { api } from '../api.ts';

function decodeMask(descriptor, maskVersions) {
  if (!descriptor) return null;
  // Descriptor is hex string like "07b0" — look up first 4 chars
  const key = descriptor.slice(0, 4).toLowerCase();
  return maskVersions[key] || null;
}

export function BusScanView({
  scan,
  busConnected,
  projectData,
  activeProjectId,
  dispatch,
  onAddDevice,
}) {
  const C = useC();
  const maskVersions = useContext(MaskCtx);
  const [area, setArea] = useState('1');
  const [line, setLine] = useState('1');
  const [scanTimeout, setScanTimeout] = useState('200');
  const [deviceInfos, setDeviceInfos] = useState({}); // addr -> info
  const [readingAddr, setReadingAddr] = useState(null);

  const knownAddrs = new Set(
    (projectData?.devices || []).map((d) => d.individual_address),
  );

  const handleReadInfo = async (addr) => {
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

  // Sync area/line inputs from incoming scan progress (e.g. scan started from topology view)
  useEffect(() => {
    if (!scan.running || !progress?.address) return;
    const parts = progress.address.split('.');
    if (parts[0] !== area) setArea(parts[0]);
    if (parts[1] !== line) setLine(parts[1]);
  }, [scan.running, progress?.address]);

  const inputStyle = {
    background: C.inputBg,
    border: `1px solid ${C.border2}`,
    borderRadius: 4,
    padding: '4px 8px',
    color: C.text,
    fontSize: 11,
    fontFamily: 'monospace',
    width: 60,
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SectionHeader
        title="Scan"
        count={scan.results.length > 0 ? `${scan.results.length} found` : null}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: C.dim }}>Area</span>
            <input
              value={area}
              onChange={(e) => setArea(e.target.value)}
              style={{ ...inputStyle, width: 40 }}
              disabled={scan.running}
            />
            <span style={{ fontSize: 10, color: C.dim }}>Line</span>
            <input
              value={line}
              onChange={(e) => setLine(e.target.value)}
              style={{ ...inputStyle, width: 40 }}
              disabled={scan.running}
            />
            <span style={{ fontSize: 10, color: C.dim }}>Timeout (ms)</span>
            <input
              value={scanTimeout}
              onChange={(e) => setScanTimeout(e.target.value)}
              style={{ ...inputStyle, width: 55 }}
              disabled={scan.running}
            />
            {!scan.running ? (
              <Btn
                onClick={handleScan}
                disabled={!busConnected}
                color={C.accent}
              >
                ⊙ Scan
              </Btn>
            ) : (
              <Btn onClick={handleAbort} color={C.red}>
                ■ Abort
              </Btn>
            )}
          </div>
        }
      />

      {!busConnected && (
        <div style={{ padding: 24, color: C.dim, fontSize: 11 }}>
          Connect to a KNX gateway first.
        </div>
      )}

      {busConnected && (scan.running || scan.results.length > 0) && (
        <>
          {/* Progress bar */}
          <div
            style={{
              padding: '8px 16px',
              borderBottom: `1px solid ${C.border}`,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: C.dim,
                marginBottom: 4,
              }}
            >
              <span>
                {scan.running ? (
                  <>
                    <span>
                      Scanning{' '}
                      <span
                        style={{ fontFamily: 'monospace', color: C.accent }}
                      >
                        {area}.{line}.*
                      </span>
                    </span>
                    {currentAddr && (
                      <span style={{ marginLeft: 8, color: C.dim }}>
                        · {currentAddr}
                      </span>
                    )}
                  </>
                ) : (
                  <span>
                    Scan complete —{' '}
                    <span style={{ fontFamily: 'monospace', color: C.accent }}>
                      {area}.{line}.*
                    </span>
                  </span>
                )}
              </span>
              <span>{pct}%</span>
            </div>
            <div style={{ height: 3, background: C.border, borderRadius: 2 }}>
              <div
                style={{
                  height: 3,
                  width: `${pct}%`,
                  background: C.accent,
                  borderRadius: 2,
                  transition: 'width 0.15s',
                }}
              />
            </div>
          </div>

          {/* Results table */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {scan.results.length === 0 &&
              !scan.running &&
              (() => {
                // Show missing project devices even when nothing responded
                const scanA = parseInt(area),
                  scanL = parseInt(line);
                const missing = (projectData?.devices || []).filter(
                  (d) => d.area === scanA && d.line === scanL,
                );
                if (missing.length === 0)
                  return (
                    <div style={{ padding: 24, color: C.dim, fontSize: 11 }}>
                      No devices responded.
                    </div>
                  );
                return null; // will be shown in merged table below
              })()}
            {(() => {
              // Merge scan results with project devices on this line that weren't found
              const foundAddrs = new Set(scan.results.map((r) => r.address));
              const scanA = parseInt(area),
                scanL = parseInt(line);
              const missingDevs =
                !scan.running && (scan.results.length > 0 || pct === 100)
                  ? (projectData?.devices || []).filter(
                      (d) =>
                        d.area === scanA &&
                        d.line === scanL &&
                        !foundAddrs.has(d.individual_address),
                    )
                  : [];
              const rows = [
                ...scan.results.map((r) => ({
                  address: r.address,
                  descriptor: r.descriptor,
                  found: true,
                })),
                ...missingDevs.map((d) => ({
                  address: d.individual_address,
                  found: false,
                })),
              ];
              if (rows.length === 0) return null;
              // Sort by address
              const cmp = (a, b) => {
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
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <TH style={{ width: 100 }}>ADDRESS</TH>
                      <TH>IN PROJECT</TH>
                      <TH style={{ width: 80 }}>MASK</TH>
                      <TH style={{ width: 50 }}>STATUS</TH>
                      <TH>SERIAL</TH>
                      <TH>MFR ID</TH>
                      <TH>ORDER</TH>
                      <TH style={{ width: 120 }}></TH>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const inProject = knownAddrs.has(r.address);
                      const projDev = inProject
                        ? (projectData?.devices || []).find(
                            (d) => d.individual_address === r.address,
                          )
                        : null;
                      const di = deviceInfos[r.address];
                      return (
                        <tr
                          key={r.address}
                          className="rh"
                          style={{ opacity: r.found ? 1 : 0.45 }}
                        >
                          <TD>
                            <PinAddr
                              address={r.address}
                              wtype="device"
                              style={{
                                color: r.found ? C.accent : C.dim,
                                fontFamily: 'monospace',
                              }}
                            />
                          </TD>
                          <TD>
                            {inProject ? (
                              <span
                                style={{
                                  color: r.found ? C.green : C.dim,
                                  fontSize: 11,
                                }}
                              >
                                {r.found ? '✓' : '✗'}{' '}
                                {projDev?.name || r.address}
                              </span>
                            ) : (
                              <span style={{ color: C.dim, fontSize: 11 }}>
                                —
                              </span>
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
                                  style={{
                                    color: C.dim,
                                    fontFamily: 'monospace',
                                    fontSize: 10,
                                  }}
                                >
                                  {mask ? mask.name : r.descriptor || '—'}
                                </span>
                              );
                            })()}
                          </TD>
                          <TD>
                            {r.found ? (
                              <span style={{ color: C.green, fontSize: 10 }}>
                                found
                              </span>
                            ) : (
                              <span style={{ color: C.red, fontSize: 10 }}>
                                missing
                              </span>
                            )}
                          </TD>
                          <TD>
                            <span
                              style={{
                                color: C.dim,
                                fontFamily: 'monospace',
                                fontSize: 10,
                              }}
                            >
                              {di?.serialNumber || '—'}
                            </span>
                          </TD>
                          <TD>
                            <span
                              style={{
                                color: C.dim,
                                fontFamily: 'monospace',
                                fontSize: 10,
                              }}
                            >
                              {di?.manufacturerId != null
                                ? `0x${di.manufacturerId.toString(16).padStart(4, '0')}`
                                : '—'}
                            </span>
                          </TD>
                          <TD>
                            <span
                              style={{
                                color: C.dim,
                                fontFamily: 'monospace',
                                fontSize: 10,
                              }}
                            >
                              {di?.orderInfo || '—'}
                            </span>
                          </TD>
                          <TD style={{ whiteSpace: 'nowrap' }}>
                            {r.found && !di && (
                              <span
                                onClick={
                                  readingAddr !== r.address
                                    ? () => handleReadInfo(r.address)
                                    : undefined
                                }
                                title="Read device properties"
                                style={{
                                  fontSize: 9,
                                  padding: '2px 8px',
                                  borderRadius: 10,
                                  background: `${C.accent}18`,
                                  color: C.accent,
                                  border: `1px solid ${C.accent}30`,
                                  cursor:
                                    readingAddr !== r.address
                                      ? 'pointer'
                                      : 'default',
                                  letterSpacing: '0.06em',
                                  marginRight: 4,
                                }}
                                className="bg"
                              >
                                {readingAddr === r.address
                                  ? 'SCANNING…'
                                  : 'SCAN'}
                              </span>
                            )}
                            {r.found && !inProject && activeProjectId && (
                              <span
                                onClick={() => onAddDevice(r.address)}
                                style={{
                                  fontSize: 9,
                                  padding: '2px 8px',
                                  borderRadius: 10,
                                  background: `${C.green}18`,
                                  color: C.green,
                                  border: `1px solid ${C.green}30`,
                                  cursor: 'pointer',
                                  letterSpacing: '0.06em',
                                }}
                                className="bg"
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
