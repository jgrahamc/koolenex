/**
 * ETS6 .knxproj parser  —  full extraction
 *
 * Resolves:
 *   - Project name (project.xml → ProjectInformation/@Name)
 *   - Manufacturer name (knx_master.xml → Manufacturer/@Id lookup)
 *   - Hardware: model, order number, hardware serial (M-XXXX/Hardware.xml)
 *   - Application program: ComObject FunctionTexts with ModuleDef template
 *     argument substitution ({{argCH}} → "3") sourced either from element
 *     attributes or from Languages/Translation elements
 *   - Channel names from Channel/@Text with same argument substitution
 *   - Device instance attributes: serial (base64→hex), timestamps, load flags
 *   - Group addresses: 3-level address assembly, DPT, range names
 *   - All GA links via Links="GA-3 GA-5" short-ID or full-ID resolution
 *
 * Password-protected projects:
 *   ETS6 ZIP-level: inner P-*.zip is AES-encrypted. The ZIP password is derived as
 *     base64(PBKDF2-HMAC-SHA256(password_utf16le, "21.project.ets.knx.org", 65536, 32))
 *   ETS5/6 file-level: individual XML files encrypted with AES-256-CBC.
 *     Format: [20-byte salt][4-byte iteration count BE][16-byte IV][ciphertext]
 *     Key:    PBKDF2-HMAC-SHA256(password_utf16le, salt, iterations, 32)
 */

import { createRequire } from 'module';
import { XMLParser } from 'fast-xml-parser';
import crypto from 'crypto';

interface MinizipEntry {
  filepath: string;
}
interface MinizipInstance {
  list(): MinizipEntry[];
  extract(filepath: string, options?: { password?: string }): Uint8Array;
}

// ─── XML node types ──────────────────────────────────────────────────────────
// fast-xml-parser returns untyped objects. These aliases are semantically
// clearer than `any` — they say "parsed XML node with unknown structure".
type XmlNode = Record<string, unknown>;
type OrdXmlNode = Record<string, unknown>;

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

interface HwInfo {
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
type DynItem =
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
type LoadProcedureStep =
  | LpRelSegment
  | LpWriteProp
  | LpCompareProp
  | LpWriteRelMem
  | LpLoadImageProp
  | LpAbsSegment;

// ─── Parsed output record types ──────────────────────────────────────────────
interface ParsedDevice {
  individual_address: string;
  name: string;
  description: string;
  comment: string;
  installation_hints: string;
  manufacturer: string;
  model: string;
  order_number: string;
  serial_number: string;
  product_ref: string;
  area: number;
  area_name: string;
  line: number;
  line_name: string;
  medium: string;
  device_type: string;
  status: string;
  last_modified: string;
  last_download: string;
  apdu_length: string;
  app_loaded: boolean;
  comm_loaded: boolean;
  ia_loaded: boolean;
  params_loaded: boolean;
  app_number: string;
  app_version: string;
  parameters: ResolvedParam[];
  app_ref: string;
  param_values: Record<string, string>;
  model_translations: Record<string, string> | null;
  bus_current: number;
  width_mm: number;
  is_power_supply: boolean;
  is_coupler: boolean;
  is_rail_mounted: boolean;
}

interface ResolvedParam {
  section: string;
  group: string;
  name: string;
  value: string;
}

interface ParsedGroupAddress {
  address: string;
  name: string;
  dpt: string;
  comment: string;
  description: string;
  main: number;
  mainGroupName: string;
  middle: number;
  middleGroupName: string;
  sub: number;
}

interface ParsedComObject {
  device_address: string;
  object_number: number;
  channel: string;
  name: string;
  function_text: string;
  dpt: string;
  object_size: string;
  flags: string;
  direction: string;
  ga_address: string;
  ga_send?: string;
  ga_receive?: string;
}

interface ParsedSpace {
  name: string;
  type: string;
  usage_id: string;
  parent_idx: number | null;
  sort_order: number;
}

interface CatalogSection {
  id: string;
  name: string;
  number: string;
  parent_id: string | null;
  mfr_id: string;
  manufacturer: string;
}

interface CatalogItem {
  id: string;
  name: string;
  number: string;
  description: string;
  section_id: string;
  product_ref: string;
  h2p_ref: string;
  order_number: string;
  manufacturer: string;
  mfr_id: string;
  model: string;
  bus_current: number;
  width_mm: number;
  is_power_supply: boolean;
  is_coupler: boolean;
  is_rail_mounted: boolean;
}

interface TopologyEntry {
  area: number;
  line: number | null;
  name: string;
  medium: string;
}

// ─── Parameter model types ───────────────────────────────────────────────────
interface ParamModelEntry {
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

interface ParamMemLayoutEntry {
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

interface ParamModel {
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

// @ts-expect-error TS1470: import.meta is valid at runtime
const require_ = createRequire(import.meta.url);
const Minizip = require_('minizip-asm.js') as new (
  data: Buffer,
) => MinizipInstance;

interface ZipEntry {
  entryName: string;
  getData(): Buffer;
}

/** Open a ZIP buffer and return entries compatible with the ZipEntry interface. */
function openZip(buffer: Buffer, password?: string): ZipEntry[] {
  const mz = new Minizip(buffer);
  const opts = password ? { password } : undefined;
  return mz.list().map((f) => {
    const data = Buffer.from(mz.extract(f.filepath, opts));
    return { entryName: f.filepath, getData: () => data };
  });
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

/** Returns true if the buffer is not plaintext XML (i.e. likely AES-encrypted). */
export function looksEncrypted(buf: Buffer | null | undefined): boolean {
  if (!buf || buf.length < 2) return false;
  // Skip leading whitespace and BOM
  let i = 0;
  // UTF-8 BOM (EF BB BF)
  if (buf[0] === 0xef && buf[1] === 0xbb) i = 3;
  // Skip whitespace (space, tab, newline, carriage return)
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)
  )
    i++;
  // Plain XML starts with '<'
  if (i < buf.length && buf[i] === 0x3c) return false;
  return true;
}

/**
 * Decrypt an ETS6-encrypted file buffer using the given password.
 * Throws with code 'PASSWORD_INCORRECT' if padding is invalid.
 */
/**
 * Derive the ZIP password for an ETS6 password-protected inner archive.
 * ETS6 uses PBKDF2-HMAC-SHA256 with a fixed salt, then base64-encodes the result.
 */
function deriveZipPassword(password: string): string {
  const derived = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    '21.project.ets.knx.org',
    65536,
    32,
    'sha256',
  );
  return derived.toString('base64');
}

/**
 * Decrypt an ETS5/6 file-level AES-256-CBC encrypted buffer.
 */
function decryptEntry(buf: Buffer, password: string): Buffer {
  if (buf.length < 40)
    throw Object.assign(new Error('Encrypted file too short'), {
      code: 'PASSWORD_INCORRECT',
    });
  const salt = buf.slice(0, 20);
  const iterations = buf.readUInt32BE(20);
  const iv = buf.slice(24, 40);
  const data = buf.slice(40);
  const key = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf16le'),
    salt,
    iterations,
    32,
    'sha256',
  );
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    throw Object.assign(new Error('Incorrect password'), {
      code: 'PASSWORD_INCORRECT',
    });
  }
}

