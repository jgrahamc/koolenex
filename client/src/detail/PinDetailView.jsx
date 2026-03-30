import { useState, useRef, useCallback, useEffect } from 'react';
import { useC } from '../theme.js';
import { localizedModel } from '../dpt.js';
import { Empty, Btn, TH, TD, PinAddr, SpacePath } from '../primitives.jsx';
import { SpaceTypeIcon } from '../icons.jsx';
import { GROUP_WTYPES } from '../state.js';
import { AddDeviceModal } from '../AddDeviceModal.jsx';
import { ComparePanel } from './ComparePanel.jsx';
import { DevicePinPanel } from './DevicePinPanel.jsx';
import { GAPinPanel } from './GAPinPanel.jsx';

function SpacePanel({ spaceId, data, C }) {
  const { devices = [], spaces = [] } = data;
  const spaceMap = Object.fromEntries(spaces.map(s => [s.id, s]));
  const space = spaceMap[parseInt(spaceId)];
  if (!space) return <Empty icon="◈" msg="Space not found" />;
  const getDescendants = (id) => {
    const children = spaces.filter(s => s.parent_id === id);
    return [id, ...children.flatMap(c => getDescendants(c.id))];
  };
  const spaceIds = new Set(getDescendants(parseInt(spaceId)));
  const matches = devices.filter(d => spaceIds.has(d.space_id));
  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ color: C.amber }}><SpaceTypeIcon type={space.type} size={22} /></span>
          <span style={{ fontSize: 9, color: C.amber, letterSpacing: '0.1em' }}>{space.type?.toUpperCase()}</span>
        </div>
        <div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, fontSize: 20, color: C.text }}>{space.name}</div>
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{matches.length} device{matches.length !== 1 ? 's' : ''}</div>
      </div>
      {matches.length === 0 ? <Empty icon="◈" msg="No devices in this space" /> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead><tr>
            <TH style={{ width: 80 }}>ADDRESS</TH>
            <TH>NAME</TH>
            <TH>MANUFACTURER</TH>
            <TH>MODEL</TH>
            <TH>LOCATION</TH>
          </tr></thead>
          <tbody>
            {matches.map(d => (
              <tr key={d.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <TD><PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} /></TD>
                <TD><span style={{ color: C.text }}>{d.name}</span></TD>
                <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>
                <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace' }}>{localizedModel(d) || '—'}</PinAddr></TD>
                <TD><SpacePath spaceId={d.space_id} spaces={spaces} style={{ color: C.dim, fontSize: 10 }} /></TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeviceGroupPanel({ wtype, value, data, C, onAddDevice }) {
  const { devices = [], spaces = [] } = data;
  const { label } = GROUP_WTYPES[wtype];
  const [showAdd, setShowAdd] = useState(false);
  const spaceMap = Object.fromEntries(spaces.map(s => [s.id, s]));
  const spacePath = id => { const p = []; let c = spaceMap[id]; while (c) { if (c.type !== 'Building') p.unshift(c.name); c = c.parent_id ? spaceMap[c.parent_id] : null; } return p.join(' › '); };
  const field = GROUP_WTYPES[wtype].field;
  const matches = devices.filter(d => d[field] === value);

  // Decide which extra columns to show
  const showMfr   = field !== 'manufacturer';
  const showModel = field !== 'model';
  const showOrder = field !== 'order_number';

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 9, color: C.amber, letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
        <div style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, fontSize: 20, color: C.text }}>{value}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 11, color: C.dim }}>{matches.length} device{matches.length !== 1 ? 's' : ''}</span>
          {onAddDevice && (
            <Btn onClick={() => setShowAdd(true)} color={C.green} style={{ fontSize: 9, padding: '2px 8px' }}>+ Add</Btn>
          )}
        </div>
      </div>
      {showAdd && onAddDevice && <AddDeviceModal data={data}
        defaults={wtype === 'model' ? { model: value, manufacturer: matches[0]?.manufacturer } : wtype === 'manufacturer' ? { manufacturer: value } : {}}
        onAdd={onAddDevice} onClose={() => setShowAdd(false)} />}
      {matches.length === 0 ? <Empty icon="◈" msg="No matching devices" /> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead><tr>
            <TH style={{ width: 80 }}>ADDRESS</TH>
            <TH>NAME</TH>
            {showMfr   && <TH>MANUFACTURER</TH>}
            {showModel && <TH>MODEL</TH>}
            {showOrder && <TH>ORDER #</TH>}
            <TH>LOCATION</TH>
            <TH style={{ width: 50 }}>mA</TH>
            <TH style={{ width: 50 }}>mm</TH>
          </tr></thead>
          <tbody>
            {matches.map(d => (
              <tr key={d.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <TD><PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace' }} /></TD>
                <TD><span style={{ color: C.text }}>{d.name}</span></TD>
                {showMfr   && <TD><PinAddr address={d.manufacturer} wtype="manufacturer" style={{ color: C.amber }}>{d.manufacturer || '—'}</PinAddr></TD>}
                {showModel && <TD><PinAddr address={d.model} wtype="model" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{localizedModel(d) || '—'}</PinAddr></TD>}
                {showOrder && <TD><PinAddr address={d.order_number} wtype="order_number" style={{ color: C.amber, fontFamily: 'monospace', fontSize: 10 }}>{d.order_number || '—'}</PinAddr></TD>}
                <TD><SpacePath spaceId={d.space_id} spaces={data.spaces} style={{ color: C.dim, fontSize: 10 }} /></TD>
                <TD><span style={{ color: C.dim, fontFamily: 'monospace' }}>{d.bus_current || '—'}</span></TD>
                <TD><span style={{ color: C.dim, fontFamily: 'monospace' }}>{d.width_mm || '—'}</span></TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PinDetailView({ pinKey, data, busStatus, telegrams = [], onWrite, activeProjectId, onUpdateGA, onUpdateDevice, onGroupJump, onAddDevice, onUpdateComObjectGAs }) {
  const C = useC();
  const COLMAP = { actuator: C.actuator, sensor: C.sensor, router: C.router, generic: C.muted };
  const scrollRef = useRef(null);
  const savedScrolls = useRef({});

  // Save scroll position whenever user scrolls
  const onScroll = useCallback(() => {
    if (scrollRef.current && pinKey) savedScrolls.current[pinKey] = scrollRef.current.scrollTop;
  }, [pinKey]);

  // Restore scroll position when pinKey changes (back/forward navigation)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = savedScrolls.current[pinKey] || 0;
  }, [pinKey]);

  if (!pinKey || !data) return <Empty icon="◈" msg="Select a pinned item from the sidebar" />;

  const [wtype, address] = pinKey.split(':');
  const { devices = [], gas = [], comObjects = [], deviceGAMap = {}, gaDeviceMap = {}, spaces = [] } = data;
  const spaceMap = Object.fromEntries(spaces.map(s => [s.id, s]));
  const spacePath = id => { const p = []; let c = spaceMap[id]; while (c) { if (c.type !== 'Building') p.unshift(c.name); c = c.parent_id ? spaceMap[c.parent_id] : null; } return p.join(' › '); };
  const gaMap = Object.fromEntries(gas.map(g => [g.address, g]));
  const busConnected = busStatus?.connected;
  const devMap = Object.fromEntries(devices.map(d => [d.individual_address, d]));

  let content;
  if (wtype === 'space') {
    content = <SpacePanel spaceId={address} data={data} C={C} />;
  } else if (GROUP_WTYPES[wtype]) {
    content = <DeviceGroupPanel wtype={wtype} value={address} data={data} C={C} onAddDevice={onAddDevice} />;
  } else if (wtype === 'compare') {
    const [addrA, addrB] = address.split('|');
    content = <ComparePanel addrA={addrA} addrB={addrB} data={data} C={C} />;
  } else if (wtype === 'device') {
    const dev = devices.find(d => d.individual_address === address);
    if (!dev) content = <Empty icon="◈" msg="Device not found" />;
    else {
      const devCOs = comObjects.filter(co => co.device_address === address);
      const linkedGAs = (deviceGAMap[address] || []).map(a => gas.find(g => g.address === a)).filter(Boolean);
      const devTelegrams = telegrams.filter(t => t.src === address || t.dst === address);
      content = (
        <DevicePinPanel C={C} COLMAP={COLMAP} dev={dev} devCOs={devCOs} linkedGAs={linkedGAs}
          spacePath={spacePath} gaMap={gaMap} devMap={devMap} spaces={spaces} allDevices={devices}
          gaDeviceMap={gaDeviceMap} allCOs={comObjects}
          busConnected={busConnected} devTelegrams={devTelegrams} onUpdateDevice={onUpdateDevice}
          onAddDevice={onAddDevice} onUpdateComObjectGAs={onUpdateComObjectGAs} activeProjectId={activeProjectId} />
      );
    }
  } else {
    const ga = gas.find(g => g.address === address);
    if (!ga) content = <Empty icon="◆" msg="Group address not found" />;
    else {
      const linkedDevices = (gaDeviceMap[address] || []).map(a => devices.find(d => d.individual_address === a)).filter(Boolean);
      const gaTelegrams = telegrams.filter(t => t.dst === address || t.src === address);
      content = (
        <GAPinPanel C={C} COLMAP={COLMAP} ga={ga} linkedDevices={linkedDevices}
          busConnected={busConnected} gaTelegrams={gaTelegrams}
          gaMap={gaMap} devMap={devMap} spaces={spaces} allCOs={comObjects}
          onWrite={onWrite} activeProjectId={activeProjectId} onUpdateGA={onUpdateGA}
          onGroupJump={onGroupJump} />
      );
    }
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflow: 'auto' }}>
      {content}
    </div>
  );
}
