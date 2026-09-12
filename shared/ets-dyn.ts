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

// ── ETS dynamic tree ────────────────────────────────────────────────────────
// The stored model shape is a single recursive `items` array of tagged
// DynItems: dynTree.main.items -> DynItem[], where each item's `type` is one
// of cib/channel/block/choose/paramRef/assign/comRef/rename/separator. This
// mirrors the `DynItem` union emitted by server/ets-app.ts - NOT the legacy
// channels/cib/pb + paramRefs/blocks/choices shape that emission never
// actually produces.
//
// Lives here rather than in server/routes/knx-tables.ts because the client's
// parameter UI (client/src/detail/paramUI.ts) walks the same tree, and had
// been typing every step of that walk `any` for want of these.

/** One row or column of a Table-layout block. */
export interface TableCellSpec {
  text?: string;
  width?: string;
}

export interface DynWhen {
  test?: string[];
  isDefault?: boolean;
  items?: DynItem[];
}

export interface DynItem {
  type:
    | 'paramRef'
    | 'block'
    | 'channel'
    | 'cib'
    | 'choose'
    | 'assign'
    | 'comRef'
    | 'rename'
    | 'separator';
  // paramRef
  refId?: string;
  // block / channel / cib
  items?: DynItem[];
  // choose
  paramRefId?: string;
  defaultValue?: string | null;
  /**
   * The controlling parameter is <TypeNone/>, so it has no value and the
   * choose's `default` branch is the one it declares - see ets-app.ts's
   * DynItemChoose.controllerValueless. Absent on app models cached before
   * 2026-09-12.
   */
  controllerValueless?: boolean;
  whens?: DynWhen[];
  // assign
  target?: string;
  source?: string | null;
  value?: string | null;
  // Display metadata carried by the same items. The server's download path
  // ignores all of it; the client's parameter UI renders from it, and had
  // been walking the whole tree as `any` for want of these being declared.
  id?: string;
  name?: string;
  label?: string;
  text?: string;
  uiHint?: string;
  cell?: string;
  inline?: boolean;
  layout?: string;
  /** Table layout: one entry per row/column, with its header text and an
   *  optional CSS width. */
  rows?: TableCellSpec[];
  columns?: TableCellSpec[];
  /** Access="None" - downloaded but not offered for editing. */
  access?: string;
  accessNone?: boolean;
  /** Rename: the paramRef whose value supplies the new display text. */
  textParamRefId?: string;
}

export interface DynTree {
  main?: { items?: DynItem[] } | null;
  moduleDefs?: { id: string; items: DynItem[] }[];
}
