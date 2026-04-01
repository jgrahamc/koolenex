import { useState, useEffect, useMemo } from 'react';
import { useC } from '../theme.js';
import { useDpt } from '../contexts.js';
import { localizedModel } from '../dpt.js';
import { Btn, TH, TD, SearchBox, SectionHeader, Empty, PinAddr, coGAs } from '../primitives.jsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.jsx';
import { DeviceTypeIcon } from '../icons.jsx';

export function ComObjectsView({ data }) {
  const C = useC();
  const dpt = useDpt();
  const [search, setSearch] = useState(() => localStorage.getItem('knx-co-search') || '');
  const [filterDevice, setFilterDevice] = useState(() => localStorage.getItem('knx-co-filter-device') || 'all');
  useEffect(() => { try { localStorage.setItem('knx-co-search', search); } catch {} }, [search]);
  useEffect(() => { try { localStorage.setItem('knx-co-filter-device', filterDevice); } catch {} }, [filterDevice]);
  const { comObjects = [], devices = [], gas = [] } = data || {};
  const gaMap = Object.fromEntries(gas.map(g => [g.address, g]));

  const CO_COLS = useMemo(() => [
    { id: 'object_number',  label: '#',          visible: true },
    { id: 'channel',        label: 'Channel',    visible: true },
    { id: 'name',           label: 'Name',       visible: true },
    { id: 'dpt',            label: 'DPT',        visible: true },
    { id: 'object_size',    label: 'Size',       visible: true },
    { id: 'ga_address',     label: 'Group Addr', visible: true },
    { id: 'flags',          label: 'Flags',      visible: true },
    { id: 'direction',      label: 'Dir',        visible: true },
    { id: 'device_name',    label: 'Device Name',visible: false },
    { id: 'function_text',  label: 'Object Function', visible: true },
  ], []);
  const [coCols, saveCoCols] = useColumns('comobjects', CO_COLS);
  const ccv = id => coCols.find(c => c.id === id)?.visible !== false;

  const filtered = comObjects.filter(co => {
    if (filterDevice !== 'all' && co.device_address !== filterDevice) return false;
    const s = search.toLowerCase();
    return !s || co.name?.toLowerCase().includes(s) || co.channel?.toLowerCase().includes(s) || co.ga_address?.includes(s) || co.dpt?.toLowerCase().includes(s) || co.device_address?.includes(s);
  });

  const groupedCOs = useMemo(() => {
    const groups = {};
    const order = [];
    for (const co of filtered) {
      if (!groups[co.device_address]) { groups[co.device_address] = []; order.push(co.device_address); }
      groups[co.device_address].push(co);
    }
    return order.map(addr => ({ addr, cos: groups[addr] }));
  }, [filtered]);
  const devMap2 = useMemo(() => Object.fromEntries(devices.map(d => [d.individual_address, d])), [devices]);
  const [collapsedDevs, setCollapsedDevs] = useState({});

  const exportCOCSV = () => dlCSV('koolenex-comobjects.csv', coCols, filtered,
    (id, co) => ({
      device_address: co.device_address, object_number: co.object_number,
      channel: co.channel, name: co.name || '',
      dpt: co.dpt, object_size: co.object_size,
      ga_address: coGAs(co).join('; '),
      flags: co.flags, direction: co.direction,
      device_name: co.device_name, function_text: co.function_text,
    })[id] ?? ''
  );

  const flagColor = f => f === 'T' ? C.green : f === 'W' ? C.accent : f === 'R' ? C.amber : C.muted;
  const dirCol = d => d === 'output' ? C.green : d === 'input' ? C.amber : C.muted;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <SectionHeader title="Group Objects" count={filtered.length} actions={[
        <SearchBox key="s" value={search} onChange={setSearch} placeholder="Search objects…" />,
        <select key="dev" value={filterDevice} onChange={e => setFilterDevice(e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '5px 8px', color: C.text, fontSize: 11, fontFamily: 'inherit' }}>
          <option value="all">All Devices</option>
          {devices.map(d => <option key={d.id} value={d.individual_address}>{d.individual_address} — {d.name}</option>)}
        </select>,
        <ColumnPicker key="cp" cols={coCols} onChange={saveCoCols} C={C} />,
        <Btn key="csv" onClick={exportCOCSV} color={C.muted} bg={C.surface}>↓ CSV</Btn>,
      ]} />
      <div style={{ overflow: 'auto', flex: 1 }}>
        {groupedCOs.map(({ addr, cos }) => {
          const dev = devMap2[addr];
          const isCollapsed = !!collapsedDevs[addr];
          return (
            <div key={`dev-${addr}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px 5px 28px', background: C.hover, borderBottom: `1px solid ${C.border}` }}>
                <span onClick={e => { e.stopPropagation(); setCollapsedDevs(p => ({ ...p, [addr]: !p[addr] })); }}
                  style={{ fontSize: 9, color: C.dim, width: 14, cursor: 'pointer', userSelect: 'none' }}>{isCollapsed ? '▸' : '▾'}</span>
                <PinAddr address={addr} wtype="device" style={{ color: C.accent, fontFamily: 'monospace', fontSize: 10 }} />
                {dev && <>
                  <DeviceTypeIcon type={dev.device_type} size={12} style={{ color: C.muted }} />
                  <span style={{ color: C.text, fontSize: 10 }}>{dev.name}</span>
                  {dev.manufacturer && <PinAddr address={dev.manufacturer} wtype="manufacturer" style={{ color: C.amber, fontSize: 10 }}>{dev.manufacturer}</PinAddr>}
                  {dev.model && <PinAddr address={dev.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{localizedModel(dev)}</PinAddr>}
                </>}
                <span style={{ color: C.dim, fontSize: 10 }}>· {cos.length}</span>
              </div>
              {!isCollapsed && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    {coCols.filter(c => c.visible !== false).map(col => (
                      <TH key={col.id} style={
                        col.id === 'object_number' ? { width: 40 } :
                        col.id === 'channel' ? { width: 70 } :
                        col.id === 'dpt' ? { width: 130 } :
                        col.id === 'object_size' ? { width: 70, whiteSpace: 'nowrap' } :
                        col.id === 'ga_address' ? { width: 90 } :
                        col.id === 'flags' ? { width: 70 } :
                        col.id === 'direction' ? { width: 70 } : {}
                      }>{col.label.toUpperCase().replace('GAS','GAs')}</TH>
                    ))}
                  </tr></thead>
                  <tbody>
                    {cos.map(co => (
                      <tr key={co.id} className="rh">
                        {ccv('object_number') && <TD><span style={{ color: C.dim }}>{co.object_number}</span></TD>}
                        {ccv('channel') && <TD><span style={{ color: C.accent, fontSize: 10, fontFamily: 'monospace' }}>{co.channel || '—'}</span></TD>}
                        {ccv('name') && <TD><span>{co.name || '—'}</span></TD>}
                        {ccv('dpt') && <TD><span style={{ color: C.muted, fontSize: 10, fontFamily: 'monospace' }} title={dpt.hover(co.dpt || coGAs(co).map(a => gaMap[a]?.dpt).find(Boolean))}>{dpt.display(co.dpt || coGAs(co).map(a => gaMap[a]?.dpt).find(Boolean))}</span></TD>}
                        {ccv('object_size') && <TD><span style={{ color: C.dim, fontSize: 10, whiteSpace: 'nowrap' }}>{co.object_size || '—'}</span></TD>}
                        {ccv('ga_address') && <TD>{coGAs(co).length ? <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{coGAs(co).map(ga => <PinAddr key={ga} address={ga} wtype="ga" style={{ color: C.purple, fontFamily: 'monospace' }} />)}</span> : <span style={{ color: C.dim }}>—</span>}</TD>}
                        {ccv('flags') && <TD><span style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: '0.05em' }}>{(co.flags || '').split('').map((f, fi) => <span key={fi} style={{ color: flagColor(f) }}>{f}</span>)}</span></TD>}
                        {ccv('direction') && <TD><span style={{ color: dirCol(co.direction), fontSize: 10 }}>{co.direction === 'output' ? '↑ Out' : co.direction === 'input' ? '↓ In' : '⇅ Both'}</span></TD>}
                        {ccv('device_name') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{co.device_name || '—'}</span></TD>}
                        {ccv('function_text') && <TD><span style={{ color: C.dim, fontSize: 10 }}>{co.function_text || '—'}</span></TD>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <Empty icon="⇅" msg="No group objects" />}
      </div>
      <div style={{ padding: '5px 14px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.dim }}>
        Flags: <span style={{ color: C.muted }}>C=Communication · R=Read · W=Write · T=Transmit · U=Update</span>
      </div>
    </div>
  );
}
