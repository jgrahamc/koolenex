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
import type { HardwareTypeParamDef } from './hardware-type.ts';
import { etsTestMatch } from '../shared/ets-dyn.ts';
import {
  el,
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
// Mirrors knx-tables.ts's GroupObjectFlags['priority'] - kept local rather
// than imported to avoid coupling this parser to the Object 3 write path.
type ComObjectPriority = 'low' | 'alarm' | 'high' | 'system';

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
  // Off the ComObjectRef, falling back to the base ComObject's declared
  // value (resolveCoRef()'s `cor.X ?? co.X` merge, like every other flag
  // here) - most refs don't override Update and inherit the app default.
  // `buildGroupObjectTable()` writes this value to the device, not just UI.
  update: string;
  // Object 3 (Group Object Table) needs both. Attribute vocabulary:
  // ReadOnInitFlag="Enabled"/"Disabled", Priority="Low"/"Alarm"/"High"/
  // "System" (System is unreachable from ETS's own UI, so real projects only
  // ever show Low/Alarm/High).
  readOnInit: string;
  priority: string;
  // Mirrors ParamDef's `baseOffsetArgId`, but for comm-object NUMBERS. A
  // module-instanced `<ComObject Number="0" BaseNumber="..._MD-13_A-2">`
  // declares only its small, module-template-relative `Number` - the real
  // absolute object number is `Number` plus the instance's resolved
  // `BaseNumber` Argument value (same mechanism as `BaseOffset`).
  baseNumberArgId?: string;
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
  update: string | null;
  readOnInit: string | null;
  priority: string | null;
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
  /**
   * The CodeSegment this parameter's offset is relative to, from
   * <Memory CodeSegment="..." Offset="..."/> - its own, or its <Union>'s.
   * Null when the parameter has no <Memory> element at all.
   *
   * An application program may declare several segments, each numbering
   * its own offsets from zero (e.g. a per-channel segment and a separate
   * device-level General segment both starting at offset 0) - without this,
   * two parameters in different segments collide on the same byte.
   */
  codeSegment: string | null;
  // A module-instanced Parameter's <Memory> element can carry a THIRD
  // attribute, `BaseOffset`, alongside `Offset`/`BitOffset` - an <Argument>
  // Id whose real value differs per module instance. `offset` above is only
  // the module-template-relative value; the true absolute address is
  // offset + the instance's resolved argument value. Stored as the raw
  // Argument Id (resolution needs a specific instance, not known at parse
  // time) so a per-device resolver can expand this into one entry per
  // instance. `undefined` for non-module-instanced parameters.
  baseOffsetArgId?: string;
  // Property-based placement: a <Property ObjectIndex|ObjectType="..."
  // PropertyId="..."/> child instead of <Memory>. Such a parameter has no
  // memory offset; it maps to a device property. Kept so the application's
  // hidden "hardware type" parameter (device object, PID_HARDWARE_TYPE) can be
  // found - see hardware-type.ts.
  propObjType?: number;
  propId?: number;
  // A module-instanced Parameter's own <Parameter> element can carry a
  // `BaseValue` attribute (a reference to an <Argument> Id, same shape as
  // `baseOffsetArgId`) whose real per-instance value determines which of
  // several Union alternatives is genuinely active for that instance - e.g.
  // a relative vs. an absolute range, selected per real module instance
  // rather than once device-globally. Only takes effect once a consumer
  // resolves it per instance (via a `resolveBaseValue` hook on
  // `evalConditionallyActiveParamRefs()` /
  // `resolveModuleParamMemLayout.ts`'s `conditionallyActiveFor`).
  baseValueArgId?: string;
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
  /**
   * True when the controlling parameter is declared <TypeNone/>, which has
   * no value by definition.
   *
   * A <choose> on one of those is not a decision: it is how ETS wraps a
   * block it always includes, and the `default` <when> is the branch it
   * means. M-0002_A-A001-13-63C2 has 77 of them - "General", "Channel A",
   * "_Sensor_Dimmen" and the like, all ParameterType PT-_dummy with
   * Value="".
   *
   * Without this, taking the default branch for a controller that resolves
   * to nothing is indistinguishable from taking it because we failed to
   * resolve a controller that does have a value - the first is correct by
   * declaration, the second is a guess. See
   * evalConditionallyActiveParamRefs (routes/knx-tables.ts).
   */
  controllerValueless: boolean;
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
// A <Module> instantiation element nested inside a <choose>/<Channel>
// branch - carried into dynTree so evalConditionallyActiveModuleInstances()
// (routes/knx-tables.ts) can resolve which module instances are active for
// a given device, the same way it resolves active parameters.
interface DynItemModule {
  type: 'module';
  // App-level module-instance id, "{appId}_MD-x_M-y" - matches modArgs' key
  // shape exactly (never includes a device-assigned MI-z, which is only
  // known once a specific device's data is in hand).
  modId: string;
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
  | DynItemCib
  | DynItemModule;

// ─── Load procedure step types ───────────────────────────────────────────────
// `mergeId` carries the enclosing `<LoadProcedure MergeId="N">` attribute -
// the splice point a mask version's `<Procedures>` template
// (knx-mask-procedures.ts) marks with a matching `<LdCtrlMerge MergeId="N">`.
// Absent when the `<LoadProcedure>` block has no `MergeId`.
interface LpBase {
  mergeId?: number;
}
interface LpRelSegment extends LpBase {
  type: 'RelSegment';
  lsmIdx: number;
  size: number;
  mode: string;
  fill: number;
}
interface LpWriteProp extends LpBase {
  type: 'WriteProp';
  objIdx: number;
  propId: number;
  data: string;
  // `Verify` of the load-control step, when the XML declares it explicitly:
  // false = device sends no application-layer confirmation (don't wait for
  // one), true = it does. Absent = step waits, as always.
  verifyResponse?: boolean;
  // `StartElement` of `LdCtrlWriteProp`: the property-array index the write
  // starts at (KNX property services are 1-based). Apps that split one
  // property over several writes (PID_MCB_TABLE on the parameter object is
  // declared twice, the second with StartElement="2") rely on it - dropping
  // it sends both writes to index 1, the second overwriting the first.
  // Absent when the XML has no StartElement.
  startElement?: number;
}
interface LpCompareProp extends LpBase {
  type: 'CompareProp';
  objIdx: number;
  propId: number;
  data: string;
}
interface LpWriteRelMem extends LpBase {
  type: 'WriteRelMem';
  objIdx: number;
  offset: number;
  size: number;
  mode: string;
  // `Verify="true"` off `<LdCtrlWriteRelMem>`. See downloadDevice() for why
  // the download path no longer branches on this.
  verify?: boolean;
  // `Verify` of the load-control step, when declared explicitly: false =
  // device sends no application-layer confirmation (don't wait), true = it
  // does. Absent = step waits, as always.
  verifyResponse?: boolean;
}
interface LpLoadImageProp extends LpBase {
  type: 'LoadImageProp';
  objIdx: number;
  propId: number;
  // `Count` of `LdCtrlLoadImageProp`: how many array elements the property
  // has, i.e. how many the read-back covers. Absent when not declared.
  count?: number;
}
interface LpAbsSegment extends LpBase {
  type: 'AbsSegment';
  lsmIdx: number;
  address: number;
  size: number;
  // `Access`/`MemType`/`SegType`/`SegFlags` of `<LdCtrlAbsSegment>`. The
  // segment descriptor sent to the device is derived from address and size
  // alone; SegFlags lets planDownload() detect an app whose declared flags
  // disagree with that heuristic and refuse rather than send an unvalidated
  // descriptor.
  access?: number;
  memType?: number;
  segType?: number;
  segFlags?: number;
}
interface LpConnect extends LpBase {
  type: 'Connect';
}
interface LpDisconnect extends LpBase {
  type: 'Disconnect';
}
interface LpRestart extends LpBase {
  type: 'Restart';
}
interface LpUnload extends LpBase {
  type: 'Unload';
  lsmIdx: number;
}
interface LpLoad extends LpBase {
  type: 'Load';
  lsmIdx: number;
}
interface LpTaskSegment extends LpBase {
  type: 'TaskSegment';
  lsmIdx: number;
  address: number;
}
interface LpLoadCompleted extends LpBase {
  type: 'LoadCompleted';
  lsmIdx: number;
}
// An LdCtrl* element this parser does not recognise. Kept (not dropped) so
// downloadDevice() can refuse an application that mandates a step it cannot
// perform.
interface LpUnhandled extends LpBase {
  type: 'Unhandled';
  tag: string;
}
export type LoadProcedureStep =
  | LpRelSegment
  | LpWriteProp
  | LpCompareProp
  | LpWriteRelMem
  | LpLoadImageProp
  | LpAbsSegment
  | LpConnect
  | LpDisconnect
  | LpRestart
  | LpUnload
  | LpLoad
  | LpTaskSegment
  | LpLoadCompleted
  | LpUnhandled;

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
  /**
   * Address of the AbsoluteSegment this entry's `offset` is relative to,
   * from the parameter's <Memory CodeSegment="..."/> and that segment's own
   * <AbsoluteSegment Address="..."/> declaration.
   *
   * Undefined when the parameter names no segment, names a RelativeSegment
   * (keyed by LoadStateMachine via relSegData instead), or the model
   * predates segment tracking - treat undefined as one flat parameter
   * buffer. See ParamDef.codeSegment: without this, two parameters in
   * different segments can collide on the same byte.
   */
  segmentAddress?: number;
  coefficient?: number;
  // Display metadata, derived the same way as `params` (pr.text || pd.text,
  // section/group maps, ti.enums/unit) but without the Access="None"/
  // typeKind==='none' filtering `params` applies. Lets a decoder (e.g.
  // decodeParamMem) label download-only/hidden params too.
  label?: string;
  section?: string;
  group?: string;
  unit?: string;
  enums?: Record<string, string>;
  // Mirrors ParamDef.baseOffsetArgId - carried through so a per-device
  // resolver (expandParamMemLayoutForActiveModules(), routes/knx-tables.ts)
  // can find entries needing per-module-instance offset expansion.
  baseOffsetArgId?: string;
  // The ParameterRef's own literal Value, separate from `defaultValue`
  // (always the Parameter's factory value). Real ETS writes this value only
  // when the entry is genuinely reached through the dynamic tree (directly
  // or via a matched <choose> branch); an unreached entry falls back to
  // `defaultValue` instead. `fromMemoryChild` gates which case applies.
  refValue?: string;
  // Mirrors ParamDef.isDefaultUnionParam - consulted by buildParamMem()'s
  // Union-conflict resolution (routes/knx-tables.ts) so the right sibling
  // wins instead of whichever reaches the write loop last.
  isDefaultUnionParam?: boolean;
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
  // Argument id -> Argument NAME (the same map ParamDef.baseOffsetArgId/
  // CoDef.baseNumberArgId's own Id needs to be resolved through to find the
  // matching key in a real instance's own modArgs entry). Exposed so a
  // per-device resolver (expandParamMemLayoutForActiveModules(),
  // routes/knx-tables.ts) can do that resolution without its own separate
  // parse pass.
  argDefs: Record<string, string>;
  // paramId (e.g. "{appId}_MD-22_P-4" - a ParameterRef key with its
  // trailing "_R-<n>" stripped) -> that Parameter's own `BaseValue`
  // Argument id, for the module-instanced params that have one. See
  // ParamDef.baseValueArgId's own doc comment for what it means; exposed
  // narrowly (not the whole paramDefs map) so resolveModuleParamMemLayout.ts
  // can resolve a choose selector's real per-instance value without its own
  // separate parse pass, same convention as `argDefs` above.
  baseValueArgIds: Record<string, string>;
  /**
   * The declared value of every ParameterRef, keyed by ParameterRef id -
   * ParameterRef@Value where present, otherwise Parameter@Value.
   *
   * `params` and `paramMemLayout` are both filtered (the first drops
   * Access="None"/TypeNone/unlabelled refs for the parameter editor, the
   * second drops anything with no memory offset for the download image), so
   * a <choose> can name a ParameterRef neither keeps - this map is the
   * fallback for resolving that controller's value.
   *
   * A controller that resolves to nothing here is either declared
   * <TypeNone/> (default branch is correct) or a real gap - see
   * DynItemChoose.controllerValueless.
   *
   * Absent from app models cached before this field existed; requires
   * reimport to populate.
   */
  paramRefValues: Record<string, string>;
  relSegData: Record<number, string>;
  absSegData: Record<number, { size: number; hex: string }>;
  loadProcedures?: LoadProcedureStep[];
  // Object 3 (Group Object Table) buffer size: `2 x maxComObjectNumber + 2`.
  // Deliberately the app's total declared object-number range (every
  // ComObject the app statically defines), not the per-device
  // instantiated/linked subset in com_objects - ETS pre-allocates Object 3
  // space for every com object the app could ever expose.
  groupObjectTableSize?: number;
  // SPECULATIVE, needs wider hardware confirmation: candidate signal for
  // which memory-write service (legacy A_Memory_Write vs
  // A_MemoryExtended_Write) a device's app requires, from the app's
  // `IsSecureEnabled` attribute (`<ApplicationProgram>` root element).
  // Mask `0x07B0` ("System B") alone does NOT reliably predict this - it
  // is shared by devices needing extended and devices needing legacy.
  // See docs/knx-device-write-protocol.md §4.1 for the evidence and the
  // `supportsExtendedMemoryServices`/PID_MCB_TABLE signals checked ahead of
  // this one in the resolution chain.
  isSecureEnabled?: boolean;
  // `<Static><Options LineCoupler0912NewProgrammingStyle="true"|"false">`:
  // which of a line-coupler mask's duplicate Load procedures applies. Only an
  // explicit false selects the legacy one. Undefined when not declared.
  lineCoupler0912NewProgrammingStyle?: boolean;
  // `<ApplicationProgram PeiType="...">`: "0" means the app carries no PEI
  // (Physical External Interface) program content. downloadDevice() refuses
  // any other declared value (see peiType there) - untested.
  peiType?: string;
  // The application's hidden hardware-type parameter (device object, property
  // 78) with its enumeration: what the device must report as
  // PID_HARDWARE_TYPE. See hardware-type.ts.
  hardwareTypeParams?: HardwareTypeParamDef[];
  // See AppIndex.supportsExtendedMemoryServices's own doc comment for the
  // full evidence. Checked before `isSecureEnabled` above (and before the
  // PID_MCB_TABLE check in knx-connection.ts's resolution chain) because it
  // is a literal, KNX-Association-documented boolean ("Gets a value
  // indicating whether extended memory services are supported" - ETS6 SDK,
  // `Knx.Ets.Sdk.Product.ApplicationOptions.SupportsExtendedMemoryServices`),
  // not an inferred correlate like `isSecureEnabled`.
  supportsExtendedMemoryServices?: boolean;
  // See AppIndex.parameterByteOrder's doc comment.
  parameterByteOrder?: 'LittleEndian' | 'BigEndian';
  // `<AddressTable MaxEntries="...">`, a sibling of `<AssociationTable>`/
  // `<ComObjectRefs>` under the app's `<Static>` - the app's declared GA
  // table capacity ceiling. `undefined` means "nothing declared", never "no
  // limit". A cheap, connection-free pre-flight check only - the device's
  // live-reported Association-table capacity
  // (`A_PropertyDescription_Read(ObjIdx=2, PropId=23)`, knx-connection.ts)
  // is authoritative and can diverge from this static value.
  gaTableMaxEntries?: number;
  // Same, for `<AssociationTable MaxEntries="...">`.
  assocTableMaxEntries?: number;
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
    update: boolean;
    readOnInit: boolean;
    priority: ComObjectPriority;
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
    update: boolean;
    readOnInit: boolean;
    priority: ComObjectPriority;
    channel: string;
  } | null;
  buildParamModel: () => ParamModel;
  appId: string;
  // Highest `Number` across every ComObject this app statically declares
  // (all Static sections, including module Static) - the basis for Object
  // 3's size, not the per-device linked/active subset. 0 if the app
  // declares no ComObjects.
  maxComObjectNumber: number;
  // SPECULATIVE. See ParamModel.isSecureEnabled's doc comment for the
  // evidence and what's needed before trusting this as a settled rule.
  isSecureEnabled: boolean;
  // See ParamModel.lineCoupler0912NewProgrammingStyle's doc comment.
  lineCoupler0912NewProgrammingStyle?: boolean;
  // See ParamModel.peiType's doc comment.
  peiType?: string;
  // Memory-write-service signal: literal `<Options
  // SupportsExtendedMemoryServices="true">` on the app's `<Static>` element.
  // Checked before `isSecureEnabled` and before the PID_MCB_TABLE fallback
  // (knx-connection.ts) since it's a documented ETS6 SDK property
  // (`ApplicationOptions.SupportsExtendedMemoryServices`), not an inferred
  // correlate, and needs no live bus read. See docs/knx-device-write-
  // protocol.md §4.1 for sample size and confidence.
  supportsExtendedMemoryServices: boolean;
  // `<Static><Options ParameterByteOrder="LittleEndian"/"BigEndian">` - a
  // genuine per-app declaration, read the same way as
  // `supportsExtendedMemoryServices`. `writeBits`/`readBits`
  // (routes/knx-tables.ts) use it to pack/unpack byte-aligned multi-byte
  // values. No documented ETS default when absent; falls back to
  // big-endian (docs/knx-device-write-protocol.md §6.1a).
  parameterByteOrder?: 'LittleEndian' | 'BigEndian';
  // See ParamModel.gaTableMaxEntries/assocTableMaxEntries's doc comments
  // and the live-check counterpart. `NaN` means the app XML has no
  // `<AddressTable>`/`<AssociationTable>` element - treat the same as "not
  // declared", never 0 or "no limit".
  gaTableMaxEntries: number;
  assocTableMaxEntries: number;
  paramRefKeys: string[];
  // The application's hardware-type parameter(s): device object (0), property
  // 78, with their enumerations. Empty when the application declares none.
  hardwareTypeParams: HardwareTypeParamDef[];
  moduleKeys: string[];
  getDefault: (prKey: string) => string | null;
  getModArgs: (mk: string) => Record<string, string | number> | null;
  loadProcedures: LoadProcedureStep[];
}

