import { useState, useEffect, useMemo } from 'react';
import { useDpt } from '../contexts.ts';
import { localizedModel } from '../dpt.ts';
import {
  Btn,
  TH,
  TD,
  SearchBox,
  SectionHeader,
  Empty,
  PinAddr,
  coGAs,
} from '../primitives.tsx';
import { useColumns, ColumnPicker, dlCSV } from '../columns.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import type { ComObjectWithDevice } from '../../../shared/types.ts';
import styles from './ComObjectsView.module.css';

interface ComObjectsViewProps {
  data: any;
}

export function ComObjectsView({ data }: ComObjectsViewProps) {
  const dpt = useDpt();
  const [search, setSearch] = useState(
    () => localStorage.getItem('knx-co-search') || '',
  );
  const [filterDevice, setFilterDevice] = useState(
    () => localStorage.getItem('knx-co-filter-device') || 'all',
  );
  useEffect(() => {
    try {
      localStorage.setItem('knx-co-search', search);
    } catch {}
  }, [search]);
  useEffect(() => {
    try {
      localStorage.setItem('knx-co-filter-device', filterDevice);
    } catch {}
  }, [filterDevice]);
  const { comObjects = [], devices = [], gas = [] } = data || {};
  const gaMap = Object.fromEntries(gas.map((g: any) => [g.address, g]));

  const CO_COLS = useMemo(
    () => [
      { id: 'object_number', label: '#', visible: true },
      { id: 'channel', label: 'Channel', visible: true },
      { id: 'name', label: 'Name', visible: true },
      { id: 'dpt', label: 'DPT', visible: true },
      { id: 'object_size', label: 'Size', visible: true },
      { id: 'ga_address', label: 'Group Addr', visible: true },
      { id: 'flags', label: 'Flags', visible: true },
      { id: 'direction', label: 'Dir', visible: true },
      { id: 'device_name', label: 'Device Name', visible: false },
      { id: 'function_text', label: 'Object Function', visible: true },
    ],
    [],
  );
  const [coCols, saveCoCols] = useColumns('comobjects', CO_COLS);
  const ccv = (id: string) =>
    coCols.find((c: any) => c.id === id)?.visible !== false;

  const filtered = comObjects.filter((co: any) => {
    if (filterDevice !== 'all' && co.device_address !== filterDevice)
      return false;
    const s = search.toLowerCase();
    return (
      !s ||
      co.name?.toLowerCase().includes(s) ||
      co.channel?.toLowerCase().includes(s) ||
      co.ga_address?.includes(s) ||
      co.dpt?.toLowerCase().includes(s) ||
      co.device_address?.includes(s)
    );
  });

  const groupedCOs = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const order: string[] = [];
    for (const co of filtered) {
      if (!groups[co.device_address]) {
        groups[co.device_address] = [];
        order.push(co.device_address);
      }
      groups[co.device_address]!.push(co);
    }
    return order.map((addr) => ({ addr, cos: groups[addr]! }));
  }, [filtered]);
  const devMap2 = useMemo(
    () =>
      Object.fromEntries(devices.map((d: any) => [d.individual_address, d])),
    [devices],
  );
  const [collapsedDevs, setCollapsedDevs] = useState<Record<string, boolean>>(
    {},
  );

  const exportCOCSV = () =>
    dlCSV(
      'koolenex-comobjects.csv',
      coCols,
      filtered,
      (id: string, co: ComObjectWithDevice) =>
        (
          ({
            device_address: co.device_address,
            object_number: co.object_number,
            channel: co.channel,
            name: co.name || '',
            dpt: co.dpt,
            object_size: co.object_size,
            ga_address: coGAs(co).join('; '),
            flags: co.flags,
            direction: co.direction,
            device_name: co.device_name,
            function_text: co.function_text,
          }) as Record<string, unknown>
        )[id] ?? '',
    );

  const flagColor = (f: string) =>
    f === 'T'
      ? 'var(--green)'
      : f === 'W'
        ? 'var(--accent)'
        : f === 'R'
          ? 'var(--amber)'
          : 'var(--muted)';

  return (
    <div className={styles.root}>
      <SectionHeader
        title="Group Objects"
        count={filtered.length}
        actions={[
          <SearchBox
            key="s"
            value={search}
            onChange={setSearch}
            placeholder="Search objects…"
          />,
          <select
            key="dev"
            value={filterDevice}
            onChange={(e) => setFilterDevice(e.target.value)}
            className={styles.filterSelect}
          >
            <option value="all">All Devices</option>
            {devices.map((d: any) => (
              <option key={d.id} value={d.individual_address}>
                {d.individual_address} — {d.name}
              </option>
            ))}
          </select>,
          <ColumnPicker key="cp" cols={coCols} onChange={saveCoCols} />,
          <Btn
            key="csv"
            onClick={exportCOCSV}
            color="var(--muted)"
            bg="var(--surface)"
          >
            ↓ CSV
          </Btn>,
        ]}
      />
      <div className={styles.scrollArea}>
        {groupedCOs.map(({ addr, cos }) => {
          const dev = devMap2[addr];
          const isCollapsed = !!collapsedDevs[addr];
          return (
            <div key={`dev-${addr}`}>
              <div className={styles.devGroupHeader}>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsedDevs((p) => ({ ...p, [addr]: !p[addr] }));
                  }}
                  className={styles.chevron}
                >
                  {isCollapsed ? '▸' : '▾'}
                </span>
                <PinAddr
                  address={addr}
                  wtype="device"
                  className={styles.accentPinAddr}
                />
                {dev && (
                  <>
                    <DeviceTypeIcon
                      type={dev.device_type}
                      size={12}
                      style={{ color: 'var(--muted)' }}
                    />
                    <span className={styles.devName}>{dev.name}</span>
                    {dev.manufacturer && (
                      <PinAddr
                        address={dev.manufacturer}
                        wtype="manufacturer"
                        className={styles.amberPinAddr}
                      >
                        {dev.manufacturer}
                      </PinAddr>
                    )}
                    {dev.model && (
                      <PinAddr
                        address={dev.model}
                        wtype="model"
                        className={styles.modelPinAddr}
                      >
                        {localizedModel(dev)}
                      </PinAddr>
                    )}
                  </>
                )}
                <span className={styles.count}>· {cos.length}</span>
              </div>
              {!isCollapsed && (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {coCols
                        .filter((c: any) => c.visible !== false)
                        .map((col: any) => (
                          <TH
                            key={col.id}
                            className={
                              col.id === 'object_number'
                                ? styles.thObjNum
                                : col.id === 'channel'
                                  ? styles.thChannel
                                  : col.id === 'dpt'
                                    ? styles.thDpt
                                    : col.id === 'object_size'
                                      ? styles.thSizeNoWrap
                                      : col.id === 'ga_address'
                                        ? styles.thGaAddr
                                        : col.id === 'flags'
                                          ? styles.thFlags
                                          : col.id === 'direction'
                                            ? styles.thDirection
                                            : undefined
                            }
                          >
                            {col.label.toUpperCase().replace('GAS', 'GAs')}
                          </TH>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cos.map((co: any) => (
                      <tr key={co.id} className="rh">
                        {ccv('object_number') && (
                          <TD>
                            <span className={styles.textDim}>
                              {co.object_number}
                            </span>
                          </TD>
                        )}
                        {ccv('channel') && (
                          <TD>
                            <span className={styles.channelMono}>
                              {co.channel || '—'}
                            </span>
                          </TD>
                        )}
                        {ccv('name') && (
                          <TD>
                            <span>{co.name || '—'}</span>
                          </TD>
                        )}
                        {ccv('dpt') && (
                          <TD>
                            <span
                              className={styles.dptMono}
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
                        )}
                        {ccv('object_size') && (
                          <TD>
                            <span className={styles.sizeSmall}>
                              {co.object_size || '—'}
                            </span>
                          </TD>
                        )}
                        {ccv('ga_address') && (
                          <TD>
                            {coGAs(co).length ? (
                              <span className={styles.gaCol}>
                                {coGAs(co).map((ga: string) => (
                                  <PinAddr
                                    key={ga}
                                    address={ga}
                                    wtype="ga"
                                    className={styles.gaPinAddr}
                                  />
                                ))}
                              </span>
                            ) : (
                              <span className={styles.textDim}>—</span>
                            )}
                          </TD>
                        )}
                        {ccv('flags') && (
                          <TD>
                            <span className={styles.flagsMono}>
                              {(co.flags || '')
                                .split('')
                                .map((f: string, fi: number) => (
                                  <span
                                    key={fi}
                                    style={{ color: flagColor(f) }}
                                  >
                                    {f}
                                  </span>
                                ))}
                            </span>
                          </TD>
                        )}
                        {ccv('direction') && (
                          <TD>
                            <span
                              className={
                                co.direction === 'output'
                                  ? styles.dirOutput
                                  : co.direction === 'input'
                                    ? styles.dirInput
                                    : styles.dirBoth
                              }
                            >
                              {co.direction === 'output'
                                ? '↑ Out'
                                : co.direction === 'input'
                                  ? '↓ In'
                                  : '⇅ Both'}
                            </span>
                          </TD>
                        )}
                        {ccv('device_name') && (
                          <TD>
                            <span className={styles.dimSmall}>
                              {co.device_name || '—'}
                            </span>
                          </TD>
                        )}
                        {ccv('function_text') && (
                          <TD>
                            <span className={styles.dimSmall}>
                              {co.function_text || '—'}
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
        {filtered.length === 0 && <Empty icon="⇅" msg="No group objects" />}
      </div>
      <div className={styles.footer}>
        Flags:{' '}
        <span className={styles.footerMuted}>
          C=Communication · R=Read · W=Write · T=Transmit · U=Update
        </span>
      </div>
    </div>
  );
}
