import { useState, useEffect, useRef, useContext, useMemo } from 'react';
import { useC, ThemeColors } from './theme.ts';
import { PinContext } from './contexts.ts';
import { coGAs } from './primitives.tsx';
import { dptUnit, dptName } from './dpt.ts';

interface GASpeechBubbleProps {
  x: number;
  y: number;
  dptStr: string;
  rawDecoded: any;
  arriveMs: number;
}

// Speech bubble that appears above a GA node when a telegram dot arrives
export function GASpeechBubble({
  x,
  y,
  dptStr,
  rawDecoded,
  arriveMs,
}: GASpeechBubbleProps) {
  const C = useC();
  const ref = useRef<SVGGElement>(null);
  const GA_HALF_H = 12;
  const BW = 96,
    BH = 36;
  const BY = y - GA_HALF_H - 10 - BH;
  const tipY = y - GA_HALF_H - 2;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('opacity', '0');
    let raf1: number, raf2: number, tid2: ReturnType<typeof setTimeout>;
    const tid1 = setTimeout(() => {
      const s1 = performance.now(),
        d1 = 280;
      function fadeIn(now: number) {
        const t = Math.min((now - s1) / d1, 1);
        el!.setAttribute('opacity', String(t));
        if (t < 1) raf1 = requestAnimationFrame(fadeIn);
      }
      raf1 = requestAnimationFrame(fadeIn);
      tid2 = setTimeout(() => {
        const s2 = performance.now(),
          d2 = 700;
        function fadeOut(now: number) {
          const t = Math.min((now - s2) / d2, 1);
          el!.setAttribute('opacity', String(1 - t));
          if (t < 1) raf2 = requestAnimationFrame(fadeOut);
        }
        raf2 = requestAnimationFrame(fadeOut);
      }, 2200);
    }, arriveMs);
    return () => {
      clearTimeout(tid1);
      clearTimeout(tid2);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  const unit = dptUnit(dptStr || '');
  const isNumeric =
    rawDecoded != null && rawDecoded !== '' && !isNaN(rawDecoded);
  const value =
    rawDecoded != null && rawDecoded !== ''
      ? `${rawDecoded}${isNumeric ? unit : ''}`
      : '—';
  const label = dptName(dptStr || '') || dptStr || null;

  return (
    <g ref={ref} opacity={0} style={{ pointerEvents: 'none' }}>
      {/* Triangle fill (covers border of rect) */}
      <polygon
        points={`${x - 7},${BY + BH} ${x + 7},${BY + BH} ${x},${tipY}`}
        fill={C.bg}
      />
      {/* Bubble body */}
      <rect
        x={x - BW / 2}
        y={BY}
        width={BW}
        height={BH}
        rx={5}
        fill={C.bg}
        stroke={C.purple}
        strokeWidth={1.2}
      />
      {/* Triangle outline — only sides, not base (base hidden behind rect) */}
      <line
        x1={x - 7}
        y1={BY + BH}
        x2={x}
        y2={tipY}
        stroke={C.purple}
        strokeWidth={1.2}
      />
      <line
        x1={x + 7}
        y1={BY + BH}
        x2={x}
        y2={tipY}
        stroke={C.purple}
        strokeWidth={1.2}
      />
      {label && (
        <text x={x} y={BY + 13} textAnchor="middle" fontSize={8} fill={C.dim}>
          {label}
        </text>
      )}
      <text
        x={x}
        y={BY + (label ? 28 : 24)}
        textAnchor="middle"
        fontSize={label ? 12 : 13}
        fill={C.text}
        fontWeight="700"
        fontFamily="monospace"
      >
        {value}
      </text>
    </g>
  );
}

interface TelegramDotProps {
  pathD?: string;
  x0?: number;
  y0?: number;
  cx1?: number;
  cy1?: number;
  cx2?: number;
  cy2?: number;
  x1?: number;
  y1?: number;
  color: string;
  durMs: number;
  delayMs?: number;
}

// Animates a dot along an SVG path via RAF using getPointAtLength
export function TelegramDot({
  pathD,
  x0,
  y0,
  cx1,
  cy1,
  cx2,
  cy2,
  x1,
  y1,
  color,
  durMs,
  delayMs = 0,
}: TelegramDotProps) {
  const ref = useRef<SVGCircleElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  // Accept explicit pathD, or fall back to cubic bezier from legacy props
  const d = pathD || `M${x0},${y0} C${cx1},${cy1} ${cx2},${cy2} ${x1},${y1}`;
  useEffect(() => {
    let raf: number;
    if (ref.current) ref.current.setAttribute('opacity', '0');
    const tid = setTimeout(() => {
      const path = pathRef.current;
      if (!path) return;
      const totalLen = path.getTotalLength();
      const start = performance.now();
      function step(now: number) {
        const t = Math.min((now - start) / durMs, 1);
        const pt = path!.getPointAtLength(t * totalLen);
        const op = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        if (ref.current) {
          ref.current.setAttribute('cx', String(pt.x));
          ref.current.setAttribute('cy', String(pt.y));
          ref.current.setAttribute('opacity', String(op));
        }
        if (t < 1) raf = requestAnimationFrame(step);
      }
      raf = requestAnimationFrame(step);
    }, delayMs);
    return () => {
      clearTimeout(tid);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <>
      <path ref={pathRef} d={d} fill="none" stroke="none" />
      <circle
        ref={ref}
        r={3.5}
        fill={color}
        filter="url(#dk-glow)"
        opacity={0}
      />
    </>
  );
}

interface DeviceNetworkDiagramProps {
  dev: any;
  linkedGAs: any[];
  devCOs: any[];
  gaDeviceMap: Record<string, string[]>;
  allCOs: any[];
  devMap: Record<string, any>;
  C: ThemeColors;
  devTelegrams: any[];
}

export function DeviceNetworkDiagram({
  dev,
  linkedGAs,
  devCOs,
  gaDeviceMap,
  allCOs,
  devMap,
  C,
  devTelegrams,
}: DeviceNetworkDiagramProps) {
  const W = 540,
    TOP = 16,
    ROW = 40;
  const DEV_W = 110,
    DEV_H = 28;
  const GA_W = 104,
    GA_H = 24;
  const PEER_W = 110,
    PEER_H = 28;
  const DIM = 0.1;

  // Stagger GA nodes into two interleaved columns when there are many
  const stagger = linkedGAs.length > 10;
  const COL_DEV = stagger ? 14 : 80;
  const COL_GA = 250; // single-column center (non-stagger)
  const GA_COL_L = 204,
    GA_COL_R = 320; // two-column centers (stagger)
  const COL_PEER = stagger ? 516 : 440;
  // Funnel points: where curves end and straight lines begin (edges of GA column area)
  const FUNNEL_L = GA_COL_L - GA_W / 2; // left edge of left GA column
  const FUNNEL_R = GA_COL_R + GA_W / 2; // right edge of right GA column

  const pin = useContext(PinContext);
  const [sel, setSel] = useState<{ type: 'ga' | 'peer'; addr: string } | null>(
    null,
  ); // null | { type:'ga'|'peer', addr }

  const trunc = (s: string | undefined, n = 13) =>
    s && s.length > n ? s.slice(0, n) + '\u2026' : s || '';

  // Compute point + tangent angle on a cubic bezier at parameter t
  const bAt = (
    x0: number,
    y0: number,
    cx1: number,
    cy1: number,
    cx2: number,
    cy2: number,
    x1: number,
    y1: number,
    t: number,
  ) => {
    const m = 1 - t;
    const x =
      m ** 3 * x0 + 3 * m ** 2 * t * cx1 + 3 * m * t ** 2 * cx2 + t ** 3 * x1;
    const y =
      m ** 3 * y0 + 3 * m ** 2 * t * cy1 + 3 * m * t ** 2 * cy2 + t ** 3 * y1;
    const dx =
      3 * (m ** 2 * (cx1 - x0) + 2 * m * t * (cx2 - cx1) + t ** 2 * (x1 - cx2));
    const dy =
      3 * (m ** 2 * (cy1 - y0) + 2 * m * t * (cy2 - cy1) + t ** 2 * (y1 - cy2));
    return { x, y, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  };

  interface MidArrowProps {
    x0: number;
    y0: number;
    cx1: number;
    cy1: number;
    cx2: number;
    cy2: number;
    x1: number;
    y1: number;
    color: string;
    op: number;
  }

  // Render a filled arrowhead polygon at midpoint of a cubic bezier
  const MidArrow = ({
    x0,
    y0,
    cx1,
    cy1,
    cx2,
    cy2,
    x1,
    y1,
    color,
    op,
  }: MidArrowProps) => {
    const { x, y, angle } = bAt(x0, y0, cx1, cy1, cx2, cy2, x1, y1, 0.52);
    return (
      <polygon
        points="-5,-3 1,0 -5,3"
        fill={color}
        opacity={op}
        transform={`translate(${x},${y}) rotate(${angle})`}
      />
    );
  };

  // GA nodes
  const gaNodes = useMemo(
    () =>
      linkedGAs.map((ga, i) => {
        const co = devCOs.find((c: any) => coGAs(c).includes(ga.address));
        let x: number, y: number;
        if (stagger) {
          const isLeft = i % 2 === 0;
          const row = Math.floor(i / 2);
          x = isLeft ? GA_COL_L : GA_COL_R;
          y = TOP + row * ROW + ROW / 2 + (isLeft ? 0 : ROW / 2);
        } else {
          x = COL_GA;
          y = TOP + i * ROW + ROW / 2;
        }
        return {
          ga,
          x,
          y,
          transmit: co?.ga_send?.split(' ').includes(ga.address) ?? false,
          receive: co?.ga_receive?.split(' ').includes(ga.address) ?? false,
        };
      }),
    [linkedGAs, devCOs, stagger],
  );

  const svgGaH = stagger
    ? TOP * 2 + Math.ceil(linkedGAs.length / 2) * ROW + ROW / 2
    : TOP * 2 + Math.max(1, linkedGAs.length) * ROW;
  const devY = svgGaH / 2;

  const peerAddrs = useMemo(
    () => [
      ...new Set(
        linkedGAs.flatMap((ga: any) =>
          (gaDeviceMap[ga.address] || []).filter(
            (a: string) => a !== dev.individual_address,
          ),
        ),
      ),
    ],
    [linkedGAs, gaDeviceMap, dev.individual_address],
  );

  const peerNodes = useMemo(() => {
    const nodes = peerAddrs.map((addr) => {
      const connYs = gaNodes
        .filter((n) => (gaDeviceMap[n.ga.address] || []).includes(addr))
        .map((n) => n.y);
      const rawY = connYs.length
        ? connYs.reduce((a, b) => a + b, 0) / connYs.length
        : svgGaH / 2;
      return { addr, y: rawY };
    });
    nodes.sort((a, b) => a.y - b.y);
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i]!.y < nodes[i - 1]!.y + ROW)
        nodes[i]!.y = nodes[i - 1]!.y + ROW;
    }
    if (nodes.length > 0 && gaNodes.length > 0) {
      const gaCenter = (gaNodes[0]!.y + gaNodes[gaNodes.length - 1]!.y) / 2;
      const peerCenter = (nodes[0]!.y + nodes[nodes.length - 1]!.y) / 2;
      const shift = gaCenter - peerCenter;
      nodes.forEach((p) => {
        p.y += shift;
      });
    }
    // Clamp: ensure topmost peer never goes above the top margin
    if (nodes.length > 0 && nodes[0]!.y < PEER_H / 2 + TOP) {
      const adj = PEER_H / 2 + TOP - nodes[0]!.y;
      nodes.forEach((p) => {
        p.y += adj;
      });
    }
    return nodes;
  }, [peerAddrs, gaNodes, gaDeviceMap, svgGaH]);

  const finalH = Math.max(
    svgGaH,
    peerNodes.length
      ? peerNodes[peerNodes.length - 1]!.y + PEER_H / 2 + TOP
      : 0,
  );

  // ── Telegram flash animations ──────────────────────────────────────────────
  const [flashes, setFlashes] = useState<any[]>([]);
  const [litDevices, setLitDevices] = useState<Set<string>>(new Set());
  const [litGAs, setLitGAs] = useState<Set<string>>(new Set());
  // GAs currently animating — dims uninvolved elements. Map of GA addr → active count
  // (count tracks overlapping animations for the same GA so removal is balanced)
  const [flashHLGAs, setFlashHLGAs] = useState<Record<string, number>>({});
  const lastTgRef = useRef<any>(devTelegrams?.[0] ?? null); // init to current latest so mount doesn't replay

  const flashDevice = (addr: string, atMs: number) =>
    setTimeout(() => {
      setLitDevices((prev) => new Set([...prev, addr]));
      setTimeout(
        () =>
          setLitDevices((prev) => {
            const n = new Set(prev);
            n.delete(addr);
            return n;
          }),
        500,
      );
    }, atMs);
  const flashGA = (addr: string, atMs: number) =>
    setTimeout(() => {
      setLitGAs((prev) => new Set([...prev, addr]));
      setTimeout(
        () =>
          setLitGAs((prev) => {
            const n = new Set(prev);
            n.delete(addr);
            return n;
          }),
        500,
      );
    }, atMs);

  // Build path strings that match the visible edge routing (curve + straight for stagger)
  const devToGaPath = (
    devRight: number,
    gaLeft: number,
    gaY: number,
    isRightCol: boolean,
  ) => {
    const curveEnd = isRightCol ? FUNNEL_L : gaLeft;
    const mx = (devRight + curveEnd) / 2;
    const line = isRightCol ? ` L${gaLeft},${gaY}` : '';
    return `M${devRight},${devY} C${mx},${devY} ${mx},${gaY} ${curveEnd},${gaY}${line}`;
  };
  const gaToDevPath = (
    devRight: number,
    gaLeft: number,
    gaY: number,
    isRightCol: boolean,
  ) => {
    const curveEnd = isRightCol ? FUNNEL_L : gaLeft;
    const mx = (devRight + curveEnd) / 2;
    const line = isRightCol ? `M${gaLeft},${gaY} L${curveEnd},${gaY} ` : '';
    return `${line}M${curveEnd},${gaY} C${mx},${gaY} ${mx},${devY} ${devRight},${devY}`;
  };
  const gaToPeerPath = (
    gaRight: number,
    gaY: number,
    peerLeft: number,
    peerY: number,
    isLeftCol: boolean,
  ) => {
    const curveStart = isLeftCol ? FUNNEL_R : gaRight;
    const mx = (curveStart + peerLeft) / 2;
    const line = isLeftCol ? `M${gaRight},${gaY} L${FUNNEL_R},${gaY} ` : '';
    return `${line}M${curveStart},${gaY} C${mx},${gaY} ${mx},${peerY} ${peerLeft},${peerY}`;
  };
  const peerToGaPath = (
    gaRight: number,
    gaY: number,
    peerLeft: number,
    peerY: number,
    isLeftCol: boolean,
  ) => {
    const curveStart = isLeftCol ? FUNNEL_R : gaRight;
    const mx = (curveStart + peerLeft) / 2;
    const line = isLeftCol ? ` L${gaRight},${gaY}` : '';
    return `M${peerLeft},${peerY} C${mx},${peerY} ${mx},${gaY} ${curveStart},${gaY}${line}`;
  };

  useEffect(() => {
    const latest = devTelegrams?.[0];
    if (!latest || latest === lastTgRef.current) return;
    lastTgRef.current = latest;
    const gaAddr = latest.dst;
    if (!gaAddr?.includes('/')) return;
    const gNode = gaNodes.find((n) => n.ga.address === gaAddr);
    if (!gNode) return;

    const durMs = 1700;
    const devRight = COL_DEV + DEV_W / 2;
    const gaLeft = gNode.x - GA_W / 2;
    const gaRight = gNode.x + GA_W / 2;
    const peerLeft = COL_PEER - PEER_W / 2;
    const isRightCol = stagger && gNode.x > COL_GA;
    const isLeftCol = stagger && gNode.x < COL_GA;

    const segments: any[] = [];

    // Helper: line colour for dev↔GA edge
    const edgeColor = (tx: boolean, rx: boolean) =>
      tx && rx ? C.green : tx ? C.accent : rx ? C.amber : C.dim;

    const devTids: ReturnType<typeof setTimeout>[] = [];

    let bubbleArriveMs = durMs; // default: dot reaches GA after durMs

    if (latest.src === dev.individual_address) {
      // Outgoing: dev → GA, then GA → each peer that receives on this GA
      const devGaColor = edgeColor(gNode.transmit, gNode.receive);
      segments.push({
        pathD: devToGaPath(devRight, gaLeft, gNode.y, isRightCol),
        color: devGaColor,
        delayMs: 0,
      });
      devTids.push(flashDevice(dev.individual_address, 0));
      devTids.push(flashGA(gaAddr, durMs));
      for (const pNode of peerNodes) {
        if (!(gaDeviceMap[gaAddr] || []).includes(pNode.addr)) continue;
        const pco = allCOs.find(
          (c: any) =>
            c.device_address === pNode.addr && coGAs(c).includes(gaAddr),
        );
        if (!pco?.ga_receive?.split(' ').includes(gaAddr)) continue;
        const pSend = pco.ga_send?.split(' ').includes(gaAddr);
        segments.push({
          pathD: gaToPeerPath(gaRight, gNode.y, peerLeft, pNode.y, isLeftCol),
          color: edgeColor(pSend, true),
          delayMs: durMs,
        });
        devTids.push(flashDevice(pNode.addr, durMs * 2));
      }
      bubbleArriveMs = durMs;
    } else {
      // Incoming: src peer → GA (if src visible), then GA → dev
      const srcNode = peerNodes.find((p) => p.addr === latest.src);
      const devGaColor = edgeColor(gNode.transmit, gNode.receive);
      if (srcNode) {
        const pco = allCOs.find(
          (c: any) =>
            c.device_address === srcNode.addr && coGAs(c).includes(gaAddr),
        );
        const pRecv = pco?.ga_receive?.split(' ').includes(gaAddr);
        segments.push({
          pathD: peerToGaPath(gaRight, gNode.y, peerLeft, srcNode.y, isLeftCol),
          color: edgeColor(true, pRecv),
          delayMs: 0,
        });
        segments.push({
          pathD: gaToDevPath(devRight, gaLeft, gNode.y, isRightCol),
          color: devGaColor,
          delayMs: durMs,
        });
        devTids.push(flashDevice(srcNode.addr, 0));
        devTids.push(flashGA(gaAddr, durMs));
        devTids.push(flashDevice(dev.individual_address, durMs * 2));
        bubbleArriveMs = durMs;
      } else {
        segments.push({
          pathD: gaToDevPath(devRight, gaLeft, gNode.y, isRightCol),
          color: devGaColor,
          delayMs: 0,
        });
        devTids.push(flashGA(gaAddr, 0));
        devTids.push(flashDevice(dev.individual_address, durMs));
        bubbleArriveMs = 50; // dot departs from GA immediately; show bubble right away
      }
    }

    // Dim uninvolved elements during animation (ref-counted so overlapping telegrams work)
    setFlashHLGAs((prev) => ({ ...prev, [gaAddr]: (prev[gaAddr] || 0) + 1 }));
    setTimeout(
      () =>
        setFlashHLGAs((prev) => {
          const n = { ...prev };
          n[gaAddr] = (n[gaAddr] || 1) - 1;
          if (n[gaAddr] <= 0) delete n[gaAddr];
          return n;
        }),
      durMs * 2 + 400,
    );

    const bubble = {
      x: gNode.x,
      y: gNode.y,
      dptStr: gNode.ga.dpt,
      rawDecoded: latest.decoded,
      arriveMs: bubbleArriveMs,
    };
    const key = `${gaAddr}-${Date.now()}`;
    setFlashes((prev) => [...prev.slice(-8), { key, segments, bubble }]);
    const cleanupMs = durMs * 2 + 500;
    const tid = setTimeout(
      () => setFlashes((prev) => prev.filter((f) => f.key !== key)),
      cleanupMs,
    );
    // Don't clear hlTid on cleanup — the decrement must always fire to balance the increment
    return () => {
      clearTimeout(tid);
      devTids.forEach(clearTimeout);
    };
  }, [devTelegrams]);

  if (linkedGAs.length === 0) return null;

  // ── selection helpers ──
  const toggle = (type: 'ga' | 'peer', addr: string) =>
    setSel((s) =>
      s?.type === type && s?.addr === addr ? null : { type, addr },
    );

  // Compute which GA addresses and peer addresses are "active" in current selection or flash
  let activeGAs: Set<string> | null, activePeers: Set<string> | null;
  const flashGAList = Object.keys(flashHLGAs);
  if (flashGAList.length > 0 && !sel) {
    // During telegram animation, highlight involved GAs and all peers connected to them
    activeGAs = new Set(flashGAList);
    activePeers = new Set(
      flashGAList.flatMap((ga) =>
        (gaDeviceMap[ga] || []).filter(
          (a: string) => a !== dev.individual_address,
        ),
      ),
    );
  } else if (!sel) {
    activeGAs = null;
    activePeers = null; // all active
  } else if (sel.type === 'ga') {
    activeGAs = new Set([sel.addr]);
    activePeers = new Set(
      (gaDeviceMap[sel.addr] || []).filter(
        (a: string) => a !== dev.individual_address,
      ),
    );
  } else {
    // peer
    activePeers = new Set([sel.addr]);
    activeGAs = new Set(
      gaNodes
        .filter((n) => (gaDeviceMap[n.ga.address] || []).includes(sel.addr))
        .map((n) => n.ga.address),
    );
  }

  const gaOp = (addr: string) => (!activeGAs || activeGAs.has(addr) ? 1 : DIM);
  const prOp = (addr: string) =>
    !activePeers || activePeers.has(addr) ? 1 : DIM;
  // An edge between dev and GA is active if the GA is active
  const devGaEdgeOp = (addr: string) => gaOp(addr);
  // An edge between GA and peer is active if BOTH are active
  const gaPeerEdgeOp = (gaAddr: string, peerAddr: string) =>
    (!activeGAs || activeGAs.has(gaAddr)) &&
    (!activePeers || activePeers.has(peerAddr))
      ? 1
      : DIM;

  const TRANS = 'opacity 0.15s ease';

  return (
    <div
      style={{
        marginBottom: 20,
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: '10px 10px 6px 10px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: '0.08em',
          marginBottom: 6,
        }}
      >
        CONNECTION DIAGRAM
        {sel && (
          <span
            onClick={() => setSel(null)}
            style={{
              marginLeft: 10,
              color: C.accent,
              cursor: 'pointer',
              fontWeight: 400,
            }}
          >
            × clear
          </span>
        )}
      </div>
      <svg
        width="100%"
        height={finalH}
        viewBox={`0 0 ${W} ${finalH}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Device node — always fully visible */}
        {(() => {
          const lit = litDevices.has(dev.individual_address);
          return (
            <g style={{ transition: 'opacity 0.15s' }}>
              <title>
                {dev.individual_address}
                {dev.name ? ` — ${dev.name}` : ''}
              </title>
              <rect
                x={COL_DEV - DEV_W / 2}
                y={devY - DEV_H / 2}
                width={DEV_W}
                height={DEV_H}
                rx={4}
                fill={lit ? `${C.accent}40` : `${C.accent}18`}
                stroke={C.accent}
                strokeWidth={lit ? 2.5 : 1.5}
                style={{ transition: 'fill 0.15s, stroke-width 0.15s' }}
              />
              <text
                x={COL_DEV}
                y={devY - 4}
                textAnchor="middle"
                fontSize={9}
                fill={C.accent}
                fontFamily="monospace"
                onClick={
                  pin
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        (pin as any)('device', dev.individual_address);
                      }
                    : undefined
                }
                style={{ cursor: pin ? 'pointer' : 'default' }}
              >
                {dev.individual_address}
              </text>
              <text
                x={COL_DEV}
                y={devY + 8}
                textAnchor="middle"
                fontSize={8}
                fill={C.muted}
              >
                {trunc(dev.name)}
              </text>
            </g>
          );
        })()}

        {/* GA nodes + device↔GA edges */}
        {gaNodes.map(({ ga, x, y, transmit, receive }) => {
          const devRight = COL_DEV + DEV_W / 2;
          const gaLeft = x - GA_W / 2;
          // In stagger mode, right-column GAs get curve→straight routing:
          // bezier curves to the funnel (left edge of left GA column), then straight line to GA
          const isRightCol = stagger && x > COL_GA;
          const curveEnd = isRightCol ? FUNNEL_L : gaLeft;
          const mx = (devRight + curveEnd) / 2;
          // Path: curve to curveEnd, then optional straight to gaLeft
          const lineToGA = isRightCol ? ` L${gaLeft},${y}` : '';
          // For receive direction: straight from GA to curveEnd, then curve to device
          const lineFromGA = isRightCol
            ? `M${gaLeft},${y} L${curveEnd},${y}`
            : '';
          const eOp = devGaEdgeOp(ga.address);
          const nOp = gaOp(ga.address);
          const isSelected = sel?.type === 'ga' && sel.addr === ga.address;
          return (
            <g key={ga.address} style={{ transition: TRANS }}>
              {transmit && receive ? (
                <>
                  <path
                    d={`M${devRight},${devY} C${mx},${devY} ${mx},${y} ${curveEnd},${y}${lineToGA}`}
                    fill="none"
                    stroke={C.green}
                    strokeWidth={1.2}
                    opacity={eOp * 0.85}
                    style={{ transition: TRANS }}
                  />
                </>
              ) : transmit ? (
                <>
                  <path
                    d={`M${devRight},${devY} C${mx},${devY} ${mx},${y} ${curveEnd},${y}${lineToGA}`}
                    fill="none"
                    stroke={C.accent}
                    strokeWidth={1.2}
                    opacity={eOp * 0.85}
                    style={{ transition: TRANS }}
                  />
                  <MidArrow
                    x0={devRight}
                    y0={devY}
                    cx1={mx}
                    cy1={devY}
                    cx2={mx}
                    cy2={y}
                    x1={curveEnd}
                    y1={y}
                    color={C.accent}
                    op={eOp * 0.85}
                  />
                </>
              ) : receive ? (
                <>
                  <path
                    d={`${lineFromGA} M${curveEnd},${y} C${mx},${y} ${mx},${devY} ${devRight},${devY}`}
                    fill="none"
                    stroke={C.amber}
                    strokeWidth={1.2}
                    opacity={eOp * 0.85}
                    style={{ transition: TRANS }}
                  />
                  <MidArrow
                    x0={curveEnd}
                    y0={y}
                    cx1={mx}
                    cy1={y}
                    cx2={mx}
                    cy2={devY}
                    x1={devRight}
                    y1={devY}
                    color={C.amber}
                    op={eOp * 0.85}
                  />
                </>
              ) : (
                <>
                  <path
                    d={`M${devRight},${devY} C${mx},${devY} ${mx},${y} ${curveEnd},${y}${lineToGA}`}
                    fill="none"
                    stroke={C.dim}
                    strokeWidth={1}
                    strokeDasharray="4,3"
                    opacity={eOp * 0.35}
                    style={{ transition: TRANS }}
                  />
                </>
              )}
              <g
                onClick={() => toggle('ga', ga.address)}
                style={{ cursor: 'pointer', transition: TRANS, opacity: nOp }}
              >
                <title>
                  {ga.address}
                  {ga.name ? ` — ${ga.name}` : ''}
                </title>
                {(() => {
                  const lit = litGAs.has(ga.address);
                  return (
                    <rect
                      x={x - GA_W / 2}
                      y={y - GA_H / 2}
                      width={GA_W}
                      height={GA_H}
                      rx={3}
                      fill={
                        lit
                          ? `${C.purple}45`
                          : isSelected
                            ? `${C.purple}38`
                            : `${C.purple}18`
                      }
                      stroke={C.purple}
                      strokeWidth={lit ? 2.5 : isSelected ? 1.8 : 1}
                      style={{ transition: 'fill 0.15s, stroke-width 0.15s' }}
                    />
                  );
                })()}
                <text
                  x={x}
                  y={y - 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill={C.purple}
                  fontFamily="monospace"
                  style={{
                    textDecoration: pin ? 'underline' : 'none',
                    cursor: pin ? 'pointer' : 'default',
                  }}
                  onClick={
                    pin
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          (pin as any)('ga', ga.address);
                        }
                      : undefined
                  }
                  {...(pin ? { title: `Pin ${ga.address}` } : {})}
                >
                  {ga.address}
                </text>
                <text
                  x={x}
                  y={y + 8}
                  textAnchor="middle"
                  fontSize={7.5}
                  fill={C.muted}
                >
                  {trunc(ga.name, 12)}
                </text>
              </g>
            </g>
          );
        })}

        {/* Peer nodes + GA↔peer edges */}
        {peerNodes.map(({ addr, y: py }) => {
          const peer = devMap[addr];
          const connGaNodes = gaNodes.filter((n) =>
            (gaDeviceMap[n.ga.address] || []).includes(addr),
          );
          const peerLeft = COL_PEER - PEER_W / 2;
          const nOp = prOp(addr);
          const isSelected = sel?.type === 'peer' && sel.addr === addr;
          return (
            <g key={addr}>
              {connGaNodes.map((gn) => {
                const pco = (allCOs || []).find(
                  (co: any) =>
                    co.device_address === addr &&
                    coGAs(co).includes(gn.ga.address),
                );
                const pTx =
                  pco?.ga_send?.split(' ').includes(gn.ga.address) ?? false;
                const pRx =
                  pco?.ga_receive?.split(' ').includes(gn.ga.address) ?? false;
                const eOp = gaPeerEdgeOp(gn.ga.address, addr);
                const gaRight = gn.x + GA_W / 2;
                // In stagger mode, left-column GAs get straight→curve routing:
                // straight line from GA right edge to funnel (right edge of right GA column), then bezier to peer
                const isLeftCol = stagger && gn.x < COL_GA;
                const curveStart = isLeftCol ? FUNNEL_R : gaRight;
                const mx = (curveStart + peerLeft) / 2;
                const lineFromGA = isLeftCol
                  ? `M${gaRight},${gn.y} L${FUNNEL_R},${gn.y} `
                  : '';
                const lineToGA = isLeftCol ? ` L${gaRight},${gn.y}` : '';
                return (
                  <g key={gn.ga.address} style={{ transition: TRANS }}>
                    {pTx && pRx ? (
                      <>
                        <path
                          d={`${lineFromGA}M${curveStart},${gn.y} C${mx},${gn.y} ${mx},${py} ${peerLeft},${py}`}
                          fill="none"
                          stroke={C.green}
                          strokeWidth={1.2}
                          opacity={eOp * 0.85}
                        />
                      </>
                    ) : pTx ? (
                      <>
                        <path
                          d={`M${peerLeft},${py} C${mx},${py} ${mx},${gn.y} ${curveStart},${gn.y}${lineToGA}`}
                          fill="none"
                          stroke={C.accent}
                          strokeWidth={1.2}
                          opacity={eOp * 0.85}
                        />
                        <MidArrow
                          x0={peerLeft}
                          y0={py}
                          cx1={mx}
                          cy1={py}
                          cx2={mx}
                          cy2={gn.y}
                          x1={curveStart}
                          y1={gn.y}
                          color={C.accent}
                          op={eOp * 0.85}
                        />
                      </>
                    ) : pRx ? (
                      <>
                        <path
                          d={`${lineFromGA}M${curveStart},${gn.y} C${mx},${gn.y} ${mx},${py} ${peerLeft},${py}`}
                          fill="none"
                          stroke={C.amber}
                          strokeWidth={1.2}
                          opacity={eOp * 0.85}
                        />
                        <MidArrow
                          x0={curveStart}
                          y0={gn.y}
                          cx1={mx}
                          cy1={gn.y}
                          cx2={mx}
                          cy2={py}
                          x1={peerLeft}
                          y1={py}
                          color={C.amber}
                          op={eOp * 0.85}
                        />
                      </>
                    ) : (
                      <>
                        <path
                          d={`${lineFromGA}M${curveStart},${gn.y} C${mx},${gn.y} ${mx},${py} ${peerLeft},${py}`}
                          fill="none"
                          stroke={C.dim}
                          strokeWidth={1}
                          strokeDasharray="4,3"
                          opacity={eOp * 0.35}
                        />
                      </>
                    )}
                  </g>
                );
              })}
              <g
                onClick={() => toggle('peer', addr)}
                style={{ cursor: 'pointer', transition: TRANS, opacity: nOp }}
              >
                <title>
                  {addr}
                  {peer?.name ? ` — ${peer.name}` : ''}
                </title>
                {(() => {
                  const lit = litDevices.has(addr);
                  return (
                    <rect
                      x={COL_PEER - PEER_W / 2}
                      y={py - PEER_H / 2}
                      width={PEER_W}
                      height={PEER_H}
                      rx={4}
                      fill={
                        lit
                          ? `${C.muted}30`
                          : isSelected
                            ? `${C.text}18`
                            : `${C.border}50`
                      }
                      stroke={lit ? C.muted : isSelected ? C.muted : C.dim}
                      strokeWidth={lit ? 2.5 : isSelected ? 1.5 : 1}
                      style={{ transition: 'fill 0.15s, stroke-width 0.15s' }}
                    />
                  );
                })()}
                <text
                  x={COL_PEER}
                  y={py - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={C.muted}
                  fontFamily="monospace"
                  style={{
                    textDecoration: pin ? 'underline' : 'none',
                    cursor: pin ? 'pointer' : 'default',
                  }}
                  onClick={
                    pin
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          (pin as any)('device', addr);
                        }
                      : undefined
                  }
                  {...(pin ? { title: `Pin ${addr}` } : {})}
                >
                  {addr}
                </text>
                <text
                  x={COL_PEER}
                  y={py + 8}
                  textAnchor="middle"
                  fontSize={8}
                  fill={C.dim}
                >
                  {trunc(peer?.name)}
                </text>
              </g>
            </g>
          );
        })}

        {/* Live telegram pulse dots + speech bubbles */}
        {flashes.flatMap(({ key, segments, bubble }: any) => [
          ...segments.map((seg: any, i: number) => (
            <TelegramDot key={`${key}-${i}`} durMs={1700} {...seg} />
          )),
          bubble && <GASpeechBubble key={`${key}-bubble`} {...bubble} />,
        ])}

        <defs>
          <filter id="dk-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <div
        style={{
          display: 'flex',
          gap: 14,
          marginTop: 4,
          fontSize: 9,
          color: C.dim,
        }}
      >
        <span>
          <span style={{ color: C.accent }}>──▶</span> transmit
        </span>
        <span>
          <span style={{ color: C.amber }}>──▶</span> receive
        </span>
        <span>
          <span style={{ color: C.green }}>───</span> both
        </span>
        <span>
          <span style={{ color: C.dim, opacity: 0.6 }}>- - -</span> direction
          unknown
        </span>
      </div>
    </div>
  );
}

interface GANetworkDiagramProps {
  ga: any;
  linkedDevices: any[];
  allCOs: any[];
  C: ThemeColors;
  gaTelegrams: any[];
}

export function GANetworkDiagram({
  ga,
  linkedDevices,
  allCOs,
  C,
  gaTelegrams,
}: GANetworkDiagramProps) {
  const W = 460,
    TOP = 24,
    ROW = 40;
  const COL_GA = 110,
    COL_DEV = 360;
  const GA_W = 104,
    GA_H = 24;
  const DEV_W = 110,
    DEV_H = 28;
  const DIM = 0.1;

  const pin = useContext(PinContext);
  const [sel, setSel] = useState<string | null>(null);

  const trunc = (s: string | undefined, n = 13) =>
    s && s.length > n ? s.slice(0, n) + '\u2026' : s || '';

  const bAt = (
    x0: number,
    y0: number,
    cx1: number,
    cy1: number,
    cx2: number,
    cy2: number,
    x1: number,
    y1: number,
    t: number,
  ) => {
    const m = 1 - t;
    const x =
      m ** 3 * x0 + 3 * m ** 2 * t * cx1 + 3 * m * t ** 2 * cx2 + t ** 3 * x1;
    const y =
      m ** 3 * y0 + 3 * m ** 2 * t * cy1 + 3 * m * t ** 2 * cy2 + t ** 3 * y1;
    const dx =
      3 * (m ** 2 * (cx1 - x0) + 2 * m * t * (cx2 - cx1) + t ** 2 * (x1 - cx2));
    const dy =
      3 * (m ** 2 * (cy1 - y0) + 2 * m * t * (cy2 - cy1) + t ** 2 * (y1 - cy2));
    return { x, y, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  };

  interface MidArrowProps {
    x0: number;
    y0: number;
    cx1: number;
    cy1: number;
    cx2: number;
    cy2: number;
    x1: number;
    y1: number;
    color: string;
    op: number;
  }

  const MidArrow = ({
    x0,
    y0,
    cx1,
    cy1,
    cx2,
    cy2,
    x1,
    y1,
    color,
    op,
  }: MidArrowProps) => {
    const { x, y, angle } = bAt(x0, y0, cx1, cy1, cx2, cy2, x1, y1, 0.52);
    return (
      <polygon
        points="-5,-3 1,0 -5,3"
        fill={color}
        opacity={op}
        transform={`translate(${x},${y}) rotate(${angle})`}
      />
    );
  };

  const devNodes = useMemo(
    () =>
      linkedDevices.map((dev, i) => {
        const co = (allCOs || []).find(
          (c: any) =>
            c.device_address === dev.individual_address &&
            coGAs(c).includes(ga.address),
        );
        return {
          dev,
          x: COL_DEV,
          y: TOP + i * ROW + ROW / 2,
          transmit: co?.ga_send?.split(' ').includes(ga.address) ?? false,
          receive: co?.ga_receive?.split(' ').includes(ga.address) ?? false,
        };
      }),
    [linkedDevices, allCOs, ga.address],
  );

  const svgH = TOP * 2 + Math.max(1, linkedDevices.length) * ROW;
  const gaY = svgH / 2;

  // ── Flash animations ──────────────────────────────────────────────────────
  const [flashes, setFlashes] = useState<any[]>([]);
  const [litDevices, setLitDevices] = useState<Set<string>>(new Set());
  const [litGA, setLitGA] = useState(false);
  const lastTgRef = useRef<any>(gaTelegrams?.[0] ?? null); // init to current latest so mount doesn't replay

  useEffect(() => {
    const latest = gaTelegrams?.[0];
    if (!latest || latest === lastTgRef.current) return;
    lastTgRef.current = latest;

    const gaRight = COL_GA + GA_W / 2;
    const _gaLeft = COL_GA - GA_W / 2;
    const devLeft = COL_DEV - DEV_W / 2;
    const mx = (gaRight + devLeft) / 2;
    const durMs = 1700;

    const srcNode = devNodes.find(
      (n) => n.dev.individual_address === latest.src,
    );
    if (!srcNode) return;

    const tids: ReturnType<typeof setTimeout>[] = [];
    const flashDev = (addr: string, atMs: number) =>
      tids.push(
        setTimeout(() => {
          setLitDevices((prev) => new Set([...prev, addr]));
          setTimeout(
            () =>
              setLitDevices((prev) => {
                const n = new Set(prev);
                n.delete(addr);
                return n;
              }),
            500,
          );
        }, atMs),
      );
    const flashGANode = (atMs: number) =>
      tids.push(
        setTimeout(() => {
          setLitGA(true);
          setTimeout(() => setLitGA(false), 500);
        }, atMs),
      );

    // device → GA pulse
    const seg = {
      x0: devLeft,
      y0: srcNode.y,
      cx1: mx,
      cy1: srcNode.y,
      cx2: mx,
      cy2: gaY,
      x1: gaRight,
      y1: gaY,
      color: C.accent,
      delayMs: 0,
    };
    flashDev(srcNode.dev.individual_address, 0);
    flashGANode(durMs);

    const bubble = {
      x: COL_GA,
      y: gaY,
      dptStr: ga.dpt,
      rawDecoded: latest.decoded,
      arriveMs: durMs,
    };
    const key = `${ga.address}-${Date.now()}`;
    setFlashes((prev) => [...prev.slice(-8), { key, seg, bubble }]);
    const tid = setTimeout(
      () => setFlashes((prev) => prev.filter((f) => f.key !== key)),
      durMs + 500 + 3000,
    );
    tids.push(tid);
    return () => tids.forEach(clearTimeout);
  }, [gaTelegrams]);

  if (linkedDevices.length === 0) return null;

  const toggle = (addr: string) => setSel((s) => (s === addr ? null : addr));
  const devOp = (addr: string) => (!sel || sel === addr ? 1 : DIM);
  const TRANS = 'opacity 0.15s ease';

  return (
    <div
      style={{
        marginBottom: 20,
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: '10px 10px 6px 10px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: '0.08em',
          marginBottom: 6,
        }}
      >
        CONNECTION DIAGRAM
        {sel && (
          <span
            onClick={() => setSel(null)}
            style={{ marginLeft: 10, color: C.accent, cursor: 'pointer' }}
          >
            × clear
          </span>
        )}
      </div>
      <svg
        width="100%"
        height={svgH}
        viewBox={`0 0 ${W} ${svgH}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* GA node (centered) */}
        {(() => {
          const lit = litGA;
          return (
            <g>
              <rect
                x={COL_GA - GA_W / 2}
                y={gaY - GA_H / 2}
                width={GA_W}
                height={GA_H}
                rx={3}
                fill={lit ? `${C.purple}45` : `${C.purple}18`}
                stroke={C.purple}
                strokeWidth={lit ? 2.5 : 1}
                style={{ transition: 'fill 0.15s, stroke-width 0.15s' }}
              />
              <text
                x={COL_GA}
                y={gaY - 3}
                textAnchor="middle"
                fontSize={9}
                fill={C.purple}
                fontFamily="monospace"
              >
                {ga.address}
              </text>
              <text
                x={COL_GA}
                y={gaY + 8}
                textAnchor="middle"
                fontSize={7.5}
                fill={C.muted}
              >
                {trunc(ga.name, 12)}
              </text>
            </g>
          );
        })()}

        {/* Device nodes + edges */}
        {devNodes.map(({ dev, x, y, transmit, receive }) => {
          const gaRight = COL_GA + GA_W / 2;
          const devLeft = COL_DEV - DEV_W / 2;
          const mx = (gaRight + devLeft) / 2;
          const op = devOp(dev.individual_address);
          const isSelected = sel === dev.individual_address;
          return (
            <g key={dev.individual_address} style={{ transition: TRANS }}>
              {/* Edge */}
              {transmit && receive ? (
                <path
                  d={`M${gaRight},${gaY} C${mx},${gaY} ${mx},${y} ${devLeft},${y}`}
                  fill="none"
                  stroke={C.green}
                  strokeWidth={1.2}
                  opacity={op * 0.85}
                  style={{ transition: TRANS }}
                />
              ) : transmit ? (
                <>
                  <path
                    d={`M${devLeft},${y} C${mx},${y} ${mx},${gaY} ${gaRight},${gaY}`}
                    fill="none"
                    stroke={C.accent}
                    strokeWidth={1.2}
                    opacity={op * 0.85}
                    style={{ transition: TRANS }}
                  />
                  <MidArrow
                    x0={devLeft}
                    y0={y}
                    cx1={mx}
                    cy1={y}
                    cx2={mx}
                    cy2={gaY}
                    x1={gaRight}
                    y1={gaY}
                    color={C.accent}
                    op={op * 0.85}
                  />
                </>
              ) : receive ? (
                <>
                  <path
                    d={`M${gaRight},${gaY} C${mx},${gaY} ${mx},${y} ${devLeft},${y}`}
                    fill="none"
                    stroke={C.amber}
                    strokeWidth={1.2}
                    opacity={op * 0.85}
                    style={{ transition: TRANS }}
                  />
                  <MidArrow
                    x0={gaRight}
                    y0={gaY}
                    cx1={mx}
                    cy1={gaY}
                    cx2={mx}
                    cy2={y}
                    x1={devLeft}
                    y1={y}
                    color={C.amber}
                    op={op * 0.85}
                  />
                </>
              ) : (
                <path
                  d={`M${gaRight},${gaY} C${mx},${gaY} ${mx},${y} ${devLeft},${y}`}
                  fill="none"
                  stroke={C.dim}
                  strokeWidth={1}
                  strokeDasharray="4,3"
                  opacity={op * 0.35}
                  style={{ transition: TRANS }}
                />
              )}
              {/* Device node */}
              <g
                onClick={() => toggle(dev.individual_address)}
                style={{ cursor: 'pointer', transition: TRANS, opacity: op }}
              >
                <title>
                  {dev.individual_address}
                  {dev.name ? ` — ${dev.name}` : ''}
                </title>
                {(() => {
                  const lit = litDevices.has(dev.individual_address);
                  return (
                    <rect
                      x={x - DEV_W / 2}
                      y={y - DEV_H / 2}
                      width={DEV_W}
                      height={DEV_H}
                      rx={4}
                      fill={
                        lit
                          ? `${C.accent}40`
                          : isSelected
                            ? `${C.accent}30`
                            : `${C.accent}18`
                      }
                      stroke={C.accent}
                      strokeWidth={lit ? 2.5 : isSelected ? 1.8 : 1.5}
                      style={{ transition: 'fill 0.15s, stroke-width 0.15s' }}
                    />
                  );
                })()}
                <text
                  x={x}
                  y={y - 4}
                  textAnchor="middle"
                  fontSize={9}
                  fill={C.accent}
                  fontFamily="monospace"
                  style={{
                    textDecoration: pin ? 'underline' : 'none',
                    cursor: pin ? 'pointer' : 'default',
                  }}
                  onClick={
                    pin
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          (pin as any)('device', dev.individual_address);
                        }
                      : undefined
                  }
                >
                  {dev.individual_address}
                </text>
                <text
                  x={x}
                  y={y + 8}
                  textAnchor="middle"
                  fontSize={8}
                  fill={C.muted}
                >
                  {trunc(dev.name)}
                </text>
              </g>
            </g>
          );
        })}

        {/* Live telegram pulses */}
        {flashes.flatMap(({ key, seg, bubble }: any) => [
          <TelegramDot key={`${key}-dot`} durMs={1700} {...seg} />,
          bubble && <GASpeechBubble key={`${key}-bubble`} {...bubble} />,
        ])}

        <defs>
          <filter id="dk-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
    </div>
  );
}
