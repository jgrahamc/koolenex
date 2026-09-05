import { useState, useMemo, useRef, useEffect } from 'react';
import { Btn, Badge, SearchBox, Empty } from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import type { VerifyDecodedParam, GroupObjectEntryFlags } from '../api.ts';
import { useVerifyCache } from '../contexts.ts';
import styles from './DeviceComparisonView.module.css';

/** Deterministic hue (0-359) from a section name, for the per-section tint. */
function hueForSection(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function sectionId(name: string): string {
  return 'sec-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** User-facing rename for section names that are correct KNX terminology but
 * meaningless to someone who isn't a KNX protocol engineer. The server's own
 * `section` string ('Group Object Table', KNX standard object/type name -
 * see docs/knx-device-write-protocol.md Part 10, koolenex repo) stays
 * unchanged everywhere it's used as a comparison key (filtering, tests,
 * server responses) - this ONLY renames what's actually painted on screen
 * (section headers, the sections-jump popover, log lines), so nothing
 * upstream needs to know about the friendlier name. Exported so
 * ProgrammingView's log lines can reuse the same mapping instead of printing
 * the raw KNX term there too. */
export function displaySectionName(section: string): string {
  if (section === 'Group Object Table') return 'Communication Flags';
  return section;
}

/** Compose a "5 params / 2 GAs / 1 Object 3" style count string from any
 * number of scoped counts, omitting whichever entries are zero (e.g. a
 * device with no GA rows, or one where every GA matches while a param
 * differs, only mentions the entries that are actually nonzero) rather than
 * always spelling out every category. Used for the combined match/differ
 * summary badges - see the comment at their call site in
 * DeviceCompareResults. Generalized 2026-08-29 from a fixed params/GAs pair
 * to an arbitrary list, to fold in Object 3's own separately-tracked count
 * alongside GA's without hardcoding a third fixed parameter. */
function composeCount(entries: Array<{ count: number; word: string }>): string {
  return entries
    .filter((e) => e.count > 0)
    .map((e) => `${e.count} ${e.word}${e.count === 1 ? '' : 's'}`)
    .join(' / ');
}

/** Compact match/differ glyph for the per-row MATCH column - a text Badge
 * ("MATCH"/"DIFFERS") has a fixed minimum width from its own padding, which
 * overflowed its cell once the MATCH column's percentage width shrank below
 * that on a narrow panel. A small fixed-size icon has no such floor. */
function MatchIcon({ match }: { match: boolean | null }) {
  if (match === true)
    return (
      <span className={styles.matchIcon} style={{ color: 'var(--green)' }} title="Match">
        ✓
      </span>
    );
  if (match === false)
    return (
      <span className={styles.matchIcon} style={{ color: 'var(--red)' }} title="Differs">
        ✕
      </span>
    );
  return (
    <span className={styles.matchIcon} style={{ color: 'var(--dim)' }} title="Not applicable">
      –
    </span>
  );
}

// Object 3's boolean flags, in real ETS's own parameter-UI checkbox order
// (Communication, Read, Write, Transmit, Update, Read On Init) - NOT the
// underlying bit order (Update/Transmit/ReadOnInit/Write/Read/Comm, per
// computeGroupObjectByte()) - display order is chosen for familiarity to
// anyone who's used real ETS, independent of wire layout. `commLinked` is
// bit 2 (Communication AND has-a-real-GA-link, combined - see
// GroupObjectEntryFlags's own doc comment) but labeled plain "C" here,
// matching ETS's own "Communication" checkbox the byte can't fully
// distinguish from.
const FLAG_CHIP_ORDER: Array<{ key: keyof GroupObjectEntryFlags; letter: string; label: string }> = [
  { key: 'commLinked', letter: 'C', label: 'Communication (+ has a real GA link)' },
  { key: 'read', letter: 'R', label: 'Read' },
  { key: 'write', letter: 'W', label: 'Write' },
  { key: 'transmit', letter: 'T', label: 'Transmit' },
  { key: 'update', letter: 'U', label: 'Update' },
  { key: 'readOnInit', letter: 'RI', label: 'Read On Init' },
];

/** Object 3's compact per-flag display: one small letter chip per boolean flag (green = set,
 * muted = clear), Priority/Size as plain text alongside. Each chip carries its OWN short tooltip
 * (just that one flag's name, via the app's standard `.tip`/`data-tip` mechanism - the same one
 * used everywhere else, not the native `title` attribute) rather than one composite tooltip for
 * the whole row: an earlier version wrapped the whole chip row in a single row-wide tooltip
 * showing the full describeGroupObjectEntry() sentence, but anchored at the row's left edge that
 * pushed a wide (up to 380px) box off the right side of the screen for columns near the viewport
 * edge - per-chip tooltips are short enough to never need that width, and land next to the
 * specific letter being hovered. `other` (the opposite project/device side) is used only to ring
 * a chip red when the two sides genuinely disagree on that one specific flag - purely visual,
 * doesn't affect the row's own overall match icon. */
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
  const [rowFilter, setRowFilter] = useState<'all' | 'differ' | 'match'>(
    'all',
  );
  const [onlyNamed, setOnlyNamed] = useState(true);
  const [showGroupCol, setShowGroupCol] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionsPopoverRef = useRef<HTMLDivElement | null>(null);

  const cacheEntry = device ? cache[device.id] : undefined;
  const result = cacheEntry?.result ?? null;
  const liveProgress = device ? progress[device.individual_address] : undefined;
  const loading = !!liveProgress && !cacheEntry;

  const decoded = result?.decoded ?? null;

  // Smart default: when a fresh result comes in (new device selected, or a
  // re-verify completes) with any differing parameter, default to showing
  // ALL differences including unnamed ones - that's almost certainly what
  // you want to see first. With no differences, default to the "match"
  // filter instead of "all" - functionally the same set of rows (nothing
  // differs), but it also puts the active-filter ring on the named-
  // parameters "All N matched" chip instead of the (deliberately muted)
  // raw-memory chip, which otherwise looked like the "selected"/important
  // one by accident of this default. Only applies once per distinct result
  // (tracked by device+fetchedAt) so it never fights a filter toggle you
  // made by hand.
  const appliedDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!decoded || !device) return;
    const key = `${device.id}:${cacheEntry?.fetchedAt ?? ''}`;
    if (appliedDefaultKeyRef.current === key) return;
    appliedDefaultKeyRef.current = key;
    const hasMismatch = decoded.some((d) => d.match === false);
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

  // GA link rows (server-side section: 'Group Addresses' - see
  // docs/knx-device-write-protocol.md Part 7 in the koolenex repo) and
  // Object 3 rows (server-side section: 'Group Object Table' - flags/
  // priority/size, Part 19, added 2026-08-29) are folded into the same
  // `decoded` array as named parameters, but they're both a different kind
  // of thing (not a byte-mapped parameter value) - the top summary badges
  // below scope "params matched"/"differ" to exclude both and show their
  // own separate counts, so the wording stays accurate and a mismatch in
  // either can't hide silently inside a "params matched" number that
  // doesn't actually mention them at all.
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
  const matchCount = paramDecoded.filter((d) => d.match === true).length;
  const mismatchCount = paramDecoded.filter((d) => d.match === false).length;
  const gaMatchCount = gaDecoded.filter((d) => d.match === true).length;
  const gaMismatchCount = gaDecoded.filter((d) => d.match === false).length;
  const obj3MatchCount = obj3Decoded.filter((d) => d.match === true).length;
  const obj3MismatchCount = obj3Decoded.filter((d) => d.match === false).length;
  // "communication object", not "flag" - each obj3Decoded row is ONE
  // communication object's WHOLE flag set (all of C/R/W/T/U/RI + Priority +
  // Size, compared together as a single string - see the `match` assignment
  // server-side, routes/bus.ts's obj3Rows), not a single flag. "N flags
  // differ" would UNDERCOUNT whenever two or more of one object's flags
  // differ at once (a real, common case - e.g. toggling Communication also
  // moves bit 2 the way toggling Read moves bit 3, so a single real edit can
  // already touch more than one flag), so the row-level word needs to name
  // what's actually being counted (objects), not the finer-grained thing
  // inside each row that isn't separately counted here.
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
  // How many of those mismatches the current filters (search / only-named)
  // are hiding from the table below - the summary badges below count every
  // decoded parameter, not just the filtered/visible ones, so this makes
  // that gap visible instead of leaving "4 differ" looking wrong next to a
  // 3-row table. Scoped to exclude GA/Object-3 rows, matching
  // `mismatchCount` above - otherwise a visible differing GA/Object-3 row
  // would count here but not in the base it's being subtracted from, going
  // negative.
  const shownMismatchCount = filtered.filter(
    (d) => d.match === false && !nonParamSections.has(d.section),
  ).length;
  const hiddenMismatchCount = mismatchCount - shownMismatchCount;

  const jumpTo = (name: string) => {
    const el = bodyRef.current?.querySelector(
      `#${CSS.escape(sectionId(name))}`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSectionsOpen(false);
  };

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
                  // Honest about what actually happened, 2026-08-31: a
                  // local edit now recomputes the PROJECT/expected side
                  // against fresh DB state without a new bus read (see
                  // refreshVerifyCache, useProjectHandlers.ts) - the
                  // DEVICE/actual side shown is still only as fresh as the
                  // last real read, so both timestamps are worth showing,
                  // not just whichever is more recent.
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
                      const hue = hueForSection(s);
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
              {/* Two different scopes shown side by side, which reads as
                  contradictory without knowing the difference (e.g. "5201
                  match / 2 differ" as parameters next to "8448/10433 bytes
                  match" as raw memory) - a visible "(raw memory)" /
                  "(named parameters)" label on each cluster, plus a fuller
                  tooltip, so that's clear without already knowing it.

                  Named parameters first, raw memory second (was the other
                  way round): named parameters are the scope actually under
                  project control, where a mismatch means something real -
                  raw memory legitimately includes padding/gap bytes ETS
                  itself never writes to (see the 2026-08-27 relmem
                  write-scope investigation), so its mismatch count is
                  structurally noisy and shouldn't be the first, most
                  prominent thing shown. The raw-memory chip's color is
                  muted to --dim for the same reason - amber/green there
                  reads as "this matters" when usually it doesn't. */}
              {/* Params and GA links share one page with no real filter
                  distinction between them - clicking "match"/"differ" already
                  shows both kinds together via `filtered`'s scope-blind
                  `d.match` check, so keeping them as two separate badge
                  groups was pure redundancy once both report the same thing
                  (all matched, or one has nothing to report). One combined
                  group instead, composing whichever of params/GAs actually
                  has a nonzero count into each label via `composeCount` -
                  covers "all clean", "only params differ", "only GAs
                  differ", and "both differ" without a separate branch per
                  case. `hiddenMismatchCount` (unnamed params hidden by "Only
                  named parameters") stays params-only in its own callout,
                  since that filter never hides GA rows (their label is
                  always the com object's name, never equal to their key). */}
              {decoded && (
                <div className={styles.summaryGroup}>
                  {(matchCount > 0 || gaMatchCount > 0 || obj3MatchCount > 0) && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'match' ? styles.filterChipBtnActive : ''}`}
                      style={{ '--chip-ring': 'var(--green)' } as React.CSSProperties}
                      onClick={() =>
                        setRowFilter(rowFilter === 'match' ? 'all' : 'match')
                      }
                      title={
                        (rowFilter === 'match'
                          ? 'Showing only matching rows — click to show all. '
                          : 'Show only matching rows. ') +
                        'Named, project-configurable parameters' +
                        (gaDecoded.length ? ', group-address links' : '') +
                        (obj3Decoded.length ? ', and communication objects\' flags' : '') +
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
                  {(mismatchCount > 0 || gaMismatchCount > 0 || obj3MismatchCount > 0) && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'differ' ? styles.filterChipBtnActive : ''}`}
                      style={{ '--chip-ring': 'var(--red)' } as React.CSSProperties}
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
                          (hiddenMismatchCount > 0 ? ` (${hiddenMismatchCount} hidden)` : '')
                        }
                        color="var(--red)"
                      />
                    </button>
                  )}
                  {/* The group label span (e.g. "named parameters / GAs")
                      that used to sit here was removed 2026-08-29 per
                      explicit request - redundant once the match badge
                      itself already says "All N matched", and updating its
                      text to also account for Object 3 wasn't worth
                      keeping. The disambiguating explanation still lives in
                      each badge's own `title` tooltip above. */}
                  {/* A third, always-present "All" chip (added 2026-08-29,
                      explicit request) so both matched and differing rows can
                      be viewed together without a click-to-toggle dance -
                      previously the ONLY way back to the unfiltered view was
                      re-clicking whichever colored badge was already active,
                      which isn't discoverable as a "show everything" action
                      in its own right. Deliberately doesn't touch `onlyNamed`
                      - that's a separate filter axis (named vs. unnamed rows,
                      not match vs. differ - see the discussion above this
                      component) and this chip's whole point is to combine
                      match state only, not every filter on the page. */}
                  {decoded.length > 0 && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'all' ? styles.filterChipBtnActive : ''}`}
                      style={{ '--chip-ring': 'var(--dim)' } as React.CSSProperties}
                      onClick={() => setRowFilter('all')}
                      title={
                        (rowFilter === 'all'
                          ? 'Showing every row — matched and differing together. '
                          : 'Show every row — matched and differing together, in one view. ') +
                        '(Doesn\'t change the "Only named parameters" filter below - ' +
                        'that\'s a separate axis.)'
                      }
                    >
                      <Badge label="All" color="var(--dim)" />
                    </button>
                  )}
                </div>
              )}
              {/* The standalone "X/Y bytes match" raw-memory badge that used
                  to sit here was removed 2026-08-29 per explicit request -
                  once decoded rows exist, it was telling the same story as
                  the params/GA/flags badges above (just a larger, noisier
                  scope), so it read as a second, contradictory-sounding
                  source of truth rather than new information. Its number and
                  explanation now live in the match/differ badges' own
                  tooltips instead. Only shown as its own badge when there's
                  no decoded breakdown to fold it into at all (a device/app
                  with no named parameters, e.g. props-only). */}
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
              Array.from(bySection.entries()).map(([section, rows]) => {
                // Group Addresses / Group Object Table both get a fixed hue
                // (not the usual name-hash) plus the distinct
                // .sectionBlockGA/.sectionTitleGA treatment (stronger
                // border/background, same reusable hue-parameterized CSS,
                // just a different --section-hue per kind) - a hash-derived
                // tint alone wouldn't reliably read as "different kind of
                // thing" from a params section, since two hashed hues can
                // land close together by chance. Both are a different
                // domain from a byte-mapped named parameter - GA rows are a
                // communication object's linked address, Object 3 rows are
                // its real device-side flags/priority/size (added
                // 2026-08-29, see docs/knx-device-write-protocol.md Part 19
                // in the koolenex repo) - so both should always look
                // deliberately distinct, not just "differently colored
                // today". Different hues from each other too (205 vs 280)
                // so the two "special" section kinds don't look identical.
                const isGA = section === 'Group Addresses';
                const isObj3 = section === 'Group Object Table';
                const hue = isGA ? 205 : isObj3 ? 280 : hueForSection(section);
                return (
                  <div
                    key={section}
                    id={sectionId(section)}
                    className={`${styles.sectionBlock} ${isGA || isObj3 ? styles.sectionBlockGA : ''}`}
                    style={{ '--section-hue': hue } as React.CSSProperties}
                  >
                    <div
                      className={`${styles.sectionTitle} ${isGA || isObj3 ? styles.sectionTitleGA : ''}`}
                    >
                      {displaySectionName(section)}
                      <span className={styles.sectionCount}>{rows.length}</span>
                    </div>
                    <table className={styles.table}>
                      <colgroup>
                        <col style={{ width: showGroupCol ? '42%' : '52%' }} />
                        {showGroupCol && <col style={{ width: '22%' }} />}
                        <col style={{ width: showGroupCol ? '16%' : '19%' }} />
                        <col style={{ width: showGroupCol ? '16%' : '19%' }} />
                        <col style={{ width: '4%' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th className={styles.th}>Parameter</th>
                          {showGroupCol && (
                            <th className={styles.th}>Group (raw)</th>
                          )}
                          <th className={styles.th}>Project</th>
                          <th className={styles.th}>Device</th>
                          <th className={styles.th} title="Match">
                            ✓
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr
                            key={r.key}
                            className={
                              r.match === false ? styles.rowDiffer : styles.row
                            }
                          >
                            <td className={styles.td}>
                              <span className={styles.tip} data-tip={r.key}>
                                <span className={styles.tipText}>
                                  {r.label}
                                </span>
                              </span>
                            </td>
                            {showGroupCol && (
                              <td
                                className={`${styles.td} ${styles.groupCell}`}
                              >
                                <span
                                  className={styles.tip}
                                  data-tip={r.group || undefined}
                                >
                                  <span className={styles.tipText}>
                                    {r.group || '—'}
                                  </span>
                                </span>
                              </td>
                            )}
                            <td className={`${styles.td} ${styles.mono}`}>
                              {isObj3 ? (
                                <FlagChips
                                  flags={r.obj3Expected}
                                  other={r.obj3Actual}
                                />
                              ) : (
                                <span
                                  className={styles.tip}
                                  data-tip={r.expectedValue}
                                >
                                  <span className={styles.tipText}>
                                    {r.expectedValue}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td className={`${styles.td} ${styles.mono}`}>
                              {isObj3 ? (
                                <FlagChips
                                  flags={r.obj3Actual}
                                  other={r.obj3Expected}
                                />
                              ) : (
                                <span
                                  className={styles.tip}
                                  data-tip={r.actualValue ?? undefined}
                                >
                                  <span className={styles.tipText}>
                                    {r.actualValue ?? '—'}
                                  </span>
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
                  </div>
                );
              })
            )}
          </>
        )}

        {result && !decoded && result.props && result.props.length > 0 && (
          <div
            className={styles.sectionBlock}
            style={{ '--section-hue': 210 } as React.CSSProperties}
          >
            <div className={styles.sectionTitle}>
              Properties ({result.family} — no decodable parameter memory for
              this device family)
            </div>
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
                        <span className={styles.tipText}>{p.expectedHex}</span>
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
          </div>
        )}

        {result && !decoded && (!result.props || result.props.length === 0) && (
          <Empty msg="No decodable parameters or properties were returned for this device." />
        )}
      </div>
    </div>
  );
}
