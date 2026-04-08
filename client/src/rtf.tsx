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
import styles from './rtf.module.css';

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
      <span
        style={style}
        className={`${styles.loading}${className ? ` ${className}` : ''}`}
      >
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
    <div className={styles.fieldWrap}>
      <div className={styles.fieldLabel}>{label}</div>
      {editing ? (
        <div className={styles.editWrap}>
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className={styles.textarea}
          />
          <div className={styles.editActions}>
            <span
              onClick={!saving ? handleSave : undefined}
              className={`${styles.saveBtn} bg`}
              style={{ cursor: saving ? 'default' : 'pointer' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </span>
            <span
              onClick={() => setEditing(false)}
              className={`${styles.cancelBtn} bg`}
            >
              Cancel
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={onSave ? startEdit : undefined}
          className={styles.displayBox}
          style={{
            color: value ? C.muted : C.dim,
            cursor: onSave ? 'pointer' : 'default',
          }}
          title={onSave ? 'Click to edit' : undefined}
        >
          {value ? (
            <RtfText value={value} />
          ) : (
            <span className={styles.emptyText}>Empty</span>
          )}
        </div>
      )}
    </div>
  );
}
