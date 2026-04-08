import { useContext, useMemo } from 'react';
import { PinContext, useDpt } from '../contexts.ts';
import { Empty, PinAddr, coGAs } from '../primitives.tsx';
import styles from './ComparePanel.module.css';

interface GaAddrCellProps {
  addr: string;
  otherAddr: string;
}

function GaAddrCell({ addr, otherAddr }: GaAddrCellProps) {
  if (!addr)
    return (
      <span className={styles.dimDash} style={{ fontFamily: 'monospace' }}>
        &mdash;
      </span>
    );
  if (!otherAddr || addr === otherAddr) {
    return (
      <span
        className={styles.gaAddrMono}
        style={{
          color:
            addr !== otherAddr ? 'var(--amber)' : 'var(--muted)',
        }}
      >
        {addr}
      </span>
    );
  }
  const pa = addr.split('/'),
    po = otherAddr.split('/');
  return (
    <span className={styles.gaAddrMono}>
      {pa.map((p, i) => (
        <span key={i}>
          {i > 0 && <span className={styles.gaAddrSep}>/</span>}
          <span
            style={{
              color: p !== po[i] ? 'var(--amber)' : 'var(--muted)',
              fontWeight: p !== po[i] ? 700 : 400,
            }}
          >
            {p}
          </span>
        </span>
      ))}
    </span>
  );
}

interface ComparePanelProps {
  addrA: string;
  addrB: string;
  data: any;
  C: any;
}

