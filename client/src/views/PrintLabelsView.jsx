import { useState, useMemo, useRef } from 'react';
import { useC } from '../theme.ts';
import { Btn, Chip, SectionHeader } from '../primitives.jsx';

// Label sheet definitions (all dimensions in mm)
const SHEETS = [
  {
    id: 'avery-l4730',
    name: 'Avery L4730 — 17.8 x 10 mm, removable (270/sheet)',
    cols: 10,
    rows: 27,
    labelW: 17.8,
    labelH: 10,
    marginTop: 13,
    marginLeft: 6,
    gapX: 2.5,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l4731',
    name: 'Avery L4731 — 25.4 x 10 mm, removable (189/sheet)',
    cols: 7,
    rows: 27,
    labelW: 25.4,
    labelH: 10,
    marginTop: 13.43,
    marginLeft: 8.48,
    gapX: 2.54,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l4732',
    name: 'Avery L4732 — 35.6 x 16.9 mm, removable (80/sheet)',
    cols: 5,
    rows: 16,
    labelW: 35.6,
    labelH: 16.9,
    marginTop: 12.99,
    marginLeft: 11.02,
    gapX: 2.54,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l6008',
    name: 'Avery L6008 — 25.4 x 10 mm, silver polyester (189/sheet)',
    cols: 7,
    rows: 27,
    labelW: 25.4,
    labelH: 10,
    marginTop: 13.43,
    marginLeft: 8.48,
    gapX: 2.54,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l7636',
    name: 'Avery L7636 — 45.7 x 21.2 mm (48/sheet)',
    cols: 4,
    rows: 12,
    labelW: 45.7,
    labelH: 21.2,
    marginTop: 10.7,
    marginLeft: 8.8,
    gapX: 2.5,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l7651',
    name: 'Avery L7651 — 38.1 x 21.2 mm (65/sheet)',
    cols: 5,
    rows: 13,
    labelW: 38.1,
    labelH: 21.2,
    marginTop: 10.7,
    marginLeft: 8,
    gapX: 2.5,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  {
    id: 'avery-l7656',
    name: 'Avery L7656 — 46 x 11.1 mm (84/sheet)',
    cols: 4,
    rows: 21,
    labelW: 46,
    labelH: 11.1,
    marginTop: 10.8,
    marginLeft: 8.6,
    gapX: 2.5,
    gapY: 0,
    pageW: 210,
    pageH: 297,
  },
  { id: 'legend', name: 'Legend Sheet (full page table)', legend: true },
];

const FIELD_OPTIONS = [
  { id: 'address', label: 'Individual Address', default: true },
  { id: 'name', label: 'Device Name', default: true },
  { id: 'location', label: 'Location', default: true },
  { id: 'manufacturer', label: 'Manufacturer', default: false },
  { id: 'model', label: 'Model', default: false },
  { id: 'order_number', label: 'Order Number', default: false },
  { id: 'status', label: 'Status', default: false },
];

export function PrintLabelsView({ data, dispatch }) {
  const C = useC();
  const {
    devices = [],
    spaces = [],
    deviceGAMap: _deviceGAMap = {},
  } = data || {};
  const [sheetId, setSheetId] = useState('avery-l4732');
  const [fields, setFields] = useState(
    () => new Set(FIELD_OPTIONS.filter((f) => f.default).map((f) => f.id)),
  );
  const [selectedDevices, setSelectedDevices] = useState(
    () => new Set(devices.map((d) => d.individual_address)),
  );
  const [filterArea, setFilterArea] = useState('all');
  const _printRef = useRef(null);

  const spaceMap = useMemo(
    () => Object.fromEntries(spaces.map((s) => [s.id, s])),
    [spaces],
  );
  const spacePath = (spaceId) => {
    const parts = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' > ');
  };

  const areas = [...new Set(devices.map((d) => `${d.area}.${d.line}`))].sort();
  const filteredDevices = devices.filter(
    (d) =>
      selectedDevices.has(d.individual_address) &&
      (filterArea === 'all' || `${d.area}.${d.line}` === filterArea),
  );

  const toggleField = (id) =>
    setFields((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const toggleDevice = (addr) =>
    setSelectedDevices((prev) => {
      const n = new Set(prev);
      n.has(addr) ? n.delete(addr) : n.add(addr);
      return n;
    });

  const selectAll = () =>
    setSelectedDevices(new Set(devices.map((d) => d.individual_address)));
  const selectNone = () => setSelectedDevices(new Set());

  const sheet = SHEETS.find((s) => s.id === sheetId);

  const handlePrint = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(buildPrintHTML(filteredDevices, sheet, fields, spacePath));
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  const labelData = (d) => {
    const parts = [];
    if (fields.has('address'))
      parts.push({ text: d.individual_address, bold: true, size: 'large' });
    if (fields.has('name')) parts.push({ text: d.name, size: 'medium' });
    if (fields.has('location') && d.space_id)
      parts.push({ text: spacePath(d.space_id), size: 'small' });
    if (fields.has('manufacturer') && d.manufacturer)
      parts.push({ text: d.manufacturer, size: 'small' });
    if (fields.has('model') && d.model)
      parts.push({ text: d.model, size: 'small' });
    if (fields.has('order_number') && d.order_number)
      parts.push({ text: d.order_number, size: 'small' });
    if (fields.has('status')) parts.push({ text: d.status, size: 'small' });
    return parts;
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SectionHeader
        title="Print Labels"
        count={filteredDevices.length}
        actions={[
          <Btn
            key="back"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'devices' })}
            color={C.dim}
          >
            Back to Devices
          </Btn>,
          <Btn key="print" onClick={handlePrint} color={C.accent}>
            {sheet?.legend
              ? 'Print Legend Sheet'
              : `Print ${filteredDevices.length} Labels`}
          </Btn>,
        ]}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Settings panel */}
        <div
          style={{
            width: 280,
            borderRight: `1px solid ${C.border}`,
            overflow: 'auto',
            padding: 14,
            flexShrink: 0,
          }}
        >
          {/* Sheet format */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.08em',
                marginBottom: 6,
              }}
            >
              LABEL FORMAT
            </div>
            {SHEETS.map((s) => (
              <div
                key={s.id}
                onClick={() => setSheetId(s.id)}
                style={{
                  padding: '6px 8px',
                  fontSize: 10,
                  borderRadius: 4,
                  cursor: 'pointer',
                  marginBottom: 2,
                  background:
                    sheetId === s.id ? `${C.accent}18` : 'transparent',
                  color: sheetId === s.id ? C.accent : C.text,
                  fontWeight: sheetId === s.id ? 600 : 400,
                }}
                className="rh"
              >
                {s.name}
              </div>
            ))}
          </div>

          {/* Fields */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.08em',
                marginBottom: 6,
              }}
            >
              FIELDS
            </div>
            {FIELD_OPTIONS.map((f) => (
              <label
                key={f.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 0',
                  fontSize: 10,
                  color: C.text,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={fields.has(f.id)}
                  onChange={() => toggleField(f.id)}
                  style={{ accentColor: C.accent }}
                />
                {f.label}
              </label>
            ))}
          </div>

          {/* Area/Line filter */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 9,
                color: C.dim,
                letterSpacing: '0.08em',
                marginBottom: 6,
              }}
            >
              FILTER BY LINE
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <Chip
                active={filterArea === 'all'}
                onClick={() => setFilterArea('all')}
              >
                All
              </Chip>
              {areas.map((a) => (
                <Chip
                  key={a}
                  active={filterArea === a}
                  onClick={() => setFilterArea(a)}
                >
                  {a}
                </Chip>
              ))}
            </div>
          </div>

          {/* Device selection */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 6,
              }}
            >
              <span
                style={{ fontSize: 9, color: C.dim, letterSpacing: '0.08em' }}
              >
                DEVICES
              </span>
              <span style={{ fontSize: 9, color: C.dim }}>
                ({selectedDevices.size}/{devices.length})
              </span>
              <span
                onClick={selectAll}
                style={{ fontSize: 9, color: C.accent, cursor: 'pointer' }}
                className="bg"
              >
                all
              </span>
              <span
                onClick={selectNone}
                style={{ fontSize: 9, color: C.accent, cursor: 'pointer' }}
                className="bg"
              >
                none
              </span>
            </div>
            <div
              style={{
                maxHeight: 300,
                overflow: 'auto',
                border: `1px solid ${C.border}`,
                borderRadius: 4,
              }}
            >
              {devices.map((d) => (
                <label
                  key={d.individual_address}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                    borderBottom: `1px solid ${C.border}11`,
                    background: selectedDevices.has(d.individual_address)
                      ? `${C.accent}08`
                      : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedDevices.has(d.individual_address)}
                    onChange={() => toggleDevice(d.individual_address)}
                    style={{ accentColor: C.accent, flexShrink: 0 }}
                  />
                  <span
                    style={{
                      color: C.accent,
                      fontFamily: 'monospace',
                      fontSize: 9,
                      flexShrink: 0,
                    }}
                  >
                    {d.individual_address}
                  </span>
                  <span
                    style={{
                      color: C.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Preview */}
        <div
          style={{ flex: 1, overflow: 'auto', background: C.bg, padding: 20 }}
        >
          <div
            style={{
              fontSize: 9,
              color: C.dim,
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            PREVIEW
          </div>
          {sheet?.legend ? (
            <LegendPreview
              devices={filteredDevices}
              fields={fields}
              spacePath={spacePath}
              C={C}
            />
          ) : (
            <LabelPreview
              devices={filteredDevices}
              sheet={sheet}
              labelData={labelData}
              C={C}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LabelPreview({ devices, sheet, labelData, C }) {
  if (!sheet || !devices.length)
    return (
      <div style={{ color: C.dim, fontSize: 11 }}>No devices selected</div>
    );
  const labelsPerPage = sheet.cols * sheet.rows;
  const pages = [];
  for (let i = 0; i < devices.length; i += labelsPerPage) {
    pages.push(devices.slice(i, i + labelsPerPage));
  }
  const scale = 2.5; // mm to px for preview
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        alignItems: 'center',
      }}
    >
      {pages.map((page, pi) => (
        <div
          key={pi}
          style={{
            width: sheet.pageW * scale,
            height: sheet.pageH * scale,
            background: 'white',
            border: '1px solid #ccc',
            borderRadius: 4,
            position: 'relative',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          {page.map((d, i) => {
            const col = i % sheet.cols;
            const row = Math.floor(i / sheet.cols);
            const x = sheet.marginLeft + col * (sheet.labelW + sheet.gapX);
            const y = sheet.marginTop + row * (sheet.labelH + sheet.gapY);
            const parts = labelData(d);
            return (
              <div
                key={d.individual_address}
                style={{
                  position: 'absolute',
                  left: x * scale,
                  top: y * scale,
                  width: sheet.labelW * scale,
                  height: sheet.labelH * scale,
                  border: '0.5px dashed #ccc',
                  padding: `${1 * scale}px ${1.5 * scale}px`,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                }}
              >
                {parts.map((p, j) => (
                  <div
                    key={j}
                    style={{
                      fontSize:
                        p.size === 'large' ? 8 : p.size === 'medium' ? 6 : 5,
                      fontWeight: p.bold ? 700 : 400,
                      color: '#000',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.text}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function LegendPreview({ devices, fields, spacePath, C }) {
  if (!devices.length)
    return (
      <div style={{ color: C.dim, fontSize: 11 }}>No devices selected</div>
    );
  const cols = FIELD_OPTIONS.filter((f) => fields.has(f.id));
  return (
    <div
      style={{
        background: 'white',
        borderRadius: 4,
        padding: 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 9,
          color: '#000',
        }}
      >
        <thead>
          <tr>
            {cols.map((f) => (
              <th
                key={f.id}
                style={{
                  textAlign: 'left',
                  padding: '4px 6px',
                  borderBottom: '2px solid #333',
                  fontWeight: 700,
                  fontSize: 8,
                  letterSpacing: '0.05em',
                }}
              >
                {f.label.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.individual_address}>
              {cols.map((f) => (
                <td
                  key={f.id}
                  style={{
                    padding: '3px 6px',
                    borderBottom: '0.5px solid #ddd',
                    fontWeight: f.id === 'address' ? 700 : 400,
                    fontFamily:
                      f.id === 'address' || f.id === 'order_number'
                        ? 'monospace'
                        : 'inherit',
                  }}
                >
                  {f.id === 'address'
                    ? d.individual_address
                    : f.id === 'name'
                      ? d.name
                      : f.id === 'location'
                        ? d.space_id
                          ? spacePath(d.space_id)
                          : ''
                        : f.id === 'manufacturer'
                          ? d.manufacturer || ''
                          : f.id === 'model'
                            ? d.model || ''
                            : f.id === 'order_number'
                              ? d.order_number || ''
                              : f.id === 'status'
                                ? d.status || ''
                                : ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildPrintHTML(devices, sheet, fields, spacePath) {
  const fieldArr = FIELD_OPTIONS.filter((f) => fields.has(f.id));

  if (sheet.legend) {
    const headerCells = fieldArr
      .map(
        (f) =>
          `<th style="text-align:left;padding:4px 6px;border-bottom:2px solid #333;font-weight:700;font-size:9px;letter-spacing:0.05em">${f.label.toUpperCase()}</th>`,
      )
      .join('');
    const rows = devices
      .map((d) => {
        const cells = fieldArr
          .map((f) => {
            const val =
              f.id === 'address'
                ? d.individual_address
                : f.id === 'name'
                  ? d.name
                  : f.id === 'location'
                    ? d.space_id
                      ? spacePath(d.space_id)
                      : ''
                    : f.id === 'manufacturer'
                      ? d.manufacturer || ''
                      : f.id === 'model'
                        ? d.model || ''
                        : f.id === 'order_number'
                          ? d.order_number || ''
                          : f.id === 'status'
                            ? d.status || ''
                            : '';
            const style = `padding:3px 6px;border-bottom:0.5px solid #ddd;${f.id === 'address' ? 'font-weight:700;font-family:monospace;' : ''}${f.id === 'order_number' ? 'font-family:monospace;' : ''}`;
            return `<td style="${style}">${esc(val)}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('\n');
    return `<!DOCTYPE html><html><head><style>
      @page { size: A4; margin: 10mm; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #000; margin: 0; }
      table { width: 100%; border-collapse: collapse; }
    </style></head><body>
      <table><thead><tr>${headerCells}</tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
  }

  // Label sheet
  const labelsPerPage = sheet.cols * sheet.rows;
  const pages = [];
  for (let i = 0; i < devices.length; i += labelsPerPage)
    pages.push(devices.slice(i, i + labelsPerPage));

  const labelHTML = pages
    .map((page, pi) => {
      const labels = page
        .map((d, i) => {
          const col = i % sheet.cols;
          const row = Math.floor(i / sheet.cols);
          const x = sheet.marginLeft + col * (sheet.labelW + sheet.gapX);
          const y = sheet.marginTop + row * (sheet.labelH + sheet.gapY);
          const lines = [];
          const sz =
            sheet.labelH > 15
              ? { lg: 9, md: 7, sm: 6 }
              : sheet.labelH > 12
                ? { lg: 7, md: 5.5, sm: 4.5 }
                : { lg: 6, md: 4.5, sm: 3.8 };
          if (fields.has('address'))
            lines.push(
              `<div style="font-weight:700;font-size:${sz.lg}px">${esc(d.individual_address)}</div>`,
            );
          if (fields.has('name'))
            lines.push(
              `<div style="font-size:${sz.md}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</div>`,
            );
          if (fields.has('location') && d.space_id)
            lines.push(
              `<div style="font-size:${sz.sm}px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(spacePath(d.space_id))}</div>`,
            );
          if (fields.has('manufacturer') && d.manufacturer)
            lines.push(
              `<div style="font-size:${sz.sm}px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.manufacturer)}</div>`,
            );
          if (fields.has('model') && d.model)
            lines.push(
              `<div style="font-size:${sz.sm}px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.model)}</div>`,
            );
          if (fields.has('order_number') && d.order_number)
            lines.push(
              `<div style="font-size:${sz.sm}px;color:#555;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.order_number)}</div>`,
            );
          if (fields.has('status'))
            lines.push(
              `<div style="font-size:${sz.sm}px;color:#555">${esc(d.status)}</div>`,
            );
          return `<div style="position:absolute;left:${x}mm;top:${y}mm;width:${sheet.labelW}mm;height:${sheet.labelH}mm;overflow:hidden;display:flex;flex-direction:column;justify-content:center;padding:0.5mm 1mm;box-sizing:border-box">${lines.join('')}</div>`;
        })
        .join('\n');
      return `<div style="position:relative;width:${sheet.pageW}mm;height:${sheet.pageH}mm;page-break-after:${pi < pages.length - 1 ? 'always' : 'auto'}">${labels}</div>`;
    })
    .join('\n');

  return `<!DOCTYPE html><html><head><style>
    @page { size: A4; margin: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; padding: 0; }
    div { line-height: 1.2; }
  </style></head><body>${labelHTML}</body></html>`;
}

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
