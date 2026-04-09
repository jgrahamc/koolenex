/**
 * ETS application program index builder.
 *
 * Parses M-XXXX_A-*.xml files to build per-application indexes for:
 *   - ComObject resolution (ComObjectRef → name, DPT, flags)
 *   - Parameter resolution (ParameterRef → section, name, display value)
 *   - Dynamic tree evaluation (choose/when condition walking)
 *   - Parameter model extraction (for download engine)
 *   - Load procedure parsing
 */

import { logger } from './log.ts';
import {
  xmlParser,
  orderedXmlParser,
  toArr,
  attr,
  interpolate,
  ordAttr,
  ordRawAttr,
  ordTagName,
  ordChildNodes,
  type XmlNode,
  type OrdXmlNode,
} from './ets-parser.ts';

// ─── Internal lookup map value types ─────────────────────────────────────────
interface CoDef {
  num: number;
  text: string;
  ft: string;
  dpt: string;
  size: string;
  read: string;
  write: string;
  comm: string;
  tx: string;
}

interface CorDef {
  refId: string;
  text: string | null;
  ft: string | null;
  dpt: string | null;
  size: string | null;
  read: string | null;
  write: string | null;
  comm: string | null;
  tx: string | null;
}

interface ParamType {
  kind: string;
  enums: Record<string, string>;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  sizeInBit?: number;
  coefficient?: number;
  unit?: string;
  uiHint?: string;
}

interface ParamDef {
  text: string;
  typeRef: string;
  value: string;
  access: string | null;
  offset: number | null;
  bitOffset: number;
  fromMemoryChild: boolean;
  isDefaultUnionParam: boolean;
}

interface ParamRefDef {
  paramId: string;
  text: string | null;
  access: string | null;
  prDefault: string | null;
}

export interface HwInfo {
  manufacturer: string;
  model: string;
  orderNumber: string;
  hwSerial: string;
  busCurrent: number;
  widthMm: number;
  isPowerSupply: boolean;
  isCoupler: boolean;
  isRailMounted: boolean;
  modelTranslations?: Record<string, string> | null;
}

// ─── Dynamic tree serialized item types ──────────────────────────────────────
interface DynItemParamRef {
  type: 'paramRef';
  refId: string;
  cell?: string;
}
interface DynItemSeparator {
  type: 'separator';
  id: string;
  text: string;
  uiHint: string;
}
interface DynItemBlock {
  type: 'block';
  id: string;
  text: string;
  name: string;
  inline: boolean;
  access?: string;
  layout?: string;
  rows?: { id: string; text: string }[];
  columns?: { id: string; text: string; width?: string }[];
  items: DynItem[];
}
interface DynItemChoose {
  type: 'choose';
  paramRefId: string;
  accessNone: boolean;
  defaultValue: string | null;
  whens: DynWhen[];
}
interface DynWhen {
  test: string[];
  isDefault: boolean;
  items: DynItem[];
}
interface DynItemRename {
  type: 'rename';
  refId: string;
  text: string;
}
interface DynItemAssign {
  type: 'assign';
  target: string;
  source: string | null;
  value: string | null;
}
interface DynItemComRef {
  type: 'comRef';
  refId: string;
}
interface DynItemChannel {
  type: 'channel';
  id: string;
  label: string;
  textParamRefId?: string;
  items: DynItem[];
}
interface DynItemCib {
  type: 'cib';
  items: DynItem[];
}
export type DynItem =
  | DynItemParamRef
  | DynItemSeparator
  | DynItemBlock
  | DynItemChoose
  | DynItemRename
  | DynItemAssign
  | DynItemComRef
  | DynItemChannel
  | DynItemCib;

// ─── Load procedure step types ───────────────────────────────────────────────
interface LpRelSegment {
  type: 'RelSegment';
  lsmIdx: number;
  size: number;
  mode: string;
  fill: number;
}
interface LpWriteProp {
  type: 'WriteProp';
  objIdx: number;
  propId: number;
  data: string;
}
interface LpCompareProp {
  type: 'CompareProp';
  objIdx: number;
  propId: number;
  data: string;
}
interface LpWriteRelMem {
  type: 'WriteRelMem';
  objIdx: number;
  offset: number;
  size: number;
  mode: string;
}
interface LpLoadImageProp {
  type: 'LoadImageProp';
  objIdx: number;
  propId: number;
}
interface LpAbsSegment {
  type: 'AbsSegment';
  lsmIdx: number;
  address: number;
  size: number;
}
export type LoadProcedureStep =
  | LpRelSegment
  | LpWriteProp
  | LpCompareProp
  | LpWriteRelMem
  | LpLoadImageProp
  | LpAbsSegment;

// ─── Parameter model types ───────────────────────────────────────────────────
export interface ParamModelEntry {
  label: string;
  section: string;
  group: string;
  sectionIndent: number;
  typeKind: string;
  enums: Record<string, string>;
  min: number | null;
  max: number | null;
  step: number | null;
  uiHint: string;
  unit: string;
  defaultValue: string;
  readOnly: boolean;
  offset: number | null;
  bitOffset: number;
  bitSize: number;
}

export interface ParamMemLayoutEntry {
  offset: number;
  bitOffset: number;
  bitSize: number;
  defaultValue: string;
  isText: boolean;
  isFloat: boolean;
  fromMemoryChild: boolean;
  isVisible: boolean;
  coefficient?: number;
}

export interface ParamModel {
  appId: string;
  params: Record<string, ParamModelEntry>;
  dynTree: {
    main: { items: DynItem[] } | null;
    moduleDefs: { id: string; items: DynItem[] }[];
  };
  modArgs: Record<string, Record<string, string | number>>;
  paramMemLayout: Record<string, ParamMemLayoutEntry>;
  relSegData: Record<number, string>;
  absSegData: Record<number, { size: number; hex: string }>;
  loadProcedures?: LoadProcedureStep[];
}

// ─── AppIndex return type ───────────────────────────────────────────────────
export interface AppIndex {
  resolveCoRef: (
    relRefId: string,
    channelId: string,
  ) => {
    objectNumber: number;
    name: string;
    function_text: string;
    channel: string;
    dpt: string;
    objectSize: string;
    read: boolean;
    write: boolean;
    comm: boolean;
    tx: boolean;
  } | null;
  resolveParamRef: (
    refId: string,
    value: string,
  ) => { section: string; group: string; name: string; value: string } | null;
  evalDynamic: (getVal: (prKey: string) => string | null) => {
    activeParams: Set<string>;
    activeCorefs: Set<string>;
    activeCorefsByObjNum: Map<number, { corId: string; channel: string }[]>;
  };
  resolveCoRefById: (corId: string) => {
    objectNumber: number;
    name: string;
    function_text: string;
    dpt: string;
    objectSize: string;
    read: boolean;
    write: boolean;
    comm: boolean;
    tx: boolean;
    channel: string;
  } | null;
  buildParamModel: () => ParamModel;
  appId: string;
  paramRefKeys: string[];
  moduleKeys: string[];
  getDefault: (prKey: string) => string | null;
  getModArgs: (mk: string) => Record<string, string | number> | null;
  loadProcedures: LoadProcedureStep[];
}

