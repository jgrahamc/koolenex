import { useState, useMemo } from 'react';
import { Btn, Chip, SectionHeader } from '../primitives.tsx';
import styles from './PrintLabelsView.module.css';

// Label sheet definitions (all dimensions in mm)
const SHEETS: any[] = [
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

interface PrintLabelsViewProps {
  data: any;
  dispatch: (action: any) => void;
}

export function PrintLabelsView({ data, dispatch }: PrintLabelsViewProps) {
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
    () => new Set(devices.map((d: any) => d.individual_address)),
  );
  const [filterArea, setFilterArea] = useState('all');
  const spaceMap = useMemo(
    () => Object.fromEntries(spaces.map((s: any) => [s.id, s])),
    [spaces],
  );
  const spacePath = (spaceId: any) => {
    const parts: string[] = [];
    let cur = spaceMap[spaceId];
    while (cur) {
      if (cur.type !== 'Building') parts.unshift(cur.name);
      cur = cur.parent_id ? spaceMap[cur.parent_id] : null;
    }
    return parts.join(' > ');
  };

  const areas = [
    ...new Set(devices.map((d: any) => `${d.area}.${d.line}`)),
  ].sort() as string[];
  const filteredDevices = devices.filter(
    (d: any) =>
      selectedDevices.has(d.individual_address) &&
      (filterArea === 'all' || `${d.area}.${d.line}` === filterArea),
  );

  const toggleField = (id: string) =>
    setFields((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
      }
      return n;
    });

  const toggleDevice = (addr: string) =>
    setSelectedDevices((prev) => {
      const n = new Set(prev);
      if (n.has(addr)) {
        n.delete(addr);
      } else {
        n.add(addr);
      }
      return n;
    });

  const selectAll = () =>
    setSelectedDevices(new Set(devices.map((d: any) => d.individual_address)));
  const selectNone = () => setSelectedDevices(new Set());

  const sheet = SHEETS.find((s) => s.id === sheetId);

  const handlePrint = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(buildPrintHTML(filteredDevices, sheet, fields, spacePath));
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  const labelData = (d: any) => {
    const parts: { text: string; bold?: boolean; size: string }[] = [];
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
    <div className={styles.root}>
      <SectionHeader
        title="Print Labels"
        count={filteredDevices.length}
        actions={[
          <Btn
            key="back"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'devices' })}
            color="var(--dim)"
          >
            Back to Devices
          </Btn>,
          <Btn key="print" onClick={handlePrint} color="var(--accent)">
            {sheet?.legend
              ? 'Print Legend Sheet'
              : `Print ${filteredDevices.length} Labels`}
          </Btn>,
        ]}
      />

      <div className={styles.body}>
        {/* Settings panel */}
        <div className={styles.settingsPanel}>
          {/* Sheet format */}
          <div className={styles.sectionGroup}>
            <div className={styles.sectionLabel}>LABEL FORMAT</div>
            {SHEETS.map((s) => (
              <div
                key={s.id}
                onClick={() => setSheetId(s.id)}
                className={`${styles.sheetOption} rh ${sheetId === s.id ? styles.sheetOptionActive : styles.sheetOptionInactive}`}
              >
                {s.name}
              </div>
            ))}
          </div>

          {/* Fields */}
          <div className={styles.sectionGroup}>
            <div className={styles.sectionLabel}>FIELDS</div>
            {FIELD_OPTIONS.map((f) => (
              <label key={f.id} className={styles.fieldLabel}>
                <input
                  type="checkbox"
                  checked={fields.has(f.id)}
                  onChange={() => toggleField(f.id)}
                  className={styles.fieldCheck}
                />
                {f.label}
              </label>
            ))}
          </div>

          {/* Area/Line filter */}
          <div className={styles.sectionGroup}>
            <div className={styles.sectionLabel}>FILTER BY LINE</div>
            <div className={styles.filterRow}>
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
            <div className={styles.devHeader}>
              <span className={styles.devHeaderLabel}>DEVICES</span>
              <span className={styles.devCount}>
                ({selectedDevices.size}/{devices.length})
              </span>
              <span onClick={selectAll} className={`${styles.selLink} bg`}>
                all
              </span>
              <span onClick={selectNone} className={`${styles.selLink} bg`}>
                none
              </span>
            </div>
            <div className={styles.devList}>
              {devices.map((d: any) => (
                <label
                  key={d.individual_address}
                  className={`${styles.devItem} ${selectedDevices.has(d.individual_address) ? styles.devItemSelected : styles.devItemUnselected}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedDevices.has(d.individual_address)}
                    onChange={() => toggleDevice(d.individual_address)}
                    className={styles.fieldCheckNoShrink}
                  />
                  <span className={styles.devAddr}>{d.individual_address}</span>
                  <span className={styles.devName}>{d.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className={styles.previewArea}>
          <div className={styles.previewLabel}>PREVIEW</div>
          {sheet?.legend ? (
            <LegendPreview
              devices={filteredDevices}
              fields={fields}
              spacePath={spacePath}
            />
          ) : (
            <LabelPreview
              devices={filteredDevices}
              sheet={sheet}
              labelData={labelData}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LabelPreview({
  devices,
  sheet,
  labelData,
}: {
  devices: any[];
  sheet: any;
  labelData: (d: any) => any[];
}) {
  if (!sheet || !devices.length)
    return <div className={styles.noDevices}>No devices selected</div>;
  const labelsPerPage = sheet.cols * sheet.rows;
  const pages: any[][] = [];
  for (let i = 0; i < devices.length; i += labelsPerPage) {
    pages.push(devices.slice(i, i + labelsPerPage));
  }
  const scale = 2.5;
  return (
    <div className={styles.pagesWrap}>
      {pages.map((page, pi) => (
        <div
          key={pi}
          className={styles.pageSheet}
          style={{
            width: sheet.pageW * scale,
            height: sheet.pageH * scale,
          }}
        >
          {page.map((d: any, i: number) => {
            const col = i % sheet.cols;
            const row = Math.floor(i / sheet.cols);
            const x = sheet.marginLeft + col * (sheet.labelW + sheet.gapX);
            const y = sheet.marginTop + row * (sheet.labelH + sheet.gapY);
            const parts = labelData(d);
            return (
              <div
                key={d.individual_address}
                className={styles.labelCell}
                style={{
                  left: x * scale,
                  top: y * scale,
                  width: sheet.labelW * scale,
                  height: sheet.labelH * scale,
                  padding: `${1 * scale}px ${1.5 * scale}px`,
                }}
              >
                {parts.map((p: any, j: number) => (
                  <div
                    key={j}
                    className={styles.labelPart}
                    style={{
                      fontSize:
                        p.size === 'large' ? 8 : p.size === 'medium' ? 6 : 5,
                      fontWeight: p.bold ? 700 : 400,
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

function LegendPreview({
  devices,
  fields,
  spacePath,
}: {
  devices: any[];
  fields: Set<string>;
  spacePath: (id: any) => string;
}) {
  if (!devices.length)
    return <div className={styles.noDevices}>No devices selected</div>;
  const cols = FIELD_OPTIONS.filter((f) => fields.has(f.id));
  return (
    <div className={styles.legendWrap}>
      <table className={styles.legendTable}>
        <thead>
          <tr>
            {cols.map((f) => (
              <th key={f.id} className={styles.legendTh}>
                {f.label.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {devices.map((d: any) => (
            <tr key={d.individual_address}>
              {cols.map((f) => (
                <td
                  key={f.id}
                  className={styles.legendTd}
                  style={{
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

function buildPrintHTML(
  devices: any[],
  sheet: any,
  fields: Set<string>,
  spacePath: (id: any) => string,
) {
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
  const pages: any[][] = [];
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
          const lines: string[] = [];
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

function esc(s: string) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
