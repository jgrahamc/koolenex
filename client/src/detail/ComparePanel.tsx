import { useContext, useMemo } from 'react';
import { PinContext, useDpt } from '../contexts.ts';
import { Empty, PinAddr, coGAs } from '../primitives.tsx';

interface GaAddrCellProps {
  addr: string;
  otherAddr: string;
  C: any;
}

function GaAddrCell({ addr, otherAddr, C }: GaAddrCellProps) {
  if (!addr)
    return (
      <span style={{ color: C.dim, fontFamily: 'monospace' }}>&mdash;</span>
    );
  if (!otherAddr || addr === otherAddr) {
    return (
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: 10,
          color: addr !== otherAddr ? C.amber : C.muted,
        }}
      >
        {addr}
      </span>
    );
  }
  const pa = addr.split('/'),
    po = otherAddr.split('/');
  return (
    <span style={{ fontFamily: 'monospace', fontSize: 10 }}>
      {pa.map((p, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: C.dim }}>/</span>}
          <span
            style={{
              color: p !== po[i] ? C.amber : C.muted,
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

export function ComparePanel({ addrA, addrB, data, C }: ComparePanelProps) {
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

  if (!devA || !devB) return <Empty icon="\u25C8" msg="Device not found" />;

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

  const diffBg = `${C.amber}18`;
  const onlyBg = `${C.red}12`;
  const TH2 = ({
    children,
    style,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
  }) => (
    <th
      style={{
        padding: '5px 8px',
        textAlign: 'left',
        fontSize: 9,
        color: C.dim,
        fontWeight: 600,
        letterSpacing: '0.07em',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        ...style,
      }}
    >
      {children}
    </th>
  );
  const TD2 = ({
    children,
    style,
    diff,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
    diff?: boolean;
  }) => (
    <td
      style={{
        padding: '4px 8px',
        fontSize: 10,
        borderBottom: `1px solid ${C.border}`,
        background: diff ? diffBg : 'transparent',
        ...style,
      }}
    >
      {children ?? <span style={{ color: C.dim }}>&mdash;</span>}
    </td>
  );

  const colA = C.accent;
  const colB = C.purple;

  return (
    <div style={{ padding: 20 }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 20,
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            flex: 1,
            padding: '10px 14px',
            background: C.surface,
            border: `2px solid ${colA}40`,
            borderRadius: 6,
          }}
        >
          <div
            onClick={pin ? () => pin('device', addrA) : undefined}
            style={{
              fontFamily: 'monospace',
              fontSize: 14,
              fontWeight: 700,
              color: colA,
              cursor: pin ? 'pointer' : 'default',
            }}
          >
            {addrA}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {devA.name}
          </div>
          {devA.model && (
            <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
              {devA.model}
            </div>
          )}
        </div>
        <div
          style={{
            fontSize: 18,
            color: C.dim,
            alignSelf: 'center',
            flexShrink: 0,
          }}
        >
          \u21C4
        </div>
        <div
          style={{
            flex: 1,
            padding: '10px 14px',
            background: C.surface,
            border: `2px solid ${colB}40`,
            borderRadius: 6,
          }}
        >
          <div
            onClick={pin ? () => pin('device', addrB) : undefined}
            style={{
              fontFamily: 'monospace',
              fontSize: 14,
              fontWeight: 700,
              color: colB,
              cursor: pin ? 'pointer' : 'default',
            }}
          >
            {addrB}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {devB.name}
          </div>
          {devB.model && (
            <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
              {devB.model}
            </div>
          )}
        </div>
      </div>

      {/* Parameters */}
      {allParamKeys.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 10,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            PARAMETERS
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH2 style={{ width: '22%' }}>SECTION</TH2>
                <TH2 style={{ width: '26%' }}>NAME</TH2>
                <TH2 style={{ color: colA }}>VALUE &mdash; {addrA}</TH2>
                <TH2 style={{ color: colB }}>VALUE &mdash; {addrB}</TH2>
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
                    <TD2 style={{ background: bg, color: C.dim }}>
                      {section || ''}
                    </TD2>
                    <TD2 style={{ background: bg, color: C.muted }}>{name}</TD2>
                    <TD2 style={{ background: bg }} diff={false}>
                      {pA ? (
                        <span
                          style={{ color: diff || onlyOne ? C.amber : C.text }}
                        >
                          {pA.value}
                        </span>
                      ) : (
                        <span style={{ color: C.dim }}>&mdash;</span>
                      )}
                    </TD2>
                    <TD2 style={{ background: bg }} diff={false}>
                      {pB ? (
                        <span
                          style={{ color: diff || onlyOne ? C.amber : C.text }}
                        >
                          {pB.value}
                        </span>
                      ) : (
                        <span style={{ color: C.dim }}>&mdash;</span>
                      )}
                    </TD2>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Group Objects */}
      {allCoNums.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 10,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            GROUP OBJECTS
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH2 style={{ width: 36 }}>#</TH2>
                <TH2>NAME</TH2>
                <TH2>OBJECT FUNCTION</TH2>
                <TH2 style={{ width: 70 }}>DPT</TH2>
                <TH2 style={{ width: 60 }}>FLAGS</TH2>
                <TH2 style={{ color: colA }}>GA &mdash; {addrA}</TH2>
                <TH2 style={{ color: colB }}>GA &mdash; {addrB}</TH2>
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
                    <TD2 style={{ background: rowBg, color: C.dim }}>{num}</TD2>
                    <TD2 style={{ background: rowBg, color: C.muted }}>
                      {co.name || '\u2014'}
                    </TD2>
                    <TD2 style={{ background: rowBg, color: C.dim }}>
                      {co.function_text || '\u2014'}
                    </TD2>
                    <TD2 style={{ background: rowBg }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          color: coA?.dpt !== coB?.dpt ? C.amber : C.dim,
                        }}
                        title={dpt.hover(co.dpt)}
                      >
                        {dpt.display(co.dpt)}
                      </span>
                    </TD2>
                    <TD2 style={{ background: rowBg }}>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          color: coA?.flags !== coB?.flags ? C.amber : C.dim,
                        }}
                      >
                        {co.flags}
                      </span>
                    </TD2>
                    <TD2 style={{ background: rowBg }} diff={false}>
                      {coA ? (
                        <span
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                          }}
                        >
                          <GaAddrCell addr={gaA} otherAddr={gaB} C={C} />
                          {gaA && gaMap[gaA] && (
                            <span style={{ fontSize: 9, color: C.dim }}>
                              {gaMap[gaA].name}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: C.dim }}>&mdash;</span>
                      )}
                    </TD2>
                    <TD2 style={{ background: rowBg }} diff={false}>
                      {coB ? (
                        <span
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 1,
                          }}
                        >
                          <GaAddrCell addr={gaB} otherAddr={gaA} C={C} />
                          {gaB && gaMap[gaB] && (
                            <span style={{ fontSize: 9, color: C.dim }}>
                              {gaMap[gaB].name}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span style={{ color: C.dim }}>&mdash;</span>
                      )}
                    </TD2>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Group Addresses */}
      {allGAs.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 10,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            GROUP ADDRESSES
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH2 style={{ width: 100 }}>ADDRESS</TH2>
                <TH2>NAME</TH2>
                <TH2 style={{ width: 70 }}>DPT</TH2>
                <TH2 style={{ width: 60, color: colA, textAlign: 'center' }}>
                  {addrA}
                </TH2>
                <TH2 style={{ width: 60, color: colB, textAlign: 'center' }}>
                  {addrB}
                </TH2>
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
                    <TD2 style={{ background: rowBg }}>
                      <PinAddr
                        address={gaAddr}
                        wtype="ga"
                        style={{ fontFamily: 'monospace', color: C.purple }}
                      >
                        {gaAddr}
                      </PinAddr>
                    </TD2>
                    <TD2 style={{ background: rowBg, color: C.muted }}>
                      {gaInfo?.name}
                    </TD2>
                    <TD2 style={{ background: rowBg }}>
                      <span
                        style={{ fontFamily: 'monospace', color: C.dim }}
                        title={dpt.hover(gaInfo?.dpt)}
                      >
                        {dpt.display(gaInfo?.dpt)}
                      </span>
                    </TD2>
                    <TD2 style={{ background: rowBg, textAlign: 'center' }}>
                      <span style={{ color: inA ? C.green : C.dim }}>
                        {inA ? '\u2713' : '\u2014'}
                      </span>
                    </TD2>
                    <TD2 style={{ background: rowBg, textAlign: 'center' }}>
                      <span style={{ color: inB ? C.green : C.dim }}>
                        {inB ? '\u2713' : '\u2014'}
                      </span>
                    </TD2>
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
