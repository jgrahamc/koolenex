import { useState, useEffect, useMemo, useContext } from 'react';
import { compareAddr } from '../../../shared/address.ts';
import type { Device } from '../../../shared/types.ts';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { STATUS_COLOR } from '../theme.ts';
import { localizedModel } from '../dpt.ts';
import {
  Badge,
  Chip,
  Btn,
  TH,
  TD,
  SearchBox,
  SectionHeader,
  Empty,
  PinAddr,
  DeviceAddr,
  SpacePath,
} from '../primitives.tsx';
import { field, useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { RtfText } from '../rtf.tsx';
import { AddDeviceModal } from '../AddDeviceModal.tsx';
import { useSpacePath } from '../hooks/spaces.ts';
import { usePersistedState } from '../hooks/usePersistedState.ts';
import { useAppData, useProjectActions, PinContext } from '../contexts.ts';
import styles from './DevicesView.module.css';
import { DEVICE_COLUMNS, deviceColClass } from '../deviceColumns.ts';

export function DevicesView() {
  const { projectData: data } = useAppData();
  const { addDevice: onAddDevice, updateDevice: onUpdateDevice } =
    useProjectActions();
  const onPin = useContext(PinContext);
  const navigate = useNavigate();
  const location = useLocation();
  const { id: projectId } = useParams();
  const jumpTo = location.state?.jumpTo;
  const [search, setSearch] = useState('');
  const [sort, setSort] = usePersistedState('knx-devices-sort', {
    col: 'individual_address',
    dir: 1,
  });
  const [filterStatus, setFilterStatus] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [editDevId, setEditDevId] = useState<number | null>(null);
  const {
    devices = [],
    gas: _gas = [],
    deviceGAMap = {},
    spaces = [],
  } = data || {};

  const [cols, saveCols] = useColumns('devices', DEVICE_COLUMNS);
  const cv = (id: string) => cols.find((c) => c.id === id)?.visible !== false;

  const { spacePath } = useSpacePath(spaces);

  useEffect(() => {
    if (!jumpTo) return;
    const addr = typeof jumpTo === 'string' ? jumpTo : jumpTo.address;
    const d = devices.find((d) => d.individual_address === addr);
    if (d) {
      onPin?.('device', d.individual_address);
      setSearch('');
      setFilterStatus('all');
    }
  }, [jumpTo]);

  const filtered = devices
    .filter((d) => {
      if (filterStatus !== 'all' && d.status !== filterStatus) return false;
      const s = search.toLowerCase();
      if (!s) return true;
      const gaCount = String((deviceGAMap[d.individual_address] || []).length);
      const space = spacePath(d.space_id);
      return (
        d.name.toLowerCase().includes(s) ||
        d.individual_address.includes(s) ||
        d.manufacturer?.toLowerCase().includes(s) ||
        d.model?.toLowerCase().includes(s) ||
        d.serial_number?.toLowerCase().includes(s) ||
        d.order_number?.toLowerCase().includes(s) ||
        d.description?.toLowerCase().includes(s) ||
        d.device_type?.toLowerCase().includes(s) ||
        d.status?.toLowerCase().includes(s) ||
        space.toLowerCase().includes(s) ||
        gaCount === s
      );
    })
    .sort((a, b) => {
      if (sort.col === 'individual_address')
        return (
          compareAddr(a.individual_address, b.individual_address) * sort.dir
        );
      return (
        String(field(a, sort.col) ?? '').localeCompare(
          String(field(b, sort.col) ?? ''),
        ) * sort.dir
      );
    });

  const [groupMode, setGroupMode] = useState(false);
  const [groupExpanded, setGroupExpanded] = useState<Record<string, boolean>>(
    {},
  );
  const groupTree = useMemo(() => {
    if (!groupMode) return null;
    const mfrs: Record<string, Record<string, typeof filtered>> = {};
    for (const d of filtered) {
      const mfr = d.manufacturer || '(Unknown)';
      const mdl = d.model || '(Unknown)';
      if (!mfrs[mfr]) mfrs[mfr] = {};
      if (!mfrs[mfr]![mdl]) mfrs[mfr]![mdl] = [];
      mfrs[mfr]![mdl]!.push(d);
    }
    return Object.entries(mfrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mfr, models]) => ({
        name: mfr,
        models: Object.entries(models)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mdl, devs]) => ({ name: mdl, devices: devs })),
      }));
  }, [groupMode, filtered]);
  const isGrpOpen = (key: string) => groupExpanded[key] !== false;
  const toggleGrp = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setGroupExpanded((p) => ({ ...p, [key]: !p[key] }));
  };

  const exportDevCSV = () =>
    dlCSV(
      'koolenex-devices.csv',
      cols,
      filtered,
      (id: string, d: Device) =>
        ({
          individual_address: d.individual_address,
          name: d.name,
          device_type: d.device_type,
          location: spacePath(d.space_id),
          manufacturer: d.manufacturer,
          model: d.model,
          order_number: d.order_number,
          serial_number: d.serial_number,
          status: d.status,
          gas: (deviceGAMap[d.individual_address] || []).length,
          description: d.description,
          comment: d.comment || '',
          area: d.area,
          line: d.line,
          last_download: d.last_download,
        })[id] ?? '',
    );

  const sortBy = (col: string) =>
    setSort((s) => ({ col, dir: s.col === col ? -s.dir : 1 }));
  const SortTH = ({
    col,
    children,
    ...rest
  }: {
    col: string;
    children: React.ReactNode;
    // Everything else is forwarded straight to TH (className, style, ...).
    [key: string]: unknown;
  }) => (
    <TH {...rest}>
      <span onClick={() => sortBy(col)} className={styles.sortHeader}>
        {children}
        {sort.col === col && (
          <span className={styles.sortArrow}>{sort.dir > 0 ? '↑' : '↓'}</span>
        )}
      </span>
    </TH>
  );

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <SectionHeader
          title="Devices"
          count={filtered.length}
          actions={[
            <SearchBox
              key="s"
              value={search}
              onChange={setSearch}
              placeholder="Search devices…"
            />,
            ...['all', 'programmed', 'modified', 'unassigned'].map((s) => (
              <Chip
                key={s}
                active={filterStatus === s}
                onClick={() => setFilterStatus(s)}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </Chip>
            )),
            <ColumnPicker key="cp" cols={cols} onChange={saveCols} />,
            <Btn
              key="grp"
              onClick={() => setGroupMode((g) => !g)}
              color={groupMode ? 'var(--accent)' : 'var(--muted)'}
              bg="var(--surface)"
            >
              {groupMode ? '⊞ Grouped' : '⊞ Group'}
            </Btn>,
            <Btn
              key="csv"
              onClick={exportDevCSV}
              color="var(--muted)"
              bg="var(--surface)"
            >
              ↓ CSV
            </Btn>,
            <Btn
              key="print"
              onClick={() => navigate(`/projects/${projectId}/labels`)}
              color="var(--muted)"
              bg="var(--surface)"
            >
              ⎙ Labels
            </Btn>,
            <Btn
              key="add"
              onClick={() => setShowAdd(true)}
              color="var(--green)"
              bg="var(--surface)"
            >
              + Add
            </Btn>,
          ]}
        />
        <div className={styles.scrollArea}>
          {groupMode ? (
            <div>
              {(groupTree || []).map((mfr) => {
                const mfrKey = `m:${mfr.name}`;
                const mfrOpen = isGrpOpen(mfrKey);
                const mfrTotal = mfr.models.reduce(
                  (s, m) => s + m.devices.length,
                  0,
                );
                return (
                  <div key={mfrKey}>
                    <div className={styles.grpMfrHeader}>
                      <span
                        onClick={(e) => toggleGrp(mfrKey, e)}
                        className={styles.chevron}
                      >
                        {mfrOpen ? '▾' : '▸'}
                      </span>
                      <PinAddr
                        address={mfr.name}
                        wtype="manufacturer"
                        className={styles.grpMfrPinAddr}
                      >
                        {mfr.name}
                      </PinAddr>
                      <span className={styles.countLabel}>
                        · {mfrTotal} devices · {mfr.models.length} models
                      </span>
                    </div>
                    {mfrOpen &&
                      mfr.models.map((mdl) => {
                        const mdlKey = `m:${mfr.name}:${mdl.name}`;
                        const mdlOpen = isGrpOpen(mdlKey);
                        return (
                          <div key={mdlKey}>
                            <div className={styles.grpMdlHeader}>
                              <span
                                onClick={(e) => toggleGrp(mdlKey, e)}
                                className={styles.chevron}
                              >
                                {mdlOpen ? '▾' : '▸'}
                              </span>
                              <PinAddr
                                address={mdl.name}
                                wtype="model"
                                className={styles.grpMdlPinAddr}
                              >
                                {mdl.name}
                              </PinAddr>
                              <span className={styles.countLabel}>
                                · {mdl.devices.length}
                              </span>
                            </div>
                            {mdlOpen && (
                              <table className={styles.grpTable}>
                                <thead>
                                  <tr>
                                    {cols
                                      .filter((c) => c.visible !== false)
                                      .map((col) => {
                                        if (
                                          col.id === 'location' &&
                                          !spaces.length
                                        )
                                          return null;
                                        const cls = deviceColClass(
                                          styles,
                                          col.id,
                                          { indentedAddress: true },
                                        );
                                        return (
                                          <TH key={col.id} className={cls}>
                                            {col.label
                                              .toUpperCase()
                                              .replace('GAS', 'GAs')}
                                          </TH>
                                        );
                                      })}
                                  </tr>
                                </thead>
                                <tbody>
                                  {mdl.devices.map(
                                    (d: (typeof filtered)[0]) => (
                                      <tr
                                        key={d.id}
                                        className={`rh ${styles.rowClickable}`}
                                        onClick={() =>
                                          onPin?.(
                                            'device',
                                            d.individual_address,
                                          )
                                        }
                                      >
                                        {cv('individual_address') && (
                                          <TD className={styles.tdIndented}>
                                            <DeviceAddr
                                              device={d}
                                              wtype="device"
                                              className={styles.accentMono}
                                            />
                                          </TD>
                                        )}
                                        {cv('name') && (
                                          <TD>
                                            {editDevId === d.id ? (
                                              <InlineEdit
                                                initial={d.name}
                                                fontSize={11}
                                                onSave={async (v) => {
                                                  await onUpdateDevice!(d.id, {
                                                    name: v,
                                                  });
                                                  setEditDevId(null);
                                                }}
                                                onCancel={() =>
                                                  setEditDevId(null)
                                                }
                                              />
                                            ) : (
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
                                            )}
                                          </TD>
                                        )}
                                        {cv('device_type') && (
                                          <TD>
                                            <span className={styles.textMuted}>
                                              {d.device_type}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('location') &&
                                          spaces.length > 0 && (
                                            <TD>
                                              <SpacePath
                                                spaceId={d.space_id}
                                                spaces={spaces}
                                                className={styles.dimLocPath}
                                              />
                                            </TD>
                                          )}
                                        {cv('manufacturer') && (
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
                                        {cv('model') && (
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
                                        {cv('order_number') && (
                                          <TD>
                                            <span className={styles.monoSmall}>
                                              {d.order_number || '—'}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('serial_number') && (
                                          <TD>
                                            <span className={styles.monoSmall}>
                                              {d.serial_number || '—'}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('status') && (
                                          <TD>
                                            <Badge
                                              label={d.status.toUpperCase()}
                                              color={
                                                STATUS_COLOR[d.status] ||
                                                'var(--dim)'
                                              }
                                            />
                                          </TD>
                                        )}
                                        {cv('gas') && (
                                          <TD>
                                            <span className={styles.textDim}>
                                              {
                                                (
                                                  deviceGAMap[
                                                    d.individual_address
                                                  ] || []
                                                ).length
                                              }
                                            </span>
                                          </TD>
                                        )}
                                        {cv('description') && (
                                          <TD>
                                            <span className={styles.dimSmall}>
                                              {d.description &&
                                              d.description !== d.name
                                                ? d.description
                                                : ''}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('comment') && (
                                          <TD>
                                            <span className={styles.dimSmall}>
                                              <RtfText value={d.comment} />
                                            </span>
                                          </TD>
                                        )}
                                        {cv('area') && (
                                          <TD>
                                            <span className={styles.textDim}>
                                              {d.area}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('line') && (
                                          <TD>
                                            <span className={styles.textDim}>
                                              {d.line}
                                            </span>
                                          </TD>
                                        )}
                                        {cv('last_download') && (
                                          <TD>
                                            <span className={styles.dimSmall}>
                                              {d.last_download || '—'}
                                            </span>
                                          </TD>
                                        )}
                                      </tr>
                                    ),
                                  )}
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
            <table className={styles.table}>
              <thead>
                <tr>
                  {cols
                    .filter((c) => c.visible !== false)
                    .map((col) => {
                      if (col.id === 'location' && !spaces.length) return null;
                      const sortable = [
                        'individual_address',
                        'name',
                        'device_type',
                        'manufacturer',
                        'model',
                        'serial_number',
                        'status',
                      ].includes(col.id);
                      const cls = deviceColClass(styles, col.id);
                      if (sortable) {
                        return (
                          <SortTH key={col.id} col={col.id} className={cls}>
                            {col.label.toUpperCase().replace('GAS', 'GAs')}
                          </SortTH>
                        );
                      }
                      return (
                        <TH key={col.id} className={cls}>
                          {col.label.toUpperCase().replace('GAS', 'GAs')}
                        </TH>
                      );
                    })}
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr
                    key={d.id}
                    className={`rh ${styles.rowClickable}`}
                    onClick={() => onPin?.('device', d.individual_address)}
                  >
                    {cv('individual_address') && (
                      <TD>
                        <DeviceAddr
                          device={d}
                          wtype="device"
                          className={styles.accentMono}
                        />
                      </TD>
                    )}
                    {cv('name') && (
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
                        )}
                      </TD>
                    )}
                    {cv('device_type') && (
                      <TD>
                        <span className={styles.textMuted}>
                          {d.device_type}
                        </span>
                      </TD>
                    )}
                    {cv('location') && spaces.length > 0 && (
                      <TD>
                        <SpacePath
                          spaceId={d.space_id}
                          spaces={spaces}
                          className={styles.dimLocPath}
                        />
                      </TD>
                    )}
                    {cv('manufacturer') && (
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
                    {cv('model') && (
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
                    {cv('order_number') && (
                      <TD>
                        <span className={styles.monoSmall}>
                          {d.order_number || '—'}
                        </span>
                      </TD>
                    )}
                    {cv('serial_number') && (
                      <TD>
                        <span className={styles.monoSmall}>
                          {d.serial_number || '—'}
                        </span>
                      </TD>
                    )}
                    {cv('status') && (
                      <TD>
                        <Badge
                          label={d.status.toUpperCase()}
                          color={STATUS_COLOR[d.status] || 'var(--dim)'}
                        />
                      </TD>
                    )}
                    {cv('gas') && (
                      <TD>
                        <span className={styles.textDim}>
                          {(deviceGAMap[d.individual_address] || []).length}
                        </span>
                      </TD>
                    )}
                    {cv('description') && (
                      <TD>
                        <span className={styles.dimSmall}>
                          {d.description && d.description !== d.name
                            ? d.description
                            : ''}
                        </span>
                      </TD>
                    )}
                    {cv('comment') && (
                      <TD>
                        <span className={styles.dimSmall}>
                          <RtfText value={d.comment} />
                        </span>
                      </TD>
                    )}
                    {cv('area') && (
                      <TD>
                        <span className={styles.textDim}>{d.area}</span>
                      </TD>
                    )}
                    {cv('line') && (
                      <TD>
                        <span className={styles.textDim}>{d.line}</span>
                      </TD>
                    )}
                    {cv('last_download') && (
                      <TD>
                        <span className={styles.dimSmall}>
                          {d.last_download || '—'}
                        </span>
                      </TD>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {filtered.length === 0 && <Empty msg="No devices match" />}
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
              {devices.filter((d) => d.status === s).length} {s}
            </span>
          ))}
        </div>
      </div>
      {showAdd && onAddDevice && (
        <AddDeviceModal
          data={data}
          defaults={{}}
          onAdd={onAddDevice}
          onClose={() => setShowAdd(false)}
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
