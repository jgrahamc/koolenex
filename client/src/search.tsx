import { useState, useEffect, useRef, useMemo } from 'react';

interface SearchResult {
  type: 'device' | 'ga' | 'space';
  wtype: string;
  address: string;
  primary: string;
  secondary: string;
  tertiary: string;
  score: number;
}

interface GlobalSearchProps {
  projectData: any;
  onPin: (wtype: string, address: string) => void;
  C: any;
}

export function GlobalSearch({ projectData, onPin, C }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hilite, setHilite] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Cmd+K / Ctrl+K to focus; Escape to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setQuery('');
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !projectData) return [];
    const { devices = [], gas = [], spaces = [] } = projectData;
    const r: SearchResult[] = [];

    for (const d of devices) {
      const addrMatch = d.individual_address?.toLowerCase().includes(q);
      const nameMatch = d.name?.toLowerCase().includes(q);
      const mfgMatch = d.manufacturer?.toLowerCase().includes(q);
      const orderMatch = d.order_number?.toLowerCase().includes(q);
      const serialMatch = d.serial_number?.toLowerCase().includes(q);
      const modelMatch = d.model?.toLowerCase().includes(q);
      if (
        addrMatch ||
        nameMatch ||
        mfgMatch ||
        orderMatch ||
        serialMatch ||
        modelMatch
      ) {
        r.push({
          type: 'device',
          wtype: 'device',
          address: d.individual_address,
          primary: d.individual_address,
          secondary: d.name,
          tertiary: [d.manufacturer, d.order_number]
            .filter(Boolean)
            .join(' · '),
          score:
            (mfgMatch || orderMatch || serialMatch ? 2 : 0) +
            (addrMatch ? 1 : 0),
        });
      }
    }
    for (const g of gas) {
      if (
        g.address?.toLowerCase().includes(q) ||
        g.name?.toLowerCase().includes(q)
      ) {
        r.push({
          type: 'ga',
          wtype: 'ga',
          address: g.address,
          primary: g.address,
          secondary: g.name,
          tertiary: g.dpt || '',
          score: 0,
        });
      }
    }
    for (const s of spaces) {
      if (s.name?.toLowerCase().includes(q)) {
        r.push({
          type: 'space',
          wtype: 'space',
          address: String(s.id),
          primary: s.name,
          secondary: s.type,
          tertiary: '',
          score: 0,
        });
      }
    }
    r.sort((a, b) => (b.score || 0) - (a.score || 0));
    return r.slice(0, 12);
  }, [query, projectData]);

  // Reset highlight when results change
  useEffect(() => {
    setHilite(0);
  }, [results]);

  const handleSelect = (r: SearchResult) => {
    onPin(r.wtype, r.address);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const handleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHilite((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHilite((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[hilite]) handleSelect(results[hilite]);
    }
  };

  const TYPE_COLOR: Record<string, string> = {
    device: C.accent,
    ga: C.purple,
    space: C.green,
  };
  const TYPE_LABEL: Record<string, string> = {
    device: 'DEV',
    ga: 'GA',
    space: 'LOC',
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        flex: '1 1 0',
        minWidth: 100,
        maxWidth: 260,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: C.inputBg,
          border: `1px solid ${focused ? C.accent : C.border}`,
          borderRadius: 4,
          padding: '0 8px',
          height: 26,
          transition: 'border-color 0.15s',
        }}
      >
        <span
          style={{ color: C.dim, fontSize: 12, lineHeight: 1, flexShrink: 0 }}
        >
          ○
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            if (query) setOpen(true);
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={handleInputKey}
          placeholder="Search  ⌘K"
          style={{
            background: 'none',
            border: 'none',
            outline: 'none',
            color: C.text,
            fontSize: 10,
            fontFamily: 'inherit',
            width: '100%',
            padding: 0,
          }}
        />
        {query && (
          <span
            onMouseDown={(e) => {
              e.preventDefault();
              setQuery('');
              setOpen(false);
            }}
            style={{
              color: C.dim,
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ×
          </span>
        )}
      </div>
      {open && results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 30,
            left: 0,
            right: 0,
            background: C.sidebar,
            border: `1px solid ${C.border2}`,
            borderRadius: 4,
            zIndex: 2000,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            minWidth: 280,
          }}
        >
          {results.map((r, i) => (
            <div
              key={i}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(r);
              }}
              onMouseEnter={() => setHilite(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                cursor: 'pointer',
                borderBottom:
                  i < results.length - 1 ? `1px solid ${C.border}` : 'none',
                background: i === hilite ? `${C.accent}18` : 'transparent',
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 5px',
                  borderRadius: 3,
                  letterSpacing: '0.06em',
                  flexShrink: 0,
                  background: `${TYPE_COLOR[r.type]}20`,
                  color: TYPE_COLOR[r.type],
                }}
              >
                {TYPE_LABEL[r.type]}
              </span>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: TYPE_COLOR[r.type],
                  flexShrink: 0,
                }}
              >
                {r.primary}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: C.muted,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.secondary}
              </span>
              {r.tertiary && (
                <span
                  style={{
                    fontSize: 9,
                    color: C.dim,
                    flexShrink: 0,
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.tertiary}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
