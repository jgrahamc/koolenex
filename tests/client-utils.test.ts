/**
 * Tests for client utility functions: spacePath, buildSpaceMap.
 * These are pure functions that don't require React rendering.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpaceMap, spacePath } from '../client/src/hooks/spaces.ts';
import type { Space } from '../shared/types.ts';

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
