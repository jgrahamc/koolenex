/**
 * Builds the parameter-editing UI structure for a device: which parameters
 * are active under the app's Dynamic conditions, and how they group into
 * sections, blocks, channels and table layouts.
 *
 * Extracted from DeviceParameters.tsx on 2026-09-09. It had lived inside
 * the component as a set of closures, which meant nothing could test it -
 * so tests/params-ui*.test.ts and eval-dynamic.test.ts each carried their
 * own re-implementation of this walk ("replicate client logic") and
 * asserted section layouts against THAT. Those tests could pass while this
 * code diverged from them. Pure and dependency-free, so those tests now
 * drive the real thing.
 *
 * Returns plain data - no JSX; the component renders from it.
 */
import { etsTestMatch } from '../../../shared/ets-dyn.ts';

export interface ParamUIModel {
  params: Record<string, any>;
  dynTree?: any;
  modArgs?: Record<string, any>;
}

export interface ParamUI {
  /** Section keys, in document order. Key is `${group}\0${label}`. */
  sections: string[];
  /** Section key -> its items (parameter descriptors and separators). */
  secMap: Record<string, any[]>;
  secGroupMap: Record<string, string>;
  secIndentMap: Record<string, number>;
  secLabelMap: Record<string, string>;
  /** Section key -> `{ rows, columns }` for Table-layout blocks. */
  secTableLayouts: Record<string, any>;
  /** paramRefs reachable through the currently-active `choose` branches. */
  activeParams: Set<string>;
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

/**
 * Reads a parameter's current value, falling back to its default.
 *
 * Module instance keys (`..._M-1_MI-2`) are stripped to their base key
 * first, so a value saved against one instance answers for the parameter
 * itself - the conditions in a module's dynamic tree are written against
 * the base key.
 */
function makeGetVal(
  model: ParamUIModel,
  values: Record<string, any>,
): (prKey: string) => any {
  const strippedValues: Record<string, any> = {};
  for (const [iKey, val] of Object.entries(values)) {
    const sk = iKey.replace(/_M-\d+_MI-\d+/g, '');
    if (!(sk in strippedValues)) strippedValues[sk] = val;
  }
  const getDefault = (prKey: string) => model.params[prKey]?.defaultValue ?? '';
  return (prKey: string) => strippedValues[prKey] ?? getDefault(prKey);
}

/**
 * The parameters active under the app's current Dynamic conditions - the
 * same evaluation buildParamUI() runs, without building the UI structure.
 */
export function evalActiveParams(
  model: ParamUIModel,
  values: Record<string, any>,
): Set<string> {
  return evalDynTree(
    model.dynTree,
    model.modArgs ?? {},
    makeGetVal(model, values),
    model.params,
  );
}

/**
 * @param model   the device's param model (`GET .../param-model`)
 * @param values  current parameter values, keyed by instance key
 */
export function buildParamUI(
  model: ParamUIModel,
  values: Record<string, any>,
): ParamUI {
  const { params, dynTree } = model;
  // Defaulted here rather than at each use: `Object.keys(modArgs || {})`
  // below already made an absent modArgs a no-op, so this is the same
  // behaviour with the optionality stated once.
  const modArgs = model.modArgs ?? {};

  const getVal = makeGetVal(model, values);
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

  return {
    sections,
    secMap,
    secGroupMap,
    secIndentMap,
    secLabelMap,
    secTableLayouts,
    activeParams,
  };
}
