import { useState, useEffect, useMemo } from 'react';
import { api } from '../api.js';

// Test whether a numeric/string value matches an ETS when-test entry.
// Tests can be exact ('0','1') or relational ('<2','>0','<=3','>=1').
function etsTestMatch(val, tests) {
  const n = parseFloat(val);
  for (const t of tests || []) {
    const rm = typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
    if (rm) {
      if (isNaN(n)) continue;
      const rv = parseFloat(rm[2]);
      const op = rm[1];
      if (op === '<'  && n <  rv) return true;
      if (op === '>'  && n >  rv) return true;
      if (op === '<=' && n <= rv) return true;
      if (op === '>=' && n >= rv) return true;
      if (op === '='  && n === rv) return true;
      if (op === '!=' && n !== rv) return true;
    } else if (String(t) === val) {
      return true;
    }
  }
  return false;
}

// ── Client-side Dynamic condition evaluator ──────────────────────────────────
function evalDynTree(dynTree, modArgs, getVal, params) {
  const active = new Set();
  function evalChoice(choice) {
    // getVal may return '' for access=None params not in currentValues.
    // Fall back to choice.defaultValue (from Parameter.@Value in the app XML).
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node); }
    }
    if (!matched && defNode) walkNode(defNode);
  }
  function walkNode(node) {
    if (!node) return;
    for (const r of node.paramRefs || []) active.add(r);
    for (const b of node.blocks || []) walkNode(b);
    for (const choice of node.choices || []) evalChoice(choice);
  }
  function walkDynSection(section) {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node);
    for (const ci of section.cib || []) walkNode(ci);
    for (const pb of section.pb || []) walkNode(pb);
    for (const choice of section.choices || []) evalChoice(choice);
  }
  walkDynSection(dynTree?.main);
  for (const md of dynTree?.moduleDefs || []) walkDynSection(md);
  return active;
}

function interpTpl(tpl, args) {
  if (!tpl) return '';
  if (!args) return tpl;
  return tpl
    .replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] ?? '')
    .replace(/\{\{(\d+)\s*:\s*([^}]*)\}\}/g, (_, n, def) => args[n] ?? def.trim())
    .replace(/[\s:–—-]+$/, '').trim();
}

