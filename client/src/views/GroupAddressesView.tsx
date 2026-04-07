import { useState, useEffect, useMemo } from 'react';
import { useC } from '../theme.ts';
import { useDpt } from '../contexts.ts';
import {
  Btn,
  Chip,
  Spinner,
  TH,
  TD,
  SearchBox,
  SectionHeader,
  Empty,
  ConfirmModal,
  PinAddr,
} from '../primitives.tsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { RtfText } from '../rtf.tsx';

interface GroupAddressesViewProps {
  data: any;
  busConnected?: boolean;
  activeProjectId?: any;
  onWrite?: any;
  onDeviceJump?: any;
  onPin?: ((type: string, addr: string) => void) | null;
  onCreateGA?: ((body: any) => Promise<any>) | null;
  onDeleteGA?: ((id: any) => Promise<any>) | null;
  onUpdateGA?: ((id: any, updates: any) => Promise<any>) | null;
  onRenameGAGroup?:
    | ((main: number, mid: number | null, name: string) => Promise<any>)
    | null;
  jumpTo?: any;
}

export function GroupAddressesView({
  data,
  busConnected: _busConnected,
  activeProjectId: _activeProjectId,
  onWrite: _onWrite,
  onDeviceJump: _onDeviceJump,
  onPin,
  onCreateGA,
  onDeleteGA,
  onUpdateGA,
  onRenameGAGroup,
  jumpTo,
}: GroupAddressesViewProps) {
  const C = useC();
  const dpt = useDpt();
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState(
    () => localStorage.getItem('knx-ga-mode') || 'tree',
  );
  useEffect(() => {
    localStorage.setItem('knx-ga-mode', viewMode);
  }, [viewMode]);
  const [expand, setExpand] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('knx-ga-expand') || '{}');
    } catch {
      return {};
    }
  });
  const [creating, setCreating] = useState(false);
  const [newAddr, setNewAddr] = useState('');
  const [newName, setNewName] = useState('');
  const [newDpt, setNewDpt] = useState('');
  const [newSaving, setNewSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<any>(null); // GA object to confirm delete
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [inlineCreate, setInlineCreate] = useState<any>(null); // { main, mid } mid=null for main-level
  const [inlineAddr, setInlineAddr] = useState('');
  const [inlineName, setInlineName] = useState('');
  const [inlineDpt, setInlineDpt] = useState('');
  const [inlineSaving, setInlineSaving] = useState(false);
  const [editGroup, setEditGroup] = useState<any>(null); // { main, middle (null for main) }
  const [editGAId, setEditGAId] = useState<any>(null);
  const { gas = [], devices = [], gaDeviceMap = {} } = data || {};

  const GA_COLS = useMemo(
    () => [
      { id: 'address', label: 'Address', visible: true },
      { id: 'name', label: 'Name', visible: true },
      { id: 'dpt', label: 'DPT', visible: true },
      { id: 'devices', label: 'Devices', visible: true },
      { id: 'main_group', label: 'Main Group', visible: false },
      { id: 'middle_group', label: 'Middle Group', visible: false },
      { id: 'description', label: 'Description', visible: false },
      { id: 'comment', label: 'Comment', visible: false },
    ],
    [],
  );
  const [gaCols, saveGaCols] = useColumns('groups', GA_COLS);
  const gcv = (id: string) =>
    gaCols.find((c: any) => c.id === id)?.visible !== false;

  const exportGACSV = () =>
    dlCSV(
      'koolenex-group-addresses.csv',
      gaCols,
      filtered,
      (id: string, g: any) =>
        ({
          address: g.address,
          name: g.name,
          dpt: g.dpt,
          devices: (gaDeviceMap[g.address] || []).length,
          main_group: `${g.main_g}${g.main_group_name ? ' — ' + g.main_group_name : ''}`,
          middle_group: `${g.middle_g}${g.middle_group_name ? ' — ' + g.middle_group_name : ''}`,
          description: g.description || '',
          comment: g.comment || '',
        })[id] ?? '',
    );

  useEffect(() => {
    if (!jumpTo) return;
    const { main_g, middle_g } = jumpTo;
    const newExpand: Record<string, boolean> = {};
    for (const g of gas) {
      newExpand[g.main_g] = g.main_g === main_g;
      newExpand[`${g.main_g}/${g.middle_g}`] =
        g.main_g === main_g && middle_g !== null && g.middle_g === middle_g;
    }
    setViewMode('tree');
    setSearch('');
    setExpand(newExpand);
  }, [jumpTo]);

  const handleCreate = async () => {
    if (!newAddr.trim() || !newName.trim() || !onCreateGA) return;
    setNewSaving(true);
    try {
      await onCreateGA({
        address: newAddr.trim(),
        name: newName.trim(),
        dpt: newDpt.trim(),
      });
      setNewAddr('');
      setNewName('');
      setNewDpt('');
      setCreating(false);
    } catch (e) {
      console.error(e);
    }
    setNewSaving(false);
  };

  const nextAddrForMain = (main: number) => {
    const mids = gas
      .filter((g: any) => g.main_g === main)
      .map((g: any) => g.middle_g);
    const maxMid = mids.length ? Math.max(...mids) : -1;
    return `${main}/${maxMid + 1}`;
  };

  const nextAddrForMid = (main: number, mid: number) => {
    const subs = gas
      .filter(
        (g: any) => g.main_g === main && g.middle_g === mid && g.sub_g != null,
      )
      .map((g: any) => g.sub_g);
    const maxSub = subs.length ? Math.max(...subs) : -1;
    return `${main}/${mid}/${maxSub + 1}`;
  };

  const openInlineCreate = (
    e: React.MouseEvent,
    main: number,
    mid: number | null = null,
  ) => {
    e.stopPropagation();
    const addr =
      mid === null ? nextAddrForMain(main) : nextAddrForMid(main, mid);
    setInlineCreate({ main, mid });
    setInlineAddr(addr);
    setInlineName('');
    setInlineDpt('');
  };

  const handleInlineCreate = async () => {
    if (!inlineAddr.trim() || !inlineName.trim() || !onCreateGA) return;
    setInlineSaving(true);
    try {
      await onCreateGA({
        address: inlineAddr.trim(),
        name: inlineName.trim(),
        dpt: inlineDpt.trim(),
      });
      setInlineCreate(null);
    } catch (_) {}
    setInlineSaving(false);
  };

  const startEditGroup = (
    e: React.MouseEvent,
    main: number,
    middle: number | null,
  ) => {
    e.stopPropagation();
    setEditGroup({ main, middle });
  };

  const startEditGA = (e: React.MouseEvent, ga: any) => {
    e.stopPropagation();
    setEditGAId(ga.id);
  };

  useEffect(() => {
    try {
      localStorage.setItem('knx-ga-expand', JSON.stringify(expand));
    } catch {}
  }, [expand]);

  const filtered = gas.filter((g: any) => {
    const s = search.toLowerCase();
    return (
      !s ||
      g.address.includes(s) ||
      g.name.toLowerCase().includes(s) ||
      g.dpt.toLowerCase().includes(s)
    );
  });
  const mains: any[] = [...new Set(filtered.map((g: any) => g.main_g))].sort(
    (a: any, b: any) => a - b,
  );

  const toggleMain = (m: number) =>
    setExpand((p: any) => ({ ...p, [m]: !(p[m] ?? true) }));
  const toggleMid = (m: number, mi: number) =>
    setExpand((p: any) => ({
      ...p,
      [`${m}/${mi}`]: !(p[`${m}/${mi}`] ?? false),
    }));

  const GARow = ({ g, indent = 0 }: { g: any; indent?: number }) => {
    const [hovered, setHovered] = useState(false);
    return (
      <tr
        className="rh"
        onClick={() => onPin?.('ga', g.address)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ borderLeft: '2px solid transparent', cursor: 'pointer' }}
      >
        {gcv('address') && (
          <TD style={{ paddingLeft: 12 + indent }}>
            <div
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <PinAddr
                address={g.address}
                wtype="ga"
                style={{ color: C.purple, fontFamily: 'monospace' }}
              />
              {onDeleteGA && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirm(g);
                  }}
                  title="Delete GA"
                  style={{
                    position: 'absolute',
                    right: -16,
                    color: C.red,
                    fontSize: 11,
                    cursor: 'pointer',
                    opacity: hovered ? 0.7 : 0,
                    lineHeight: 1,
                    transition: 'opacity 0.1s',
                  }}
                >
                  ✕
                </span>
              )}
            </div>
          </TD>
        )}
        {gcv('name') && (
          <TD>
            {editGAId === g.id ? (
              <InlineEdit
                initial={g.name}
                fontSize={11}
                onSave={async (v) => {
                  await onUpdateGA!(g.id, { name: v });
                  setEditGAId(null);
                }}
                onCancel={() => setEditGAId(null)}
                C={C}
              />
            ) : (
              <span
                onClick={onUpdateGA ? (e) => startEditGA(e, g) : undefined}
                style={{ cursor: onUpdateGA ? 'text' : 'default' }}
                title={onUpdateGA ? 'Click to rename' : undefined}
              >
                {g.name}
              </span>
            )}
          </TD>
        )}
        {gcv('dpt') && (
          <TD>
            <span
              style={{ color: C.muted, fontSize: 10 }}
              title={dpt.hover(g.dpt)}
            >
              {dpt.display(g.dpt)}
            </span>
          </TD>
        )}
        {gcv('devices') && (
          <TD>
            <span style={{ color: C.dim }}>
              {(gaDeviceMap[g.address] || []).length}
            </span>
          </TD>
        )}
        {gcv('main_group') && (
          <TD>
            <span style={{ color: C.dim, fontSize: 10 }}>
              {g.main_g}
              {g.main_group_name ? ` — ${g.main_group_name}` : ''}
            </span>
          </TD>
        )}
        {gcv('middle_group') && (
          <TD>
            <span style={{ color: C.dim, fontSize: 10 }}>
              {g.middle_g}
              {g.middle_group_name ? ` — ${g.middle_group_name}` : ''}
            </span>
          </TD>
        )}
        {gcv('description') && (
          <TD>
            <span style={{ color: C.dim, fontSize: 10 }}>
              {g.description || ''}
            </span>
          </TD>
        )}
        {gcv('comment') && (
          <TD>
            <span style={{ color: C.dim, fontSize: 10 }}>
              <RtfText value={g.comment} />
            </span>
          </TD>
        )}
      </tr>
    );
  };

  const _gaVisColCount = gaCols.filter((c: any) => c.visible !== false).length;

  const handleConfirmDelete = async () => {
    if (!deleteConfirm || !onDeleteGA) return;
    setDeleteInProgress(true);
    try {
      await onDeleteGA(deleteConfirm.id);
      setDeleteConfirm(null);
    } catch (_) {}
    setDeleteInProgress(false);
  };

  const assocDevices = deleteConfirm
    ? gaDeviceMap[deleteConfirm.address] || []
    : [];

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {deleteConfirm && (
        <ConfirmModal
          title={`Delete ${deleteConfirm.address} — ${deleteConfirm.name}?`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteConfirm(null)}
          confirmLabel={deleteInProgress ? 'Deleting…' : 'Yes, Delete'}
        >
          {assocDevices.length > 0 ? (
            <>
              <div style={{ marginBottom: 8 }}>
                This will also remove <strong>{assocDevices.length}</strong>{' '}
                device association{assocDevices.length !== 1 ? 's' : ''}:
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  maxHeight: 120,
                  overflowY: 'auto',
                }}
              >
                {assocDevices.map((addr: any) => {
                  const dev = devices.find(
                    (d: any) => d.individual_address === addr,
                  );
                  return (
                    <li key={addr} style={{ fontFamily: 'monospace' }}>
                      {addr}
                      {dev?.name ? ` — ${dev.name}` : ''}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div>
              This group address has no device associations. It will be
              permanently deleted.
            </div>
          )}
        </ConfirmModal>
      )}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <SectionHeader
          title="Group Addresses"
          count={filtered.length}
          actions={[
            <SearchBox
              key="s"
              value={search}
              onChange={setSearch}
              placeholder="Search GAs…"
            />,
            <Chip
              key="tree"
              active={viewMode === 'tree'}
              onClick={() => setViewMode('tree')}
            >
              Tree
            </Chip>,
            <Chip
              key="flat"
              active={viewMode === 'flat'}
              onClick={() => setViewMode('flat')}
            >
              Flat
            </Chip>,
            onCreateGA && (
              <Btn
                key="new"
                onClick={() => setCreating((p) => !p)}
                color={C.green}
              >
                + New GA
              </Btn>
            ),
            <ColumnPicker key="cp" cols={gaCols} onChange={saveGaCols} C={C} />,
            <Btn key="csv" onClick={exportGACSV} color={C.muted} bg={C.surface}>
              ↓ CSV
            </Btn>,
          ]}
        />
        {creating && (
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
            <input
              value={newAddr}
              onChange={(e) => setNewAddr(e.target.value)}
              placeholder="1/2/3"
              style={{
                background: C.inputBg,
                border: `1px solid ${C.border2}`,
                borderRadius: 4,
                padding: '6px 10px',
                color: C.text,
                fontSize: 11,
                fontFamily: 'monospace',
                width: 80,
              }}
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              style={{
                background: C.inputBg,
                border: `1px solid ${C.border2}`,
                borderRadius: 4,
                padding: '6px 10px',
                color: C.text,
                fontSize: 11,
                fontFamily: 'inherit',
                flex: 1,
                minWidth: 120,
              }}
            />
            <input
              value={newDpt}
              onChange={(e) => setNewDpt(e.target.value)}
              placeholder="DPT (optional)"
              style={{
                background: C.inputBg,
                border: `1px solid ${C.border2}`,
                borderRadius: 4,
                padding: '6px 10px',
                color: C.text,
                fontSize: 11,
                fontFamily: 'monospace',
                width: 120,
              }}
            />
            <Btn
              onClick={handleCreate}
              disabled={newSaving || !newAddr.trim() || !newName.trim()}
              color={C.green}
            >
              {newSaving ? <Spinner /> : 'Create'}
            </Btn>
            <Btn onClick={() => setCreating(false)} color={C.dim}>
              Cancel
            </Btn>
          </div>
        )}
        <div style={{ overflow: 'auto', flex: 1 }}>
          {viewMode === 'flat' ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {gaCols
                    .filter((c: any) => c.visible !== false)
                    .map((col: any) => (
                      <TH
                        key={col.id}
                        style={
                          col.id === 'address'
                            ? { width: 100 }
                            : col.id === 'devices'
                              ? { width: 70 }
                              : col.id === 'dpt'
                                ? { width: 180 }
                                : {}
                        }
                      >
                        {col.label.toUpperCase().replace('GAS', 'GAs')}
                      </TH>
                    ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((g: any) => (
                  <GARow key={g.id} g={g} />
                ))}
              </tbody>
            </table>
          ) : (
            mains.map((main: any) => {
              const mainGAs = filtered.filter((g: any) => g.main_g === main);
              const middles: any[] = [
                ...new Set(mainGAs.map((g: any) => g.middle_g)),
              ].sort((a: any, b: any) => a - b);
              const mainExpanded = search ? true : expand[main] !== false;
              const mainName = mainGAs[0]?.main_group_name;
              return (
                <div key={`m${main}`}>
                  <div
                    onClick={() => toggleMain(main)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 14px',
                      background: C.surface,
                      borderBottom: `1px solid ${C.border}`,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <span style={{ fontSize: 9, color: C.dim, width: 14 }}>
                      {mainExpanded ? '▾' : '▸'}
                    </span>
                    {editGroup?.main === main && editGroup?.middle === null ? (
                      <InlineEdit
                        prefix={`${main} —`}
                        initial={mainName || ''}
                        fontSize={11}
                        onSave={async (v) => {
                          await onRenameGAGroup!(main, null, v);
                          setEditGroup(null);
                        }}
                        onCancel={() => setEditGroup(null)}
                        C={C}
                      />
                    ) : (
                      <>
                        <span
                          style={{
                            color: C.accent,
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {main}
                        </span>
                        {mainName ? (
                          <span
                            onClick={
                              onRenameGAGroup
                                ? (e) => startEditGroup(e, main, null)
                                : undefined
                            }
                            style={{
                              color: C.accent,
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: onRenameGAGroup ? 'text' : 'default',
                            }}
                            title={
                              onRenameGAGroup ? 'Click to rename' : undefined
                            }
                          >
                            — {mainName}
                          </span>
                        ) : (
                          onRenameGAGroup && (
                            <span
                              onClick={(e) => startEditGroup(e, main, null)}
                              style={{
                                color: C.dim,
                                fontSize: 10,
                                cursor: 'pointer',
                                fontStyle: 'italic',
                              }}
                            >
                              + name
                            </span>
                          )
                        )}
                      </>
                    )}
                    <span style={{ color: C.dim, fontSize: 10 }}>
                      · {mainGAs.length}
                    </span>
                    {onCreateGA && (
                      <span
                        onClick={(e) => openInlineCreate(e, main, null)}
                        title="Add GA under this group"
                        style={{
                          marginLeft: 4,
                          color: C.green,
                          fontSize: 13,
                          lineHeight: 1,
                          cursor: 'pointer',
                          opacity: 0.7,
                        }}
                      >
                        +
                      </span>
                    )}
                  </div>
                  {inlineCreate?.main === main && inlineCreate.mid === null && (
                    <div
                      style={{
                        padding: '8px 14px 8px 28px',
                        borderBottom: `1px solid ${C.border}`,
                        background: C.surface,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <input
                        value={inlineAddr}
                        onChange={(e) => setInlineAddr(e.target.value)}
                        placeholder="m/mi"
                        style={{
                          background: C.inputBg,
                          border: `1px solid ${C.border2}`,
                          borderRadius: 4,
                          padding: '6px 10px',
                          color: C.text,
                          fontSize: 11,
                          fontFamily: 'monospace',
                          width: 80,
                        }}
                      />
                      <input
                        value={inlineName}
                        onChange={(e) => setInlineName(e.target.value)}
                        placeholder="Group name"
                        autoFocus
                        style={{
                          background: C.inputBg,
                          border: `1px solid ${C.border2}`,
                          borderRadius: 4,
                          padding: '6px 10px',
                          color: C.text,
                          fontSize: 11,
                          fontFamily: 'inherit',
                          flex: 1,
                          minWidth: 120,
                        }}
                      />
                      <Btn
                        onClick={handleInlineCreate}
                        disabled={
                          inlineSaving ||
                          !inlineAddr.trim() ||
                          !inlineName.trim()
                        }
                        color={C.green}
                      >
                        {inlineSaving ? <Spinner /> : 'Create'}
                      </Btn>
                      <Btn onClick={() => setInlineCreate(null)} color={C.dim}>
                        Cancel
                      </Btn>
                    </div>
                  )}
                  {mainExpanded &&
                    middles.map((mid: any) => {
                      const allInGroup = filtered.filter(
                        (g: any) => g.main_g === main && g.middle_g === mid,
                      );
                      const placeholder2 = allInGroup.find(
                        (g: any) => g.sub_g === null,
                      );
                      const subs = allInGroup.filter(
                        (g: any) => g.sub_g !== null,
                      );
                      const midKey = `${main}/${mid}`;
                      const midExpanded = search
                        ? true
                        : expand[midKey] === true;
                      const midName =
                        allInGroup.find((g: any) => g.middle_group_name)
                          ?.middle_group_name ||
                        placeholder2?.name ||
                        undefined;
                      return (
                        <div key={`m${main}mi${mid}`}>
                          <div
                            onClick={() => toggleMid(main, mid)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '5px 14px 5px 28px',
                              background: C.hover,
                              borderBottom: `1px solid ${C.border}`,
                              cursor: 'pointer',
                              userSelect: 'none',
                            }}
                          >
                            <span
                              style={{ fontSize: 9, color: C.dim, width: 14 }}
                            >
                              {midExpanded ? '▾' : '▸'}
                            </span>
                            {editGroup?.main === main &&
                            editGroup?.middle === mid ? (
                              <InlineEdit
                                prefix={`${main}/${mid} —`}
                                initial={midName || ''}
                                fontSize={10}
                                onSave={async (v) => {
                                  await onRenameGAGroup!(main, mid, v);
                                  setEditGroup(null);
                                }}
                                onCancel={() => setEditGroup(null)}
                                C={C}
                              />
                            ) : (
                              <>
                                <span
                                  style={{
                                    color: C.text,
                                    fontSize: 10,
                                    fontWeight: 500,
                                  }}
                                >
                                  {main}/{mid}
                                </span>
                                {midName ? (
                                  <span
                                    onClick={
                                      onRenameGAGroup
                                        ? (e) => startEditGroup(e, main, mid)
                                        : undefined
                                    }
                                    style={{
                                      color: C.text,
                                      fontSize: 10,
                                      fontWeight: 500,
                                      cursor: onRenameGAGroup
                                        ? 'text'
                                        : 'default',
                                    }}
                                    title={
                                      onRenameGAGroup
                                        ? 'Click to rename'
                                        : undefined
                                    }
                                  >
                                    — {midName}
                                  </span>
                                ) : (
                                  onRenameGAGroup && (
                                    <span
                                      onClick={(e) =>
                                        startEditGroup(e, main, mid)
                                      }
                                      style={{
                                        color: C.dim,
                                        fontSize: 9,
                                        cursor: 'pointer',
                                        fontStyle: 'italic',
                                      }}
                                    >
                                      + name
                                    </span>
                                  )
                                )}
                              </>
                            )}
                            <span style={{ color: C.dim, fontSize: 10 }}>
                              · {subs.length}
                            </span>
                            {onCreateGA && (
                              <span
                                onClick={(e) => openInlineCreate(e, main, mid)}
                                title="Add GA under this group"
                                style={{
                                  marginLeft: 4,
                                  color: C.green,
                                  fontSize: 13,
                                  lineHeight: 1,
                                  cursor: 'pointer',
                                  opacity: 0.7,
                                }}
                              >
                                +
                              </span>
                            )}
                          </div>
                          {inlineCreate?.main === main &&
                            inlineCreate.mid === mid && (
                              <div
                                style={{
                                  padding: '8px 14px 8px 42px',
                                  borderBottom: `1px solid ${C.border}`,
                                  background: C.hover,
                                  display: 'flex',
                                  gap: 8,
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <input
                                  value={inlineAddr}
                                  onChange={(e) =>
                                    setInlineAddr(e.target.value)
                                  }
                                  placeholder="m/mi/s"
                                  style={{
                                    background: C.inputBg,
                                    border: `1px solid ${C.border2}`,
                                    borderRadius: 4,
                                    padding: '6px 10px',
                                    color: C.text,
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    width: 80,
                                  }}
                                />
                                <input
                                  value={inlineName}
                                  onChange={(e) =>
                                    setInlineName(e.target.value)
                                  }
                                  placeholder="Name"
                                  autoFocus
                                  style={{
                                    background: C.inputBg,
                                    border: `1px solid ${C.border2}`,
                                    borderRadius: 4,
                                    padding: '6px 10px',
                                    color: C.text,
                                    fontSize: 11,
                                    fontFamily: 'inherit',
                                    flex: 1,
                                    minWidth: 120,
                                  }}
                                />
                                <input
                                  value={inlineDpt}
                                  onChange={(e) => setInlineDpt(e.target.value)}
                                  placeholder="DPT (optional)"
                                  style={{
                                    background: C.inputBg,
                                    border: `1px solid ${C.border2}`,
                                    borderRadius: 4,
                                    padding: '6px 10px',
                                    color: C.text,
                                    fontSize: 11,
                                    fontFamily: 'monospace',
                                    width: 120,
                                  }}
                                />
                                <Btn
                                  onClick={handleInlineCreate}
                                  disabled={
                                    inlineSaving ||
                                    !inlineAddr.trim() ||
                                    !inlineName.trim()
                                  }
                                  color={C.green}
                                >
                                  {inlineSaving ? <Spinner /> : 'Create'}
                                </Btn>
                                <Btn
                                  onClick={() => setInlineCreate(null)}
                                  color={C.dim}
                                >
                                  Cancel
                                </Btn>
                              </div>
                            )}
                          {midExpanded && (
                            <table
                              style={{
                                width: '100%',
                                borderCollapse: 'collapse',
                              }}
                            >
                              <thead>
                                <tr>
                                  {gaCols
                                    .filter((c: any) => c.visible !== false)
                                    .map((col: any) => (
                                      <TH
                                        key={col.id}
                                        style={
                                          col.id === 'address'
                                            ? { width: 100, paddingLeft: 42 }
                                            : col.id === 'devices'
                                              ? { width: 70 }
                                              : col.id === 'dpt'
                                                ? { width: 180 }
                                                : {}
                                        }
                                      >
                                        {col.label
                                          .toUpperCase()
                                          .replace('GAS', 'GAs')}
                                      </TH>
                                    ))}
                                </tr>
                              </thead>
                              <tbody>
                                {subs.map((g: any) => (
                                  <GARow key={g.id} g={g} indent={30} />
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })
          )}
          {filtered.length === 0 && <Empty icon="◆" msg="No group addresses" />}
        </div>
      </div>
    </div>
  );
}

/** Self-contained inline edit — owns its own input state so parent re-renders don't reset cursor. */
function InlineEdit({
  initial,
  prefix,
  fontSize = 11,
  onSave,
  onCancel,
  C,
}: {
  initial: string;
  prefix?: string;
  fontSize?: number;
  onSave: (v: string) => Promise<void>;
  onCancel: () => void;
  C: any;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await onSave(value.trim());
    } catch (_) {}
    setSaving(false);
  };
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 1 }}
    >
      {prefix && (
        <span style={{ fontSize, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {prefix}
        </span>
      )}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          background: C.inputBg,
          border: `1px solid ${C.accent}`,
          borderRadius: 3,
          padding: '2px 6px',
          color: C.text,
          fontSize,
          fontFamily: 'inherit',
          flex: 1,
          minWidth: 80,
        }}
      />
      <Btn onClick={save} disabled={saving || !value.trim()} color={C.green}>
        {saving ? <Spinner /> : 'Save'}
      </Btn>
      <Btn onClick={onCancel} color={C.dim}>
        Cancel
      </Btn>
    </div>
  );
}
