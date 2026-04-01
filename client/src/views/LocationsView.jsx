import { useState, useContext, useMemo } from 'react';
import { useC, STATUS_COLOR, I18nCtx } from '../theme.js';
import { PinContext } from '../contexts.js';
import { Badge, Btn, Chip, TH, TD, SearchBox, SectionHeader, Empty, PinAddr } from '../primitives.jsx';
import { SpaceTypeIcon, DeviceTypeIcon } from '../icons.jsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.jsx';
import { spaceUsageMap, localizedModel } from '../dpt.js';

import { AddDeviceModal } from '../AddDeviceModal.jsx';

export function LocationsView({ data, dispatch, onAddDevice, onUpdateDevice, onUpdateSpace, onCreateSpace, onDeleteSpace }) {
  const C = useC();
  const pin = useContext(PinContext);
  const { t: i18t } = useContext(I18nCtx);
  const COLMAP = { actuator: C.actuator, sensor: C.sensor, router: C.router, generic: C.muted };
  const { spaces = [], devices = [], deviceGAMap = {} } = data || {};
  const [search, setSearch] = useState('');
  const [addDefaults, setAddDefaults] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [spaceSort, setSpaceSort] = useState(() => localStorage.getItem('knx-loc-sort') || 'import');
  const [editSpaceId, setEditSpaceId] = useState(null);
  const [editDevId, setEditDevId] = useState(null);
  const [addSpaceParent, setAddSpaceParent] = useState(null); // null = not adding, { parentId, defaultType }
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('knx-loc-collapsed');
      if (stored) return new Set(JSON.parse(stored));
    } catch {}
    return new Set(spaces.filter(s => s.parent_id).map(s => s.id));
  });
  const toggleCollapse = (id) => setCollapsed(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem('knx-loc-collapsed', JSON.stringify([...n])); } catch {}
    return n;
  });

  const LOC_COLS = useMemo(() => [
    { id: 'individual_address', label: 'Address',      visible: true },
    { id: 'name',               label: 'Name',         visible: true },
    { id: 'device_type',        label: 'Type',         visible: true },
    { id: 'manufacturer',       label: 'Manufacturer', visible: true },
    { id: 'model',              label: 'Model',        visible: true },
    { id: 'serial_number',      label: 'Serial',       visible: false },
    { id: 'status',             label: 'Status',       visible: true },
    { id: 'gas',                label: 'GAs',          visible: true },
  ], []);
  const [locCols, saveLocCols] = useColumns('locations', LOC_COLS);
  const lcv = id => locCols.find(c => c.id === id)?.visible !== false;
  const visibleLocCols = locCols.filter(c => c.visible !== false);

  if (!spaces.length) return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <SectionHeader title="Locations" count={0} />
      <Empty icon="◻" msg="No location data in this project — location info is stored in ETS under the Buildings tab" />
    </div>
  );

  // Build tree
  const nodeMap = {};
  for (const s of spaces) nodeMap[s.id] = { ...s, children: [], devs: [] };
  const roots = [];
  for (const s of spaces) {
    if (s.parent_id && nodeMap[s.parent_id]) nodeMap[s.parent_id].children.push(nodeMap[s.id]);
    else roots.push(nodeMap[s.id]);
  }
  const sortSpaces = arr => arr.sort((a, b) =>
    spaceSort === 'name' ? a.name.localeCompare(b.name)
    : (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
  );
  sortSpaces(roots);
  for (const n of Object.values(nodeMap)) { sortSpaces(n.children); }
  for (const d of devices) {
    if (d.space_id && nodeMap[d.space_id]) nodeMap[d.space_id].devs.push(d);
  }
  for (const n of Object.values(nodeMap)) { n.devs.sort((a, b) => a.name.localeCompare(b.name)); }

  const sq = search.toLowerCase();
  const matchesSearch = (node) => {
    if (!sq) return true;
    if (node.name.toLowerCase().includes(sq)) return true;
    if (node.devs.some(d => d.name.toLowerCase().includes(sq) || d.individual_address.includes(sq))) return true;
    return node.children.some(c => matchesSearch(c));
  };

  const exportLocCSV = () => {
    const allDevs = devices.filter(d =>
      (filterStatus === 'all' || d.status === filterStatus) &&
      (!sq || d.name.toLowerCase().includes(sq) || d.individual_address.includes(sq)));
    dlCSV('koolenex-locations.csv', locCols, allDevs,
      (id, d) => ({
        individual_address: d.individual_address, name: d.name,
        device_type: d.device_type, manufacturer: d.manufacturer || '',
        model: d.model || '', serial_number: d.serial_number || '',
        status: d.status, gas: (deviceGAMap[d.individual_address] || []).length,
      })[id] ?? ''
    );
  };

  const renderSpace = (node, depth) => {
    if (!matchesSearch(node)) return null;
    const isCollapsed  = sq ? false : collapsed.has(node.id);
    const hasChildren  = node.children.length > 0 || node.devs.length > 0;
    const filteredDevs = node.devs.filter(d =>
      (filterStatus === 'all' || d.status === filterStatus) &&
      (!sq || d.name.toLowerCase().includes(sq) || d.individual_address.includes(sq)));
    return (
      <div key={`sp-${node.id}`}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: depth === 0 ? '6px 14px' : `5px 14px 5px ${14 + depth * 18}px`,
          background: depth === 0 ? C.surface : depth === 1 ? C.hover : 'transparent',
          borderBottom: `1px solid ${C.border}`,
          cursor: hasChildren ? 'pointer' : 'default',
        }} onClick={() => hasChildren && toggleCollapse(node.id)}>
          {hasChildren
            ? <span style={{ color: C.dim, fontSize: 9, width: 10 }}>{isCollapsed ? '▸' : '▾'}</span>
            : <span style={{ width: 10 }} />}
          <span style={{ color: depth === 0 ? C.amber : C.dim }} title={node.type}><SpaceTypeIcon type={node.type} size={13} /></span>
          {editSpaceId === node.id ? (
            <InlineEdit initial={node.name} fontSize={depth === 0 ? 11 : 10}
              onSave={async (v) => { await onUpdateSpace(node.id, { name: v }); setEditSpaceId(null); }}
              onCancel={() => setEditSpaceId(null)} C={C} />
          ) : (
            <span
              className={pin ? 'pa' : undefined} data-pin={pin ? '1' : undefined}
              style={{ fontWeight: depth <= 1 ? 600 : 400, fontSize: depth === 0 ? 11 : 10, color: depth === 0 ? C.amber : pin ? C.amber : C.text, cursor: pin ? 'pointer' : 'default' }}
              onClick={pin ? (e) => { e.stopPropagation(); pin('space', String(node.id)); } : undefined}
            >{node.name}</span>
          )}
          {onUpdateSpace && editSpaceId !== node.id && (
            <span onClick={(e) => { e.stopPropagation(); setEditSpaceId(node.id); }}
              title="Rename" style={{ color: C.dim, fontSize: 9, cursor: 'pointer', opacity: 0.5 }} className="bg">edit</span>
          )}
          {node.type === 'Room' && spaceUsageMap()[node.usage_id] && (
            <span style={{ color: C.dim, fontSize: 10, marginLeft: 4 }}>· {i18t(node.usage_id) || spaceUsageMap()[node.usage_id]}</span>
          )}
          {node.type === 'Floor' && dispatch && (
            <span
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'FLOORPLAN_JUMP', spaceId: node.id }); }}
              title="View floor plan"
              style={{ color: C.accent, fontSize: 9, marginLeft: 6, cursor: 'pointer', opacity: 0.7 }}>
              floor plan
            </span>
          )}
          <AddMenu nodeId={node.id} nodeType={node.type} nodeName={node.name} C={C}
            onAddDevice={onAddDevice ? () => setAddDefaults({ space_id: node.id }) : null}
            onAddSpace={onCreateSpace ? () => {
              const childType = node.type === 'Building' ? 'Floor' : node.type === 'Floor' ? 'Room' : 'Room';
              setAddSpaceParent({ parentId: node.id, defaultType: childType });
            } : null}
          />
          {onDeleteSpace && node.devs.length === 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); onDeleteSpace(node.id); }}
              title={`Delete ${node.name}`}
              style={{ color: C.red, fontSize: 13, marginLeft: 4, cursor: 'pointer', opacity: 0.5, lineHeight: 1 }}>
              −
            </span>
          )}
          {(filteredDevs.length > 0 || node.children.length > 0) && (
            <span style={{ fontSize: 10, color: C.dim }}>· {filteredDevs.length + node.children.reduce((s, c) => s + c.devs.length, 0)}</span>
          )}
        </div>
        {addSpaceParent?.parentId === node.id && (
          <AddSpaceForm parentId={node.id} defaultType={addSpaceParent.defaultType} C={C}
            onSave={async (body) => { await onCreateSpace(body); setAddSpaceParent(null); }}
            onCancel={() => setAddSpaceParent(null)} />
        )}
        {!isCollapsed && (
          <>
            {filteredDevs.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  {visibleLocCols.map(col => (
                    <TH key={col.id} style={
                      col.id === 'individual_address' ? { width: 100, paddingLeft: 14 + depth * 18 + 28 } :
                      col.id === 'gas' ? { width: 50 } :
                      col.id === 'status' ? { width: 100 } : {}
                    }>{col.label.toUpperCase().replace('GAS','GAs')}</TH>
                  ))}
                </tr></thead>
                <tbody>
                  {filteredDevs.map(d => (
                    <tr key={d.id} className="rh" style={{ borderLeft: '2px solid transparent' }}>
                      {lcv('individual_address') && <TD style={{ paddingLeft: 14 + depth * 18 + 28 }}>
                        <PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} />
                      </TD>}
                      {lcv('name') && <TD>{editDevId === d.id ? (
                        <InlineEdit initial={d.name} fontSize={11}
                          onSave={async (v) => { await onUpdateDevice(d.id, { name: v }); setEditDevId(null); }}
                          onCancel={() => setEditDevId(null)} C={C} />
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <DeviceTypeIcon type={d.device_type} style={{ color: COLMAP[d.device_type] || C.muted }} />
                          <span onClick={onUpdateDevice ? e => { e.stopPropagation(); setEditDevId(d.id); } : undefined}
                            style={{ cursor: onUpdateDevice ? 'text' : 'default' }}
                            title={onUpdateDevice ? 'Click to rename' : undefined}>{d.name}</span>
                        </span>
                      )}</TD>}
                      {lcv('device_type') && <TD><span style={{ color: C.muted }}>{d.device_type}</span></TD>}
                      {lcv('manufacturer') && <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>}
                      {lcv('model') && <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{localizedModel(d) || '—'}</PinAddr></TD>}
                      {lcv('serial_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.serial_number || '—'}</span></TD>}
                      {lcv('status') && <TD><Badge label={d.status.toUpperCase()} color={STATUS_COLOR[d.status] || C.dim} /></TD>}
                      {lcv('gas') && <TD><span style={{ color: C.dim }}>{(deviceGAMap[d.individual_address] || []).length}</span></TD>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {node.children.map(child => renderSpace(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const unplaced = devices.filter(d => !d.space_id)
    .filter(d => (filterStatus === 'all' || d.status === filterStatus) &&
      (!sq || d.name.toLowerCase().includes(sq) || d.individual_address.includes(sq)));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <SectionHeader title="Locations" count={spaces.length}
        actions={[
          <SearchBox key="s" value={search} onChange={setSearch} placeholder="Search spaces or devices…" />,
          <Chip key="si" active={spaceSort === 'import'} onClick={() => { setSpaceSort('import'); localStorage.setItem('knx-loc-sort', 'import'); }}>Import Order</Chip>,
          <Chip key="sn" active={spaceSort === 'name'} onClick={() => { setSpaceSort('name'); localStorage.setItem('knx-loc-sort', 'name'); }}>By Name</Chip>,
          <ColumnPicker key="cp" cols={locCols} onChange={saveLocCols} C={C} />,
          <Btn key="csv" onClick={exportLocCSV} color={C.muted} bg={C.surface}>↓ CSV</Btn>,
          ...(onCreateSpace ? [<Btn key="add" onClick={() => setAddSpaceParent({ parentId: null, defaultType: 'Building' })} color={C.green} bg={C.surface}>+ Building</Btn>] : []),
        ]} />
      <div style={{ flex: 1, overflow: 'auto' }}>
        {addSpaceParent?.parentId === null && (
          <AddSpaceForm parentId={null} defaultType="Building" C={C}
            onSave={async (body) => { await onCreateSpace(body); setAddSpaceParent(null); }}
            onCancel={() => setAddSpaceParent(null)} />
        )}
        {roots.map(r => renderSpace(r, 0))}
        {unplaced.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 14px', background: C.surface, borderBottom: `1px solid ${C.border}` }}>
              <span style={{ color: C.dim, fontSize: 12 }}>◉</span>
              <span style={{ fontWeight: 600, fontSize: 11, color: C.muted }}>Unplaced</span>
              <span style={{ fontSize: 10, color: C.dim }}>· {unplaced.length}</span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {visibleLocCols.map(col => (
                  <TH key={col.id} style={col.id === 'individual_address' ? { width: 100, paddingLeft: 42 } : col.id === 'gas' ? { width: 50 } : col.id === 'status' ? { width: 100 } : {}}>
                    {col.label.toUpperCase().replace('GAS','GAs')}
                  </TH>
                ))}
              </tr></thead>
              <tbody>
                {unplaced.map(d => (
                  <tr key={d.id} className="rh" style={{ borderLeft: '2px solid transparent' }}>
                    {lcv('individual_address') && <TD style={{ paddingLeft: 42 }}><PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} /></TD>}
                    {lcv('name') && <TD>{editDevId === d.id ? (
                      <InlineEdit initial={d.name} fontSize={11}
                        onSave={async (v) => { await onUpdateDevice(d.id, { name: v }); setEditDevId(null); }}
                        onCancel={() => setEditDevId(null)} C={C} />
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <DeviceTypeIcon type={d.device_type} style={{ color: COLMAP[d.device_type] || C.muted }} />
                        <span onClick={onUpdateDevice ? e => { e.stopPropagation(); setEditDevId(d.id); } : undefined}
                          style={{ cursor: onUpdateDevice ? 'text' : 'default' }}
                          title={onUpdateDevice ? 'Click to rename' : undefined}>{d.name}</span>
                      </span>
                    )}</TD>}
                    {lcv('device_type') && <TD><span style={{ color: C.muted }}>{d.device_type}</span></TD>}
                    {lcv('manufacturer') && <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>}
                    {lcv('model') && <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{d.model || '—'}</PinAddr></TD>}
                    {lcv('serial_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.serial_number || '—'}</span></TD>}
                    {lcv('status') && <TD><Badge label={d.status.toUpperCase()} color={STATUS_COLOR[d.status] || C.dim} /></TD>}
                    {lcv('gas') && <TD><span style={{ color: C.dim }}>{(deviceGAMap[d.individual_address] || []).length}</span></TD>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div style={{ padding: '5px 14px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.dim, display: 'flex', gap: 14, flexShrink: 0 }}>
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span key={s} className="rh" onClick={() => setFilterStatus(p => p === s ? 'all' : s)}
            style={{ cursor: 'pointer', color: filterStatus === s ? c : C.dim, fontWeight: filterStatus === s ? 600 : 400 }}>
            <span style={{ color: c }}>●</span> {devices.filter(d => d.status === s).length} {s}
          </span>
        ))}
      </div>
      {addDefaults && onAddDevice && <AddDeviceModal data={data} defaults={addDefaults} onAdd={onAddDevice} onClose={() => setAddDefaults(null)} />}
    </div>
  );
}

function AddMenu({ nodeId, nodeType, nodeName, C, onAddDevice, onAddSpace }) {
  const [open, setOpen] = useState(false);
  const options = [
    onAddDevice && { label: 'Add device', action: onAddDevice },
    onAddSpace && { label: 'Add space', action: onAddSpace },
  ].filter(Boolean);
  if (options.length === 0) return null;
  if (options.length === 1) {
    return (
      <span onClick={(e) => { e.stopPropagation(); options[0].action(); }}
        title={options[0].label}
        style={{ color: C.green, fontSize: 13, marginLeft: 4, cursor: 'pointer', opacity: 0.7, lineHeight: 1 }}>+</span>
    );
  }
  return (
    <span style={{ position: 'relative', marginLeft: 4 }}>
      <span onClick={(e) => { e.stopPropagation(); setOpen(p => !p); }}
        title="Add…"
        style={{ color: C.green, fontSize: 13, cursor: 'pointer', opacity: 0.7, lineHeight: 1 }}>+</span>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', zIndex: 1000, minWidth: 120, overflow: 'hidden' }}>
            {options.map(o => (
              <div key={o.label} onClick={(e) => { e.stopPropagation(); o.action(); setOpen(false); }}
                className="rh"
                style={{ padding: '6px 12px', fontSize: 10, color: C.text, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                {o.label}
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

const SPACE_TYPES = ['Building', 'Floor', 'Room', 'Corridor', 'Stairway', 'DistributionBoard'];

function AddSpaceForm({ parentId, defaultType, C, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [type, setType] = useState(defaultType || 'Room');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try { await onSave({ name: name.trim(), type, parent_id: parentId }); }
    catch (_) {}
    setSaving(false);
  };
  return (
    <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={type} onChange={e => setType(e.target.value)}
        style={{ background: C.inputBg, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '5px 8px', color: C.text, fontSize: 10, fontFamily: 'inherit' }}>
        {SPACE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
        style={{ background: C.inputBg, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '5px 8px', color: C.text, fontSize: 10, fontFamily: 'inherit', flex: 1, minWidth: 120 }} />
      <Btn onClick={save} disabled={saving || !name.trim()} color={C.green}>{saving ? 'Creating…' : 'Create'}</Btn>
      <Btn onClick={onCancel} color={C.dim}>Cancel</Btn>
    </div>
  );
}

function InlineEdit({ initial, fontSize = 11, onSave, onCancel, C }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!value.trim()) return;
    setSaving(true);
    try { await onSave(value.trim()); } catch (_) {}
    setSaving(false);
  };
  return (
    <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 1 }}>
      <input value={value} onChange={e => setValue(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
        style={{ background: C.inputBg, border: `1px solid ${C.accent}`, borderRadius: 3, padding: '2px 6px', color: C.text, fontSize, fontFamily: 'inherit', flex: 1, minWidth: 80 }} />
      <Btn onClick={save} disabled={saving || !value.trim()} color={C.green}>{saving ? 'Saving' : 'Save'}</Btn>
      <Btn onClick={onCancel} color={C.dim}>Cancel</Btn>
    </div>
  );
}
