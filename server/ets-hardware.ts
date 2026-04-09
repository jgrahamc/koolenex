/**
 * ETS hardware and catalog extraction.
 *
 * Parses M-XXXX/Hardware.xml and M-XXXX/Catalog.xml files to build
 * hardware product maps and catalog section/item lists.
 */

import { logger } from './log.ts';
import {
  xmlParser,
  toArr,
  attr,
  type XmlNode,
} from './ets-parser.ts';
import type { ZipEntry } from './ets-zip.ts';
import type { HwInfo } from './ets-app.ts';

export interface CatalogSection {
  id: string;
  name: string;
  number: string;
  parent_id: string | null;
  mfr_id: string;
  manufacturer: string;
}

export interface CatalogItem {
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

/** Extract manufacturer names from knx_master.xml. */
export function parseMfrNames(
  entries: ZipEntry[],
): { mfrById: Record<string, string>; knxMasterXml: string | null } {
  const mfrById: Record<string, string> = {};
  const byName: Record<string, ZipEntry> = Object.fromEntries(
    entries.map((e) => [e.entryName, e]),
  );
  const masterE =
    byName['knx_master.xml'] ||
    entries.find((e) => e.entryName.endsWith('/knx_master.xml'));
  let knxMasterXml: string | null = null;
  if (masterE) {
    try {
      knxMasterXml = masterE.getData().toString('utf8');
      const mx = xmlParser.parse(knxMasterXml);
      for (const m of toArr(mx?.KNX?.MasterData?.Manufacturers?.Manufacturer))
        if (attr(m, 'Id')) mfrById[attr(m, 'Id')] = attr(m, 'Name');
    } catch (_) {}
  }
  return { mfrById, knxMasterXml };
}

/** Parse Hardware.xml files and build product/H2P lookup maps. */
export function parseHardware(
  entries: ZipEntry[],
  mfrById: Record<string, string>,
): { hwByProd: Record<string, HwInfo>; hwByH2P: Record<string, HwInfo> } {
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
      logger.error('ets', 'Hardware.xml parse error', {
        error: (e as Error).message,
      });
    }
  }

  return { hwByProd, hwByH2P };
}

/** Parse Catalog.xml files and build catalog section/item lists. */
export function parseCatalog(
  entries: ZipEntry[],
  mfrById: Record<string, string>,
  hwByProd: Record<string, HwInfo>,
  hwByH2P: Record<string, HwInfo>,
): { catalogSections: CatalogSection[]; catalogItems: CatalogItem[] } {
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
      logger.error('ets', 'Catalog.xml parse error', {
        error: (e as Error).message,
      });
    }
  }

  return { catalogSections, catalogItems };
}
