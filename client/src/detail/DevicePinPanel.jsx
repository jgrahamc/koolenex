import { useState, useEffect, useContext, useMemo } from 'react';
import { PinContext, useDpt } from '../contexts.js';
import { localizedModel } from '../dpt.js';
import { Badge, Btn, Spinner, TabBar, TH, TD, PinAddr, SpacePath, coGAs } from '../primitives.jsx';
import { STATUS_COLOR, MaskCtx } from '../theme.js';
import { DeviceTypeIcon } from '../icons.jsx';
import { DeviceNetworkDiagram } from '../diagram.jsx';
import { DeviceParameters } from './DeviceParameters.jsx';
import { PinTelegramFeed } from './PinTelegramFeed.jsx';
import { api } from '../api.js';
import { RtfText, EditableRtfField } from '../rtf.jsx';
import { AddDeviceModal } from '../AddDeviceModal.jsx';

export function DevicePinPanel({ C, COLMAP, dev, devCOs, linkedGAs, spacePath, gaMap, devMap, spaces, allDevices, gaDeviceMap, allCOs, busConnected, devTelegrams, onUpdateDevice, onAddDevice, onUpdateComObjectGAs, activeProjectId }) {
  const pin = useContext(PinContext);
  const dpt = useDpt();
  const maskVersions = useContext(MaskCtx);
  const [reachability, setReachability] = useState(null);
  const [identifying, setIdentifying] = useState(false);
  const [busInfo, setBusInfo] = useState(null);
  const [readingInfo, setReadingInfo] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [editName, setEditName] = useState(dev.name);
  const [editType, setEditType] = useState(dev.device_type || 'generic');
  const [saving, setSaving] = useState(false);

  const [devTab, setDevTab] = useState(() => localStorage.getItem('knx-pin-tab-device') || 'overview');
  const handleDevTab = (t) => { setDevTab(t); localStorage.setItem('knx-pin-tab-device', t); };

  const devAddr = dev.individual_address;
  useEffect(() => { setReachability(null); setIdentifying(false); setEditing(false); setBusInfo(null); setReadingInfo(false); }, [devAddr]);

  const handleSave = async () => {
    if (!editName.trim() || !onUpdateDevice) return;
    setSaving(true);
    try { await onUpdateDevice(dev.id, { name: editName.trim(), device_type: editType }); setEditing(false); }
    catch (e) { console.error(e); }
    setSaving(false);
  };

  const handlePing = async () => {
    setReachability('checking');
    try {
      const gaAddresses = linkedGAs.map(g => g.address);
      const result = await api.busPing(gaAddresses, devAddr);
      setReachability(result.reachable ? 'reachable' : 'unreachable');
    } catch (_) {
      setReachability('unreachable');
    }
  };

  const handleIdentify = async () => {
    setIdentifying(true);
    try { await api.busIdentify(devAddr); } catch (_) {}
    setIdentifying(false);
  };

  const handleReadInfo = async () => {
    setReadingInfo(true);
    try {
      const info = await api.busDeviceInfo(devAddr);
      setBusInfo(info);
    } catch (e) { console.error(e); setBusInfo({ error: 'Failed to read device info' }); }
    setReadingInfo(false);
  };

  const reachColor = reachability === 'reachable' ? C.green : reachability === 'unreachable' ? C.red : C.dim;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ width: '100%' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <DeviceTypeIcon type={editing ? editType : dev.device_type} size={28} style={{ color: COLMAP[editing ? editType : dev.device_type] || C.muted }} />
          <div style={{ flex: 1 }}>
            <div onClick={pin ? () => pin('device', dev.individual_address) : undefined} style={{ fontFamily: "'DM Mono',monospace", fontWeight: 700, fontSize: 20, color: C.text, cursor: pin ? 'pointer' : 'default' }}>{dev.individual_address}</div>
            {editing ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
                  style={{ background: C.inputBg, border: `1px solid ${C.accent}`, borderRadius: 4, padding: '4px 8px', color: C.text, fontSize: 12, fontFamily: 'monospace', flex: 1, minWidth: 120 }} />
                <select value={editType} onChange={e => setEditType(e.target.value)}
                  style={{ background: C.inputBg, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '4px 8px', color: C.text, fontSize: 11, fontFamily: 'inherit' }}>
                  {['generic','actuator','sensor','router'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <Btn onClick={handleSave} disabled={saving || !editName.trim()} color={C.green}>{saving ? <Spinner /> : 'Save'}</Btn>
                <Btn onClick={() => setEditing(false)} color={C.dim}>Cancel</Btn>
              </div>
            ) : (
              <div onClick={onUpdateDevice ? () => { setEditName(dev.name); setEditType(dev.device_type || 'generic'); setEditing(true); } : undefined}
                style={{ fontSize: 12, color: C.muted, marginTop: 2, cursor: onUpdateDevice ? 'pointer' : 'default' }}
                title={onUpdateDevice ? 'Click to edit' : undefined}>{dev.name}</div>
            )}
            {dev.space_id && <div style={{ fontSize: 10, marginTop: 2 }}><SpacePath spaceId={dev.space_id} spaces={spaces} style={{ color: C.dim }} /></div>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Badge label={dev.status?.toUpperCase()} color={STATUS_COLOR[dev.status] || C.dim} />
            {busConnected && <>
              {reachability !== null && (
                <Badge label={reachability === 'checking' ? 'PINGING…' : reachability === 'reachable' ? 'REACHABLE' : 'NO RESPONSE'} color={reachColor} />
              )}
              <span onClick={reachability !== 'checking' ? handlePing : undefined}
                title="Ping device"
                style={{ fontSize: 9, padding: '2px 6px', borderRadius: 10, background: `${C.accent}18`, color: C.accent, border: `1px solid ${C.accent}30`, letterSpacing: '0.06em', whiteSpace: 'nowrap', cursor: reachability !== 'checking' ? 'pointer' : 'default' }}
                className="bg">PING</span>
              <span onClick={!identifying ? handleIdentify : undefined}
                title="Flash device LED"
                style={{ fontSize: 9, padding: '2px 6px', borderRadius: 10, background: `${C.amber}18`, color: C.amber, border: `1px solid ${C.amber}30`, letterSpacing: '0.06em', whiteSpace: 'nowrap', cursor: !identifying ? 'pointer' : 'default' }}
                className="bg">{identifying ?<><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: C.amber, boxShadow: `0 0 6px 2px ${C.amber}`, marginRight: 5, animation: 'pulse 0.5s ease-in-out infinite alternate' }} />IDENTIFYING…</> : <><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: `${C.amber}55`, border: `1px solid ${C.amber}40`, marginRight: 5 }} />IDENTIFY</>}</span>
              <span onClick={!readingInfo ? handleReadInfo : undefined}
                title="Read device properties from bus"
                style={{ fontSize: 9, padding: '2px 6px', borderRadius: 10, background: `${C.green}18`, color: C.green, border: `1px solid ${C.green}30`, letterSpacing: '0.06em', whiteSpace: 'nowrap', cursor: !readingInfo ? 'pointer' : 'default' }}
                className="bg">{readingInfo ? 'SCANNING…' : 'SCAN'}</span>
            </>}
            {onAddDevice && (
              <span onClick={() => setShowDuplicate(true)}
                title="Duplicate this device"
                style={{ fontSize: 9, padding: '2px 6px', borderRadius: 10, background: `${C.green}18`, color: C.green, border: `1px solid ${C.green}30`, letterSpacing: '0.06em', whiteSpace: 'nowrap', cursor: 'pointer' }}
                className="bg">DUPLICATE</span>
            )}
          </div>
        </div>
        {showDuplicate && onAddDevice && (
          <DuplicateDeviceModal dev={dev} data={{ devices: allDevices, spaces }} onAdd={onAddDevice} onClose={() => setShowDuplicate(false)} C={C} />
        )}

        {/* Tab bar */}
        <TabBar C={C} active={devTab} onChange={handleDevTab} tabs={[
          { id: 'overview',    label: 'OVERVIEW' },
          ...(linkedGAs.length ? [{ id: 'gas', label: `GROUP ADDRESSES (${linkedGAs.length})` }] : []),
          ...(devCOs.length ? [{ id: 'comobjects', label: `GROUP OBJECTS (${devCOs.length})` }] : []),
          ...(dev.app_ref ? [{ id: 'parameters', label: 'PARAMETERS' }] : []),
          { id: 'telegrams',   label: 'MONITOR' },
        ]} />

        {/* Overview tab */}
        {devTab === 'overview' && <>
          {busInfo && !busInfo.error && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em', marginBottom: 6 }}>BUS INFO (LIVE)</div>
              <div style={{ background: C.surface, borderRadius: 4, border: `1px solid ${C.border}`, padding: '8px 12px' }}>
                {(() => {
                  const maskKey = busInfo.descriptor?.slice(0,4)?.toLowerCase();
                  const mask = maskKey && maskVersions[maskKey];
                  return [
                  ['Mask Version', mask ? `${mask.name} (0x${busInfo.descriptor})` : busInfo.descriptor],
                  ['Serial Number', busInfo.serialNumber],
                  ['Manufacturer ID', busInfo.manufacturerId != null ? `0x${busInfo.manufacturerId.toString(16).padStart(4, '0').toUpperCase()} (${busInfo.manufacturerId})` : null],
                  ['Firmware Revision', busInfo.firmwareRevision != null ? `${busInfo.firmwareRevision}` : null],
                  ['Order Info', busInfo.orderInfo],
                  ['Hardware Type', busInfo.hardwareType],
                  ['Program Version', busInfo.programVersion ? `MfrID=${busInfo.programVersion.manufacturerId} DevType=${busInfo.programVersion.deviceType} AppVer=${busInfo.programVersion.appVersion}` : null],
                  mask ? ['Management Model', mask.managementModel] : null,
                ].filter(Boolean).filter(([,v]) => v != null).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: C.dim, width: 130, flexShrink: 0 }}>{label}</span>
                    <span style={{ color: C.muted, fontFamily: 'monospace', fontSize: 10 }}>{value}</span>
                  </div>
                ));
                })()}
              </div>
            </div>
          )}
          {busInfo?.error && (
            <div style={{ marginBottom: 16, fontSize: 11, color: C.red }}>{busInfo.error}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 20 }}>
            {[['Manufacturer', dev.manufacturer, 'manufacturer', dev.manufacturer], ['Model', dev.model, 'model', localizedModel(dev)], ['Order #', dev.order_number, 'order_number', dev.order_number],
              ['Serial', dev.serial_number, null, dev.serial_number], ['Last Modified', dev.last_modified?.slice(0,10), null, dev.last_modified?.slice(0,10)], ['Last Download', dev.last_download?.slice(0,10), null, dev.last_download?.slice(0,10)],
              dev.bus_current ? ['Bus Current', dev.bus_current + ' mA', null, dev.bus_current + ' mA'] : null,
              dev.width_mm ? ['Width', dev.width_mm + ' mm', null, dev.width_mm + ' mm'] : null,
            ].filter(Boolean).filter(([,v]) => v).map(([k, v, wt, display]) => (
              <div key={k} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '8px 12px',
                cursor: wt && pin ? 'pointer' : 'default' }}
                onClick={wt && pin ? () => pin(wt, v) : undefined}
                className={wt && pin ? 'bg' : ''}>
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 3 }}>{k}</div>
                <div style={{ fontSize: 10, color: wt ? C.amber : C.text }}>{display}</div>
              </div>
            ))}
          </div>
          <EditableRtfField label="DESCRIPTION" value={dev.description && dev.description !== dev.name ? dev.description : ''} C={C}
            onSave={onUpdateDevice ? (v) => onUpdateDevice(dev.id, { description: v }) : null} />
          <EditableRtfField label="COMMENT" value={dev.comment || ''} C={C}
            onSave={onUpdateDevice ? (v) => onUpdateDevice(dev.id, { comment: v }) : null} />
          <EditableRtfField label="INSTALLATION HINTS" value={dev.installation_hints || ''} C={C}
            onSave={onUpdateDevice ? (v) => onUpdateDevice(dev.id, { installation_hints: v }) : null} />
          <SameDeviceSection dev={dev} allDevices={allDevices} spaces={spaces} C={C} pin={pin} />
        </>}

        {/* Group Addresses tab */}
        {devTab === 'gas' && <>
          {linkedGAs.length === 0
            ? <div style={{ fontSize: 11, color: C.dim, padding: '24px 0', textAlign: 'center' }}>No linked group addresses</div>
            : <>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, marginBottom: 20 }}>
                <thead><tr>
                  <TH style={{ width: 90 }}>ADDRESS</TH>
                  <TH>NAME</TH>
                  <TH style={{ width: 80 }}>DPT</TH>
                </tr></thead>
                <tbody>
                  {linkedGAs.map(g => (
                    <tr key={g.id} className="rh">
                      <TD><PinAddr address={g.address} wtype="ga" style={{ color: C.purple, fontFamily: 'monospace' }} /></TD>
                      <TD><span style={{ color: C.muted }}>{g.name}</span></TD>
                      <TD><span style={{ color: C.dim }} title={dpt.hover(g.dpt)}>{dpt.display(g.dpt)}</span></TD>
                    </tr>
                  ))}
                </tbody>
              </table>
              {gaDeviceMap && (
                <DeviceNetworkDiagram dev={dev} linkedGAs={linkedGAs} devCOs={devCOs}
                  gaDeviceMap={gaDeviceMap} allCOs={allCOs} devMap={devMap} C={C}
                  devTelegrams={devTelegrams} />
              )}
            </>
          }
        </>}

        {/* Group Objects tab */}
        {devTab === 'comobjects' && <>
          {devCOs.length === 0
            ? <div style={{ fontSize: 11, color: C.dim, padding: '24px 0', textAlign: 'center' }}>No group objects</div>
            : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <thead><tr>
                  <TH style={{ width: 40 }}>#</TH>
                  <TH style={{ width: 120 }}>CHANNEL</TH>
                  <TH>NAME</TH>
                  <TH>OBJECT FUNCTION</TH>
                  <TH style={{ width: 100 }}>DPT</TH>
                  <TH style={{ width: 90, whiteSpace: 'nowrap' }}>SIZE</TH>
                  <TH style={{ width: 60 }}>FLAGS</TH>
                  <TH>GA</TH>
                </tr></thead>
                <tbody>
                  {devCOs.map((co, i) => (
                    <tr key={i} className="rh">
                      <TD><span style={{ color: C.dim }}>{co.object_number}</span></TD>
                      <TD><span style={{ color: C.muted }}>{co.channel}</span></TD>
                      <TD><span style={{ color: C.text }}>{co.name || '—'}</span></TD>
                      <TD><span style={{ color: C.muted }}>{co.function_text || '—'}</span></TD>
                      <TD><span style={{ color: C.dim, fontFamily: 'monospace' }} title={dpt.hover(co.dpt || coGAs(co).map(a => gaMap[a]?.dpt).find(Boolean))}>{dpt.display(co.dpt || coGAs(co).map(a => gaMap[a]?.dpt).find(Boolean))}</span></TD>
                      <TD><span style={{ color: C.dim, whiteSpace: 'nowrap' }}>{co.object_size}</span></TD>
                      <TD><span style={{ color: C.dim, fontFamily: 'monospace' }}>{co.flags}</span></TD>
                      <TD>
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {coGAs(co).map((ga, idx) => (
                            <span key={ga} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {onUpdateComObjectGAs && coGAs(co).length > 1 && (
                                <span style={{ display: 'flex', flexDirection: 'column', gap: 0, lineHeight: 1, flexShrink: 0 }}>
                                  {idx > 0 && <span onClick={() => onUpdateComObjectGAs(co.id, { reorder: ga, position: idx - 1 })}
                                    style={{ color: C.dim, fontSize: 7, cursor: 'pointer' }} title="Move up">▲</span>}
                                  {idx < coGAs(co).length - 1 && <span onClick={() => onUpdateComObjectGAs(co.id, { reorder: ga, position: idx + 1 })}
                                    style={{ color: C.dim, fontSize: 7, cursor: 'pointer' }} title="Move down">▼</span>}
                                </span>
                              )}
                              <PinAddr address={ga} wtype="ga" style={{ color: C.purple, fontFamily: 'monospace', flexShrink: 0 }}>{ga}</PinAddr>
                              {gaMap[ga] && <span style={{ color: C.dim, fontSize: 9 }}>{gaMap[ga].name}</span>}
                              {onUpdateComObjectGAs && (
                                <span onClick={() => onUpdateComObjectGAs(co.id, { remove: ga })}
                                  title="Remove GA" style={{ color: C.dim, fontSize: 8, cursor: 'pointer', marginLeft: 'auto' }}>✕</span>
                              )}
                            </span>
                          ))}
                          {onUpdateComObjectGAs && (
                            <ComObjectGAAdder co={co} gaMap={gaMap} C={C}
                              onAdd={(ga) => onUpdateComObjectGAs(co.id, { add: ga })} />
                          )}
                        </span>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </>}

        {/* Parameters tab */}
        {devTab === 'parameters' && (
          <DeviceParameters dev={dev} C={C} projectId={activeProjectId} />
        )}

        {/* Telegrams tab */}
        {devTab === 'telegrams' && (
          <PinTelegramFeed telegrams={devTelegrams} gaMap={gaMap} devMap={devMap} spaces={spaces} />
        )}

      </div>
    </div>
  );
}

// Inline GA adder for a com object — shows a "+" that expands into a searchable dropdown
function ComObjectGAAdder({ co, gaMap, C, onAdd }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  if (!open) {
    return (
      <span onClick={() => setOpen(true)}
        style={{ color: C.green, fontSize: 8, cursor: 'pointer', opacity: 0.7 }}
        title="Link group address">+ link GA</span>
    );
  }

  const existing = new Set(coGAs(co));
  const allGAs = Object.values(gaMap);
  const sq = search.toLowerCase();
  const filtered = allGAs.filter(g =>
    !existing.has(g.address) &&
    (g.address.includes(sq) || (g.name || '').toLowerCase().includes(sq))
  ).slice(0, 15);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} autoFocus
          placeholder="Search GA..."
          onKeyDown={e => e.key === 'Escape' && setOpen(false)}
          style={{ background: C.inputBg, border: `1px solid ${C.border2}`, borderRadius: 3,
            padding: '2px 6px', color: C.text, fontSize: 9, fontFamily: 'inherit', width: 120 }} />
        <span onClick={() => setOpen(false)} style={{ color: C.dim, fontSize: 9, cursor: 'pointer' }}>cancel</span>
      </div>
      {filtered.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 3, maxHeight: 100, overflow: 'auto' }}>
          {filtered.map(g => (
            <div key={g.address}
              onClick={() => { onAdd(g.address); setOpen(false); setSearch(''); }}
              style={{ display: 'flex', gap: 4, padding: '2px 6px', cursor: 'pointer', fontSize: 9, alignItems: 'center' }}
              className="rh">
              <span style={{ color: C.purple, fontFamily: 'monospace', flexShrink: 0 }}>{g.address}</span>
              <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{g.name}</span>
            </div>
          ))}
        </div>
      )}
      {filtered.length === 0 && search && (
        <div style={{ fontSize: 9, color: C.dim, padding: '2px 6px' }}>No matching GAs</div>
      )}
    </div>
  );
}

