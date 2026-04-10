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

import { XMLParser } from 'fast-xml-parser';
import { logger } from './log.ts';
import {
  openZip,
  looksEncrypted,
  deriveZipPassword,
  decryptEntry,
} from './ets-zip.ts';
import type { ZipEntry } from './ets-zip.ts';
import { buildAppIndex } from './ets-app.ts';
import type { AppIndex, HwInfo, ParamModel } from './ets-app.ts';
import { parseMfrNames, parseHardware, parseCatalog } from './ets-hardware.ts';
import type { CatalogSection, CatalogItem } from './ets-hardware.ts';

// Re-export for backward compatibility — these are the public API symbols
// that external modules import from ets-parser.ts.
export { looksEncrypted } from './ets-zip.ts';
export type {
  HwInfo,
  ParamModel,
  DynItem,
  LoadProcedureStep,
  ParamModelEntry,
  ParamMemLayoutEntry,
} from './ets-app.ts';
export type { CatalogSection, CatalogItem } from './ets-hardware.ts';

// ─── XML node types ──────────────────────────────────────────────────────────
// fast-xml-parser returns untyped objects. These aliases are semantically
// clearer than `any` — they say "parsed XML node with unknown structure".
export type XmlNode = Record<string, unknown>;
export type OrdXmlNode = Record<string, unknown>;

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
  'LdCtrlConnect',
  'LdCtrlDisconnect',
  'LdCtrlRestart',
  'LdCtrlUnload',
  'LdCtrlLoad',
  'LdCtrlTaskSegment',
  'LdCtrlLoadCompleted',
  'RelativeSegment',
  'AbsoluteSegment',
  'Channel',
]);

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name: string) => ALWAYS_ARRAY.has(name),
  processEntities: true, // decode &#xD; &#xA; etc. at parse time
  htmlEntities: true, // also handle &amp; &lt; etc.
});

// ─── Order-preserving parser for Dynamic sections ────────────────────────────
export const orderedXmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  htmlEntities: true,
  trimValues: false,
});

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const toArr = (v: any): any[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

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
export const attr = (el: XmlNode | unknown, name: string): string =>
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

export const ordAttr = (
  el: OrdXmlNode | null | undefined,
  name: string,
): string =>
  sanitizeText(
    (el?.[':@'] as Record<string, unknown> | undefined)?.[`@_${name}`] ?? '',
  );
export const ordRawAttr = (
  el: OrdXmlNode | null | undefined,
  name: string,
): string =>
  (
    ((el?.[':@'] as Record<string, unknown> | undefined)?.[`@_${name}`] ??
      '') as string | number
  ).toString();
export const ordTagName = (
  el: OrdXmlNode | null | undefined,
): string | undefined => Object.keys(el || {}).find((k) => k !== ':@');
export const ordChildNodes = (
  el: OrdXmlNode | null | undefined,
): OrdXmlNode[] => {
  const tag = ordTagName(el);
  const c = tag ? el?.[tag] : null;
  return Array.isArray(c) ? (c as OrdXmlNode[]) : [];
};

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

interface TopologyEntry {
  area: number;
  line: number | null;
  name: string;
  medium: string;
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
  const { mfrById, knxMasterXml } = parseMfrNames(entries);

  // ── Hardware lookup ────────────────────────────────────────────────────────
  const { hwByProd, hwByH2P } = parseHardware(entries, mfrById);

  // ── Catalog lookup ──────────────────────────────────────────────────────────
  const { catalogSections, catalogItems } = parseCatalog(
    entries,
    mfrById,
    hwByProd,
    hwByH2P,
  );

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
      logger.error('ets', 'app XML parse error', {
        error: (e as Error).message,
      });
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
        logger.error('ets', 'decrypt failed', { entry: entry.entryName });
        continue;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let xml: any;
    try {
      xml = xmlParser.parse(entryBuf.toString('utf8'));
    } catch (e: unknown) {
      logger.error('ets', '0.xml parse error', {
        entry: entry.entryName,
        error: (e as Error).message,
      });
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
          const flat = parseInt(attr(ga, 'Address'), 10);
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
      const areaNum = parseInt(attr(area, 'Address'), 10) || 0;
      const areaName = attr(area, 'Name');
      topologyEntries.push({
        area: areaNum,
        line: null,
        name: areaName || '',
        medium: 'TP',
      });
      for (const line of toArr(area.Line)) {
        const lineNum = parseInt(attr(line, 'Address'), 10) || 0;
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
          const devNum = parseInt(attr(dev, 'Address'), 10) || 0;
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
              10,
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
                logger.error('ets', 'CO merge error', {
                  objNum: String(objNum),
                  error: (e as Error).message,
                });
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
      logger.error('ets', `buildParamModel failed for ${aid}`, {
        error: (e as Error).message,
      });
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
