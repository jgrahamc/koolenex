import { useState, useEffect, useContext } from 'react';
import { PinContext, useDpt } from '../contexts.ts';
import { localizedModel } from '../dpt.ts';
import {
  Badge,
  Btn,
  Spinner,
  TabBar,
  TH,
  TD,
  PinAddr,
  SpacePath,
  coGAs,
} from '../primitives.tsx';
import { STATUS_COLOR, MaskCtx } from '../theme.ts';
import { DeviceTypeIcon } from '../icons.tsx';
import { DeviceNetworkDiagram } from '../diagram.tsx';
import { DeviceParameters } from './DeviceParameters.tsx';
import { PinTelegramFeed } from './PinTelegramFeed.tsx';
import { api } from '../api.ts';
import { EditableRtfField } from '../rtf.tsx';
import styles from './DevicePinPanel.module.css';

interface DevicePinPanelProps {
  COLMAP: Record<string, string>;
  dev: any;
  devCOs: any[];
  linkedGAs: any[];
  spacePath: (id: number) => string;
  gaMap: Record<string, any>;
  devMap: Record<string, any>;
  spaces: any[];
  allDevices: any[];
  gaDeviceMap: Record<string, string[]>;
  allCOs: any[];
  busConnected: boolean;
  devTelegrams: any[];
  onUpdateDevice: any;
  onAddDevice: any;
  onUpdateComObjectGAs: any;
  activeProjectId: any;
}

