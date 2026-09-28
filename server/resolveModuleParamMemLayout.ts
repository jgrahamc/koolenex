// ETS "Module architecture" apps declare each module-instanced Parameter's
// absolute memory offset as `Offset` (small, module-template-relative) plus
// `BaseOffset` - an <Argument> Id reference whose numeric value differs per
// module instance (e.g. 340 for one button, 360 for another). ets-app.ts's
// `buildParamModel()` captures `Offset`/`BaseOffset` (as
// `paramMemLayout[key].baseOffsetArgId`) and the per-instance argument
// values (`modArgs`), but `paramMemLayout` itself only ever has one entry
// per template ParameterRef, at the un-shifted relative offset - never one
// per device instance, so unrelated ModuleDefs' parameters can collide on
// the same address.
//
// This module expands a template `paramMemLayout` into a per-device-correct
// one, using the device's own active module instances (resolved via
// `evalConditionallyActiveModuleInstances`, routes/knx-tables.ts - the same
// `<choose ParamRefId="..."><when test="N"><Module .../></when>...` decision
// point ETS itself uses, not a downstream symptom of activation like
// ComObjectInstanceRef/ParameterInstanceRef presence, which cannot
// distinguish "active, left at default" from "never used" for a module that
// owns no comm-object of its own).
//
// A `<choose>` inside a ModuleDef's own Dynamic section has its selector
// resolved PER REAL INSTANCE, not once device-globally - otherwise every
// instance's Union content resolves to the same template-default
// alternative even when each instance's own override genuinely differs.

import {
  evalConditionallyActiveModuleInstances,
  evalConditionallyActiveParamRefs,
  buildUnconditionalChannelSet,
  type DynTree,
  type ParamDef,
} from './routes/knx-tables.ts';

export interface ModuleAwareParamMemLayoutEntry {
  offset: number | null;
  bitOffset: number;
  baseOffsetArgId?: string;
  fromMemoryChild?: boolean;
  isVisible?: boolean;
  [key: string]: unknown;
}

/**
 * Expand `paramMemLayout` (template-level, one entry per ParameterRef) into
 * a per-device-correct copy: module-instanced parameters get one entry per
 * active instance, keyed at the same fully-qualified id
 * (`..._MD-x_M-y_MI-z_P-p_R-r`) real per-device parameter overrides already
 * use, with the correctly resolved absolute offset. Non-module parameters
 * pass through unchanged - this can only add entries for a
 * module-architecture app, never remove or alter an existing one.
 */
export function expandParamMemLayoutForActiveModules<
  T extends ModuleAwareParamMemLayoutEntry,
