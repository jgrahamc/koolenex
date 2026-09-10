/**
 * Normalising a DPT to its canonical dotted key ('9.001').
 *
 * ETS writes a datapoint type three ways - 'DPST-9-1', 'DPT-9-1' and '9.1' -
 * and everything that looks a DPT up (the master-data tables, the decoder,
 * the UI's formatters) keys on '9.001'. The client and the server each had
 * their own copy of this, differing only at the edges, with
 * tests/normalize-consistency.test.ts existing purely to keep the two in
 * step. This is the one implementation; the two callers keep their own thin
 * adapters for what they want back when there is no usable key.
 *
 * Returns null when the input cannot be made into a key - empty, or a bare
 * main number like '9', which is a real DPT family but not a key any table
 * is indexed by.
 */
export function normalizeDptKey(
  dpt: string | number | null | undefined,
): string | null {
  if (dpt == null || dpt === '') return null;
  // Trimmed: a stray space used to survive into the key on the server side
  // (' 9.1' padded to ' 9.001'), which then matched nothing.
  const s = String(dpt).trim();
  if (!s) return null;
  const m = s.match(/^DPS?T-(\d+)-(\d+)$/i);
  if (m) return `${m[1]}.${m[2]!.padStart(3, '0')}`;
  if (s.includes('.')) {
    const [main, sub] = s.split('.');
    return `${main}.${(sub ?? '').padStart(3, '0')}`;
  }
  return null;
}
