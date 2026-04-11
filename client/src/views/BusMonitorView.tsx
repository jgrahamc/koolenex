import { useState, useEffect, useRef, useContext, useMemo } from 'react';
import { useDpt, PinContext } from '../contexts.ts';
import {
  Badge,
  Btn,
  Chip,
  Spinner,
  TH,
  TD,
  SearchBox,
  SectionHeader,
  Empty,
  PinAddr,
  SpacePath,
  coGAs,
} from '../primitives.tsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { dptInfo } from '../dpt.ts';
import { useSpacePath } from '../hooks/spaces.ts';
import styles from './BusMonitorView.module.css';

function TelegramFlowPanel({
  telegrams,
  gaMap,
  devMap,
  comObjects,
}: {
  telegrams: any[];
  gaMap: Record<string, any>;
  devMap: Record<string, any>;
  comObjects: any[];
}) {
  const pin = useContext(PinContext);
  // Build GA → [linked device addresses] from comObjects
  const gaDevMap = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const co of comObjects || []) {
      for (const ga of coGAs(co)) {
        if (!m[ga]) m[ga] = [];
        if (!m[ga]!.includes(co.device_address)) m[ga]!.push(co.device_address);
      }
    }
    return m;
  }, [comObjects]);

  const recent = telegrams.slice(0, 6);

  if (recent.length === 0)
    return (
      <div className={styles.flowEmpty}>
        <span className={styles.flowEmptyText}>Waiting for live activity…</span>
      </div>
    );

  return (
    <div className={styles.flowPanel}>
      <div className={styles.flowLabel}>LIVE FLOW</div>
      {recent.map((tg: any, i: number) => {
        const opacity =
          ([1, 0.82, 0.65, 0.48, 0.32, 0.18] as number[])[i] ?? 0.18;
        const srcDev = devMap[tg.src as string];
        const ga = gaMap[tg.dst as string];
        const dptI = dptInfo(ga?.dpt);
        const decoded =
          tg.decoded != null && tg.decoded !== ''
            ? (dptI.enums?.[Number(tg.decoded)] ?? `${tg.decoded}${dptI.unit}`)
            : null;
        const isWrite = tg.type?.includes('Write');
        const isRead = tg.type?.includes('Read');
        const typeCol = isWrite
          ? 'var(--accent)'
          : isRead
            ? 'var(--amber)'
            : 'var(--green)';
        const receivers = isWrite
          ? (gaDevMap[tg.dst as string] || [])
              .filter((a: string) => a !== tg.src)
              .slice(0, 5)
          : [];
        const isNew = i === 0;

        const chip = (
          label: string,
          sub: string | undefined,
          color: string,
          glow: boolean,
          onClick?: () => void,
        ) => (
          <div
            onClick={onClick}
            className={styles.flowChip}
            style={{
              background: glow
                ? `color-mix(in srgb, ${color} 8%, transparent)`
                : 'var(--surface)',
              border: `1px solid ${glow ? `color-mix(in srgb, ${color} 44%, transparent)` : 'var(--border)'}`,
              color,
              boxShadow: glow
                ? `0 0 8px color-mix(in srgb, ${color} 21%, transparent)`
                : 'none',
              cursor: onClick ? 'pointer' : 'default',
            }}
          >
            {label}
            {sub ? <span className={styles.flowChipSub}>{sub}</span> : null}
          </div>
        );

        return (
          <div
            key={tg.id || i}
            className={`${styles.flowRow} ${isNew ? 'flowin' : ''}`}
            style={{ opacity }}
          >
            {/* Source device */}
            {chip(
              tg.src,
              srcDev?.name?.slice(0, 16),
              'var(--accent)',
              isNew,
              pin ? () => pin('device', tg.src) : undefined,
            )}

            {/* Arrow */}
            <span className={styles.flowArrow} style={{ color: typeCol }}>
              →
            </span>

            {/* Destination GA + value */}
            <div
              onClick={pin ? () => pin('ga', tg.dst) : undefined}
              className={styles.flowDstChip}
              style={{
                background: isNew ? 'var(--purple-15)' : 'var(--surface)',
                border: `1px solid ${isNew ? 'var(--purple-70)' : 'var(--border)'}`,
                color: 'var(--purple)',
                boxShadow: isNew ? '0 0 8px var(--purple-35)' : 'none',
                cursor: pin ? 'pointer' : 'default',
              }}
            >
              {tg.dst}
              {ga?.name ? (
                <span className={styles.flowDstName}>
                  {ga.name.slice(0, 18)}
                </span>
              ) : null}
              {decoded != null ? (
                <span className={styles.flowDecodedVal}>{decoded}</span>
              ) : null}
            </div>

            {/* Receivers */}
            {receivers.length > 0 && (
              <>
                <span className={styles.flowArrow} style={{ color: typeCol }}>
                  →
                </span>
                <div className={styles.flowReceivers}>
                  {receivers.map((addr: string) =>
                    chip(
                      addr,
                      devMap[addr]?.name?.slice(0, 12),
                      'var(--muted)',
                      false,
                    ),
                  )}
                </div>
              </>
            )}

            {/* Type label (right-aligned) */}
            <span className={styles.flowType} style={{ color: typeCol }}>
              {tg.type?.replace('GroupValue', '')?.trim()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface BusMonitorViewProps {
  telegrams: any[];
  busConnected: boolean;
  activeProjectId: any;
  onClear: () => void;
  onWrite?: ((ga: string, val: string, dpt: string) => Promise<void>) | null;
  data: any;
}

export function BusMonitorView({
  telegrams,
  busConnected,
  activeProjectId: _activeProjectId,
  onClear,
  onWrite,
  data,
}: BusMonitorViewProps) {
  const dpt = useDpt();
  const [filter, setFilter] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<any[] | null>(null);
  const [showSend, setShowSend] = useState(false);
  const [showFlow, setShowFlow] = useState(true);
  const [sendGa, setSendGa] = useState('');
  const [sendVal, setSendVal] = useState('');
  const [sendDpt, setSendDpt] = useState('1');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(telegrams.length);

  const MON_COLS = useMemo(
    () => [
      { id: 'timestamp', label: 'Timestamp', visible: true },
      { id: 'delta', label: 'Δt', visible: true },
      { id: 'src', label: 'Source', visible: true },
      { id: 'location', label: 'Location', visible: true },
      { id: 'dst', label: 'Dest GA', visible: true },
      { id: 'ga_name', label: 'GA Name', visible: true },
      { id: 'type', label: 'Type', visible: true },
      { id: 'raw_value', label: 'Raw', visible: false },
      { id: 'decoded', label: 'Decoded', visible: true },
      { id: 'dpt', label: 'DPT', visible: true },
      { id: 'priority', label: 'Priority', visible: false },
    ],
    [],
  );
  const [monCols, saveMonCols] = useColumns('monitor', MON_COLS);
  const mcv = (id: string) =>
    monCols.find((c: any) => c.id === id)?.visible !== false;

  const gaMap = useMemo(() => {
    const m: Record<string, any> = {};
    for (const g of data?.gas || []) m[g.address] = g;
    return m;
  }, [data]);

  const devMap = useMemo(() => {
    const m: Record<string, any> = {};
    for (const d of data?.devices || []) m[d.individual_address] = d;
    return m;
  }, [data]);

  const { spacePath } = useSpacePath(data?.spaces || []);

  // Auto-scroll to top when new telegrams arrive and not paused
  useEffect(() => {
    if (!paused && telegrams.length !== prevLenRef.current) {
      prevLenRef.current = telegrams.length;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [telegrams.length, paused]);

  const togglePause = () => {
    if (!paused) setSnapshot([...telegrams]);
    else setSnapshot(null);
    setPaused((p) => !p);
  };

  const displayTelegrams = paused ? snapshot || telegrams : telegrams;
  const newCount = paused ? telegrams.length - (snapshot?.length || 0) : 0;

  const filtered = displayTelegrams.filter((t: any) => {
    if (filterType !== 'all' && !t.type?.includes(filterType)) return false;
    const s = filter.toLowerCase();
    if (!s) return true;
    const gaName = gaMap[t.dst]?.name || '';
    return (
      t.src?.includes(s) ||
      t.dst?.includes(s) ||
      t.type?.toLowerCase().includes(s) ||
      gaName.toLowerCase().includes(s)
    );
  });

  const getDecoded = (tg: any) => {
    const ga = gaMap[tg.dst];
    const info = dptInfo(ga?.dpt || '');
    if (tg.decoded == null || tg.decoded === '') return '';
    // If DPT has enum labels, show label instead of raw number
    if (info.enums) {
      const label = info.enums[Number(tg.decoded)];
      if (label != null) return label;
    }
    return `${tg.decoded}${info.unit}`;
  };

  const exportMonCSV = () => {
    const rows = filtered.map((tg: any, i: number) => {
      const ga = gaMap[tg.dst];
      const t0 = tgTime(tg),
        t1 = tgTime(filtered[i + 1]);
      const delta = t0 != null && t1 != null ? fmtDelta(t0 - t1) : '';
      return {
        timestamp: tg.timestamp?.replace('T', ' ').slice(0, 22) || '',
        delta,
        src: tg.src || '',
        location: spacePath(devMap[tg.src]?.space_id),
        dst: tg.dst || '',
        ga_name: ga?.name || '',
        type: tg.type || '',
        raw_value: tg.raw_value || '',
        decoded: getDecoded(tg),
        dpt: dpt.display(ga?.dpt) || '',
        priority: tg.priority || '',
      };
    });
    dlCSV(
      `koolenex-monitor-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`,
      monCols,
      rows,
      (id, r) => r[id] ?? '',
    );
  };

  const doSend = async (val: string = sendVal) => {
    if (!sendGa || !onWrite) return;
    setSending(true);
    try {
      await onWrite(sendGa, val, sendDpt);
    } catch (_) {}
    setSending(false);
  };

  const typeColor = (tp: string | undefined) =>
    tp?.includes('Write')
      ? 'var(--text)'
      : tp?.includes('Read')
        ? 'var(--amber)'
        : 'var(--green)';

  const fmtDelta = (ms: number | null) => {
    if (ms == null) return '';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(2)}s`;
    const m = Math.floor(ms / 60000),
      s = ((ms % 60000) / 1000).toFixed(1);
    return `+${m}m${s}s`;
  };
  const tgTime = (tg: any) => {
    if (!tg) return null;
    const t = tg.timestamp || tg.time;
    return t ? new Date(t).getTime() : null;
  };

  return (
    <div className={styles.root}>
      <SectionHeader
        title="Monitor"
        count={filtered.length}
        actions={[
          <Badge
            key="status"
            label={busConnected ? 'LIVE' : 'OFFLINE'}
            color={busConnected ? 'var(--green)' : 'var(--dim)'}
          />,
          <Btn
            key="pause"
            onClick={togglePause}
            color={paused ? 'var(--amber)' : 'var(--muted)'}
            bg="var(--surface)"
          >
            {paused ? '▷ Resume' : '⏸ Pause'}
          </Btn>,
          <Btn
            key="send"
            onClick={() => setShowSend((s) => !s)}
            color={showSend ? 'var(--accent)' : 'var(--muted)'}
            bg="var(--surface)"
            disabled={!busConnected}
          >
            ⊕ Send
          </Btn>,
          <Btn
            key="flow"
            onClick={() => setShowFlow((s) => !s)}
            color={showFlow ? 'var(--purple)' : 'var(--muted)'}
            bg="var(--surface)"
          >
            ⬡ Flow
          </Btn>,
          <ColumnPicker key="cp" cols={monCols} onChange={saveMonCols} />,
          <Btn
            key="exp"
            onClick={exportMonCSV}
            color="var(--muted)"
            bg="var(--surface)"
          >
            ↓ CSV
          </Btn>,
          <Btn
            key="clr"
            onClick={onClear}
            color="var(--muted)"
            bg="var(--surface)"
          >
            Clear
          </Btn>,
          <SearchBox
            key="s"
            value={filter}
            onChange={setFilter}
            placeholder="Filter GA, src, type…"
          />,
          ...['all', 'Write', 'Read', 'Response'].map((t) => (
            <Chip
              key={t}
              active={filterType === t}
              onClick={() => setFilterType(t)}
            >
              {t}
            </Chip>
          )),
        ]}
      />

      {showSend && (
        <div className={styles.sendPanel}>
          <span className={styles.sendLabel}>SEND</span>
          <input
            value={sendGa}
            onChange={(e) => setSendGa(e.target.value)}
            placeholder="GA (x/y/z)"
            list="bm-ga-list"
            className={styles.sendInputWide}
          />
          <datalist id="bm-ga-list">
            {(data?.gas || []).map((g: any) => (
              <option key={g.address} value={g.address}>
                {g.name}
              </option>
            ))}
          </datalist>
          <select
            value={sendDpt}
            onChange={(e) => setSendDpt(e.target.value)}
            className={styles.sendSelect}
          >
            <option value="1">DPT 1 — Bool</option>
            <option value="5">DPT 5 — 0–255</option>
            <option value="9">DPT 9 — Float</option>
          </select>
          {sendDpt === '1' ? (
            <div className={styles.boolRow}>
              <Btn
                onClick={() => doSend('1')}
                color="var(--green)"
                bg="var(--surface)"
                disabled={!sendGa || sending}
              >
                On
              </Btn>
              <Btn
                onClick={() => doSend('0')}
                color="var(--red)"
                bg="var(--surface)"
                disabled={!sendGa || sending}
              >
                Off
              </Btn>
            </div>
          ) : (
            <>
              <input
                value={sendVal}
                onChange={(e) => setSendVal(e.target.value)}
                placeholder="Value"
                className={styles.sendInputNarrow}
              />
              <Btn onClick={() => doSend()} disabled={!sendGa || sending}>
                {sending ? <Spinner /> : '▷ Send'}
              </Btn>
            </>
          )}
        </div>
      )}

      {paused && (
        <div className={styles.pausedBar}>
          ⏸ Paused
          {newCount > 0
            ? ` — ${newCount} new telegram${newCount !== 1 ? 's' : ''} waiting`
            : ''}
        </div>
      )}

      <div ref={scrollRef} className={styles.scrollArea}>
        <table className={styles.table}>
          <thead>
            <tr>
              {monCols
                .filter((c: any) => c.visible !== false)
                .map((col: any) => (
                  <TH
                    key={col.id}
                    className={
                      col.id === 'timestamp'
                        ? styles.thTimestamp
                        : col.id === 'delta'
                          ? styles.thDelta
                          : col.id === 'src'
                            ? styles.thSrc
                            : col.id === 'dst'
                              ? styles.thDst
                              : col.id === 'type'
                                ? styles.thType
                                : col.id === 'raw_value'
                                  ? styles.thRaw
                                  : col.id === 'decoded'
                                    ? styles.thDecoded
                                    : col.id === 'dpt'
                                      ? styles.thDpt
                                      : col.id === 'priority'
                                        ? styles.thPriority
                                        : undefined
                    }
                  >
                    {col.label.toUpperCase().replace('GAS', 'GAs')}
                  </TH>
                ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((tg: any, i: number) => {
              const ga = gaMap[tg.dst as string];
              const t0 = tgTime(tg),
                t1 = tgTime(filtered[i + 1]);
              const delta = t0 != null && t1 != null ? t0 - t1 : null;
              return (
                <tr
                  key={tg.id || i}
                  className={`rh ${i === 0 && !paused ? 'tgnew' : ''}`}
                >
                  {mcv('timestamp') && (
                    <TD>
                      <span className={styles.monoSmall}>
                        {tg.timestamp?.replace('T', ' ').slice(0, 22) ||
                          tg.time}
                      </span>
                    </TD>
                  )}
                  {mcv('delta') && (
                    <TD>
                      <span className={styles.monoSmall}>
                        {fmtDelta(delta)}
                      </span>
                    </TD>
                  )}
                  {mcv('src') && (
                    <TD>
                      <PinAddr
                        address={tg.src}
                        wtype="device"
                        title={devMap[tg.src]?.name}
                        className={styles.srcAddr}
                      />
                    </TD>
                  )}
                  {mcv('location') && data?.spaces?.length > 0 && (
                    <TD>
                      <SpacePath
                        spaceId={devMap[tg.src]?.space_id}
                        spaces={data.spaces}
                        className={styles.monoSmall}
                      />
                    </TD>
                  )}
                  {mcv('dst') && (
                    <TD>
                      <PinAddr
                        address={tg.dst}
                        wtype="ga"
                        title={ga?.name}
                        className={styles.dstAddr}
                      />
                    </TD>
                  )}
                  {mcv('ga_name') && (
                    <TD>
                      <span className={styles.gaName}>{ga?.name || ''}</span>
                    </TD>
                  )}
                  {mcv('type') && (
                    <TD>
                      <span
                        className={styles.typeSpan}
                        style={{ color: typeColor(tg.type) }}
                      >
                        {tg.type}
                      </span>
                    </TD>
                  )}
                  {mcv('raw_value') && (
                    <TD>
                      <span className={styles.monoSmall}>{tg.raw_value}</span>
                    </TD>
                  )}
                  {mcv('decoded') && (
                    <TD>
                      <span
                        className={
                          ga ? styles.decodedBold : styles.decodedNormal
                        }
                      >
                        {getDecoded(tg)}
                      </span>
                    </TD>
                  )}
                  {mcv('dpt') && (
                    <TD>
                      <span
                        className={styles.dptSmall}
                        title={dpt.hover(ga?.dpt)}
                      >
                        {dpt.display(ga?.dpt)}
                      </span>
                    </TD>
                  )}
                  {mcv('priority') && (
                    <TD>
                      <span className={styles.prioritySmall}>
                        {tg.priority || ''}
                      </span>
                    </TD>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <Empty
            icon="◎"
            msg={
              busConnected
                ? 'Waiting for telegrams…'
                : 'Connect to KNX bus to see live traffic'
            }
          />
        )}
      </div>
      {showFlow && (
        <TelegramFlowPanel
          telegrams={paused ? snapshot || telegrams : telegrams}
          gaMap={gaMap}
          devMap={devMap}
          comObjects={data?.comObjects}
        />
      )}
    </div>
  );
}
