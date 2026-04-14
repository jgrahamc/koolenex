import { useState, useContext, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { STATUS_COLOR, I18nCtx } from '../theme.ts';
import { PinContext, useAppData, useProjectActions } from '../contexts.ts';
import {
  Badge,
  Btn,
  Chip,
  TH,
  TD,
  SearchBox,
  SectionHeader,
  Empty,
  PinAddr,
} from '../primitives.tsx';
import { SpaceTypeIcon, DeviceTypeIcon } from '../icons.tsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { spaceUsageMap, localizedModel } from '../dpt.ts';
import type { Space, Device } from '../../../shared/types.ts';
import { AddDeviceModal } from '../AddDeviceModal.tsx';
import { usePersistedSet } from '../hooks/usePersistedState.ts';
import styles from './LocationsView.module.css';

export function LocationsView() {
  const { projectData: data, activeProjectId: projectId } = useAppData();
  const {
    addDevice: onAddDevice,
    updateDevice: onUpdateDevice,
    updateSpace: onUpdateSpace,
    createSpace: onCreateSpace,
    deleteSpace: onDeleteSpace,
  } = useProjectActions();
  const navigate = useNavigate();
  const pin = useContext(PinContext);
  const { t: i18t } = useContext(I18nCtx);
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
  };
  const { spaces = [], devices = [], deviceGAMap = {} } = data || {};
  const [search, setSearch] = useState('');
  const [addDefaults, setAddDefaults] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [spaceSort, setSpaceSort] = useState(
    () => localStorage.getItem('knx-loc-sort') || 'import',
  );
  const [editSpaceId, setEditSpaceId] = useState<any>(null);
  const [editDevId, setEditDevId] = useState<any>(null);
  const [addSpaceParent, setAddSpaceParent] = useState<any>(null); // null = not adding, { parentId, defaultType }
  const [collapsed, setCollapsed] = usePersistedSet(
    'knx-loc-collapsed',
    () =>
      new Set(
        spaces.filter((s: any) => s.parent_id).map((s: any) => String(s.id)),
      ),
  );
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const LOC_COLS = useMemo(
    () => [
      { id: 'individual_address', label: 'Address', visible: true },
      { id: 'name', label: 'Name', visible: true },
      { id: 'device_type', label: 'Type', visible: true },
      { id: 'manufacturer', label: 'Manufacturer', visible: true },
      { id: 'model', label: 'Model', visible: true },
      { id: 'serial_number', label: 'Serial', visible: false },
      { id: 'status', label: 'Status', visible: true },
      { id: 'gas', label: 'GAs', visible: true },
    ],
    [],
  );
  const [locCols, saveLocCols] = useColumns('locations', LOC_COLS);
  const lcv = (id: string) =>
    locCols.find((c: any) => c.id === id)?.visible !== false;
  const visibleLocCols = locCols.filter((c: any) => c.visible !== false);

  if (!spaces.length)
    return (
      <div className={styles.root}>
        <SectionHeader title="Locations" count={0} />
        <Empty
          icon="◻"
          msg="No location data in this project — location info is stored in ETS under the Buildings tab"
        />
      </div>
    );

  // Build tree
  interface SpaceNode extends Space {
    children: SpaceNode[];
    devs: Device[];
  }
  const nodeMap: Record<string, SpaceNode> = {};
  for (const s of spaces)
    nodeMap[s.id] = { ...s, children: [], devs: [] } as SpaceNode;
  const roots: SpaceNode[] = [];
  for (const s of spaces) {
    if (s.parent_id && nodeMap[s.parent_id])
      nodeMap[s.parent_id]!.children.push(nodeMap[s.id]!);
    else roots.push(nodeMap[s.id]!);
  }
  const sortSpaces = (arr: SpaceNode[]) =>
    arr.sort((a, b) =>
      spaceSort === 'name'
        ? a.name.localeCompare(b.name)
        : (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.name.localeCompare(b.name),
    );
  sortSpaces(roots);
  for (const n of Object.values(nodeMap)) {
    sortSpaces(n.children);
  }
  for (const d of devices) {
    if (d.space_id && nodeMap[d.space_id]) nodeMap[d.space_id]!.devs.push(d);
  }
  for (const n of Object.values(nodeMap)) {
    n.devs.sort((a, b) => a.name.localeCompare(b.name));
  }

  const sq = search.toLowerCase();
  const matchesSearch = (node: SpaceNode): boolean => {
    if (!sq) return true;
    if (node.name.toLowerCase().includes(sq)) return true;
    if (
      node.devs.some(
        (d) =>
          d.name.toLowerCase().includes(sq) ||
          d.individual_address.includes(sq),
      )
    )
      return true;
    return node.children.some((c) => matchesSearch(c));
  };

  const exportLocCSV = () => {
    const allDevs = devices.filter(
      (d: any) =>
        (filterStatus === 'all' || d.status === filterStatus) &&
        (!sq ||
          d.name.toLowerCase().includes(sq) ||
          d.individual_address.includes(sq)),
    );
    dlCSV(
      'koolenex-locations.csv',
      locCols,
      allDevs,
      (id: string, d: any) =>
        ({
          individual_address: d.individual_address,
          name: d.name,
          device_type: d.device_type,
          manufacturer: d.manufacturer || '',
          model: d.model || '',
          serial_number: d.serial_number || '',
          status: d.status,
          gas: (deviceGAMap[d.individual_address] || []).length,
        })[id] ?? '',
    );
  };

  const renderSpace = (node: any, depth: number): React.ReactNode => {
    if (!matchesSearch(node)) return null;
    const isCollapsed = sq ? false : collapsed.has(node.id);
    const hasChildren = node.children.length > 0 || node.devs.length > 0;
    const filteredDevs = node.devs.filter(
      (d: any) =>
        (filterStatus === 'all' || d.status === filterStatus) &&
        (!sq ||
          d.name.toLowerCase().includes(sq) ||
          d.individual_address.includes(sq)),
    );
    return (
      <div key={`sp-${node.id}`}>
        <div
          className={styles.spaceRow}
          style={{
            padding:
              depth === 0 ? '6px 14px' : `5px 14px 5px ${14 + depth * 18}px`,
            background:
              depth === 0
                ? 'var(--surface)'
                : depth === 1
                  ? 'var(--hover)'
                  : 'transparent',
            cursor: hasChildren ? 'pointer' : 'default',
          }}
          onClick={() => hasChildren && toggleCollapse(node.id)}
        >
          {hasChildren ? (
            <span className={styles.chevronSmall}>
              {isCollapsed ? '▸' : '▾'}
            </span>
          ) : (
            <span className={styles.spacerSmall} />
          )}
          <span
            style={{ color: depth === 0 ? 'var(--amber)' : 'var(--dim)' }}
            title={node.type}
          >
            <SpaceTypeIcon type={node.type} size={13} />
          </span>
          {editSpaceId === node.id ? (
            <InlineEdit
              initial={node.name}
              fontSize={depth === 0 ? 11 : 10}
              onSave={async (v) => {
                await onUpdateSpace!(node.id, { name: v });
                setEditSpaceId(null);
              }}
              onCancel={() => setEditSpaceId(null)}
            />
          ) : (
            <span
              className={pin ? 'pa' : undefined}
              data-pin={pin ? '1' : undefined}
              style={{
                fontWeight: depth <= 1 ? 600 : 400,
                fontSize: depth === 0 ? 11 : 10,
                color:
                  depth === 0
                    ? 'var(--amber)'
                    : pin
                      ? 'var(--amber)'
                      : 'var(--text)',
                cursor: pin ? 'pointer' : 'default',
              }}
              onClick={
                pin
                  ? (e) => {
                      e.stopPropagation();
                      pin('space', String(node.id));
                    }
                  : undefined
              }
            >
              {node.name}
            </span>
          )}
          {editSpaceId !== node.id && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                setEditSpaceId(node.id);
              }}
              title="Rename"
              className={`bg ${styles.editLink}`}
            >
              edit
            </span>
          )}
          {node.type === 'Room' && spaceUsageMap()[node.usage_id] && (
            <span className={styles.usageLabel}>
              · {i18t(node.usage_id) || spaceUsageMap()[node.usage_id]}
            </span>
          )}
          {node.type === 'Floor' && projectId && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/projects/${projectId}/floorplan`, {
                  state: { jumpTo: node.id },
                });
              }}
              title="View floor plan"
              className={styles.floorPlanLink}
            >
              floor plan
            </span>
          )}
          <AddMenu
            nodeId={node.id}
            nodeType={node.type}
            nodeName={node.name}
            onAddDevice={() => setAddDefaults({ space_id: node.id })}
            onAddSpace={() => {
              const childType =
                node.type === 'Building'
                  ? 'Floor'
                  : node.type === 'Floor'
                    ? 'Room'
                    : 'Room';
              setAddSpaceParent({
                parentId: node.id,
                defaultType: childType,
              });
            }}
          />
          {onDeleteSpace && node.devs.length === 0 && (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSpace(node.id);
              }}
              title={`Delete ${node.name}`}
              className={styles.deleteIcon}
            >
              −
            </span>
          )}
          {(filteredDevs.length > 0 || node.children.length > 0) && (
            <span className={styles.countLabel}>
              ·{' '}
              {filteredDevs.length +
                node.children.reduce((s: any, c: any) => s + c.devs.length, 0)}
            </span>
          )}
        </div>
        {addSpaceParent?.parentId === node.id && (
          <AddSpaceForm
            parentId={node.id}
            defaultType={addSpaceParent.defaultType}
            onSave={async (body) => {
              await onCreateSpace!(body);
              setAddSpaceParent(null);
            }}
            onCancel={() => setAddSpaceParent(null)}
          />
        )}
        {!isCollapsed && (
          <>
            {filteredDevs.length > 0 && (
              <table className={styles.table}>
                <thead>
                  <tr>
                    {visibleLocCols.map((col: any) => (
                      <TH
                        key={col.id}
                        className={
                          col.id === 'individual_address'
                            ? styles.colAddr
                            : col.id === 'gas'
                              ? styles.colGas
                              : col.id === 'status'
                                ? styles.colStatus
                                : undefined
                        }
                        style={
                          col.id === 'individual_address'
                            ? { paddingLeft: 14 + depth * 18 + 28 }
                            : {}
                        }
                      >
                        {col.label.toUpperCase().replace('GAS', 'GAs')}
                      </TH>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredDevs.map((d: any) => (
                    <tr key={d.id} className={`rh ${styles.rowBorder}`}>
                      {lcv('individual_address') && (
                        <TD style={{ paddingLeft: 14 + depth * 18 + 28 }}>
                          <PinAddr
                            address={d.individual_address}
                            wtype="device"
                            className={styles.accentMono}
                          />
                        </TD>
                      )}
                      {lcv('name') && (
                        <TD>
                          {editDevId === d.id ? (
                            <InlineEdit
                              initial={d.name}
                              fontSize={11}
                              onSave={async (v) => {
                                await onUpdateDevice!(d.id, { name: v });
                                setEditDevId(null);
                              }}
                              onCancel={() => setEditDevId(null)}
                            />
                          ) : (
                            <span className={styles.devNameWrap}>
                              <DeviceTypeIcon
                                type={d.device_type}
                                style={{
                                  color:
                                    COLMAP[d.device_type] || 'var(--muted)',
                                }}
                              />
                              <span
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditDevId(d.id);
                                }}
                                style={{
                                  cursor: 'text',
                                }}
                                title="Click to rename"
                              >
                                {d.name}
                              </span>
                            </span>
                          )}
                        </TD>
                      )}
                      {lcv('device_type') && (
                        <TD>
                          <span className={styles.textMuted}>
                            {d.device_type}
                          </span>
                        </TD>
                      )}
                      {lcv('manufacturer') && (
                        <TD>
                          <PinAddr
                            address={d.manufacturer}
                            wtype="manufacturer"
                            className={styles.amberText}
                          >
                            {d.manufacturer || '—'}
                          </PinAddr>
                        </TD>
                      )}
                      {lcv('model') && (
                        <TD>
                          <PinAddr
                            address={d.model}
                            wtype="model"
                            className={styles.amberMono}
                          >
                            {localizedModel(d) || '—'}
                          </PinAddr>
                        </TD>
                      )}
                      {lcv('serial_number') && (
                        <TD>
                          <span className={styles.monoSmall}>
                            {d.serial_number || '—'}
                          </span>
                        </TD>
                      )}
                      {lcv('status') && (
                        <TD>
                          <Badge
                            label={d.status.toUpperCase()}
                            color={STATUS_COLOR[d.status] || 'var(--dim)'}
                          />
                        </TD>
                      )}
                      {lcv('gas') && (
                        <TD>
                          <span className={styles.textDim}>
                            {(deviceGAMap[d.individual_address] || []).length}
                          </span>
                        </TD>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {node.children.map((child: any) => renderSpace(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const unplaced = devices
    .filter((d: any) => !d.space_id)
    .filter(
      (d: any) =>
        (filterStatus === 'all' || d.status === filterStatus) &&
        (!sq ||
          d.name.toLowerCase().includes(sq) ||
          d.individual_address.includes(sq)),
    );

  return (
    <div className={styles.root}>
      <SectionHeader
        title="Locations"
        count={spaces.length}
        actions={[
          <SearchBox
            key="s"
            value={search}
            onChange={setSearch}
            placeholder="Search spaces or devices…"
          />,
          <Chip
            key="si"
            active={spaceSort === 'import'}
            onClick={() => {
              setSpaceSort('import');
              localStorage.setItem('knx-loc-sort', 'import');
            }}
          >
            Import Order
          </Chip>,
          <Chip
            key="sn"
            active={spaceSort === 'name'}
            onClick={() => {
              setSpaceSort('name');
              localStorage.setItem('knx-loc-sort', 'name');
            }}
          >
            By Name
          </Chip>,
          <ColumnPicker key="cp" cols={locCols} onChange={saveLocCols} />,
          <Btn
            key="csv"
            onClick={exportLocCSV}
            color="var(--muted)"
            bg="var(--surface)"
          >
            ↓ CSV
          </Btn>,
          <Btn
            key="add"
            onClick={() =>
              setAddSpaceParent({
                parentId: null,
                defaultType: 'Building',
              })
            }
            color="var(--green)"
            bg="var(--surface)"
          >
            + Building
          </Btn>,
        ]}
      />
      <div className={styles.scrollArea}>
        {addSpaceParent?.parentId === null && (
          <AddSpaceForm
            parentId={null}
            defaultType="Building"
            onSave={async (body) => {
              await onCreateSpace!(body);
              setAddSpaceParent(null);
            }}
            onCancel={() => setAddSpaceParent(null)}
          />
        )}
        {roots.map((r) => renderSpace(r, 0))}
        {unplaced.length > 0 && (
          <div>
            <div className={styles.unplacedHeader}>
              <span className={styles.unplacedIcon}>◉</span>
              <span className={styles.unplacedTitle}>Unplaced</span>
              <span className={styles.countLabel}>· {unplaced.length}</span>
            </div>
            <table className={styles.table}>
              <thead>
                <tr>
                  {visibleLocCols.map((col: any) => (
                    <TH
                      key={col.id}
                      className={
                        col.id === 'individual_address'
                          ? styles.colAddrIndented
                          : col.id === 'gas'
                            ? styles.colGas
                            : col.id === 'status'
                              ? styles.colStatus
                              : undefined
                      }
                    >
                      {col.label.toUpperCase().replace('GAS', 'GAs')}
                    </TH>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unplaced.map((d: any) => (
                  <tr key={d.id} className={`rh ${styles.rowBorder}`}>
                    {lcv('individual_address') && (
                      <TD className={styles.tdIndented}>
                        <PinAddr
                          address={d.individual_address}
                          wtype="device"
                          className={styles.accentMono}
                        />
                      </TD>
                    )}
                    {lcv('name') && (
                      <TD>
                        {editDevId === d.id ? (
                          <InlineEdit
                            initial={d.name}
                            fontSize={11}
                            onSave={async (v) => {
                              await onUpdateDevice!(d.id, { name: v });
                              setEditDevId(null);
                            }}
                            onCancel={() => setEditDevId(null)}
                          />
                        ) : (
                          <span className={styles.devNameWrap}>
                            <DeviceTypeIcon
                              type={d.device_type}
                              style={{
                                color: COLMAP[d.device_type] || 'var(--muted)',
                              }}
                            />
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditDevId(d.id);
                              }}
                              className={styles.renameable}
                              title="Click to rename"
                            >
                              {d.name}
                            </span>
                          </span>
                        )}
                      </TD>
                    )}
                    {lcv('device_type') && (
                      <TD>
                        <span className={styles.textMuted}>
                          {d.device_type}
                        </span>
                      </TD>
                    )}
                    {lcv('manufacturer') && (
                      <TD>
                        <PinAddr
                          address={d.manufacturer}
                          wtype="manufacturer"
                          className={styles.amberText}
                        >
                          {d.manufacturer || '—'}
                        </PinAddr>
                      </TD>
                    )}
                    {lcv('model') && (
                      <TD>
                        <PinAddr
                          address={d.model}
                          wtype="model"
                          className={styles.amberMono}
                        >
                          {d.model || '—'}
                        </PinAddr>
                      </TD>
                    )}
                    {lcv('serial_number') && (
                      <TD>
                        <span className={styles.monoSmall}>
                          {d.serial_number || '—'}
                        </span>
                      </TD>
                    )}
                    {lcv('status') && (
                      <TD>
                        <Badge
                          label={d.status.toUpperCase()}
                          color={STATUS_COLOR[d.status] || 'var(--dim)'}
                        />
                      </TD>
                    )}
                    {lcv('gas') && (
                      <TD>
                        <span className={styles.textDim}>
                          {(deviceGAMap[d.individual_address] || []).length}
                        </span>
                      </TD>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className={styles.statusBar}>
        {Object.entries(STATUS_COLOR).map(([s, c]) => (
          <span
            key={s}
            className={`rh ${filterStatus === s ? styles.statusItemActive : styles.statusItem}`}
            onClick={() => setFilterStatus((p) => (p === s ? 'all' : s))}
            style={{ color: filterStatus === s ? c : 'var(--dim)' }}
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

function AddMenu({
  nodeId: _nodeId,
  nodeType: _nodeType,
  nodeName: _nodeName,
  onAddDevice,
  onAddSpace,
}: {
  nodeId: any;
  nodeType: any;
  nodeName: any;
  onAddDevice: (() => void) | null;
  onAddSpace: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const options = [
    onAddDevice && { label: 'Add device', action: onAddDevice },
    onAddSpace && { label: 'Add space', action: onAddSpace },
  ].filter(Boolean) as { label: string; action: () => void }[];
  if (options.length === 0) return null;
  if (options.length === 1) {
    return (
      <span
        onClick={(e) => {
          e.stopPropagation();
          options[0]!.action();
        }}
        title={options[0]!.label}
        className={styles.addIcon}
      >
        +
      </span>
    );
  }
  return (
    <span className={styles.addMenuWrap}>
      <span
        onClick={(e) => {
          e.stopPropagation();
          setOpen((p) => !p);
        }}
        title="Add…"
        className={styles.addMenuIcon}
      >
        +
      </span>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            className={styles.addMenuBackdrop}
          />
          <div className={styles.addMenuDropdown}>
            {options.map((o) => (
              <div
                key={o.label}
                onClick={(e) => {
                  e.stopPropagation();
                  o.action();
                  setOpen(false);
                }}
                className={`rh ${styles.addMenuItem}`}
              >
                {o.label}
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

const SPACE_TYPES = [
  'Building',
  'Floor',
  'Room',
  'Corridor',
  'Stairway',
  'DistributionBoard',
];

function AddSpaceForm({
  parentId,
  defaultType,
  onSave,
  onCancel,
}: {
  parentId: any;
  defaultType: string;
  onSave: (body: any) => Promise<void>;
  onCancel: () => void;
}) {
  const { t: i18t } = useContext(I18nCtx);
  const [name, setName] = useState('');
  const [type, setType] = useState(defaultType || 'Room');
  const [usageId, setUsageId] = useState('');
  const [saving, setSaving] = useState(false);
  const usages = spaceUsageMap();
  const usageEntries = Object.entries(usages).sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        type,
        parent_id: parentId,
        usage_id: usageId,
      });
    } catch (_) {}
    setSaving(false);
  };
  return (
    <div className={styles.addSpaceForm}>
      <select
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          if (e.target.value !== 'Room') setUsageId('');
        }}
        className={styles.selectInput}
      >
        {SPACE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {type === 'Room' && usageEntries.length > 0 && (
        <select
          value={usageId}
          onChange={(e) => setUsageId(e.target.value)}
          className={styles.selectInput}
        >
          <option value="">— Use —</option>
          {usageEntries.map(([id, text]) => (
            <option key={id} value={id}>
              {i18t(id) || text}
            </option>
          ))}
        </select>
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        className={styles.nameInput}
      />
      <Btn
        onClick={save}
        disabled={saving || !name.trim()}
        color="var(--green)"
      >
        {saving ? 'Creating…' : 'Create'}
      </Btn>
      <Btn onClick={onCancel} color="var(--dim)">
        Cancel
      </Btn>
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
