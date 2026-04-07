import { useState, useEffect } from 'react';
import { api } from '../api.ts';

// Test whether a numeric/string value matches an ETS when-test entry.
// Tests can be exact ('0','1') or relational ('<2','>0','<=3','>=1').
function etsTestMatch(val: string, tests: any[] | undefined) {
  const n = parseFloat(val);
  for (const t of tests || []) {
    const rm =
      typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]!);
      const op = rm[1]!;
      if (op === '<' && n < rv) return true;
      if (op === '>' && n > rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '=' && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) {
      return true;
    }
  }
  return false;
}

// -- Client-side Dynamic condition evaluator --
function evalDynTree(
  dynTree: any,
  _modArgs: any,
  getVal: (key: string) => any,
  params: Record<string, any>,
) {
  const active = new Set<string>();
  function evalChoice(choice: any) {
    if (
      choice.paramRefId &&
      !choice.accessNone &&
      params[choice.paramRefId] &&
      !active.has(choice.paramRefId)
    )
      return;
    const raw = getVal(choice.paramRefId);
    const val = String(
      raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''),
    );
    let matched = false,
      defItems: any[] | null = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) {
        defItems = w.items;
        continue;
      }
      if (etsTestMatch(val, w.test)) {
        matched = true;
        walkItems(w.items);
      }
    }
    if (!matched && defItems) walkItems(defItems);
  }
  function walkItems(items: any[] | undefined) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') active.add(item.refId);
      else if (
        item.type === 'block' ||
        item.type === 'channel' ||
        item.type === 'cib'
      )
        walkItems(item.items);
      else if (item.type === 'choose') evalChoice(item);
    }
  }
  walkItems(dynTree?.main?.items);
  for (const md of dynTree?.moduleDefs || []) walkItems(md.items);
  return active;
}

function interpTpl(tpl: string | undefined, args: Record<string, any>) {
  if (!tpl) return '';
  if (!args) return tpl;
  return tpl
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => args[k] ?? '')
    .replace(
      /\{\{(\d+)\s*:\s*([^}]*)\}\}/g,
      (_, n: string, def: string) => args[n] ?? def.trim(),
    )
    .replace(/[\s:–—-]+$/, '')
    .trim();
}

interface DeviceParametersProps {
  dev: any;
  projectId: any;
  C: any;
}

