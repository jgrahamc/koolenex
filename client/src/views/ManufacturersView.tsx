import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { STATUS_COLOR } from '../theme.ts';
import {
  Badge,
  Btn,
  Empty,
  PinAddr,
  SpacePath,
  SectionHeader,
  TH,
  TD,
} from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import { dlCSV } from '../columns.tsx';
import type { Device } from '../../../shared/types.ts';
import { AddDeviceModal } from '../AddDeviceModal.tsx';
import styles from './ManufacturersView.module.css';

interface ManufacturersViewProps {
  data: any;
  onAddDevice?: ((body: any) => Promise<any>) | null;
  projectId?: number | null;
}

export function ManufacturersView({
  data,
  onAddDevice,
  projectId,
}: ManufacturersViewProps) {
  const navigate = useNavigate();
  const { devices, spaces = [], deviceGAMap = {} } = data;
  const [addDefaults, setAddDefaults] = useState<any>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('knx-mfr-expanded') || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('knx-mfr-expanded', JSON.stringify(expanded));
    } catch {}
  }, [expanded]);

  const tree = useMemo(() => {
    const mfrs: Record<string, Record<string, any[]>> = {};
    for (const d of devices) {
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
          .map(([mdl, devs]) => ({
            name: mdl,
            devices: [...devs].sort((a: any, b: any) =>
              a.individual_address.localeCompare(b.individual_address),
            ),
          })),
      }));
  }, [devices]);

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  const isOpen = (key: string) => !!expanded[key];

  const csvCols = [
    { id: 'manufacturer', label: 'Manufacturer', visible: true },
    { id: 'model', label: 'Model', visible: true },
    { id: 'address', label: 'Address', visible: true },
    { id: 'name', label: 'Name', visible: true },
    { id: 'device_type', label: 'Type', visible: true },
    { id: 'status', label: 'Status', visible: true },
    { id: 'order_number', label: 'Order #', visible: true },
    { id: 'serial_number', label: 'Serial', visible: true },
    { id: 'gas', label: 'GAs', visible: true },
  ];
  const exportCSV = () =>
    dlCSV(
      'koolenex-manufacturers.csv',
      csvCols,
      devices,
      (id: string, d: Device) =>
        (
          ({
            manufacturer: d.manufacturer || '',
            model: d.model || '',
            address: d.individual_address,
            name: d.name,
            device_type: d.device_type,
            status: d.status,
            order_number: d.order_number || '',
            serial_number: d.serial_number || '',
            gas: (deviceGAMap[d.individual_address] || []).length,
          }) as Record<string, unknown>
        )[id] ?? '',
    );

  return (
    <div className={styles.root}>
      <SectionHeader
        title="Manufacturers"
        count={tree.length}
        actions={[
          <Btn
            key="csv"
            onClick={exportCSV}
            color="var(--muted)"
            bg="var(--surface)"
          >
            ↓ CSV
          </Btn>,
        ]}
      />
      <div className={styles.scrollArea}>
        {tree.length === 0 && <Empty icon="⊞" msg="No devices" />}
        {tree.map((mfr) => {
          const mfrKey = `m:${mfr.name}`;
          const mfrTotal = mfr.models.reduce((s, m) => s + m.devices.length, 0);
          return (
            <div key={mfr.name}>
              <div
                onClick={() => toggle(mfrKey)}
                className={`rh ${styles.mfrHeader}`}
              >
                <span className={styles.chevron}>
                  {isOpen(mfrKey) ? '▾' : '▸'}
                </span>
                <PinAddr
                  address={mfr.name}
                  wtype="manufacturer"
                  className={styles.mfrPinAddr}
                >
                  {mfr.name}
                </PinAddr>
                <span className={styles.mfrCount}>
                  · {mfrTotal} devices · {mfr.models.length} models
                </span>
                {projectId && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/projects/${projectId}/catalog`, {
                        state: { jumpTo: mfr.name },
                      });
                    }}
                    title="View in catalog"
                    className={`bg ${styles.catalogLink}`}
                  >
                    catalog
                  </span>
                )}
              </div>
              {isOpen(mfrKey) &&
                mfr.models.map((mdl) => {
                  const mdlKey = `m:${mfr.name}:${mdl.name}`;
                  return (
                    <div key={mdl.name}>
                      <div
                        onClick={() => toggle(mdlKey)}
                        className={`rh ${styles.mdlHeader}`}
                      >
                        <span className={styles.chevron}>
                          {isOpen(mdlKey) ? '▾' : '▸'}
                        </span>
                        <PinAddr
                          address={mdl.name}
                          wtype="model"
                          className={styles.mdlPinAddr}
                        >
                          {mdl.name}
                        </PinAddr>
                        <span className={styles.mfrCount}>
                          · {mdl.devices.length}
                        </span>
                        {onAddDevice && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setAddDefaults({
                                manufacturer: mfr.name,
                                model: mdl.name,
                              });
                            }}
                            title="Add another device of this type"
                            className={styles.addBtn}
                          >
                            +
                          </span>
                        )}
                      </div>
                      {isOpen(mdlKey) && (
                        <table className={styles.table}>
                          <thead>
                            <tr>
                              <TH className={styles.thAddrIndented}>ADDRESS</TH>
                              <TH>NAME</TH>
                              <TH>TYPE</TH>
                              <TH>STATUS</TH>
                              {spaces.length > 0 && <TH>LOCATION</TH>}
                              <TH>ORDER #</TH>
                              <TH>GAs</TH>
                            </tr>
                          </thead>
                          <tbody>
                            {mdl.devices.map((d: any) => (
                              <tr key={d.id} className="rh">
                                <TD className={styles.tdAddrIndented}>
                                  <PinAddr
                                    address={d.individual_address}
                                    wtype="device"
                                    className={styles.accentMono}
                                  />
                                </TD>
                                <TD>
                                  <span className={styles.textMuted}>
                                    {d.name}
                                  </span>
                                </TD>
                                <TD>
                                  <span className={styles.devType}>
                                    <DeviceTypeIcon
                                      type={d.device_type}
                                      size={12}
                                      style={{ color: 'var(--muted)' }}
                                    />
                                    <span className={styles.textMuted}>
                                      {d.device_type}
                                    </span>
                                  </span>
                                </TD>
                                <TD>
                                  <Badge
                                    label={d.status.toUpperCase()}
                                    color={
                                      STATUS_COLOR[d.status] || 'var(--dim)'
                                    }
                                  />
                                </TD>
                                {spaces.length > 0 && (
                                  <TD>
                                    <SpacePath
                                      spaceId={d.space_id}
                                      spaces={spaces}
                                      className={styles.dimLocPath}
                                    />
                                  </TD>
                                )}
                                <TD>
                                  {d.order_number ? (
                                    <PinAddr
                                      address={d.order_number}
                                      wtype="order_number"
                                      className={styles.orderPinAddr}
                                    >
                                      {d.order_number}
                                    </PinAddr>
                                  ) : (
                                    <span className={styles.textDim}>—</span>
                                  )}
                                </TD>
                                <TD>
                                  <span className={styles.textDim}>
                                    {(deviceGAMap[d.individual_address] || [])
                                      .length || '—'}
                                  </span>
                                </TD>
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
