import { useContext } from 'react';
import { useC } from '../theme.ts';
import { PinContext, useDpt } from '../contexts.ts';
import { TH, TD, PinAddr, SpacePath } from '../primitives.jsx';
import { dptInfo } from '../dpt.ts';

export function PinTelegramFeed({
  telegrams,
  gaMap = {},
  devMap = {},
  spaces = [],
}) {
  const C = useC();
  const _pin = useContext(PinContext);
  const dpt = useDpt();
  const spaceMap = Object.fromEntries(spaces.map((s) => [s.id, s]));
  const _spacePath = (spaceId) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' › ');
  };
  const hasSpaces = spaces.length > 0;
  const typeColor = (tp) =>
    tp?.includes('Write') ? C.text : tp?.includes('Read') ? C.amber : C.green;
  const tgTime = (tg) => {
    if (!tg) return null;
    const t = tg.timestamp || tg.time;
    return t ? new Date(t).getTime() : null;
  };
  const fmtDelta = (ms) => {
    if (ms == null) return '';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(2)}s`;
    const m = Math.floor(ms / 60000),
      s = ((ms % 60000) / 1000).toFixed(1);
    return `+${m}m${s}s`;
  };

  return (
    <div style={{ marginTop: 24 }}>
      {telegrams.length === 0 ? (
        <div style={{ fontSize: 11, color: C.dim, padding: '12px 0' }}>
          No telegrams yet
        </div>
      ) : (
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            overflow: 'auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <TH style={{ width: 155 }}>TIMESTAMP</TH>
                <TH style={{ width: 65 }}>DELTA</TH>
                <TH style={{ width: 75 }}>SOURCE</TH>
                {hasSpaces && <TH>LOCATION</TH>}
                <TH style={{ width: 75 }}>DEST GA</TH>
                <TH>GA NAME</TH>
                <TH style={{ width: 170 }}>TYPE</TH>
                <TH style={{ width: 80 }}>RAW</TH>
                <TH style={{ width: 100 }}>DECODED</TH>
                <TH style={{ width: 55 }}>DPT</TH>
              </tr>
            </thead>
            <tbody>
              {telegrams.slice(0, 100).map((tg, i) => {
                const ga = gaMap[tg.dst];
                const t0 = tgTime(tg),
                  t1 = tgTime(telegrams[i + 1]);
                const delta = t0 != null && t1 != null ? t0 - t1 : null;
                const dptI = dptInfo(ga?.dpt || '');
                const decoded =
                  tg.decoded != null && tg.decoded !== ''
                    ? (dptI.enums?.[Number(tg.decoded)] ??
                      `${tg.decoded}${dptI.unit}`)
                    : '';
                return (
                  <tr
                    key={tg.id || i}
                    className={`rh${i === 0 ? ' tgnew' : ''}`}
                  >
                    <TD>
                      <span
                        style={{
                          color: C.dim,
                          fontFamily: 'monospace',
                          fontSize: 10,
                        }}
                      >
                        {tg.timestamp?.replace('T', ' ').slice(0, 22) ||
                          tg.time}
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
                        {fmtDelta(delta)}
                      </span>
                    </TD>
                    <TD>
                      <PinAddr
                        address={tg.src}
                        wtype="device"
                        style={{
                          color: C.accent,
                          fontFamily: 'monospace',
                          fontSize: 10,
                        }}
                      />
                    </TD>
                    {hasSpaces && (
                      <TD>
                        <SpacePath
                          spaceId={devMap[tg.src]?.space_id}
                          spaces={spaces}
                          style={{ color: C.dim, fontSize: 10 }}
                        />
                      </TD>
                    )}
                    <TD>
                      <PinAddr
                        address={tg.dst}
                        wtype="ga"
                        style={{
                          color: C.purple,
                          fontFamily: 'monospace',
                          fontSize: 10,
                        }}
                      />
                    </TD>
                    <TD>
                      <span style={{ color: C.muted, fontSize: 10 }}>
                        {ga?.name || ''}
                      </span>
                    </TD>
                    <TD>
                      <span style={{ color: typeColor(tg.type), fontSize: 10 }}>
                        {tg.type}
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
                        {tg.raw_value}
                      </span>
                    </TD>
                    <TD>
                      <span
                        style={{ color: C.text, fontWeight: ga ? 500 : 400 }}
                      >
                        {decoded}
                      </span>
                    </TD>
                    <TD>
                      <span
                        style={{ color: C.dim, fontSize: 9 }}
                        title={dpt.hover(ga?.dpt)}
                      >
                        {dpt.display(ga?.dpt)}
                      </span>
                    </TD>
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