>(
  paramMemLayout: Record<string, T>,
  /**
   * ParamModel.baseValueArgIds - paramId (a choose selector's own
   * Parameter, e.g. "{appId}_MD-22_P-4" - a ParameterRef key with its
   * trailing "_R-<n>" stripped) -> that Parameter's own `BaseValue`
   * Argument id. See ParamDef.baseValueArgId's own doc comment (ets-app.ts)
   * for what it means.
   */
  baseValueArgIds: Record<string, string>,
  argDefs: Record<string, string>,
  modArgs: Record<string, Record<string, string | number>>,
  dynTree: DynTree | null | undefined,
  paramsForDefaults: Record<string, ParamDef>,
  currentValues: Record<string, unknown>,
): Record<string, T> {
  // Fast path: nothing in this app is module-instanced (every
  // non-module-architecture app) - return the original object untouched,
  // zero behavior change, zero extra work.
  const hasModuleEntries = Object.values(paramMemLayout).some(
    (info) => !!info.baseOffsetArgId,
  );
  if (!hasModuleEntries) return paramMemLayout;

  const activeModules = evalConditionallyActiveModuleInstances(
    dynTree,
    paramsForDefaults,
    currentValues,
  );
  // Instance-independent (doesn't touch currentValues) - computed once,
  // reused for every real instance.
  const unconditionalChannel = buildUnconditionalChannelSet(dynTree);

  // Per-instance - see this file's own header
  // comment. Cached per real instance (modKey), not recomputed per
  // parameter - this function is otherwise O(params x instances) already.
  const conditionallyActiveByInstance = new Map<string, Set<string>>();
  const conditionallyActiveFor = (
    appId: string,
    mdShort: string,
    mYPart: string,
    mi: string,
  ): Set<string> => {
    const cacheKey = `${appId}_${mdShort}_${mYPart}_MI-${mi}`;
    let set = conditionallyActiveByInstance.get(cacheKey);
    if (!set) {
      const prefix = `${appId}_${mdShort}_`;
      const qualify = (templateKey: string): string =>
        templateKey.startsWith(prefix)
          ? `${cacheKey}_${templateKey.slice(prefix.length)}`
          : templateKey;
      // See ParamDef.baseValueArgId's own doc comment (ets-app.ts). A
      // choose selector's own underlying Parameter Id is its ParameterRef
      // key with the trailing "_R-<n>" stripped - the same convention
      // every other id-derivation in this project relies on (confirmed
      // real: "..._MD-22_P-4_R-5" -> "..._MD-22_P-4").
      const modKey = `${appId}_${mdShort}_${mYPart}`;
      const resolveBaseValue = (templateKey: string): string | undefined => {
        const paramIdMatch = templateKey.match(/^(.*)_R-\d+$/);
        if (!paramIdMatch) return undefined;
        const baseValueArgId = baseValueArgIds[paramIdMatch[1]!];
        if (!baseValueArgId) return undefined;
        const argName = argDefs[baseValueArgId];
        if (!argName) return undefined;
        const resolvedArg = modArgs[modKey]?.[argName];
        return resolvedArg !== undefined ? String(resolvedArg) : undefined;
      };
      set = evalConditionallyActiveParamRefs(
        dynTree,
        paramsForDefaults,
        currentValues,
        undefined,
        qualify,
        resolveBaseValue,
      );
      conditionallyActiveByInstance.set(cacheKey, set);
    }
    return set;
  };

  // Every `MI-\d+` value observed in real ETS-exported project data has
  // been "1", with no exceptions - used only as a fallback when no
  // per-device override reveals an instance's actual MI. Self-correcting
  // if that's ever wrong for a specific device: if `currentValues` already
  // contains a key matching this instance's own qualified prefix with a
  // real MI, that value is used instead.
  const resolveMi = (
    appId: string,
    mdShort: string,
    mYPart: string,
  ): string => {
    const miPrefix = `${appId}_${mdShort}_${mYPart}_MI-`;
    for (const cvKey of Object.keys(currentValues)) {
      if (!cvKey.startsWith(miPrefix)) continue;
      const miMatch = cvKey.slice(miPrefix.length).match(/^(\d+)_/);
      if (miMatch) return miMatch[1]!;
    }
    return '1';
  };

  const result: Record<string, T> = {};
  for (const [prId, info] of Object.entries(paramMemLayout)) {
    if (!info.baseOffsetArgId) {
      // Non-module parameter - unchanged.
      result[prId] = info;
      continue;
    }
    const argName = argDefs[info.baseOffsetArgId];
    // Template's own MD-x, extracted from the template ParameterRef's own
    // key (e.g. "{appId}_MD-3_P-5_R-5" -> "MD-3") - the App-wide,
    // un-instanced grouping every active instance of this ModuleDef
    // shares, regardless of which specific instance (M-y) fires for this
    // device. "P-" for a plain Parameter, "UP-" for a Union member -
    // matched generically rather than as a fixed P-only allowlist.
    const mdMatch = prId.match(/^(.*)_(MD-\d+)_[A-Za-z]+-\d+_R-\d+$/);
    if (!argName || !mdMatch) continue; // no BaseOffset resolution possible - drop, don't guess
    const [, appId, mdShort] = mdMatch;
    const prSuffix = prId.slice(`${appId}_${mdShort}_`.length); // "P-5_R-5"
    for (const modKey of Object.keys(modArgs)) {
      // modKey shape: "{appId}_MD-x_M-y" - only instances of THIS ModuleDef.
      if (!modKey.startsWith(`${appId}_${mdShort}_M-`)) continue;
      if (!activeModules.has(modKey)) continue; // declared in the App, but not active on this device
      const resolvedArg = modArgs[modKey]![argName];
      if (resolvedArg === undefined) continue;
      const resolvedOffset =
        (info.offset ?? 0) + (parseInt(String(resolvedArg), 10) || 0);
      const mYPart = modKey.slice(`${appId}_${mdShort}_`.length); // "M-44"
      const mi = resolveMi(appId!, mdShort!, mYPart);
      const qualifiedKey = `${appId}_${mdShort}_${mYPart}_MI-${mi}_${prSuffix}`;
      // Same conditional-Union gate the non-module path already applies -
      // a module parameter that's a hidden Union alternate (fromMemoryChild)
      // only gets written when actually active/overridden, same as any
      // other parameter.
      if (info.fromMemoryChild) {
        const hiddenOverridden =
          !info.isVisible && qualifiedKey in currentValues;
        const unconditional = unconditionalChannel.has(prId);
        const isCondActive = conditionallyActiveFor(
          appId!,
          mdShort!,
          mYPart,
          mi,
        ).has(prId);
        if (!hiddenOverridden && !unconditional && !isCondActive) continue;
      }
      result[qualifiedKey] = {
        ...info,
        offset: resolvedOffset,
        fromMemoryChild: false,
      };
    }
  }
  return result;
}