// ─── Build per-application-program index ─────────────────────────────────────
export function buildAppIndex(buf: Buffer): AppIndex | null {
  const rawXml = buf.toString('utf8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let xml: any;
  try {
    xml = xmlParser.parse(rawXml);
  } catch (e: unknown) {
    logger.error('ets', 'app parse error', { error: (e as Error).message });
    return null;
  }

  const mfrNode = toArr(xml?.KNX?.ManufacturerData?.Manufacturer)[0];
  if (!mfrNode) return null;

  // ApplicationProgram may be single object (not array) even with isArray=false for it
  const apRaw = mfrNode?.ApplicationPrograms?.ApplicationProgram;
  const ap = Array.isArray(apRaw) ? apRaw[0] : apRaw;
  if (!ap) return null;

  const appId = attr(ap, 'Id');

  // Parse entire app XML with order-preserving parser to extract Dynamic sections
  // and ParameterBlock indent levels (leading spaces in Text attributes that the
  // main parser trims).
  let orderedDynamic: OrdXmlNode[] | null = null;
  const orderedModDynamics: Record<string, OrdXmlNode[]> = {};
  const pbIndentMap: Record<string, number> = {};
  try {
    const orderedXml = orderedXmlParser.parse(rawXml);

    // Walk ordered tree to collect ParameterBlock Text indent levels.
    // ETS uses leading spaces in ParameterBlock Text to encode visual hierarchy.
    // The ordered parser is configured with trimValues:false so we can count them.
    const collectPbIndents = (items: OrdXmlNode[]) => {
      if (!Array.isArray(items)) return;
      for (const el of items) {
        const tag = ordTagName(el);
        if (!tag || tag === '#text' || tag === '?xml') continue;
        if (tag === 'ParameterBlock') {
          const id = ordAttr(el, 'Id');
          const rawText = ordRawAttr(el, 'Text');
          if (id && rawText) {
            const leadingSpaces = rawText.match(/^(\s*)/)![1]!.length;
            if (leadingSpaces > 0) pbIndentMap[id] = leadingSpaces;
          }
        }
        collectPbIndents(ordChildNodes(el));
      }
    };
    collectPbIndents(orderedXml);
    // Navigate: KNX > ManufacturerData > Manufacturer > ApplicationPrograms > ApplicationProgram > Dynamic
    const findDynamic = (
      items: OrdXmlNode | OrdXmlNode[] | null,
    ): OrdXmlNode[] | null => {
      if (!items) return null;
      for (const el of Array.isArray(items) ? items : [items]) {
        const tag = ordTagName(el);
        if (tag === 'Dynamic') return ordChildNodes(el);
        // Recurse into known container elements
        for (const key of [
          'KNX',
          'ManufacturerData',
          'Manufacturer',
          'ApplicationPrograms',
          'ApplicationProgram',
        ]) {
          if (tag === key) {
            const result = findDynamic(ordChildNodes(el));
            if (result) return result;
          }
        }
      }
      return null;
    };
    orderedDynamic = findDynamic(orderedXml);

    // Find ModuleDef Dynamic sections
    const findModDefs = (items: OrdXmlNode | OrdXmlNode[] | null) => {
      if (!items) return;
      for (const el of Array.isArray(items) ? items : [items]) {
        const tag = ordTagName(el);
        if (tag === 'ModuleDef') {
          const mdId = ordAttr(el, 'Id');
          for (const child of ordChildNodes(el)) {
            if (ordTagName(child) === 'Dynamic')
              orderedModDynamics[mdId] = ordChildNodes(child);
          }
        }
        // Recurse into containers
        for (const key of [
          'KNX',
          'ManufacturerData',
          'Manufacturer',
          'ApplicationPrograms',
          'ApplicationProgram',
          'Static',
          'ModuleDefs',
        ]) {
          if (tag === key) findModDefs(ordChildNodes(el));
        }
      }
    };
    findModDefs(orderedXml);
  } catch (_) {}

  // 1. Translations: refId → { AttributeName → Text }
  //    Collect from all Language elements, English first so it wins over other languages.
  const trans: Record<string, Record<string, string>> = {};
  const collectTrans = (langs: XmlNode[]) => {
    for (const langNode of toArr(langs)) {
      for (const tu of toArr(langNode?.TranslationUnit)) {
        for (const el of toArr(tu?.TranslationElement)) {
          const refId = attr(el, 'RefId');
          if (!refId) continue;
          if (!trans[refId]) trans[refId] = {};
          for (const t of toArr(el.Translation)) {
            const attrName = attr(t, 'AttributeName');
            if (attrName && !trans[refId]![attrName])
              trans[refId]![attrName] = attr(t, 'Text');
          }
        }
      }
    }
  };
  const allLangs = toArr(mfrNode?.Languages?.Language);
  // English-speaking locales first so they take priority
  const enLangs = allLangs.filter((l: XmlNode) =>
    /^en/i.test(attr(l, 'Identifier')),
  );
  const otherLangs = allLangs.filter(
    (l: XmlNode) => !/^en/i.test(attr(l, 'Identifier')),
  );
  collectTrans(enLangs);
  collectTrans(otherLangs);

  const T = (id: string, a: string): string => trans[id]?.[a] ?? '';

  // No-op — removed pickName/pickText/DIR_RE. Text and FunctionText are stored separately.

  // 2. ComObject definitions (top-level Static + inside each ModuleDef Static)
  const coDefs: Record<string, CoDef> = {};
  const allStaticSections = [
    ap.Static,
    ...toArr(ap.ModuleDefs?.ModuleDef).map((md: XmlNode) => md.Static),
  ].filter(Boolean);

  for (const st of allStaticSections) {
    // ComObjects may be under ComObjects/ComObject OR ComObjectTable/ComObject
    const coList = [
      ...toArr(st.ComObjects?.ComObject),
      ...toArr(st.ComObjectTable?.ComObject),
    ];
    for (const co of coList) {
      const id = attr(co, 'Id');
      if (!id) continue;
      coDefs[id] = {
        num: parseInt(attr(co, 'Number'), 10) || 0,
        text: T(id, 'Text') || attr(co, 'Text') || '',
        ft: T(id, 'FunctionText') || attr(co, 'FunctionText') || '',
        dpt: attr(co, 'DatapointType'),
        size: attr(co, 'ObjectSize'),
        read: attr(co, 'ReadFlag'),
        write: attr(co, 'WriteFlag'),
        comm: attr(co, 'CommunicationFlag'),
        tx: attr(co, 'TransmitFlag'),
      };
    }
  }

  // 3. ComObjectRef definitions (same two scopes)
  const corDefs: Record<string, CorDef> = {};
  for (const st of allStaticSections) {
    for (const cor of toArr(st.ComObjectRefs?.ComObjectRef)) {
      const id = attr(cor, 'Id');
      if (!id) continue;
      corDefs[id] = {
        refId: attr(cor, 'RefId'),
        text: T(id, 'Text') || attr(cor, 'Text') || null,
        ft: T(id, 'FunctionText') || attr(cor, 'FunctionText') || null,
        dpt: attr(cor, 'DatapointType') || null,
        size: attr(cor, 'ObjectSize') || null,
        read: attr(cor, 'ReadFlag') || null,
        write: attr(cor, 'WriteFlag') || null,
        comm: attr(cor, 'CommunicationFlag') || null,
        tx: attr(cor, 'TransmitFlag') || null,
      };
    }
  }

  // 4. Argument definitions: argId → argName
  const argDefs: Record<string, string> = {};
  for (const md of toArr(ap.ModuleDefs?.ModuleDef)) {
    for (const arg of toArr(md.Arguments?.Argument))
      if (attr(arg, 'Id')) argDefs[attr(arg, 'Id')] = attr(arg, 'Name');
  }

  // 5. Module instantiations (Dynamic section): fullModId → { argName: value, _count: N }
  const modArgs: Record<string, Record<string, string | number>> = {};
  const collectMods = (mods: XmlNode[]) => {
    for (const mod of mods) {
      const mid = attr(mod, 'Id');
      if (!mid) continue;
      const args: Record<string, string | number> = {};
      for (const na of toArr(mod.NumericArg)) {
        const name = argDefs[attr(na, 'RefId')];
        if (name) args[name] = attr(na, 'Value');
      }
      const count = parseInt(attr(mod, 'Count'), 10) || 1;
      args._count = count;
      modArgs[mid] = args;
    }
  };
  collectMods(toArr(ap.Dynamic?.Module));
  for (const md of toArr(ap.ModuleDefs?.ModuleDef))
    collectMods(toArr(md.Dynamic?.Module));

  // 6. Channel definitions: fullChanId → text template
  const chanDefs: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ch of toArr(ap.ModuleDefs?.ModuleDef).flatMap((md: any) =>
    toArr(md.Dynamic?.Channel),
  )) {
    const id = attr(ch, 'Id');
    if (id)
      chanDefs[id] = T(id, 'Text') || attr(ch, 'Text') || attr(ch, 'Name');
  }
  // Top-level Dynamic channels
  for (const ch of toArr(ap.Dynamic?.Channel)) {
    const id = attr(ch, 'Id');
    if (id)
      chanDefs[id] = T(id, 'Text') || attr(ch, 'Text') || attr(ch, 'Name');
  }
  // Static channel definitions (Static/Channels/Channel)
  for (const st of allStaticSections) {
    for (const ch of toArr(st.Channels?.Channel)) {
      const id = attr(ch, 'Id');
      if (id)
        chanDefs[id] = T(id, 'Text') || attr(ch, 'Text') || attr(ch, 'Name');
    }
  }

  /**
   * Resolve a ComObjectInstanceRef.RefId + ChannelId from 0.xml.
   *
   * RefId pattern:    "MD-{x}_M-{y}_MI-{z}_O-{a}-{b}_R-{c}"
   * ChannelId pattern:"MD-{x}_M-{y}_MI-{z}_CH-{argName}"
   *
   * Returns { name, channel, dpt, objectSize, read, write, comm, tx }
   * or null if unresolvable.
   */
  function resolveCoRef(relRefId: string, channelId: string) {
    const buildResult = (
      cor: CorDef,
      co: CoDef,
      args: Record<string, string | number>,
      channel: string,
    ) => ({
      objectNumber: co.num,
      name: interpolate(cor.text || co.text, args),
      function_text: interpolate(cor.ft || co.ft, args),
      channel,
      dpt: cor.dpt || co.dpt || '',
      objectSize: cor.size || co.size || '',
      read: (cor.read ?? co.read) === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm: (cor.comm ?? co.comm) === 'Enabled',
      tx: (cor.tx ?? co.tx) === 'Enabled',
    });

    // Case 1: module-based "MD-{x}_M-{y}_MI-{z}_O-{a}-{b}_R-{c}"
    const m1 = relRefId.match(/^(MD-\d+)_M-(\d+)_MI-\d+_(O-[\d-]+_R-\d+)$/);
    if (m1) {
      const [, mdPart, mNum, orPart] = m1;
      const cor = corDefs[`${appId}_${mdPart}_${orPart}`];
      if (!cor) return null;
      const co = coDefs[cor.refId];
      if (!co) return null;
      const args = modArgs[`${appId}_${mdPart}_M-${mNum}`] || {};
      let channel = '';
      if (channelId) {
        const cm = channelId.match(/^(MD-\d+)_M-\d+_MI-\d+_(CH-\w+)$/);
        if (cm)
          channel = interpolate(
            chanDefs[`${appId}_${cm[1]}_${cm[2]}`] || '',
            args,
          );
        else
          channel =
            interpolate(chanDefs[`${appId}_${channelId}`] || '', args) ||
            chanDefs[channelId] ||
            channelId;
      }
      return buildResult(cor, co, args, channel);
    }

    // Case 2: flat "O-{a}[-{b}]_R-{c}" (no module prefix)
    const m2 = relRefId.match(/^(O-[\d-]+_R-\d+)$/);
    if (m2) {
      const cor = corDefs[`${appId}_${m2[1]}`];
      if (!cor) return null;
      const co = coDefs[cor.refId];
      if (!co) return null;
      const ch = channelId
        ? interpolate(chanDefs[`${appId}_${channelId}`] || '', {}) ||
          chanDefs[channelId] ||
          channelId
        : '';
      return buildResult(cor, co, {}, ch);
    }

    // Case 3: absolute ID already containing appId
    if (relRefId.startsWith(appId + '_')) {
      const cor = corDefs[relRefId];
      if (!cor) return null;
      const co = coDefs[cor.refId];
      if (!co) return null;
      return buildResult(cor, co, {}, '');
    }

    return null;
  }

  // 7. ParameterType definitions: typeId → { kind, enums }
  //    kind: 'enum' | 'number' | 'none' | 'other'
  const paramTypes: Record<string, ParamType> = {};
  for (const st of allStaticSections) {
    for (const pt of toArr(st.ParameterTypes?.ParameterType)) {
      const tid = attr(pt, 'Id');
      if (!tid) continue;
      if ('TypeNone' in pt) {
        paramTypes[tid] = { kind: 'none', enums: {} };
        continue;
      }
      if (pt.TypeNumber) {
        const tn = Array.isArray(pt.TypeNumber)
          ? pt.TypeNumber[0]
          : pt.TypeNumber;
        const uiHint = attr(tn, 'UIHint') || '';
        const coeff = attr(tn, 'Coefficient');
        paramTypes[tid] = {
          kind: uiHint === 'CheckBox' ? 'checkbox' : 'number',
          enums: {},
          min:
            attr(tn, 'minInclusive') !== ''
              ? Number(attr(tn, 'minInclusive'))
              : attr(tn, 'Minimum') !== ''
                ? Number(attr(tn, 'Minimum'))
                : null,
          max:
            attr(tn, 'maxInclusive') !== ''
              ? Number(attr(tn, 'maxInclusive'))
              : attr(tn, 'Maximum') !== ''
                ? Number(attr(tn, 'Maximum'))
                : null,
          step: attr(tn, 'Step') !== '' ? Number(attr(tn, 'Step')) : null,
          sizeInBit: parseInt(attr(tn, 'SizeInBit'), 10) || 8,
          ...(coeff ? { coefficient: parseFloat(coeff) } : {}),
          uiHint,
        };
        continue;
      }
      if (pt.TypeFloat) {
        const tf = Array.isArray(pt.TypeFloat) ? pt.TypeFloat[0] : pt.TypeFloat;
        const coeff = attr(tf, 'Coefficient');
        paramTypes[tid] = {
          kind: 'float',
          enums: {},
          min:
            attr(tf, 'minInclusive') !== ''
              ? Number(attr(tf, 'minInclusive'))
              : attr(tf, 'Minimum') !== ''
                ? Number(attr(tf, 'Minimum'))
                : null,
          max:
            attr(tf, 'maxInclusive') !== ''
              ? Number(attr(tf, 'maxInclusive'))
              : attr(tf, 'Maximum') !== ''
                ? Number(attr(tf, 'Maximum'))
                : null,
          step: null,
          sizeInBit: parseInt(attr(tf, 'SizeInBit'), 10) || 16,
          ...(coeff ? { coefficient: parseFloat(coeff) } : {}),
        };
        continue;
      }
      if (pt.TypeTime) {
        const tt = Array.isArray(pt.TypeTime) ? pt.TypeTime[0] : pt.TypeTime;
        const uiHint = attr(tt, 'UIHint') || '';
        paramTypes[tid] = {
          kind: 'time',
          enums: {},
          min:
            attr(tt, 'minInclusive') !== ''
              ? Number(attr(tt, 'minInclusive'))
              : null,
          max:
            attr(tt, 'maxInclusive') !== ''
              ? Number(attr(tt, 'maxInclusive'))
              : null,
          step: null,
          sizeInBit: parseInt(attr(tt, 'SizeInBit'), 10) || 16,
          unit: attr(tt, 'Unit') || '',
          uiHint,
        };
        continue;
      }
      if (pt.TypeText) {
        const tt = Array.isArray(pt.TypeText) ? pt.TypeText[0] : pt.TypeText;
        paramTypes[tid] = {
          kind: 'text',
          enums: {},
          sizeInBit: parseInt(attr(tt, 'SizeInBit'), 10) || 8,
        };
        continue;
      }
      const enums: Record<string, string> = {};
      for (const e of toArr(pt.TypeRestriction?.Enumeration)) {
        const val = attr(e, 'Value');
        const txt = T(attr(e, 'Id'), 'Text') || attr(e, 'Text');
        if (val !== '' && txt) enums[val] = txt;
      }
      const trSizeInBit = parseInt(attr(pt.TypeRestriction, 'SizeInBit'), 10) || 8;
      paramTypes[tid] = {
        kind: Object.keys(enums).length ? 'enum' : 'other',
        enums,
        sizeInBit: trSizeInBit,
      };
    }
  }

  // 8. Parameter definitions: paramId → { text, typeRef }
  //    Parameters are always flat under Static/Parameters or inside Union elements.
  //    Parameter.Access is stored so ParameterRef resolution can inherit it when the ref
  //    itself has no Access override. Access="None" means download-only (not shown in ETS UI).
  const paramDefs: Record<string, ParamDef> = {};
  // baseFromMem: true when the parent Union's offset came from a <Memory> child element.
  // In that convention, all Union child params use relSeg-index offsets (not absolute ETS offsets),
  // so they must be treated identically to standalone params with <Memory> children.
  const addParam = (p: XmlNode, baseOffset = 0, baseFromMem = false) => {
    const id = attr(p, 'Id');
    if (!id) return;
    let rawOff = attr(p, 'Offset');
    let rawBitOff = attr(p, 'BitOffset');
    // Some parameters specify memory via a <Memory> child element rather than direct attributes.
    // This is the standard ETS6 encoding for parameters in <Parameters> (non-Union) sections.
    // Track the source so buildParamMem can distinguish absolute-offset params (Memory child)
    // from Union params (direct Offset="0" attribute) for relSeg blob convention detection.
    let fromMemoryChild = baseFromMem;
    if (rawOff === '') {
      const mem = Array.isArray(p.Memory) ? p.Memory[0] : p.Memory;
      if (mem) {
        rawOff = attr(mem, 'Offset');
        rawBitOff = attr(mem, 'BitOffset');
        if (rawOff !== '') fromMemoryChild = true;
      }
    }
    paramDefs[id] = {
      // Use Text attribute (display label), NOT Name (internal code identifier)
      text: T(id, 'Text') || attr(p, 'Text') || '',
      typeRef: attr(p, 'ParameterType'),
      value: attr(p, 'Value'), // factory default value
      access: attr(p, 'Access') || null,
      // Memory layout — null means not directly memory-mapped (e.g. Union child with no Offset)
      offset:
        rawOff !== ''
          ? baseOffset + (parseInt(rawOff, 10) || 0)
          : baseOffset > 0
            ? baseOffset
            : null,
      bitOffset: parseInt(rawBitOff, 10) || 0,
      fromMemoryChild: fromMemoryChild,
      // DefaultUnionParameter="0" marks the first (default-active) param in a Union —
      // its default value should be written even when not in currentValues.
      isDefaultUnionParam: attr(p, 'DefaultUnionParameter') === '0',
    };
  };
  for (const st of allStaticSections) {
    for (const p of toArr(st.Parameters?.Parameter)) addParam(p);
    for (const u of toArr(st.Parameters?.Union)) {
      // Union children share the union's byte offset; their own @Offset is relative to it.
      // The union's offset may be in a <Memory Offset="X"> child element rather than a direct attribute.
      let uOffset = parseInt(attr(u, 'Offset'), 10);
      let uFromMem = false;
      if (isNaN(uOffset) || uOffset === 0) {
        const uMem = Array.isArray(u.Memory) ? u.Memory[0] : u.Memory;
        if (uMem) {
          const memOff = parseInt(attr(uMem, 'Offset'), 10);
          if (!isNaN(memOff)) {
            uOffset = memOff;
            uFromMem = true;
          }
        }
      }
      if (isNaN(uOffset)) uOffset = 0;
      for (const p of toArr(u.Parameter)) addParam(p, uOffset, uFromMem);
    }
  }

  // 9. ParameterRef definitions: fullRefId → { paramId, text override, access override }
  //    Collected before 8b so the section-map walk can use it for label resolution.
  const paramRefDefs: Record<string, ParamRefDef> = {};
  for (const st of allStaticSections) {
    for (const pr of toArr(st.ParameterRefs?.ParameterRef)) {
      const id = attr(pr, 'Id');
      if (!id) continue;
      paramRefDefs[id] = {
        paramId: attr(pr, 'RefId'),
        // Use Text attribute (display label), NOT Name (internal code identifier like P_ZeitLang)
        text: T(id, 'Text') || attr(pr, 'Text') || null,
        access: attr(pr, 'Access') || null,
        // A non-empty Value attribute overrides the Parameter's default value for this ref.
        prDefault: attr(pr, 'Value') || null,
      };
    }
  }

  // Helper: given a ParameterBlock element, resolve the best human-readable label.
  // Priority: Translation for PB id → PB Text attr → ParamRefId→Parameter Text → PB Name
  // ABB (and others) use a "dummy" TypeNone Parameter referenced via ParamRefId to
  // carry the English section header text (e.g. "Channel A") while PB.Name holds only
  // the internal German name (e.g. "R_Kanal A").
  // pbLabel: returns { label (trimmed), indent (leading-space count from raw XML) }
  // ETS uses leading spaces in ParameterBlock Text to encode visual hierarchy.
  // fast-xml-parser trims attribute values, but pbIndentMap captures the count from raw XML.
  const pbLabel = (
    pb: XmlNode,
    fallback: string,
  ): { label: string; indent: number } => {
    const id = attr(pb, 'Id');
    const indent = pbIndentMap[id] || 0;
    let label = T(id, 'Text') || attr(pb, 'Text');
    if (!label) {
      const prId = attr(pb, 'ParamRefId');
      if (prId) {
        const pr = paramRefDefs[prId];
        if (pr)
          label =
            T(pr.paramId, 'Text') ||
            pr.text ||
            paramDefs[pr.paramId]?.text ||
            '';
      }
    }
    return { label: label || attr(pb, 'Name') || fallback || '', indent };
  };

  // 8b. Section map from Dynamic: ParameterRef fullId → section label (template)
  //     Walk Channel / ChannelIndependentBlock / ParameterBlock / choose / when hierarchy.
  //     paramRefGroupMap tracks the Channel label (parent grouping) separately from the
  //     innermost ParameterBlock label (section label), so the UI can show group headers.
  const paramRefSectionMap: Record<string, string> = {};
  const paramRefGroupMap: Record<string, string> = {};
  const paramRefSectionIndentMap: Record<string, number> = {}; // indent (leading spaces) of the PB label — encodes ETS hierarchy
  const walkDynamic = (
    items: XmlNode[],
    sectionTpl: string,
    groupLabel = '',
    sectionIndent = 0,
  ) => {
    for (const item of toArr(items)) {
      for (const rr of toArr(item.ParameterRefRef)) {
        const rid = attr(rr, 'RefId');
        if (rid && !paramRefSectionMap[rid]) {
          paramRefSectionMap[rid] = sectionTpl;
          paramRefGroupMap[rid] = groupLabel;
          paramRefSectionIndentMap[rid] = sectionIndent;
        }
      }
      for (const pb of toArr(item.ParameterBlock)) {
        const { label, indent } = pbLabel(pb, sectionTpl);
        walkDynamic([pb], label, groupLabel, indent);
      }
      for (const ch of toArr(item.choose)) {
        for (const w of toArr(ch.when))
          walkDynamic([w], sectionTpl, groupLabel, sectionIndent);
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walkDynSection = (dyn: any) => {
    if (!dyn) return;
    for (const ch of toArr(dyn.Channel)) {
      const chLabel =
        T(attr(ch, 'Id'), 'Text') || attr(ch, 'Text') || attr(ch, 'Name') || '';
      walkDynamic([ch], chLabel, chLabel, 0); // channel label = both section fallback and group
    }
    for (const cib of toArr(dyn.ChannelIndependentBlock))
      walkDynamic([cib], '', '', 0);
    for (const pb of toArr(dyn.ParameterBlock)) {
      const { label, indent } = pbLabel(pb, '');
      walkDynamic([pb], label, '', indent);
    }
    // Also recurse into top-level choose/when — some apps put Channel elements
    // inside conditional blocks (e.g. choose/when at the Dynamic root level).
    for (const ch of toArr(dyn.choose)) {
      for (const w of toArr(ch.when)) walkDynSection(w);
    }
  };
  walkDynSection(ap.Dynamic);
  for (const md of toArr(ap.ModuleDefs?.ModuleDef)) walkDynSection(md.Dynamic);

  /**
   * Resolve a ParameterInstanceRef.RefId (fully-qualified) + its value.
   *
   * ParameterInstanceRef RefIds from 0.xml are always full qualified ParameterRef Ids.
   * For module instances they embed _M-{m}_MI-{k} which must be stripped to obtain
   * the ParameterRef key as it appears in the app XML.
   *
   * Returns { section, name, value } or null.
   */
  function resolveParamRef(refId: string, value: string) {
    // Strip module instance path: _M-{m}_MI-{k}
    const prKey = refId.replace(/_M-\d+_MI-\d+/g, '');

    const pr = paramRefDefs[prKey];
    if (!pr) return null;

    const pd = paramDefs[pr.paramId];
    if (!pd) return null;

    // Effective access: ParameterRef.Access overrides Parameter.Access.
    // Access="None" means download-only — not shown in the ETS UI.
    const effectiveAccess = pr.access ?? pd.access ?? '';
    if (effectiveAccess === 'None') return null;

    // Module args for template substitution (e.g. channel number in section label)
    let args: Record<string, string | number> = {};
    const modMatch = refId.match(/_(MD-\d+)_(M-\d+)_MI-\d+_/);
    if (modMatch)
      args = modArgs[`${appId}_${modMatch[1]}_${modMatch[2]}`] || {};

    // Section label — from Dynamic map, template-substituted
    const sectionTpl = paramRefSectionMap[prKey] || '';
    const section = sectionTpl ? interpolate(sectionTpl, args) : '';
    const groupTpl = paramRefGroupMap[prKey] || '';
    const group = groupTpl ? interpolate(groupTpl, args) : '';

    // Display name — ParameterRef text override takes priority, then Parameter text
    const nameTpl = pr.text || pd.text;
    if (!nameTpl) return null;
    const name = interpolate(nameTpl, args) || nameTpl;
    if (!name || /^calc/i.test(name)) return null;

    // Display value — enum lookup for TypeRestriction, raw otherwise
    const typeInfo = pd.typeRef
      ? paramTypes[pd.typeRef] || { kind: 'other', enums: {} }
      : { kind: 'other', enums: {} };
    if (typeInfo.kind === 'none') return null; // TypeNone = UI page marker, no value
    const displayVal =
      typeInfo.kind === 'enum' && typeInfo.enums[value] !== undefined
        ? typeInfo.enums[value]
        : value;

    return { section, group, name, value: displayVal };
  }

  // Return factory default for a paramRef key (stripped, no module instance path).
  const getDefault = (prKey: string): string | null => {
    const pr = paramRefDefs[prKey];
    if (!pr) return null;
    // ParameterRef Value overrides Parameter Value
    if (pr.prDefault != null && pr.prDefault !== '') return pr.prDefault;
    const pd = paramDefs[pr.paramId];
    return pd ? pd.value : null;
  };

  const getModArgs = (mk: string): Record<string, string | number> | null =>
    modArgs[mk] || null;

  // ── Serialize ordered Dynamic tree into items arrays ──────────────────────
  function serOrderedItems(ordItems: OrdXmlNode[]): DynItem[] {
    if (!ordItems || !ordItems.length) return [];
    const result: DynItem[] = [];
    for (const el of ordItems) {
      const tag = ordTagName(el);
      if (!tag) continue;
      if (tag === 'ParameterRefRef') {
        const refId = ordAttr(el, 'RefId');
        if (refId)
          result.push({
            type: 'paramRef',
            refId,
            cell: ordAttr(el, 'Cell') || undefined,
          });
      } else if (tag === 'ParameterSeparator') {
        const id = ordAttr(el, 'Id');
        result.push({
          type: 'separator',
          id,
          text: T(id, 'Text') || ordAttr(el, 'Text'),
          uiHint: ordAttr(el, 'UIHint'),
        });
      } else if (tag === 'ParameterBlock') {
        const id = ordAttr(el, 'Id');
        const children = ordChildNodes(el);
        let rows: { id: string; text: string }[] | undefined,
          columns: { id: string; text: string; width?: string }[] | undefined;
        if (ordAttr(el, 'Layout') === 'Table') {
          rows = [];
          columns = [];
          for (const child of children) {
            const ctag = ordTagName(child);
            if (ctag === 'Rows')
              for (const r of ordChildNodes(child))
                if (ordTagName(r) === 'Row')
                  rows!.push({
                    id: ordAttr(r, 'Id'),
                    text:
                      T(ordAttr(r, 'Id'), 'Text') ||
                      ordAttr(r, 'Text') ||
                      ordAttr(r, 'Name'),
                  });
            if (ctag === 'Columns')
              for (const c of ordChildNodes(child))
                if (ordTagName(c) === 'Column')
                  columns!.push({
                    id: ordAttr(c, 'Id'),
                    text:
                      T(ordAttr(c, 'Id'), 'Text') ||
                      ordAttr(c, 'Text') ||
                      ordAttr(c, 'Name'),
                    width: ordAttr(c, 'Width') || undefined,
                  });
          }
        }
        let blockText = T(id, 'Text') || ordAttr(el, 'Text') || '';
        if (!blockText) {
          const prId = ordAttr(el, 'ParamRefId');
          if (prId) {
            const pr = paramRefDefs[prId];
            const pd = pr ? paramDefs[pr.paramId] : null;
            blockText =
              (pr ? T(pr.paramId, 'Text') : '') || pr?.text || pd?.text || '';
          }
        }
        result.push({
          type: 'block',
          id,
          text: blockText,
          name: ordAttr(el, 'Name'),
          inline: ordAttr(el, 'Inline') === 'true',
          access: ordAttr(el, 'Access') || undefined,
          layout: ordAttr(el, 'Layout') || undefined,
          rows,
          columns,
          items: serOrderedItems(children),
        });
      } else if (tag === 'choose') {
        const prId = ordAttr(el, 'ParamRefId');
        const pr = paramRefDefs[prId];
        const pd = pr ? paramDefs[pr.paramId] : null;
        const effectiveAccess = pr?.access ?? pd?.access ?? '';
        const whens: DynWhen[] = [];
        for (const w of ordChildNodes(el)) {
          if (ordTagName(w) !== 'when') continue;
          const test = (ordAttr(w, 'test') || ordAttr(w, 'Value') || '')
            .split(' ')
            .filter(Boolean);
          const isDefault = ordAttr(w, 'default') === 'true';
          whens.push({
            test,
            isDefault,
            items: serOrderedItems(ordChildNodes(w)),
          });
        }
        if (prId)
          result.push({
            type: 'choose',
            paramRefId: prId,
            accessNone: effectiveAccess === 'None',
            defaultValue: pr?.prDefault ?? pd?.value ?? null,
            whens,
          });
      } else if (tag === 'Rename') {
        result.push({
          type: 'rename',
          refId: ordAttr(el, 'RefId'),
          text: T(ordAttr(el, 'Id'), 'Text') || ordAttr(el, 'Text'),
        });
      } else if (tag === 'Assign') {
        const target = ordAttr(el, 'TargetParamRefRef');
        const source = ordAttr(el, 'SourceParamRefRef') || null;
        const value = ordAttr(el, 'Value');
        if (target && (source || value !== ''))
          result.push({
            type: 'assign',
            target,
            source,
            value: value !== '' ? value : null,
          });
      } else if (tag === 'ComObjectRefRef') {
        result.push({ type: 'comRef', refId: ordAttr(el, 'RefId') });
      } else if (tag === 'Channel') {
        const chId = ordAttr(el, 'Id');
        const textPrId = ordAttr(el, 'TextParameterRefId') || undefined;
        result.push({
          type: 'channel',
          id: chId,
          label:
            T(chId, 'Text') || ordAttr(el, 'Text') || ordAttr(el, 'Name') || '',
          textParamRefId: textPrId,
          items: serOrderedItems(ordChildNodes(el)),
        });
      } else if (tag === 'ChannelIndependentBlock') {
        result.push({ type: 'cib', items: serOrderedItems(ordChildNodes(el)) });
      }
    }
    return result;
  }

  // ── Dynamic condition evaluator ───────────────────────────────────────────
  // Walks the Dynamic choose/when tree using per-device param values.
  // Returns { activeParams: Set<prKey>, activeCorefs: Set<corId> }.
  // Uses the ordered Dynamic tree to correctly evaluate choose/when conditions
  // including operator tests (!=, <, >, etc.) and TypeNone page-marker params.
  function evalDynamic(getVal: (prKey: string) => string | null) {
    const activeParams = new Set<string>();
    const activeCorefs = new Set<string>();
    const activeCorefsByObjNum = new Map<
      number,
      { corId: string; channel: string }[]
    >(); // objectNumber → [{corId, channel}] in walk order

    function etsTestMatch(val: string, tests: string[]): boolean {
      const n = parseFloat(val);
      for (const t of tests) {
        const rm =
          typeof t === 'string' && t.match(/^(!=|=|[<>]=?)(-?\d+(?:\.\d+)?)$/);
        if (rm) {
          if (isNaN(n)) continue;
          const rv = parseFloat(rm[2]!);
          const op = rm[1];
          if (op === '<' && n < rv) return true;
          if (op === '>' && n > rv) return true;
          if (op === '<=' && n <= rv) return true;
          if (op === '>=' && n >= rv) return true;
          if (op === '=' && n === rv) return true;
          if (op === '!=' && n !== rv) return true;
        } else if (String(t) === val) return true;
      }
      return false;
    }

    function isTypeNone(prId: string): boolean {
      const pr = paramRefDefs[prId];
      if (!pr) return true; // unknown param — treat as always-evaluate
      const pd = paramDefs[pr.paramId];
      if (!pd) return true;
      const ti = paramTypes[pd.typeRef];
      return ti?.kind === 'none';
    }

    function walkItems(items: DynItem[] | null, channelLabel: string) {
      if (!items) return;
      for (const item of items) {
        if (item.type === 'paramRef') {
          if (item.refId) activeParams.add(item.refId);
        } else if (item.type === 'comRef') {
          if (item.refId) {
            activeCorefs.add(item.refId);
            const cor = corDefs[item.refId];
            const co = cor ? coDefs[cor.refId] : null;
            if (co) {
              if (!activeCorefsByObjNum.has(co.num))
                activeCorefsByObjNum.set(co.num, []);
              // Interpolate channel label templates (e.g. {{0: Shutter Actuator A+B}})
              let ch = channelLabel || '';
              if (ch && ch.includes('{{')) {
                const mdMatch = item.refId.match(/_(MD-\w+)_(M-\d+)_/);
                ch = interpolate(
                  ch,
                  mdMatch
                    ? modArgs[`${appId}_${mdMatch[1]}_${mdMatch[2]}`] || {}
                    : {},
                );
              }
              activeCorefsByObjNum
                .get(co.num)!
                .push({ corId: item.refId, channel: ch });
            }
          }
        } else if (item.type === 'channel') {
          walkItems(item.items, item.label || channelLabel);
        } else if (item.type === 'block' || item.type === 'cib') {
          walkItems(item.items, channelLabel);
        } else if (item.type === 'choose') {
          // Skip if controlling param is known visible but not active (prevents phantom COs)
          if (
            item.paramRefId &&
            !item.accessNone &&
            !isTypeNone(item.paramRefId) &&
            !activeParams.has(item.paramRefId)
          )
            continue;
          const raw = getVal(item.paramRefId);
          const val = String(
            raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
          );
          let matched = false,
            defItems: DynItem[] | null = null;
          for (const w of item.whens || []) {
            if (w.isDefault) {
              defItems = w.items;
              continue;
            }
            if (etsTestMatch(val, w.test)) {
              matched = true;
              walkItems(w.items, channelLabel);
            }
          }
          if (!matched && defItems) walkItems(defItems, channelLabel);
        }
      }
    }

    const mainItems = orderedDynamic ? serOrderedItems(orderedDynamic) : null;
    const modItemsList = Object.entries(orderedModDynamics)
      .map(([_id, od]) => (od ? serOrderedItems(od) : null))
      .filter(Boolean) as DynItem[][];
    // Pass 1: evaluate conditions to collect active params, but don't collect corefs yet
    function walkPass1(items: DynItem[] | null) {
      if (!items) return;
      for (const item of items) {
        if (item.type === 'paramRef') {
          if (item.refId) activeParams.add(item.refId);
        } else if (item.type === 'comRef') {
          /* skip — collected in pass 2 */
        } else if (
          item.type === 'block' ||
          item.type === 'channel' ||
          item.type === 'cib'
        ) {
          walkPass1(item.items);
        } else if (item.type === 'choose') {
          const raw = getVal(item.paramRefId);
          const val = String(
            raw !== '' && raw != null ? raw : (item.defaultValue ?? ''),
          );
          let matched = false,
            defItems: DynItem[] | null = null;
          for (const w of item.whens || []) {
            if (w.isDefault) {
              defItems = w.items;
              continue;
            }
            if (etsTestMatch(val, w.test)) {
              matched = true;
              walkPass1(w.items);
            }
          }
          if (!matched && defItems) walkPass1(defItems);
        }
      }
    }
    if (mainItems) walkPass1(mainItems);
    for (const mi of modItemsList) walkPass1(mi);

    // Pass 2: re-evaluate conditions, now skipping chooses on inactive params, collecting corefs
    if (mainItems) walkItems(mainItems, '');
    for (const mi of modItemsList) walkItems(mi, '');
    return { activeParams, activeCorefs, activeCorefsByObjNum };
  }

  // Resolve a COM object from its app-level ComObjectRef ID (no instance path).
  // Used to add active-but-unlinked COM objects to the device's object list.
  function resolveCoRefById(corId: string) {
    const cor = corDefs[corId];
    if (!cor) return null;
    const co = coDefs[cor.refId];
    if (!co) return null;
    // Try to extract module args for template substitution from corId
    const mdMatch = corId.match(/_(MD-\d+)_(M-\d+)_/);
    const args = mdMatch
      ? modArgs[`${appId}_${mdMatch[1]}_${mdMatch[2]}`] || {}
      : {};
    return {
      objectNumber: co.num,
      name: interpolate(cor.text || co.text, args),
      function_text: interpolate(cor.ft || co.ft, args),
      dpt: cor.dpt || co.dpt || '',
      objectSize: cor.size || co.size || '',
      read: (cor.read ?? co.read) === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm: (cor.comm ?? co.comm) === 'Enabled',
      tx: (cor.tx ?? co.tx) === 'Enabled',
      channel: '',
    };
  }

  function buildParamModel(): ParamModel {
    const params: Record<string, ParamModelEntry> = {};
    for (const [prKey, pr] of Object.entries(paramRefDefs)) {
      const pd = paramDefs[pr.paramId];
      if (!pd) continue;
      // Effective access: ParameterRef.Access overrides Parameter.Access.
      // Access="None" = download-only, not shown in the ETS UI.
      const effectiveAccess = pr.access ?? pd.access ?? '';
      if (effectiveAccess === 'None') continue;
      const ti = paramTypes[pd.typeRef] || { kind: 'other', enums: {} };
      if (ti.kind === 'none') continue;
      const label = pr.text || pd.text;
      if (!label) continue;
      params[prKey] = {
        label,
        section: paramRefSectionMap[prKey] || '',
        group: paramRefGroupMap[prKey] || '',
        sectionIndent: paramRefSectionIndentMap[prKey] || 0,
        typeKind: ti.kind,
        enums: ti.enums || {},
        min: ti.min ?? null,
        max: ti.max ?? null,
        step: ti.step ?? null,
        uiHint: ti.uiHint || '',
        unit: ti.unit || '',
        defaultValue: pr.prDefault ?? pd.value ?? '',
        readOnly: effectiveAccess === 'Read',
        // Memory layout for download
        offset: pd.offset ?? null,
        bitOffset: pd.bitOffset ?? 0,
        bitSize: ti.sizeInBit ?? 8,
      };
    }

    const dynTree = {
      main: orderedDynamic ? { items: serOrderedItems(orderedDynamic) } : null,
      moduleDefs: toArr(ap.ModuleDefs?.ModuleDef)
        .map((md: XmlNode) => {
          const mdId = attr(md, 'Id');
          const ordDyn = orderedModDynamics[mdId];
          return { id: mdId, items: ordDyn ? serOrderedItems(ordDyn) : [] };
        })
        .filter((m: { id: string; items: DynItem[] }) => m.items.length > 0),
    };

    // paramMemLayout: ALL paramRefs (including Access=None download-only params)
    // keyed by paramRefId → { offset, bitOffset, bitSize, defaultValue }
    // Used by the download engine to build the parameter memory segment.
    const paramMemLayout: Record<string, ParamMemLayoutEntry> = {};
    for (const [prId, pr] of Object.entries(paramRefDefs)) {
      const pd = paramDefs[pr.paramId];
      if (!pd || pd.offset === null || pd.offset === undefined) continue;
      const ti: ParamType = paramTypes[pd.typeRef] || {
        kind: 'other',
        enums: {},
      };
      // effectiveAccess: ParameterRef.Access overrides Parameter.Access.
      // Access='None' = download-only (hidden from UI). Other values = user-configurable.
      // isVisible: true for params the user can set in ETS. When a visible param is at its
      // default value, ETS may not store it explicitly in the project XML — but it still
      // programs the XML default to the device. So for visible params not in currentValues,
      // we should write the XML default rather than falling back to the relSeg factory blob.
      const effectiveAccess = pr.access ?? pd.access ?? '';
      const isVisible =
        effectiveAccess !== 'None' && ti.kind !== undefined && ti.kind !== null;
      paramMemLayout[prId] = {
        offset: pd.offset,
        bitOffset: pd.bitOffset || 0,
        bitSize: ti.sizeInBit || 8,
        defaultValue: pr.prDefault ?? pd.value ?? '',
        isText: ti.kind === 'text',
        isFloat: ti.kind === 'float',
        fromMemoryChild: pd.fromMemoryChild || false,
        isVisible,
        ...(ti.coefficient ? { coefficient: ti.coefficient } : {}),
      };
    }

    // relSegData: BASE64-decoded data blobs from Static/Code/RelativeSegment elements,
    // keyed by @LoadStateMachine (= LsmIdx). When present, this blob IS the default
    // parameter memory and should be used as the base buffer in buildParamMem instead
    // of a fill byte. Some devices (e.g. ABB/Busch-Jaeger RTC controllers) encode all
    // parameter defaults in this blob; individual Parameter.@Offset values may be 0
    // for all parameters in such devices.
    const relSegData: Record<number, string> = {};
    for (const st of allStaticSections) {
      for (const rs of toArr(st.Code?.RelativeSegment)) {
        const lsm = parseInt(attr(rs, 'LoadStateMachine'), 10);
        if (!lsm) continue;
        const rawData = typeof rs.Data === 'string' ? rs.Data : '';
        if (rawData) {
          try {
            relSegData[lsm] = Buffer.from(
              rawData.replace(/\s/g, ''),
              'base64',
            ).toString('hex');
          } catch (_) {}
        }
      }
    }

    // absSegData: BASE64-decoded data blobs from Static/Code/AbsoluteSegment elements,
    // keyed by Address (decimal string). Used for devices with ProductProcedure/absolute
    // memory addressing (e.g. Zennio, older BCU2 devices).
    const absSegData: Record<number, { size: number; hex: string }> = {};
    for (const st of allStaticSections) {
      for (const as_ of toArr(st.Code?.AbsoluteSegment)) {
        const addr = parseInt(attr(as_, 'Address'), 10);
        const size = parseInt(attr(as_, 'Size'), 10) || 0;
        if (isNaN(addr)) continue;
        const rawData = typeof as_.Data === 'string' ? as_.Data : '';
        let hex = '';
        if (rawData) {
          try {
            hex = Buffer.from(rawData.replace(/\s/g, ''), 'base64').toString(
              'hex',
            );
          } catch (_) {}
        }
        absSegData[addr] = { size, hex };
      }
    }

    return {
      appId,
      params,
      dynTree,
      modArgs,
      paramMemLayout,
      relSegData,
      absSegData,
    };
  }

  // ── LoadProcedures ────────────────────────────────────────────────────────
  // Parse the download steps from Static/LoadProcedures.
  const loadProcedures: LoadProcedureStep[] = [];
  for (const lp of toArr(ap.Static?.LoadProcedures?.LoadProcedure)) {
    for (const el of toArr(lp.LdCtrlRelSegment)) {
      const lsmIdx = parseInt(attr(el, 'LsmIdx'), 10) || 4;
      const size = parseInt(attr(el, 'Size'), 10) || 0;
      const mode = attr(el, 'AppliesTo') || 'full';
      loadProcedures.push({
        type: 'RelSegment',
        lsmIdx,
        size,
        mode,
        fill: parseInt(attr(el, 'Fill'), 10) || 0,
      });
    }
    for (const el of toArr(lp.LdCtrlWriteProp)) {
      const raw = attr(el, 'InlineData');
      const data = raw ? Buffer.from(raw.replace(/\s/g, ''), 'hex') : null;
      if (data && data.length) {
        loadProcedures.push({
          type: 'WriteProp',
          objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
          propId: parseInt(attr(el, 'PropId'), 10) || 0,
          data: data.toString('hex'),
        });
      }
    }
    for (const el of toArr(lp.LdCtrlCompareProp)) {
      const raw = attr(el, 'InlineData');
      const data = raw ? raw.replace(/\s/g, '') : '';
      loadProcedures.push({
        type: 'CompareProp',
        objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
        propId: parseInt(attr(el, 'PropId'), 10) || 0,
        data,
      });
    }
    for (const el of toArr(lp.LdCtrlWriteRelMem)) {
      const mode = attr(el, 'AppliesTo') || 'full';
      loadProcedures.push({
        type: 'WriteRelMem',
        objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 4,
        offset: parseInt(attr(el, 'Offset'), 10) || 0,
        size: parseInt(attr(el, 'Size'), 10) || 0,
        mode,
      });
    }
    for (const el of toArr(lp.LdCtrlLoadImageProp)) {
      loadProcedures.push({
        type: 'LoadImageProp',
        objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
        propId: parseInt(attr(el, 'PropId'), 10) || 27,
      });
    }
    for (const el of toArr(lp.LdCtrlAbsSegment)) {
      loadProcedures.push({
        type: 'AbsSegment',
        lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
        address: parseInt(attr(el, 'Address'), 10) || 0,
        size: parseInt(attr(el, 'Size'), 10) || 0,
      });
    }
  }

  return {
    resolveCoRef,
    resolveParamRef,
    evalDynamic,
    resolveCoRefById,
    buildParamModel,
    appId,
    paramRefKeys: Object.keys(paramRefDefs),
    moduleKeys: Object.keys(modArgs), // "{appId}_MD-n_M-k" — one per instantiated module
    getDefault,
    getModArgs,
    loadProcedures,
  };
}
