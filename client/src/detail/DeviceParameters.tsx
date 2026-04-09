import { useState, useEffect } from 'react';
import { api } from '../api.ts';
import styles from './DeviceParameters.module.css';

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
  C?: any;
}

export function DeviceParameters({ dev, projectId }: DeviceParametersProps) {
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
        display = String(rawVal) === '1' ? '✓' : '✗';
      else if (isDuration)
        display = fmtDuration(rawVal, item.unit, item.uiHint);
      else display = rawVal;
      return <span className={styles.viewValue}>{display}</span>;
    }
    if (item.typeKind === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={String(rawVal) === '1'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleChange(item.instanceKey, e.target.checked ? '1' : '0')
          }
          className={styles.checkbox}
        />
      );
    }
    if (item.typeKind === 'enum') {
      const entries = Object.entries(item.enums || {});
      if (entries.length === 2) {
        return (
          <div className={styles.radioGroup}>
            {entries.map(([v, l]) => (
              <label key={v} className={styles.radioLabel}>
                <input
                  type="radio"
                  name={item.instanceKey}
                  value={v}
                  checked={String(rawVal) === String(v)}
                  onChange={() => handleChange(item.instanceKey, v)}
                  className={styles.radio}
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
          className={styles.selectInput}
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
          className={styles.numberInput}
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
          className={styles.durationInput}
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
        className={styles.textInput}
        style={{ width: textWidth }}
      />
    );
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLabel}>PARAMETERS</div>
        {mode === 'view' ? (
          <button onClick={() => setMode('edit')} className={styles.editBtn}>
            Edit
          </button>
        ) : (
          <>
            <button onClick={() => setMode('view')} className={styles.viewBtn}>
              View
            </button>
            {dirty && (
              <button
                onClick={handleSave}
                disabled={saving}
                className={styles.saveBtn}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {saveErr && <span className={styles.saveErr}>{saveErr}</span>}
          </>
        )}
      </div>
      {sections.length === 0 ? (
        <div className={styles.emptyMsg}>No visible parameters</div>
      ) : (
        <div className={styles.splitLayout}>
          {sections.length > 1 && (
            <div className={styles.sidebar}>
              {(() => {
                const items: React.ReactNode[] = [];
                let lastGroup: string | null = null;
                for (const key of sections) {
                  const grp = secGroupMap[key] || '';
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
                          className={styles.sideGroup}
                        >
                          <span
                            className={
                              collapsed
                                ? styles.sideGroupArrowCollapsed
                                : styles.sideGroupArrowExpanded
                            }
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
                      className={
                        curSec === key
                          ? styles.sideItemActive
                          : styles.sideItemInactive
                      }
                      style={{ padding: `4px 10px 4px ${paddingLeft}px` }}
                    >
                      {lbl}
                    </div>,
                  );
                }
                return items;
              })()}
            </div>
          )}
          <div className={styles.content}>
            <SectionContent
              items={secMap[curSec] || []}
              tableLayout={secTableLayouts[curSec]}
              renderInput={renderInput}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface SepRowProps {
  item: any;
}

function SepRow({ item }: SepRowProps) {
  if (item.uiHint === 'Headline' && item.text)
    return (
      <tr>
        <td colSpan={99} className={styles.sepHeadline}>
          {item.text}
        </td>
      </tr>
    );
  if (item.uiHint === 'HorizontalRuler')
    return (
      <tr>
        <td colSpan={99} className={styles.sepHrPad}>
          <hr className={styles.sepHr} />
        </td>
      </tr>
    );
  if (item.uiHint === 'Information' && item.text)
    return (
      <tr>
        <td colSpan={99} className={styles.sepInfoPad}>
          <div className={styles.sepInfo}>
            <span className={styles.sepInfoIcon}>i</span>
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
}

function SectionContent({
  items,
  tableLayout,
  renderInput,
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

  return (
    <>
      {runs.map((run: any, ri: number) => {
        if (run.type === 'separator') {
          return (
            <table key={`s${ri}`} className={styles.paramTable}>
              <tbody>
                <SepRow item={run.item} />
              </tbody>
            </table>
          );
        }
        if (run.type === 'table' && rows && columns) {
          return (
            <table
              key={`t${ri}`}
              className={`${styles.tableLayoutTable} ${styles.tableLayoutBorder}`}
            >
              <thead>
                <tr>
                  <th className={styles.tableLayoutThBorder}></th>
                  {columns.map((col: any, ci: number) => (
                    <th
                      key={ci}
                      className={styles.tableLayoutThBorder}
                      style={col.width ? { width: col.width } : undefined}
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
                      <td className={styles.tableLayoutRowLabelBorder}>
                        {row.text}
                      </td>
                      {rowItems.map((item: any, ci: number) => (
                        <td key={ci} className={styles.tableLayoutCellBorder}>
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
            <table key={`p${ri}`} className={styles.paramTable}>
              <tbody>
                {run.items.map((item: any, i: number) => (
                  <tr key={i}>
                    <td className={styles.paramLabel}>{item.label}</td>
                    <td className={styles.paramValue}>{renderInput(item)}</td>
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