function DuplicateDeviceModal({ dev, data, onAdd, onClose, C }) {
  const { devices = [], spaces = [] } = data;
  const [name, setName] = useState(dev.name + ' (copy)');
  const [area, setArea] = useState(dev.area);
  const [line, setLine] = useState(dev.line);
  const [devNum, setDevNum] = useState(() => {
    const used = new Set(devices.filter(d => d.area === dev.area && d.line === dev.line).map(d => parseInt(d.individual_address.split('.')[2])));
    for (let i = 1; i <= 255; i++) { if (!used.has(i)) return i; }
    return 1;
  });
  const [spaceId, setSpaceId] = useState(dev.space_id || '');
  const [error, setError] = useState('');

  const recomputeDevNum = (a, l) => {
    const used = new Set(devices.filter(d => d.area === a && d.line === l).map(d => parseInt(d.individual_address.split('.')[2])));
    for (let i = 1; i <= 255; i++) { if (!used.has(i)) return i; }
    return 1;
  };

  const address = `${area}.${line}.${devNum}`;
  const addressExists = devices.some(d => d.individual_address === address);

  // Flatten spaces for dropdown
  const flatSpaces = (() => {
    const nodeMap = {};
    for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
    const roots = [];
    for (const s of spaces) {
      if (s.parent_id && nodeMap[s.parent_id]) nodeMap[s.parent_id].children.push(nodeMap[s.id]);
      else roots.push(nodeMap[s.id]);
    }
    const result = [];
    const walk = (nodes, depth) => {
      for (const n of nodes.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))) {
        result.push({ id: n.id, name: n.name, type: n.type, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(roots, 0);
    return result;
  })();

  const handleSubmit = async () => {
    if (addressExists) { setError('Address already exists'); return; }
    if (!name.trim()) { setError('Name is required'); return; }
    setError('');

    // Duplicate: copy device fields but NOT group addresses or com object assignments
    // DO copy parameters (param_values)
    const body = {
      individual_address: address,
      name: name.trim(),
      area, line,
      manufacturer: dev.manufacturer || '',
      model: dev.model || '',
      device_type: dev.device_type || 'generic',
      order_number: dev.order_number || '',
      medium: dev.medium || 'TP',
      product_ref: dev.product_ref || '',
      description: dev.description || '',
      space_id: spaceId || null,
    };

    const newDev = await onAdd(body);
    // Save param_values from the source device to the new device
    if (newDev && dev.param_values && dev.param_values !== '{}') {
      try {
        const pv = typeof dev.param_values === 'string' ? JSON.parse(dev.param_values) : dev.param_values;
        if (Object.keys(pv).length > 0) {
          await api.saveParamValues(newDev.project_id, newDev.id, pv);
        }
      } catch (_) {}
    }
    if (newDev) onClose();
  };

  const inputStyle = {
    background: C.inputBg, border: `1px solid ${C.border2}`, borderRadius: 4,
    padding: '5px 8px', color: C.text, fontSize: 11, fontFamily: 'inherit',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
      onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8, padding: 20, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 4 }}>Duplicate Device</div>
        <div style={{ fontSize: 10, color: C.dim, marginBottom: 14 }}>
          Copy {dev.individual_address} ({dev.manufacturer} {dev.model}) with parameters. Group addresses and channel assignments are not copied.
        </div>

        {/* Name */}
        <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.08em', marginBottom: 4 }}>NAME</div>
        <input value={name} onChange={e => setName(e.target.value)} autoFocus
          style={{ ...inputStyle, width: '100%', marginBottom: 14 }} />

        {/* Address */}
        <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.08em', marginBottom: 4 }}>
          INDIVIDUAL ADDRESS
          {addressExists && <span style={{ color: C.red, marginLeft: 8 }}>already exists</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14 }}>
          <input type="number" min={1} max={15} value={area}
            onChange={e => { const a = +e.target.value; setArea(a); setDevNum(recomputeDevNum(a, line)); }}
            style={{ ...inputStyle, width: 50, textAlign: 'center' }} />
          <span style={{ color: C.dim }}>.</span>
          <input type="number" min={0} max={15} value={line}
            onChange={e => { const l = +e.target.value; setLine(l); setDevNum(recomputeDevNum(area, l)); }}
            style={{ ...inputStyle, width: 50, textAlign: 'center' }} />
          <span style={{ color: C.dim }}>.</span>
          <input type="number" min={1} max={255} value={devNum}
            onChange={e => setDevNum(+e.target.value)}
            style={{ ...inputStyle, width: 60, textAlign: 'center' }} />
        </div>

        {/* Location */}
        <div style={{ fontSize: 9, color: C.dim, letterSpacing: '0.08em', marginBottom: 4 }}>LOCATION</div>
        <select value={spaceId} onChange={e => setSpaceId(+e.target.value || '')}
          style={{ ...inputStyle, width: '100%', marginBottom: 14 }}>
          <option value="">— None —</option>
          {flatSpaces.map(s => (
            <option key={s.id} value={s.id}>{'  '.repeat(s.depth)}{s.name} ({s.type})</option>
          ))}
        </select>

        {error && <div style={{ fontSize: 10, color: C.red, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn onClick={onClose} color={C.dim}>Cancel</Btn>
          <Btn onClick={handleSubmit} color={C.green} disabled={addressExists}>Duplicate</Btn>
        </div>
      </div>
    </div>
  );
}

function SameDeviceSection({ dev, allDevices, spaces, C, pin }) {
  const [selected, setSelected] = useState(new Set());
  const key = dev.order_number || dev.model;
  if (!key || !allDevices) return null;
  const similar = allDevices.filter(d =>
    d.individual_address !== dev.individual_address &&
    (dev.order_number ? d.order_number === dev.order_number : d.model === dev.model)
  );
  if (!similar.length) return null;
  const toggleSelect = (addr) => setSelected(prev => { const n = new Set(prev); n.has(addr) ? n.delete(addr) : n.add(addr); return n; });
  const compareSelected = () => {
    if (selected.size < 1 || !pin) return;
    pin('multicompare', [dev.individual_address, ...selected].join('|'));
  };
  return (
    <div style={{ marginTop: 4, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em' }}>
          SAME DEVICE TYPE ({similar.length}) — {key}
        </span>
        {selected.size >= 1 && pin && (
          <Btn onClick={compareSelected} color={C.accent} style={{ fontSize: 9, padding: '2px 8px' }}>
            Compare {selected.size + 1} Devices
          </Btn>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {similar.map(d => (
          <div key={d.individual_address} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: selected.has(d.individual_address) ? `${C.accent}10` : C.surface, border: `1px solid ${selected.has(d.individual_address) ? C.accent + '40' : C.border}`, borderRadius: 4 }}>
            {pin && <input type="checkbox" checked={selected.has(d.individual_address)}
              onChange={() => toggleSelect(d.individual_address)}
              style={{ cursor: 'pointer', accentColor: C.accent, flexShrink: 0 }} />}
            <PinAddr address={d.individual_address} wtype="device" style={{ color: C.accent, fontFamily: 'monospace', fontSize: 11, flexShrink: 0 }} />
            <span style={{ color: C.muted, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            {d.space_id && <SpacePath spaceId={d.space_id} spaces={spaces} style={{ fontSize: 10, color: C.dim, flexShrink: 0 }} />}
            <Badge label={d.status?.toUpperCase()} color={STATUS_COLOR[d.status] || C.dim} />
            <span onClick={() => pin && pin('compare', `${dev.individual_address}|${d.individual_address}`)}
              style={{ fontSize: 9, padding: '2px 7px', borderRadius: 10, background: `${C.purple}18`, color: C.purple, border: `1px solid ${C.purple}30`, cursor: 'pointer', letterSpacing: '0.06em', flexShrink: 0 }}
              className="bg">COMPARE</span>
          </div>
        ))}
      </div>
    </div>
  );
}
