import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Device } from '../../../shared/types.ts';
import { api, errMessage } from '../api.ts';
import { buildParamUI } from '../detail/paramUI.ts';
import type { ParamUIModel, ParamUIParam } from '../detail/paramUI.ts';
import { Btn } from '../primitives.tsx';
import styles from './DeviceStatusPopover.module.css';

// Above this many pending changes, listing each one gets noisy rather than
// useful - a count plus a pointer to the real editing pages (which already
// show current values, just not "what changed") reads better than a long
// scrolling list inside a small popover.
const MAX_INLINE_CHANGES = 5;

type PendingChange = {
  kind: string;
  key: string;
  updatedAt: string;
  label: string | null;
  from?: unknown;
  to?: unknown;
  flagDiffs?: Array<{ field: string; from: string; to: string }>;
};

interface Props {
  device: Device;
  projectId: number | null;
  onClose: () => void;
  onRestart: () => void;
  onClearHistory: () => void;
  restarting: boolean;
  clearingHistory: boolean;
}

/** Badge-click popover for the Programming page's status column - shows
 *  what a Programmed/Modified badge actually means and puts the
 *  Restart/Reset-download-status actions here instead of as permanent
 *  inline icon buttons next to the badge (real feedback: they "didn't look
 *  very nice" sitting on top of it). One popover, three real states
 *  (programmed / restart-withheld / modified) - Unassigned/Deleted/Error
 *  have nothing to show here, so the badge stays a plain non-interactive
 *  span for those (see the caller's own onClick gating). */
