/**
 * RtfText component -- renders RTF strings as HTML using the server-side
 * @iarna/rtf-to-html converter. Raw RTF is preserved in the DB for re-export;
 * this component only handles display.
 *
 * EditableRtfField -- always-visible labeled box, click-to-edit with a textarea.
 * When editing RTF content, the user edits plain text (RTF markup is replaced).
 */
import { useState, useEffect, useRef } from 'react';
import { api } from './api.ts';

// In-memory cache so we don't re-convert the same RTF string repeatedly
const cache = new Map<string, string>();

interface RtfTextProps {
  value?: string;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * React component that renders an RTF string as HTML.
 * Falls back to plain text if the string isn't RTF.
 */
export function RtfText({ value, style, className }: RtfTextProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return;
    if (!value.startsWith('{\\rtf')) return;

    if (cache.has(value)) {
      setHtml(cache.get(value)!);
      return;
    }

    let cancelled = false;
    api
      .rtfToHtml(value)
      .then((result) => {
        if (cancelled) return;
        cache.set(value, result);
        setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!value) return null;

  if (!value.startsWith('{\\rtf')) {
    return (
      <span style={style} className={className}>
        {value}
      </span>
    );
  }

  if (html === null) {
    return (
      <span style={{ ...style, opacity: 0.5 }} className={className}>
        Loading…
      </span>
    );
  }

  return (
    <span
      style={style}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Extract plain text from an RTF string for editing purposes.
 * Uses the cached HTML conversion if available, otherwise returns raw value.
 */
function rtfToPlainText(value: string) {
  if (!value || !value.startsWith('{\\rtf')) return value || '';
  const html = cache.get(value);
  if (html) {
    // Strip HTML tags, decode entities
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || '';
  }
  return value;
}

interface EditableRtfFieldProps {
  label: string;
  value?: string;
  onSave?: (draft: string) => Promise<void>;
  C: any;
}

/**
 * Always-visible labeled field box. Shows RTF/plain content.
 * Click to edit -- saves plain text (replaces RTF).
 */
export function EditableRtfField({
  label,
  value,
  onSave,
  C,
}: EditableRtfFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const startEdit = () => {
    setDraft(rtfToPlainText(value || ''));
    setEditing(true);
  };

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') setEditing(false);
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    }
  };

  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          letterSpacing: '0.08em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            style={{
              background: C.inputBg,
              border: `1px solid ${C.accent}`,
              borderRadius: 4,
              padding: '8px 12px',
              color: C.text,
              fontSize: 11,
              fontFamily: 'inherit',
              resize: 'vertical',
              minHeight: 40,
            }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <span
              onClick={!saving ? handleSave : undefined}
              style={{
                fontSize: 9,
                padding: '2px 8px',
                borderRadius: 10,
                background: `${C.green}18`,
                color: C.green,
                border: `1px solid ${C.green}30`,
                cursor: saving ? 'default' : 'pointer',
                letterSpacing: '0.06em',
              }}
              className="bg"
            >
              {saving ? 'Saving…' : 'Save'}
            </span>
            <span
              onClick={() => setEditing(false)}
              style={{
                fontSize: 9,
                padding: '2px 8px',
                borderRadius: 10,
                background: `${C.dim}15`,
                color: C.dim,
                border: `1px solid ${C.dim}30`,
                cursor: 'pointer',
                letterSpacing: '0.06em',
              }}
              className="bg"
            >
              Cancel
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={onSave ? startEdit : undefined}
          style={{
            fontSize: 11,
            color: value ? C.muted : C.dim,
            padding: '8px 12px',
            background: C.surface,
            borderRadius: 4,
            border: `1px solid ${C.border}`,
            minHeight: 20,
            cursor: onSave ? 'pointer' : 'default',
          }}
          title={onSave ? 'Click to edit' : undefined}
        >
          {value ? (
            <RtfText value={value} />
          ) : (
            <span style={{ fontStyle: 'italic', opacity: 0.5 }}>Empty</span>
          )}
        </div>
      )}
    </div>
  );
}
