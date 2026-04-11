import { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from '../primitives.tsx';
import { SpaceTypeIcon } from '../icons.tsx';
import { buildSpaceMap, spacePath as spacePathFn } from '../hooks/spaces.ts';
import { GROUP_WTYPES } from '../state.ts';
import { AddDeviceModal } from '../AddDeviceModal.tsx';
import { ComparePanel } from './ComparePanel.tsx';
import { DevicePinPanel } from './DevicePinPanel.tsx';
import { GAPinPanel } from './GAPinPanel.tsx';
import styles from './PinDetailView.module.css';

interface SpacePanelProps {
  spaceId: string;
  data: any;
  onUpdateSpace: any;
  onAddDevice: any;
}

function SpacePanel({
  spaceId,
  data,
  onUpdateSpace,
  onAddDevice,
}: SpacePanelProps) {
  const { devices = [], spaces = [] } = data;
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const spaceMap = Object.fromEntries(spaces.map((s: any) => [s.id, s]));
  const space = spaceMap[parseInt(spaceId)];
  if (!space) return <Empty icon="◈" msg="Space not found" />;
  const getDescendants = (id: number): number[] => {
    const children = spaces.filter((s: any) => s.parent_id === id);
    return [id, ...children.flatMap((c: any) => getDescendants(c.id))];
  };
  const spaceIds = new Set(getDescendants(parseInt(spaceId)));
  const matches = devices.filter((d: any) => spaceIds.has(d.space_id));

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
    <div className={styles.spacePanel}>
      <div className={styles.spacePanelHeader}>
        <div className={styles.spaceTypeRow}>
          <span className={styles.spaceTypeIcon}>
            <SpaceTypeIcon type={space.type} size={22} />
          </span>
          <span className={styles.spaceTypeLabel}>
            {space.type?.toUpperCase()}
          </span>
        </div>
        {editing ? (
          <div className={styles.spaceNameEdit}>
            <input
              value={editName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setEditName(e.target.value)
              }
              autoFocus
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setEditing(false);
              }}
              className={styles.spaceNameInput}
            />
            <Btn
              onClick={handleSave}
              disabled={saving || !editName.trim()}
              color="var(--green)"
            >
              {saving ? 'Saving' : 'Save'}
            </Btn>
            <Btn onClick={() => setEditing(false)} color="var(--dim)">
              Cancel
            </Btn>
          </div>
        ) : (
          <div
            className={
              onUpdateSpace ? styles.spaceNameClickable : styles.spaceName
            }
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
        <div className={styles.spaceStatsRow}>
          <span className={styles.spaceDeviceCount}>
            {matches.length} device{matches.length !== 1 ? 's' : ''}
          </span>
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              color="var(--green)"
              className={styles.btnSmall}
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
        <table className={styles.spaceTable}>
          <thead>
            <tr>
              <TH className={styles.thAddrWide}>ADDRESS</TH>
              <TH>NAME</TH>
              <TH>MANUFACTURER</TH>
              <TH>MODEL</TH>
              <TH>LOCATION</TH>
            </tr>
          </thead>
          <tbody>
            {matches.map((d: any) => (
              <tr key={d.id}>
                <TD>
                  <PinAddr
                    address={d.individual_address}
                    wtype="device"
                    className={styles.deviceAddr}
                  />
                </TD>
                <TD>
                  <span className={styles.normalText}>{d.name}</span>
                </TD>
                <TD>
                  <PinAddr
                    address={d.manufacturer}
                    wtype="manufacturer"
                    className={styles.amberText}
                  >
                    {d.manufacturer || '—'}
                  </PinAddr>
                </TD>
                <TD>
                  <PinAddr
                    address={d.model}
                    wtype="model"
                    className={styles.amberMono}
                  >
                    {localizedModel(d) || '—'}
                  </PinAddr>
                </TD>
                <TD>
                  <SpacePath
                    spaceId={d.space_id}
                    spaces={spaces}
                    className={styles.spacePathDim}
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

interface DeviceGroupPanelProps {
  wtype: string;
  value: string;
  data: any;
  onAddDevice: any;
  projectId?: number | null;
}

function DeviceGroupPanel({
  wtype,
  value,
  data,
  onAddDevice,
  projectId,
}: DeviceGroupPanelProps) {
  const navigate = useNavigate();
  const pin = useContext(PinContext);
  const { devices = [], spaces: _spaces = [] } = data;
  const { label } = GROUP_WTYPES[wtype as keyof typeof GROUP_WTYPES];
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const field = GROUP_WTYPES[wtype as keyof typeof GROUP_WTYPES].field;
  const matches = devices.filter((d: any) => d[field] === value);
  const toggleSelect = (addr: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(addr)) n.delete(addr);
      else n.add(addr);
      return n;
    });
  const selectAll = () =>
    setSelected(new Set(matches.map((d: any) => d.individual_address)));
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
    <div className={styles.groupPanel}>
      <div className={styles.groupHeader}>
        <div className={styles.groupTypeLabel}>{label}</div>
        <div className={styles.groupTitle}>{value}</div>
        <div className={styles.groupStatsRow}>
          <span className={styles.groupDeviceCount}>
            {matches.length} device{matches.length !== 1 ? 's' : ''}
          </span>
          {onAddDevice && (
            <Btn
              onClick={() => setShowAdd(true)}
              color="var(--green)"
              className={styles.btnSmall}
            >
              + Add
            </Btn>
          )}
          {projectId &&
            (() => {
              const mfr =
                wtype === 'manufacturer' ? value : matches[0]?.manufacturer;
              return mfr ? (
                <Btn
                  onClick={() =>
                    navigate(`/projects/${projectId}/catalog`, {
                      state: { jumpTo: mfr },
                    })
                  }
                  color="var(--accent)"
                  className={styles.btnSmall}
                >
                  Catalog
                </Btn>
              ) : null;
            })()}
          {matches.length >= 2 && pin && (
            <>
              <span className={styles.groupSep}>|</span>
              <Btn
                onClick={
                  selected.size === matches.length ? selectNone : selectAll
                }
                color="var(--dim)"
                className={styles.btnSmall}
              >
                {selected.size === matches.length
                  ? 'Deselect All'
                  : 'Select All'}
              </Btn>
              {selected.size >= 2 && (
                <Btn
                  onClick={compareSelected}
                  color="var(--accent)"
                  className={styles.btnSmall}
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
        <table className={styles.groupTable}>
          <thead>
            <tr>
              {matches.length >= 2 && pin && (
                <TH className={styles.thCheckbox}></TH>
              )}
              <TH className={styles.thAddrWide}>ADDRESS</TH>
              <TH>NAME</TH>
              {showMfr && <TH>MANUFACTURER</TH>}
              {showModel && <TH>MODEL</TH>}
              {showOrder && <TH>ORDER #</TH>}
              <TH>LOCATION</TH>
              <TH className={styles.thMa}>mA</TH>
              <TH className={styles.thMm}>mm</TH>
            </tr>
          </thead>
          <tbody>
            {matches.map((d: any) => (
              <tr
                key={d.id}
                className={
                  selected.has(d.individual_address)
                    ? styles.rowSelected
                    : styles.rowNormal
                }
              >
                {matches.length >= 2 && pin && (
                  <TD className={styles.tdCenter}>
                    <input
                      type="checkbox"
                      checked={selected.has(d.individual_address)}
                      onChange={() => toggleSelect(d.individual_address)}
                      className={styles.selectCheck}
                    />
                  </TD>
                )}
                <TD>
                  <PinAddr
                    address={d.individual_address}
                    wtype="device"
                    className={styles.deviceAddr}
                  />
                </TD>
                <TD>
                  <span className={styles.normalText}>{d.name}</span>
                </TD>
                {showMfr && (
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
                {showModel && (
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
                {showOrder && (
                  <TD>
                    <PinAddr
                      address={d.order_number}
                      wtype="order_number"
                      className={styles.amberMono}
                    >
                      {d.order_number || '—'}
                    </PinAddr>
                  </TD>
                )}
                <TD>
                  <SpacePath
                    spaceId={d.space_id}
                    spaces={data.spaces}
                    className={styles.spacePathDim}
                  />
                </TD>
                <TD>
                  <span className={styles.dimMono}>{d.bus_current || '—'}</span>
                </TD>
                <TD>
                  <span className={styles.dimMono}>{d.width_mm || '—'}</span>
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

interface MultiComparePanelProps {
  addrs: string[];
  data: any;
}

function MultiComparePanel({ addrs, data }: MultiComparePanelProps) {
  const pin = useContext(PinContext);
  const dpt = useDpt();
  const { devices = [], gas = [], comObjects = [] } = data;
  const gaMap: Record<string, any> = Object.fromEntries(
    gas.map((g: any) => [g.address, g]),
  );
  const [showAll, setShowAll] = useState(false);

  const devs = addrs
    .map((a) => devices.find((d: any) => d.individual_address === a))
    .filter(Boolean);
  if (devs.length < 2)
    return <Empty icon="◈" msg="Need at least 2 devices to compare" />;

  const colors = devs.map(
    (_: any, i: number) => COMPARE_COLORS[i % COMPARE_COLORS.length]!,
  );

  // Parameters comparison
  const allParams = devs.map((d: any) => {
    try {
      return JSON.parse(d.parameters || '[]');
    } catch {
      return [];
    }
  });
  const allParamMaps = allParams.map((ps: any[]) =>
    Object.fromEntries(ps.map((p: any) => [`${p.section}|${p.name}`, p])),
  );
  const allKeys = [
    ...new Set(allParamMaps.flatMap((m: any) => Object.keys(m))),
  ].sort();

  // Filter to only show rows where at least one value differs
  const paramRows = allKeys.map((k) => {
    const vals = allParamMaps.map((m: any) => m[k]?.value ?? null);
    const defined = vals.filter((v: any) => v !== null);
    const allSame =
      defined.length === vals.length &&
      defined.every((v: any) => v === defined[0]);
    return { key: k, vals, allSame };
  });
  const diffRows = paramRows.filter((r) => !r.allSame);
  const displayRows = showAll ? paramRows : diffRows;

  // Group objects comparison
  const allCOs = devs.map((d: any) =>
    comObjects.filter((co: any) => co.device_address === d.individual_address),
  );
  const allCOMaps = allCOs.map((cos: any[]) =>
    Object.fromEntries(cos.map((co: any) => [co.object_number, co])),
  );
  const allCoNums = [
    ...new Set(allCOs.flat().map((co: any) => co.object_number)),
  ].sort((a: number, b: number) => a - b);
  const coRows = allCoNums.map((num) => {
    const cos = allCOMaps.map((m: any) => m[num] || null);
    const gasArr = cos.map((co: any) => co?.ga_address || '');
    const allSame = gasArr.every((g: string) => g === gasArr[0]);
    return { num, cos, gas: gasArr, allSame };
  });
  const diffCORows = coRows.filter((r) => !r.allSame);

  // Group addresses comparison
  const allGASets = allCOs.map((cos: any[]) => new Set(cos.flatMap(coGAs)));
  const allGAAddrs = [
    ...new Set(allGASets.flatMap((s: Set<string>) => [...s])),
  ].sort();
  const gaRows = allGAAddrs.map((ga) => {
    const present = allGASets.map((s: Set<string>) => s.has(ga));
    const allSame = present.every((p: boolean) => p === present[0]);
    return { ga, present, allSame };
  });
  const diffGARows = gaRows.filter((r) => !r.allSame);

  const TH2 = ({
    children,
    style,
    className,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
    className?: string;
  }) => (
    <th
      className={`${styles.th2}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </th>
  );
  const TD2 = ({
    children,
    style,
    diff,
    className,
  }: {
    children?: React.ReactNode;
    style?: React.CSSProperties;
    diff?: boolean;
    className?: string;
  }) => (
    <td
      className={`${diff ? styles.td2Diff : styles.td2}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children ?? <span className={styles.tdDash}>-</span>}
    </td>
  );

  return (
    <div className={styles.multiPanel}>
      {/* Header: device cards */}
      <div className={styles.multiHeader}>
        {devs.map((d: any, i: number) => (
          <div
            key={d.individual_address}
            onClick={
              pin ? () => pin('device', d.individual_address) : undefined
            }
            className={pin ? styles.multiDevCardClickable : styles.multiDevCard}
            style={{ border: `2px solid ${colors[i]}40` }}
          >
            <div className={styles.multiDevAddr} style={{ color: colors[i] }}>
              {d.individual_address}
            </div>
            <div className={styles.multiDevName}>{d.name}</div>
          </div>
        ))}
      </div>

      {/* Parameters */}
      <div className={styles.sectionBlock}>
        <div className={styles.sectionHeaderRow}>
          <span className={styles.sectionLabel}>PARAMETERS</span>
          <span className={styles.sectionDiffCount}>
            {diffRows.length} difference{diffRows.length !== 1 ? 's' : ''} /{' '}
            {paramRows.length} total
          </span>
          <Btn
            onClick={() => setShowAll((p) => !p)}
            color="var(--dim)"
            className={styles.btnXSmall}
          >
            {showAll ? 'Differences Only' : 'Show All'}
          </Btn>
        </div>
        {displayRows.length === 0 ? (
          <div className={styles.emptyRow}>
            {showAll
              ? 'No parameters found.'
              : 'All parameters are identical across selected devices.'}
          </div>
        ) : (
          <div className={styles.scrollTableTall}>
            <table className={styles.fullTable}>
              <thead>
                <tr>
                  <TH2 className={styles.thSection}>SECTION</TH2>
                  <TH2 className={styles.thNameCol}>NAME</TH2>
                  {devs.map((d: any, i: number) => (
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
                      <TD2 className={styles.td2Dim} diff={!allSame}>
                        {section}
                      </TD2>
                      <TD2 className={styles.td2Muted} diff={!allSame}>
                        {name}
                      </TD2>
                      {vals.map((v: any, i: number) => (
                        <TD2 key={i} diff={!allSame}>
                          <span
                            className={
                              v === null
                                ? styles.dimText
                                : !allSame
                                  ? styles.amberValue
                                  : styles.normalText
                            }
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

      {/* Group Objects -- differences only */}
      {diffCORows.length > 0 && (
        <div className={styles.sectionBlock}>
          <div className={styles.sectionLabelMb}>
            GROUP OBJECTS &mdash; {diffCORows.length} difference
            {diffCORows.length !== 1 ? 's' : ''}
          </div>
          <div className={styles.scrollTableMed}>
            <table className={styles.fullTable}>
              <thead>
                <tr>
                  <TH2 className={styles.thObjNum}>#</TH2>
                  <TH2>NAME</TH2>
                  {devs.map((d: any, i: number) => (
                    <TH2
                      key={d.individual_address}
                      style={{ color: colors[i] }}
                    >
                      GA &mdash; {d.individual_address}
                    </TH2>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diffCORows.map(({ num, cos, gas: gasArr }) => {
                  const co = cos.find((c: any) => c) || {};
                  return (
                    <tr key={num}>
                      <TD2 className={styles.td2Dim} diff>
                        {num}
                      </TD2>
                      <TD2 className={styles.td2Muted} diff>
                        {co.name || co.function_text}
                      </TD2>
                      {gasArr.map((ga: string, i: number) => (
                        <TD2 key={i} diff>
                          {ga ? (
                            <span className={styles.amberMono}>
                              {ga.split(/\s+/).map((a: string, j: number) => (
                                <span key={j}>
                                  {j > 0 && ' '}
                                  <PinAddr
                                    address={a}
                                    wtype="ga"
                                    className={styles.amberText}
                                  >
                                    {a}
                                  </PinAddr>
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className={styles.dimText}>-</span>
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

      {/* Group Addresses -- differences only */}
      {diffGARows.length > 0 && (
        <div className={styles.sectionBlock}>
          <div className={styles.sectionLabelMb}>
            GROUP ADDRESSES &mdash; {diffGARows.length} difference
            {diffGARows.length !== 1 ? 's' : ''}
          </div>
          <div className={styles.scrollTableMed}>
            <table className={styles.fullTable}>
              <thead>
                <tr>
                  <TH2 className={styles.thGaAddr}>ADDRESS</TH2>
                  <TH2>NAME</TH2>
                  <TH2 className={styles.thDpt}>DPT</TH2>
                  {devs.map((d: any, i: number) => (
                    <TH2
                      key={d.individual_address}
                      className={styles.thPresence}
                      style={{ color: colors[i] }}
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
                          className={styles.purpleAddr}
                        >
                          {ga}
                        </PinAddr>
                      </TD2>
                      <TD2 diff className={styles.td2Muted}>
                        {gaInfo?.name}
                      </TD2>
                      <TD2 diff>
                        <span
                          className={styles.monoAddr}
                          title={dpt.hover(gaInfo?.dpt)}
                        >
                          {dpt.display(gaInfo?.dpt)}
                        </span>
                      </TD2>
                      {present.map((p: boolean, i: number) => (
                        <TD2 key={i} diff className={styles.tdCenter}>
                          <span
                            className={p ? styles.greenCheck : styles.dimCheck}
                          >
                            {p ? '✓' : '-'}
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
          <div className={styles.identicalMsg}>
            All devices are identically configured.
          </div>
        )}
    </div>
  );
}

interface PinDetailViewProps {
  pinKey: string;
  data: any;
  busStatus: any;
  telegrams?: any[];
  onWrite: any;
  activeProjectId: any;
  onUpdateGA: any;
  onUpdateDevice: any;
  onUpdateSpace: any;
  onGroupJump: any;
  onAddDevice: any;
  onUpdateComObjectGAs: any;
  projectId?: number | null;
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
  projectId,
}: PinDetailViewProps) {
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScrolls = useRef<Record<string, number>>({});

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
  const spaceMap = buildSpaceMap(spaces);
  const spacePath = (id: number) => spacePathFn(id, spaceMap);
  const gaMap: Record<string, any> = Object.fromEntries(
    gas.map((g: any) => [g.address, g]),
  );
  const busConnected = busStatus?.connected;
  const devMap: Record<string, any> = Object.fromEntries(
    devices.map((d: any) => [d.individual_address, d]),
  );

  let content;
  if (wtype === 'space') {
    content = (
      <SpacePanel
        spaceId={address!}
        data={data}
        onUpdateSpace={onUpdateSpace}
        onAddDevice={onAddDevice}
      />
    );
  } else if (wtype! in GROUP_WTYPES) {
    content = (
      <DeviceGroupPanel
        wtype={wtype!}
        value={address!}
        data={data}
        onAddDevice={onAddDevice}
        projectId={projectId}
      />
    );
  } else if (wtype === 'multicompare') {
    const addrs = address!.split('|');
    content = <MultiComparePanel addrs={addrs} data={data} />;
  } else if (wtype === 'compare') {
    const [addrA, addrB] = address!.split('|');
    content = <ComparePanel addrA={addrA!} addrB={addrB!} data={data} />;
  } else if (wtype === 'device') {
    const dev = devices.find((d: any) => d.individual_address === address);
    if (!dev) content = <Empty icon="◈" msg="Device not found" />;
    else {
      const devCOs = comObjects.filter(
        (co: any) => co.device_address === address,
      );
      const linkedGAs = (deviceGAMap[address!] || [])
        .map((a: string) => gas.find((g: any) => g.address === a))
        .filter(Boolean)
        .sort(
          (a: any, b: any) =>
            a.main_g - b.main_g || a.middle_g - b.middle_g || a.sub_g - b.sub_g,
        );
      const devTelegrams = telegrams.filter(
        (t: any) => t.src === address || t.dst === address,
      );
      content = (
        <DevicePinPanel
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
    const ga = gas.find((g: any) => g.address === address);
    if (!ga) content = <Empty icon="◆" msg="Group address not found" />;
    else {
      const linkedDevices = (gaDeviceMap[address!] || [])
        .map((a: string) =>
          devices.find((d: any) => d.individual_address === a),
        )
        .filter(Boolean);
      const gaTelegrams = telegrams.filter(
        (t: any) => t.dst === address || t.src === address,
      );
      content = (
        <GAPinPanel
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
    <div ref={scrollRef} onScroll={onScroll} className={styles.scrollContainer}>
      {content}
    </div>
  );
}
