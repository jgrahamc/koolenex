import { useState, useMemo, useRef, useEffect } from 'react';
import { Btn, Badge, SearchBox, Empty } from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import type { VerifyDecodedParam, GroupObjectEntryFlags } from '../api.ts';
import { useVerifyCache } from '../contexts.ts';
import styles from './DeviceComparisonView.module.css';

// Was a per-section hash-derived hue (every section its own colour) - real
// feedback: with every table now collapsed by default (see
// expandedSections below), the original reason for that - making a long,
// fully-expanded page's sections tell apart at a glance - matters much
// less, and the hash's arbitrary results ("doesn't look right") weren't
// worth keeping just for their own sake. One calm, deliberate hue for
// every ordinary section now; Group Addresses and Group Object Table keep
// their own fixed hues (a real, deliberate distinction - see the call
// site's own comment - not just "different colour for variety").
const NEUTRAL_SECTION_HUE = 230;
function sectionHue(name: string): number {
  if (name === 'Group Addresses') return 205;
  if (name === 'Group Object Table') return 280;
  return NEUTRAL_SECTION_HUE;
}

function sectionId(name: string): string {
  return 'sec-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** User-facing rename for section names that are correct KNX terminology but
 * opaque to a non-protocol-engineer. The server's own `section` string
 * ('Group Object Table', see docs/knx-device-write-protocol.md §6.4) stays
 * unchanged as a comparison key everywhere (filtering, tests, server
 * responses) - this only renames what's painted on screen. Exported so
 * ProgrammingView's log lines reuse the same mapping. */
export function displaySectionName(section: string): string {
  if (section === 'Group Object Table') return 'Communication Flags';
  return section;
}

/** Compose a "5 params / 2 GAs / 1 Object 3" style count string from any
 * number of scoped counts, omitting whichever entries are zero. Used for
 * the combined match/differ summary badges below. Takes an arbitrary list
 * of scoped counts, so Object 3's own separately-tracked count can fold in
 * alongside GA's without hardcoding a third fixed parameter. */
function composeCount(entries: Array<{ count: number; word: string }>): string {
  return entries
    .filter((e) => e.count > 0)
    .map((e) => `${e.count} ${e.word}${e.count === 1 ? '' : 's'}`)
    .join(' / ');
}

/**
 * Where a decoded parameter lives in the parameter segment, and whether the
 * download writes it: "0x1a" for a whole byte, "0x1a.3+2" for a 2-bit field
 * at bit 3, with a trailing "!" when the download never writes those bytes
 * (VerifyDecodedParam.written) and the Project side is therefore a decode of
 * the segment's fill rather than an expectation.
 */
function byteLayout(r: VerifyDecodedParam): string {
  const whole = r.bitOffset === 0 && r.bitSize % 8 === 0;
  const where = whole
    ? `0x${r.offset.toString(16)}`
    : `0x${r.offset.toString(16)}.${r.bitOffset}+${r.bitSize}`;
  return r.written === false ? `${where} !` : where;
}

/** Compact match/differ glyph for the per-row MATCH column - a text Badge
 * has a fixed minimum width from its own padding that overflows a narrow
 * column; a small fixed-size icon has no such floor. */
function MatchIcon({ match }: { match: boolean | null }) {
  if (match === true)
    return (
      <span
        className={styles.matchIcon}
        style={{ color: 'var(--green)' }}
        title="Match"
      >
        ✓
      </span>
    );
  if (match === false)
    return (
      <span
        className={styles.matchIcon}
        style={{ color: 'var(--red)' }}
        title="Differs"
      >
        ✕
      </span>
    );
  return (
    <span
      className={styles.matchIcon}
      style={{ color: 'var(--dim)' }}
      title="Not applicable"
    >
      –
    </span>
  );
}

// Object 3's boolean flags, in ETS's own parameter-UI checkbox order
// (Communication, Read, Write, Transmit, Update, Read On Init) - not the
// underlying wire bit order (see computeGroupObjectByte()). `commLinked` is
// bit 2 (Communication AND has-a-real-GA-link, combined) but labeled plain
// "C", matching ETS's own checkbox the byte can't fully distinguish from.
const FLAG_CHIP_ORDER: Array<{
  key: keyof GroupObjectEntryFlags;
  letter: string;
  label: string;
}> = [
  {
    key: 'commLinked',
    letter: 'C',
    label: 'Communication (+ has a real GA link)',
  },
  { key: 'read', letter: 'R', label: 'Read' },
  { key: 'write', letter: 'W', label: 'Write' },
  { key: 'transmit', letter: 'T', label: 'Transmit' },
  { key: 'update', letter: 'U', label: 'Update' },
  { key: 'readOnInit', letter: 'RI', label: 'Read On Init' },
];

/** Object 3's compact per-flag display: one small letter chip per boolean flag (green = set,
 * muted = clear), Priority/Size as plain text alongside. Each chip carries its own short tooltip
 * (via the app's standard `.tip`/`data-tip` mechanism, not the native `title`) rather than one
 * composite tooltip for the row - a row-wide tooltip anchored at the left edge pushed its wide
 * (~380px) box off-screen for columns near the viewport edge. `other` (the opposite project/
 * device side) only rings a chip red when the two sides disagree on that one flag - purely
 * visual, doesn't affect the row's own match icon. */
function FlagChips({
  flags,
  other,
}: {
  flags: GroupObjectEntryFlags | null | undefined;
  other?: GroupObjectEntryFlags | null;
}) {
  if (!flags) return <span className={styles.groupCell}>—</span>;
  return (
    <span className={styles.flagChips}>
      {FLAG_CHIP_ORDER.map(({ key, letter, label }) => {
        const on = flags[key] as boolean;
        const differs = other != null && other[key] !== flags[key];
        return (
          <span
            key={key}
            className={`${styles.tip} ${styles.flagChip} ${on ? styles.flagChipOn : styles.flagChipOff} ${differs ? styles.flagChipDiffer : ''}`}
            data-tip={`${label}: ${on ? 'Yes' : 'No'}`}
          >
            {letter}
          </span>
        );
      })}
      <span className={styles.flagMeta}>
        {flags.priority} · {flags.size}
      </span>
    </span>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

interface DeviceLike {
  id: number;
  individual_address: string;
  name: string;
  device_type: string;
}

/**
 * Displays a device's cached verify-device result (decoded parameters or
 * raw properties) side-by-side with what the project expects, plus the
 * live in-progress read state if one is running. Pure display + filtering -
 * does NOT trigger a bus read itself; the host (the standalone Device vs
 * Project page, or Programming's slide-over) is responsible for that via
 * the shared VerifyCacheCtx, so this component works identically embedded
 * either way.
 */
export function DeviceCompareResults({
  device,
  showDeviceLabel = true,
}: {
  device: DeviceLike | null;
  /** Hide the device name/icon row when the host already shows it
   * elsewhere (e.g. the slide-over's own header). */
  showDeviceLabel?: boolean;
}) {
  const { cache, progress } = useVerifyCache();

  const [search, setSearch] = useState('');
  // Row filter driven by the summary chips above the table ("N match" / "N
  // differ") instead of a separate checkbox - clicking a chip filters to
  // that outcome, clicking it again (or the same state) returns to 'all'.
  const [rowFilter, setRowFilter] = useState<'all' | 'differ' | 'match'>('all');
  const [onlyNamed, setOnlyNamed] = useState(true);
  const [showGroupCol, setShowGroupCol] = useState(false);
  // Diagnostic column: where in the parameter segment each row was decoded
  // from, and whether the download writes it. Two rows reporting different
  // values from the same byte signal a union of mutually-exclusive
  // alternatives, which otherwise reads as unrelated mismatches.
  const [showLayoutCol, setShowLayoutCol] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionsPopoverRef = useRef<HTMLDivElement | null>(null);
  // Which ONE section is expanded, by name - `null` means every section
  // starts collapsed (accordion behaviour, real feedback: opening a second
  // section should close whichever one was already open, rather than
  // stacking every table someone has looked at down the page). Scoped to
  // sections *within* the Parameters category - see `expandedCategory`
  // below for the outer axis.
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const toggleSection = (name: string): void => {
    setExpandedSection((prev) => (prev === name ? null : name));
  };
  // Real ETS parameter sections (D01, Enabled Functions, ...), Group
  // Addresses and the Group Object Table (Communication Flags) used to be
  // flat siblings in one accordion, sorted alphabetically together, so a
  // "Group Addresses" entry could sit between two unrelated parameter
  // sections purely by alphabetical accident. Grouped instead: a Parameters
  // group broken down by section, with Group Addresses/Object 3 kept as
  // their own separate group after it - one outer accordion axis for the
  // category, independent of which individual parameter section is open
  // inside it.
  const [expandedCategory, setExpandedCategory] = useState<
    'parameters' | 'ga' | 'obj3' | null
  >(null);
  const toggleCategory = (cat: 'parameters' | 'ga' | 'obj3'): void => {
    setExpandedCategory((prev) => (prev === cat ? null : cat));
  };

  const cacheEntry = device ? cache[device.id] : undefined;
  const result = cacheEntry?.result ?? null;
  const liveProgress = device ? progress[device.individual_address] : undefined;
  const loading = !!liveProgress && !cacheEntry;

  const decoded = result?.decoded ?? null;

  // Smart default: a fresh result with any differing parameter defaults to
  // showing all differences including unnamed ones. With no differences,
  // default to the "match" filter instead of "all" so the active-filter
  // ring lands on the named-parameters "All N matched" chip rather than the
  // muted raw-memory chip. Applies once per distinct result (device+
  // fetchedAt) so it never fights a manual filter toggle.
  const appliedDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!decoded || !device) return;
    const key = `${device.id}:${cacheEntry?.fetchedAt ?? ''}`;
    if (appliedDefaultKeyRef.current === key) return;
    appliedDefaultKeyRef.current = key;
    const hasMismatch = decoded.some(
      (d) => d.match === false && d.isVisible !== false,
    );
    setRowFilter(hasMismatch ? 'differ' : 'match');
    setOnlyNamed(!hasMismatch);
  }, [decoded, device, cacheEntry]);
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (decoded ?? []).filter((d) => {
        if (rowFilter === 'differ' && d.match !== false) return false;
        if (rowFilter === 'match' && d.match !== true) return false;
        if (onlyNamed && d.label === d.key) return false;
        if (!q) return true;
        return (
          d.label.toLowerCase().includes(q) ||
          d.section.toLowerCase().includes(q) ||
          d.group.toLowerCase().includes(q)
        );
      }),
    [decoded, rowFilter, onlyNamed, q],
  );

  const bySection = useMemo(() => {
    const m = new Map<string, VerifyDecodedParam[]>();
    for (const row of filtered) {
      const key = row.section || '(Ungrouped)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(row);
    }
    return m;
  }, [filtered]);

  const sections = Array.from(bySection.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );

  // GA link rows (server-side section 'Group Addresses') and Object 3 rows
  // ('Group Object Table' - flags/priority/size) are folded into the same
  // `decoded` array as named parameters, but are a different kind of thing
  // (not a byte-mapped parameter value) - the summary badges below scope
  // "params matched"/"differ" to exclude both and show their own separate
  // counts, so a mismatch in either can't hide inside the params number.
  const nonParamSections = new Set(['Group Addresses', 'Group Object Table']);
  const gaDecoded = decoded
    ? decoded.filter((d) => d.section === 'Group Addresses')
    : [];
  const obj3Decoded = decoded
    ? decoded.filter((d) => d.section === 'Group Object Table')
    : [];
  const paramDecoded = decoded
    ? decoded.filter((d) => !nonParamSections.has(d.section))
    : [];
  // An Access="None" (isVisible: false) row - download-only, never shown in
  // ETS's UI, sometimes a device-firmware sentinel - is excluded from these
  // counts entirely, matching the server-side `match` verdict: an operator
  // can't act on it, so it shouldn't drive the "N differ" figure or the
  // Programmed/Modified status. The row stays in the table, just uncounted.
  const matchCount = paramDecoded.filter(
    (d) => d.match === true && d.isVisible !== false,
  ).length;
  const mismatchCount = paramDecoded.filter(
    (d) => d.match === false && d.isVisible !== false,
  ).length;
  // How many differing parameters the download never writes (server-side
  // `written`) - their bytes keep the segment's fill, so the difference is
  // an artefact, not device drift. Reported next to the mismatch count
  // rather than subtracted from it.
  // Column widths, now that two of the five columns are optional.
  const optionalCols = (showGroupCol ? 1 : 0) + (showLayoutCol ? 1 : 0);
  const nameColWidth = `${52 - optionalCols * 10}%`;
  const valueColWidth = `${19 - optionalCols * 3}%`;

  const unwrittenMismatchCount = paramDecoded.filter(
    (d) => d.match === false && d.written === false,
  ).length;
  const gaMatchCount = gaDecoded.filter((d) => d.match === true).length;
  const gaMismatchCount = gaDecoded.filter((d) => d.match === false).length;
  const obj3MatchCount = obj3Decoded.filter((d) => d.match === true).length;
  const obj3MismatchCount = obj3Decoded.filter((d) => d.match === false).length;
  // "communication object", not "flag" - each obj3Decoded row is ONE
  // object's whole flag set (C/R/W/T/U/RI + Priority + Size, compared as a
  // single string). "N flags differ" would undercount whenever two or more
  // of one object's flags differ at once (common - e.g. toggling
  // Communication also moves bit 2 the way toggling Read moves bit 3).
  const matchCountEntries = [
    { count: matchCount, word: 'param' },
    { count: gaMatchCount, word: 'GA' },
    { count: obj3MatchCount, word: 'Comm Object' },
  ];
  const mismatchCountEntries = [
    { count: mismatchCount, word: 'param' },
    { count: gaMismatchCount, word: 'GA' },
    { count: obj3MismatchCount, word: 'Comm Object' },
  ];
  // How many of those mismatches the current filters (search/only-named)
  // hide from the table below - makes that gap visible instead of leaving
  // "4 differ" looking wrong next to a 3-row table. Scoped to exclude
  // GA/Object-3 rows, matching `mismatchCount` above, or this could go
  // negative.
  const shownMismatchCount = filtered.filter(
    (d) =>
      d.match === false &&
      d.isVisible !== false &&
      !nonParamSections.has(d.section),
  ).length;
  const hiddenMismatchCount = mismatchCount - shownMismatchCount;

  const jumpTo = (name: string) => {
    // Expand first (closing whatever else was open - accordion) - jumping
    // to a still-collapsed section would otherwise scroll to what looks
    // like an empty header with nothing under it. Group Addresses/Object 3
    // are now their own top-level category with no inner section of their
    // own to also open - everything else is a real parameter section
    // nested inside the Parameters category.
    if (name === 'Group Addresses') {
      setExpandedCategory('ga');
    } else if (name === 'Group Object Table') {
      setExpandedCategory('obj3');
    } else {
      setExpandedCategory('parameters');
      setExpandedSection(name);
    }
    const el = bodyRef.current?.querySelector(
      `#${CSS.escape(sectionId(name))}`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSectionsOpen(false);
  };

  // Renders one table of rows - shared by every real ETS parameter section
  // AND by the Group Addresses/Group Object Table categories (which have no
  // further per-section nesting of their own). `flagsMode` is true only for
  // Group Object Table rows, whose Project/Device cells are a FlagChips
  // strip rather than a plain value, and whose byte-layout column is always
  // suppressed (an Object 3 row isn't a single byte-mapped parameter - see
  // FlagChips's own doc comment). Lifted out of the per-section render
  // loop so the Group Addresses/Object 3 categories can call it directly
  // without an inner section header duplicating the category header above
  // it.
  const renderRowsTable = (
    tableRows: VerifyDecodedParam[],
    flagsMode: boolean,
  ) => (
    <table className={styles.table}>
      <colgroup>
        <col style={{ width: nameColWidth }} />
        {showGroupCol && <col style={{ width: '22%' }} />}
        {showLayoutCol && <col style={{ width: '14%' }} />}
        <col style={{ width: valueColWidth }} />
        <col style={{ width: valueColWidth }} />
        <col style={{ width: '4%' }} />
      </colgroup>
      <thead>
        <tr>
          <th className={styles.th}>Parameter</th>
          {showGroupCol && <th className={styles.th}>Group (raw)</th>}
          {showLayoutCol && <th className={styles.th}>Byte</th>}
          <th className={styles.th}>Project</th>
          <th className={styles.th}>Device</th>
          <th className={styles.th} title="Match">
            ✓
          </th>
        </tr>
      </thead>
      <tbody>
        {tableRows.map((r) => (
          <tr
            key={r.key}
            className={r.match === false ? styles.rowDiffer : styles.row}
          >
            <td className={styles.td}>
              <span className={styles.tip} data-tip={r.key}>
                <span className={styles.tipText}>{r.label}</span>
              </span>
            </td>
            {showGroupCol && (
              <td className={`${styles.td} ${styles.groupCell}`}>
                <span className={styles.tip} data-tip={r.group || undefined}>
                  <span className={styles.tipText}>{r.group || '—'}</span>
                </span>
              </td>
            )}
            {showLayoutCol && (
              <td className={`${styles.td} ${styles.mono} ${styles.groupCell}`}>
                {flagsMode ? '—' : byteLayout(r)}
              </td>
            )}
            <td className={`${styles.td} ${styles.mono}`}>
              {flagsMode ? (
                <FlagChips flags={r.obj3Expected} other={r.obj3Actual} />
              ) : (
                <span className={styles.tip} data-tip={r.expectedValue}>
                  <span className={styles.tipText}>{r.expectedValue}</span>
                </span>
              )}
            </td>
            <td className={`${styles.td} ${styles.mono}`}>
              {flagsMode ? (
                <FlagChips flags={r.obj3Actual} other={r.obj3Expected} />
              ) : (
                <span
                  className={styles.tip}
                  data-tip={r.actualValue ?? undefined}
                >
                  <span className={styles.tipText}>{r.actualValue ?? '—'}</span>
                </span>
              )}
            </td>
            <td className={styles.td}>
              <MatchIcon match={r.match} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  // ETS itself nests a section's real parameters under their own declared
  // Group heading, not as one flat list - real feedback, with a screenshot
  // of ETS's own tabbed parameter view. `r.group` already carries that real
  // declared value (the same one the "Group (raw)" column showed as text) -
  // promoted here into actual sub-tables, one per distinct group, when a
  // section genuinely has more than one. A section with only one group (or
  // none) stays a single flat table exactly as before - splitting a section
  // that ETS itself never subdivides would invent structure that isn't
  // real. Shared by real parameter sections and by the Group
  // Addresses/Object 3 categories, though the latter two never actually
  // have more than one group in practice.
  const renderSectionBody = (
    rows: VerifyDecodedParam[],
    flagsMode: boolean,
  ) => {
    const byGroup = new Map<string, VerifyDecodedParam[]>();
    for (const r of rows) {
      const g = r.group || '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    const groupNames = Array.from(byGroup.keys());
    if (groupNames.length <= 1) return renderRowsTable(rows, flagsMode);
    return (
      <div className={styles.subTables}>
        {groupNames.map((g) => (
          <div key={g} className={styles.subTableBlock}>
            <div className={styles.subTableTitle}>
              {g || '(Ungrouped)'}
              <span className={styles.sectionCount}>
                {byGroup.get(g)!.length}
              </span>
            </div>
            {renderRowsTable(byGroup.get(g)!, flagsMode)}
          </div>
        ))}
      </div>
    );
  };

  // One real ETS parameter section (D01 - General, Enabled Functions, ...),
  // nested inside the outer Parameters category below - own header/accordion
  // (expandedSection), same chrome as before this category split, just no
  // longer a top-level sibling of Group Addresses/Object 3.
  const renderParamSection = (section: string, rows: VerifyDecodedParam[]) => {
    const hue = sectionHue(section);
    const isExpanded = expandedSection === section;
    const sectionMismatchCount = rows.filter(
      (r) => r.match === false && r.isVisible !== false,
    ).length;
    return (
      <div
        key={section}
        id={sectionId(section)}
        className={styles.sectionBlock}
        style={{ '--section-hue': hue } as React.CSSProperties}
      >
        <button
          type="button"
          className={`${styles.sectionTitle} ${styles.sectionTitleBtn}`}
          onClick={() => toggleSection(section)}
          aria-expanded={isExpanded}
        >
          <span className={styles.sectionCollapseIcon}>
            {isExpanded ? '▾' : '▸'}
          </span>
          {displaySectionName(section)}
          <span className={styles.sectionCount}>{rows.length}</span>
          {sectionMismatchCount > 0 && (
            <span className={styles.sectionMismatchCount}>
              {sectionMismatchCount} differ
            </span>
          )}
        </button>
        {isExpanded && renderSectionBody(rows, false)}
      </div>
    );
  };

  // Real ETS parameter sections, i.e. everything that isn't Group
  // Addresses/Group Object Table - these get nested inside one outer
  // "Parameters" category (below), instead of sitting as top-level
  // siblings sorted alphabetically alongside GA/Object 3.
  const paramSectionNames = sections.filter((s) => !nonParamSections.has(s));
  const gaRows = bySection.get('Group Addresses') ?? [];
  const obj3Rows = bySection.get('Group Object Table') ?? [];
  const paramRowsTotal = paramSectionNames.reduce(
    (n, s) => n + bySection.get(s)!.length,
    0,
  );
  const gaRowsMismatch = gaRows.filter((r) => r.match === false).length;
  const obj3RowsMismatch = obj3Rows.filter((r) => r.match === false).length;

  // Close the sections popover on outside click.
  useEffect(() => {
    if (!sectionsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!sectionsPopoverRef.current?.contains(e.target as Node)) {
        setSectionsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [sectionsOpen]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        {result && (
          <div className={styles.toolbarRow}>
            {showDeviceLabel && device && (
              <span className={styles.devLabel}>
                <DeviceTypeIcon type={device.device_type} />
                {device.individual_address} — {device.name}
              </span>
            )}
            {cacheEntry && (
              <span
                className={styles.cacheNote}
                title={
                  // A local edit recomputes the PROJECT/expected side
                  // against fresh DB state without a new bus read (see
                  // refreshVerifyCache, useProjectHandlers.ts) - the
                  // DEVICE/actual side is only as fresh as the last real
                  // read, so both timestamps are worth showing.
                  cacheEntry.recomputedAt
                    ? `Device last read ${new Date(cacheEntry.fetchedAt).toLocaleString()} · project recomputed ${new Date(cacheEntry.recomputedAt).toLocaleString()}`
                    : new Date(cacheEntry.fetchedAt).toLocaleString()
                }
              >
                {cacheEntry.recomputedAt
                  ? `recomputed ${timeAgo(cacheEntry.recomputedAt)} · device read ${timeAgo(cacheEntry.fetchedAt)}`
                  : `cached · read ${timeAgo(cacheEntry.fetchedAt)}`}
              </span>
            )}

            {decoded && decoded.length > 0 && sections.length > 1 && (
              <div className={styles.sectionsNav} ref={sectionsPopoverRef}>
                <Btn
                  onClick={() => setSectionsOpen((o) => !o)}
                  color="var(--muted)"
                  bg="var(--surface)"
                >
                  Sections ({sections.length}) {sectionsOpen ? '▴' : '▾'}
                </Btn>
                {sectionsOpen && (
                  <div className={styles.sectionsPopover}>
                    {sections.map((s) => {
                      const hue = sectionHue(s);
                      return (
                        <button
                          key={s}
                          onClick={() => jumpTo(s)}
                          className={styles.jumpChip}
                          style={{ '--chip-hue': hue } as React.CSSProperties}
                        >
                          {displaySectionName(s)}
                          <span className={styles.jumpChipCount}>
                            {bySection.get(s)!.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className={styles.summaryBadges}>
              {/* Two scopes shown side by side read as contradictory without
                  a label (e.g. "5201 match / 2 differ" as parameters next
                  to "8448/10433 bytes match" as raw memory) - each cluster's
                  tooltip spells out the difference. Named parameters shown
                  first: that's the scope under project control, where a
                  mismatch means something real. Raw memory legitimately
                  includes padding/gap bytes ETS never writes to (see the
                  relmem write-scope documentation), so it's structurally
                  noisy and muted to --dim rather than amber/green. */}
              {/* Params and GA links share one page with no filter
                  distinction - `filtered`'s scope-blind `d.match` check
                  already shows both together, so they're composed into one
                  badge group via `composeCount` rather than kept as
                  redundant separate groups. `hiddenMismatchCount` (unnamed
                  params hidden by "Only named parameters") stays
                  params-only, since that filter never hides GA rows. */}
              {decoded && (
                <div className={styles.summaryGroup}>
                  {(matchCount > 0 ||
                    gaMatchCount > 0 ||
                    obj3MatchCount > 0) && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'match' ? styles.filterChipBtnActive : ''}`}
                      style={
                        { '--chip-ring': 'var(--green)' } as React.CSSProperties
                      }
                      onClick={() =>
                        setRowFilter(rowFilter === 'match' ? 'all' : 'match')
                      }
                      title={
                        (rowFilter === 'match'
                          ? 'Showing only matching rows — click to show all. '
                          : 'Show only matching rows. ') +
                        'Named, project-configurable parameters' +
                        (gaDecoded.length ? ', group-address links' : '') +
                        (obj3Decoded.length
                          ? ", and communication objects' flags"
                          : '') +
                        ' only. Underneath, at the raw byte level, ' +
                        `${result.totalBytes - result.totalDiffering}/${result.totalBytes} ` +
                        `bytes of the parameter memory segment match ` +
                        `(a separate, larger scope - includes unmapped/padding bytes ETS ` +
                        `itself rarely writes to, so a mismatch there alone usually isn't ` +
                        `meaningful the way a named-row mismatch above is).`
                      }
                    >
                      <Badge
                        label={
                          mismatchCount === 0 &&
                          gaMismatchCount === 0 &&
                          obj3MismatchCount === 0
                            ? `All ${composeCount(matchCountEntries)} matched`
                            : `${composeCount(matchCountEntries)} match`
                        }
                        color="var(--green)"
                      />
                    </button>
                  )}
                  {(mismatchCount > 0 ||
                    gaMismatchCount > 0 ||
                    obj3MismatchCount > 0) && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'differ' ? styles.filterChipBtnActive : ''}`}
                      style={
                        { '--chip-ring': 'var(--red)' } as React.CSSProperties
                      }
                      onClick={() => {
                        const next = rowFilter === 'differ' ? 'all' : 'differ';
                        setRowFilter(next);
                        if (next === 'differ' && hiddenMismatchCount > 0)
                          setOnlyNamed(false);
                      }}
                      title={
                        (rowFilter === 'differ'
                          ? 'Showing only differing rows — click to show all. '
                          : hiddenMismatchCount > 0
                            ? `Show only differing rows (including ${hiddenMismatchCount} unnamed param${hiddenMismatchCount === 1 ? '' : 's'} normally hidden by "Only named parameters"). `
                            : 'Show only differing rows. ') +
                        `Underneath, at the raw byte level, ` +
                        `${result.totalBytes - result.totalDiffering}/${result.totalBytes} ` +
                        `bytes of the parameter memory segment match (a separate, larger ` +
                        `scope - includes unmapped/padding bytes ETS itself rarely writes ` +
                        `to, so a mismatch there alone usually isn't meaningful the way a ` +
                        `named-row mismatch above is).`
                      }
                    >
                      <Badge
                        label={
                          `${composeCount(mismatchCountEntries)} differ` +
                          (hiddenMismatchCount > 0
                            ? ` (${hiddenMismatchCount} hidden)`
                            : '')
                        }
                        color="var(--red)"
                      />
                    </button>
                  )}
                  {/* Diagnostic: how much of the mismatch is parameters the
                      download never writes, whose expected side is a decode
                      of the segment's fill. Shown beside the differ count
                      rather than subtracted from it. See
                      VerifyDecodedParam.written. */}
                  {unwrittenMismatchCount > 0 && (
                    <span
                      className={styles.cacheNote}
                      title={
                        `${unwrittenMismatchCount} of the differing parameters are ones this ` +
                        `download never writes: the app declares them, but they are an ` +
                        `inactive alternative for their channel or have no value and no ` +
                        `default, so their bytes keep the segment's fill. The comparison ` +
                        `still decodes them on both sides, so "expected" there is a decode ` +
                        `of filler and the difference is an artefact rather than device drift.`
                      }
                    >
                      {unwrittenMismatchCount} never written
                    </span>
                  )}
                  {/* Always-present "All" chip so matched and differing rows
                      can be viewed together without a click-to-toggle dance
                      - re-clicking the active colored badge isn't
                      discoverable as "show everything". Deliberately
                      doesn't touch `onlyNamed`, a separate filter axis. */}
                  {decoded.length > 0 && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'all' ? styles.filterChipBtnActive : ''}`}
                      style={
                        { '--chip-ring': 'var(--dim)' } as React.CSSProperties
                      }
                      onClick={() => setRowFilter('all')}
                      title={
                        (rowFilter === 'all'
                          ? 'Showing every row — matched and differing together. '
                          : 'Show every row — matched and differing together, in one view. ') +
                        '(Doesn\'t change the "Only named parameters" filter below - ' +
                        "that's a separate axis.)"
                      }
                    >
                      <Badge label="All" color="var(--dim)" />
                    </button>
                  )}
                </div>
              )}
              {/* Standalone "X/Y bytes match" raw-memory badge, shown only
                  when there's no decoded breakdown to fold it into (a
                  device/app with no named parameters, e.g. props-only) -
                  otherwise the number lives in the match/differ badges'
                  tooltips instead. */}
              {(!decoded || decoded.length === 0) && (
                <div className={styles.summaryGroup}>
                  <Badge
                    label={`${result.totalBytes - result.totalDiffering}/${result.totalBytes} bytes match`}
                    color="var(--dim)"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {result && decoded && decoded.length > 0 && (
          <div className={styles.toolbarRow}>
            <div className={styles.filterBar}>
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder="Filter parameters…"
              />
              <label className={styles.checkToggle}>
                <input
                  type="checkbox"
                  checked={onlyNamed}
                  onChange={(e) => setOnlyNamed(e.target.checked)}
                />
                Only named parameters
              </label>
              <label
                className={styles.checkToggle}
                title={
                  'Raw per-instance label from the product database (e.g. "Dimming channel 2 ({{0:...}})"). ' +
                  'The {{0:...}} is a template placeholder real ETS substitutes at render time - koolenex ' +
                  "doesn't resolve it yet, so it's shown exactly as parsed."
                }
              >
                <input
                  type="checkbox"
                  checked={showGroupCol}
                  onChange={(e) => setShowGroupCol(e.target.checked)}
                />
                Show group column ⓘ
              </label>
              <label
                className={styles.checkToggle}
                title={
                  'Byte offset, bit offset and bit width each parameter is decoded from, ' +
                  'and whether the download actually writes it. A parameter the app declares ' +
                  'but the download skips - an inactive alternative for its channel, or one ' +
                  'with no value and no default - keeps the segment fill, so its "Project" ' +
                  'value is a decode of filler and any difference from the device is an artefact.'
                }
              >
                <input
                  type="checkbox"
                  checked={showLayoutCol}
                  onChange={(e) => setShowLayoutCol(e.target.checked)}
                />
                Show byte layout ⓘ
              </label>
            </div>
          </div>
        )}
      </div>

      <div className={styles.body} ref={bodyRef}>
        {!result && !loading && (
          <Empty
            icon="⇄"
            msg="No verify result for this device yet — run Verify to read it over the bus."
          />
        )}

        {loading && liveProgress && (
          <div className={styles.loadingBanner}>
            <div className={styles.progressRow}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${liveProgress.pct}%` }}
                />
              </div>
              <span className={styles.progressPct}>{liveProgress.pct}%</span>
            </div>
            <span className={styles.loadingText}>
              Reading device memory over the bus — {liveProgress.bytesRead}/
              {liveProgress.totalBytes} bytes
            </span>
          </div>
        )}

        {result && decoded && decoded.length > 0 && (
          <>
            {filtered.length === 0 ? (
              <Empty msg="No parameters match the current filter." />
            ) : (
              <>
                {/* Parameters - every real ETS section nested inside one
                    outer category, instead of sitting as top-level siblings
                    sorted alphabetically alongside Group Addresses/Object 3.
                    Own accordion axis (expandedCategory) from the individual
                    sections nested inside it (expandedSection) - opening the
                    category doesn't pick which section is open, and
                    switching sections doesn't collapse the category itself. */}
                {paramSectionNames.length > 0 && (
                  <div
                    className={styles.categoryBlock}
                    style={
                      {
                        '--section-hue': NEUTRAL_SECTION_HUE,
                      } as React.CSSProperties
                    }
                  >
                    <button
                      type="button"
                      className={`${styles.categoryTitle} ${styles.categoryTitleBtn}`}
                      onClick={() => toggleCategory('parameters')}
                      aria-expanded={expandedCategory === 'parameters'}
                    >
                      <span className={styles.sectionCollapseIcon}>
                        {expandedCategory === 'parameters' ? '▾' : '▸'}
                      </span>
                      Parameters
                      <span className={styles.sectionCount}>
                        {paramRowsTotal}
                      </span>
                      {shownMismatchCount > 0 && (
                        <span className={styles.sectionMismatchCount}>
                          {shownMismatchCount} differ
                        </span>
                      )}
                    </button>
                    {expandedCategory === 'parameters' && (
                      <div className={styles.categoryBody}>
                        {paramSectionNames.map((section) =>
                          renderParamSection(section, bySection.get(section)!),
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* Group Addresses - its own category, own fixed hue (see
                    sectionHue's own doc comment for why this and Object 3
                    keep a distinct, non-neutral colour). No further section
                    nesting of its own (a device only ever has one "Group
                    Addresses" section), so the category header IS the
                    section header - renderSectionBody is called directly,
                    with no renderParamSection wrapper duplicating it. */}
                {gaRows.length > 0 && (
                  <div
                    id={sectionId('Group Addresses')}
                    className={`${styles.categoryBlock} ${styles.sectionBlockGA}`}
                    style={
                      {
                        '--section-hue': sectionHue('Group Addresses'),
                      } as React.CSSProperties
                    }
                  >
                    <button
                      type="button"
                      className={`${styles.categoryTitle} ${styles.categoryTitleBtn} ${styles.sectionTitleGA}`}
                      onClick={() => toggleCategory('ga')}
                      aria-expanded={expandedCategory === 'ga'}
                    >
                      <span className={styles.sectionCollapseIcon}>
                        {expandedCategory === 'ga' ? '▾' : '▸'}
                      </span>
                      {displaySectionName('Group Addresses')}
                      <span className={styles.sectionCount}>
                        {gaRows.length}
                      </span>
                      {gaRowsMismatch > 0 && (
                        <span className={styles.sectionMismatchCount}>
                          {gaRowsMismatch} differ
                        </span>
                      )}
                    </button>
                    {expandedCategory === 'ga' && (
                      <div className={styles.categoryBody}>
                        {renderSectionBody(gaRows, false)}
                      </div>
                    )}
                  </div>
                )}
                {/* Communication Flags (server-side 'Group Object Table') -
                    same treatment as Group Addresses above, its own fixed
                    hue, flagsMode=true so its rows render as FlagChips. */}
                {obj3Rows.length > 0 && (
                  <div
                    id={sectionId('Group Object Table')}
                    className={`${styles.categoryBlock} ${styles.sectionBlockGA}`}
                    style={
                      {
                        '--section-hue': sectionHue('Group Object Table'),
                      } as React.CSSProperties
                    }
                  >
                    <button
                      type="button"
                      className={`${styles.categoryTitle} ${styles.categoryTitleBtn} ${styles.sectionTitleGA}`}
                      onClick={() => toggleCategory('obj3')}
                      aria-expanded={expandedCategory === 'obj3'}
                    >
                      <span className={styles.sectionCollapseIcon}>
                        {expandedCategory === 'obj3' ? '▾' : '▸'}
                      </span>
                      {displaySectionName('Group Object Table')}
                      <span className={styles.sectionCount}>
                        {obj3Rows.length}
                      </span>
                      {obj3RowsMismatch > 0 && (
                        <span className={styles.sectionMismatchCount}>
                          {obj3RowsMismatch} differ
                        </span>
                      )}
                    </button>
                    {expandedCategory === 'obj3' && (
                      <div className={styles.categoryBody}>
                        {renderSectionBody(obj3Rows, true)}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {result && !decoded && result.props && result.props.length > 0 && (
          <div
            className={styles.sectionBlock}
            style={{ '--section-hue': 210 } as React.CSSProperties}
          >
            <button
              type="button"
              className={`${styles.sectionTitle} ${styles.sectionTitleBtn}`}
              onClick={() => toggleSection('Properties')}
              aria-expanded={expandedSection === 'Properties'}
            >
              <span className={styles.sectionCollapseIcon}>
                {expandedSection === 'Properties' ? '▾' : '▸'}
              </span>
              Properties ({result.family} — no decodable parameter memory for
              this device family)
              {result.props.filter((p) => !p.match).length > 0 && (
                <span className={styles.sectionMismatchCount}>
                  {result.props.filter((p) => !p.match).length} differ
                </span>
              )}
            </button>
            {expandedSection === 'Properties' && (
              <table className={styles.table}>
                <colgroup>
                  <col style={{ width: '52%' }} />
                  <col style={{ width: '19%' }} />
                  <col style={{ width: '19%' }} />
                  <col style={{ width: '4%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className={styles.th}>Property</th>
                    <th className={styles.th}>Project (hex)</th>
                    <th className={styles.th}>Device (hex)</th>
                    <th className={styles.th}>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {result.props.map((p, i) => (
                    <tr
                      key={i}
                      className={!p.match ? styles.rowDiffer : styles.row}
                    >
                      <td className={styles.td}>
                        obj={p.obj} pid={p.pid}
                      </td>
                      <td className={`${styles.td} ${styles.mono}`}>
                        <span className={styles.tip} data-tip={p.expectedHex}>
                          <span className={styles.tipText}>
                            {p.expectedHex}
                          </span>
                        </span>
                      </td>
                      <td className={`${styles.td} ${styles.mono}`}>
                        <span className={styles.tip} data-tip={p.actualHex}>
                          <span className={styles.tipText}>{p.actualHex}</span>
                        </span>
                      </td>
                      <td className={styles.td}>
                        <MatchIcon match={p.match} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {result && !decoded && (!result.props || result.props.length === 0) && (
          <Empty msg="No decodable parameters or properties were returned for this device." />
        )}
      </div>
    </div>
  );
}
