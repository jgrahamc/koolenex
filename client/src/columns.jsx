import { useState, useRef, useEffect } from 'react';
import { Btn } from './primitives.jsx';

export function useColumns(viewId, defaults) {
  const [cols, setCols] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(`knx-cols-${viewId}`) || 'null');
      if (!stored) return defaults;
      const storedMap = Object.fromEntries(stored.map(c => [c.id, c]));
      return defaults
        .map(dc => ({ ...dc, visible: storedMap[dc.id]?.visible ?? dc.visible }))
        .sort((a, b) => {
          const ai = stored.findIndex(s => s.id === a.id);
          const bi = stored.findIndex(s => s.id === b.id);
          if (ai === -1) return 1; if (bi === -1) return -1;
          return ai - bi;
        });
    } catch { return defaults; }
  });
  const save = (newCols) => {
    setCols(newCols);
    try { localStorage.setItem(`knx-cols-${viewId}`, JSON.stringify(newCols.map(c => ({ id: c.id, visible: c.visible })))); } catch {}
  };
  return [cols, save];
}

export function ColumnPicker({ cols, onChange, C }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const dragIdx = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Btn onClick={() => setOpen(o => !o)} color={open ? C.accent : C.muted} bg={C.surface} title="Configure columns">
        ⋮ Cols
      </Btn>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 200,
          background: C.sidebar, border: `1px solid ${C.border}`, borderRadius: 6,
          padding: '6px 4px', minWidth: 150, boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          maxHeight: 320, overflowY: 'auto' }}>
          {cols.map((col, i) => (
            <div key={col.id} draggable
              onDragStart={() => { dragIdx.current = i; }}
              onDragOver={e => e.preventDefault()}
              onDrop={() => {
                const from = dragIdx.current;
                if (from == null || from === i) return;
                const next = [...cols];
                next.splice(i, 0, next.splice(from, 1)[0]);
                onChange(next);
                dragIdx.current = null;
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
                cursor: 'grab', userSelect: 'none', fontSize: 11, color: C.text }}>
              <span style={{ color: C.dim, fontSize: 13 }}>⠿</span>
              <input type="checkbox" checked={col.visible !== false} style={{ cursor: 'pointer' }}
                onChange={e => onChange(cols.map((c, j) => j === i ? { ...c, visible: e.target.checked } : c))} />
              <span>{col.label}</span>
            </div>
          ))}
          <div style={{ borderTop: `1px solid ${C.border}`, margin: '4px 0' }} />
          <div onClick={() => onChange(cols.map(c => ({ ...c, visible: true })))}
            style={{ padding: '3px 8px', fontSize: 10, color: C.accent, cursor: 'pointer' }}>Show all</div>
        </div>
      )}
    </div>
  );
}

export function dlCSV(filename, cols, rows, getVal) {
  const visible = cols.filter(c => c.visible !== false);
  const lines = [
    visible.map(c => `"${c.label}"`).join(','),
    ...rows.map(r => visible.map(c => `"${String(getVal(c.id, r) ?? '').replace(/"/g, '""')}"`).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click(); URL.revokeObjectURL(a.href);
}