export function DevicePinPanel({
  COLMAP,
  dev,
  devCOs,
  linkedGAs,
  spacePath: _spacePath,
  gaMap,
  devMap,
  spaces,
  allDevices,
  gaDeviceMap,
  allCOs,
  busConnected,
  devTelegrams,
  onUpdateDevice,
  onAddDevice,
  onUpdateComObjectGAs,
  activeProjectId,
}: DevicePinPanelProps) {
  const pin = useContext(PinContext) as any;
  const dpt = useDpt();
  const maskVersions = useContext(MaskCtx) as any;
  const [reachability, setReachability] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [busInfo, setBusInfo] = useState<any>(null);
  const [readingInfo, setReadingInfo] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [editName, setEditName] = useState(dev.name);
  const [editType, setEditType] = useState(dev.device_type || 'generic');
  const [saving, setSaving] = useState(false);

  const [devTab, setDevTab] = useState(
    () => localStorage.getItem('knx-pin-tab-device') || 'overview',
  );
  const handleDevTab = (t: string) => {
    setDevTab(t);
    localStorage.setItem('knx-pin-tab-device', t);
  };

  const devAddr = dev.individual_address;
  useEffect(() => {
    setReachability(null);
    setIdentifying(false);
    setEditing(false);
    setBusInfo(null);
    setReadingInfo(false);
  }, [devAddr]);

  const handleSave = async () => {
    if (!editName.trim() || !onUpdateDevice) return;
    setSaving(true);
    try {
      await onUpdateDevice(dev.id, {
        name: editName.trim(),
        device_type: editType,
      });
      setEditing(false);
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };

  const handlePing = async () => {
    setReachability('checking');
    try {
      const gaAddresses = linkedGAs.map((g: any) => g.address);
      const result = (await api.busPing(gaAddresses, devAddr)) as {
        reachable: boolean;
      };
      setReachability(result.reachable ? 'reachable' : 'unreachable');
    } catch (_) {
      setReachability('unreachable');
    }
  };

  const handleIdentify = async () => {
    setIdentifying(true);
    try {
      await api.busIdentify(devAddr);
    } catch (_) {}
    setIdentifying(false);
  };

  const handleReadInfo = async () => {
    setReadingInfo(true);
    try {
      const info = await api.busDeviceInfo(devAddr);
      setBusInfo(info);
    } catch (e) {
      console.error(e);
      setBusInfo({ error: 'Failed to read device info' });
    }
    setReadingInfo(false);
  };

  const reachColor =
    reachability === 'reachable'
      ? 'var(--green)'
      : reachability === 'unreachable'
        ? 'var(--red)'
        : 'var(--dim)';

  return (
    <div className={styles.panel}>
      <div className={styles.inner}>
        {/* Header */}
        <div className={styles.header}>
          <DeviceTypeIcon
            type={editing ? editType : dev.device_type}
            size={28}
            style={{
              color:
                COLMAP[editing ? editType : dev.device_type] || 'var(--muted)',
            }}
          />
          <div className={styles.headerFlex}>
            <div
              onClick={
                pin ? () => pin('device', dev.individual_address) : undefined
              }
              className={pin ? styles.devAddressClickable : styles.devAddress}
            >
              {dev.individual_address}
            </div>
            {editing ? (
              <div className={styles.editRow}>
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
                  className={styles.editNameInput}
                />
                <select
                  value={editType}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setEditType(e.target.value)
                  }
                  className={styles.editTypeSelect}
                >
                  {['generic', 'actuator', 'sensor', 'router'].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <Btn
                  onClick={handleSave}
                  disabled={saving || !editName.trim()}
                  color="var(--green)"
                >
                  {saving ? <Spinner /> : 'Save'}
                </Btn>
                <Btn onClick={() => setEditing(false)} color="var(--dim)">
                  Cancel
                </Btn>
              </div>
            ) : (
              <div
                onClick={
                  onUpdateDevice
                    ? () => {
                        setEditName(dev.name);
                        setEditType(dev.device_type || 'generic');
                        setEditing(true);
                      }
                    : undefined
                }
                className={
                  onUpdateDevice ? styles.devNameClickable : styles.devName
                }
                title={onUpdateDevice ? 'Click to edit' : undefined}
              >
                {dev.name}
              </div>
            )}
            {dev.space_id && (
              <div className={styles.spaceRow}>
                <SpacePath
                  spaceId={dev.space_id}
                  spaces={spaces}
                  className={styles.spacePathDim}
                />
              </div>
            )}
          </div>
          <div className={styles.badgeWrap}>
            <Badge
              label={dev.status?.toUpperCase()}
              color={(STATUS_COLOR as any)[dev.status] || 'var(--dim)'}
            />
            {busConnected && (
              <>
                {reachability !== null && (
                  <Badge
                    label={
                      reachability === 'checking'
                        ? 'PINGING…'
                        : reachability === 'reachable'
                          ? 'REACHABLE'
                          : 'NO RESPONSE'
                    }
                    color={reachColor}
                  />
                )}
                <span
                  onClick={reachability !== 'checking' ? handlePing : undefined}
                  title="Ping device"
                  className={`bg ${reachability !== 'checking' ? styles.pingBtnActive : styles.pingBtnDisabled}`}
                >
                  PING
                </span>
                <span
                  onClick={!identifying ? handleIdentify : undefined}
                  title="Flash device LED"
                  className={`bg ${!identifying ? styles.identifyBtnActive : styles.identifyBtnDisabled}`}
                >
                  {identifying ? (
                    <>
                      <span className={styles.identifyDotActive} />
                      IDENTIFYING&hellip;
                    </>
                  ) : (
                    <>
                      <span className={styles.identifyDotIdle} />
                      IDENTIFY
                    </>
                  )}
                </span>
                <span
                  onClick={!readingInfo ? handleReadInfo : undefined}
                  title="Read device properties from bus"
                  className={`bg ${!readingInfo ? styles.scanBtnActive : styles.scanBtnDisabled}`}
                >
                  {readingInfo ? 'SCANNING…' : 'SCAN'}
                </span>
              </>
            )}
            {onAddDevice && (
              <span
                onClick={() => setShowDuplicate(true)}
                title="Duplicate this device"
                className={`bg ${styles.duplicateBtn}`}
              >
                DUPLICATE
              </span>
            )}
          </div>
        </div>
        {showDuplicate && onAddDevice && (
          <DuplicateDeviceModal
            dev={dev}
            data={{ devices: allDevices, spaces }}
            onAdd={onAddDevice}
            onClose={() => setShowDuplicate(false)}
          />
        )}

        {/* Tab bar */}
        <TabBar
          active={devTab}
          onChange={handleDevTab}
          tabs={[
            { id: 'overview', label: 'OVERVIEW' },
            ...(linkedGAs.length
              ? [{ id: 'gas', label: `GROUP ADDRESSES (${linkedGAs.length})` }]
              : []),
            ...(devCOs.length
              ? [
                  {
                    id: 'comobjects',
                    label: `GROUP OBJECTS (${devCOs.length})`,
                  },
                ]
              : []),
            ...(dev.app_ref ? [{ id: 'parameters', label: 'PARAMETERS' }] : []),
            { id: 'telegrams', label: 'MONITOR' },
          ]}
        />

        {/* Overview tab */}
        {devTab === 'overview' && (
          <>
            {busInfo && !busInfo.error && (
              <div className={styles.busInfoSection}>
                <div className={styles.busInfoLabel}>BUS INFO (LIVE)</div>
                <div className={styles.busInfoCard}>
                  {(() => {
                    const maskKey = busInfo.descriptor
                      ?.slice(0, 4)
                      ?.toLowerCase();
                    const mask = maskKey && maskVersions[maskKey];
                    return (
                      [
                        [
                          'Mask Version',
                          mask
                            ? `${mask.name} (0x${busInfo.descriptor})`
                            : busInfo.descriptor,
                        ],
                        ['Serial Number', busInfo.serialNumber],
                        [
                          'Manufacturer ID',
                          busInfo.manufacturerId != null
                            ? `0x${busInfo.manufacturerId.toString(16).padStart(4, '0').toUpperCase()} (${busInfo.manufacturerId})`
                            : null,
                        ],
                        [
                          'Firmware Revision',
                          busInfo.firmwareRevision != null
                            ? `${busInfo.firmwareRevision}`
                            : null,
                        ],
                        ['Order Info', busInfo.orderInfo],
                        ['Hardware Type', busInfo.hardwareType],
                        [
                          'Program Version',
                          busInfo.programVersion
                            ? `MfrID=${busInfo.programVersion.manufacturerId} DevType=${busInfo.programVersion.deviceType} AppVer=${busInfo.programVersion.appVersion}`
                            : null,
                        ],
                        mask
                          ? ['Management Model', mask.managementModel]
                          : null,
                      ] as ([string, any] | null)[]
                    )
                      .filter(Boolean)
                      .filter(
                        (entry): entry is [string, any] =>
                          entry != null && entry[1] != null,
                      )
                      .map(([label, value]) => (
                        <div key={label} className={styles.busInfoRow}>
                          <span className={styles.busInfoKey}>{label}</span>
                          <span className={styles.busInfoValue}>{value}</span>
                        </div>
                      ));
                  })()}
                </div>
              </div>
            )}
            {busInfo?.error && (
              <div className={styles.busInfoError}>{busInfo.error}</div>
            )}
            <div className={styles.overviewGrid}>
              {(
                [
                  [
                    'Manufacturer',
                    dev.manufacturer,
                    'manufacturer',
                    dev.manufacturer,
                  ],
                  ['Model', dev.model, 'model', localizedModel(dev)],
                  [
                    'Order #',
                    dev.order_number,
                    'order_number',
                    dev.order_number,
                  ],
                  ['Serial', dev.serial_number, null, dev.serial_number],
                  [
                    'Last Modified',
                    dev.last_modified?.slice(0, 10),
                    null,
                    dev.last_modified?.slice(0, 10),
                  ],
                  [
                    'Last Download',
                    dev.last_download?.slice(0, 10),
                    null,
                    dev.last_download?.slice(0, 10),
                  ],
                  dev.bus_current
                    ? [
                        'Bus Current',
                        dev.bus_current + ' mA',
                        null,
                        dev.bus_current + ' mA',
                      ]
                    : null,
                  dev.width_mm
                    ? [
                        'Width',
                        dev.width_mm + ' mm',
                        null,
                        dev.width_mm + ' mm',
                      ]
                    : null,
                ] as ([string, any, string | null, any] | null)[]
              )
                .filter(
                  (entry): entry is [string, any, string | null, any] =>
                    entry != null,
                )
                .filter(([, v]) => v)
                .map(([k, v, wt, display]) => (
                  <div
                    key={k}
                    className={`${wt && pin ? `bg ${styles.infoCardClickable}` : styles.infoCard}`}
                    onClick={wt && pin ? () => pin(wt, v) : undefined}
                  >
                    <div className={styles.infoCardLabel}>{k}</div>
                    <div
                      className={
                        wt ? styles.infoCardValueLink : styles.infoCardValue
                      }
                    >
                      {display}
                    </div>
                  </div>
                ))}
            </div>
            <EditableRtfField
              label="DESCRIPTION"
              value={
                dev.description && dev.description !== dev.name
                  ? dev.description
                  : ''
              }
              onSave={
                onUpdateDevice
                  ? (v: string) => onUpdateDevice(dev.id, { description: v })
                  : undefined
              }
            />
            <EditableRtfField
              label="COMMENT"
              value={dev.comment || ''}
              onSave={
                onUpdateDevice
                  ? (v: string) => onUpdateDevice(dev.id, { comment: v })
                  : undefined
              }
            />
            <EditableRtfField
              label="INSTALLATION HINTS"
              value={dev.installation_hints || ''}
              onSave={
                onUpdateDevice
                  ? (v: string) =>
                      onUpdateDevice(dev.id, { installation_hints: v })
                  : undefined
              }
            />
            <SameDeviceSection
              dev={dev}
              allDevices={allDevices}
              spaces={spaces}
              pin={pin}
            />
          </>
        )}

        {/* Group Addresses tab */}
        {devTab === 'gas' && (
          <>
            {linkedGAs.length === 0 ? (
              <div className={styles.emptyTab}>No linked group addresses</div>
            ) : (
              <>
                <table className={styles.gaTable}>
                  <thead>
                    <tr>
                      <TH className={styles.thGaAddr}>ADDRESS</TH>
                      <TH>NAME</TH>
                      <TH className={styles.thGaDpt}>DPT</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {linkedGAs.map((g: any) => (
                      <tr key={g.id} className="rh">
                        <TD>
                          <PinAddr
                            address={g.address}
                            wtype="ga"
                            className={styles.gaAddrCell}
                          />
                        </TD>
                        <TD>
                          <span className={styles.mutedText}>{g.name}</span>
                        </TD>
                        <TD>
                          <span
                            className={styles.dimText}
                            title={dpt.hover(g.dpt)}
                          >
                            {dpt.display(g.dpt)}
                          </span>
                        </TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {gaDeviceMap && (
                  <DeviceNetworkDiagram
                    dev={dev}
                    linkedGAs={linkedGAs}
                    devCOs={devCOs}
                    gaDeviceMap={gaDeviceMap}
                    allCOs={allCOs}
                    devMap={devMap}
                    devTelegrams={devTelegrams}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* Group Objects tab */}
        {devTab === 'comobjects' && (
          <>
            {devCOs.length === 0 ? (
              <div className={styles.emptyTab}>No group objects</div>
            ) : (
              <table className={styles.coTable}>
                <thead>
                  <tr>
                    <TH className={styles.thCoNum}>#</TH>
                    <TH className={styles.thCoChannel}>CHANNEL</TH>
                    <TH>NAME</TH>
                    <TH>OBJECT FUNCTION</TH>
                    <TH className={styles.thCoDpt}>DPT</TH>
                    <TH className={styles.thCoSizeNoWrap}>SIZE</TH>
                    <TH className={styles.thCoFlags}>FLAGS</TH>
                    <TH>GA</TH>
                  </tr>
                </thead>
                <tbody>
                  {devCOs.map((co: any, i: number) => (
                    <tr key={i} className="rh">
                      <TD>
                        <span className={styles.dimText}>
                          {co.object_number}
                        </span>
                      </TD>
                      <TD>
                        <span className={styles.mutedText}>{co.channel}</span>
                      </TD>
                      <TD>
                        <span className={styles.normalText}>
                          {co.name || '—'}
                        </span>
                      </TD>
                      <TD>
                        <span className={styles.mutedText}>
                          {co.function_text || '—'}
                        </span>
                      </TD>
                      <TD>
                        <span
                          className={styles.dimMono}
                          title={dpt.hover(
                            co.dpt ||
                              coGAs(co)
                                .map((a: string) => gaMap[a]?.dpt)
                                .find(Boolean),
                          )}
                        >
                          {dpt.display(
                            co.dpt ||
                              coGAs(co)
                                .map((a: string) => gaMap[a]?.dpt)
                                .find(Boolean),
                          )}
                        </span>
                      </TD>
                      <TD>
                        <span className={styles.dimNoWrap}>
                          {co.object_size}
                        </span>
                      </TD>
                      <TD>
                        <span className={styles.dimMono}>{co.flags}</span>
                      </TD>
                      <TD>
                        <span className={styles.gaCellWrap}>
                          {coGAs(co).map((ga: string, idx: number) => (
                            <span key={ga} className={styles.gaRow}>
                              {onUpdateComObjectGAs && coGAs(co).length > 1 && (
                                <span className={styles.reorderCol}>
                                  {idx > 0 && (
                                    <span
                                      onClick={() =>
                                        onUpdateComObjectGAs(co.id, {
                                          reorder: ga,
                                          position: idx - 1,
                                        })
                                      }
                                      className={styles.reorderArrow}
                                      title="Move up"
                                    >
                                      &#9650;
                                    </span>
                                  )}
                                  {idx < coGAs(co).length - 1 && (
                                    <span
                                      onClick={() =>
                                        onUpdateComObjectGAs(co.id, {
                                          reorder: ga,
                                          position: idx + 1,
                                        })
                                      }
                                      className={styles.reorderArrow}
                                      title="Move down"
                                    >
                                      &#9660;
                                    </span>
                                  )}
                                </span>
                              )}
                              <PinAddr
                                address={ga}
                                wtype="ga"
                                className={styles.gaPinAddr}
                              >
                                {ga}
                              </PinAddr>
                              {gaMap[ga] && (
                                <span className={styles.gaSubName}>
                                  {gaMap[ga].name}
                                </span>
                              )}
                              {onUpdateComObjectGAs && (
                                <span
                                  onClick={() =>
                                    onUpdateComObjectGAs(co.id, { remove: ga })
                                  }
                                  title="Remove GA"
                                  className={styles.gaRemoveBtn}
                                >
                                  &#10005;
                                </span>
                              )}
                            </span>
                          ))}
                          {onUpdateComObjectGAs && (
                            <ComObjectGAAdder
                              co={co}
                              gaMap={gaMap}
                              onAdd={(ga: string) =>
                                onUpdateComObjectGAs(co.id, { add: ga })
                              }
                            />
                          )}
                        </span>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* Parameters tab */}
        {devTab === 'parameters' && (
          <DeviceParameters dev={dev} projectId={activeProjectId} />
        )}

        {/* Telegrams tab */}
        {devTab === 'telegrams' && (
          <PinTelegramFeed
            telegrams={devTelegrams}
            gaMap={gaMap}
            devMap={devMap}
            spaces={spaces}
          />
        )}
      </div>
    </div>
  );
}

// Inline GA adder for a com object
interface ComObjectGAAdderProps {
  co: any;
  gaMap: Record<string, any>;
  onAdd: (ga: string) => void;
}

function ComObjectGAAdder({ co, gaMap, onAdd }: ComObjectGAAdderProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  if (!open) {
    return (
      <span
        onClick={() => setOpen(true)}
        className={styles.gaLinkBtn}
        title="Link group address"
      >
        + link GA
      </span>
    );
  }

  const existing = new Set(coGAs(co));
  const allGAs = Object.values(gaMap);
  const sq = search.toLowerCase();
  const filtered = allGAs
    .filter(
      (g: any) =>
        !existing.has(g.address) &&
        (g.address.includes(sq) || (g.name || '').toLowerCase().includes(sq)),
    )
    .slice(0, 15);

  return (
    <div className={styles.gaAdderWrap}>
      <div className={styles.gaAdderRow}>
        <input
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSearch(e.target.value)
          }
          autoFocus
          placeholder="Search GA..."
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) =>
            e.key === 'Escape' && setOpen(false)
          }
          className={styles.gaAdderInput}
        />
        <span onClick={() => setOpen(false)} className={styles.gaAdderCancel}>
          cancel
        </span>
      </div>
      {filtered.length > 0 && (
        <div className={styles.gaAdderDropdown}>
          {filtered.map((g: any) => (
            <div
              key={g.address}
              onClick={() => {
                onAdd(g.address);
                setOpen(false);
                setSearch('');
              }}
              className={`rh ${styles.gaAdderItem}`}
            >
              <span className={styles.gaAdderAddr}>{g.address}</span>
              <span className={styles.gaAdderName}>{g.name}</span>
            </div>
          ))}
        </div>
      )}
      {filtered.length === 0 && search && (
        <div className={styles.gaAdderEmpty}>No matching GAs</div>
      )}
    </div>
  );
}

interface DuplicateDeviceModalProps {
  dev: any;
  data: any;
  onAdd: any;
  onClose: () => void;
}

function DuplicateDeviceModal({
  dev,
  data,
  onAdd,
  onClose,
}: DuplicateDeviceModalProps) {
  const { devices = [], spaces = [] } = data;
  const [name, setName] = useState(dev.name + ' (copy)');
  const [area, setArea] = useState(dev.area);
  const [line, setLine] = useState(dev.line);
  const [devNum, setDevNum] = useState(() => {
    const used = new Set(
      devices
        .filter((d: any) => d.area === dev.area && d.line === dev.line)
        .map((d: any) => parseInt(d.individual_address.split('.')[2])),
    );
    for (let i = 1; i <= 255; i++) {
      if (!used.has(i)) return i;
    }
    return 1;
  });
  const [spaceId, setSpaceId] = useState<number | string>(dev.space_id || '');
  const [error, setError] = useState('');

  const recomputeDevNum = (a: number, l: number) => {
    const used = new Set(
      devices
        .filter((d: any) => d.area === a && d.line === l)
        .map((d: any) => parseInt(d.individual_address.split('.')[2])),
    );
    for (let i = 1; i <= 255; i++) {
      if (!used.has(i)) return i;
    }
    return 1;
  };

  const address = `${area}.${line}.${devNum}`;
  const addressExists = devices.some(
    (d: any) => d.individual_address === address,
  );

  // Flatten spaces for dropdown
  const flatSpaces = (() => {
    const nodeMap: Record<number, any> = {};
    for (const s of spaces) nodeMap[s.id] = { ...s, children: [] };
    const roots: any[] = [];
    for (const s of spaces) {
      if (s.parent_id && nodeMap[s.parent_id])
        nodeMap[s.parent_id].children.push(nodeMap[s.id]);
      else roots.push(nodeMap[s.id]);
    }
    const result: any[] = [];
    const walk = (nodes: any[], depth: number) => {
      for (const n of nodes.sort(
        (a: any, b: any) =>
          (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
          a.name.localeCompare(b.name),
      )) {
        result.push({ id: n.id, name: n.name, type: n.type, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(roots, 0);
    return result;
  })();

  const handleSubmit = async () => {
    if (addressExists) {
      setError('Address already exists');
      return;
    }
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError('');

    const body = {
      individual_address: address,
      name: name.trim(),
      area,
      line,
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
    if (newDev && dev.param_values && dev.param_values !== '{}') {
      try {
        const pv =
          typeof dev.param_values === 'string'
            ? JSON.parse(dev.param_values)
            : dev.param_values;
        if (Object.keys(pv).length > 0) {
          await api.saveParamValues(newDev.project_id, newDev.id, pv);
        }
      } catch (_) {}
    }
    if (newDev) onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div
        className={styles.modalBox}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className={styles.modalTitle}>Duplicate Device</div>
        <div className={styles.modalSubtitle}>
          Copy {dev.individual_address} ({dev.manufacturer} {dev.model}) with
          parameters. Group addresses and channel assignments are not copied.
        </div>

        {/* Name */}
        <div className={styles.fieldLabel}>NAME</div>
        <input
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setName(e.target.value)
          }
          autoFocus
          className={styles.nameInput}
        />

        {/* Address */}
        <div className={styles.fieldLabel}>
          INDIVIDUAL ADDRESS
          {addressExists && (
            <span className={styles.addrConflict}>already exists</span>
          )}
        </div>
        <div className={styles.addressWrap}>
          <input
            type="number"
            min={1}
            max={15}
            value={area}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const a = +e.target.value;
              setArea(a);
              setDevNum(recomputeDevNum(a, line));
            }}
            className={styles.addrInput}
          />
          <span className={styles.addrDot}>.</span>
          <input
            type="number"
            min={0}
            max={15}
            value={line}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const l = +e.target.value;
              setLine(l);
              setDevNum(recomputeDevNum(area, l));
            }}
            className={styles.addrInput}
          />
          <span className={styles.addrDot}>.</span>
          <input
            type="number"
            min={1}
            max={255}
            value={devNum}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setDevNum(+e.target.value)
            }
            className={styles.addrInputWide}
          />
        </div>

        {/* Location */}
        <div className={styles.fieldLabel}>LOCATION</div>
        <select
          value={spaceId}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            setSpaceId(+e.target.value || '')
          }
          className={styles.selectField}
        >
          <option value="">&mdash; None &mdash;</option>
          {flatSpaces.map((s: any) => (
            <option key={s.id} value={s.id}>
              {'  '.repeat(s.depth)}
              {s.name} ({s.type})
            </option>
          ))}
        </select>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <Btn onClick={onClose} color="var(--dim)">
            Cancel
          </Btn>
          <Btn
            onClick={handleSubmit}
            color="var(--green)"
            disabled={addressExists}
          >
            Duplicate
          </Btn>
        </div>
      </div>
    </div>
  );
}

interface SameDeviceSectionProps {
  dev: any;
  allDevices: any[];
  spaces: any[];
  pin: any;
}

function SameDeviceSection({
  dev,
  allDevices,
  spaces,
  pin,
}: SameDeviceSectionProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = dev.order_number || dev.model;
  if (!key || !allDevices) return null;
  const similar = allDevices.filter(
    (d: any) =>
      d.individual_address !== dev.individual_address &&
      (dev.order_number
        ? d.order_number === dev.order_number
        : d.model === dev.model),
  );
  if (!similar.length) return null;
  const toggleSelect = (addr: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(addr)) n.delete(addr);
      else n.add(addr);
      return n;
    });
  const compareSelected = () => {
    if (selected.size < 1 || !pin) return;
    pin('multicompare', [dev.individual_address, ...selected].join('|'));
  };
  return (
    <div className={styles.sameDevSection}>
      <div className={styles.sameDevHeader}>
        <span className={styles.sameDevLabel}>
          SAME DEVICE TYPE ({similar.length}) &mdash; {key}
        </span>
        {selected.size >= 1 && pin && (
          <Btn
            onClick={compareSelected}
            color="var(--accent)"
            className={styles.compareBtnSmall}
          >
            Compare {selected.size + 1} Devices
          </Btn>
        )}
      </div>
      <div className={styles.sameDevList}>
        {similar.map((d: any) => (
          <div
            key={d.individual_address}
            className={
              selected.has(d.individual_address)
                ? styles.sameDevRowSelected
                : styles.sameDevRowDefault
            }
          >
            {pin && (
              <input
                type="checkbox"
                checked={selected.has(d.individual_address)}
                onChange={() => toggleSelect(d.individual_address)}
                className={styles.selectCheck}
              />
            )}
            <PinAddr
              address={d.individual_address}
              wtype="device"
              className={styles.sameDevAddr}
            />
            <span className={styles.sameDevName}>{d.name}</span>
            {d.space_id && (
              <SpacePath
                spaceId={d.space_id}
                spaces={spaces}
                className={styles.spacePathSmall}
              />
            )}
            <Badge
              label={d.status?.toUpperCase()}
              color={(STATUS_COLOR as any)[d.status] || 'var(--dim)'}
            />
            <span
              onClick={() =>
                pin &&
                pin(
                  'compare',
                  `${dev.individual_address}|${d.individual_address}`,
                )
              }
              className={`bg ${styles.compareBtn}`}
            >
              COMPARE
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