// Normalizes a ComObject/ComObjectRef `Priority` attribute
// ("Low"/"Alarm"/"High"/"System", or absent) to the lowercase vocabulary
// used by Object 3 code (knx-tables.ts's GroupObjectFlags). Absent/
// unrecognized defaults to 'low'.
function normalizePriority(raw: string | undefined | null): ComObjectPriority {
  switch (raw) {
    case 'Alarm':
      return 'alarm';
    case 'High':
      return 'high';
    case 'System':
      return 'system';
    case 'Low':
    default:
      return 'low';
  }
}

/**
 * The `<Dynamic>…</Dynamic>` slice of an application program, or null when
 * the program is not the simple shape this is safe for: exactly one Dynamic
 * section (so the slice is the whole of it) and no ModuleDefs (whose own
 * Dynamic sections are identified by an enclosing element the slice would
 * lose). See buildAppIndex's own comment for why this exists.
 */
function dynamicOnly(rawXml: string): string | null {
  if (rawXml.includes('<ModuleDef ') || rawXml.includes('<ModuleDefs')) {
    return null;
  }
  const open = rawXml.indexOf('<Dynamic');
  const close = rawXml.indexOf('</Dynamic>');
  if (open < 0 || close < open) return null;
  // More than one section: indexOf/lastIndexOf would span the gap between
  // them, which is not a balanced element.
  if (rawXml.lastIndexOf('</Dynamic>') !== close) return null;
  if (rawXml.indexOf('<Dynamic', open + 1) !== -1) return null;
  return rawXml.slice(open, close + '</Dynamic>'.length);
}

