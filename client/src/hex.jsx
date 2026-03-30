import { useState, useMemo } from 'react';

export function HexDump({ hex, annotations = [], title, C }) {
  const [hovered, setHovered] = useState(null); // byte index
  if (!hex || hex.length < 2) return <div style={{ fontSize: 10, color: C.dim, padding: '12px 0' }}>No data</div>;

  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));

  // Build annotation map: byteIdx → { label, color }
  const annoMap = {};
  for (const a of annotations) {
    for (let i = a.start; i < a.start + a.len && i < bytes.length; i++) {
      annoMap[i] = { label: a.label, color: a.color };
    }
  }

  const COLS = 16;
  const rows = Math.ceil(bytes.length / COLS);

  const makeTitle = (idx) => {
    const anno = annoMap[idx];
    return `0x${idx.toString(16).padStart(4, '0')} (${idx})${anno ? ' — ' + anno.label : ''}`;
  };

  return (
    <div>
      {title && <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.08em', marginBottom: 6 }}>{title}</div>}
      <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 10, lineHeight: '19px', overflowX: 'auto' }}>
        {Array.from({ length: rows }, (_, r) => {
          const start = r * COLS;
          const rowBytes = bytes.slice(start, start + COLS);
          return (
            <div key={r} style={{ display: 'flex', gap: 0, whiteSpace: 'nowrap' }}>
              <span style={{ color: C.dim, marginRight: 12, userSelect: 'none', flexShrink: 0 }}>
                {start.toString(16).padStart(4, '0')}
              </span>
              <span style={{ marginRight: 12, flexShrink: 0 }}>
                {rowBytes.map((b, ci) => {
                  const idx = start + ci;
                  const anno = annoMap[idx];
                  const isHov = hovered !== null && annoMap[hovered] && anno?.label === annoMap[hovered]?.label;
                  return (
                    <span key={ci}
                      title={makeTitle(idx)}
                      onMouseEnter={() => setHovered(idx)}
                      onMouseLeave={() => setHovered(null)}
                      style={{
                        color: anno ? anno.color : C.text,
                        background: isHov ? `${anno.color}22` : hovered === idx ? `${C.accent}22` : 'transparent',
                        padding: '1px 0',
                        borderRadius: 2,
                        cursor: 'default',
                      }}>
                      {b.toString(16).padStart(2, '0')}
                      {ci === 7 ? '  ' : ' '}
                    </span>
                  );
                })}
                {rowBytes.length < COLS && Array.from({ length: COLS - rowBytes.length }, (_, i) => {
                  const ci = rowBytes.length + i;
                  return <span key={`pad${ci}`} style={{ color: 'transparent', userSelect: 'none' }}>{'xx' + (ci === 7 ? '  ' : ' ')}</span>;
                })}
              </span>
              <span style={{ color: C.dim, flexShrink: 0 }}>
                {rowBytes.map((b, ci) => {
                  const idx = start + ci;
                  const anno = annoMap[idx];
                  const isHov = hovered !== null && annoMap[hovered] && anno?.label === annoMap[hovered]?.label;
                  const ch = (b >= 32 && b < 127) ? String.fromCharCode(b) : '·';
                  return (
                    <span key={ci}
                      title={makeTitle(idx)}
                      onMouseEnter={() => setHovered(idx)}
                      onMouseLeave={() => setHovered(null)}
                      style={{
                        color: anno ? anno.color : b >= 32 && b < 127 ? C.muted : C.dim,
                        background: isHov ? `${anno.color}22` : hovered === idx ? `${C.accent}22` : 'transparent',
                        cursor: 'default',
                      }}>{ch}</span>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>{bytes.length} bytes</div>
    </div>
  );
}

// Side-by-side hex dump comparison with differing bytes highlighted
export function HexDumpCompare({ hexA, hexB, labelA, labelB, C, colA, colB, annotations = [] }) {
  const [hovered, setHovered] = useState(null);

  const toBytes = (h) => {
    const b = [];
    for (let i = 0; i < (h || '').length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16));
    return b;
  };

  const bytesA = toBytes(hexA);
  const bytesB = toBytes(hexB);
  const len = Math.max(bytesA.length, bytesB.length);
  if (!len) return <div style={{ fontSize: 10, color: C.dim, padding: '12px 0' }}>No image data for either device</div>;

  // Build annotation map: byteIdx → { label, color }
  const annoMap = {};
  for (const a of annotations) {
    for (let i = a.start; i < a.start + a.len && i < len; i++) {
      annoMap[i] = { label: a.label, color: a.color };
    }
  }

  const COLS = 16;
  const rows = Math.ceil(len / COLS);
  const diffCount = Array.from({ length: len }, (_, i) => bytesA[i] !== bytesB[i]).filter(Boolean).length;

  const hovAnno = hovered !== null ? annoMap[hovered] : null;

  const renderCell = (bytes, idx, isA) => {
    const b = bytes[idx];
    const bOther = isA ? bytesB[idx] : bytesA[idx];
    const missing = b === undefined;
    const diff = b !== bOther;
    const anno = annoMap[idx];
    const isHov = hovAnno && anno?.label === hovAnno.label;
    const color = missing ? C.dim : diff ? C.amber : C.muted;
    const bg = isHov ? `${anno.color}22` : hovered === idx ? `${C.accent}22` : diff ? `${C.amber}11` : 'transparent';
    const hexStr = missing ? '--' : b.toString(16).padStart(2, '0');
    const titleStr = `0x${idx.toString(16).padStart(4, '0')} (${idx})${anno ? ' — ' + anno.label : ''}`;
    return (
      <span key={idx}
        title={titleStr}
        onMouseEnter={() => setHovered(idx)}
        onMouseLeave={() => setHovered(null)}
        style={{ color, background: bg, borderRadius: 2, cursor: 'default' }}
      >{hexStr} </span>
    );
  };

  const renderAscii = (bytes, start, count, isA) => {
    return Array.from({ length: count }, (_, ci) => {
      const idx = start + ci;
      const b = bytes[idx];
      const bOther = isA ? bytesB[idx] : bytesA[idx];
      const diff = b !== bOther;
      const anno = annoMap[idx];
      const isHov = hovAnno && anno?.label === hovAnno.label;
      const ch = (b !== undefined && b >= 32 && b < 127) ? String.fromCharCode(b) : (b === undefined ? ' ' : '·');
      return (
        <span key={ci}
          onMouseEnter={() => setHovered(idx)}
          onMouseLeave={() => setHovered(null)}
          style={{
            color: diff ? C.amber : b !== undefined && b >= 32 && b < 127 ? C.muted : C.dim,
            background: isHov ? `${anno.color}22` : hovered === idx ? `${C.accent}22` : 'transparent',
            cursor: 'default',
          }}
        >{ch}</span>
      );
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, fontSize: 10 }}>
        <span style={{ color: C.dim }}>{diffCount === 0 ? 'Identical' : `${diffCount} byte${diffCount > 1 ? 's' : ''} differ`}</span>
        {hovered !== null && <span style={{ color: C.muted, fontFamily: 'monospace' }}>
          offset 0x{hovered.toString(16).padStart(4, '0')}
          {hovAnno ? <span style={{ color: hovAnno.color }}> — {hovAnno.label}</span> : null}
        </span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {[{hex: hexA, bytes: bytesA, label: labelA, color: colA, isA: true}, {hex: hexB, bytes: bytesB, label: labelB, color: colB, isA: false}].map(({ bytes, label, color, isA }) => (
          <div key={label}>
            <div style={{ fontSize: 9, color, letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
            <div style={{ fontFamily: "'DM Mono',monospace", fontSize: 9.5, lineHeight: '18px', overflowX: 'auto' }}>
              {Array.from({ length: rows }, (_, r) => {
                const start = r * COLS;
                const count = Math.min(COLS, len - start);
                return (
                  <div key={r} style={{ display: 'flex', gap: 0, whiteSpace: 'nowrap' }}>
                    <span style={{ color: C.dim, marginRight: 10, userSelect: 'none', flexShrink: 0, fontSize: 9 }}>
                      {start.toString(16).padStart(4, '0')}
                    </span>
                    <span style={{ marginRight: 10, flexShrink: 0 }}>
                      {Array.from({ length: count }, (_, ci) => {
                        const idx = start + ci;
                        return <span key={ci}>{renderCell(bytes, idx, isA)}{ci === 7 ? ' ' : ''}</span>;
                      })}
                    </span>
                    <span style={{ flexShrink: 0 }}>{renderAscii(bytes, start, count, isA)}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>{bytes.length} bytes</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Build HexDump annotations for a GA table hex string
export function buildGATableAnnotations(hex, C) {
  if (!hex || hex.length < 2) return [];
  const count = parseInt(hex.slice(0, 2), 16);
  const annos = [{ start: 0, len: 1, label: `count = ${count}`, color: C.accent }];
  for (let i = 0; i < count; i++) {
    const off = 1 + i * 2;
    if (off * 2 + 4 > hex.length) break;
    const b0 = parseInt(hex.slice(off * 2, off * 2 + 2), 16);
    const b1 = parseInt(hex.slice(off * 2 + 2, off * 2 + 4), 16);
    const main = (b0 >> 3) & 0x1F, mid = b0 & 0x07, sub = b1;
    annos.push({ start: off, len: 2, label: `GA[${i}] = ${main}/${mid}/${sub}`, color: C.purple });
  }
  return annos;
}

// Build HexDump annotations for an association table hex string
export function buildAssocTableAnnotations(hex, C) {
  if (!hex || hex.length < 2) return [];
  const count = parseInt(hex.slice(0, 2), 16);
  const annos = [{ start: 0, len: 1, label: `count = ${count}`, color: C.accent }];
  for (let i = 0; i < count; i++) {
    const off = 1 + i * 2;
    if (off * 2 + 4 > hex.length) break;
    const co  = parseInt(hex.slice(off * 2, off * 2 + 2), 16);
    const ga  = parseInt(hex.slice(off * 2 + 2, off * 2 + 4), 16);
    annos.push({ start: off, len: 2, label: `CO ${co} → GA[${ga}]`, color: C.amber });
  }
  return annos;
}