export function DeviceStatusPopover({
  device,
  projectId,
  onClose,
  onRestart,
  onClearHistory,
  restarting,
  clearingHistory,
}: Props) {
  const isModified = device.status === 'modified';
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const [changes, setChanges] = useState<PendingChange[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [paramLabels, setParamLabels] = useState<Record<
    string,
    { label: string; from: string; to: string }
  > | null>(null);

  useEffect(() => {
    if (!isModified || !projectId) return;
    let cancelled = false;
    api
      .getDevicePendingChanges(projectId, device.id)
      .then((res) => {
        if (cancelled) return;
        setChangeCount(res.count);
        // Only keep the actual rows around (and only try to resolve
        // parameter labels below) when we're within the inline-display
        // cap - no point fetching/building the param-UI tree just to
        // throw the result away behind a "N changes pending" summary.
        setChanges(
          res.count > 0 && res.count <= MAX_INLINE_CHANGES ? res.changes : null,
        );
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(errMessage(e) || 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [isModified, projectId, device.id]);

  // param_value's `key` only means something once matched against this
  // device's own param model (see the API's own doc comment) - fetched
  // lazily, only when there's actually at least one such change to show.
  useEffect(() => {
    if (!changes || !projectId) return;
    const paramChanges = changes.filter((c) => c.kind === 'param_value');
    if (!paramChanges.length) return;
    let cancelled = false;
    api
      .getParamModel(projectId, device.id)
      .then((model) => {
        if (cancelled) return;
        const ui = buildParamUI(model as unknown as ParamUIModel, {});
        const items = Object.values(ui.secMap)
          .flat()
          .filter((it): it is ParamUIParam => it.type !== 'separator');
        const map: Record<string, { label: string; from: string; to: string }> =
          {};
        const fmt = (item: ParamUIParam | undefined, v: unknown): string => {
          const raw = String(v ?? '');
          const label = item?.enums?.[raw] ?? raw;
          return item?.unit ? `${label} ${item.unit}` : label;
        };
        for (const c of paramChanges) {
          const item = items.find((it) => it.instanceKey === c.key);
          map[c.key] = {
            label: item?.label || c.key,
            from: fmt(item, c.from),
            to: fmt(item, c.to),
          };
        }
        setParamLabels(map);
      })
      .catch(() => {
        // Falls back to the raw key/values already rendered below - a
        // model-load failure here shouldn't block the popover itself.
      });
    return () => {
      cancelled = true;
    };
  }, [changes, projectId, device.id]);

  const title = isModified
    ? 'Modified — not yet downloaded'
    : device.restart_withheld
      ? 'Restart withheld'
      : 'Programmed';

  // Opens downward by default (CSS: top: calc(100% + 6px)), but a row near
  // the bottom of the table - there's no page-level scroll to reach past it
  // (.root is `overflow: clip`, deliberately not scrollable - see its own
  // CSS comment) - would push the action buttons entirely off-screen with
  // no way to reach them. Flip to open upward instead whenever the
  // downward placement wouldn't fit in the viewport, checked after the
  // real content (and its real height, e.g. a long restart-withheld
  // reason) has rendered.
  const ref = useRef<HTMLDivElement>(null);
  const [openUpward, setOpenUpward] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) setOpenUpward(true);
  }, [changes, changeCount]);

  return (
    <div
      ref={ref}
      className={`${styles.popover} ${openUpward ? styles.popoverUp : ''}`}
      role="dialog"
      aria-label={title}
    >
      <div className={styles.header}>
        <strong>{title}</strong>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className={styles.body}>
        {isModified ? (
          loadErr ? (
            <div className={styles.err}>{loadErr}</div>
          ) : changeCount === null ? (
            <div className={styles.muted}>Loading…</div>
          ) : changeCount === 0 ? (
            <div className={styles.muted}>
              No pending changes recorded - the next Verify or Program will
              confirm what actually differs.
            </div>
          ) : changes ? (
            <ul className={styles.changeList}>
              {changes.map((c, i) => (
                <li key={`${c.kind}:${c.key}:${i}`}>
                  {c.kind === 'ga_link' && (
                    <>
                      {c.label}: <code>{String(c.from) || '(none)'}</code> →{' '}
                      <code>{String(c.to) || '(none)'}</code>
                    </>
                  )}
                  {c.kind === 'group_object_flag' && (
                    <>
                      {c.label}
                      {(c.flagDiffs ?? []).map((f, j) => (
                        <span key={j}>
                          {j > 0 ? ', ' : ' — '}
                          {f.field}: {f.from} → {f.to}
                        </span>
                      ))}
                    </>
                  )}
                  {c.kind === 'param_value' &&
                    (paramLabels?.[c.key] ? (
                      <>
                        {paramLabels[c.key]!.label}:{' '}
                        <code>{paramLabels[c.key]!.from}</code> →{' '}
                        <code>{paramLabels[c.key]!.to}</code>
                      </>
                    ) : (
                      <>
                        Parameter: <code>{String(c.from ?? '')}</code> →{' '}
                        <code>{String(c.to ?? '')}</code>
                      </>
                    ))}
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.muted}>
              {changeCount} changes pending — see this device's Parameters and
              Group Objects pages for full details.
            </div>
          )
        ) : (
          <>
            {device.last_download ? (
              <div className={styles.infoLine}>
                Last download: {new Date(device.last_download).toLocaleString()}
              </div>
            ) : (
              // The badge only reads "Programmed" (this branch) once a
              // real download has completed - the one way to reach this
              // with no last_download on file is a prior "Reset download
              // status" (this popover's own action, or the pre-existing
              // route it calls) clearing it without also reverting the
              // status label itself. Said plainly rather than just "no
              // download recorded", since the badge and this body would
              // otherwise flatly contradict each other.
              <div className={styles.muted}>
                No download on file for this device, even though it's marked
                Programmed - its history was likely reset. Verify or re-program
                to establish a fresh record.
              </div>
            )}
            {!!device.last_download_serial && (
              <div className={styles.infoLine}>
                Serial confirmed: {device.last_download_serial}
              </div>
            )}
            {!!device.restart_withheld && (
              <div className={styles.warnBlock}>
                <div>
                  Still running its previous, un-restarted application - the
                  download completed but the device was never rebooted onto it.
                </div>
                {device.restart_withheld_reason && (
                  <div className={styles.reason}>
                    {device.restart_withheld_reason}
                  </div>
                )}
                {device.restart_withheld_at && (
                  <div className={styles.muted}>
                    {new Date(device.restart_withheld_at).toLocaleString()}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {!isModified && (
        <div className={styles.actions}>
          {!!device.restart_withheld && (
            <Btn onClick={onRestart} disabled={restarting}>
              {restarting ? 'Restarting…' : 'Restart device'}
            </Btn>
          )}
          {/* Always offered here (this branch only renders for a
              Programmed/Restart-needed device to begin with) rather than
              gated on last_download/restart_withheld already being set -
              resetting an already-clear record is a harmless no-op, and
              hiding the button whenever those happen to be empty is
              exactly how this device ended up with a "Programmed" badge
              and nothing to show for it in the first place. */}
          <Btn onClick={onClearHistory} disabled={clearingHistory}>
            {clearingHistory ? 'Resetting…' : 'Reset download status'}
          </Btn>
        </div>
      )}
    </div>
  );
}
