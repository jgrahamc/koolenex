import { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { useC } from '../theme.ts';
import { localizedModel } from '../dpt.ts';
import { PinContext, useDpt } from '../contexts.ts';
import {
  Empty,
  Btn,
  TH,
  TD,
  PinAddr,
  SpacePath,
  coGAs,
} from '../primitives.jsx';
import { SpaceTypeIcon } from '../icons.jsx';
import { GROUP_WTYPES } from '../state.ts';
import { AddDeviceModal } from '../AddDeviceModal.jsx';
import { ComparePanel } from './ComparePanel.jsx';
import { DevicePinPanel } from './DevicePinPanel.jsx';
import { GAPinPanel } from './GAPinPanel.jsx';

function SpacePanel({ spaceId, data, C, onUpdateSpace, onAddDevice }) {
  const { devices = [], spaces = [] } = data;
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const spaceMap = Object.fromEntries(spaces.map((s) => [s.id, s]));
  const space = spaceMap[parseInt(spaceId)];
  if (!space) return <Empty icon="◈" msg="Space not found" />;
  const getDescendants = (id) => {
    const children = spaces.filter((s) => s.parent_id === id);
    return [id, ...children.flatMap((c) => getDescendants(c.id))];
  };
  const spaceIds = new Set(getDescendants(parseInt(spaceId)));
  const matches = devices.filter((d) => spaceIds.has(d.space_id));

  const handleSave = async () => {
    if (!editName.trim() || !onUpdateSpace) return;
    setSaving(true);
    try {
      await onUpdateSpace(space.id, { name: editName.trim() });
      setEditing(false);
    } catch (_) {}
    setSaving(false);
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <span style={{ color: C.amber }}>
            <SpaceTypeIcon type={space.type} size={22} />
          </span>
          <span style={{ fontSize: 9, color: C.amber, letterSpacing: '0.1em' }}>
            {space.type?.toUpperCase()}
          </span>
        </div>
        {editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setEditing(false);
              }}
              style={{
                fontFamily: "'DM Mono',monospace",
                fontWeight: 700,
                fontSize: 20,
                color: C.text,
                background: C.inputBg,
                border: `1px solid ${C.accent}`,
                borderRadius: 4,
                padding: '2px 8px',
                flex: 1,
              }}
            />
            <Btn
              onClick={handleSave}
              disabled={saving || !editName.trim()}
              color={C.green}
            >
              {saving ? 'Saving' : 'Save'}
            </Btn>
            <Btn onClick={() => setEditing(false)} color={C.dim}>
              Cancel
            </Btn>
          </div>
        ) : (
          <div
            style={{
              fontFamily: "'DM Mono',monospace",
              fontWeight: 700,
              fontSize: 20,
              color: C.text,
              cursor: onUpdateSpace ? 'text' : 'default',
            }}
            onClick={
              onUpdateSpace
                ? () => {
                    setEditName(space.name);
                    setEditing(true);
                  }
                : undefined
            }
            title={onUpdateSpace ? 'Click to rename' : undefined}
          >
            {space.name}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 4,
          }}
        >
          <span style={{ fontSize: 11, color: C.dim }}>
            {matches.length} device{matches.length !== 1 ? 's' : ''}
          </span>
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              color={C.green}
              style={{ fontSize: 9, padding: '2px 8px' }}
            >
              + Add Device
            </Btn>
          )}
        </div>
      </div>
      {showAdd && onAddDevice && (
        <AddDeviceModal
          data={data}
          defaults={{ space_id: space.id }}
          onAdd={onAddDevice}
          onClose={() => setShowAdd(false)}
        />
      )}
      {matches.length === 0 ? (
        <Empty icon="◈" msg="No devices in this space" />
      ) : (
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}
        >
          <thead>
            <tr>
              <TH style={{ width: 80 }}>ADDRESS</TH>
              <TH>NAME</TH>
              <TH>MANUFACTURER</TH>
              <TH>MODEL</TH>
              <TH>LOCATION</TH>
            </tr>
          </thead>
          <tbody>
            {matches.map((d) => (
              <tr key={d.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                <TD>
                  <PinAddr
                    address={d.individual_address}
                    wtype="device"
                    style={{ color: C.accent, fontFamily: 'monospace' }}
                  />
                </TD>
                <TD>
                  <span style={{ color: C.text }}>{d.name}</span>
                </TD>
                <TD>
                  <PinAddr
                    address={d.manufacturer}
                    wtype="manufacturer"
                    style={{ color: C.amber }}
                  >
                    {d.manufacturer || '—'}
                  </PinAddr>
                </TD>
                <TD>
                  <PinAddr
                    address={d.model}
                    wtype="model"
                    style={{ color: C.amber, fontFamily: 'monospace' }}
                  >
                    {localizedModel(d) || '—'}
                  </PinAddr>
                </TD>
                <TD>
                  <SpacePath
                    spaceId={d.space_id}
                    spaces={spaces}
                    style={{ color: C.dim, fontSize: 10 }}
                  />
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DeviceGroupPanel({ wtype, value, data, C, onAddDevice, dispatch }) {
  const pin = useContext(PinContext);
  const { devices = [], spaces: _spaces = [] } = data;
  const { label } = GROUP_WTYPES[wtype];
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const field = GROUP_WTYPES[wtype].field;
  const matches = devices.filter((d) => d[field] === value);
  const toggleSelect = (addr) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(addr) ? n.delete(addr) : n.add(addr);
      return n;
    });
  const selectAll = () =>
    setSelected(new Set(matches.map((d) => d.individual_address)));
  const selectNone = () => setSelected(new Set());
  const compareSelected = () => {
    if (selected.size < 2 || !pin) return;
    pin('multicompare', [...selected].join('|'));
  };

  // Decide which extra columns to show
  const showMfr = field !== 'manufacturer';
  const showModel = field !== 'model';
  const showOrder = field !== 'order_number';

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 9,
            color: C.amber,
            letterSpacing: '0.1em',
            marginBottom: 4,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: "'DM Mono',monospace",
            fontWeight: 700,
            fontSize: 20,
            color: C.text,
          }}
        >
          {value}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 4,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 11, color: C.dim }}>
            {matches.length} device{matches.length !== 1 ? 's' : ''}
          </span>
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              color={C.green}
              style={{ fontSize: 9, padding: '2px 8px' }}
            >
              + Add
            </Btn>
          )}
          {dispatch &&
            (() => {
              const mfr =
                wtype === 'manufacturer' ? value : matches[0]?.manufacturer;
              return mfr ? (
                <Btn
                  onClick={() =>
                    dispatch({ type: 'CATALOG_JUMP', manufacturer: mfr })
                  }
                  color={C.accent}
                  style={{ fontSize: 9, padding: '2px 8px' }}
                >
                  Catalog
                </Btn>
              ) : null;
            })()}
          {matches.length >= 2 && pin && (
            <>
              <span style={{ color: C.border2 }}>|</span>
              <Btn
                onClick={
                  selected.size === matches.length ? selectNone : selectAll
                }
                color={C.dim}
                style={{ fontSize: 9, padding: '2px 8px' }}
              >
                {selected.size === matches.length
                  ? 'Deselect All'
                  : 'Select All'}
              </Btn>
              {selected.size >= 2 && (
                <Btn
                  onClick={compareSelected}
                  color={C.accent}
                  style={{ fontSize: 9, padding: '2px 8px' }}
                >
                  Compare {selected.size} Devices
                </Btn>
              )}
            </>
          )}
        </div>
      </div>
      {showAdd && onAddDevice && (
        <AddDeviceModal
          data={data}
          defaults={
            wtype === 'model'
              ? { model: value, manufacturer: matches[0]?.manufacturer }
              : wtype === 'manufacturer'
                ? { manufacturer: value }
                : {}
          }
          onAdd={onAddDevice}
          onClose={() => setShowAdd(false)}
        />
      )}
      {matches.length === 0 ? (
        <Empty icon="◈" msg="No matching devices" />
      ) : (
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}
        >
          <thead>
            <tr>
              {matches.length >= 2 && pin && <TH style={{ width: 30 }}></TH>}
              <TH style={{ width: 80 }}>ADDRESS</TH>
              <TH>NAME</TH>
              {showMfr && <TH>MANUFACTURER</TH>}
              {showModel && <TH>MODEL</TH>}
              {showOrder && <TH>ORDER #</TH>}
              <TH>LOCATION</TH>
              <TH style={{ width: 50 }}>mA</TH>
              <TH style={{ width: 50 }}>mm</TH>
            </tr>
          </thead>
          <tbody>
            {matches.map((d) => (
              <tr
                key={d.id}
                style={{
                  borderBottom: `1px solid ${C.border}`,
                  background: selected.has(d.individual_address)
                    ? `${C.accent}10`
                    : 'transparent',
                }}
              >
                {matches.length >= 2 && pin && (
                  <TD style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(d.individual_address)}
                      onChange={() => toggleSelect(d.individual_address)}
                      style={{ cursor: 'pointer', accentColor: C.accent }}
                    />
                  </TD>
                )}
                <TD>
                  <PinAddr
                    address={d.individual_address}
                    wtype="device"
                    style={{ color: C.accent, fontFamily: 'monospace' }}
                  />
                </TD>
                <TD>
                  <span style={{ color: C.text }}>{d.name}</span>
                </TD>
                {showMfr && (
                  <TD>
                    <PinAddr
                      address={d.manufacturer}
                      wtype="manufacturer"
                      style={{ color: C.amber }}
                    >
                      {d.manufacturer || '—'}
                    </PinAddr>
                  </TD>
                )}
                {showModel && (
                  <TD>
                    <PinAddr
                      address={d.model}
                      wtype="model"
                      style={{
                        color: C.amber,
                        fontFamily: 'monospace',
                        fontSize: 10,
                      }}
                    >
                      {localizedModel(d) || '—'}
                    </PinAddr>
                  </TD>
                )}
                {showOrder && (
                  <TD>
                    <PinAddr
                      address={d.order_number}
                      wtype="order_number"
                      style={{
                        color: C.amber,
                        fontFamily: 'monospace',
                        fontSize: 10,
                      }}
                    >
                      {d.order_number || '—'}
                    </PinAddr>
                  </TD>
                )}
                <TD>
                  <SpacePath
                    spaceId={d.space_id}
                    spaces={data.spaces}
                    style={{ color: C.dim, fontSize: 10 }}
                  />
                </TD>
                <TD>
                  <span style={{ color: C.dim, fontFamily: 'monospace' }}>
                    {d.bus_current || '—'}
                  </span>
                </TD>
                <TD>
                  <span style={{ color: C.dim, fontFamily: 'monospace' }}>
                    {d.width_mm || '—'}
                  </span>
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const COMPARE_COLORS = [
  '#4fc3f7',
  '#ab47bc',
  '#66bb6a',
  '#ffa726',
  '#ef5350',
  '#26c6da',
  '#ec407a',
  '#8d6e63',
  '#78909c',
  '#d4e157',
];

function MultiComparePanel({ addrs, data, C }) {
  const pin = useContext(PinContext);
  const dpt = useDpt();
  const { devices = [], gas = [], comObjects = [] } = data;
  const gaMap = Object.fromEntries(gas.map((g) => [g.address, g]));
  const [showAll, setShowAll] = useState(false);

  const devs = addrs
    .map((a) => devices.find((d) => d.individual_address === a))
    .filter(Boolean);
  if (devs.length < 2)
    return <Empty icon="◈" msg="Need at least 2 devices to compare" />;

  const colors = devs.map((_, i) => COMPARE_COLORS[i % COMPARE_COLORS.length]);

  // Parameters comparison
  const allParams = devs.map((d) => {
    try {
      return JSON.parse(d.parameters || '[]');
    } catch {
      return [];
    }
  });
  const allParamMaps = allParams.map((ps) =>
    Object.fromEntries(ps.map((p) => [`${p.section}|${p.name}`, p])),
  );
  const allKeys = [
    ...new Set(allParamMaps.flatMap((m) => Object.keys(m))),
  ].sort();

  // Filter to only show rows where at least one value differs
  const paramRows = allKeys.map((k) => {
    const vals = allParamMaps.map((m) => m[k]?.value ?? null);
    const defined = vals.filter((v) => v !== null);
    const allSame =
      defined.length === vals.length && defined.every((v) => v === defined[0]);
    return { key: k, vals, allSame };
  });
  const diffRows = paramRows.filter((r) => !r.allSame);
  const displayRows = showAll ? paramRows : diffRows;

  // Group objects comparison
  const allCOs = devs.map((d) =>
    comObjects.filter((co) => co.device_address === d.individual_address),
  );
  const allCOMaps = allCOs.map((cos) =>
    Object.fromEntries(cos.map((co) => [co.object_number, co])),
  );
  const allCoNums = [
    ...new Set(allCOs.flat().map((co) => co.object_number)),
  ].sort((a, b) => a - b);
  const coRows = allCoNums.map((num) => {
    const cos = allCOMaps.map((m) => m[num] || null);
    const gas = cos.map((co) => co?.ga_address || '');
    const allSame = gas.every((g) => g === gas[0]);
    return { num, cos, gas, allSame };
  });
  const diffCORows = coRows.filter((r) => !r.allSame);

  // Group addresses comparison
  const allGASets = allCOs.map((cos) => new Set(cos.flatMap(coGAs)));
  const allGAAddrs = [...new Set(allGASets.flatMap((s) => [...s]))].sort();
  const gaRows = allGAAddrs.map((ga) => {
    const present = allGASets.map((s) => s.has(ga));
    const allSame = present.every((p) => p === present[0]);
    return { ga, present, allSame };
  });
  const diffGARows = gaRows.filter((r) => !r.allSame);

  const TH2 = ({ children, style }) => (
    <th
      style={{
        padding: '5px 8px',
        textAlign: 'left',
        fontSize: 9,
        color: C.dim,
        fontWeight: 600,
        letterSpacing: '0.07em',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        position: 'sticky',
        top: 0,
        ...style,
      }}
    >
      {children}
    </th>
  );
  const TD2 = ({ children, style, diff }) => (
    <td
      style={{
        padding: '4px 8px',
        fontSize: 10,
        borderBottom: `1px solid ${C.border}`,
        background: diff ? `${C.amber}18` : 'transparent',
        ...style,
      }}
    >
      {children ?? <span style={{ color: C.dim }}>-</span>}
    </td>
  );

  return (
    <div style={{ padding: 20 }}>
      {/* Header: device cards */}
      <div
        style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}
      >
        {devs.map((d, i) => (
          <div
            key={d.individual_address}
            onClick={
              pin ? () => pin('device', d.individual_address) : undefined
            }
            style={{
              flex: '1 1 0',
              minWidth: 100,
              padding: '8px 12px',
              background: C.surface,
              border: `2px solid ${colors[i]}40`,
              borderRadius: 6,
              cursor: pin ? 'pointer' : 'default',
            }}
          >
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                fontWeight: 700,
                color: colors[i],
              }}
            >
              {d.individual_address}
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
              {d.name}
            </div>
          </div>
        ))}
      </div>

      {/* Parameters */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em' }}>
            PARAMETERS
          </span>
          <span style={{ fontSize: 10, color: C.dim }}>
            {diffRows.length} difference{diffRows.length !== 1 ? 's' : ''} /{' '}
            {paramRows.length} total
          </span>
          <Btn
            onClick={() => setShowAll((p) => !p)}
            color={C.dim}
            style={{ fontSize: 9, padding: '1px 6px' }}
          >
            {showAll ? 'Differences Only' : 'Show All'}
          </Btn>
        </div>
        {displayRows.length === 0 ? (
          <div style={{ fontSize: 11, color: C.dim, padding: '8px 0' }}>
            {showAll
              ? 'No parameters found.'
              : 'All parameters are identical across selected devices.'}
          </div>
        ) : (
          <div
            style={{
              maxHeight: 400,
              overflow: 'auto',
              border: `1px solid ${C.border}`,
              borderRadius: 4,
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH2 style={{ width: '18%' }}>SECTION</TH2>
                  <TH2 style={{ width: '20%' }}>NAME</TH2>
                  {devs.map((d, i) => (
                    <TH2
                      key={d.individual_address}
                      style={{ color: colors[i] }}
                    >
                      {d.individual_address}
                    </TH2>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map(({ key, vals, allSame }) => {
                  const [section, name] = key.split('|');
                  return (
                    <tr key={key}>
                      <TD2 style={{ color: C.dim }} diff={!allSame}>
                        {section}
                      </TD2>
                      <TD2 style={{ color: C.muted }} diff={!allSame}>
                        {name}
                      </TD2>
                      {vals.map((v, i) => (
                        <TD2 key={i} diff={!allSame}>
                          <span
                            style={{
                              color:
                                v === null
                                  ? C.dim
                                  : !allSame
                                    ? C.amber
                                    : C.text,
                            }}
                          >
                            {v ?? '-'}
                          </span>
                        </TD2>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Group Objects — differences only */}
      {diffCORows.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 10,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            GROUP OBJECTS — {diffCORows.length} difference
            {diffCORows.length !== 1 ? 's' : ''}
          </div>
          <div
            style={{
              maxHeight: 300,
              overflow: 'auto',
              border: `1px solid ${C.border}`,
              borderRadius: 4,
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH2 style={{ width: 36 }}>#</TH2>
                  <TH2>NAME</TH2>
                  {devs.map((d, i) => (
                    <TH2
                      key={d.individual_address}
                      style={{ color: colors[i] }}
                    >
                      GA — {d.individual_address}
                    </TH2>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diffCORows.map(({ num, cos, gas }) => {
                  const co = cos.find((c) => c) || {};
                  return (
                    <tr key={num}>
                      <TD2 style={{ color: C.dim }} diff>
                        {num}
                      </TD2>
                      <TD2 style={{ color: C.muted }} diff>
                        {co.name || co.function_text}
                      </TD2>
                      {gas.map((ga, i) => (
                        <TD2 key={i} diff>
                          {ga ? (
                            <span
                              style={{
                                fontFamily: 'monospace',
                                fontSize: 10,
                                color: C.amber,
                              }}
                            >
                              {ga.split(/\s+/).map((a, j) => (
                                <span key={j}>
                                  {j > 0 && ' '}
                                  <PinAddr
                                    address={a}
                                    wtype="ga"
                                    style={{ color: C.amber }}
                                  >
                                    {a}
                                  </PinAddr>
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span style={{ color: C.dim }}>-</span>
                          )}
                        </TD2>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Group Addresses — differences only */}
      {diffGARows.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              fontSize: 10,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 8,
            }}
          >
            GROUP ADDRESSES — {diffGARows.length} difference
            {diffGARows.length !== 1 ? 's' : ''}
          </div>
          <div
            style={{
              maxHeight: 300,
              overflow: 'auto',
              border: `1px solid ${C.border}`,
              borderRadius: 4,
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH2 style={{ width: 100 }}>ADDRESS</TH2>
                  <TH2>NAME</TH2>
                  <TH2 style={{ width: 70 }}>DPT</TH2>
                  {devs.map((d, i) => (
                    <TH2
                      key={d.individual_address}
                      style={{
                        width: 50,
                        textAlign: 'center',
                        color: colors[i],
                      }}
                    >
                      {d.individual_address}
                    </TH2>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diffGARows.map(({ ga, present }) => {
                  const gaInfo = gaMap[ga];
                  return (
                    <tr key={ga}>
                      <TD2 diff>
                        <PinAddr
                          address={ga}
                          wtype="ga"
                          style={{ fontFamily: 'monospace', color: C.purple }}
                        >
                          {ga}
                        </PinAddr>
                      </TD2>
                      <TD2 diff style={{ color: C.muted }}>
                        {gaInfo?.name}
                      </TD2>
                      <TD2 diff>
                        <span
                          style={{ fontFamily: 'monospace', color: C.dim }}
                          title={dpt.hover(gaInfo?.dpt)}
                        >
                          {dpt.display(gaInfo?.dpt)}
                        </span>
                      </TD2>
                      {present.map((p, i) => (
                        <TD2 key={i} diff style={{ textAlign: 'center' }}>
                          <span style={{ color: p ? C.green : C.dim }}>
                            {p ? '\u2713' : '-'}
                          </span>
                        </TD2>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {diffCORows.length === 0 &&
        diffGARows.length === 0 &&
        diffRows.length === 0 && (
          <div style={{ fontSize: 11, color: C.dim, padding: '8px 0' }}>
            All devices are identically configured.
          </div>
        )}
    </div>
  );
}

export function PinDetailView({
  pinKey,
  data,
  busStatus,
  telegrams = [],
  onWrite,
  activeProjectId,
  onUpdateGA,
  onUpdateDevice,
  onUpdateSpace,
  onGroupJump,
  onAddDevice,
  onUpdateComObjectGAs,
  dispatch,
}) {
  const C = useC();
  const COLMAP = {
    actuator: C.actuator,
    sensor: C.sensor,
    router: C.router,
    generic: C.muted,
  };
  const scrollRef = useRef(null);
  const savedScrolls = useRef({});

  // Save scroll position whenever user scrolls
  const onScroll = useCallback(() => {
    if (scrollRef.current && pinKey)
      savedScrolls.current[pinKey] = scrollRef.current.scrollTop;
  }, [pinKey]);

  // Restore scroll position when pinKey changes (back/forward navigation)
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = savedScrolls.current[pinKey] || 0;
  }, [pinKey]);

  if (!pinKey || !data)
    return <Empty icon="◈" msg="Select a pinned item from the sidebar" />;

  const [wtype, address] = pinKey.split(':');
  const {
    devices = [],
    gas = [],
    comObjects = [],
    deviceGAMap = {},
    gaDeviceMap = {},
    spaces = [],
  } = data;
  const spaceMap = Object.fromEntries(spaces.map((s) => [s.id, s]));
  const spacePath = (id) => {
    const p = [];
    let c = spaceMap[id];
    while (c) {
      if (c.type !== 'Building') p.unshift(c.name);
      c = c.parent_id ? spaceMap[c.parent_id] : null;
    }
    return p.join(' › ');
  };
  const gaMap = Object.fromEntries(gas.map((g) => [g.address, g]));
  const busConnected = busStatus?.connected;
  const devMap = Object.fromEntries(
    devices.map((d) => [d.individual_address, d]),
  );

  let content;
  if (wtype === 'space') {
    content = (
      <SpacePanel
        spaceId={address}
        data={data}
        C={C}
        onUpdateSpace={onUpdateSpace}
        onAddDevice={onAddDevice}
      />
    );
  } else if (GROUP_WTYPES[wtype]) {
    content = (
      <DeviceGroupPanel
        wtype={wtype}
        value={address}
        data={data}
        C={C}
        onAddDevice={onAddDevice}
        dispatch={dispatch}
      />
    );
  } else if (wtype === 'multicompare') {
    const addrs = address.split('|');
    content = <MultiComparePanel addrs={addrs} data={data} C={C} />;
  } else if (wtype === 'compare') {
    const [addrA, addrB] = address.split('|');
    content = <ComparePanel addrA={addrA} addrB={addrB} data={data} C={C} />;
  } else if (wtype === 'device') {
    const dev = devices.find((d) => d.individual_address === address);
    if (!dev) content = <Empty icon="◈" msg="Device not found" />;
    else {
      const devCOs = comObjects.filter((co) => co.device_address === address);
      const linkedGAs = (deviceGAMap[address] || [])
        .map((a) => gas.find((g) => g.address === a))
        .filter(Boolean);
      const devTelegrams = telegrams.filter(
        (t) => t.src === address || t.dst === address,
      );
      content = (
        <DevicePinPanel
          C={C}
          COLMAP={COLMAP}
          dev={dev}
          devCOs={devCOs}
          linkedGAs={linkedGAs}
          spacePath={spacePath}
          gaMap={gaMap}
          devMap={devMap}
          spaces={spaces}
          allDevices={devices}
          gaDeviceMap={gaDeviceMap}
          allCOs={comObjects}
          busConnected={busConnected}
          devTelegrams={devTelegrams}
          onUpdateDevice={onUpdateDevice}
          onAddDevice={onAddDevice}
          onUpdateComObjectGAs={onUpdateComObjectGAs}
          activeProjectId={activeProjectId}
        />
      );
    }
  } else {
    const ga = gas.find((g) => g.address === address);
    if (!ga) content = <Empty icon="◆" msg="Group address not found" />;
    else {
      const linkedDevices = (gaDeviceMap[address] || [])
        .map((a) => devices.find((d) => d.individual_address === a))
        .filter(Boolean);
      const gaTelegrams = telegrams.filter(
        (t) => t.dst === address || t.src === address,
      );
      content = (
        <GAPinPanel
          C={C}
          COLMAP={COLMAP}
          ga={ga}
          linkedDevices={linkedDevices}
          busConnected={busConnected}
          gaTelegrams={gaTelegrams}
          gaMap={gaMap}
          devMap={devMap}
          spaces={spaces}
          allCOs={comObjects}
          onWrite={onWrite}
          activeProjectId={activeProjectId}
          onUpdateGA={onUpdateGA}
          onGroupJump={onGroupJump}
        />
      );
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ flex: 1, overflow: 'auto' }}
    >
      {content}
    </div>
  );
}
