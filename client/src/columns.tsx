import { useState, useRef, useEffect } from 'react';
import { Btn } from './primitives.tsx';
import styles from './columns.module.css';

export interface Column {
  id: string;
  label: string;
  visible?: boolean;
}

export function useColumns(
  viewId: string,
  defaults: Column[],
): [Column[], (cols: Column[]) => void] {
  const [cols, setCols] = useState<Column[]>(() => {
    try {
      const stored: Column[] | null = JSON.parse(
        localStorage.getItem(`knx-cols-${viewId}`) || 'null',
      );
      if (!stored) return defaults;
      const storedMap = Object.fromEntries(stored.map((c) => [c.id, c]));
      return defaults
        .map((dc) => ({
          ...dc,
          visible: storedMap[dc.id]?.visible ?? dc.visible,
        }))
        .sort((a, b) => {
          const ai = stored.findIndex((s) => s.id === a.id);
          const bi = stored.findIndex((s) => s.id === b.id);
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        });
    } catch {
      return defaults;
    }
  });
  const save = (newCols: Column[]) => {
    setCols(newCols);
    try {
      localStorage.setItem(
        `knx-cols-${viewId}`,
        JSON.stringify(newCols.map((c) => ({ id: c.id, visible: c.visible }))),
      );
    } catch {}
  };
  return [cols, save];
}

interface ColumnPickerProps {
  cols: Column[];
  onChange: (cols: Column[]) => void;
  C: any;
}

export function ColumnPicker({ cols, onChange, C }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dragIdx = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className={styles.pickerWrap}>
      <Btn
        onClick={() => setOpen((o) => !o)}
        color={open ? C.accent : C.muted}
        bg={C.surface}
        title="Configure columns"
      >
        ⋮ Cols
      </Btn>
      {open && (
        <div className={styles.dropdown}>
          {cols.map((col, i) => (
            <div
              key={col.id}
              draggable
              onDragStart={() => {
                dragIdx.current = i;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const from = dragIdx.current;
                if (from == null || from === i) return;
                const next = [...cols];
                const removed = next.splice(from, 1)[0]!;
                next.splice(i, 0, removed);
                onChange(next);
                dragIdx.current = null;
              }}
              className={styles.colRow}
            >
              <span className={styles.dragHandle}>⠿</span>
              <input
                type="checkbox"
                checked={col.visible !== false}
                className={styles.colCheckbox}
                onChange={(e) =>
                  onChange(
                    cols.map((c, j) =>
                      j === i ? { ...c, visible: e.target.checked } : c,
                    ),
                  )
                }
              />
              <span>{col.label}</span>
            </div>
          ))}
          <div className={styles.divider} />
          <div
            onClick={() => onChange(cols.map((c) => ({ ...c, visible: true })))}
            className={styles.showAll}
          >
            Show all
          </div>
        </div>
      )}
    </div>
  );
}

export function dlCSV(
  filename: string,
  cols: Column[],
  rows: any[],
  getVal: (id: string, row: any) => any,
) {
  const visible = cols.filter((c) => c.visible !== false);
  const lines = [
    visible.map((c) => `"${c.label}"`).join(','),
    ...rows.map((r) =>
      visible
        .map((c) => `"${String(getVal(c.id, r) ?? '').replace(/"/g, '""')}"`)
        .join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
