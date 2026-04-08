import { useState, useEffect, useMemo, useRef } from 'react';
import { useC } from '../theme.ts';
import {
  Btn,
  Spinner,
  SearchBox,
  SectionHeader,
  Empty,
} from '../primitives.tsx';
import { api } from '../api.ts';
import { AddDeviceModal } from '../AddDeviceModal.tsx';

interface CatalogViewProps {
  activeProjectId: any;
  data: any;
  onAddDevice?: ((body: any) => Promise<any>) | null;
  onPin?: ((type: string, value: string) => void) | null;
  jumpTo?: any;
}

export function CatalogView({
  activeProjectId,
  data,
  onAddDevice,
  onPin,
  jumpTo,
}: CatalogViewProps) {
  const C = useC();
  const [catalog, setCatalog] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});
  const [importing, setImporting] = useState(false);
  const [addDefaults, setAddDefaults] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!activeProjectId) return;
    setLoading(true);
    api
      .getCatalog(activeProjectId)
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [activeProjectId]);

  // Handle jumpTo -- expand the target manufacturer's first-level sections, collapse all others
  useEffect(() => {
    if (!jumpTo?.manufacturer || !catalog) return;
    const { sections = [] } = catalog;
    const newExpanded: Record<string, boolean> = {};
    // Find root sections belonging to this manufacturer and expand them
    for (const sec of sections) {
      if (!sec.parent_id && sec.manufacturer === jumpTo.manufacturer) {
        newExpanded[sec.id] = true;
      }
    }
    setExpandedSections(newExpanded);
    setSearch('');
  }, [jumpTo, catalog]);

  const handleImportKnxprod = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file || !activeProjectId) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const result = (await api.importKnxprod(activeProjectId, fd)) as {
        sections: any[];
        items: any[];
      };
      setCatalog({ sections: result.sections, items: result.items });
    } catch (err) {
      console.error('knxprod import error:', err);
    }
    setImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleAddFromCatalog = (item: any) => {
    setAddDefaults({
      manufacturer: item.manufacturer,
      model: item.model || item.name,
      order_number: item.order_number,
      product_ref: item.product_ref,
    });
  };

  const toggleSection = (id: string) =>
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const sq = search.toLowerCase();

  // Build tree from flat sections/items
  const { mfrGroups, filteredItemCount } = useMemo(() => {
    if (!catalog)
      return { mfrGroups: [] as [string, any[]][], filteredItemCount: 0 };
    const { sections = [], items = [] } = catalog;

    // Filter items by search
    const filteredItems = sq
      ? items.filter(
          (i: any) =>
            i.name.toLowerCase().includes(sq) ||
            i.order_number.toLowerCase().includes(sq) ||
            i.manufacturer.toLowerCase().includes(sq) ||
            i.description.toLowerCase().includes(sq),
        )
      : items;

    // Build section map
    const sectionMap: Record<string, any> = {};
    for (const s of sections)
      sectionMap[s.id] = { ...s, children: [], items: [] };

    // Assign items to sections
    for (const item of filteredItems) {
      if (sectionMap[item.section_id])
        sectionMap[item.section_id].items.push(item);
    }

    // Build parent-child relationships
    const roots: any[] = [];
    for (const s of sections) {
      if (s.parent_id && sectionMap[s.parent_id]) {
        sectionMap[s.parent_id].children.push(sectionMap[s.id]);
      } else {
        roots.push(sectionMap[s.id]);
      }
    }

    // Count items recursively for each section
    const countItems = (node: any): number => {
      let c = node.items.length;
      for (const child of node.children) c += countItems(child);
      node.totalItems = c;
      return c;
    };
    roots.forEach(countItems);

    // Filter out empty sections when searching
    const prune = (nodes: any[]): any[] =>
      nodes
        .filter((n) => n.totalItems > 0)
        .map((n) => ({ ...n, children: prune(n.children) }));
    const prunedRoots = sq ? prune(roots) : roots;

    // Group roots by manufacturer
    const byMfr: Record<string, any[]> = {};
    for (const r of prunedRoots) {
      const mfr = r.manufacturer || 'Unknown';
      if (!byMfr[mfr]) byMfr[mfr] = [];
      byMfr[mfr]!.push(r);
    }
    const mfrGroups = Object.entries(byMfr).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    return { mfrGroups, filteredItemCount: filteredItems.length };
  }, [catalog, sq]);

  if (!activeProjectId)
    return <Empty icon="◈" msg="No project selected" />;

  const renderSection = (node: any, depth: number): React.ReactNode => {
    const isOpen = sq || expandedSections[node.id];
    const hasContent = node.children.length > 0 || node.items.length > 0;
    return (
      <div key={node.id}>
        <div
          onClick={() => hasContent && toggleSection(node.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: `4px 14px 4px ${14 + depth * 16}px`,
            background: depth === 0 ? C.surface : 'transparent',
            borderBottom: `1px solid ${C.border}`,
            cursor: hasContent ? 'pointer' : 'default',
            userSelect: 'none',
          }}
        >
          {hasContent ? (
            <span style={{ fontSize: 9, color: C.dim, width: 10 }}>
              {isOpen ? '▾' : '▸'}
            </span>
          ) : (
            <span style={{ width: 10 }} />
          )}
          <span
            style={{
              fontSize: depth === 0 ? 11 : 10,
              fontWeight: depth <= 1 ? 600 : 400,
              color: depth === 0 ? C.accent : C.text,
              flex: 1,
            }}
          >
            {node.number ? `${node.number} ` : ''}
            {node.name}
          </span>
          <span style={{ fontSize: 9, color: C.dim }}>{node.totalItems}</span>
        </div>
        {isOpen && (
          <>
            {node.items.length > 0 && (
              <div>
                {node.items.map((item: any) => (
                  <div
                    key={item.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: `5px 14px 5px ${14 + (depth + 1) * 16}px`,
                      borderBottom: `1px solid ${C.border}11`,
                      fontSize: 10,
                    }}
                  >
                    {item.in_use ? (
                      <span
                        onClick={
                          onPin
                            ? () => onPin('model', item.model || item.name)
                            : undefined
                        }
                        style={{
                          color: C.green,
                          fontSize: 10,
                          flexShrink: 0,
                          cursor: onPin ? 'pointer' : 'default',
                          padding: '0 2px',
                        }}
                        title="View devices of this type"
                        className="bg"
                      >
                        ●
                      </span>
                    ) : (
                      <span
                        style={{
                          color: C.dim,
                          fontSize: 10,
                          flexShrink: 0,
                          padding: '0 2px',
                        }}
                      >
                        ○
                      </span>
                    )}
                    <span
                      onClick={
                        item.in_use && onPin
                          ? () => onPin('model', item.model || item.name)
                          : undefined
                      }
                      style={{
                        color: C.text,
                        flex: 1,
                        cursor: item.in_use && onPin ? 'pointer' : 'default',
                      }}
                      className={item.in_use && onPin ? 'bg' : undefined}
                    >
                      {item.name}
                    </span>
                    {item.order_number && (
                      <span
                        onClick={
                          onPin
                            ? () => onPin('order_number', item.order_number)
                            : undefined
                        }
                        style={{
                          color: C.dim,
                          fontFamily: 'monospace',
                          fontSize: 9,
                          flexShrink: 0,
                          cursor: onPin ? 'pointer' : 'default',
                        }}
                        className={onPin ? 'bg' : undefined}
                      >
                        {item.order_number}
                      </span>
                    )}
                    {onAddDevice && (
                      <span
                        onClick={() => handleAddFromCatalog(item)}
                        style={{
                          fontSize: 9,
                          padding: '1px 6px',
                          borderRadius: 10,
                          background: `${C.green}18`,
                          color: C.green,
                          border: `1px solid ${C.green}30`,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}
                        className="bg"
                      >
                        + Add
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {node.children.map((child: any) => renderSection(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SectionHeader
        title="Product Catalog"
        count={filteredItemCount}
        actions={[
          <SearchBox
            key="s"
            value={search}
            onChange={setSearch}
            placeholder="Search products…"
          />,
          <Btn
            key="imp"
            onClick={() => fileRef.current?.click()}
            color={C.accent}
            bg={C.surface}
            disabled={importing}
          >
            {importing ? (
              <>
                <Spinner /> Importing…
              </>
            ) : (
              '+ Import .knxprod'
            )}
          </Btn>,
        ]}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".knxprod"
        onChange={handleImportKnxprod}
        style={{ display: 'none' }}
      />

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <div style={{ padding: 20, textAlign: 'center' }}>
            <Spinner /> Loading catalog…
          </div>
        )}
        {!loading && catalog && filteredItemCount === 0 && (
          <Empty
            icon="◈"
            msg={
              sq
                ? 'No products match search'
                : 'No catalog data — reimport your .knxproj or import a .knxprod file'
            }
          />
        )}
        {!loading &&
          catalog &&
          mfrGroups.map(([mfr, sections]) => (
            <div key={mfr}>
              <div
                style={{
                  padding: '8px 14px',
                  background: C.surface,
                  borderBottom: `1px solid ${C.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  onClick={onPin ? () => onPin('manufacturer', mfr) : undefined}
                  style={{
                    color: C.amber,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: onPin ? 'pointer' : 'default',
                  }}
                  className={onPin ? 'bg' : undefined}
                >
                  {mfr}
                </span>
                <span style={{ color: C.dim, fontSize: 10 }}>
                  ·{' '}
                  {sections.reduce((s: number, n: any) => s + n.totalItems, 0)}{' '}
                  products
                </span>
              </div>
              {sections.map((sec: any) => renderSection(sec, 0))}
            </div>
          ))}
      </div>
      {addDefaults && onAddDevice && (
        <AddDeviceModal
          data={data}
          defaults={addDefaults}
          onAdd={onAddDevice}
          onClose={() => setAddDefaults(null)}
        />
      )}
    </div>
  );
}