// ─── Build per-application-program index ─────────────────────────────────────
/**
 * The document position of every element inside an application program's
 * <LoadProcedures>, keyed `<procedure index>|<tag>|<index among that tag>`.
 *
 * The regular XML parser groups a <LoadProcedure>'s children by tag name, so
 * two steps of different kinds keep no relative order (a WriteProp declared
 * before a LoadImageProp can come out after it). The order-preserving parser
 * keeps it; this returns those positions so the steps can be put back in the
 * order the application declares them. Empty when the structure is not found.
 */
function loadProcedureDocumentOrder(rawXml: string): Map<string, number> {
  const order = new Map<string, number>();
  let ordered: OrdXmlNode[];
  try {
    ordered = orderedXmlParser.parse(rawXml) as OrdXmlNode[];
  } catch {
    return order;
  }
  const findChild = (nodes: OrdXmlNode[], tag: string): OrdXmlNode | null => {
    for (const n of nodes) if (ordTagName(n) === tag) return n;
    return null;
  };
  let nodes: OrdXmlNode[] = ordered;
  for (const tag of [
    'KNX',
    'ManufacturerData',
    'Manufacturer',
    'ApplicationPrograms',
    'ApplicationProgram',
    'Static',
    'LoadProcedures',
  ]) {
    const next = findChild(nodes, tag);
    if (!next) return order;
    nodes = ordChildNodes(next);
  }
  let position = 0;
  let procedureIndex = -1;
  for (const lp of nodes) {
    if (ordTagName(lp) !== 'LoadProcedure') continue;
    procedureIndex++;
    const perTag = new Map<string, number>();
    for (const child of ordChildNodes(lp)) {
      const tag = ordTagName(child);
      if (!tag || !tag.startsWith('LdCtrl')) continue;
      const n = perTag.get(tag) ?? 0;
      perTag.set(tag, n + 1);
      order.set(`${procedureIndex}|${tag}|${n}`, position++);
    }
  }
  return order;
}

