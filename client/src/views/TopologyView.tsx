import { useState, useEffect, useContext, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MediumCtx, STATUS_COLOR } from '../theme.ts';
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
import styles from './TopologyView.module.css';

interface TopologyViewProps {
  data: any;
  onPin?: any;
  busConnected: boolean;
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
  onAddDevice,
  activeProjectId: _activeProjectId,
  onUpdateTopology,
  onCreateTopology,
  onDeleteTopology,
}: TopologyViewProps) {
  const navigate = useNavigate();
  const { id: projectId } = useParams();
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

  const areaRows = topology
    .filter((t: any) => t.line === null)
    .sort((a: any, b: any) => a.area - b.area);
  const lineRows = topology.filter((t: any) => t.line !== null);
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
    <div className={styles.root}>
      <SectionHeader
        title="Topology"
        count={devices.length}
        actions={[
          <ColumnPicker key="cp" cols={topoCols} onChange={saveTopoCols} />,
          <Btn
            key="csv"
            onClick={exportTopoCSV}
            color="var(--muted)"
            bg="var(--surface)"
          >
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
                  color="var(--green)"
                  bg="var(--surface)"
                >
                  + Area
                </Btn>,
              ]
            : []),
        ]}
      />
      <div className={styles.scrollArea}>
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
              <div className={styles.areaHeader}>
                {editTopoId === areaRow?.id ? (
                  <InlineEdit
                    initial={areaName}
                    fontSize={11}
                    onSave={async (v) => {
                      await onUpdateTopology!(areaRow.id, { name: v });
                      setEditTopoId(null);
                    }}
                    onCancel={() => setEditTopoId(null)}
                  />
                ) : (
                  <>
                    <span className={styles.areaTitle}>AREA {area}</span>
                    {areaName && (
                      <span className={styles.areaTitle}>— {areaName}</span>
                    )}
                    {!areaName && onUpdateTopology && areaRow && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTopoId(areaRow.id);
                        }}
                        className={styles.nameAddLink}
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
                        className={`bg ${styles.editLink}`}
                      >
                        edit
                      </span>
                    )}
                  </>
                )}
                <span className={styles.countLabel}>
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
                    className={styles.addIcon}
                  >
                    +
                  </span>
                )}
                {onDeleteTopology && areaRow && areaDevs.length === 0 && (
                  <span
                    onClick={() => onDeleteTopology(areaRow.id)}
                    title={`Delete Area ${area}`}
                    className={styles.deleteIcon}
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
                      TP: 'var(--green)',
                      RF: 'var(--amber)',
                      IP: 'var(--accent)',
                      PL: 'var(--purple)',
                    } as Record<string, any>
                  )[medium] || 'var(--dim)';
                return (
                  <div key={`line-${area}-${line}`}>
                    <div className={styles.lineHeader}>
                      <span
                        onClick={() => toggleLine(area, line)}
                        className={styles.chevron}
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
                        />
                      ) : (
                        <>
                          <span className={styles.lineTitle}>
                            Line {area}.{line}
                          </span>
                          {lineName && (
                            <span className={styles.lineName}>
                              — {lineName}
                            </span>
                          )}
                          {!lineName && onUpdateTopology && lineRow && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditTopoId(lineRow.id);
                              }}
                              className={styles.nameAddLink}
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
                              className={`bg ${styles.editLink}`}
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
                      <span className={styles.countLabel}>· {devs.length}</span>
                      {(() => {
                        const mA = devs.reduce(
                          (s: any, d: any) => s + (d.bus_current || 0),
                          0,
                        );
                        return mA > 0 ? (
                          <span className={styles.countLabel}>· {mA} mA</span>
                        ) : null;
                      })()}
                      {onAddDevice && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setAddDefaults({ area, line, medium });
                          }}
                          title="Add device to this line"
                          className={styles.addIcon}
                        >
                          +
                        </span>
                      )}
                      {onDeleteTopology && lineRow && devs.length === 0 && (
                        <span
                          onClick={() => onDeleteTopology(lineRow.id)}
                          title={`Delete Line ${area}.${line}`}
                          className={styles.deleteIcon}
                        >
                          −
                        </span>
                      )}
                      {busConnected && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/projects/${projectId}/scan`);
                            api.busScan(area, line, 200);
                          }}
                          className={`bg ${styles.scanBadge}`}
                        >
                          ⊙ SCAN
                        </span>
                      )}
                    </div>
                    {!isCollapsed && devs.length > 0 && (
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            {visibleTopoCols.map((col: any) => (
                              <TH
                                key={col.id}
                                className={
                                  col.id === 'individual_address'
                                    ? styles.colAddr
                                    : col.id === 'device_type'
                                      ? styles.colType
                                      : col.id === 'manufacturer'
                                        ? styles.colMfr
                                        : col.id === 'model'
                                          ? styles.colModel
                                          : col.id === 'order_number'
                                            ? styles.colOrder
                                            : col.id === 'serial_number'
                                              ? styles.colSerial
                                              : col.id === 'status'
                                                ? styles.colStatus
                                                : col.id === 'gas'
                                                  ? styles.colGas
                                                  : undefined
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
                              className={`rh ${styles.rowTransparentBorder}`}
                            >
                              {tcv('individual_address') && (
                                <TD className={styles.tdAddr}>
                                  <PinAddr
                                    address={d.individual_address}
                                    wtype="device"
                                    className={styles.accentMono}
                                  />
                                </TD>
                              )}
                              {tcv('name') && <TD>{d.name}</TD>}
                              {tcv('device_type') && (
                                <TD>
                                  <span className={styles.textMuted}>
                                    {d.device_type}
                                  </span>
                                </TD>
                              )}
                              {tcv('location') && spaces.length > 0 && (
                                <TD>
                                  <SpacePath
                                    spaceId={d.space_id}
                                    spaces={spaces}
                                    className={styles.dimLocPath}
                                  />
                                </TD>
                              )}
                              {tcv('manufacturer') && (
                                <TD>
                                  <PinAddr
                                    address={d.manufacturer}
                                    wtype="manufacturer"
                                    className={styles.amberPinAddr}
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
                                    className={styles.amberModelPinAddr}
                                  >
                                    {localizedModel(d) || '—'}
                                  </PinAddr>
                                </TD>
                              )}
                              {tcv('order_number') && (
                                <TD>
                                  <span className={styles.monoSmall}>
                                    {d.order_number || '—'}
                                  </span>
                                </TD>
                              )}
                              {tcv('serial_number') && (
                                <TD>
                                  <span className={styles.monoSmall}>
                                    {d.serial_number || '—'}
                                  </span>
                                </TD>
                              )}
                              {tcv('status') && (
                                <TD>
                                  <Badge
                                    label={d.status.toUpperCase()}
                                    color={
                                      STATUS_COLOR[d.status] || 'var(--dim)'
                                    }
                                  />
                                </TD>
                              )}
                              {tcv('gas') && (
                                <TD>
                                  <span className={styles.textDim}>
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
      <div className={styles.statusBar}>
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span
            key={s}
            className={`rh ${styles.statusItem}`}
            onClick={() => setStatusFilter((p) => (p === s ? 'all' : s))}
            style={{
              color: statusFilter === s ? c : 'var(--dim)',
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
}: {
  initial: string;
  fontSize?: number;
  onSave: (v: string) => Promise<void>;
  onCancel: () => void;
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
    <div onClick={(e) => e.stopPropagation()} className={styles.inlineEditWrap}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        className={styles.inlineEditInput}
        style={{ fontSize }}
      />
      <Btn
        onClick={save}
        disabled={saving || !value.trim()}
        color="var(--green)"
      >
        {saving ? 'Saving' : 'Save'}
      </Btn>
      <Btn onClick={onCancel} color="var(--dim)">
        Cancel
      </Btn>
    </div>
  );
}
