import { useState, useEffect, useContext, useMemo } from 'react';
import { useC, MediumCtx, STATUS_COLOR } from '../theme.ts';
import { localizedModel } from '../dpt.ts';
import {
  Badge,
  Btn,
  TH,
  TD,
  SectionHeader,
  Empty,
  PinAddr,
  SpacePath,
} from '../primitives.tsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { api } from '../api.ts';

import { AddDeviceModal } from '../AddDeviceModal.tsx';

interface TopologyViewProps {
  data: any;
  onPin?: any;
  busConnected: boolean;
  dispatch?: ((action: any) => void) | null;
  onAddDevice?: ((body: any) => Promise<any>) | null;
  activeProjectId?: any;
  onUpdateTopology?: ((id: any, updates: any) => Promise<any>) | null;
  onCreateTopology?: ((body: any) => Promise<any>) | null;
  onDeleteTopology?: ((id: any) => Promise<any>) | null;
}

export function TopologyView({
  data,
  onPin: _onPin,
  busConnected,
  dispatch,
  onAddDevice,
  activeProjectId: _activeProjectId,
  onUpdateTopology,
  onCreateTopology,
  onDeleteTopology,
}: TopologyViewProps) {
  const C = useC();
  const mediumTypes = useContext(MediumCtx);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('knx-topo-collapsed') || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('knx-topo-collapsed', JSON.stringify(collapsed));
    } catch {}
  }, [collapsed]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [addDefaults, setAddDefaults] = useState<any>(null);
  const [editTopoId, setEditTopoId] = useState<any>(null);
  const {
    devices = [],
    deviceGAMap = {},
    spaces = [],
    topology = [],
  } = data || {};

  const TOPO_COLS = useMemo(
    () => [
      { id: 'individual_address', label: 'Address', visible: true },
      { id: 'name', label: 'Name', visible: true },
      { id: 'device_type', label: 'Type', visible: true },
      { id: 'location', label: 'Location', visible: true },
      { id: 'manufacturer', label: 'Manufacturer', visible: true },
      { id: 'model', label: 'Model', visible: true },
      { id: 'order_number', label: 'Order #', visible: false },
      { id: 'serial_number', label: 'Serial', visible: true },
      { id: 'status', label: 'Status', visible: true },
      { id: 'gas', label: 'GAs', visible: true },
    ],
    [],
  );
  const [topoCols, saveTopoCols] = useColumns('topology', TOPO_COLS);
  const tcv = (id: string) =>
    topoCols.find((c: any) => c.id === id)?.visible !== false;
  const visibleTopoCols = topoCols.filter((c: any) => c.visible !== false);

  const spaceMap = useMemo(
    () => Object.fromEntries(spaces.map((s: any) => [s.id, s])),
    [spaces],
  );
  const spacePath = (spaceId: any) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' › ');
  };

  // Build topology structure from the topology table
  const areaRows = topology
    .filter((t: any) => t.line === null)
    .sort((a: any, b: any) => a.area - b.area);
  const lineRows = topology.filter((t: any) => t.line !== null);
  // Also discover areas/lines from devices that might not have topology rows yet
  const allAreas: any[] = [
    ...new Set([
      ...areaRows.map((t: any) => t.area),
      ...devices.map((d: any) => d.area),
    ]),
  ].sort((a: any, b: any) => a - b);

  const toggleLine = (area: number, line: number) =>
    setCollapsed((p) => ({ ...p, [`${area}.${line}`]: !p[`${area}.${line}`] }));

  const exportTopoCSV = () => {
    const filtered = devices.filter(
      (d: any) => statusFilter === 'all' || d.status === statusFilter,
    );
    dlCSV(
      'koolenex-topology.csv',
      topoCols,
      filtered,
      (id: string, d: any) =>
        ({
          individual_address: d.individual_address,
          name: d.name,
          device_type: d.device_type,
          location: spacePath(d.space_id),
          manufacturer: d.manufacturer || '',
          model: d.model || '',
          order_number: d.order_number || '',
          serial_number: d.serial_number || '',
          status: d.status,
          gas: (deviceGAMap[d.individual_address] || []).length,
        })[id] ?? '',
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
      }}
    >
      <SectionHeader
        title="Topology"
        count={devices.length}
        actions={[
          <ColumnPicker
            key="cp"
            cols={topoCols}
            onChange={saveTopoCols}
            C={C}
          />,
          <Btn key="csv" onClick={exportTopoCSV} color={C.muted} bg={C.surface}>
            ↓ CSV
          </Btn>,
          ...(onCreateTopology
            ? [
                <Btn
                  key="add"
                  onClick={() => {
                    const nextArea = allAreas.length
                      ? Math.max(...allAreas) + 1
                      : 1;
                    onCreateTopology({
                      area: nextArea,
                      name: `Area ${nextArea}`,
                    });
                  }}
                  color={C.green}
                  bg={C.surface}
                >
                  + Area
                </Btn>,
              ]
            : []),
        ]}
      />
      <div style={{ overflow: 'auto', flex: 1 }}>
        {allAreas.map((area: any) => {
          const areaRow = areaRows.find((t: any) => t.area === area);
          const areaName = areaRow?.name || '';
          const lines: any[] = [
            ...new Set([
              ...lineRows
                .filter((t: any) => t.area === area)
                .map((t: any) => t.line),
              ...devices
                .filter((d: any) => d.area === area)
                .map((d: any) => d.line),
            ]),
          ].sort((a: any, b: any) => a - b);
          const areaDevs = devices.filter(
            (d: any) =>
              d.area === area &&
              (statusFilter === 'all' || d.status === statusFilter),
          );
          return (
            <div key={`area-${area}`}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 14px',
                  background: C.surface,
                  borderBottom: `1px solid ${C.border}`,
                }}
              >
                {editTopoId === areaRow?.id ? (
                  <InlineEdit
                    initial={areaName}
                    fontSize={11}
                    onSave={async (v) => {
                      await onUpdateTopology!(areaRow.id, { name: v });
                      setEditTopoId(null);
                    }}
                    onCancel={() => setEditTopoId(null)}
                    C={C}
                  />
                ) : (
                  <>
                    <span
                      style={{ color: C.accent, fontSize: 11, fontWeight: 600 }}
                    >
                      AREA {area}
                    </span>
                    {areaName && (
                      <span
                        style={{
                          color: C.accent,
                          fontSize: 11,
                          fontWeight: 600,
                        }}
                      >
                        — {areaName}
                      </span>
                    )}
                    {!areaName && onUpdateTopology && areaRow && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTopoId(areaRow.id);
                        }}
                        style={{
                          color: C.dim,
                          fontSize: 9,
                          cursor: 'pointer',
                          fontStyle: 'italic',
                        }}
                      >
                        + name
                      </span>
                    )}
                    {areaName && onUpdateTopology && areaRow && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTopoId(areaRow.id);
                        }}
                        title="Rename"
                        style={{
                          color: C.dim,
                          fontSize: 9,
                          cursor: 'pointer',
                          opacity: 0.5,
                        }}
                        className="bg"
                      >
                        edit
                      </span>
                    )}
                  </>
                )}
                <span style={{ color: C.dim, fontSize: 10 }}>
                  · {areaDevs.length} devices · {lines.length} lines
                </span>
                {onCreateTopology && (
                  <span
                    onClick={() => {
                      const nextLine = lines.length
                        ? Math.max(...lines) + 1
                        : 1;
                      onCreateTopology({ area, line: nextLine, name: '' });
                    }}
                    title="Add a new line to this area"
                    style={{
                      color: C.green,
                      fontSize: 13,
                      cursor: 'pointer',
                      opacity: 0.7,
                      lineHeight: 1,
                    }}
                  >
                    +
                  </span>
                )}
                {onDeleteTopology && areaRow && areaDevs.length === 0 && (
                  <span
                    onClick={() => onDeleteTopology(areaRow.id)}
                    title={`Delete Area ${area}`}
                    style={{
                      color: C.red,
                      fontSize: 13,
                      cursor: 'pointer',
                      opacity: 0.5,
                      lineHeight: 1,
                    }}
                  >
                    −
                  </span>
                )}
              </div>
              {lines.map((line: any) => {
                const lineRow = lineRows.find(
                  (t: any) => t.area === area && t.line === line,
                );
                const lineName = lineRow?.name || '';
                const devs = devices.filter(
                  (d: any) =>
                    d.area === area &&
                    d.line === line &&
                    (statusFilter === 'all' || d.status === statusFilter),
                );
                const isCollapsed = !!collapsed[`${area}.${line}`];
                const medium =
                  lineRow?.medium ||
                  devices.find((d: any) => d.area === area && d.line === line)
                    ?.medium ||
                  'TP';
                const mediumColor =
                  (
                    {
                      TP: C.green,
                      RF: C.amber,
                      IP: C.accent,
                      PL: C.purple,
                    } as Record<string, any>
                  )[medium] || C.dim;
                return (
                  <div key={`line-${area}-${line}`}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 14px 5px 28px',
                        background: C.hover,
                        borderBottom: `1px solid ${C.border}`,
                      }}
                    >
                      <span
                        onClick={() => toggleLine(area, line)}
                        style={{
                          fontSize: 9,
                          color: C.dim,
                          width: 14,
                          cursor: 'pointer',
                          userSelect: 'none',
                        }}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                      {editTopoId === lineRow?.id ? (
                        <InlineEdit
                          initial={lineName}
                          fontSize={10}
                          onSave={async (v) => {
                            await onUpdateTopology!(lineRow.id, { name: v });
                            setEditTopoId(null);
                          }}
                          onCancel={() => setEditTopoId(null)}
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
                            Line {area}.{line}
                          </span>
                          {lineName && (
                            <span style={{ color: C.text, fontSize: 10 }}>
                              — {lineName}
                            </span>
                          )}
                          {!lineName && onUpdateTopology && lineRow && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditTopoId(lineRow.id);
                              }}
                              style={{
                                color: C.dim,
                                fontSize: 9,
                                cursor: 'pointer',
                                fontStyle: 'italic',
                              }}
                            >
                              + name
                            </span>
                          )}
                          {lineName && onUpdateTopology && lineRow && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditTopoId(lineRow.id);
                              }}
                              title="Rename"
                              style={{
                                color: C.dim,
                                fontSize: 9,
                                cursor: 'pointer',
                                opacity: 0.5,
                              }}
                              className="bg"
                            >
                              edit
                            </span>
                          )}
                        </>
                      )}
                      <Badge
                        label={medium}
                        color={mediumColor}
                        title={mediumTypes[medium] || medium}
                      />
                      <span style={{ color: C.dim, fontSize: 10 }}>
                        · {devs.length}
                      </span>
                      {(() => {
                        const mA = devs.reduce(
                          (s: any, d: any) => s + (d.bus_current || 0),
                          0,
                        );
                        return mA > 0 ? (
                          <span style={{ color: C.dim, fontSize: 10 }}>
                            · {mA} mA
                          </span>
                        ) : null;
                      })()}
                      {onAddDevice && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setAddDefaults({ area, line, medium });
                          }}
                          title="Add device to this line"
                          style={{
                            color: C.green,
                            fontSize: 13,
                            cursor: 'pointer',
                            opacity: 0.7,
                            lineHeight: 1,
                          }}
                        >
                          +
                        </span>
                      )}
                      {onDeleteTopology && lineRow && devs.length === 0 && (
                        <span
                          onClick={() => onDeleteTopology(lineRow.id)}
                          title={`Delete Line ${area}.${line}`}
                          style={{
                            color: C.red,
                            fontSize: 13,
                            cursor: 'pointer',
                            opacity: 0.5,
                            lineHeight: 1,
                          }}
                        >
                          −
                        </span>
                      )}
                      {busConnected && dispatch && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'SCAN_RESET' });
                            dispatch({ type: 'SET_VIEW', view: 'scan' });
                            api.busScan(area, line, 200);
                          }}
                          style={{
                            fontSize: 9,
                            padding: '1px 7px',
                            borderRadius: 10,
                            background: `${C.accent}15`,
                            color: C.accent,
                            border: `1px solid ${C.accent}30`,
                            cursor: 'pointer',
                            letterSpacing: '0.06em',
                          }}
                          className="bg"
                        >
                          ⊙ SCAN
                        </span>
                      )}
                    </div>
                    {!isCollapsed && devs.length > 0 && (
                      <table
                        style={{ width: '100%', borderCollapse: 'collapse' }}
                      >
                        <thead>
                          <tr>
                            {visibleTopoCols.map((col: any) => (
                              <TH
                                key={col.id}
                                style={
                                  col.id === 'individual_address'
                                    ? { width: 100, paddingLeft: 42 }
                                    : col.id === 'device_type'
                                      ? { width: 90 }
                                      : col.id === 'manufacturer'
                                        ? { width: 120 }
                                        : col.id === 'model'
                                          ? { width: 110 }
                                          : col.id === 'order_number'
                                            ? { width: 110 }
                                            : col.id === 'serial_number'
                                              ? { width: 130 }
                                              : col.id === 'status'
                                                ? { width: 110 }
                                                : col.id === 'gas'
                                                  ? { width: 50 }
                                                  : {}
                                }
                              >
                                {col.label.toUpperCase().replace('GAS', 'GAs')}
                              </TH>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {devs.map((d: any) => (
                            <tr
                              key={d.id}
                              className="rh"
                              style={{ borderLeft: '2px solid transparent' }}
                            >
                              {tcv('individual_address') && (
                                <TD style={{ paddingLeft: 42 }}>
                                  <PinAddr
                                    address={d.individual_address}
                                    wtype="device"
                                    style={{
                                      color: C.accent,
                                      fontFamily: 'monospace',
                                    }}
                                  />
                                </TD>
                              )}
                              {tcv('name') && <TD>{d.name}</TD>}
                              {tcv('device_type') && (
                                <TD>
                                  <span style={{ color: C.muted }}>
                                    {d.device_type}
                                  </span>
                                </TD>
                              )}
                              {tcv('location') && spaces.length > 0 && (
                                <TD>
                                  <SpacePath
                                    spaceId={d.space_id}
                                    spaces={spaces}
                                    style={{ color: C.dim, fontSize: 10 }}
                                  />
                                </TD>
                              )}
                              {tcv('manufacturer') && (
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
                              {tcv('model') && (
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
                              {tcv('order_number') && (
                                <TD>
                                  <span
                                    style={{
                                      color: C.dim,
                                      fontFamily: 'monospace',
                                      fontSize: 10,
                                    }}
                                  >
                                    {d.order_number || '—'}
                                  </span>
                                </TD>
                              )}
                              {tcv('serial_number') && (
                                <TD>
                                  <span
                                    style={{
                                      color: C.dim,
                                      fontFamily: 'monospace',
                                      fontSize: 10,
                                    }}
                                  >
                                    {d.serial_number || '—'}
                                  </span>
                                </TD>
                              )}
                              {tcv('status') && (
                                <TD>
                                  <Badge
                                    label={d.status.toUpperCase()}
                                    color={
                                      (STATUS_COLOR as any)[d.status] || C.dim
                                    }
                                  />
                                </TD>
                              )}
                              {tcv('gas') && (
                                <TD>
                                  <span style={{ color: C.dim }}>
                                    {
                                      (deviceGAMap[d.individual_address] || [])
                                        .length
                                    }
                                  </span>
                                </TD>
                              )}
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
        {devices.length === 0 && allAreas.length === 0 && (
          <Empty icon="⬡" msg="No devices or topology" />
        )}
      </div>
      <div
        style={{
          padding: '5px 14px',
          borderTop: `1px solid ${C.border}`,
          fontSize: 10,
          color: C.dim,
          display: 'flex',
          gap: 14,
        }}
      >
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span
            key={s}
            className="rh"
            onClick={() => setStatusFilter((p) => (p === s ? 'all' : s))}
            style={{
              cursor: 'pointer',
              color: statusFilter === s ? c : C.dim,
              fontWeight: statusFilter === s ? 600 : 400,
            }}
          >
            <span style={{ color: c }}>●</span>{' '}
            {devices.filter((d: any) => d.status === s).length} {s}
          </span>
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

function InlineEdit({
  initial,
  fontSize = 11,
  onSave,
  onCancel,
  C,
}: {
  initial: string;
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
        {saving ? 'Saving' : 'Save'}
      </Btn>
      <Btn onClick={onCancel} color={C.dim}>
        Cancel
      </Btn>
    </div>
  );
}
