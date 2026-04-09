import { useContext } from 'react';
import { PinContext, useDpt } from '../contexts.ts';
import { TH, TD, PinAddr, SpacePath } from '../primitives.tsx';
import { dptInfo } from '../dpt.ts';
import styles from './PinTelegramFeed.module.css';

interface PinTelegramFeedProps {
  telegrams: any[];
  gaMap?: Record<string, any>;
  devMap?: Record<string, any>;
  spaces?: any[];
}

export function PinTelegramFeed({
  telegrams,
  gaMap = {},
  devMap = {},
  spaces = [],
}: PinTelegramFeedProps) {
  const _pin = useContext(PinContext);
  const dpt = useDpt();
  const spaceMap = Object.fromEntries(spaces.map((s: any) => [s.id, s]));
  const _spacePath = (spaceId: number) => {
    const parts: string[] = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' › ');
  };
  const hasSpaces = spaces.length > 0;
  const typeColor = (tp: string | undefined) =>
    tp?.includes('Write')
      ? 'var(--text)'
      : tp?.includes('Read')
        ? 'var(--amber)'
        : 'var(--green)';
  const tgTime = (tg: any) => {
    if (!tg) return null;
    const t = tg.timestamp || tg.time;
    return t ? new Date(t).getTime() : null;
  };
  const fmtDelta = (ms: number | null) => {
    if (ms == null) return '';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(2)}s`;
    const m = Math.floor(ms / 60000),
      s = ((ms % 60000) / 1000).toFixed(1);
    return `+${m}m${s}s`;
  };

  return (
    <div className={styles.wrapper}>
      {telegrams.length === 0 ? (
        <div className={styles.empty}>No telegrams yet</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <TH className={styles.thTimestamp}>TIMESTAMP</TH>
                <TH className={styles.thDelta}>DELTA</TH>
                <TH className={styles.thSource}>SOURCE</TH>
                {hasSpaces && <TH>LOCATION</TH>}
                <TH className={styles.thDestGA}>DEST GA</TH>
                <TH>GA NAME</TH>
                <TH className={styles.thType}>TYPE</TH>
                <TH className={styles.thRaw}>RAW</TH>
                <TH className={styles.thDecoded}>DECODED</TH>
                <TH className={styles.thDpt}>DPT</TH>
              </tr>
            </thead>
            <tbody>
              {telegrams.slice(0, 100).map((tg: any, i: number) => {
                const ga = gaMap[tg.dst];
                const t0 = tgTime(tg),
                  t1 = tgTime(telegrams[i + 1]);
                const delta = t0 != null && t1 != null ? t0 - t1 : null;
                const dptI = dptInfo(ga?.dpt || '') as any;
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
                      <span className={styles.dimMono}>
                        {tg.timestamp?.replace('T', ' ').slice(0, 22) ||
                          tg.time}
                      </span>
                    </TD>
                    <TD>
                      <span className={styles.dimMono}>{fmtDelta(delta)}</span>
                    </TD>
                    <TD>
                      <PinAddr
                        address={tg.src}
                        wtype="device"
                        className={styles.srcAddr}
                      />
                    </TD>
                    {hasSpaces && (
                      <TD>
                        <SpacePath
                          spaceId={devMap[tg.src]?.space_id}
                          spaces={spaces}
                          className={styles.spacePathCell}
                        />
                      </TD>
                    )}
                    <TD>
                      <PinAddr
                        address={tg.dst}
                        wtype="ga"
                        className={styles.dstAddr}
                      />
                    </TD>
                    <TD>
                      <span className={styles.gaName}>{ga?.name || ''}</span>
                    </TD>
                    <TD>
                      <span
                        className={styles.typeCell}
                        style={{ color: typeColor(tg.type) }}
                      >
                        {tg.type}
                      </span>
                    </TD>
                    <TD>
                      <span className={styles.rawCell}>{tg.raw_value}</span>
                    </TD>
                    <TD>
                      <span
                        className={ga ? styles.decodedGa : styles.decodedNormal}
                      >
                        {decoded}
                      </span>
                    </TD>
                    <TD>
                      <span
                        className={styles.dptCell}
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
