'use strict';
const path = require('path');
const fs   = require('fs');
const { XMLParser } = require('fast-xml-parser');

// ── Per-project knx_master.xml ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const APPS_DIR = path.join(DATA_DIR, 'apps');
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

function masterXmlPath(projectId) {
  return path.join(DATA_DIR, `knx_master_${projectId}.xml`);
}

function saveMasterXml(projectId, xml) {
  if (!xml) return;
  fs.writeFileSync(masterXmlPath(projectId), xml);
}

function readMasterXml(projectId) {
  if (!projectId) return null;
  const p = masterXmlPath(projectId);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return null;
}

// Caches keyed by projectId
const _dptInfoCache = {};
const _spaceUsageCache = {};
const _translationCache = {};
const _mediumTypeCache = {};
const _maskVersionCache = {};

const toArr = v => v == null ? [] : Array.isArray(v) ? v : [v];

function parseMasterXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: name => ['DatapointType','DatapointSubtype','Float','UnsignedInteger','SignedInteger',
      'Enumeration','EnumValue','Bit','MaskVersion','Language','TranslationUnit',
      'TranslationElement','Translation','SpaceUsage','MediumType','FunctionType','FunctionPoint'].includes(name),
  });
  return parser.parse(xml);
}

function getDptInfo(projectId) {
  if (_dptInfoCache[projectId]) return _dptInfoCache[projectId];
  const xml = readMasterXml(projectId);
  if (!xml) return (_dptInfoCache[projectId] = {});
  const root = parseMasterXml(xml);
  const dptTypes = root?.KNX?.MasterData?.DatapointTypes?.DatapointType || [];
  const result = {};
  for (const dpt of dptTypes) {
    const mainNum = dpt['@_Number'];
    const sizeInBit = parseInt(dpt['@_SizeInBit']) || 0;
    for (const sub of toArr(dpt?.DatapointSubtypes?.DatapointSubtype)) {
      const key = `${mainNum}.${String(sub['@_Number']).padStart(3, '0')}`;
      const fmt = sub?.Format || {};
      let unit = '', enums = null, coefficient = null;

      for (const tag of ['Float','UnsignedInteger','SignedInteger']) {
        const arr = toArr(fmt[tag]);
        if (arr.length) {
          unit = arr[0]['@_Unit'] || '';
          if (arr[0]['@_Coefficient']) coefficient = parseFloat(arr[0]['@_Coefficient']);
          break;
        }
      }

      const bits = toArr(fmt.Bit);
      if (bits.length) {
        const b = bits[0];
        enums = { 0: b['@_Cleared'] || '0', 1: b['@_Set'] || '1' };
      }

      const enumEl = toArr(fmt.Enumeration);
      if (enumEl.length) {
        enums = {};
        for (const ev of toArr(enumEl[0].EnumValue)) {
          enums[Number(ev['@_Value'])] = ev['@_Text'] || String(ev['@_Value']);
        }
      }

      result[key] = {
        name: sub['@_Name'] || '',
        text: sub['@_Text'] || '',
        unit, sizeInBit,
        ...(coefficient != null ? { coefficient } : {}),
        ...(enums ? { enums } : {}),
      };
    }
  }
  return (_dptInfoCache[projectId] = result);
}

// Build a tracked UPDATE helper: collects SET clauses, values, and audit diffs
function makeTracker(old) {
  const sets = [], vals = [], diffs = [];
  const track = (col, newVal) => { sets.push(`${col}=?`); vals.push(newVal); diffs.push(`${col}: "${old[col] ?? ''}" → "${newVal}"`); };
  return { track, sets, vals, diffs };
}

// Save param models to disk
function saveModelsAndMasterXml(paramModels, knxMasterXml, projectId) {
  if (paramModels) {
    for (const [appId, model] of Object.entries(paramModels)) {
      try {
        const safe = appId.replace(/[^a-zA-Z0-9_\-]/g, '_');
        fs.writeFileSync(path.join(APPS_DIR, safe + '.json'), JSON.stringify(model));
      } catch (_) {}
    }
  }
  if (knxMasterXml) saveMasterXml(projectId, knxMasterXml);
}

module.exports = {
  DATA_DIR,
  APPS_DIR,
  saveMasterXml,
  readMasterXml,
  parseMasterXml,
  getDptInfo,
  makeTracker,
  saveModelsAndMasterXml,
  toArr,
  _spaceUsageCache,
  _translationCache,
  _mediumTypeCache,
  _maskVersionCache,
};
