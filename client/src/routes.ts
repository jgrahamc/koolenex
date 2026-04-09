// ── URL helpers for react-router navigation ──────────────────────────────────

/** Build URL for a pin window entry */
export function pinUrl(
  projectId: number | string | null | undefined,
  wtype: string,
  address: string,
): string {
  const pid = projectId;
  switch (wtype) {
    case 'device':
      return `/projects/${pid}/devices/${address}`;
    case 'ga': {
      const parts = address.split('/');
      return `/projects/${pid}/gas/${parts[0]}/${parts[1]}/${parts[2]}`;
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
