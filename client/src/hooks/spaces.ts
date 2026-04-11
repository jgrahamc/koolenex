import { useMemo, useCallback } from 'react';
import type { Space } from '../../../shared/types.ts';

/** Build a lookup map from space id → Space. */
export function buildSpaceMap(spaces: Space[]): Record<number, Space> {
  return Object.fromEntries(spaces.map((s) => [s.id, s]));
}

/**
 * Build a breadcrumb path for a space, e.g. "Floor 1 › Room 3".
 * Skips the root "Building" node.
 */
export function spacePath(
  spaceId: number | null | undefined,
  spaceMap: Record<number, Space>,
  separator = ' › ',
): string {
  if (spaceId == null) return '';
  const parts: string[] = [];
  let cur: Space | undefined = spaceMap[spaceId];
  while (cur) {
    if (cur.type !== 'Building') parts.unshift(cur.name);
    cur = cur.parent_id ? spaceMap[cur.parent_id] : undefined;
  }
  return parts.join(separator);
}

/**
 * Hook that returns a memoized spaceMap and spacePath function.
 */
export function useSpacePath(spaces: Space[], separator = ' › ') {
  const spaceMap = useMemo(() => buildSpaceMap(spaces), [spaces]);
  const getPath = useCallback(
    (spaceId: number | null | undefined) =>
      spacePath(spaceId, spaceMap, separator),
    [spaceMap, separator],
  );
  return { spaceMap, spacePath: getPath };
}
