/**
 * ETS Dynamic-section condition evaluation, shared by the server (which
 * builds a device's download image from it) and the client (which builds
 * the parameter UI from it).
 *
 * This lived in four places until 2026-09-09 - server/routes/knx-tables.ts,
 * a nested copy in server/ets-app.ts's evalDynamic,
 * client/src/detail/DeviceParameters.tsx, and a private near-identical copy
 * inside each of five test files, which described themselves as
 * "replicate client logic". A device's parameter memory image and the UI
 * that edits it have to agree about which parameters are active, so the
 * predicate they agree by belongs in one place.
 */

/**
 * Test a value against an ETS `<when test="...">` condition list.
 *
 * Entries are either exact matches ('0', '1', 'foo') or relational
 * ('<2', '>0', '<=3', '>=1', '=4', '!=0'). A relational test against a
 * non-numeric value never matches; an exact test compares as strings.
 */
export function etsTestMatch(
  val: string | number,
  tests: (string | number)[] | null | undefined,
): boolean {
  const n = parseFloat(String(val));
  for (const t of tests || []) {
    const rm =
      typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]!);
      const op = rm[1];
      if (op === '<' && n < rv) return true;
      if (op === '>' && n > rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '=' && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === String(val)) {
      return true;
    }
  }
  return false;
}