export function DeviceParameters({ dev, projectId, C }) {
  const [mode, setMode] = useState('view');
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeSection, setActiveSection] = useState(null);

  const devId = dev.id;

  const viewParams = useMemo(() => {
    try { return JSON.parse(dev.parameters || '[]'); } catch { return []; }
  }, [dev.parameters]);

  // Auto-load the model whenever the device changes (if it has an app_ref).
  // This means view mode always shows current saved values, not the stale ETS snapshot.
  useEffect(() => {
    if (!dev.app_ref || !projectId || !devId) return;
    let cancelled = false;
    setLoading(true); setLoadErr(null); setModel(null); setValues({}); setMode('view'); setDirty(false);
    api.getParamModel(projectId, devId)
      .then(data => {
        if (cancelled) return;
        setModel(data);
        const init = {};
        for (const [k, v] of Object.entries(data.currentValues || {})) init[k] = v;
        setValues(init);
      })
      .catch(e => { if (!cancelled) setLoadErr(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [devId, projectId, dev.app_ref]);

  const handleChange = (instanceKey, newVal) => {
    setValues(prev => ({ ...prev, [instanceKey]: newVal }));
    setDirty(true);
  };

  const [saveErr, setSaveErr] = useState(null);

  const handleSave = async () => {
    setSaving(true); setSaveErr(null);
    try { await api.saveParamValues(projectId, devId, values); setDirty(false); }
    catch (e) { setSaveErr(e.message || 'Save failed'); }
    setSaving(false);
  };

  if (mode === 'view' && !model) {
    if (!viewParams.length && !dev.app_ref) return null;
    const sections = [];
    const sectionMap = {};
    for (const p of viewParams) {
      const sec = p.section || '';
      if (!sectionMap[sec]) { sectionMap[sec] = []; sections.push(sec); }
      sectionMap[sec].push(p);
    }
    const curSec = (activeSection !== null && sections.includes(activeSection)) ? activeSection : sections[0] ?? '';

    return (
      <div style={{ marginTop: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em' }}>PARAMETERS ({viewParams.length})</div>
          {dev.app_ref && (
            <button onClick={() => setMode('edit')} disabled={loading || !model}
              style={{ fontSize: 9, background: 'none', border: `1px solid ${C.accent}`, borderRadius: 3, padding: '1px 6px', color: C.accent, cursor: 'pointer', opacity: (!model || loading) ? 0.5 : 1 }}>
              {loading ? 'Loading…' : 'Edit'}
            </button>
          )}
          {loadErr && <span style={{ fontSize: 9, color: C.red }}>{loadErr}</span>}
        </div>
        <div style={{ display: 'flex', gap: 0 }}>
          {sections.length > 1 && (
            <div style={{ minWidth: 120, borderRight: `1px solid ${C.border}`, marginRight: 12, paddingRight: 0, flexShrink: 0 }}>
              {sections.map(s => (
                <div key={s} onClick={() => setActiveSection(s)}
                  style={{ padding: '5px 10px', cursor: 'pointer', fontSize: 10, userSelect: 'none', whiteSpace: 'nowrap',
                    color: curSec === s ? C.accent : C.muted,
                    borderLeft: `2px solid ${curSec === s ? C.accent : 'transparent'}`,
                    background: curSec === s ? C.selected : 'transparent' }}>
                  {s || 'General'}
                </div>
              ))}
            </div>
          )}
          <table style={{ flex: 1, borderCollapse: 'collapse', fontSize: 10 }}>
            <tbody>
              {(sectionMap[curSec] || []).map((p, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '4px 8px', color: C.muted, width: '55%' }}>{p.name}</td>
                  <td style={{ padding: '4px 8px', color: C.text, fontFamily: 'monospace' }}>{p.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (!model) return null;
  const { params, dynTree, modArgs } = model;

  const strippedValues = {};
  for (const [iKey, val] of Object.entries(values)) {
    const sk = iKey.replace(/_M-\d+_MI-\d+/g, '');
    if (!(sk in strippedValues)) strippedValues[sk] = val;
  }

  const getDefault = (prKey) => params[prKey]?.defaultValue ?? '';
  const getVal = (prKey) => strippedValues[prKey] ?? getDefault(prKey);
  const activeParams = evalDynTree(dynTree, modArgs, getVal, params);

  const sections = [];  // keys: "group\0section" composite (section is stripped of leading spaces)
  const secMap = {};
  const secGroupMap  = {};  // key → groupLabel
  const secIndentMap = {};  // key → leading-space indent count (from ETS Text convention)
  const secLabelMap  = {};  // key → display label (stripped)

  function addItem(secLabel, instanceKey, prKey, args) {
    if (!params[prKey] || !activeParams.has(prKey)) return;
    const meta = params[prKey];
    const grpTpl = meta.group || '';
    const grp = grpTpl ? (interpTpl(grpTpl, args) || grpTpl) : '';
    // ETS encodes hierarchy via leading spaces in ParameterBlock Text (stripped by parser, but
    // indent count stored separately as sectionIndent).
    const indent = meta.sectionIndent || 0;
    // Composite key: group\0section — prevents collisions between same-named sections in different groups
    const key = `${grp}\0${secLabel}`;
    if (!secMap[key]) {
      secMap[key] = [];
      sections.push(key);
      secGroupMap[key]  = grp;
      secIndentMap[key] = indent;
      secLabelMap[key]  = secLabel;
    }
    if (!secMap[key].some(x => x.instanceKey === instanceKey)) {
      secMap[key].push({
        instanceKey, prKey,
        label: interpTpl(meta.label, args) || meta.label,
        typeKind: meta.typeKind, enums: meta.enums, min: meta.min, max: meta.max, step: meta.step,
        uiHint: meta.uiHint || '', unit: meta.unit || '',
        defaultValue: meta.defaultValue, readOnly: meta.readOnly,
      });
    }
  }

  function walkNode(node, secLabel, args, mkPrefix) {
    if (!node) return;
    for (const prKey of node.paramRefs || []) {
      const instanceKey = mkPrefix ? mkPrefix + prKey.replace(/^[^_]*_/, '_') : prKey;
      const meta = params[prKey];
      const sec = interpTpl(meta?.section || '', args) || secLabel || '';
      addItem(sec, instanceKey, prKey, args);
    }
    for (const b of node.blocks || []) walkNode(b, secLabel, args, mkPrefix);
    for (const choice of node.choices || []) evalChoice(choice, secLabel, args, mkPrefix);
  }

  function evalChoice(choice, secLabel, args, mkPrefix) {
    const raw = getVal(choice.paramRefId);
    const val = String(raw !== '' && raw != null ? raw : (choice.defaultValue ?? ''));
    let matched = false, defNode = null;
    for (const w of choice.whens || []) {
      if (w.isDefault) { defNode = w.node; continue; }
      if (etsTestMatch(val, w.test)) { matched = true; walkNode(w.node, secLabel, args, mkPrefix); }
    }
    if (!matched && defNode) walkNode(defNode, secLabel, args, mkPrefix);
  }

  function walkDynSection(section, args, mkPrefix) {
    if (!section) return;
    for (const ch of section.channels || []) walkNode(ch.node, interpTpl(ch.label, args) || ch.label, args, mkPrefix);
    for (const ci of section.cib || []) walkNode(ci, '', args, mkPrefix);
    for (const pb of section.pb || []) walkNode(pb, '', args, mkPrefix);
    for (const choice of section.choices || []) evalChoice(choice, '', args, mkPrefix);
  }

  walkDynSection(dynTree?.main, {}, null);

  for (const md of dynTree?.moduleDefs || []) {
    const defId = md.id;
    const moduleKeys = Object.keys(modArgs || {}).filter(k => k.startsWith(defId + '_M-'));
    for (const mk of moduleKeys) {
      const args = modArgs[mk] || {};
      const mkPrefix = mk + '_MI-1';
      walkDynSection(md, args, mkPrefix);
    }
  }

  const curSec = (activeSection !== null && sections.includes(activeSection)) ? activeSection : (sections[0] ?? '');

  // Format a raw numeric value as hh:mm:ss (or hh:mm:ss.fff) for TypeTime display.
  const fmtDuration = (raw, unit, uiHint) => {
    const n = Number(raw);
    if (isNaN(n)) return String(raw);
    const pad2 = x => String(x).padStart(2, '0');
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
  const parseDuration = (text, unit) => {
    const parts = text.trim().split(':');
    if (parts.length < 3) return null;
    const h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    const sfff = parts[2].split('.');
    const s = parseInt(sfff[0]) || 0;
    const ms = sfff[1] ? Math.round(parseInt(sfff[1].padEnd(3,'0').slice(0,3))) : 0;
    const totalMs = (h * 3600 + m * 60 + s) * 1000 + ms;
    return unit === 'Milliseconds' ? totalMs : Math.round(totalMs / 1000);
  };

  const renderInput = (item) => {
    const rawVal = values[item.instanceKey] ?? item.defaultValue ?? '';
    const isDuration = item.typeKind === 'time' && item.uiHint?.startsWith('Duration_hh');

    if (item.readOnly || mode === 'view') {
      let display;
      if (item.typeKind === 'enum') display = item.enums?.[rawVal] ?? rawVal;
      else if (item.typeKind === 'checkbox') display = String(rawVal) === '1' ? '✓' : '✗';
      else if (isDuration) display = fmtDuration(rawVal, item.unit, item.uiHint);
      else display = rawVal;
      return <span style={{ color: C.muted, fontFamily: 'monospace', fontSize: 10 }}>{display}</span>;
    }
    if (item.typeKind === 'checkbox') {
      return (
        <input type="checkbox" checked={String(rawVal) === '1'}
          onChange={e => handleChange(item.instanceKey, e.target.checked ? '1' : '0')}
          style={{ accentColor: C.accent, cursor: 'pointer', margin: 0, width: 14, height: 14 }} />
      );
    }
    if (item.typeKind === 'enum') {
      const entries = Object.entries(item.enums || {});
      if (entries.length === 2) {
        return (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            {entries.map(([v, l]) => (
              <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 10, color: C.text, userSelect: 'none' }}>
                <input type="radio" name={item.instanceKey} value={v}
                  checked={String(rawVal) === String(v)}
                  onChange={() => handleChange(item.instanceKey, v)}
                  style={{ accentColor: C.accent, cursor: 'pointer', margin: 0 }} />
                {l}
              </label>
            ))}
          </div>
        );
      }
      return (
        <select value={rawVal} onChange={e => handleChange(item.instanceKey, e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 3, padding: '2px 4px', color: C.text, fontSize: 10, fontFamily: 'inherit', maxWidth: 180 }}>
          {entries.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      );
    }
    if (item.typeKind === 'number') {
      return (
        <input type="number" value={rawVal}
          min={item.min ?? undefined} max={item.max ?? undefined} step={item.step ?? 1}
          onChange={e => handleChange(item.instanceKey, e.target.value)}
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 3, padding: '2px 6px', color: C.text, fontSize: 10, fontFamily: 'monospace', width: 80 }} />
      );
    }
    if (isDuration) {
      return (
        <input type="text" value={fmtDuration(rawVal, item.unit, item.uiHint)}
          onChange={e => {
            const parsed = parseDuration(e.target.value, item.unit);
            if (parsed !== null) handleChange(item.instanceKey, String(parsed));
          }}
          placeholder="hh:mm:ss"
          style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 3, padding: '2px 6px', color: C.text, fontSize: 10, fontFamily: 'monospace', width: 90 }} />
      );
    }
    const textWidth = item.typeKind === 'text' ? 220 : 140;
    return (
      <input type="text" value={rawVal} onChange={e => handleChange(item.instanceKey, e.target.value)}
        style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 3, padding: '2px 6px', color: C.text, fontSize: 10, fontFamily: 'monospace', width: textWidth }} />
    );
  };

  return (
    <div style={{ marginTop: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: C.dim, letterSpacing: '0.08em' }}>PARAMETERS</div>
        {mode === 'view'
          ? <button onClick={() => setMode('edit')}
              style={{ fontSize: 9, background: 'none', border: `1px solid ${C.accent}`, borderRadius: 3, padding: '1px 6px', color: C.accent, cursor: 'pointer' }}>
              Edit
            </button>
          : <>
              <button onClick={() => setMode('view')}
                style={{ fontSize: 9, background: 'none', border: `1px solid ${C.border2}`, borderRadius: 3, padding: '1px 6px', color: C.muted, cursor: 'pointer' }}>
                View
              </button>
              {dirty && (
                <button onClick={handleSave} disabled={saving}
                  style={{ fontSize: 9, background: C.accent, border: 'none', borderRadius: 3, padding: '1px 8px', color: '#fff', cursor: 'pointer' }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              {saveErr && <span style={{ fontSize: 9, color: C.red }}>{saveErr}</span>}
            </>
        }
      </div>
      {sections.length === 0
        ? <div style={{ color: C.dim, fontSize: 10 }}>No visible parameters</div>
        : <div style={{ display: 'flex', gap: 0 }}>
            {sections.length > 1 && (
              <div style={{ minWidth: 120, borderRight: `1px solid ${C.border}`, marginRight: 12, flexShrink: 0 }}>
                {(() => {
                  const items = [];
                  let lastGroup = null;
                  for (const key of sections) {
                    const grp    = secGroupMap[key]  || '';
                    const indent = secIndentMap[key] || 0;
                    const lbl    = secLabelMap[key]  || key || 'General';
                    // paddingLeft: extra depth when ETS uses leading spaces (4 spaces per level)
                    const paddingLeft = indent > 0 ? 26 : grp ? 18 : 10;
                    if (grp !== lastGroup) {
                      lastGroup = grp;
                      if (grp) items.push(
                        <div key={'grp:' + grp} style={{ padding: '5px 10px 2px', fontSize: 9, color: C.dim, userSelect: 'none', whiteSpace: 'nowrap', letterSpacing: '0.05em', textTransform: 'uppercase', borderLeft: '2px solid transparent' }}>
                          {grp}
                        </div>
                      );
                    }
                    items.push(
                      <div key={key} onClick={() => setActiveSection(key)}
                        style={{ padding: `4px 10px 4px ${paddingLeft}px`, cursor: 'pointer', fontSize: 10, userSelect: 'none', whiteSpace: 'nowrap',
                          color: curSec === key ? C.accent : C.muted,
                          borderLeft: `2px solid ${curSec === key ? C.accent : 'transparent'}`,
                          background: curSec === key ? C.selected : 'transparent' }}>
                        {lbl}
                      </div>
                    );
                  }
                  return items;
                })()}
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <tbody>
                {(secMap[curSec] || []).map((item, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '4px 8px', color: C.muted, width: '50%', verticalAlign: 'middle' }}>{item.label}</td>
                    <td style={{ padding: '3px 8px', verticalAlign: 'middle' }}>{renderInput(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
      }
    </div>
  );
}