// ─── XML parser ───────────────────────────────────────────────────────────────
const ALWAYS_ARRAY = new Set([
  'Area',
  'Line',
  'Segment',
  'DeviceInstance',
  'GroupRange',
  'GroupAddress',
  'ComObjectInstanceRef',
  'Send',
  'Receive',
  'Manufacturer',
  'ComObject',
  'ComObjectRef',
  'Module',
  'NumericArg',
  'Argument',
  'Language',
  'TranslationUnit',
  'TranslationElement',
  'Translation',
  'Hardware',
  'Product',
  'Hardware2Program',
  'Space',
  'DeviceInstanceRef',
  'ParameterBlock',
  'Parameter',
  'ParameterRef',
  'ParameterInstanceRef',
  'ParameterType',
  'Enumeration',
  'Union',
  'ParameterRefRef',
  'ComObjectRefRef',
  'choose',
  'when',
  'ChannelIndependentBlock',
  'LoadProcedure',
  'LdCtrlRelSegment',
  'LdCtrlWriteProp',
  'LdCtrlCompareProp',
  'LdCtrlWriteRelMem',
  'LdCtrlLoadImageProp',
  'LdCtrlAbsSegment',
  'RelativeSegment',
  'AbsoluteSegment',
  'Channel',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name: string) => ALWAYS_ARRAY.has(name),
  processEntities: true, // decode &#xD; &#xA; etc. at parse time
  htmlEntities: true, // also handle &amp; &lt; etc.
});

// ─── Order-preserving parser for Dynamic sections ────────────────────────────
const orderedXmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  htmlEntities: true,
  trimValues: false,
});
const ordAttr = (el: OrdXmlNode | null | undefined, name: string): string =>
  sanitizeText(
    (el?.[':@'] as Record<string, unknown> | undefined)?.[`@_${name}`] ?? '',
  );
const ordRawAttr = (el: OrdXmlNode | null | undefined, name: string): string =>
  (
    ((el?.[':@'] as Record<string, unknown> | undefined)?.[`@_${name}`] ??
      '') as string | number
  ).toString();
const ordTagName = (el: OrdXmlNode | null | undefined): string | undefined =>
  Object.keys(el || {}).find((k) => k !== ':@');
const ordChildNodes = (el: OrdXmlNode | null | undefined): OrdXmlNode[] => {
  const tag = ordTagName(el);
  const c = tag ? el?.[tag] : null;
  return Array.isArray(c) ? (c as OrdXmlNode[]) : [];
};

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toArr = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Sanitize a string value from an ETS attribute.
 * Strategy:
 *   1. Decode all numeric XML character references (&#xD; → \r, &#10; → \n, etc.)
 *      so they become actual characters regardless of whether fast-xml-parser
 *      decoded them already.
 *   2. Remove every ASCII control character (codes 0–31 and 127) that results.
 *   3. Collapse runs of whitespace and trim.
 */
export const sanitizeText = (s: unknown): string => {
  let str = (s ?? '').toString();
  // Decode hex numeric character references: &#xD; &#x0D; &#XA; etc.
  str = str.replace(/&#[xX]([0-9a-fA-F]+);/g, (_: string, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  // Decode decimal numeric character references: &#13; &#10; etc.
  str = str.replace(/&#([0-9]+);/g, (_: string, d: string) =>
    String.fromCharCode(parseInt(d, 10)),
  );
  // Strip all ASCII control characters (NUL–US and DEL)
  // eslint-disable-next-line no-control-regex
  str = str.replace(/[\x00-\x1F\x7F]+/g, ' ');
  return str.replace(/ {2,}/g, ' ').trim();
};
const attr = (el: XmlNode | unknown, name: string): string =>
  sanitizeText((el as XmlNode)?.[`@_${name}`] ?? '');
export const interpolate = (
  tpl: unknown,
  map: Record<string, string | number>,
): string =>
  sanitizeText(
    ((tpl || '') as string)
      // Named args: {{argCH}} → map.argCH ?? ''
      .replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(map[k] ?? ''))
      // Numbered args with default text: {{0: Channel A}} → use default text if arg 0 not in map
      .replace(
        /\{\{(\d+)\s*:\s*([^}]*)\}\}/g,
        (_: string, n: string, def: string) => String(map[n] ?? def.trim()),
      ),
  )
    .replace(/[\s:\-–—]+$/, '')
    .trim();

