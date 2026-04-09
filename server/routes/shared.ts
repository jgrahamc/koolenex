import path from 'path';
import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import type { DptInfoEntry } from '../../shared/types.ts';
import { logger } from '../log.ts';

/** Max upload size for .knxproj / .knxprod / floor-plan files (50 MB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// ── Per-project knx_master.xml ─────────────────────────────────────────────────
export const DATA_DIR = path.join(process.cwd(), 'data');
export const APPS_DIR = path.join(DATA_DIR, 'apps');
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

function masterXmlPath(projectId: string | number): string {
  return path.join(DATA_DIR, `knx_master_${projectId}.xml`);
}

export function saveMasterXml(
  projectId: string | number,
  xml: string | null | undefined,
): void {
  if (!xml) return;
  fs.writeFileSync(masterXmlPath(projectId), xml);
}

export function readMasterXml(
  projectId: string | number | null | undefined,
): string | null {
  if (!projectId) return null;
  const p = masterXmlPath(projectId);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Caches keyed by projectId
const _dptInfoCache: Record<string | number, Record<string, DptInfoEntry>> = {};
export const _spaceUsageCache: Record<string | number, unknown> = {};
export const _translationCache: Record<string | number, unknown> = {};
export const _mediumTypeCache: Record<string | number, unknown> = {};
export const _maskVersionCache: Record<string | number, unknown> = {};

export const toArr = <T>(v: T | T[] | null | undefined): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

export function parseMasterXml(xml: string): Record<string, unknown> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name: string) =>
      [
        'DatapointType',
        'DatapointSubtype',
        'Float',
        'UnsignedInteger',
        'SignedInteger',
        'Enumeration',
        'EnumValue',
        'Bit',
        'MaskVersion',
        'Language',
        'TranslationUnit',
        'TranslationElement',
        'Translation',
        'SpaceUsage',
        'MediumType',
        'FunctionType',
        'FunctionPoint',
      ].includes(name),
  });
  return parser.parse(xml) as Record<string, unknown>;
}

interface XmlElement {
  [key: string]: unknown;
}

export function getDptInfo(
  projectId: string | number,
): Record<string, DptInfoEntry> {
  if (_dptInfoCache[projectId]) return _dptInfoCache[projectId]!;
  const xml = readMasterXml(projectId);
  if (!xml) return (_dptInfoCache[projectId] = {});
  const root = parseMasterXml(xml) as {
    KNX?: {
      MasterData?: { DatapointTypes?: { DatapointType?: XmlElement[] } };
    };
  };
  const dptTypes = root?.KNX?.MasterData?.DatapointTypes?.DatapointType ?? [];
  const result: Record<string, DptInfoEntry> = {};
  for (const dpt of dptTypes) {
    const mainNum = dpt['@_Number'] as string;
    const sizeInBit = parseInt(dpt['@_SizeInBit'] as string, 10) || 0;
    for (const sub of toArr(
      (dpt as { DatapointSubtypes?: { DatapointSubtype?: XmlElement[] } })
        ?.DatapointSubtypes?.DatapointSubtype,
    )) {
      const key = `${mainNum}.${String((sub as XmlElement)['@_Number']).padStart(3, '0')}`;
      const fmt = ((sub as XmlElement)?.Format ?? {}) as XmlElement;
      let unit = '';
      let enums: Record<number, string> | undefined;
      let coefficient: number | undefined;

      for (const tag of ['Float', 'UnsignedInteger', 'SignedInteger']) {
        const arr = toArr(fmt[tag] as XmlElement[] | XmlElement | null);
        if (arr.length) {
          unit = ((arr[0] as XmlElement)['@_Unit'] as string) || '';
          const coeff = (arr[0] as XmlElement)['@_Coefficient'];
          if (coeff) coefficient = parseFloat(coeff as string);
          break;
        }
      }

      const bits = toArr(fmt.Bit as XmlElement[] | XmlElement | null);
      if (bits.length) {
        const b = bits[0] as XmlElement;
        enums = {
          0: (b['@_Cleared'] as string) || '0',
          1: (b['@_Set'] as string) || '1',
        };
      }

      const enumEl = toArr(fmt.Enumeration as XmlElement[] | XmlElement | null);
      if (enumEl.length) {
        enums = {};
        for (const ev of toArr(
          (enumEl[0] as XmlElement).EnumValue as
            | XmlElement[]
            | XmlElement
            | null,
        )) {
          const e = ev as XmlElement;
          enums[Number(e['@_Value'])] =
            (e['@_Text'] as string) || String(e['@_Value']);
        }
      }

      result[key] = {
        name: ((sub as XmlElement)['@_Name'] as string) || '',
        text: ((sub as XmlElement)['@_Text'] as string) || '',
        unit,
        sizeInBit,
        ...(coefficient != null ? { coefficient } : {}),
        ...(enums ? { enums } : {}),
      };
    }
  }
  return (_dptInfoCache[projectId] = result);
}

export interface UpdateBuilder {
  track: (col: string, newVal: unknown) => void;
  sets: string[];
  vals: unknown[];
  diffs: string[];
}

export function makeUpdateBuilder<T extends object>(old: T): UpdateBuilder {
  const rec = old as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const diffs: string[] = [];
  const track = (col: string, newVal: unknown): void => {
    sets.push(`${col}=?`);
    vals.push(newVal);
    diffs.push(`${col}: "${rec[col] ?? ''}" → "${newVal}"`);
  };
  return { track, sets, vals, diffs };
}

export function saveModelsAndMasterXml(
  paramModels: Record<string, unknown> | null | undefined,
  knxMasterXml: string | null | undefined,
  projectId: string | number,
): void {
  if (paramModels) {
    for (const [appId, model] of Object.entries(paramModels)) {
      const safe = appId.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        fs.writeFileSync(
          path.join(APPS_DIR, safe + '.json'),
          JSON.stringify(model),
        );
      } catch (e) {
        logger.warn('ets', `failed to write model ${safe}.json`, {
          error: (e as Error).message,
        });
      }
    }
  }
  if (knxMasterXml) saveMasterXml(projectId, knxMasterXml);
}
