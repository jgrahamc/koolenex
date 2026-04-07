import { useState, useEffect, useMemo } from 'react';
import { useC, STATUS_COLOR } from '../theme.ts';
import {
  Badge,
  Btn,
  Empty,
  PinAddr,
  SpacePath,
  SectionHeader,
  TH,
  TD,
} from '../primitives.jsx';
import { DeviceTypeIcon } from '../icons.jsx';
import { dlCSV } from '../columns.jsx';

import { AddDeviceModal } from '../AddDeviceModal.jsx';

export function ManufacturersView({ data, onAddDevice, dispatch }) {
  const C = useC();
  const { devices, spaces = [], deviceGAMap = {} } = data;
  const [addDefaults, setAddDefaults] = useState(null);
  const [expanded, setExpanded] = useState(() => {
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
    const mfrs = {};
    for (const d of devices) {
      const mfr = d.manufacturer || '(Unknown)';
      const mdl = d.model || '(Unknown)';
      if (!mfrs[mfr]) mfrs[mfr] = {};
      if (!mfrs[mfr][mdl]) mfrs[mfr][mdl] = [];
      mfrs[mfr][mdl].push(d);
    }
    return Object.entries(mfrs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mfr, models]) => ({
        name: mfr,
        models: Object.entries(models)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([mdl, devs]) => ({
            name: mdl,
            devices: [...devs].sort((a, b) =>
              a.individual_address.localeCompare(b.individual_address),
            ),
          })),
      }));
  }, [devices]);

  const toggle = (key) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  const isOpen = (key) => !!expanded[key];

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
      (id, d) =>
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
        })[id] ?? '',
    );

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
        title="Manufacturers"
        count={tree.length}
        actions={[
          <Btn key="csv" onClick={exportCSV} color={C.muted} bg={C.surface}>
            ↓ CSV
          </Btn>,
        ]}
      />
      <div style={{ overflow: 'auto', flex: 1 }}>
        {tree.length === 0 && <Empty icon="⊞" msg="No devices" />}
        {tree.map((mfr) => {
          const mfrKey = `m:${mfr.name}`;
          const mfrTotal = mfr.models.reduce((s, m) => s + m.devices.length, 0);
          return (
            <div key={mfr.name}>
              {/* Manufacturer header */}
              <div
                onClick={() => toggle(mfrKey)}
                className="rh"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderBottom: `1px solid ${C.border}`,
                  background: C.surface,
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    fontSize: 9,
                    color: C.dim,
                    width: 14,
                    userSelect: 'none',
                    flexShrink: 0,
                  }}
                >
                  {isOpen(mfrKey) ? '▾' : '▸'}
                </span>
                <PinAddr
                  address={mfr.name}
                  wtype="manufacturer"
                  style={{ color: C.amber, fontSize: 11, fontWeight: 600 }}
                >
                  {mfr.name}
                </PinAddr>
                <span style={{ color: C.dim, fontSize: 10 }}>
                  · {mfrTotal} devices · {mfr.models.length} models
                </span>
                {dispatch && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({
                        type: 'CATALOG_JUMP',
                        manufacturer: mfr.name,
                      });
                    }}
                    title="View in catalog"
                    style={{
                      color: C.accent,
                      fontSize: 9,
                      marginLeft: 4,
                      cursor: 'pointer',
                      opacity: 0.7,
                    }}
                    className="bg"
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
                      {/* Model header */}
                      <div
                        onClick={() => toggle(mdlKey)}
                        className="rh"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '5px 14px 5px 28px',
                          borderBottom: `1px solid ${C.border}`,
                          background: C.hover,
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{
                            fontSize: 9,
                            color: C.dim,
                            width: 14,
                            userSelect: 'none',
                            flexShrink: 0,
                          }}
                        >
                          {isOpen(mdlKey) ? '▾' : '▸'}
                        </span>
                        <PinAddr
                          address={mdl.name}
                          wtype="model"
                          style={{
                            color: C.text,
                            fontSize: 10,
                            fontFamily: 'monospace',
                          }}
                        >
                          {mdl.name}
                        </PinAddr>
                        <span style={{ color: C.dim, fontSize: 10 }}>
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
                            style={{
                              color: C.green,
                              fontSize: 9,
                              cursor: 'pointer',
                              opacity: 0.7,
                            }}
                          >
                            +
                          </span>
                        )}
                      </div>
                      {/* Device table */}
                      {isOpen(mdlKey) && (
                        <table
                          style={{ width: '100%', borderCollapse: 'collapse' }}
                        >
                          <thead>
                            <tr>
                              <TH style={{ paddingLeft: 42 }}>ADDRESS</TH>
                              <TH>NAME</TH>
                              <TH>TYPE</TH>
                              <TH>STATUS</TH>
                              {spaces.length > 0 && <TH>LOCATION</TH>}
                              <TH>ORDER #</TH>
                              <TH>GAs</TH>
                            </tr>
                          </thead>
                          <tbody>
                            {mdl.devices.map((d) => (
                              <tr key={d.id} className="rh">
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
                                <TD>
                                  <span style={{ color: C.text }}>
                                    {d.name}
                                  </span>
                                </TD>
                                <TD>
                                  <span
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 5,
                                    }}
                                  >
                                    <DeviceTypeIcon
                                      type={d.device_type}
                                      size={12}
                                      style={{ color: C.muted }}
                                    />
                                    <span style={{ color: C.muted }}>
                                      {d.device_type}
                                    </span>
                                  </span>
                                </TD>
                                <TD>
                                  <Badge
                                    label={d.status.toUpperCase()}
                                    color={STATUS_COLOR[d.status] || C.dim}
                                  />
                                </TD>
                                {spaces.length > 0 && (
                                  <TD>
                                    <SpacePath
                                      spaceId={d.space_id}
                                      spaces={spaces}
                                      style={{ color: C.dim, fontSize: 10 }}
                                    />
                                  </TD>
                                )}
                                <TD>
                                  {d.order_number ? (
                                    <PinAddr
                                      address={d.order_number}
                                      wtype="order_number"
                                      style={{
                                        color: C.dim,
                                        fontFamily: 'monospace',
                                        fontSize: 10,
                                      }}
                                    >
                                      {d.order_number}
                                    </PinAddr>
                                  ) : (
                                    <span style={{ color: C.dim }}>—</span>
                                  )}
                                </TD>
                                <TD>
                                  <span style={{ color: C.dim }}>
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
