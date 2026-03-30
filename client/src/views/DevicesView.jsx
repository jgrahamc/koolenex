import { useState, useEffect, useMemo } from 'react';
import { useC, STATUS_COLOR } from '../theme.js';
import { localizedModel } from '../dpt.js';
import { Badge, Chip, Btn, TH, TD, SearchBox, SectionHeader, Empty, PinAddr, SpacePath } from '../primitives.jsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.jsx';
import { RtfText } from '../rtf.jsx';
import { AddDeviceModal } from '../AddDeviceModal.jsx';

export function DevicesView({ data, onDeviceStatus, jumpTo, onPin, onAddDevice }) {
  const C = useC();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(() => { try { return JSON.parse(localStorage.getItem('knx-devices-sort')) || { col: 'individual_address', dir: 1 }; } catch { return { col: 'individual_address', dir: 1 }; } });
  useEffect(() => { try { localStorage.setItem('knx-devices-sort', JSON.stringify(sort)); } catch {} }, [sort]);
  const [filterStatus, setFilterStatus] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const { devices = [], gas = [], deviceGAMap = {}, spaces = [] } = data || {};

  const DEV_COLS = useMemo(() => [
    { id: 'individual_address', label: 'Address',      visible: true },
    { id: 'name',               label: 'Name',         visible: true },
    { id: 'device_type',        label: 'Type',         visible: true },
    { id: 'location',           label: 'Location',     visible: true },
    { id: 'manufacturer',       label: 'Manufacturer', visible: true },
    { id: 'model',              label: 'Model',        visible: true },
    { id: 'order_number',       label: 'Order #',      visible: false },
    { id: 'serial_number',      label: 'Serial',       visible: true },
    { id: 'status',             label: 'Status',       visible: true },
    { id: 'gas',                label: 'GAs',          visible: true },
    { id: 'description',        label: 'Description',  visible: false },
    { id: 'comment',            label: 'Comment',      visible: false },
    { id: 'area',               label: 'Area',         visible: false },
    { id: 'line',               label: 'Line',         visible: false },
    { id: 'last_download',      label: 'Last Download',visible: false },
  ], []);
  const [cols, saveCols] = useColumns('devices', DEV_COLS);
  const cv = id => cols.find(c => c.id === id)?.visible !== false;

  const spaceMap = useMemo(() => Object.fromEntries(spaces.map(s => [s.id, s])), [spaces]);
  const spacePath = (spaceId) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) { if (cur.type !== 'Building') parts.unshift(cur.name); cur = cur.parent_id ? spaceMap[cur.parent_id] : null; }
    return parts.join(' › ');
  };

  useEffect(() => {
    if (!jumpTo) return;
    const d = devices.find(d => d.individual_address === jumpTo.address);
    if (d) { onPin?.('device', d.individual_address); setSearch(''); setFilterStatus('all'); }
  }, [jumpTo]);

  const cmpAddr = (x, y) => {
    const p = s => s.split(/[./]/).map(Number);
    const [ax, bx] = [p(x), p(y)];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      const d = (ax[i] ?? 0) - (bx[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const filtered = devices.filter(d => {
    if (filterStatus !== 'all' && d.status !== filterStatus) return false;
    const s = search.toLowerCase();
    if (!s) return true;
    const gaCount = String((deviceGAMap[d.individual_address] || []).length);
    const space = spacePath(d.space_id);
    return d.name.toLowerCase().includes(s)
        || d.individual_address.includes(s)
        || d.manufacturer?.toLowerCase().includes(s)
        || d.model?.toLowerCase().includes(s)
        || d.serial_number?.toLowerCase().includes(s)
        || d.order_number?.toLowerCase().includes(s)
        || d.description?.toLowerCase().includes(s)
        || d.device_type?.toLowerCase().includes(s)
        || d.status?.toLowerCase().includes(s)
        || space.toLowerCase().includes(s)
        || gaCount === s;
  }).sort((a, b) => {
    if (sort.col === 'individual_address') return cmpAddr(a.individual_address, b.individual_address) * sort.dir;
    return String(a[sort.col] ?? '').localeCompare(String(b[sort.col] ?? '')) * sort.dir;
  });

  const [groupMode, setGroupMode] = useState(false);
  const [groupExpanded, setGroupExpanded] = useState({});
  const groupTree = useMemo(() => {
    if (!groupMode) return null;
    const mfrs = {};
    for (const d of filtered) {
      const mfr = d.manufacturer || '(Unknown)';
      const mdl = d.model || '(Unknown)';
      if (!mfrs[mfr]) mfrs[mfr] = {};
      if (!mfrs[mfr][mdl]) mfrs[mfr][mdl] = [];
      mfrs[mfr][mdl].push(d);
    }
    return Object.entries(mfrs).sort(([a],[b]) => a.localeCompare(b))
      .map(([mfr, models]) => ({
        name: mfr,
        models: Object.entries(models).sort(([a],[b]) => a.localeCompare(b))
          .map(([mdl, devs]) => ({ name: mdl, devices: devs })),
      }));
  }, [groupMode, filtered]);
  const isGrpOpen = key => groupExpanded[key] !== false;
  const toggleGrp = (key, e) => { e.stopPropagation(); setGroupExpanded(p => ({ ...p, [key]: !p[key] })); };

  const exportDevCSV = () => dlCSV(
    'koolenex-devices.csv', cols, filtered,
    (id, d) => ({
      individual_address: d.individual_address,
      name: d.name, device_type: d.device_type,
      location: spacePath(d.space_id),
      manufacturer: d.manufacturer, model: d.model,
      order_number: d.order_number, serial_number: d.serial_number,
      status: d.status,
      gas: (deviceGAMap[d.individual_address] || []).length,
      description: d.description, comment: d.comment || '', area: d.area, line: d.line,
      last_download: d.last_download,
    })[id] ?? ''
  );

  const sortBy = col => setSort(s => ({ col, dir: s.col === col ? -s.dir : 1 }));
  const SortTH = ({ col, children, ...rest }) => (
    <TH {...rest}><span onClick={() => sortBy(col)} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
      {children}{sort.col === col && <span style={{ color: C.accent }}>{sort.dir > 0 ? '↑' : '↓'}</span>}
    </span></TH>
  );

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <SectionHeader title="Devices" count={filtered.length} actions={[
          <SearchBox key="s" value={search} onChange={setSearch} placeholder="Search devices…" />,
          ...['all', 'programmed', 'modified', 'unassigned'].map(s => (
            <Chip key={s} active={filterStatus === s} onClick={() => setFilterStatus(s)}>
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </Chip>
          )),
          <ColumnPicker key="cp" cols={cols} onChange={saveCols} C={C} />,
          <Btn key="grp" onClick={() => setGroupMode(g => !g)} color={groupMode ? C.accent : C.muted} bg={C.surface}>{groupMode ? '⊞ Grouped' : '⊞ Group'}</Btn>,
          <Btn key="csv" onClick={exportDevCSV} color={C.muted} bg={C.surface}>↓ CSV</Btn>,
          ...(onAddDevice ? [<Btn key="add" onClick={() => setShowAdd(true)} color={C.green} bg={C.surface}>+ Add</Btn>] : []),
        ]} />
        <div style={{ overflow: 'auto', flex: 1 }}>
          {groupMode ? (
            <div>
              {(groupTree || []).map(mfr => {
                const mfrKey = `m:${mfr.name}`;
                const mfrOpen = isGrpOpen(mfrKey);
                const mfrTotal = mfr.models.reduce((s, m) => s + m.devices.length, 0);
                return (
                  <div key={mfrKey}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: C.surface, borderBottom: `1px solid ${C.border}` }}>
                      <span onClick={e => toggleGrp(mfrKey, e)} style={{ fontSize: 9, color: C.dim, width: 14, cursor: 'pointer', userSelect: 'none' }}>{mfrOpen ? '▾' : '▸'}</span>
                      <PinAddr address={mfr.name} wtype="manufacturer" style={{ color: C.amber, fontSize: 11, fontWeight: 600 }}>{mfr.name}</PinAddr>
                      <span style={{ color: C.dim, fontSize: 10 }}>· {mfrTotal} devices · {mfr.models.length} models</span>
                    </div>
                    {mfrOpen && mfr.models.map(mdl => {
                      const mdlKey = `m:${mfr.name}:${mdl.name}`;
                      const mdlOpen = isGrpOpen(mdlKey);
                      return (
                        <div key={mdlKey}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px 5px 28px', background: C.hover, borderBottom: `1px solid ${C.border}` }}>
                            <span onClick={e => toggleGrp(mdlKey, e)} style={{ fontSize: 9, color: C.dim, width: 14, cursor: 'pointer', userSelect: 'none' }}>{mdlOpen ? '▾' : '▸'}</span>
                            <PinAddr address={mdl.name} wtype="model" style={{ color: C.text, fontSize: 10, fontFamily: 'monospace' }}>{mdl.name}</PinAddr>
                            <span style={{ color: C.dim, fontSize: 10 }}>· {mdl.devices.length}</span>
                          </div>
                          {mdlOpen && (
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead><tr>
                                {cols.filter(c => c.visible !== false).map(col => {
                                  if (col.id === 'individual_address') return <TH key={col.id} style={{ width: 100, paddingLeft: 42 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  if (col.id === 'device_type') return <TH key={col.id} style={{ width: 90 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  if (col.id === 'location') return spaces.length > 0 ? <TH key={col.id}>{col.label.toUpperCase().replace('GAS','GAs')}</TH> : null;
                                  if (col.id === 'manufacturer') return <TH key={col.id} style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  if (col.id === 'model') return <TH key={col.id} style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  if (col.id === 'serial_number') return <TH key={col.id} style={{ width: 130 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  if (col.id === 'status') return <TH key={col.id} style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                  return <TH key={col.id} style={col.id === 'gas' ? { width: 50 } : {}}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                                })}
                              </tr></thead>
                              <tbody>
                                {mdl.devices.map(d => (
                                  <tr key={d.id} className="rh" onClick={() => onPin?.('device', d.individual_address)} style={{ borderLeft: '2px solid transparent', cursor: 'pointer' }}>
                                    {cv('individual_address') && <TD style={{ paddingLeft: 42 }}><PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} /></TD>}
                                    {cv('name') && <TD>{d.name}</TD>}
                                    {cv('device_type') && <TD><span style={{ color: C.muted }}>{d.device_type}</span></TD>}
                                    {cv('location') && spaces.length > 0 && <TD><SpacePath spaceId={d.space_id} spaces={spaces} style={{ color: C.dim, fontSize: 10 }} /></TD>}
                                    {cv('manufacturer') && <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>}
                                    {cv('model') && <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{localizedModel(d) || '—'}</PinAddr></TD>}
                                    {cv('order_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.order_number || '—'}</span></TD>}
                                    {cv('serial_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.serial_number || '—'}</span></TD>}
                                    {cv('status') && <TD><Badge label={d.status.toUpperCase()} color={STATUS_COLOR[d.status] || C.dim} /></TD>}
                                    {cv('gas') && <TD><span style={{ color: C.dim }}>{(deviceGAMap[d.individual_address] || []).length}</span></TD>}
                                    {cv('description') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{d.description && d.description !== d.name ? d.description : ''}</span></TD>}
                                    {cv('comment') && <TD><span style={{ color: C.dim, fontSize: 10 }}><RtfText value={d.comment} /></span></TD>}
                                    {cv('area') && <TD><span style={{ color: C.dim }}>{d.area}</span></TD>}
                                    {cv('line') && <TD><span style={{ color: C.dim }}>{d.line}</span></TD>}
                                    {cv('last_download') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{d.last_download || '—'}</span></TD>}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                {cols.filter(c => c.visible !== false).map(col => {
                  if (col.id === 'individual_address') return <SortTH key={col.id} col="individual_address" style={{ width: 100 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'name') return <SortTH key={col.id} col="name">{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'device_type') return <SortTH key={col.id} col="device_type" style={{ width: 90 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'location') return spaces.length > 0 ? <TH key={col.id}>{col.label.toUpperCase().replace('GAS','GAs')}</TH> : null;
                  if (col.id === 'manufacturer') return <SortTH key={col.id} col="manufacturer" style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'model') return <SortTH key={col.id} col="model" style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'serial_number') return <SortTH key={col.id} col="serial_number" style={{ width: 130 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  if (col.id === 'status') return <SortTH key={col.id} col="status" style={{ width: 110 }}>{col.label.toUpperCase().replace('GAS','GAs')}</SortTH>;
                  return <TH key={col.id} style={col.id === 'gas' ? { width: 50 } : {}}>{col.label.toUpperCase().replace('GAS','GAs')}</TH>;
                })}
              </tr></thead>
              <tbody>
                {filtered.map(d => (
                  <tr key={d.id} className="rh"
                    onClick={() => onPin?.('device', d.individual_address)}
                    style={{ borderLeft: '2px solid transparent', cursor: 'pointer' }}>
                    {cv('individual_address') && <TD><PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} /></TD>}
                    {cv('name') && <TD>{d.name}</TD>}
                    {cv('device_type') && <TD><span style={{ color: C.muted }}>{d.device_type}</span></TD>}
                    {cv('location') && spaces.length > 0 && <TD><SpacePath spaceId={d.space_id} spaces={spaces} style={{ color: C.dim, fontSize: 10 }} /></TD>}
                    {cv('manufacturer') && <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>}
                    {cv('model') && <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{localizedModel(d) || '—'}</PinAddr></TD>}
                    {cv('order_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.order_number || '—'}</span></TD>}
                    {cv('serial_number') && <TD><span style={{ color: C.dim, fontFamily: 'monospace', fontSize: 10 }}>{d.serial_number || '—'}</span></TD>}
                    {cv('status') && <TD><Badge label={d.status.toUpperCase()} color={STATUS_COLOR[d.status] || C.dim} /></TD>}
                    {cv('gas') && <TD><span style={{ color: C.dim }}>{(deviceGAMap[d.individual_address] || []).length}</span></TD>}
                    {cv('description') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{d.description && d.description !== d.name ? d.description : ''}</span></TD>}
                                    {cv('comment') && <TD><span style={{ color: C.dim, fontSize: 10 }}><RtfText value={d.comment} /></span></TD>}
                    {cv('area') && <TD><span style={{ color: C.dim }}>{d.area}</span></TD>}
                    {cv('line') && <TD><span style={{ color: C.dim }}>{d.line}</span></TD>}
                    {cv('last_download') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{d.last_download || '—'}</span></TD>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {filtered.length === 0 && <Empty msg="No devices match" />}
        </div>
        <div style={{ padding: '5px 14px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.dim, display: 'flex', gap: 14 }}>
          {Object.entries(STATUS_COLOR).map(([s, c]) => (
            <span key={s} className="rh" onClick={() => setFilterStatus(p => p === s ? 'all' : s)}
              style={{ cursor: 'pointer', color: filterStatus === s ? c : C.dim, fontWeight: filterStatus === s ? 600 : 400 }}>
              <span style={{ color: c }}>●</span> {devices.filter(d => d.status === s).length} {s}
            </span>
          ))}
        </div>
      </div>
      {showAdd && onAddDevice && <AddDeviceModal data={data} defaults={{}} onAdd={onAddDevice} onClose={() => setShowAdd(false)} />}
    </div>
  );
}
