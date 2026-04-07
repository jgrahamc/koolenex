import { useEffect, useContext, Fragment } from 'react';
import { useC } from './theme.ts';
import { PinContext } from './contexts.ts';

interface BadgeProps {
  label: string;
  color: string;
  title?: string;
}

export const Badge = ({ label, color, title }: BadgeProps) => (
  <span
    title={title}
    style={{
      fontSize: 9,
      padding: '2px 6px',
      borderRadius: 10,
      background: `${color}18`,
      color,
      border: `1px solid ${color}30`,
      letterSpacing: '0.06em',
      whiteSpace: 'nowrap',
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
      style={{
        background: active ? C.selected : C.surface,
        border: `1px solid ${active ? C.accent + '66' : C.border}`,
        color: active ? C.accent : C.muted,
        padding: '3px 10px',
        borderRadius: 20,
        fontSize: 10,
        fontFamily: 'inherit',
        cursor: 'pointer',
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

export const TH = ({ children, style = {} }: THProps) => {
  const C = useC();
  return (
    <th
      style={{
        padding: '7px 12px',
        textAlign: 'left',
        fontSize: 9,
        color: C.dim,
        letterSpacing: '0.1em',
        fontWeight: 400,
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        position: 'sticky',
        top: 0,
        zIndex: 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </th>
  );
};

interface TDProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export const TD = ({ children, style = {} }: TDProps) => {
  const C = useC();
  return (
    <td
      style={{
        padding: '7px 12px',
        fontSize: 11,
        color: C.text,
        borderBottom: `1px solid ${C.border}`,
        ...style,
      }}
    >
      {children}
    </td>
  );
};

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const SearchBox = ({
  value,
  onChange,
  placeholder = 'Search…',
}: SearchBoxProps) => {
  const C = useC();
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: C.inputBg,
        border: `1px solid ${C.border2}`,
        borderRadius: 4,
        padding: '5px 10px',
        color: C.text,
        fontSize: 11,
        fontFamily: 'inherit',
        width: 200,
      }}
    />
  );
};

interface SectionHeaderProps {
  title: string;
  count?: number | null;
  actions?: React.ReactNode;
}

export const SectionHeader = ({
  title,
  count,
  actions,
}: SectionHeaderProps) => {
  const C = useC();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 16px',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        gap: 8,
        flexShrink: 0,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: "'Syne',sans-serif",
          fontWeight: 700,
          fontSize: 12,
          color: C.text,
          letterSpacing: '0.05em',
        }}
      >
        {title}
      </span>
      {count != null && (
        <span
          style={{
            fontSize: 10,
            color: C.dim,
            background: C.border,
            borderRadius: 10,
            padding: '1px 7px',
          }}
        >
          {count}
        </span>
      )}
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        {actions}
      </div>
    </div>
  );
};

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
      className="bg"
      title={title}
      style={{
        background: disabled ? C.surface : btnBg,
        border: `1px solid ${btnColor}44`,
        color: disabled ? C.dim : btnColor,
        padding: '4px 12px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
};

export const Spinner = () => {
  const C = useC();
  return (
    <span className="spin" style={{ fontSize: 12, color: C.accent }}>
      ◌
    </span>
  );
};

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
    style={{
      display: 'flex',
      gap: 0,
      borderBottom: `1px solid ${C.border}`,
      marginBottom: 16,
    }}
  >
    {tabs.map((t) => (
      <button
        key={t.id}
        onClick={() => onChange(t.id)}
        style={{
          background: 'none',
          border: 'none',
          borderBottom:
            active === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
          padding: '6px 14px',
          color: active === t.id ? C.accent : C.muted,
          fontSize: 10,
          letterSpacing: '0.07em',
          cursor: 'pointer',
          fontFamily: 'inherit',
          marginBottom: -1,
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

export const Empty = ({ icon = '◈', msg }: EmptyProps) => {
  const C = useC();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 10,
        color: C.dim,
      }}
    >
      <span style={{ fontSize: 36 }}>{icon}</span>
      <span style={{ fontSize: 12 }}>{msg}</span>
    </div>
  );
};

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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border2}`,
          borderRadius: 8,
          padding: 24,
          maxWidth: 420,
          width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: C.text,
            marginBottom: 12,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: C.muted,
            marginBottom: 20,
            lineHeight: 1.7,
          }}
        >
          {children}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
  const C = useC();
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: C.surface,
        border: `1px solid ${C.border2}`,
        borderRadius: 6,
        padding: '8px 16px',
        fontSize: 11,
        color: C.text,
        zIndex: 3000,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        whiteSpace: 'nowrap',
      }}
    >
      {msg}
    </div>
  );
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
          {i > 0 && <span style={{ opacity: 0.5 }}> › </span>}
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