export function ComparePanel({
  addrA,
  addrB,
  data,
  C: _C,
}: ComparePanelProps) {
  const pin = useContext(PinContext) as any;
  const dpt = useDpt();
  const { devices = [], gas = [], comObjects = [] } = data;
  const gaMap: Record<string, any> = Object.fromEntries(
    gas.map((g: any) => [g.address, g]),
  );

  const devA = devices.find((d: any) => d.individual_address === addrA);
  const devB = devices.find((d: any) => d.individual_address === addrB);
  const paramsA = useMemo(() => {
    try {
      return JSON.parse(devA?.parameters || '[]');
    } catch {
      return [];
    }
  }, [devA?.parameters]);
  const paramsB = useMemo(() => {
    try {
      return JSON.parse(devB?.parameters || '[]');
    } catch {
      return [];
    }
  }, [devB?.parameters]);

  if (!devA || !devB) return <Empty icon="◈" msg="Device not found" />;

  const cosA = comObjects.filter((co: any) => co.device_address === addrA);
  const cosB = comObjects.filter((co: any) => co.device_address === addrB);
  const coMapA: Record<number, any> = Object.fromEntries(
    cosA.map((co: any) => [co.object_number, co]),
  );
  const coMapB: Record<number, any> = Object.fromEntries(
    cosB.map((co: any) => [co.object_number, co]),
  );
  const allCoNums = [
    ...new Set([
      ...cosA.map((co: any) => co.object_number),
      ...cosB.map((co: any) => co.object_number),
    ]),
  ].sort((a, b) => a - b);

  const paramMapA: Record<string, any> = Object.fromEntries(
    paramsA.map((p: any) => [`${p.section}|${p.name}`, p]),
  );
  const paramMapB: Record<string, any> = Object.fromEntries(
    paramsB.map((p: any) => [`${p.section}|${p.name}`, p]),
  );
  const allParamKeys = [
    ...new Set([...Object.keys(paramMapA), ...Object.keys(paramMapB)]),
  ];
  allParamKeys.sort((a, b) => a.localeCompare(b));

  // All unique GAs from both devices
  const gasA = new Set<string>(cosA.flatMap(coGAs));
  const gasB = new Set<string>(cosB.flatMap(coGAs));
  const allGAs = [...new Set<string>([...gasA, ...gasB])].sort();

  const diffBg = 'color-mix(in srgb, var(--amber) 9%, transparent)';
  const onlyBg = 'color-mix(in srgb, var(--red) 7%, transparent)';

  const colA = 'var(--accent)';
  const colB = 'var(--purple)';

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.headerRow}>
        <div
          className={styles.deviceCard}
          style={{ border: `2px solid color-mix(in srgb, var(--accent) 25%, transparent)` }}
        >
          <div
            onClick={pin ? () => pin('device', addrA) : undefined}
            className={pin ? styles.deviceAddrClickable : styles.deviceAddr}
            style={{ color: colA }}
          >
            {addrA}
          </div>
          <div className={styles.deviceName}>{devA.name}</div>
          {devA.model && (
            <div className={styles.deviceModel}>{devA.model}</div>
          )}
        </div>
        <div className={styles.arrowSep}>{'⇄'}</div>
        <div
          className={styles.deviceCard}
          style={{ border: `2px solid color-mix(in srgb, var(--purple) 25%, transparent)` }}
        >
          <div
            onClick={pin ? () => pin('device', addrB) : undefined}
            className={pin ? styles.deviceAddrClickable : styles.deviceAddr}
            style={{ color: colB }}
          >
            {addrB}
          </div>
          <div className={styles.deviceName}>{devB.name}</div>
          {devB.model && (
            <div className={styles.deviceModel}>{devB.model}</div>
          )}
        </div>
      </div>

      {/* Parameters */}
      {allParamKeys.length > 0 && (
        <div className={styles.sectionBlock}>
          <div className={styles.sectionLabel}>PARAMETERS</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th} style={{ width: '22%' }}>
                  SECTION
                </th>
                <th className={styles.th} style={{ width: '26%' }}>
                  NAME
                </th>
                <th className={styles.th} style={{ color: colA }}>
                  VALUE &mdash; {addrA}
                </th>
                <th className={styles.th} style={{ color: colB }}>
                  VALUE &mdash; {addrB}
                </th>
              </tr>
            </thead>
            <tbody>
              {allParamKeys.map((k) => {
                const pA = paramMapA[k],
                  pB = paramMapB[k];
                const diff = pA?.value !== pB?.value;
                const onlyOne = !pA || !pB;
                const bg = onlyOne ? onlyBg : diff ? diffBg : 'transparent';
                const [section, name] = k.split('|');
                return (
                  <tr key={k}>
                    <td
                      className={styles.td}
                      style={{ background: bg, color: 'var(--dim)' }}
                    >
                      {section || ''}
                    </td>
                    <td
                      className={styles.td}
                      style={{ background: bg, color: 'var(--muted)' }}
                    >
                      {name}
                    </td>
                    <td className={styles.td} style={{ background: bg }}>
                      {pA ? (
                        <span
                          style={{
                            color:
                              diff || onlyOne
                                ? 'var(--amber)'
                                : 'var(--text)',
                          }}
                        >
                          {pA.value}
                        </span>
                      ) : (
                        <span className={styles.dimDash}>&mdash;</span>
                      )}
                    </td>
                    <td className={styles.td} style={{ background: bg }}>
                      {pB ? (
                        <span
                          style={{
                            color:
                              diff || onlyOne
                                ? 'var(--amber)'
                                : 'var(--text)',
                          }}
                        >
                          {pB.value}
                        </span>
                      ) : (
                        <span className={styles.dimDash}>&mdash;</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Group Objects */}
      {allCoNums.length > 0 && (
        <div className={styles.sectionBlock}>
          <div className={styles.sectionLabel}>GROUP OBJECTS</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th} style={{ width: 36 }}>
                  #
                </th>
                <th className={styles.th}>NAME</th>
                <th className={styles.th}>OBJECT FUNCTION</th>
                <th className={styles.th} style={{ width: 70 }}>
                  DPT
                </th>
                <th className={styles.th} style={{ width: 60 }}>
                  FLAGS
                </th>
                <th className={styles.th} style={{ color: colA }}>
                  GA &mdash; {addrA}
                </th>
                <th className={styles.th} style={{ color: colB }}>
                  GA &mdash; {addrB}
                </th>
              </tr>
            </thead>
            <tbody>
              {allCoNums.map((num) => {
                const coA = coMapA[num],
                  coB = coMapB[num];
                const co = coA || coB;
                const gaA = coA?.ga_address || '',
                  gaB = coB?.ga_address || '';
                const gaDiff = gaA !== gaB;
                const onlyOne = !coA || !coB;
                const anyDiff =
                  gaDiff ||
                  onlyOne ||
                  coA?.dpt !== coB?.dpt ||
                  coA?.flags !== coB?.flags;
                const rowBg = onlyOne
                  ? onlyBg
                  : anyDiff
                    ? diffBg
                    : 'transparent';
                return (
                  <tr key={num}>
                    <td
                      className={styles.td}
                      style={{ background: rowBg, color: 'var(--dim)' }}
                    >
                      {num}
                    </td>
                    <td
                      className={styles.td}
                      style={{ background: rowBg, color: 'var(--muted)' }}
                    >
                      {co.name || '—'}
                    </td>
                    <td
                      className={styles.td}
                      style={{ background: rowBg, color: 'var(--dim)' }}
                    >
                      {co.function_text || '—'}
                    </td>
                    <td className={styles.td} style={{ background: rowBg }}>
                      <span
                        className={styles.monoCell}
                        style={{
                          color:
                            coA?.dpt !== coB?.dpt
                              ? 'var(--amber)'
                              : 'var(--dim)',
                        }}
                        title={dpt.hover(co.dpt)}
                      >
                        {dpt.display(co.dpt)}
                      </span>
                    </td>
                    <td className={styles.td} style={{ background: rowBg }}>
                      <span
                        className={styles.monoCell}
                        style={{
                          color:
                            coA?.flags !== coB?.flags
                              ? 'var(--amber)'
                              : 'var(--dim)',
                        }}
                      >
                        {co.flags}
                      </span>
                    </td>
                    <td className={styles.td} style={{ background: rowBg }}>
                      {coA ? (
                        <span className={styles.gaColWrap}>
                          <GaAddrCell addr={gaA} otherAddr={gaB} />
                          {gaA && gaMap[gaA] && (
                            <span className={styles.gaSubName}>
                              {gaMap[gaA].name}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className={styles.dimDash}>&mdash;</span>
                      )}
                    </td>
                    <td className={styles.td} style={{ background: rowBg }}>
                      {coB ? (
                        <span className={styles.gaColWrap}>
                          <GaAddrCell addr={gaB} otherAddr={gaA} />
                          {gaB && gaMap[gaB] && (
                            <span className={styles.gaSubName}>
                              {gaMap[gaB].name}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className={styles.dimDash}>&mdash;</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Group Addresses */}
      {allGAs.length > 0 && (
        <div className={styles.sectionBlock}>
          <div className={styles.sectionLabel}>GROUP ADDRESSES</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th} style={{ width: 100 }}>
                  ADDRESS
                </th>
                <th className={styles.th}>NAME</th>
                <th className={styles.th} style={{ width: 70 }}>
                  DPT
                </th>
                <th
                  className={styles.th}
                  style={{ width: 60, color: colA, textAlign: 'center' }}
                >
                  {addrA}
                </th>
                <th
                  className={styles.th}
                  style={{ width: 60, color: colB, textAlign: 'center' }}
                >
                  {addrB}
                </th>
              </tr>
            </thead>
            <tbody>
              {allGAs.map((gaAddr) => {
                const inA = gasA.has(gaAddr),
                  inB = gasB.has(gaAddr);
                const onlyOne = inA !== inB;
                const rowBg = onlyOne ? onlyBg : 'transparent';
                const gaInfo = gaMap[gaAddr];
                return (
                  <tr key={gaAddr}>
                    <td className={styles.td} style={{ background: rowBg }}>
                      <PinAddr
                        address={gaAddr}
                        wtype="ga"
                        style={{
                          fontFamily: 'monospace',
                          color: 'var(--purple)',
                        }}
                      >
                        {gaAddr}
                      </PinAddr>
                    </td>
                    <td
                      className={styles.td}
                      style={{
                        background: rowBg,
                        color: 'var(--muted)',
                      }}
                    >
                      {gaInfo?.name}
                    </td>
                    <td className={styles.td} style={{ background: rowBg }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          color: 'var(--dim)',
                        }}
                        title={dpt.hover(gaInfo?.dpt)}
                      >
                        {dpt.display(gaInfo?.dpt)}
                      </span>
                    </td>
                    <td
                      className={styles.td}
                      style={{
                        background: rowBg,
                        textAlign: 'center',
                      }}
                    >
                      <span
                        style={{
                          color: inA ? 'var(--green)' : 'var(--dim)',
                        }}
                      >
                        {inA ? '✓' : '—'}
                      </span>
                    </td>
                    <td
                      className={styles.td}
                      style={{
                        background: rowBg,
                        textAlign: 'center',
                      }}
                    >
                      <span
                        style={{
                          color: inB ? 'var(--green)' : 'var(--dim)',
                        }}
                      >
                        {inB ? '✓' : '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
