/**
 * Tests for client utility functions: spacePath, buildSpaceMap.
 * These are pure functions that don't require React rendering.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpaceMap, spacePath } from '../client/src/hooks/spaces.ts';
import type { Space } from '../shared/types.ts';
import {
  deviceColumns,
  deviceColClass,
  DEVICE_COLUMNS,
  TOPOLOGY_COLUMNS,
  LOCATION_COLUMNS,
} from '../client/src/deviceColumns.ts';
import type { Column } from '../client/src/columns.tsx';

function makeSpace(
  id: number,
  name: string,
  type: Space['type'],
  parentId: number | null = null,
): Space {
  return {
    id,
    project_id: 1,
    name,
    type,
    parent_id: parentId,
    sort_order: 0,
    usage_id: '',
  };
}

describe('buildSpaceMap', () => {
  it('builds a map from id to Space', () => {
    const spaces = [
      makeSpace(1, 'Building A', 'Building'),
      makeSpace(2, 'Floor 1', 'Floor', 1),
      makeSpace(3, 'Room 101', 'Room', 2),
    ];
    const map = buildSpaceMap(spaces);
    assert.equal(Object.keys(map).length, 3);
    assert.equal(map[1]!.name, 'Building A');
    assert.equal(map[2]!.name, 'Floor 1');
    assert.equal(map[3]!.name, 'Room 101');
  });

  it('handles empty array', () => {
    const map = buildSpaceMap([]);
    assert.deepEqual(map, {});
  });
});

describe('spacePath', () => {
  const spaces = [
    makeSpace(1, 'Building A', 'Building'),
    makeSpace(2, 'Floor 1', 'Floor', 1),
    makeSpace(3, 'Room 101', 'Room', 2),
    makeSpace(4, 'Corridor', 'Corridor', 2),
  ];
  const map = buildSpaceMap(spaces);

  it('returns full path for a leaf space', () => {
    assert.equal(spacePath(3, map), 'Floor 1 › Room 101');
  });

  it('skips Building type in path', () => {
    // Building should not appear in the breadcrumb
    assert.equal(spacePath(2, map), 'Floor 1');
  });

  it('returns single segment for top-level non-Building space', () => {
    assert.equal(spacePath(2, map), 'Floor 1');
  });

  it('returns empty string for Building itself', () => {
    assert.equal(spacePath(1, map), '');
  });

  it('returns empty string for null/undefined spaceId', () => {
    assert.equal(spacePath(null, map), '');
    assert.equal(spacePath(undefined, map), '');
  });

  it('returns empty string for unknown spaceId', () => {
    assert.equal(spacePath(999, map), '');
  });

  it('uses custom separator', () => {
    assert.equal(spacePath(3, map, ' > '), 'Floor 1 > Room 101');
    assert.equal(spacePath(3, map, '/'), 'Floor 1/Room 101');
  });

  it('handles deep nesting', () => {
    const deepSpaces = [
      makeSpace(10, 'HQ', 'Building'),
      makeSpace(11, 'Wing A', 'Floor', 10),
      makeSpace(12, 'Section 1', 'Corridor', 11),
      makeSpace(13, 'Lab 42', 'Room', 12),
    ];
    const deepMap = buildSpaceMap(deepSpaces);
    assert.equal(spacePath(13, deepMap), 'Wing A › Section 1 › Lab 42');
  });

  it('handles Corridor type (non-Building) in path', () => {
    assert.equal(spacePath(4, map), 'Floor 1 › Corridor');
  });
});

// ── Device columns ───────────────────────────────────────────────────────────

describe('deviceColumns', () => {
  it('gives every view the same label for the same column id', () => {
    const label = (cols: Column[], id: string) =>
      cols.find((c) => c.id === id)?.label;
    for (const id of ['individual_address', 'device_type', 'gas', 'status']) {
      assert.equal(label(DEVICE_COLUMNS, id), label(TOPOLOGY_COLUMNS, id));
      assert.equal(label(DEVICE_COLUMNS, id), label(LOCATION_COLUMNS, id));
    }
  });

  it('keeps each view its own subset, in order', () => {
    assert.equal(DEVICE_COLUMNS.length, 15);
    assert.equal(TOPOLOGY_COLUMNS.length, 10);
    assert.equal(LOCATION_COLUMNS.length, 8);
    // Topology is the leading run of the full device set.
    assert.deepEqual(
      TOPOLOGY_COLUMNS.map((c) => c.id),
      DEVICE_COLUMNS.slice(0, 10).map((c) => c.id),
    );
    // Locations drops the columns it has no room for, keeping the order.
    assert.ok(!LOCATION_COLUMNS.some((c) => c.id === 'location'));
    assert.ok(!LOCATION_COLUMNS.some((c) => c.id === 'order_number'));
  });

  it('keeps each view its own default visibility', () => {
    const visible = (cols: Column[], id: string) =>
      cols.find((c) => c.id === id)?.visible;
    assert.equal(visible(DEVICE_COLUMNS, 'order_number'), false);
    assert.equal(visible(DEVICE_COLUMNS, 'status'), true);
    assert.equal(visible(TOPOLOGY_COLUMNS, 'order_number'), false);
    // Serial shows in the device and topology lists but not in locations.
    assert.equal(visible(DEVICE_COLUMNS, 'serial_number'), true);
    assert.equal(visible(TOPOLOGY_COLUMNS, 'serial_number'), true);
    assert.equal(visible(LOCATION_COLUMNS, 'serial_number'), false);
  });

  it('builds an arbitrary subset', () => {
    const cols = deviceColumns(['name', 'status'], ['status']);
    assert.deepEqual(cols, [
      { id: 'name', label: 'Name', visible: true },
      { id: 'status', label: 'Status', visible: false },
    ]);
  });
});

describe('deviceColClass', () => {
  // A view's CSS module only defines the classes it actually uses; a missing
  // one must come back undefined, exactly as the hand-written `: undefined`
  // chains this replaced did.
  const styles = {
    colAddr: 'a',
    colAddrIndented: 'ai',
    colGas: 'g',
    colStatus: 's',
  };

  it('maps an id to the view class that sizes it', () => {
    assert.equal(deviceColClass(styles, 'individual_address'), 'a');
    assert.equal(deviceColClass(styles, 'gas'), 'g');
    assert.equal(deviceColClass(styles, 'status'), 's');
  });

  it('returns undefined for a column this view does not size', () => {
    assert.equal(deviceColClass(styles, 'device_type'), undefined);
    assert.equal(deviceColClass(styles, 'name'), undefined);
    assert.equal(deviceColClass(styles, 'not_a_column'), undefined);
  });

  it('picks the indented address variant only when asked', () => {
    assert.equal(
      deviceColClass(styles, 'individual_address', { indentedAddress: true }),
      'ai',
    );
    assert.equal(deviceColClass(styles, 'gas', { indentedAddress: true }), 'g');
  });
});