// ─── AppIndex return type ───────────────────────────────────────────────────
interface AppIndex {
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
function buildAppIndex(buf: Buffer): AppIndex | null {
  const rawXml = buf.toString('utf8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let xml: any;
  try {
    xml = xmlParser.parse(rawXml);
  } catch (e: unknown) {
    console.error('[ETS] app parse:', (e as Error).message);
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
        num: parseInt(attr(co, 'Number')) || 0,
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
      const count = parseInt(attr(mod, 'Count')) || 1;
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
          sizeInBit: parseInt(attr(tn, 'SizeInBit')) || 8,
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
          sizeInBit: parseInt(attr(tf, 'SizeInBit')) || 16,
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
          sizeInBit: parseInt(attr(tt, 'SizeInBit')) || 16,
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
          sizeInBit: parseInt(attr(tt, 'SizeInBit')) || 8,
        };
        continue;
      }
      const enums: Record<string, string> = {};
      for (const e of toArr(pt.TypeRestriction?.Enumeration)) {
        const val = attr(e, 'Value');
        const txt = T(attr(e, 'Id'), 'Text') || attr(e, 'Text');
        if (val !== '' && txt) enums[val] = txt;
      }
      const trSizeInBit = parseInt(attr(pt.TypeRestriction, 'SizeInBit')) || 8;
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
          ? baseOffset + parseInt(rawOff)
          : baseOffset > 0
            ? baseOffset
            : null,
      bitOffset: parseInt(rawBitOff) || 0,
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
      let uOffset = parseInt(attr(u, 'Offset'));
      let uFromMem = false;
      if (isNaN(uOffset) || uOffset === 0) {
        const uMem = Array.isArray(u.Memory) ? u.Memory[0] : u.Memory;
        if (uMem) {
          const memOff = parseInt(attr(uMem, 'Offset'));
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
        const lsm = parseInt(attr(rs, 'LoadStateMachine'));
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
        const addr = parseInt(attr(as_, 'Address'));
        const size = parseInt(attr(as_, 'Size')) || 0;
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
      const lsmIdx = parseInt(attr(el, 'LsmIdx')) || 4;
      const size = parseInt(attr(el, 'Size')) || 0;
      const mode = attr(el, 'AppliesTo') || 'full';
      loadProcedures.push({
        type: 'RelSegment',
        lsmIdx,
        size,
        mode,
        fill: parseInt(attr(el, 'Fill')) || 0,
      });
    }
    for (const el of toArr(lp.LdCtrlWriteProp)) {
      const raw = attr(el, 'InlineData');
      const data = raw ? Buffer.from(raw.replace(/\s/g, ''), 'hex') : null;
      if (data && data.length) {
        loadProcedures.push({
          type: 'WriteProp',
          objIdx: parseInt(attr(el, 'ObjIdx')) || 0,
          propId: parseInt(attr(el, 'PropId')) || 0,
          data: data.toString('hex'),
        });
      }
    }
    for (const el of toArr(lp.LdCtrlCompareProp)) {
      const raw = attr(el, 'InlineData');
      const data = raw ? raw.replace(/\s/g, '') : '';
      loadProcedures.push({
        type: 'CompareProp',
        objIdx: parseInt(attr(el, 'ObjIdx')) || 0,
        propId: parseInt(attr(el, 'PropId')) || 0,
        data,
      });
    }
    for (const el of toArr(lp.LdCtrlWriteRelMem)) {
      const mode = attr(el, 'AppliesTo') || 'full';
      loadProcedures.push({
        type: 'WriteRelMem',
        objIdx: parseInt(attr(el, 'ObjIdx')) || 4,
        offset: parseInt(attr(el, 'Offset')) || 0,
        size: parseInt(attr(el, 'Size')) || 0,
        mode,
      });
    }
    for (const el of toArr(lp.LdCtrlLoadImageProp)) {
      loadProcedures.push({
        type: 'LoadImageProp',
        objIdx: parseInt(attr(el, 'ObjIdx')) || 0,
        propId: parseInt(attr(el, 'PropId')) || 27,
      });
    }
    for (const el of toArr(lp.LdCtrlAbsSegment)) {
      loadProcedures.push({
        type: 'AbsSegment',
        lsmIdx: parseInt(attr(el, 'LsmIdx')) || 0,
        address: parseInt(attr(el, 'Address')) || 0,
        size: parseInt(attr(el, 'Size')) || 0,
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

// ─── Location / building tree ─────────────────────────────────────────────────
/**
 * Recursively walk ETS <Space> elements (Locations section) and build a flat
 * list of spaces with parent_idx references, plus a map from DeviceInstance
 * individual_address → space index.
 */
function parseLocationsRec(
  spaceEls: XmlNode[],
  parentIdx: number | null,
  spaces: ParsedSpace[],
  devSpaceMap: Record<string, number>,
  devInstById: Record<string, string>,
): void {
  for (let i = 0; i < spaceEls.length; i++) {
    const sp = spaceEls[i]!;
    const idx = spaces.length;
    spaces.push({
      name: attr(sp, 'Name'),
      type: attr(sp, 'Type') || 'Room',
      usage_id: attr(sp, 'Usage') || '',
      parent_idx: parentIdx,
      sort_order: i,
    });
    for (const ref of toArr(sp.DeviceInstanceRef)) {
      const ia = devInstById[attr(ref, 'RefId')];
      if (ia) devSpaceMap[ia] = idx;
    }
    parseLocationsRec(toArr(sp.Space), idx, spaces, devSpaceMap, devInstById);
  }
}

// ─── ParsedProject interface ─────────────────────────────────────────────────
export interface ParsedProject {
  projectName: string;
  devices: ParsedDevice[];
  groupAddresses: ParsedGroupAddress[];
  comObjects: ParsedComObject[];
  links: { deviceAddress: string; gaAddress: string }[];
  spaces: ParsedSpace[];
  devSpaceMap: Record<string, number>;
  paramModels: Record<string, ParamModel>;
  thumbnail: string | null;
  projectInfo: Record<string, string> | null;
  knxMasterXml: string | null;
  catalogSections: CatalogSection[];
  catalogItems: CatalogItem[];
  topologyEntries: TopologyEntry[];
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function parseKnxproj(
  buffer: Buffer,
  password: string | null = null,
): ParsedProject {
  let entries: ZipEntry[];
  try {
    entries = openZip(buffer);
  } catch (e: unknown) {
    throw new Error(
      'Invalid or corrupt .knxproj file: ' + (e as Error).message,
      {
        cause: e,
      },
    );
  }
  const byName: Record<string, ZipEntry> = Object.fromEntries(
    entries.map((e) => [e.entryName, e]),
  );

  // ── ETS6 ZIP-level password protection ────────────────────────────────────
  // ETS6 puts installation files inside an AES-encrypted inner P-*.zip.
  // Detect, derive the ZIP password, and merge extracted entries.
  const innerZipEntries = entries.filter((e) =>
    /^P-[^/]+\.zip$/i.test(e.entryName),
  );
  for (const innerZipEntry of innerZipEntries) {
    const prefix = innerZipEntry.entryName.replace('.zip', '') + '/';
    // Skip if the inner ZIP's contents are already in the outer ZIP (unprotected project)
    if (
      entries.some(
        (e) => e.entryName.startsWith(prefix) && e.entryName.endsWith('.xml'),
      )
    )
      continue;

    if (!password)
      throw Object.assign(new Error('Project is password-protected'), {
        code: 'PASSWORD_REQUIRED',
      });

    const zipPw = deriveZipPassword(password);
    let innerEntries: ZipEntry[];
    try {
      innerEntries = openZip(innerZipEntry.getData(), zipPw);
    } catch (_) {
      throw Object.assign(new Error('Incorrect password'), {
        code: 'PASSWORD_INCORRECT',
      });
    }

    for (const f of innerEntries) {
      const virtualEntry: ZipEntry = {
        entryName: prefix + f.entryName,
        getData: () => f.getData(),
      };
      entries.push(virtualEntry);
      byName[virtualEntry.entryName] = virtualEntry;
    }
  }

  // ── Manufacturer names ─────────────────────────────────────────────────────
  const mfrById: Record<string, string> = {}; // "M-00FA" → "KNX Association"
  const masterE =
    byName['knx_master.xml'] ||
    entries.find((e) => e.entryName.endsWith('/knx_master.xml'));
  let knxMasterXml: string | null = null; // raw XML string for per-project storage
  if (masterE) {
    try {
      knxMasterXml = masterE.getData().toString('utf8');
      const mx = xmlParser.parse(knxMasterXml);
      for (const m of toArr(mx?.KNX?.MasterData?.Manufacturers?.Manufacturer))
        if (attr(m, 'Id')) mfrById[attr(m, 'Id')] = attr(m, 'Name');
    } catch (_) {}
  }

  // ── Hardware lookup ────────────────────────────────────────────────────────
  const hwByProd: Record<string, HwInfo> = {};
  const hwByH2P: Record<string, HwInfo> = {};

  for (const e of entries.filter((e) =>
    /M-[^/]+\/Hardware\.xml$/i.test(e.entryName),
  )) {
    const mfrId =
      e.entryName.match(/M-[^/]+/)?.[0] || e.entryName.split('/')[0]!;
    const mfrName = mfrById[mfrId] || mfrId;
    try {
      const hx = xmlParser.parse(e.getData().toString('utf8'));
      for (const mNode of toArr(hx?.KNX?.ManufacturerData?.Manufacturer)) {
        // Build translation maps from Hardware.xml Languages section
        // hwTrans: refId → text (English preferred, for the model column)
        // hwTransAll: refId → { langId: text } (all languages, stored for runtime lookup)
        const hwTrans: Record<string, string> = {};
        const hwTransAll: Record<string, Record<string, string>> = {};
        const hwLangs = toArr(mNode?.Languages?.Language);
        const hwEnLangs = hwLangs.filter((l: XmlNode) =>
          /^en/i.test(attr(l, 'Identifier')),
        );
        const hwOtherLangs = hwLangs.filter(
          (l: XmlNode) => !/^en/i.test(attr(l, 'Identifier')),
        );
        for (const langs of [hwEnLangs, hwOtherLangs]) {
          for (const lang of langs) {
            const langId = attr(lang, 'Identifier');
            for (const tu of toArr(lang?.TranslationUnit)) {
              for (const el of toArr(tu?.TranslationElement)) {
                const refId = attr(el, 'RefId');
                if (!refId) continue;
                for (const t of toArr(el.Translation)) {
                  if (attr(t, 'AttributeName') === 'Text' && attr(t, 'Text')) {
                    if (!hwTrans[refId]) hwTrans[refId] = attr(t, 'Text'); // English first wins
                    if (!hwTransAll[refId]) hwTransAll[refId] = {};
                    hwTransAll[refId]![langId] = attr(t, 'Text');
                    break;
                  }
                }
              }
            }
          }
        }
        const hwT = (id: string): string => hwTrans[id] || '';
        const hwTAll = (
          id: string,
          baseText: string,
          defaultLang: string,
        ): Record<string, string> | null => {
          const t = hwTransAll[id] ? { ...hwTransAll[id] } : {};
          // Add base text under the manufacturer's default language
          if (baseText && defaultLang && !t[defaultLang])
            t[defaultLang] = baseText;
          return Object.keys(t).length ? t : null;
        };

        for (const outer of toArr(mNode.Hardware)) {
          for (const hw of toArr(outer.Hardware)) {
            const hwId = attr(hw, 'Id');
            const hwName = hwT(hwId) || attr(hw, 'Name');
            const hwSerial = attr(hw, 'SerialNumber');
            const busCurrent =
              Math.round(parseFloat(attr(hw, 'BusCurrent'))) || 0;
            const widthMm =
              parseFloat(
                attr(hw, 'WidthInMillimeter') ||
                  attr(toArr(hw?.Products?.Product)[0], 'WidthInMillimeter'),
              ) || 0;
            const isPowerSupply =
              attr(hw, 'IsPowerSupply') === 'true' ||
              attr(hw, 'IsPowerSupply') === '1';
            const isCoupler =
              attr(hw, 'IsCoupler') === 'true' || attr(hw, 'IsCoupler') === '1';
            const isRailMounted =
              attr(toArr(hw?.Products?.Product)[0], 'IsRailMounted') ===
                'true' ||
              attr(toArr(hw?.Products?.Product)[0], 'IsRailMounted') === '1';
            const hwExtra = {
              busCurrent,
              widthMm,
              isPowerSupply,
              isCoupler,
              isRailMounted,
            };
            const info = (base: string) => ({
              manufacturer: mfrName,
              model: base,
              orderNumber: '',
              hwSerial,
              ...hwExtra,
            });
            for (const p of [
              ...toArr(hw?.Products?.Product),
              ...toArr(hw?.Product),
            ]) {
              const pId = attr(p, 'Id');
              const baseText = attr(p, 'Text') || hwName;
              const pWidth =
                parseFloat(attr(p, 'WidthInMillimeter')) || widthMm;
              const defaultLang = attr(p, 'DefaultLanguage');
              if (pId)
                hwByProd[pId] = {
                  manufacturer: mfrName,
                  model: hwT(pId) || baseText,
                  orderNumber: attr(p, 'OrderNumber'),
                  hwSerial,
                  modelTranslations: hwTAll(pId, baseText, defaultLang),
                  ...hwExtra,
                  widthMm: pWidth,
                };
            }
            for (const h of [
              ...toArr(hw?.Hardware2Programs?.Hardware2Program),
              ...toArr(hw?.Hardware2Program),
            ])
              if (attr(h, 'Id')) hwByH2P[attr(h, 'Id')] = info(hwName);
          }
        }
      }
    } catch (e: unknown) {
      console.error('[ETS] Hardware.xml:', (e as Error).message);
    }
  }

  // ── Catalog lookup ──────────────────────────────────────────────────────────
  const catalogSections: CatalogSection[] = [];
  const catalogItems: CatalogItem[] = [];

  for (const e of entries.filter((e) =>
    /M-[^/]+\/Catalog\.xml$/i.test(e.entryName),
  )) {
    const mfrId =
      e.entryName.match(/M-[^/]+/)?.[0] || e.entryName.split('/')[0]!;
    const mfrName = mfrById[mfrId] || mfrId;
    try {
      const cx = xmlParser.parse(e.getData().toString('utf8'));
      for (const mNode of toArr(cx?.KNX?.ManufacturerData?.Manufacturer)) {
        // Build translation map for catalog names
        const catTrans: Record<string, string> = {};
        for (const lang of toArr(mNode?.Languages?.Language).filter(
          (l: XmlNode) => /^en/i.test(attr(l, 'Identifier')),
        )) {
          for (const tu of toArr(lang?.TranslationUnit)) {
            for (const el of toArr(tu?.TranslationElement)) {
              const refId = attr(el, 'RefId');
              if (!refId) continue;
              for (const t of toArr(el.Translation)) {
                if (attr(t, 'Text')) {
                  catTrans[refId] = attr(t, 'Text');
                  break;
                }
              }
            }
          }
        }
        const ct = (id: string): string => catTrans[id] || '';

        const walkSections = (sections: XmlNode[], parentId: string | null) => {
          for (const sec of toArr(sections)) {
            const secId = attr(sec, 'Id');
            const secName = ct(secId) || attr(sec, 'Name') || '';
            const secNumber = attr(sec, 'Number') || '';
            catalogSections.push({
              id: secId,
              name: secName,
              number: secNumber,
              parent_id: parentId,
              mfr_id: mfrId,
              manufacturer: mfrName,
            });
            // Items directly in this section
            for (const item of toArr(sec.CatalogItem)) {
              const itemId = attr(item, 'Id');
              const prodRef = attr(item, 'ProductRefId') || '';
              const h2pRef = attr(item, 'Hardware2ProgramRefId') || '';
              const hw: Partial<HwInfo> =
                hwByProd[prodRef] || hwByH2P[h2pRef] || ({} as Partial<HwInfo>);
              catalogItems.push({
                id: itemId,
                name: ct(itemId) || attr(item, 'Name') || hw.model || '',
                number: attr(item, 'Number') || '',
                description: attr(item, 'VisibleDescription') || '',
                section_id: secId,
                product_ref: prodRef,
                h2p_ref: h2pRef,
                order_number:
                  hw.orderNumber || attr(item, 'VisibleDescription') || '',
                manufacturer: mfrName,
                mfr_id: mfrId,
                model: hw.model || ct(itemId) || attr(item, 'Name') || '',
                bus_current: hw.busCurrent || 0,
                width_mm: hw.widthMm || 0,
                is_power_supply: hw.isPowerSupply || false,
                is_coupler: hw.isCoupler || false,
                is_rail_mounted: hw.isRailMounted || false,
              });
            }
            // Recurse into child sections
            walkSections(toArr(sec.CatalogSection), secId);
          }
        };
        const catalog = mNode?.Catalog;
        walkSections(toArr(catalog?.CatalogSection), null);
      }
    } catch (e: unknown) {
      console.error('[ETS] Catalog.xml:', (e as Error).message);
    }
  }

  // ── Application program indexes ────────────────────────────────────────────
  // Keyed by "M-00FA_A-2504-10-C071" (appId without path/extension)
  const appByAppId: Record<string, AppIndex> = {};
  const appEntries = entries.filter((e) =>
    /M-[^/]+\/M-[^/]+_A-[^/]+\.xml$/i.test(e.entryName),
  );
  for (const e of appEntries) {
    try {
      const idx = buildAppIndex(e.getData());
      if (idx?.appId) appByAppId[idx.appId] = idx;
    } catch (e: unknown) {
      console.error('[ETS] app XML:', (e as Error).message);
    }
  }

  // Given a Hardware2ProgramRefId like "M-00FA_H-xxx_HP-2504-10-C071"
  // the matching appId is "M-00FA_A-2504-10-C071".
  // HP may contain multiple concatenated app IDs (e.g. "4A24-11-O0007-4A24-21-O0007"),
  // so try every dash-boundary prefix from longest to shortest.
  const getAppIdx = (h2pRefId: string): AppIndex | null => {
    const mfr = h2pRefId.split('_H-')[0];
    const hp = h2pRefId.split('_HP-')[1] || '';
    const parts = hp.split('-');
    for (let i = parts.length; i >= 1; i--) {
      const key = `${mfr}_A-${parts.slice(0, i).join('-')}`;
      if (appByAppId[key]) return appByAppId[key]!;
    }
    return null;
  };

  // ── Installation files ─────────────────────────────────────────────────────
  let installEntries = entries.filter((e) =>
    /P-[^/]+\/0\.xml$/i.test(e.entryName),
  );
  if (!installEntries.length)
    installEntries = entries.filter((e) => e.entryName.endsWith('0.xml'));

  // ── Password-protection check ──────────────────────────────────────────────
  // Encrypted project files are binary (not XML). Detect early and validate
  // the password before attempting full parsing.
  for (const entry of installEntries) {
    const raw = entry.getData();
    if (!looksEncrypted(raw)) break; // plaintext — no password needed
    if (!password)
      throw Object.assign(new Error('Project is password-protected'), {
        code: 'PASSWORD_REQUIRED',
      });
    try {
      decryptEntry(raw, password);
    } catch (_) {
      throw Object.assign(new Error('Incorrect password'), {
        code: 'PASSWORD_INCORRECT',
      });
    }
    break; // password validated against first encrypted entry
  }

  let projectName = 'Imported Project';
  let projectInfo: Record<string, string> | null = null;
  const devices: ParsedDevice[] = [];
  const groupAddresses: ParsedGroupAddress[] = [];
  const comObjects: ParsedComObject[] = [];
  const links: { deviceAddress: string; gaAddress: string }[] = [];
  const spaces: ParsedSpace[] = [];
  const devSpaceMap: Record<string, number> = {};
  const topologyEntries: TopologyEntry[] = [];

  for (const entry of installEntries) {
    // Try project.xml for name first
    const projKey = entry.entryName.replace('0.xml', 'project.xml');
    if (byName[projKey]) {
      try {
        let projBuf = byName[projKey]!.getData();
        if (looksEncrypted(projBuf)) projBuf = decryptEntry(projBuf, password!);
        const px = xmlParser.parse(projBuf.toString('utf8'));
        const pi = px?.KNX?.Project?.ProjectInformation;
        if (attr(pi, 'Name')) projectName = attr(pi, 'Name');
        if (pi) {
          projectInfo = {
            lastModified: attr(pi, 'LastModified') || '',
            projectStart: attr(pi, 'ProjectStart') || '',
            archivedVersion: attr(pi, 'ArchivedVersion') || '',
            comment: attr(pi, 'Comment') || '',
            completionStatus: attr(pi, 'CompletionStatus') || '',
            groupAddressStyle: attr(pi, 'GroupAddressStyle') || '',
            guid: attr(pi, 'Guid') || '',
          };
        }
      } catch (_) {}
    }

    let entryBuf = entry.getData();
    if (looksEncrypted(entryBuf)) {
      try {
        entryBuf = decryptEntry(entryBuf, password!);
      } catch (_) {
        console.error('[ETS] decrypt failed:', entry.entryName);
        continue;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let xml: any;
    try {
      xml = xmlParser.parse(entryBuf.toString('utf8'));
    } catch (e: unknown) {
      console.error('[ETS] 0.xml:', entry.entryName, (e as Error).message);
      continue;
    }

    const inst = xml?.KNX?.Project?.Installations?.Installation;
    const installation = Array.isArray(inst) ? inst[0] : inst;
    if (!installation) continue;

    // ── Group addresses ──────────────────────────────────────────────────────
    const gaById: Record<string, string> = {}; // fullId  → address string "0/0/1"
    const gaByShort: Record<string, string> = {}; // "GA-3"  → address string

    for (const mainGR of toArr(
      installation.GroupAddresses?.GroupRanges?.GroupRange,
    )) {
      const mainName = attr(mainGR, 'Name');
      for (const midGR of toArr(mainGR.GroupRange)) {
        const midName = attr(midGR, 'Name');
        for (const ga of toArr(midGR.GroupAddress)) {
          const flat = parseInt(attr(ga, 'Address'));
          const mainNum = (flat >> 11) & 0x1f;
          const midNum = (flat >> 8) & 0x07;
          const subNum = flat & 0xff;
          const addr = `${mainNum}/${midNum}/${subNum}`;
          const fullId = attr(ga, 'Id');
          const shortId = fullId.split('_').slice(-1)[0]!; // "GA-3"
          groupAddresses.push({
            address: addr,
            name: attr(ga, 'Name') || addr,
            dpt: attr(ga, 'DatapointType'),
            comment: attr(ga, 'Comment') || '',
            description: attr(ga, 'Description') || '',
            main: mainNum,
            mainGroupName: mainName,
            middle: midNum,
            middleGroupName: midName,
            sub: subNum,
          });
          if (fullId) gaById[fullId] = addr;
          if (shortId) gaByShort[shortId] = addr;
        }
      }
    }
    const resolveGA = (ref: string): string | null =>
      ref ? gaById[ref] || gaByShort[ref] || null : null;

    // ── Topology ─────────────────────────────────────────────────────────────
    const topology = installation.Topology;
    if (!topology) continue;

    const devInstById: Record<string, string> = {}; // DeviceInstance @Id → individual_address

    for (const area of toArr(topology.Area)) {
      const areaNum = parseInt(attr(area, 'Address')) || 0;
      const areaName = attr(area, 'Name');
      topologyEntries.push({
        area: areaNum,
        line: null,
        name: areaName || '',
        medium: 'TP',
      });
      for (const line of toArr(area.Line)) {
        const lineNum = parseInt(attr(line, 'Address')) || 0;
        const lineName = attr(line, 'Name');
        const mediumAttr =
          attr(line, 'MediumTypeRefId') ||
          attr(line, 'Medium') ||
          attr(line, 'DomainAddress') ||
          '';
        const mediumFromName = (() => {
          const n = lineName.toUpperCase();
          if (n.includes(' RF') || n.startsWith('RF ')) return 'RF';
          if (n.includes(' PL')) return 'PL';
          if (n.includes(' IP')) return 'IP';
          return '';
        })();
        const medium = mediumAttr || mediumFromName || 'TP';
        topologyEntries.push({
          area: areaNum,
          line: lineNum,
          name: lineName || '',
          medium,
        });

        const allDevs = [
          ...toArr(line.DeviceInstance),
          ...toArr(line.Segment).flatMap((s: XmlNode) =>
            toArr(s.DeviceInstance),
          ),
        ];

        for (const dev of allDevs) {
          const devNum = parseInt(attr(dev, 'Address')) || 0;
          const ia = `${areaNum}.${lineNum}.${devNum}`;
          const prodRef = attr(dev, 'ProductRefId');
          const h2pRef = attr(dev, 'Hardware2ProgramRefId');
          const hw: Partial<HwInfo> =
            hwByProd[prodRef] || hwByH2P[h2pRef] || ({} as Partial<HwInfo>);
          const appIdx = getAppIdx(h2pRef);

          // Serial: ETS stores as base64 — decode to hex
          let serial = attr(dev, 'SerialNumber') || hw.hwSerial || '';
          if (serial && !/^[0-9A-Fa-f]{8,}$/.test(serial)) {
            try {
              serial = Buffer.from(serial, 'base64')
                .toString('hex')
                .toUpperCase();
            } catch (_) {}
          }

          // Name: user-given name in ETS, else fall back to model
          const devName =
            attr(dev, 'Name') || attr(dev, 'Description') || hw.model || ia;

          // Track DeviceInstance Id so Locations can link back to this device
          const devInstId = attr(dev, 'Id');
          if (devInstId) devInstById[devInstId] = ia;

          // ── Parameters ─────────────────────────────────────────────────────
          const parameters: ResolvedParam[] = [];
          const pirEls = toArr(dev.ParameterInstanceRefs?.ParameterInstanceRef);

          // instanceValues: full instance key → raw value (from 0.xml)
          // strippedValues: stripped key (no _M-n_MI-n_) → raw value (first instance wins)
          // Both are used: instanceValues for reconstruction, strippedValues for condition eval
          const instanceValues = new Map<string, string>();
          const strippedValues = new Map<string, string>();
          const seenModInstances = new Set<string>();

          for (const pir of pirEls) {
            const refId = attr(pir, 'RefId');
            const value = attr(pir, 'Value');
            if (!refId) continue;
            instanceValues.set(refId, value);
            const sk = refId.replace(/_M-\d+_MI-\d+/g, '');
            if (!strippedValues.has(sk)) strippedValues.set(sk, value);
            const mMatch = refId.match(/^(.+_MD-\d+_M-\d+)_MI-(\d+)_/);
            if (mMatch) seenModInstances.add(`${mMatch[1]}_MI-${mMatch[2]}`);
          }

          // Supplement module instances up to their declared Count
          if (appIdx?.moduleKeys) {
            for (const mk of appIdx.moduleKeys) {
              const modInfo = appIdx.getModArgs?.(mk);
              const count = Number(modInfo?._count) || 1;
              for (let i = 1; i <= count; i++) {
                const miKey = `${mk}_MI-${i}`;
                if (!seenModInstances.has(miKey)) seenModInstances.add(miKey);
              }
            }
          }

          // Evaluate Dynamic conditions with this device's parameter values.
          // getVal returns the RAW value (not display-translated) for condition checks.
          let activeParams: Set<string> | null = null,
            activeCorefsByObjNum: Map<
              number,
              { corId: string; channel: string }[]
            > | null = null;
          if (appIdx?.evalDynamic) {
            const getVal = (prKey: string) =>
              strippedValues.get(prKey) ?? appIdx.getDefault(prKey);
            ({ activeParams, activeCorefsByObjNum } =
              appIdx.evalDynamic(getVal));
          }

          if (appIdx?.resolveParamRef) {
            if (appIdx.paramRefKeys) {
              for (const prKey of appIdx.paramRefKeys) {
                // Skip params hidden by Dynamic conditions
                if (activeParams && !activeParams.has(prKey)) continue;

                const modMatch = prKey.match(/^(.+_MD-\d+)_(.+)$/);
                if (modMatch) {
                  const mdBase = modMatch[1];
                  const rest = modMatch[2];
                  for (const mi of seenModInstances) {
                    const miMatch = mi.match(/^(.+_MD-\d+)_(M-\d+)_(MI-\d+)$/);
                    if (!miMatch || miMatch[1] !== mdBase) continue;
                    const instanceKey = `${mdBase}_${miMatch[2]}_${miMatch[3]}_${rest}`;
                    const value = instanceValues.has(instanceKey)
                      ? instanceValues.get(instanceKey)!
                      : appIdx.getDefault(prKey);
                    if (value == null) continue;
                    const resolved = appIdx.resolveParamRef(instanceKey, value);
                    if (resolved) parameters.push(resolved);
                  }
                } else {
                  const value = instanceValues.has(prKey)
                    ? instanceValues.get(prKey)!
                    : appIdx.getDefault(prKey);
                  if (value == null) continue;
                  const resolved = appIdx.resolveParamRef(prKey, value);
                  if (resolved) parameters.push(resolved);
                }
              }
            } else {
              for (const [refId, value] of instanceValues) {
                const resolved = appIdx.resolveParamRef(refId, value);
                if (resolved) parameters.push(resolved);
              }
            }
          }

          devices.push({
            individual_address: ia,
            name: devName,
            description: attr(dev, 'Description') || '',
            comment: attr(dev, 'Comment') || '',
            installation_hints: attr(dev, 'InstallationHints') || '',
            manufacturer: hw.manufacturer || '',
            model: hw.model || '',
            order_number: hw.orderNumber || '',
            serial_number: serial,
            product_ref: prodRef,
            area: areaNum,
            area_name: areaName,
            line: lineNum,
            line_name: lineName,
            medium,
            device_type: inferType(devName, prodRef, hw.model || '', hw),
            status: attr(dev, 'LastDownload') ? 'programmed' : 'unassigned',
            last_modified: attr(dev, 'LastModified'),
            last_download: attr(dev, 'LastDownload'),
            apdu_length: attr(dev, 'LastUsedAPDULength') || '',
            app_loaded: attr(dev, 'ApplicationProgramLoaded') === 'true',
            comm_loaded: attr(dev, 'CommunicationPartLoaded') === 'true',
            ia_loaded: attr(dev, 'IndividualAddressLoaded') === 'true',
            params_loaded: attr(dev, 'ParametersLoaded') === 'true',
            app_number: '',
            app_version: '',
            parameters,
            app_ref: appIdx?.appId || '',
            param_values: Object.fromEntries(instanceValues),
            model_translations: hw.modelTranslations || null,
            bus_current: hw.busCurrent || 0,
            width_mm: hw.widthMm || 0,
            is_power_supply: hw.isPowerSupply || false,
            is_coupler: hw.isCoupler || false,
            is_rail_mounted: hw.isRailMounted || false,
          });

          // ── ComObjects ───────────────────────────────────────────────────
          for (const cor of toArr(
            dev.ComObjectInstanceRefs?.ComObjectInstanceRef,
          )) {
            const refId = attr(cor, 'RefId');
            const channelId = attr(cor, 'ChannelId');
            const linksAttr = attr(cor, 'Links');

            // Skip direction-label Text on instance refs — these are generic placeholders, not user-given names
            const DIRECTION_RE =
              /^(input|output|input\/output|in|out|eingang|ausgang|ein\/ausgang|ein|aus|entrée|sortie|entrée\/sortie|ingresso|uscita|ingresso\/uscita|entrada|salida|entrada\/salida)$/i;
            let name = DIRECTION_RE.test(attr(cor, 'Text'))
              ? ''
              : attr(cor, 'Text') || '';
            let dpt = attr(cor, 'DatapointType') || '';
            let function_text = '';
            let objectSize = '';
            let channel = '';
            let read = false,
              write = false,
              comm = false,
              tx = false;
            // Fallback: extract base object number from O-{n} pattern in refId
            let objNum = parseInt(
              (refId.match(/(?:^|_)O-(\d+)/) || [])[1] ?? '0',
            );

            if (appIdx) {
              const resolved = appIdx.resolveCoRef(refId, channelId);
              if (resolved) {
                if (!name) name = resolved.name;
                function_text = resolved.function_text || '';
                if (!dpt) dpt = resolved.dpt;
                objectSize = resolved.objectSize;
                channel = resolved.channel;
                read = resolved.read;
                write = resolved.write;
                comm = resolved.comm;
                tx = resolved.tx;
                objNum = resolved.objectNumber ?? objNum;
              }
              // Also merge overrides from the active Dynamic tree variants
              if (activeCorefsByObjNum && objNum != null) {
                const dynEntries = activeCorefsByObjNum.get(objNum);
                if (dynEntries) {
                  for (const { corId, channel: ch } of dynEntries) {
                    const r = appIdx.resolveCoRefById(corId);
                    if (!r) continue;
                    if (r.name) name = r.name;
                    if (r.function_text) function_text = r.function_text;
                    if (r.dpt) dpt = r.dpt;
                    if (r.objectSize) objectSize = r.objectSize;
                    if (ch) channel = ch;
                  }
                }
              }
            }

            const updateFlag = attr(cor, 'UpdateFlag') === 'Enabled';
            const flags = buildFlags({ read, write, comm, tx, u: updateFlag });
            const coObj: ParsedComObject = {
              device_address: ia,
              object_number: objNum,
              channel,
              name,
              function_text,
              dpt,
              object_size: objectSize,
              flags,
              direction:
                tx && !write ? 'output' : !tx && write ? 'input' : 'both',
              ga_address: '',
              ga_send: '',
              ga_receive: '',
            };

            const coGAs: string[] = [],
              coSend: string[] = [],
              coRecv: string[] = [];
            const addGA = (
              gaAddr: string,
              isSend: boolean,
              isRecv: boolean,
            ) => {
              if (!coGAs.includes(gaAddr)) {
                coGAs.push(gaAddr);
                links.push({ deviceAddress: ia, gaAddress: gaAddr });
              }
              if (isSend && !coSend.includes(gaAddr)) coSend.push(gaAddr);
              if (isRecv && !coRecv.includes(gaAddr)) coRecv.push(gaAddr);
            };

            // Links attribute: the first GA is the "Sending" address (marked S in
            // ETS6). For COs with both T+W flags:
            //   - First GA: transmit only (the object sends on this address)
            //   - Remaining GAs: receive only (the object listens on these)
            // For COs with only T or only W, all GAs share the same direction.
            const gaRefs = (linksAttr || '').split(/\s+/).filter(Boolean);
            const hasBoth = tx && (write || updateFlag);
            gaRefs.forEach((gaRef, idx) => {
              const gaAddr = resolveGA(gaRef);
              if (!gaAddr) return;
              if (hasBoth) {
                // First = send, rest = receive
                addGA(gaAddr, idx === 0, idx !== 0);
              } else {
                addGA(gaAddr, !!tx, !!(write || updateFlag));
              }
            });

            // Legacy nested Connectors: explicit per-GA direction
            for (const conn of toArr(cor.Connectors?.Send)) {
              const gaAddr = resolveGA(attr(conn, 'GroupAddressRefId'));
              if (gaAddr) addGA(gaAddr, true, false);
            }
            for (const conn of toArr(cor.Connectors?.Receive)) {
              const gaAddr = resolveGA(attr(conn, 'GroupAddressRefId'));
              if (gaAddr) addGA(gaAddr, false, true);
            }

            coObj.ga_address = coGAs.join(' ');
            coObj.ga_send = coSend.join(' ');
            coObj.ga_receive = coRecv.join(' ');

            comObjects.push(coObj);
          }

          // ── Supplement: active-but-unlinked COM objects ───────────────────
          // evalDynamic identified all COM objects valid for the current config.
          // Any that didn't appear in 0.xml have no GA assigned — add them
          // so the user can see and assign them without going back to ETS.
          if (activeCorefsByObjNum && appIdx?.resolveCoRefById) {
            // Track which physical object numbers are already covered by 0.xml entries
            const linkedObjNums = new Set(
              toArr(dev.ComObjectInstanceRefs?.ComObjectInstanceRef)
                .map((cor: XmlNode) => {
                  const refId = attr(cor, 'RefId');
                  if (!refId) return null;
                  const r = appIdx.resolveCoRef(refId, attr(cor, 'ChannelId'));
                  return r ? r.objectNumber : null;
                })
                .filter((n: number | null) => n != null),
            );

            // For each object number, resolve all active ComObjectRef variants and merge
            for (const [objNum, dynEntries] of activeCorefsByObjNum) {
              try {
                if (linkedObjNums.has(objNum)) continue;
                // Resolve each variant and merge: later overrides win per-attribute
                let merged: {
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
                } | null = null;
                let mergedChannel = '';
                for (const { corId, channel: ch } of dynEntries) {
                  const r = appIdx.resolveCoRefById(corId);
                  if (!r) continue;
                  if (ch) mergedChannel = ch;
                  if (!merged) {
                    merged = { ...r };
                  } else {
                    // Layer overrides: non-empty values from later variants win
                    if (r.name) merged.name = r.name;
                    if (r.function_text) merged.function_text = r.function_text;
                    if (r.dpt) merged.dpt = r.dpt;
                    if (r.objectSize) merged.objectSize = r.objectSize;
                  }
                }
                if (!merged || (!merged.name && !merged.function_text))
                  continue;
                comObjects.push({
                  device_address: ia,
                  object_number: merged.objectNumber,
                  channel: mergedChannel || merged.channel,
                  name: merged.name,
                  function_text: merged.function_text,
                  dpt: merged.dpt,
                  object_size: merged.objectSize,
                  flags: buildFlags(merged),
                  direction:
                    merged.tx && !merged.write
                      ? 'output'
                      : !merged.tx && merged.write
                        ? 'input'
                        : 'both',
                  ga_address: '',
                });
              } catch (e: unknown) {
                console.error(
                  '[ETS] CO merge error:',
                  objNum,
                  (e as Error).message,
                );
              }
            }
          }
        }
      }
    }

    // ── Locations / building structure ───────────────────────────────────────
    if (installation.Locations) {
      parseLocationsRec(
        toArr(installation.Locations.Space),
        null,
        spaces,
        devSpaceMap,
        devInstById,
      );
    }
  }

  // Deduplicate links
  const seen = new Set<string>();
  const uLinks = links.filter((l) => {
    const k = `${l.deviceAddress}||${l.gaAddress}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });

  // Build param models for all app programs found
  const paramModels: Record<string, ParamModel> = {};
  for (const [aid, idx] of Object.entries(appByAppId)) {
    try {
      const m = idx.buildParamModel?.();
      if (m) {
        // Also attach loadProcedures so the client/downloader can use them
        m.loadProcedures = idx.loadProcedures || [];
        paramModels[aid] = m;
      }
    } catch (e) {
      console.error(
        `[ETS] buildParamModel failed for ${aid}:`,
        (e as Error).message,
      );
    }
  }

  // ── Project thumbnail ──────────────────────────────────────────────────────
  let thumbnail: string | null = null;
  const jpgEntry = entries.find((e) => /project\.jpg$/i.test(e.entryName));
  if (jpgEntry) {
    try {
      thumbnail = jpgEntry.getData().toString('base64');
    } catch (_) {}
  }

  return {
    projectName,
    devices,
    groupAddresses,
    comObjects,
    links: uLinks,
    spaces,
    devSpaceMap,
    paramModels,
    thumbnail,
    projectInfo,
    knxMasterXml,
    catalogSections,
    catalogItems,
    topologyEntries,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function inferType(
  name: string,
  productRef: string,
  model: string,
  hw: Partial<HwInfo> = {},
): string {
  if (hw.isCoupler) return 'router';
  const n = `${name} ${productRef} ${model}`.toLowerCase();
  if (/router|ip.?coupl|backbone|knxip/.test(n)) return 'router';
  if (
    /sensor|button|push|detect|weather|temp|co2|presence|motion|bs\.tp|keypad|panel|scene/.test(
      n,
    )
  )
    return 'sensor';
  return 'actuator';
}

export function buildFlags({
  read,
  write,
  comm,
  tx,
  u,
}: {
  read?: boolean;
  write?: boolean;
  comm?: boolean;
  tx?: boolean;
  u?: boolean;
}): string {
  return (
    [comm && 'C', read && 'R', write && 'W', tx && 'T', u && 'U']
      .filter(Boolean)
      .join('') || 'CW'
  );
}
