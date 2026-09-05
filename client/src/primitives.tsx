import { useEffect, useContext, Fragment } from 'react';
import { PinContext } from './contexts.ts';
import styles from './primitives.module.css';

interface BadgeProps {
  label: string;
  color: string;
  title?: string;
}

export const Badge = ({ label, color, title }: BadgeProps) => (
  <span
    title={title}
    className={styles.badge}
    style={{
      background: `color-mix(in srgb, ${color} 9%, transparent)`,
      color,
      border: `1px solid color-mix(in srgb, ${color} 19%, transparent)`,
    }}
  >
    {label}
  </span>
);

interface ChipProps {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  // Scoped override for one specific Chip instance (e.g. a stronger
  // border color) - deliberately not a className passthrough, so callers
  // can't accidentally fight the shared .chipActive/.chipInactive base
  // styling, only layer a small addition on top of it.
  style?: React.CSSProperties;
}

export const Chip = ({ children, active, onClick, title, style }: ChipProps) => (
  <button
    onClick={onClick}
    title={title}
    className={`${styles.chip} ${active ? styles.chipActive : styles.chipInactive}`}
    style={style}
  >
    {children}
  </button>
);

interface THProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export const TH = ({ children, style = {}, className }: THProps) => (
  <th
    className={[styles.th, className].filter(Boolean).join(' ')}
    style={style}
  >
    {children}
  </th>
);

interface TDProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export const TD = ({ children, style = {}, className }: TDProps) => (
  <td
    className={[styles.td, className].filter(Boolean).join(' ')}
    style={style}
  >
    {children}
  </td>
);

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const SearchBox = ({
  value,
  onChange,
  placeholder = 'Search…',
}: SearchBoxProps) => (
  <input
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className={styles.searchBox}
  />
);

interface SectionHeaderProps {
  title: string;
  count?: number | null;
  actions?: React.ReactNode;
}

export const SectionHeader = ({
  title,
  count,
  actions,
}: SectionHeaderProps) => (
  <div className={styles.sectionHeader}>
    <span className={styles.sectionTitle}>{title}</span>
    {count != null && <span className={styles.sectionCount}>{count}</span>}
    <div className={styles.sectionActions}>{actions}</div>
  </div>
);

interface BtnProps {
  children?: React.ReactNode;
  onClick?: () => void;
  color?: string;
  bg?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  title?: string;
  className?: string;
}

