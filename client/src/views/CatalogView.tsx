import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Btn,
  Spinner,
  SearchBox,
  SectionHeader,
  Empty,
} from '../primitives.tsx';
import { api } from '../api.ts';
import { AddDeviceModal } from '../AddDeviceModal.tsx';
import styles from './CatalogView.module.css';

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

  useEffect(() => {
    if (!jumpTo?.manufacturer || !catalog) return;
    const { sections = [] } = catalog;
    const newExpanded: Record<string, boolean> = {};
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

  const { mfrGroups, filteredItemCount } = useMemo(() => {
    if (!catalog)
      return { mfrGroups: [] as [string, any[]][], filteredItemCount: 0 };
    const { sections = [], items = [] } = catalog;

    const filteredItems = sq
      ? items.filter(
          (i: any) =>
            i.name.toLowerCase().includes(sq) ||
            i.order_number.toLowerCase().includes(sq) ||
            i.manufacturer.toLowerCase().includes(sq) ||
            i.description.toLowerCase().includes(sq),
        )
      : items;

    const sectionMap: Record<string, any> = {};
    for (const s of sections)
      sectionMap[s.id] = { ...s, children: [], items: [] };

    for (const item of filteredItems) {
      if (sectionMap[item.section_id])
        sectionMap[item.section_id].items.push(item);
    }

    const roots: any[] = [];
    for (const s of sections) {
      if (s.parent_id && sectionMap[s.parent_id]) {
        sectionMap[s.parent_id].children.push(sectionMap[s.id]);
      } else {
        roots.push(sectionMap[s.id]);
      }
    }

    const countItems = (node: any): number => {
      let c = node.items.length;
      for (const child of node.children) c += countItems(child);
      node.totalItems = c;
      return c;
    };
    roots.forEach(countItems);

    const prune = (nodes: any[]): any[] =>
      nodes
        .filter((n) => n.totalItems > 0)
        .map((n) => ({ ...n, children: prune(n.children) }));
    const prunedRoots = sq ? prune(roots) : roots;

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

  if (!activeProjectId) return <Empty icon="◈" msg="No project selected" />;

  const renderSection = (node: any, depth: number): React.ReactNode => {
    const isOpen = sq || expandedSections[node.id];
    const hasContent = node.children.length > 0 || node.items.length > 0;
    return (
      <div key={node.id}>
        <div
          onClick={() => hasContent && toggleSection(node.id)}
          className={`${styles.sectionRow} ${depth === 0 ? styles.sectionRowRoot : ''} ${hasContent ? styles.sectionRowClickable : ''}`}
          data-depth={depth}
          style={{ paddingLeft: 14 + depth * 16 }}
        >
          {hasContent ? (
            <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
          ) : (
            <span className={styles.spacer} />
          )}
          <span
            className={
              depth === 0
                ? styles.sectionNameRoot
                : depth === 1
                  ? styles.sectionNameChild
                  : styles.sectionNameDeep
            }
          >
            {node.number ? `${node.number} ` : ''}
            {node.name}
          </span>
          <span className={styles.sectionCount}>{node.totalItems}</span>
        </div>
        {isOpen && (
          <>
            {node.items.length > 0 && (
              <div>
                {node.items.map((item: any) => (
                  <div
                    key={item.id}
                    className={styles.itemRow}
                    style={{ paddingLeft: 14 + (depth + 1) * 16 }}
                  >
                    {item.in_use ? (
                      <span
                        onClick={
                          onPin
                            ? () => onPin('model', item.model || item.name)
                            : undefined
                        }
                        className={`bg ${onPin ? styles.dotInUseClickable : styles.dotInUse}`}
                        title="View devices of this type"
                      >
                        ●
                      </span>
                    ) : (
                      <span className={styles.dotUnused}>○</span>
                    )}
                    <span
                      onClick={
                        item.in_use && onPin
                          ? () => onPin('model', item.model || item.name)
                          : undefined
                      }
                      className={`${item.in_use && onPin ? styles.itemNameClickable : styles.itemName} ${item.in_use && onPin ? 'bg' : ''}`}
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
                        className={`${onPin ? styles.orderNumClickable : styles.orderNum} ${onPin ? 'bg' : ''}`}
                      >
                        {item.order_number}
                      </span>
                    )}
                    {onAddDevice && (
                      <span
                        onClick={() => handleAddFromCatalog(item)}
                        className={`bg ${styles.addBadge}`}
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
    <div className={styles.root}>
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
            color="var(--accent)"
            bg="var(--surface)"
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
        className={styles.hidden}
      />

      <div className={styles.scrollArea}>
        {loading && (
          <div className={styles.loadingWrap}>
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
              <div className={styles.mfrHeader}>
                <span
                  onClick={onPin ? () => onPin('manufacturer', mfr) : undefined}
                  className={`${onPin ? styles.mfrNameClickable : styles.mfrName} ${onPin ? 'bg' : ''}`}
                >
                  {mfr}
                </span>
                <span className={styles.mfrCount}>
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
