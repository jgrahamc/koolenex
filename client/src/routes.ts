// ── URL helpers for react-router navigation ──────────────────────────────────

/** URL segment → view ID mapping */
const SEG_TO_VIEW: Record<string, string> = {
  locations: 'locations',
  floorplan: 'floorplan',
  topology: 'topology',
  devices: 'devices',
  device: 'pin',
  gas: 'groups',
  ga: 'pin',
  comobjects: 'comobjects',
  manufacturers: 'manufacturers',
  catalog: 'catalog',
  monitor: 'monitor',
  scan: 'scan',
  programming: 'programming',
  info: 'project',
  labels: 'printlabels',
  compare: 'pin',
  multicompare: 'pin',
  manufacturer: 'pin',
  model: 'pin',
  order: 'pin',
  space: 'pin',
};

/** Derive the active view ID from a pathname. */
export function viewFromPath(path: string): string {
  if (path === '/settings') return 'settings';
  if (path === '/' || !path.startsWith('/projects/')) return 'projects';
  const rest = path.replace(/^\/projects\/\d+\/?/, '');
  const seg = rest.split('/')[0] || 'locations';
  return SEG_TO_VIEW[seg] || 'locations';
}

/** Derive the pin key from a pathname, or null if not a pin view. */
export function pinKeyFromPath(path: string): string | null {
  if (!path.startsWith('/projects/')) return null;
  const rest = path.replace(/^\/projects\/\d+\/?/, '');
  const parts = rest.split('/');
  const seg = parts[0];

  if (seg === 'device' && parts.length >= 2)
    return `device:${parts.slice(1).join('.')}`;
  if (seg === 'ga' && parts.length >= 4)
    return `ga:${parts[1]}/${parts[2]}/${parts[3]}`;
  if (seg === 'compare' && parts.length >= 3)
    return `compare:${parts[1]}|${parts[2]}`;
  if (seg === 'multicompare' && parts.length >= 3)
    return `multicompare:${parts.slice(1).join('|')}`;
  if (seg === 'manufacturer' && parts.length >= 2)
    return `manufacturer:${decodeURIComponent(parts[1]!)}`;
  if (seg === 'model' && parts.length >= 2)
    return `model:${decodeURIComponent(parts[1]!)}`;
  if (seg === 'order' && parts.length >= 2)
    return `order_number:${decodeURIComponent(parts[1]!)}`;
  if (seg === 'space' && parts.length >= 2) return `space:${parts[1]}`;
  return null;
}

/** Build URL for a pin window entry. */
export function pinUrl(
  projectId: number | string | null | undefined,
  wtype: string,
  address: string,
): string {
  const pid = projectId;
  switch (wtype) {
    case 'device':
      return `/projects/${pid}/device/${address}`;
    case 'ga': {
      const parts = address.split('/');
      return `/projects/${pid}/ga/${parts[0]}/${parts[1]}/${parts[2]}`;
    }
    case 'compare': {
      const [a, b] = address.split('|');
      return `/projects/${pid}/compare/${a}/${b}`;
    }
    case 'multicompare': {
      const addrs = address.split('|');
      return `/projects/${pid}/multicompare/${addrs.join('/')}`;
    }
    case 'manufacturer':
      return `/projects/${pid}/manufacturer/${encodeURIComponent(address)}`;
    case 'model':
      return `/projects/${pid}/model/${encodeURIComponent(address)}`;
    case 'order_number':
      return `/projects/${pid}/order/${encodeURIComponent(address)}`;
    case 'space':
      return `/projects/${pid}/space/${address}`;
    default:
      return `/projects/${pid}/devices/${address}`;
  }
}
