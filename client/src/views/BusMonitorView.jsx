import { useState, useEffect, useRef, useContext, useMemo } from 'react';
import { useC } from '../theme.ts';
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
} from '../primitives.jsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.jsx';
import { dptInfo } from '../dpt.ts';

function TelegramFlowPanel({ telegrams, gaMap, devMap, comObjects, C }) {
  const pin = useContext(PinContext);
  // Build GA → [linked device addresses] from comObjects
  const gaDevMap = useMemo(() => {
    const m = {};
    for (const co of comObjects || []) {
      for (const ga of coGAs(co)) {
        if (!m[ga]) m[ga] = [];
        if (!m[ga].includes(co.device_address)) m[ga].push(co.device_address);
      }
    }
    return m;
  }, [comObjects]);

  const recent = telegrams.slice(0, 6);

  if (recent.length === 0)
    return (
      <div
        style={{
          borderTop: `1px solid ${C.border}`,
          background: C.sidebar,
          height: 54,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 11, color: C.dim }}>
          Waiting for live activity…
        </span>
      </div>
    );

  return (
    <div
      style={{
        borderTop: `1px solid ${C.border}`,
        background: C.sidebar,
        padding: '8px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: C.dim,
          letterSpacing: '0.1em',
          marginBottom: 1,
        }}
      >
        LIVE FLOW
      </div>
      {recent.map((tg, i) => {
        const opacity = [1, 0.82, 0.65, 0.48, 0.32, 0.18][i] ?? 0.18;
        const srcDev = devMap[tg.src];
        const ga = gaMap[tg.dst];
        const dptI = dptInfo(ga?.dpt);
        const decoded =
          tg.decoded != null && tg.decoded !== ''
            ? (dptI.enums?.[Number(tg.decoded)] ?? `${tg.decoded}${dptI.unit}`)
            : null;
        const isWrite = tg.type?.includes('Write');
        const isRead = tg.type?.includes('Read');
        const typeCol = isWrite ? C.accent : isRead ? C.amber : C.green;
        const receivers = isWrite
          ? (gaDevMap[tg.dst] || []).filter((a) => a !== tg.src).slice(0, 5)
          : [];
        const isNew = i === 0;

        const chip = (label, sub, color, glow, onClick) => (
          <div
            onClick={onClick}
            style={{
              background: glow ? `${color}15` : C.surface,
              border: `1px solid ${glow ? `${color}70` : C.border}`,
              borderRadius: 3,
              padding: '1px 8px',
              fontSize: 10,
              fontFamily: 'monospace',
              color,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              boxShadow: glow ? `0 0 8px ${color}35` : 'none',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: onClick ? 'pointer' : 'default',
            }}
          >
            {label}
            {sub ? (
              <span style={{ color: C.dim, fontSize: 9, marginLeft: 5 }}>
                {sub}
              </span>
            ) : null}
          </div>
        );

        return (
          <div
            key={tg.id || i}
            className={isNew ? 'flowin' : ''}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              opacity,
              height: 22,
              overflow: 'hidden',
            }}
          >
            {/* Source device */}
            {chip(
              tg.src,
              srcDev?.name?.slice(0, 16),
              C.accent,
              isNew,
              pin ? () => pin('device', tg.src) : undefined,
            )}

            {/* Arrow */}
            <span style={{ color: typeCol, fontSize: 13, flexShrink: 0 }}>
              →
            </span>

            {/* Destination GA + value */}
            <div
              onClick={pin ? () => pin('ga', tg.dst) : undefined}
              style={{
                background: isNew ? `${C.purple}15` : C.surface,
                border: `1px solid ${isNew ? `${C.purple}70` : C.border}`,
                borderRadius: 3,
                padding: '1px 8px',
                fontSize: 10,
                fontFamily: 'monospace',
                color: C.purple,
                whiteSpace: 'nowrap',
                flexShrink: 0,
                boxShadow: isNew ? `0 0 8px ${C.purple}35` : 'none',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                cursor: pin ? 'pointer' : 'default',
              }}
            >
              {tg.dst}
              {ga?.name ? (
                <span style={{ color: C.muted, fontSize: 9, marginLeft: 5 }}>
                  {ga.name.slice(0, 18)}
                </span>
              ) : null}
              {decoded != null ? (
                <span
                  style={{
                    color: C.text,
                    fontWeight: 600,
                    marginLeft: 8,
                    fontSize: 10,
                  }}
                >
                  {decoded}
                </span>
              ) : null}
            </div>

            {/* Receivers */}
            {receivers.length > 0 && (
              <>
                <span style={{ color: typeCol, fontSize: 13, flexShrink: 0 }}>
                  →
                </span>
                <div style={{ display: 'flex', gap: 4, overflow: 'hidden' }}>
                  {receivers.map((addr) =>
                    chip(
                      addr,
                      devMap[addr]?.name?.slice(0, 12),
                      C.muted,
                      false,
                    ),
                  )}
                </div>
              </>
            )}

            {/* Type label (right-aligned) */}
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 9,
                color: typeCol,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {tg.type?.replace('GroupValue', '')?.trim()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function BusMonitorView({
  telegrams,
  busConnected,
  activeProjectId: _activeProjectId,
  onClear,
  onWrite,
  data,
}) {
  const C = useC();
  const dpt = useDpt();
  const [filter, setFilter] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [showSend, setShowSend] = useState(false);
  const [showFlow, setShowFlow] = useState(true);
  const [sendGa, setSendGa] = useState('');
  const [sendVal, setSendVal] = useState('');
  const [sendDpt, setSendDpt] = useState('1');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
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
  const mcv = (id) => monCols.find((c) => c.id === id)?.visible !== false;

  const gaMap = useMemo(() => {
    const m = {};
    for (const g of data?.gas || []) m[g.address] = g;
    return m;
  }, [data]);

  const devMap = useMemo(() => {
    const m = {};
    for (const d of data?.devices || []) m[d.individual_address] = d;
    return m;
  }, [data]);

  const spaceMap = useMemo(
    () => Object.fromEntries((data?.spaces || []).map((s) => [s.id, s])),
    [data],
  );
  const spacePath = (spaceId) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' › ');
  };

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

  const filtered = displayTelegrams.filter((t) => {
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

  const getDecoded = (tg) => {
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
    const rows = filtered.map((tg, i) => {
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

  const doSend = async (val = sendVal) => {
    if (!sendGa || !onWrite) return;
    setSending(true);
    try {
      await onWrite(sendGa, val, sendDpt);
    } catch (_) {}
    setSending(false);
  };

  const typeColor = (tp) =>
    tp?.includes('Write') ? C.text : tp?.includes('Read') ? C.amber : C.green;

  const fmtDelta = (ms) => {
    if (ms == null) return '';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(2)}s`;
    const m = Math.floor(ms / 60000),
      s = ((ms % 60000) / 1000).toFixed(1);
    return `+${m}m${s}s`;
  };
  const tgTime = (tg) => {
    if (!tg) return null;
    const t = tg.timestamp || tg.time;
    return t ? new Date(t).getTime() : null;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
      }}
    >
      <SectionHeader
        title="Monitor"
        count={`${filtered.length} telegrams`}
        actions={[
          <Badge
            key="status"
            label={busConnected ? 'LIVE' : 'OFFLINE'}
            color={busConnected ? C.green : C.dim}
          />,
          <Btn
            key="pause"
            onClick={togglePause}
            color={paused ? C.amber : C.muted}
            bg={C.surface}
          >
            {paused ? '▷ Resume' : '⏸ Pause'}
          </Btn>,
          <Btn
            key="send"
            onClick={() => setShowSend((s) => !s)}
            color={showSend ? C.accent : C.muted}
            bg={C.surface}
            disabled={!busConnected}
          >
            ⊕ Send
          </Btn>,
          <Btn
            key="flow"
            onClick={() => setShowFlow((s) => !s)}
            color={showFlow ? C.purple : C.muted}
            bg={C.surface}
          >
            ⬡ Flow
          </Btn>,
          <ColumnPicker key="cp" cols={monCols} onChange={saveMonCols} C={C} />,
          <Btn key="exp" onClick={exportMonCSV} color={C.muted} bg={C.surface}>
            ↓ CSV
          </Btn>,
          <Btn key="clr" onClick={onClear} color={C.muted} bg={C.surface}>
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
        <div
          style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: C.surface,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 10, color: C.dim, flexShrink: 0 }}>
            SEND
          </span>
          <input
            value={sendGa}
            onChange={(e) => setSendGa(e.target.value)}
            placeholder="GA (x/y/z)"
            list="bm-ga-list"
            style={{
              background: C.bg,
              border: `1px solid ${C.border2}`,
              borderRadius: 4,
              padding: '6px 10px',
              color: C.text,
              fontSize: 11,
              fontFamily: 'inherit',
              width: 110,
            }}
          />
          <datalist id="bm-ga-list">
            {(data?.gas || []).map((g) => (
              <option key={g.address} value={g.address}>
                {g.name}
              </option>
            ))}
          </datalist>
          <select
            value={sendDpt}
            onChange={(e) => setSendDpt(e.target.value)}
            style={{
              background: C.bg,
              border: `1px solid ${C.border2}`,
              borderRadius: 4,
              padding: '6px 10px',
              color: C.text,
              fontSize: 11,
              fontFamily: 'inherit',
            }}
          >
            <option value="1">DPT 1 — Bool</option>
            <option value="5">DPT 5 — 0–255</option>
            <option value="9">DPT 9 — Float</option>
          </select>
          {sendDpt === '1' ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <Btn
                onClick={() => doSend('1')}
                color={C.green}
                bg={C.surface}
                disabled={!sendGa || sending}
              >
                On
              </Btn>
              <Btn
                onClick={() => doSend('0')}
                color={C.red}
                bg={C.surface}
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
                style={{
                  background: C.bg,
                  border: `1px solid ${C.border2}`,
                  borderRadius: 4,
                  padding: '6px 10px',
                  color: C.text,
                  fontSize: 11,
                  fontFamily: 'inherit',
                  width: 80,
                }}
              />
              <Btn onClick={() => doSend()} disabled={!sendGa || sending}>
                {sending ? <Spinner /> : '▷ Send'}
              </Btn>
            </>
          )}
        </div>
      )}

      {paused && (
        <div
          style={{
            padding: '4px 16px',
            background: '#150f00',
            borderBottom: `1px solid ${C.amber}22`,
            fontSize: 10,
            color: C.amber,
          }}
        >
          ⏸ Paused
          {newCount > 0
            ? ` — ${newCount} new telegram${newCount !== 1 ? 's' : ''} waiting`
            : ''}
        </div>
      )}

      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {monCols
                .filter((c) => c.visible !== false)
                .map((col) => (
                  <TH
                    key={col.id}
                    style={
                      col.id === 'timestamp'
                        ? { width: 155 }
                        : col.id === 'delta'
                          ? { width: 75 }
                          : col.id === 'src'
                            ? { width: 75 }
                            : col.id === 'dst'
                              ? { width: 75 }
                              : col.id === 'type'
                                ? { width: 170 }
                                : col.id === 'raw_value'
                                  ? { width: 80 }
                                  : col.id === 'decoded'
                                    ? { width: 100 }
                                    : col.id === 'dpt'
                                      ? { width: 65 }
                                      : col.id === 'priority'
                                        ? { width: 65 }
                                        : {}
                    }
                  >
                    {col.label.toUpperCase().replace('GAS', 'GAs')}
                  </TH>
                ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((tg, i) => {
              const ga = gaMap[tg.dst];
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
                  )}
                  {mcv('delta') && (
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
                  )}
                  {mcv('src') && (
                    <TD>
                      <PinAddr
                        address={tg.src}
                        wtype="device"
                        title={devMap[tg.src]?.name}
                        style={{ color: C.accent, fontFamily: 'monospace' }}
                      />
                    </TD>
                  )}
                  {mcv('location') && data?.spaces?.length > 0 && (
                    <TD>
                      <SpacePath
                        spaceId={devMap[tg.src]?.space_id}
                        spaces={data.spaces}
                        style={{ color: C.dim, fontSize: 10 }}
                      />
                    </TD>
                  )}
                  {mcv('dst') && (
                    <TD>
                      <PinAddr
                        address={tg.dst}
                        wtype="ga"
                        title={ga?.name}
                        style={{ color: C.purple, fontFamily: 'monospace' }}
                      />
                    </TD>
                  )}
                  {mcv('ga_name') && (
                    <TD>
                      <span style={{ color: C.muted, fontSize: 10 }}>
                        {ga?.name || ''}
                      </span>
                    </TD>
                  )}
                  {mcv('type') && (
                    <TD>
                      <span style={{ color: typeColor(tg.type), fontSize: 10 }}>
                        {tg.type}
                      </span>
                    </TD>
                  )}
                  {mcv('raw_value') && (
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
                  )}
                  {mcv('decoded') && (
                    <TD>
                      <span
                        style={{ color: C.text, fontWeight: ga ? 500 : 400 }}
                      >
                        {getDecoded(tg)}
                      </span>
                    </TD>
                  )}
                  {mcv('dpt') && (
                    <TD>
                      <span
                        style={{ color: C.dim, fontSize: 9 }}
                        title={dpt.hover(ga?.dpt)}
                      >
                        {dpt.display(ga?.dpt)}
                      </span>
                    </TD>
                  )}
                  {mcv('priority') && (
                    <TD>
                      <span style={{ color: C.dim, fontSize: 10 }}>
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
          C={C}
        />
      )}
    </div>
  );
}