export function buildAppIndex(buf: Buffer): AppIndex | null {
  const rawXml = buf.toString('utf8');
  let xml: XmlNode;
  try {
    xml = xmlParser.parse(rawXml) as XmlNode;
  } catch (e: unknown) {
    logger.error('ets', 'app parse error', { error: (e as Error).message });
    return null;
  }

  const mfrNode = toArr(el(el(xml.KNX).ManufacturerData).Manufacturer)[0];
  if (!mfrNode) return null;

  // ApplicationProgram may be single object (not array) even with isArray=false for it
  const apRaw = el(mfrNode?.ApplicationPrograms).ApplicationProgram;
  const ap = Array.isArray(apRaw) ? apRaw[0] : apRaw;
  if (!ap) return null;

  const appId = attr(ap, 'Id');
  // SPECULATIVE input for the memory-write-service guess - see
  // AppIndex.isSecureEnabled's doc comment.
  const isSecureEnabled = attr(ap, 'IsSecureEnabled') === 'true';
  // Absent (empty) is left undefined rather than guessed as "0".
  const peiType = attr(ap, 'PeiType') || undefined;
  const lineCouplerRaw = attr(
    el(ap.Static).Options,
    'LineCoupler0912NewProgrammingStyle',
  );
  const lineCoupler0912NewProgrammingStyle =
    lineCouplerRaw === 'true'
      ? true
      : lineCouplerRaw === 'false'
        ? false
        : undefined;
  // See AppIndex.supportsExtendedMemoryServices's doc comment. XML shape:
  // `<Static><Options SupportsExtendedMemoryServices="true" .../></Static>`
  // - a single `<Options>` element directly under the app's root `<Static>`
  // (not per-module, not per-ComObject).
  const supportsExtendedMemoryServices =
    attr(el(ap.Static).Options, 'SupportsExtendedMemoryServices') === 'true';
  // See AppIndex.parameterByteOrder's doc comment. Same element as above -
  // `<Static><Options ParameterByteOrder="LittleEndian"/"BigEndian">`.
  const parameterByteOrderRaw = attr(
    el(ap.Static).Options,
    'ParameterByteOrder',
  );
  const parameterByteOrder =
    parameterByteOrderRaw === 'LittleEndian' ||
    parameterByteOrderRaw === 'BigEndian'
      ? parameterByteOrderRaw
      : undefined;
  // `<AddressTable MaxEntries="...">`/`<AssociationTable MaxEntries="...">`,
  // siblings of `<ComObjectRefs>` under the app's `<Static>`. See
  // AppIndex.gaTableMaxEntries/assocTableMaxEntries's doc comments.
  const gaTableMaxEntries = parseInt(
    attr(el(ap.Static).AddressTable, 'MaxEntries'),
    10,
  );
  const assocTableMaxEntries = parseInt(
    attr(el(ap.Static).AssociationTable, 'MaxEntries'),
    10,
  );

  // Parse the app XML a second time with the order-preserving parser, needed
  // for two things the main parse can't carry: document order across
  // heterogeneous siblings (the Dynamic tree) and untrimmed attribute text
  // (ETS encodes ParameterBlock hierarchy as leading spaces, which the main
  // parser strips).
  //
  // Both live entirely inside <Dynamic>, so a program with exactly one
  // Dynamic section and no ModuleDefs only needs that slice parsed - it's a
  // single balanced element, so findDynamic() still works unchanged on it.
  // A program with ModuleDefs falls back to parsing the whole document,
  // since findModDefs() needs the enclosing <ModuleDef Id="..."> a slice
  // would cut away.
  let orderedDynamic: OrdXmlNode[] | null = null;
  const orderedModDynamics: Record<string, OrdXmlNode[]> = {};
  const pbIndentMap: Record<string, number> = {};
  try {
    const orderedXml = orderedXmlParser.parse(dynamicOnly(rawXml) ?? rawXml);

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
  const allLangs = toArr(el(mfrNode?.Languages).Language);
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
        update: attr(co, 'UpdateFlag'),
        readOnInit: attr(co, 'ReadOnInitFlag'),
        priority: attr(co, 'Priority'),
        ...(attr(co, 'BaseNumber')
          ? { baseNumberArgId: attr(co, 'BaseNumber') }
          : {}),
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
        update: attr(cor, 'UpdateFlag') || null,
        readOnInit: attr(cor, 'ReadOnInitFlag') || null,
        priority: attr(cor, 'Priority') || null,
      };
    }
  }

  // 4. Argument definitions: argId → argName
  const argDefs: Record<string, string> = {};
  for (const md of toArr(ap.ModuleDefs?.ModuleDef)) {
    for (const arg of toArr(el(md.Arguments).Argument))
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
    collectMods(toArr(el(md.Dynamic).Module));
  // <Module> instantiation elements aren't always direct children of
  // <Dynamic> - they can nest inside <Channel>/<ChannelIndependentBlock>/
  // <choose>/<when> blocks several levels deep. collectMods() above only
  // matches direct children, so walk the order-preserving tree
  // (orderedDynamic/orderedModDynamics) recursing unconditionally into every
  // child rather than an allowlist of container tags. Additive on top of
  // collectMods() (a strict superset), so a rare ordered-parse failure
  // degrades to the narrower direct-child behavior instead of losing module
  // data entirely.
  const collectModsOrdered = (items: OrdXmlNode[] | null) => {
    if (!items) return;
    for (const el of items) {
      if (ordTagName(el) === 'Module') {
        const mid = ordAttr(el, 'Id');
        if (mid) {
          const args: Record<string, string | number> = {};
          for (const child of ordChildNodes(el)) {
            if (ordTagName(child) !== 'NumericArg') continue;
            const name = argDefs[ordAttr(child, 'RefId')];
            if (name) args[name] = ordAttr(child, 'Value');
          }
          const count = parseInt(ordAttr(el, 'Count'), 10) || 1;
          args._count = count;
          modArgs[mid] = args;
        }
      }
      collectModsOrdered(ordChildNodes(el));
    }
  };
  collectModsOrdered(orderedDynamic);
  for (const ordDyn of Object.values(orderedModDynamics))
    collectModsOrdered(ordDyn);

  // See CoDef.baseNumberArgId's doc comment. Resolves a ComObject's absolute
  // object number for one module instance: `co.num` (module-relative
  // `Number`) plus the instance's `BaseNumber` Argument value (looked up by
  // name in `args`, same shape `modArgs` uses elsewhere). Falls back to the
  // bare template number when there's nothing to resolve.
  function resolveObjectNumber(
    co: CoDef,
    args: Record<string, string | number>,
  ): number {
    if (!co.baseNumberArgId) return co.num;
    const argName = argDefs[co.baseNumberArgId];
    if (!argName) return co.num;
    const raw = args[argName];
    if (raw === undefined) return co.num;
    const n = Number(raw);
    return Number.isFinite(n) ? co.num + n : co.num;
  }

  // 6. Channel definitions: fullChanId → text template
  const chanDefs: Record<string, string> = {};
  for (const ch of toArr(el(ap.ModuleDefs).ModuleDef).flatMap((md) =>
    toArr(el(md.Dynamic).Channel),
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
      objectNumber: resolveObjectNumber(co, args),
      name: interpolate(cor.text || co.text, args),
      function_text: interpolate(cor.ft || co.ft, args),
      channel,
      dpt: cor.dpt || co.dpt || '',
      objectSize: cor.size || co.size || '',
      read: (cor.read ?? co.read) === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm: (cor.comm ?? co.comm) === 'Enabled',
      tx: (cor.tx ?? co.tx) === 'Enabled',
      update: (cor.update ?? co.update) === 'Enabled',
      readOnInit: (cor.readOnInit ?? co.readOnInit) === 'Enabled',
      priority: normalizePriority(cor.priority ?? co.priority),
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
        // <TypeFloat> isn't always the 2-byte KNX DPT9 float - its Encoding
        // attribute picks the wire format: "DPT 9" (2 bytes) or "IEEE-754
        // Single" (a full 4-byte float, no DPT9 mantissa/exponent packing).
        // Neither encoding declares its own SizeInBit, so size must come
        // from Encoding. knx-tables.ts's decode/encode already branches on
        // bitSize 16/32/64 (KNX float16/IEEE754 single/double); this just
        // needs to stop defaulting an unspecified size to 16 for Single.
        const encoding = attr(tf, 'Encoding');
        const defaultSizeInBit =
          encoding === 'IEEE-754 Single'
            ? 32
            : encoding === 'IEEE-754 Double'
              ? 64
              : 16; // "DPT 9" and anything unrecognized
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
          sizeInBit: parseInt(attr(tf, 'SizeInBit'), 10) || defaultSizeInBit,
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
      if (pt.TypeRawData) {
        // Pre-baked binary blobs shipped inline as a Parameter's own Value
        // (e.g. characteristic-curve tables). Falling through to the
        // generic TypeRestriction branch below would default size to 1 byte
        // (`|| 8`), since TypeRestriction has no SizeInBit here.
        //
        // MaxSize is in bytes, not bits. Wire format is a 4-byte big-endian
        // length prefix followed by up to MaxSize-4 bytes of data - MaxSize
        // already accounts for the prefix. buildParamMem()
        // (server/routes/knx-tables.ts) emits the prefix + payload for
        // entries whose value exceeds a plain scalar's size; this only
        // needs to report the real byte size so that code recognizes them.
        const trd = Array.isArray(pt.TypeRawData)
          ? pt.TypeRawData[0]
          : pt.TypeRawData;
        const maxSizeBytes = parseInt(attr(trd, 'MaxSize'), 10) || 1;
        paramTypes[tid] = {
          kind: 'other',
          enums: {},
          sizeInBit: maxSizeBytes * 8,
        };
        continue;
      }
      const enums: Record<string, string> = {};
      for (const e of toArr(el(pt.TypeRestriction).Enumeration)) {
        const val = attr(e, 'Value');
        const txt = T(attr(e, 'Id'), 'Text') || attr(e, 'Text');
        if (val !== '' && txt) enums[val] = txt;
      }
      const trSizeInBit =
        parseInt(attr(pt.TypeRestriction, 'SizeInBit'), 10) || 8;
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
  const addParam = (
    p: XmlNode,
    baseOffset = 0,
    baseFromMem = false,
    baseBitOffset = 0,
    baseCodeSegment: string | null = null,
    baseBaseOffsetArgId: string | null = null,
  ) => {
    const id = attr(p, 'Id');
    if (!id) return;
    let rawOff = attr(p, 'Offset');
    let rawBitOff = attr(p, 'BitOffset');
    // Some parameters specify memory via a <Memory> child element rather than direct attributes.
    // This is the standard ETS6 encoding for parameters in <Parameters> (non-Union) sections.
    // Track the source so buildParamMem can distinguish absolute-offset params (Memory child)
    // from Union params (direct Offset="0" attribute) for relSeg blob convention detection.
    let fromMemoryChild = baseFromMem;
    // A Union's children inherit their parent's segment along with its
    // offset; a standalone parameter names its own.
    let codeSegment = baseCodeSegment;
    // See ParamDef.baseOffsetArgId's doc comment. A Union member's own
    // <Memory> doesn't carry `BaseOffset` in practice - the base lives on
    // the enclosing <Union>'s <Memory>, propagated via
    // `baseBaseOffsetArgId` - but own takes priority if both are present.
    let baseOffsetArgId = baseBaseOffsetArgId;
    {
      const mem = Array.isArray(p.Memory) ? p.Memory[0] : p.Memory;
      if (mem) {
        const seg = attr(mem, 'CodeSegment');
        if (seg !== '') codeSegment = seg;
        if (rawOff === '') {
          rawOff = attr(mem, 'Offset');
          rawBitOff = attr(mem, 'BitOffset');
          if (rawOff !== '') fromMemoryChild = true;
        }
        const bo = attr(mem, 'BaseOffset');
        if (bo !== '') baseOffsetArgId = bo;
      }
    }
    // <Property> placement (mutually exclusive with <Memory>). The object is
    // named by `ObjectType` on some parameters and `ObjectIndex` on others
    // (the hardware-type one), so accept whichever is present.
    let propObjType: number | undefined;
    let propId: number | undefined;
    const propEl = Array.isArray(p.Property) ? p.Property[0] : p.Property;
    if (propEl) {
      const ot = parseInt(
        attr(propEl, 'ObjectType') || attr(propEl, 'ObjectIndex'),
        10,
      );
      const pid = parseInt(attr(propEl, 'PropertyId'), 10);
      if (!isNaN(ot) && !isNaN(pid)) {
        propObjType = ot;
        propId = pid;
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
      // A Union's bit position comes from the Union's own <Memory BitOffset>, not
      // the child Parameter's own BitOffset (which is conventionally 0). Fold the
      // parent's baseBitOffset in additively so a child's own nonzero BitOffset
      // (if it ever has one) still combines correctly.
      bitOffset: baseBitOffset + (parseInt(rawBitOff, 10) || 0),
      fromMemoryChild: fromMemoryChild,
      // DefaultUnionParameter="0" marks the first (default-active) param in a Union —
      // its default value should be written even when not in currentValues.
      isDefaultUnionParam: attr(p, 'DefaultUnionParameter') === '0',
      codeSegment,
      ...(baseOffsetArgId ? { baseOffsetArgId } : {}),
      // See ParamDef.baseValueArgId's own doc comment.
      ...(attr(p, 'BaseValue') ? { baseValueArgId: attr(p, 'BaseValue') } : {}),
      ...(propObjType !== undefined && propId !== undefined
        ? { propObjType, propId }
        : {}),
    };
  };
  for (const st of allStaticSections) {
    for (const p of toArr(st.Parameters?.Parameter)) addParam(p);
    for (const u of toArr(st.Parameters?.Union)) {
      // Union children share the union's byte offset AND bit offset; their own
      // @Offset/@BitOffset are relative to it. The union's offset/bitOffset may
      // be in a <Memory Offset="X" BitOffset="Y"> child element rather than
      // direct attributes on the <Union> itself.
      let uOffset = parseInt(attr(u, 'Offset'), 10);
      let uBitOffset = parseInt(attr(u, 'BitOffset'), 10) || 0;
      let uFromMem = false;
      let uCodeSegment: string | null = null;
      // Real convention, confirmed against real module-architecture app
      // XML: a Union MEMBER's own <Memory> never carries `BaseOffset` - the
      // real base lives on the enclosing <Union>'s own <Memory> instead,
      // propagated down to every member the same way offset/bitOffset/
      // codeSegment already are.
      let uBaseOffsetArgId: string | null = null;
      // The Union's <Memory> child can supply the byte offset, the bit offset,
      // or both. Read it whenever present so a Union that carries its BitOffset
      // in <Memory> is not dropped just because its byte Offset happens to be a
      // direct (nonzero) attribute.
      const uMem = Array.isArray(u.Memory) ? u.Memory[0] : u.Memory;
      if (uMem) {
        const seg = attr(uMem, 'CodeSegment');
        if (seg !== '') uCodeSegment = seg;
        const memBitOff = parseInt(attr(uMem, 'BitOffset'), 10);
        if (!isNaN(memBitOff)) uBitOffset = memBitOff;
        if (isNaN(uOffset) || uOffset === 0) {
          const memOff = parseInt(attr(uMem, 'Offset'), 10);
          if (!isNaN(memOff)) {
            uOffset = memOff;
            uFromMem = true;
          }
        }
        const uBo = attr(uMem, 'BaseOffset');
        if (uBo !== '') uBaseOffsetArgId = uBo;
      }
      if (isNaN(uOffset)) uOffset = 0;
      for (const p of toArr(u.Parameter))
        addParam(
          p,
          uOffset,
          uFromMem,
          uBitOffset,
          uCodeSegment,
          uBaseOffsetArgId,
        );
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
  const walkDynSection = (dyn: XmlNode | undefined) => {
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
  walkDynSection(el(ap.Dynamic));
  for (const md of toArr(el(ap.ModuleDefs).ModuleDef))
    walkDynSection(el(md.Dynamic));

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
        // TypeNone carries no value at all, so a choose on it always
        // means its default branch - see DynItemChoose.controllerValueless.
        const controllerKind = pd ? paramTypes[pd.typeRef]?.kind : undefined;
        if (prId)
          result.push({
            type: 'choose',
            paramRefId: prId,
            accessNone: effectiveAccess === 'None',
            defaultValue: pr?.prDefault ?? pd?.value ?? null,
            controllerValueless: controllerKind === 'none',
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
      } else if (tag === 'Module') {
        // See DynItemModule's own doc comment - a real <Module>
        // instantiation nested inside a <choose>/<Channel> branch,
        // previously silently dropped here entirely.
        const mid = ordAttr(el, 'Id');
        if (mid) result.push({ type: 'module', modId: mid });
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

    function isTypeNone(prId: string): boolean {
      const pr = paramRefDefs[prId];
      if (!pr) return true; // unknown param — treat as always-evaluate
      const pd = paramDefs[pr.paramId];
      if (!pd) return true;
      const ti = paramTypes[pd.typeRef];
      return ti?.kind === 'none';
    }

    // A genuinely-active module instance's Dynamic tree must be walked with
    // its own resolved args threaded through: a comref or <choose> inside a
    // ModuleDef's Dynamic section is written module-def-relative (e.g.
    // "MD-1_O-2-1_R-4", no "_M-<n>_" instance segment), which the regex
    // fallback below can never resolve. See the 'module' branch below.
    interface ModuleCtx {
      mdId: string; // ModuleDef id, e.g. "{appId}_MD-1" - the un-instanced template
      instanceModId: string; // real instance id, e.g. "{appId}_MD-1_M-254"
      args: Record<string, string | number>; // this instance's real resolved NumericArgs, keyed by arg NAME
    }

    function walkItems(
      items: DynItem[] | null,
      channelLabel: string,
      moduleCtx: ModuleCtx | null = null,
    ) {
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
              // `args` must be resolved unconditionally so
              // `resolveObjectNumber()` below keys this map by the same
              // absolute object number `resolveCoRef()`/`resolveCoRefById()`
              // return, not the bare template `co.num`.
              //
              // When this comRef was reached via a module instance's own
              // Dynamic tree (`moduleCtx` set), use that instance's resolved
              // args directly - a comref inside a ModuleDef's <Dynamic> is
              // module-def-relative, so regex-extracting "_M-<n>_" from
              // `item.refId` can't match here.
              let args: Record<string, string | number>;
              if (moduleCtx) {
                args = moduleCtx.args;
              } else {
                const mdMatch = item.refId.match(/_(MD-\w+)_(M-\d+)_/);
                args = mdMatch
                  ? modArgs[`${appId}_${mdMatch[1]}_${mdMatch[2]}`] || {}
                  : {};
              }
              // A module-scoped comm object (co.baseNumberArgId set) reached
              // with no per-instance args (no "_M-<n>_" refId segment or
              // moduleCtx) has no real grounding - skip it rather than let
              // resolveObjectNumber() fall back to the bare template
              // Number, which produces collision-prone ghost entries.
              if (co.baseNumberArgId && Object.keys(args).length === 0)
                continue;
              const realObjNum = resolveObjectNumber(co, args);
              if (!activeCorefsByObjNum.has(realObjNum))
                activeCorefsByObjNum.set(realObjNum, []);
              // Interpolate channel label templates (e.g. {{0: Shutter Actuator A+B}})
              let ch = channelLabel || '';
              if (ch && ch.includes('{{')) ch = interpolate(ch, args);
              activeCorefsByObjNum
                .get(realObjNum)!
                .push({ corId: item.refId, channel: ch });
            }
          }
        } else if (item.type === 'channel') {
          walkItems(item.items, item.label || channelLabel, moduleCtx);
        } else if (item.type === 'block' || item.type === 'cib') {
          walkItems(item.items, channelLabel, moduleCtx);
        } else if (item.type === 'choose') {
          // Skip if controlling param is known visible but not active (prevents phantom COs)
          if (
            item.paramRefId &&
            !item.accessNone &&
            !isTypeNone(item.paramRefId) &&
            !activeParams.has(item.paramRefId)
          )
            continue;
          // A <choose> inside a ModuleDef's Dynamic section (reached via
          // moduleCtx) selects on a paramRefId that is module-def-relative
          // (e.g. "{appId}_MD-1_P-2_R-2") - the same literal id for every
          // instance. Per-instance overrides live under the fully-qualified
          // ParameterInstanceRef key ("{appId}_MD-1_M-254_MI-1_P-2_R-2").
          // Only rewrite the lookup key when the choose's paramRefId
          // belongs to THIS module (starts with `moduleCtx.mdId + '_'`) - a
          // choose can also reference a plain device-global parameter,
          // which must resolve unqualified.
          const qualifiedKey =
            moduleCtx && item.paramRefId.startsWith(`${moduleCtx.mdId}_`)
              ? `${moduleCtx.instanceModId}_MI-1_${item.paramRefId.slice(moduleCtx.mdId.length + 1)}`
              : item.paramRefId;
          const raw = getVal(qualifiedKey);
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
              walkItems(w.items, channelLabel, moduleCtx);
            }
          }
          if (!matched && defItems)
            walkItems(defItems, channelLabel, moduleCtx);
        } else if (item.type === 'module') {
          // Recurse into this module instance's own Dynamic tree using its
          // resolved per-instance args, so comrefs/nested chooses declared
          // only inside the owning ModuleDef's <Dynamic> (never in the
          // device's own ComObjectInstanceRefs XML) are found and gated.
          const instArgs = modArgs[item.modId];
          if (!instArgs) continue; // never actually instantiated - nothing to recurse into
          const mdMatch = item.modId.match(/^(.+)_M-\d+$/);
          if (!mdMatch) continue;
          const mdId = mdMatch[1]!;
          const modItems = modItemsById[mdId];
          if (modItems)
            walkItems(modItems, channelLabel, {
              mdId,
              instanceModId: item.modId,
              args: instArgs,
            });
        }
      }
    }

    const mainItems = orderedDynamic ? serOrderedItems(orderedDynamic) : null;
    // Index each ModuleDef's serialized item list by its ModuleDef id
    // (orderedModDynamics' key, "{appId}_MD-x") so the 'module' recursion in
    // walkItems can look one up by id. `modItemsList` (the flat form) still
    // feeds the pass1/pass2 walks below.
    const modItemsById: Record<string, DynItem[]> = {};
    const modItemsList: DynItem[][] = [];
    for (const [mdId, od] of Object.entries(orderedModDynamics)) {
      const its = od ? serOrderedItems(od) : null;
      if (its) {
        modItemsById[mdId] = its;
        modItemsList.push(its);
      }
    }
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
      objectNumber: resolveObjectNumber(co, args),
      name: interpolate(cor.text || co.text, args),
      function_text: interpolate(cor.ft || co.ft, args),
      dpt: cor.dpt || co.dpt || '',
      objectSize: cor.size || co.size || '',
      read: (cor.read ?? co.read) === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm: (cor.comm ?? co.comm) === 'Enabled',
      tx: (cor.tx ?? co.tx) === 'Enabled',
      update: (cor.update ?? co.update) === 'Enabled',
      readOnInit: (cor.readOnInit ?? co.readOnInit) === 'Enabled',
      priority: normalizePriority(cor.priority ?? co.priority),
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

    // chooseOwnerOf: paramRefId → the paramRefId of the nearest enclosing
    // <Choose> in the dynamic tree. Some paramRefs have no Text of their own
    // (a companion value ETS writes based on a visible enum/checkbox's
    // selected branch) - for those, the enclosing choose's label is the
    // most meaningful one available, since that choose is the user-visible
    // control the companion value belongs to.
    const chooseOwnerOf: Record<string, string> = {};
    function walkForChooseOwners(
      items: DynItem[] | null | undefined,
      owner: string | null,
    ): void {
      if (!items) return;
      for (const it of items) {
        if (it.type === 'paramRef' && it.refId) {
          if (owner && !(it.refId in chooseOwnerOf))
            chooseOwnerOf[it.refId] = owner;
        } else if (it.type === 'choose' && it.paramRefId) {
          for (const w of it.whens || [])
            walkForChooseOwners(w.items, it.paramRefId!);
        } else if (
          it.type === 'block' ||
          it.type === 'channel' ||
          it.type === 'cib'
        ) {
          walkForChooseOwners(it.items, owner);
        }
      }
    }
    walkForChooseOwners(dynTree.main?.items ?? null, null);
    for (const md of dynTree.moduleDefs) walkForChooseOwners(md.items, null);

    // Which address each CodeSegment id actually sits at, from the
    // <AbsoluteSegment Id="..." Address="..."/> declarations themselves.
    // A parameter's <Memory CodeSegment="..." Offset="N"/> is an offset
    // INTO that segment, so this is what turns a parameter's offset into
    // a place in the device's memory. RelativeSegments are keyed by their
    // LoadStateMachine rather than an address and are handled by the
    // existing relSegData path, so only absolute ones are mapped here.
    const codeSegmentAddress: Record<string, number> = {};
    for (const st of allStaticSections) {
      for (const as_ of toArr(st.Code?.AbsoluteSegment)) {
        const id = attr(as_, 'Id');
        const addr = parseInt(attr(as_, 'Address'), 10);
        if (id && !isNaN(addr)) codeSegmentAddress[id] = addr;
      }
    }

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

      // Same generic derivation as `params` above (pr.text || pd.text) -
      // just not gated on Access/typeKind, so download-only params still
      // get a real label instead of falling back to their raw paramRefId.
      // When the paramRef itself has no Text at all (a companion value
      // written by a <Choose>, not something ETS ever labels on its own),
      // borrow the enclosing choose's own label/section instead - see
      // chooseOwnerOf above.
      let ownLabel = pr.text || pd.text || '';
      let labelSection = paramRefSectionMap[prId] || '';
      const ownerId = chooseOwnerOf[prId];
      if (!ownLabel && ownerId) {
        const ownerPr = paramRefDefs[ownerId];
        const ownerPd = ownerPr ? paramDefs[ownerPr.paramId] : null;
        if (ownerPr && ownerPd) {
          ownLabel = ownerPr.text || ownerPd.text || '';
          labelSection = paramRefSectionMap[ownerId] || labelSection;
        }
      }

      const segmentAddress =
        pd.codeSegment != null ? codeSegmentAddress[pd.codeSegment] : undefined;

      paramMemLayout[prId] = {
        offset: pd.offset,
        bitOffset: pd.bitOffset || 0,
        ...(segmentAddress !== undefined ? { segmentAddress } : {}),
        bitSize: ti.sizeInBit || 8,
        // See ParamMemLayoutEntry.refValue's doc comment: `defaultValue` is
        // always the Parameter's factory value; `refValue` below carries
        // the ParameterRef's own value separately, for buildParamMem() to
        // prefer only when this entry is genuinely reached by the tree walk.
        defaultValue: pd.value ?? '',
        isText: ti.kind === 'text',
        isFloat: ti.kind === 'float',
        fromMemoryChild: pd.fromMemoryChild || false,
        isVisible,
        ...(pr.prDefault !== null ? { refValue: pr.prDefault } : {}),
        ...(pd.isDefaultUnionParam ? { isDefaultUnionParam: true } : {}),
        ...(pd.baseOffsetArgId ? { baseOffsetArgId: pd.baseOffsetArgId } : {}),
        ...(ti.coefficient ? { coefficient: ti.coefficient } : {}),
        ...(ownLabel && {
          label: ownLabel,
          section: labelSection,
          group: paramRefGroupMap[prId] || '',
          unit: ti.unit || '',
          enums: ti.enums || {},
        }),
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

    // Every ParameterRef's declared value, unfiltered - see the field's
    // own doc comment on ParamModel for why neither map above can serve
    // this purpose.
    const paramRefValues: Record<string, string> = {};
    for (const [prId, pr] of Object.entries(paramRefDefs)) {
      const pd = paramDefs[pr.paramId];
      if (!pd) continue;
      const value = pr.prDefault ?? pd.value ?? '';
      if (value !== '') paramRefValues[prId] = String(value);
    }

    // paramId -> baseValueArgId, for module-instanced params that have one -
    // see ParamModel.baseValueArgIds' own doc comment.
    const baseValueArgIds: Record<string, string> = {};
    for (const [paramId, pd] of Object.entries(paramDefs)) {
      if (pd.baseValueArgId) baseValueArgIds[paramId] = pd.baseValueArgId;
    }

    return {
      appId,
      params,
      dynTree,
      modArgs,
      paramMemLayout,
      argDefs,
      baseValueArgIds,
      paramRefValues,
      relSegData,
      absSegData,
    };
  }

  // ── LoadProcedures ────────────────────────────────────────────────────────
  // Parse the download steps from Static/LoadProcedures.
  // Iterate LdCtrl* children in document order (JavaScript objects preserve
  // insertion order) to support both DefaultProcedure and ProductProcedure
  // style load sequences.
  const loadProcedures: LoadProcedureStep[] = [];
  // Where each step came from, so the list can be put back in document order
  // below (see loadProcedureDocumentOrder).
  const loadProcedureKeys: string[] = [];
  let procedureIndex = -1;
  for (const lp of toArr(ap.Static?.LoadProcedures?.LoadProcedure)) {
    procedureIndex++;
    const mergeIdRaw = attr(lp, 'MergeId');
    const mergeId = mergeIdRaw ? parseInt(mergeIdRaw, 10) : undefined;
    const withMergeId = mergeId != null ? { mergeId } : {};
    for (const key of Object.keys(lp as XmlNode)) {
      if (!key.startsWith('LdCtrl')) continue;
      let elementIndex = -1;
      for (const el of toArr((lp as XmlNode)[key])) {
        elementIndex++;
        const stepsBefore = loadProcedures.length;
        switch (key) {
          case 'LdCtrlRelSegment':
            loadProcedures.push({
              type: 'RelSegment',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 4,
              size: parseInt(attr(el, 'Size'), 10) || 0,
              mode: attr(el, 'AppliesTo') || 'full',
              fill: parseInt(attr(el, 'Fill'), 10) || 0,
              ...withMergeId,
            });
            break;
          case 'LdCtrlWriteProp': {
            const raw = attr(el, 'InlineData');
            const data = raw
              ? Buffer.from(raw.replace(/\s/g, ''), 'hex').toString('hex')
              : '';
            loadProcedures.push({
              type: 'WriteProp',
              objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
              propId: parseInt(attr(el, 'PropId'), 10) || 0,
              data,
              ...(!isNaN(parseInt(attr(el, 'StartElement'), 10))
                ? { startElement: parseInt(attr(el, 'StartElement'), 10) }
                : {}),
              ...(attr(el, 'Verify') === 'true' ||
              attr(el, 'Verify') === 'false'
                ? { verifyResponse: attr(el, 'Verify') === 'true' }
                : {}),
              ...withMergeId,
            });
            break;
          }
          case 'LdCtrlCompareProp':
            loadProcedures.push({
              type: 'CompareProp',
              objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
              propId: parseInt(attr(el, 'PropId'), 10) || 0,
              data: attr(el, 'InlineData').replace(/\s/g, ''),
              ...withMergeId,
            });
            break;
          case 'LdCtrlWriteRelMem':
            loadProcedures.push({
              type: 'WriteRelMem',
              objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 4,
              offset: parseInt(attr(el, 'Offset'), 10) || 0,
              size: parseInt(attr(el, 'Size'), 10) || 0,
              mode: attr(el, 'AppliesTo') || 'full',
              // `Verify="true"` on `<LdCtrlWriteRelMem>`. See
              // downloadDevice() for current usage.
              verify: attr(el, 'Verify') === 'true',
              ...(attr(el, 'Verify') === 'true' ||
              attr(el, 'Verify') === 'false'
                ? { verifyResponse: attr(el, 'Verify') === 'true' }
                : {}),
              ...withMergeId,
            });
            break;
          case 'LdCtrlLoadImageProp':
            loadProcedures.push({
              type: 'LoadImageProp',
              objIdx: parseInt(attr(el, 'ObjIdx'), 10) || 0,
              propId: parseInt(attr(el, 'PropId'), 10) || 27,
              ...(!isNaN(parseInt(attr(el, 'Count'), 10))
                ? { count: parseInt(attr(el, 'Count'), 10) }
                : {}),
              ...withMergeId,
            });
            break;
          case 'LdCtrlAbsSegment': {
            const optInt = (name: string): number | undefined => {
              const n = parseInt(attr(el, name), 10);
              return isNaN(n) ? undefined : n;
            };
            const access = optInt('Access');
            const memType = optInt('MemType');
            const segType = optInt('SegType');
            const segFlags = optInt('SegFlags');
            loadProcedures.push({
              type: 'AbsSegment',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
              address: parseInt(attr(el, 'Address'), 10) || 0,
              size: parseInt(attr(el, 'Size'), 10) || 0,
              ...(access != null ? { access } : {}),
              ...(memType != null ? { memType } : {}),
              ...(segType != null ? { segType } : {}),
              ...(segFlags != null ? { segFlags } : {}),
              ...withMergeId,
            });
            break;
          }
          case 'LdCtrlConnect':
            loadProcedures.push({ type: 'Connect', ...withMergeId });
            break;
          case 'LdCtrlDisconnect':
            loadProcedures.push({ type: 'Disconnect', ...withMergeId });
            break;
          case 'LdCtrlRestart':
            loadProcedures.push({ type: 'Restart', ...withMergeId });
            break;
          case 'LdCtrlUnload':
            loadProcedures.push({
              type: 'Unload',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
              ...withMergeId,
            });
            break;
          case 'LdCtrlLoad':
            loadProcedures.push({
              type: 'Load',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
              ...withMergeId,
            });
            break;
          case 'LdCtrlTaskSegment':
            loadProcedures.push({
              type: 'TaskSegment',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
              address: parseInt(attr(el, 'Address'), 10) || 0,
              ...withMergeId,
            });
            break;
          case 'LdCtrlLoadCompleted':
            loadProcedures.push({
              type: 'LoadCompleted',
              lsmIdx: parseInt(attr(el, 'LsmIdx'), 10) || 0,
              ...withMergeId,
            });
            break;
          default:
            // Any other LdCtrl* directive: keep it visible instead of
            // silently dropping it.
            loadProcedures.push({
              type: 'Unhandled',
              tag: key,
              ...withMergeId,
            });
            break;
        }
        for (let i = stepsBefore; i < loadProcedures.length; i++) {
          loadProcedureKeys[i] = `${procedureIndex}|${key}|${elementIndex}`;
        }
      }
    }
  }
  // Restore the order the application declares its steps in. Only applied when
  // every step's position is known; otherwise the steps stay as parsed.
  {
    const docOrder = loadProcedureDocumentOrder(rawXml);
    const positions = loadProcedureKeys.map((k) => docOrder.get(k));
    if (
      docOrder.size > 0 &&
      loadProcedures.length > 1 &&
      positions.every((p) => p !== undefined)
    ) {
      const sorted = loadProcedures
        .map((step, i) => ({ step, pos: positions[i]!, i }))
        .sort((a, b) => a.pos - b.pos || a.i - b.i)
        .map((x) => x.step);
      loadProcedures.splice(0, loadProcedures.length, ...sorted);
    }
  }

  // See AppIndex.maxComObjectNumber's doc comment.
  const maxComObjectNumber = Object.values(coDefs).reduce(
    (max, co) => Math.max(max, co.num),
    0,
  );

  return {
    resolveCoRef,
    resolveParamRef,
    evalDynamic,
    resolveCoRefById,
    buildParamModel,
    appId,
    maxComObjectNumber,
    isSecureEnabled,
    peiType,
    lineCoupler0912NewProgrammingStyle,
    supportsExtendedMemoryServices,
    parameterByteOrder,
    gaTableMaxEntries,
    assocTableMaxEntries,
    paramRefKeys: Object.keys(paramRefDefs),
    hardwareTypeParams: Object.entries(paramDefs)
      .filter(([, pd]) => pd.propObjType === 0 && pd.propId === 78)
      .map(([key, pd]) => ({
        key,
        value: pd.value,
        enums: paramTypes[pd.typeRef]?.enums ?? {},
      }))
      .filter((d) => Object.keys(d.enums).length > 0),
    moduleKeys: Object.keys(modArgs), // "{appId}_MD-n_M-k" — one per instantiated module
    getDefault,
    getModArgs,
    loadProcedures,
  };
}
