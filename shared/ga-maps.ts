import type { GAMaps } from './types.ts';

/** Build device↔GA lookup maps from com objects with ga_address fields. */
export function buildGAMaps(
  comObjects: Array<{ device_address: string; ga_address: string }>,
): GAMaps {
  const deviceGAMap: Record<string, string[]> = {};
  const gaDeviceMap: Record<string, string[]> = {};
  for (const co of comObjects) {
    const da = co.device_address;
    for (const ga of (co.ga_address || '').split(/\s+/).filter(Boolean)) {
      if (!deviceGAMap[da]) deviceGAMap[da] = [];
      if (!deviceGAMap[da]!.includes(ga)) deviceGAMap[da]!.push(ga);
      if (!gaDeviceMap[ga]) gaDeviceMap[ga] = [];
      if (!gaDeviceMap[ga]!.includes(da)) gaDeviceMap[ga]!.push(da);
    }
  }
  return { deviceGAMap, gaDeviceMap };
}