export const Btn = ({
  children,
  onClick,
  color,
  bg,
  disabled = false,
  style = {},
  title,
  className,
}: BtnProps) => {
  const btnColor = color ?? 'var(--accent)';
  const btnBg = bg ?? 'var(--selected)';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${styles.btn} bg${className ? ` ${className}` : ''}`}
      title={title}
      style={{
        background: disabled ? 'var(--surface)' : btnBg,
        border: `1px solid color-mix(in srgb, ${btnColor} 27%, transparent)`,
        color: disabled ? 'var(--dim)' : btnColor,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
};

export const Spinner = () => (
  <span className={`spin ${styles.spinner}`}>◌</span>
);

interface TabItem {
  id: string;
  label: string;
}

interface TabBarProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  C?: any;
}

export const TabBar = ({ tabs, active, onChange }: TabBarProps) => (
  <div className={`${styles.tabBar} ${styles.tabBarBorder}`}>
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => onChange(t.id)}
        className={`${styles.tabBtn} ${active === t.id ? styles.tabBtnActive : styles.tabBtnInactive}`}
      >
        {t.label}
      </button>
    ))}
  </div>
);

interface EmptyProps {
  icon?: string;
  msg: string;
}

export const Empty = ({ icon = '◈', msg }: EmptyProps) => (
  <div className={styles.empty}>
    <span className={styles.emptyIcon}>{icon}</span>
    <span className={styles.emptyMsg}>{msg}</span>
  </div>
);

interface ConfirmModalProps {
  title: string;
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  confirmColor?: string;
}

export const ConfirmModal = ({
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel = 'Delete',
  confirmColor,
}: ConfirmModalProps) => (
  <div className={styles.modalOverlay}>
    <div className={styles.modalBox}>
      <div className={styles.modalTitle}>{title}</div>
      <div className={styles.modalBody}>{children}</div>
      <div className={styles.modalActions}>
        <Btn onClick={onCancel} color="var(--dim)">
          No
        </Btn>
        <Btn onClick={onConfirm} color={confirmColor ?? 'var(--red)'}>
          {confirmLabel}
        </Btn>
      </div>
    </div>
  </div>
);

interface ToastProps {
  msg: string;
  onDone: () => void;
}

export const Toast = ({ msg, onDone }: ToastProps) => {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return <div className={styles.toast}>{msg}</div>;
};

interface ComObject {
  ga_address?: string;
}

/** Split a co.ga_address string (space-separated, may be single or multiple) into an array. */
export const coGAs = (co: ComObject) =>
  co?.ga_address?.split(' ').filter(Boolean) || [];

interface PinAddrProps {
  address?: string;
  wtype?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
  className?: string;
}

/** Wrap any address span -- single-click pins the address. */
export function PinAddr({
  address,
  wtype,
  children,
  style,
  title,
  className,
}: PinAddrProps) {
  const pin = useContext(PinContext) as
    | ((wtype: string, address: string) => void)
    | null;
  const canPin = !!(address && wtype && pin);
  return (
    <span
      className={[className, canPin ? `pa ${styles.pinAddrClickable}` : '']
        .filter(Boolean)
        .join(' ')}
      data-pin={canPin ? '1' : undefined}
      style={style}
      title={title ?? (canPin ? `Pin ${address}` : undefined)}
      onClick={
        canPin
          ? (e) => {
              e.stopPropagation();
              pin!(wtype!, address!);
            }
          : undefined
      }
    >
      {children ?? address}
    </span>
  );
}

interface DeviceAddrProps {
  device: {
    individual_address: string;
    has_address?: number | boolean;
    serial_number?: string;
  };
  wtype?: string;
  style?: React.CSSProperties;
  className?: string;
  // Called when the "-.-.-" placeholder itself is clicked (has_address
  // falsy only - never fires for a real address). Omit to render it as
  // plain, non-interactive text.
  onAssignClick?: () => void;
}

/**
 * Address display for a device row - the one place that decides whether to
 * show a device's real individual_address or ETS's own "-.-.-" convention
 * for a device with no real address at all (has_address=0, a synthetic
 * placeholder - see ets-parser.ts's synthetic-address handling, added
 * 2026-08-30). Deliberately never renders the synthetic value itself
 * (e.g. "99.99.256") anywhere a person would read it, and never makes it
 * pinnable (PinAddr's click-to-pin), since pinning a fake address has no
 * real meaning. Use this instead of PinAddr directly for any device row.
 *
 * A real address with no recorded serial number gets its own distinct
 * amber "pending" color, not the normal accent - added 2026-08-30 after a
 * real gap: assigning/changing a device's planned address (AddressDeviceModal's
 * own project-address section, merged in 2026-08-31 - see that
 * component's doc comment) only updates our project record, not the
 * physical device - nothing has actually been written to hardware until a
 * real addressing write happens and records a serial against it. Without
 * this, a freshly (re)planned address looked indistinguishable from one
 * already confirmed on real hardware. That same gap also let a STALE
 * serial from a prior, unrelated address survive a project address
 * change and misleadingly count as "confirmed" for the new one - fixed
 * server-side, 2026-08-31 (server/routes/devices.ts clears serial_number
 * whenever individual_address genuinely changes).
 */
export function DeviceAddr({
  device,
  wtype,
  style,
  className,
  onAssignClick,
}: DeviceAddrProps) {
  if (!device.has_address) {
    return (
      <span
        className={[className, onAssignClick ? `pa ${styles.pinAddrClickable}` : '']
          .filter(Boolean)
          .join(' ')}
        style={{
          color: 'var(--amber)',
          cursor: onAssignClick ? 'pointer' : undefined,
          ...style,
        }}
        title={
          onAssignClick
            ? 'No individual address assigned yet — click to assign one'
            : 'No individual address assigned in the project yet - assign one before this device can be commissioned'
        }
        onClick={onAssignClick}
      >
        -.-.-
      </span>
    );
  }
  if (!device.serial_number) {
    return (
      <PinAddr
        address={device.individual_address}
        wtype={wtype}
        className={className}
        style={{ color: 'var(--amber)', ...style }}
        title={`${device.individual_address} — assigned in the project, but not yet written to a physical device (no serial recorded). Click to view/edit this device's details, parameters, and group address links.`}
      />
    );
  }
  return (
    <PinAddr
      address={device.individual_address}
      wtype={wtype}
      className={className}
      style={style}
      // Real request 2026-08-31: this badge already opens the device
      // detail page (DevicePinPanel.tsx), which has real parameter and
      // GA-link editing (DeviceParameters.tsx / onUpdateComObjectGAs) -
      // that wasn't obvious from PinAddr's own generic default tooltip
      // ("Pin X"), which says nothing about what's actually there.
      title={`${device.individual_address} — click to view/edit this device's details, parameters, and group address links`}
    />
  );
}

interface Space {
  id: string | number;
  name: string;
  type: string;
  parent_id?: string | number | null;
}

interface SpacePathProps {
  spaceId?: string | number | null;
  spaces?: Space[];
  style?: React.CSSProperties;
  className?: string;
}

// Renders a space breadcrumb path with each segment clickable to pin that space
export function SpacePath({
  spaceId,
  spaces,
  style,
  className,
}: SpacePathProps) {
  const pin = useContext(PinContext) as
    | ((wtype: string, address: string) => void)
    | null;
  if (!spaceId || !spaces?.length)
    return (
      <span style={style} className={className}>
        —
      </span>
    );
  const spaceMap = Object.fromEntries(spaces.map((s) => [s.id, s])) as Record<
    string | number,
    Space
  >;
  const parts: { id: string | number; name: string }[] = [];
  let cur: Space | undefined = spaceMap[spaceId];
  while (cur) {
    if (cur.type !== 'Building') parts.unshift({ id: cur.id, name: cur.name });
    cur = cur.parent_id ? spaceMap[cur.parent_id] : undefined;
  }
  if (!parts.length)
    return (
      <span style={style} className={className}>
        —
      </span>
    );
  return (
    <span style={style} className={className}>
      {parts.map((p, i) => (
        <Fragment key={String(p.id)}>
          {i > 0 && <span className={styles.spacePathSep}> › </span>}
          <span
            onClick={
              pin
                ? (e) => {
                    e.stopPropagation();
                    pin('space', String(p.id));
                  }
                : undefined
            }
            className={
              pin
                ? `pa ${styles.spacePathSegClickable}`
                : styles.spacePathSegDefault
            }
            data-pin={pin ? '1' : undefined}
          >
            {p.name}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
