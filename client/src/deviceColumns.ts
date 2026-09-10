/**
 * The device column catalogue, shared by every view that lists devices.
 *
 * DevicesView, TopologyView and LocationsView each showed the same device
 * columns with the same labels and the same widths, and each carried its
 * own copy of the list plus its own `col.id === 'x' ? styles.colX : ...`
 * chain (eight branches, seven, and four). Adding a column, renaming one,
 * or changing what a view shows by default meant editing whichever copies
 * you remembered.
 *
 * Each view still picks its own subset and its own default visibility -
 * that part genuinely differs. What they now share is the id, the label,
 * and which CSS class sizes the column.
 */
import type { Column } from './columns.tsx';

const LABELS = {
  individual_address: 'Address',
  name: 'Name',
  device_type: 'Type',
  location: 'Location',
  manufacturer: 'Manufacturer',
  model: 'Model',
  order_number: 'Order #',
  serial_number: 'Serial',
  status: 'Status',
  gas: 'GAs',
  description: 'Description',
  comment: 'Comment',
  area: 'Area',
  line: 'Line',
  last_download: 'Last Download',
} as const;

export type DeviceColumnId = keyof typeof LABELS;

/**
 * Build a view's column list: `ids` in display order, with `hidden` naming
 * the ones that start switched off. The user's own choices override these
 * defaults - useColumns() merges what it finds in localStorage.
 */
export function deviceColumns(
  ids: readonly DeviceColumnId[],
  hidden: readonly DeviceColumnId[] = [],
): Column[] {
  return ids.map((id) => ({
    id,
    label: LABELS[id],
    visible: !hidden.includes(id),
  }));
}

export const DEVICE_COLUMNS = deviceColumns(
  [
    'individual_address',
    'name',
    'device_type',
    'location',
    'manufacturer',
    'model',
    'order_number',
    'serial_number',
    'status',
    'gas',
    'description',
    'comment',
    'area',
    'line',
    'last_download',
  ],
  ['order_number', 'description', 'comment', 'area', 'line', 'last_download'],
);

export const TOPOLOGY_COLUMNS = deviceColumns(
  [
    'individual_address',
    'name',
    'device_type',
    'location',
    'manufacturer',
    'model',
    'order_number',
    'serial_number',
    'status',
    'gas',
  ],
  ['order_number'],
);

export const LOCATION_COLUMNS = deviceColumns(
  [
    'individual_address',
    'name',
    'device_type',
    'manufacturer',
    'model',
    'serial_number',
    'status',
    'gas',
  ],
  ['serial_number'],
);

/** Column id -> the CSS-module class name that sizes it. */
const COL_CLASS: Partial<Record<DeviceColumnId, string>> = {
  individual_address: 'colAddr',
  device_type: 'colType',
  manufacturer: 'colMfr',
  model: 'colModel',
  order_number: 'colOrder',
  serial_number: 'colSerial',
  status: 'colStatus',
  gas: 'colGas',
};

/**
 * The sizing class for a column, from the calling view's own CSS module -
 * the widths differ per view (TopologyView indents its address column,
 * LocationsView's status column is narrower), so the class name is shared
 * but the rule behind it is not. A view whose module has no such class
 * gets undefined, exactly as its hand-written chain's final `: undefined`
 * did.
 *
 * `indentedAddress` picks the tree-indented address variant that the
 * grouped tables in DevicesView and LocationsView use.
 */
export function deviceColClass(
  styles: Record<string, string>,
  id: string,
  opts?: { indentedAddress?: boolean },
): string | undefined {
  if (id === 'individual_address' && opts?.indentedAddress)
    return styles['colAddrIndented'];
  const cls = COL_CLASS[id as DeviceColumnId];
  return cls ? styles[cls] : undefined;
}
