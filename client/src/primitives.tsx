import { useEffect, useContext, Fragment } from 'react';
import { useC } from './theme.ts';
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
      background: `${color}18`,
      color,
      border: `1px solid ${color}30`,
    }}
  >
    {label}
  </span>
);

interface ChipProps {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}

export const Chip = ({ children, active, onClick }: ChipProps) => {
  const C = useC();
  return (
    <button
      onClick={onClick}
      className={styles.chip}
      style={{
        background: active ? C.selected : C.surface,
        border: `1px solid ${active ? C.accent + '66' : C.border}`,
        color: active ? C.accent : C.muted,
      }}
    >
      {children}
    </button>
  );
};

interface THProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export const TH = ({ children, style = {} }: THProps) => (
  <th className={styles.th} style={style}>
    {children}
  </th>
);

interface TDProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export const TD = ({ children, style = {} }: TDProps) => (
  <td className={styles.td} style={style}>
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
}

export const Btn = ({
  children,
  onClick,
  color,
  bg,
  disabled = false,
  style = {},
  title,
}: BtnProps) => {
  const C = useC();
  const btnColor = color ?? C.accent;
  const btnBg = bg ?? C.selected;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${styles.btn} bg`}
      title={title}
      style={{
        background: disabled ? C.surface : btnBg,
        border: `1px solid ${btnColor}44`,
        color: disabled ? C.dim : btnColor,
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
  C: any;
}

export const TabBar = ({ tabs, active, onChange, C }: TabBarProps) => (
  <div
    className={styles.tabBar}
    style={{ borderBottom: `1px solid ${C.border}` }}
  >
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => onChange(t.id)}
        className={styles.tabBtn}
        style={{
          borderBottom:
            active === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
          color: active === t.id ? C.accent : C.muted,
        }}
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
}: ConfirmModalProps) => {
  const C = useC();
  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalBox}>
        <div className={styles.modalTitle}>{title}</div>
        <div className={styles.modalBody}>{children}</div>
        <div className={styles.modalActions}>
          <Btn onClick={onCancel} color={C.dim}>
            No
          </Btn>
          <Btn onClick={onConfirm} color={confirmColor ?? C.red}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>
  );
};

interface ToastProps {
  msg: string;
  onDone: () => void;
}

export const Toast = ({ msg, onDone }: ToastProps) => {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
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
      className={[className, canPin ? 'pa' : ''].filter(Boolean).join(' ')}
      data-pin={canPin ? '1' : undefined}
      style={{
        ...style,
        cursor: canPin ? 'pointer' : (style?.cursor ?? 'default'),
      }}
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

interface Space {
  id: string | number;
  name: string;
  type: string;
  parent_id?: string | number | null;
}

interface SpacePathProps {
  spaceId?: string | number;
  spaces?: Space[];
  style?: React.CSSProperties;
}

// Renders a space breadcrumb path with each segment clickable to pin that space
export function SpacePath({ spaceId, spaces, style }: SpacePathProps) {
  const C = useC();
  const pin = useContext(PinContext) as
    | ((wtype: string, address: string) => void)
    | null;
  if (!spaceId || !spaces?.length) return <span style={style}>—</span>;
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
  if (!parts.length) return <span style={style}>—</span>;
  return (
    <span style={style}>
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
            className={pin ? 'pa' : undefined}
            data-pin={pin ? '1' : undefined}
            style={{
              color: pin ? C.amber : 'inherit',
              cursor: pin ? 'pointer' : 'default',
            }}
          >
            {p.name}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