export function DeviceParameters({ dev, projectId, C }: DeviceParametersProps) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [model, setModel] = useState<any>(null);
  const [_loading, setLoading] = useState(false);
  const [_loadErr, setLoadErr] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );

  const devId = dev.id;

  // Auto-load the model whenever the device changes (if it has an app_ref).
  // This means view mode always shows current saved values, not the stale ETS snapshot.
  useEffect(() => {
    setModel(null);
    setValues({});
    setMode('view');
    setDirty(false);
    setLoading(false);
    setLoadErr(null);
    if (!dev.app_ref || !projectId || !devId) return;
    let cancelled = false;
    setLoading(true);
    api
      .getParamModel(projectId, devId)
      .then((data: any) => {
        if (cancelled) return;
        setModel(data);
        const init: Record<string, any> = {};
        for (const [k, v] of Object.entries(data.currentValues || {}))
          init[k] = v;
        setValues(init);
      })
      .catch((e: any) => {
        if (!cancelled) setLoadErr(e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [devId, projectId, dev.app_ref]);

  const handleChange = (instanceKey: string, newVal: string) => {
    setValues((prev) => ({ ...prev, [instanceKey]: newVal }));
    setDirty(true);
  };

  const [saveErr, setSaveErr] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      await api.saveParamValues(projectId, devId, values);
      setDirty(false);
    } catch (e: any) {
      setSaveErr(e.message || 'Save failed');
    }
    setSaving(false);
  };

  if (mode === 'view' && !model) return null;

  if (!model) return null;
  const { params, dynTree, modArgs } = model;

  const strippedValues: Record<string, any> = {};
  for (const [iKey, val] of Object.entries(values)) {
    const sk = iKey.replace(/_M-\d+_MI-\d+/g, '');
    if (!(sk in strippedValues)) strippedValues[sk] = val;
  }

  const getDefault = (prKey: string) => params[prKey]?.defaultValue ?? '';
  const getVal = (prKey: string) => strippedValues[prKey] ?? getDefault(prKey);
  const activeParams = evalDynTree(dynTree, modArgs, getVal, params);

  const sections: string[] = [];
  const secMap: Record<string, any[]> = {};
  const secGroupMap: Record<string, string> = {};
  const secIndentMap: Record<string, number> = {};
  const secLabelMap: Record<string, string> = {};

  const secTableLayouts: Record<string, any> = {};

  function ensureSection(secLabel: string, grp: string | undefined) {
    const key = `${grp || ''}\0${secLabel}`;
    if (!secMap[key]) {
      secMap[key] = [];
      sections.push(key);
      secGroupMap[key] = grp || '';
      secIndentMap[key] = 0;
      secLabelMap[key] = secLabel;
    }
    return key;
  }

  function addItem(
    secLabel: string,
    instanceKey: string,
    prKey: string,
    args: Record<string, any>,
    cell: string | undefined,
    grp: string | undefined,
  ) {
    if (!params[prKey] || !activeParams.has(prKey)) return;
    const meta = params[prKey];
    const effectiveGrp =
      grp !== undefined
        ? grp
        : meta.group
          ? interpTpl(meta.group, args) || meta.group
          : '';
    const key = ensureSection(secLabel, effectiveGrp);
    if (!secMap[key]!.some((x: any) => x.instanceKey === instanceKey)) {
      secMap[key]!.push({
        instanceKey,
        prKey,
        label: interpTpl(meta.label, args) || meta.label,
        typeKind: meta.typeKind,
        enums: meta.enums,
        min: meta.min,
        max: meta.max,
        step: meta.step,
        uiHint: meta.uiHint || '',
        unit: meta.unit || '',
        defaultValue: meta.defaultValue,
        readOnly: meta.readOnly,
        cell: cell || undefined,
      });
    }
  }

  function addSeparator(secLabel: string, item: any, grp: string | undefined) {
    const key = ensureSection(secLabel, grp);
    secMap[key]!.push({
      type: 'separator',
      text: item.text,
      uiHint: item.uiHint,
    });
  }

  // Track Rename: blockId -> new display text (set by Rename elements inside active when-branches)
  const blockRenames: Record<string, string> = {};

  // Pre-scan items for active Renames, evaluating choose/when to find which branch fires
  function collectRenames(items: any[] | undefined) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'rename' && item.refId && item.text) {
        blockRenames[item.refId] = item.text;
      } else if (item.type === 'choose') {
        if (
          item.paramRefId &&
          !item.accessNone &&
          params[item.paramRefId] &&
          !activeParams.has(item.paramRefId)
        )
          continue;
        const raw = getVal(item.paramRefId);
        const val = String(
          raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
        );
        let matched = false,
          defItems: any[] | null = null;
        for (const w of item.whens || []) {
          if (w.isDefault) {
            defItems = w.items;
            continue;
          }
          if (etsTestMatch(val, w.test)) {
            matched = true;
            collectRenames(w.items);
          }
        }
        if (!matched && defItems) collectRenames(defItems);
      } else if (
        item.type === 'block' ||
        item.type === 'channel' ||
        item.type === 'cib'
      ) {
        collectRenames(item.items);
      }
    }
  }

  // Special walk for channel children: defers Access=None block content
  // to the next navigable block (matching ETS6 behavior where Access=None
  // block params appear on the parent/group header page)
  function walkChannelItems(
    items: any[] | undefined,
    chLabel: string,
    args: Record<string, any>,
    mkPrefix: string | null,
    grpLabel: string | undefined,
  ) {
    if (!items) return;
    let deferredItems: any[] = [];
    for (const item of items) {
      if (item.type === 'block' && item.access === 'None') {
        collectRenames(item.items);
      } else if (item.type === 'block' && !item.inline) {
        collectRenames(item.items);
        const renamed = item.id ? blockRenames[item.id] : null;
        const blockLabel =
          renamed ||
          interpTpl(item.text, args) ||
          item.text ||
          item.name ||
          chLabel;
        walkItems(deferredItems, blockLabel, args, mkPrefix, grpLabel);
        deferredItems = [];
        walkItems(item.items, blockLabel, args, mkPrefix, grpLabel);
      } else if (item.type === 'choose') {
        if (
          item.paramRefId &&
          !item.accessNone &&
          params[item.paramRefId] &&
          !activeParams.has(item.paramRefId)
        )
          continue;
        const raw = getVal(item.paramRefId);
        const val = String(
          raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
        );
        let matched = false,
          defWhenItems: any[] | null = null;
        for (const w of item.whens || []) {
          if (w.isDefault) {
            defWhenItems = w.items;
            continue;
          }
          if (etsTestMatch(val, w.test)) {
            matched = true;
            walkChannelItems(w.items, chLabel, args, mkPrefix, grpLabel);
          }
        }
        if (!matched && defWhenItems)
          walkChannelItems(defWhenItems, chLabel, args, mkPrefix, grpLabel);
      } else {
        if (
          deferredItems.length > 0 ||
          item.type === 'separator' ||
          item.type === 'paramRef'
        ) {
          deferredItems.push(item);
        } else {
          walkItems([item], chLabel, args, mkPrefix, grpLabel);
        }
      }
    }
    if (deferredItems.length > 0) {
      walkItems(deferredItems, chLabel, args, mkPrefix, grpLabel);
    }
  }

  function walkItems(
    items: any[] | undefined,
    secLabel: string,
    args: Record<string, any>,
    mkPrefix: string | null,
    grpLabel: string | undefined,
  ) {
    if (!items) return;
    for (const item of items) {
      if (item.type === 'paramRef') {
        const prKey = item.refId;
        const instanceKey = mkPrefix
          ? mkPrefix + prKey.replace(/^[^_]*_/, '_')
          : prKey;
        addItem(secLabel || '', instanceKey, prKey, args, item.cell, grpLabel);
      } else if (item.type === 'separator') {
        addSeparator(secLabel || '', item, grpLabel);
      } else if (item.type === 'rename') {
        if (item.refId && item.text) blockRenames[item.refId] = item.text;
      } else if (item.type === 'block') {
        if (item.layout === 'Table' && item.rows && item.columns) {
          const key = ensureSection(secLabel || '', grpLabel);
          if (!secTableLayouts[key])
            secTableLayouts[key] = { rows: item.rows, columns: item.columns };
        }
        collectRenames(item.items);
        if (item.inline || item.access === 'None') {
          walkItems(item.items, secLabel, args, mkPrefix, grpLabel);
        } else {
          const renamed = item.id ? blockRenames[item.id] : null;
          const blockLabel =
            renamed ||
            interpTpl(item.text, args) ||
            item.text ||
            item.name ||
            secLabel;
          walkItems(item.items, blockLabel, args, mkPrefix, grpLabel);
        }
      } else if (item.type === 'choose') {
        if (
          item.paramRefId &&
          !item.accessNone &&
          params[item.paramRefId] &&
          !activeParams.has(item.paramRefId)
        )
          continue;
        const raw = getVal(item.paramRefId);
        const val = String(
          raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
        );
        let matched = false,
          defItems: any[] | null = null;
        for (const w of item.whens || []) {
          if (w.isDefault) {
            defItems = w.items;
            continue;
          }
          if (etsTestMatch(val, w.test)) {
            matched = true;
            walkItems(w.items, secLabel, args, mkPrefix, grpLabel);
          }
        }
        if (!matched && defItems)
          walkItems(defItems, secLabel, args, mkPrefix, grpLabel);
      } else if (item.type === 'channel') {
        let chLabel = interpTpl(item.label, args) || item.label || '';
        if (item.textParamRefId) {
          const textVal = getVal(item.textParamRefId);
          if (textVal) chLabel = String(textVal);
        }
        collectRenames(item.items);
        walkChannelItems(item.items, chLabel, args, mkPrefix, chLabel);
      } else if (item.type === 'cib') {
        walkItems(item.items, '', args, mkPrefix, grpLabel);
      }
    }
  }

  walkItems(dynTree?.main?.items, '', {}, null, '');

  for (const md of dynTree?.moduleDefs || []) {
    const defId = md.id;
    const moduleKeys = Object.keys(modArgs || {}).filter((k: string) =>
      k.startsWith(defId + '_M-'),
    );
    for (const mk of moduleKeys) {
      const args = modArgs[mk] || {};
      const mkPrefix = mk + '_MI-1';
      walkItems(md.items, '', args, mkPrefix, '');
    }
  }

  const visibleSections = sections.filter((key) => {
    const grp = secGroupMap[key] || '';
    return !grp || !!expandedGroups[grp];
  });
  const curSec =
    activeSection !== null && visibleSections.includes(activeSection)
      ? activeSection
      : (visibleSections[0] ?? '');

  // Format a raw numeric value as hh:mm:ss (or hh:mm:ss.fff) for TypeTime display.
  const fmtDuration = (raw: any, unit: string, uiHint: string) => {
    const n = Number(raw);
    if (isNaN(n)) return String(raw);
    const pad2 = (x: number) => String(x).padStart(2, '0');
    const ms = unit === 'Milliseconds' ? n : n * 1000;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (uiHint === 'Duration_hhmmssfff') {
      const f = Math.round(ms % 1000);
      return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(f).padStart(3, '0')}`;
    }
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  };

  // Parse hh:mm:ss (or hh:mm:ss.fff) text back to raw value in the param's unit.
  const parseDuration = (text: string, unit: string) => {
    const parts = text.trim().split(':');
    if (parts.length < 3) return null;
    const h = parseInt(parts[0]!) || 0;
    const m = parseInt(parts[1]!) || 0;
    const sfff = parts[2]!.split('.');
    const s = parseInt(sfff[0]!) || 0;
    const ms = sfff[1]
      ? Math.round(parseInt(sfff[1]!.padEnd(3, '0').slice(0, 3)))
      : 0;
    const totalMs = (h * 3600 + m * 60 + s) * 1000 + ms;
    return unit === 'Milliseconds' ? totalMs : Math.round(totalMs / 1000);
  };

  const renderInput = (item: any) => {
    const rawVal = values[item.instanceKey] ?? item.defaultValue ?? '';
    const isDuration =
      item.typeKind === 'time' && item.uiHint?.startsWith('Duration_hh');

    if (item.readOnly || mode === 'view') {
      let display: any;
      if (item.typeKind === 'enum') display = item.enums?.[rawVal] ?? rawVal;
      else if (item.typeKind === 'checkbox')
        display = String(rawVal) === '1' ? '\u2713' : '\u2717';
      else if (isDuration)
        display = fmtDuration(rawVal, item.unit, item.uiHint);
      else display = rawVal;
      return (
        <span style={{ color: C.muted, fontFamily: 'monospace', fontSize: 10 }}>
          {display}
        </span>
      );
    }
    if (item.typeKind === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={String(rawVal) === '1'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleChange(item.instanceKey, e.target.checked ? '1' : '0')
          }
          style={{
            accentColor: C.accent,
            cursor: 'pointer',
            margin: 0,
            width: 14,
            height: 14,
          }}
        />
      );
    }
    if (item.typeKind === 'enum') {
      const entries = Object.entries(item.enums || {});
      if (entries.length === 2) {
        return (
          <div
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            {entries.map(([v, l]) => (
              <label
                key={v}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  cursor: 'pointer',
                  fontSize: 10,
                  color: C.text,
                  userSelect: 'none',
                }}
              >
                <input
                  type="radio"
                  name={item.instanceKey}
                  value={v}
                  checked={String(rawVal) === String(v)}
                  onChange={() => handleChange(item.instanceKey, v)}
                  style={{
                    accentColor: C.accent,
                    cursor: 'pointer',
                    margin: 0,
                  }}
                />
                {l as string}
              </label>
            ))}
          </div>
        );
      }
      return (
        <select
          value={rawVal}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            handleChange(item.instanceKey, e.target.value)
          }
          style={{
            background: C.surface,
            border: `1px solid ${C.border2}`,
            borderRadius: 3,
            padding: '2px 4px',
            color: C.text,
            fontSize: 10,
            fontFamily: 'inherit',
            maxWidth: 180,
          }}
        >
          {entries.map(([v, l]) => (
            <option key={v} value={v}>
              {l as string}
            </option>
          ))}
        </select>
      );
    }
    if (item.typeKind === 'number') {
      return (
        <input
          type="number"
          value={rawVal}
          min={item.min ?? undefined}
          max={item.max ?? undefined}
          step={item.step ?? 1}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleChange(item.instanceKey, e.target.value)
          }
          style={{
            background: C.surface,
            border: `1px solid ${C.border2}`,
            borderRadius: 3,
            padding: '2px 6px',
            color: C.text,
            fontSize: 10,
            fontFamily: 'monospace',
            width: 80,
          }}
        />
      );
    }
    if (isDuration) {
      return (
        <input
          type="text"
          value={fmtDuration(rawVal, item.unit, item.uiHint)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const parsed = parseDuration(e.target.value, item.unit);
            if (parsed !== null) handleChange(item.instanceKey, String(parsed));
          }}
          placeholder="hh:mm:ss"
          style={{
            background: C.surface,
            border: `1px solid ${C.border2}`,
            borderRadius: 3,
            padding: '2px 6px',
            color: C.text,
            fontSize: 10,
            fontFamily: 'monospace',
            width: 90,
          }}
        />
      );
    }
    const textWidth = item.typeKind === 'text' ? 220 : 140;
    return (
      <input
        type="text"
        value={rawVal}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          handleChange(item.instanceKey, e.target.value)
        }
        style={{
          background: C.surface,
          border: `1px solid ${C.border2}`,
          borderRadius: 3,
          padding: '2px 6px',
          color: C.text,
          fontSize: 10,
          fontFamily: 'monospace',
          width: textWidth,
        }}
      />
    );
  };

  return (
    <div style={{ marginTop: 20, marginBottom: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em' }}>
          PARAMETERS
        </div>
        {mode === 'view' ? (
          <button
            onClick={() => setMode('edit')}
            style={{
              fontSize: 9,
              background: 'none',
              border: `1px solid ${C.accent}`,
              borderRadius: 3,
              padding: '1px 6px',
              color: C.accent,
              cursor: 'pointer',
            }}
          >
            Edit
          </button>
        ) : (
          <>
            <button
              onClick={() => setMode('view')}
              style={{
                fontSize: 9,
                background: 'none',
                border: `1px solid ${C.border2}`,
                borderRadius: 3,
                padding: '1px 6px',
                color: C.muted,
                cursor: 'pointer',
              }}
            >
              View
            </button>
            {dirty && (
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  fontSize: 9,
                  background: C.accent,
                  border: 'none',
                  borderRadius: 3,
                  padding: '1px 8px',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {saving ? 'Saving\u2026' : 'Save'}
              </button>
            )}
            {saveErr && (
              <span style={{ fontSize: 9, color: C.red }}>{saveErr}</span>
            )}
          </>
        )}
      </div>
      {sections.length === 0 ? (
        <div style={{ color: C.dim, fontSize: 10 }}>No visible parameters</div>
      ) : (
        <div style={{ display: 'flex', gap: 0 }}>
          {sections.length > 1 && (
            <div
              style={{
                minWidth: 120,
                borderRight: `1px solid ${C.border}`,
                marginRight: 12,
                flexShrink: 0,
              }}
            >
              {(() => {
                const items: React.ReactNode[] = [];
                let lastGroup: string | null = null;
                for (const key of sections) {
                  const grp = secGroupMap[key] || '';
                  const _indent = secIndentMap[key] || 0;
                  const lbl = secLabelMap[key] || key || 'General';
                  if (grp !== lastGroup) {
                    lastGroup = grp;
                    if (grp) {
                      const collapsed = !expandedGroups[grp];
                      items.push(
                        <div
                          key={'grp:' + grp}
                          onClick={() =>
                            setExpandedGroups((prev) => ({
                              ...prev,
                              [grp]: !prev[grp],
                            }))
                          }
                          style={{
                            position: 'relative',
                            padding: '4px 10px 4px 14px',
                            fontSize: 10,
                            color: C.muted,
                            userSelect: 'none',
                            whiteSpace: 'nowrap',
                            borderLeft: '2px solid transparent',
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            style={{
                              position: 'absolute',
                              left: 5,
                              top: '50%',
                              transform: `translateY(-50%) rotate(${collapsed ? '-90deg' : '0deg'})`,
                              fontSize: 7,
                              transition: 'transform 0.15s',
                            }}
                          >
                            &#9660;
                          </span>
                          {grp}
                        </div>,
                      );
                    }
                  }
                  if (grp && !expandedGroups[grp]) continue;
                  const paddingLeft = grp ? 24 : 14;
                  items.push(
                    <div
                      key={key}
                      onClick={() => setActiveSection(key)}
                      style={{
                        padding: `4px 10px 4px ${paddingLeft}px`,
                        cursor: 'pointer',
                        fontSize: 10,
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        color: curSec === key ? C.accent : C.muted,
                        borderLeft: `2px solid ${curSec === key ? C.accent : 'transparent'}`,
                        background: curSec === key ? C.selected : 'transparent',
                      }}
                    >
                      {lbl}
                    </div>,
                  );
                }
                return items;
              })()}
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <SectionContent
              items={secMap[curSec] || []}
              tableLayout={secTableLayouts[curSec]}
              renderInput={renderInput}
              C={C}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface SepRowProps {
  item: any;
  C: any;
}

function SepRow({ item, C }: SepRowProps) {
  if (item.uiHint === 'Headline' && item.text)
    return (
      <tr>
        <td
          colSpan={99}
          style={{
            padding: '10px 8px 4px',
            color: C.accent,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
          }}
        >
          {item.text}
        </td>
      </tr>
    );
  if (item.uiHint === 'HorizontalRuler')
    return (
      <tr>
        <td colSpan={99} style={{ padding: 0 }}>
          <hr
            style={{
              border: 'none',
              borderTop: `1px solid ${C.border}`,
              margin: '4px 0',
            }}
          />
        </td>
      </tr>
    );
  if (item.uiHint === 'Information' && item.text)
    return (
      <tr>
        <td colSpan={99} style={{ padding: '6px 8px' }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              padding: '8px 10px',
              background: `${C.accent}08`,
              border: `1px solid ${C.accent}25`,
              borderRadius: 4,
              fontSize: 9,
              color: C.muted,
            }}
          >
            <span
              style={{
                color: C.accent,
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              i
            </span>
            <span>{item.text}</span>
          </div>
        </td>
      </tr>
    );
  return null;
}

interface SectionContentProps {
  items: any[];
  tableLayout: any;
  renderInput: (item: any) => React.ReactNode;
  C: any;
}

function SectionContent({
  items,
  tableLayout,
  renderInput,
  C,
}: SectionContentProps) {
  if (!items?.length) return null;

  // Group into runs preserving order: separator, table (cells), regular params
  const runs: any[] = [];
  const cellMap: Record<string, any> | null = tableLayout ? {} : null;

  for (const item of items) {
    if (item.type === 'separator') {
      runs.push({ type: 'separator', item });
    } else if (item.cell && tableLayout) {
      cellMap![item.cell] = item;
      if (!runs.some((r: any) => r.type === 'table'))
        runs.push({ type: 'table' });
    } else {
      const last = runs[runs.length - 1];
      if (last?.type === 'params') last.items.push(item);
      else runs.push({ type: 'params', items: [item] });
    }
  }

  const { rows, columns } = tableLayout || {};
  const bc = C.border;

  return (
    <>
      {runs.map((run: any, ri: number) => {
        if (run.type === 'separator') {
          return (
            <table
              key={`s${ri}`}
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 10,
              }}
            >
              <tbody>
                <SepRow item={run.item} C={C} />
              </tbody>
            </table>
          );
        }
        if (run.type === 'table' && rows && columns) {
          return (
            <table
              key={`t${ri}`}
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 10,
                border: `1px solid ${bc}`,
                margin: '4px 0',
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      padding: '4px 8px',
                      textAlign: 'left',
                      color: C.dim,
                      fontSize: 9,
                      fontWeight: 600,
                      border: `1px solid ${bc}`,
                    }}
                  ></th>
                  {columns.map((col: any, ci: number) => (
                    <th
                      key={ci}
                      style={{
                        padding: '4px 8px',
                        textAlign: 'left',
                        color: C.dim,
                        fontSize: 9,
                        fontWeight: 600,
                        width: col.width || 'auto',
                        border: `1px solid ${bc}`,
                      }}
                    >
                      {col.text}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any, rowIdx: number) => {
                  const rowItems = columns.map(
                    (_: any, ci: number) => cellMap![`${rowIdx + 1},${ci + 1}`],
                  );
                  if (rowItems.every((x: any) => !x)) return null;
                  return (
                    <tr key={rowIdx}>
                      <td
                        style={{
                          padding: '4px 8px',
                          color: C.muted,
                          fontWeight: 500,
                          border: `1px solid ${bc}`,
                        }}
                      >
                        {row.text}
                      </td>
                      {rowItems.map((item: any, ci: number) => (
                        <td
                          key={ci}
                          style={{
                            padding: '3px 8px',
                            verticalAlign: 'middle',
                            border: `1px solid ${bc}`,
                          }}
                        >
                          {item ? renderInput(item) : null}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        }
        if (run.type === 'params') {
          return (
            <table
              key={`p${ri}`}
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 10,
              }}
            >
              <tbody>
                {run.items.map((item: any, i: number) => (
                  <tr key={i}>
                    <td
                      style={{
                        padding: '4px 8px',
                        color: C.muted,
                        width: '50%',
                        verticalAlign: 'middle',
                      }}
                    >
                      {item.label}
                    </td>
                    <td style={{ padding: '3px 8px', verticalAlign: 'middle' }}>
                      {renderInput(item)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return null;
      })}
    </>
  );
}
