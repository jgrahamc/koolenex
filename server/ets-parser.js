'use strict';
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
 * Password-protected projects: ETS6 encrypts inner XML files with AES-256-CBC.
 *   Format: [20-byte salt][4-byte iteration count BE][16-byte IV][ciphertext]
 *   Key:    PBKDF2-HMAC-SHA256(password_utf16le, salt, iterations, 32)
 */

const AdmZip        = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const crypto        = require('crypto');


// ─── Encryption helpers ───────────────────────────────────────────────────────

/** Returns true if the buffer is not plaintext XML (i.e. likely AES-encrypted). */
function looksEncrypted(buf) {
  if (!buf || buf.length < 2) return false;
  // Skip leading whitespace and BOM
  let i = 0;
  // UTF-8 BOM (EF BB BF)
  if (buf[0] === 0xef && buf[1] === 0xbb) i = 3;
  // Skip whitespace (space, tab, newline, carriage return)
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  // Plain XML starts with '<'
  if (i < buf.length && buf[i] === 0x3c) return false;
  return true;
}

/**
 * Decrypt an ETS6-encrypted file buffer using the given password.
 * Throws with code 'PASSWORD_INCORRECT' if padding is invalid.
 */
function decryptEntry(buf, password) {
  if (buf.length < 40) throw Object.assign(new Error('Encrypted file too short'), { code: 'PASSWORD_INCORRECT' });
  const salt       = buf.slice(0, 20);
  const iterations = buf.readUInt32BE(20);
  const iv         = buf.slice(24, 40);
  const data       = buf.slice(40);
  const key        = crypto.pbkdf2Sync(Buffer.from(password, 'utf16le'), salt, iterations, 32, 'sha256');
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    throw Object.assign(new Error('Incorrect password'), { code: 'PASSWORD_INCORRECT' });
  }
}

// ─── XML parser ───────────────────────────────────────────────────────────────
const ALWAYS_ARRAY = new Set([
  'Area','Line','Segment','DeviceInstance',
  'GroupRange','GroupAddress',
  'ComObjectInstanceRef','Send','Receive',
  'Manufacturer',
  'ComObject','ComObjectRef',
  'Module','NumericArg','Argument',
  'Language','TranslationUnit','TranslationElement','Translation',
  'Hardware','Product','Hardware2Program',
  'Space','DeviceInstanceRef',
  'ParameterBlock','Parameter','ParameterRef','ParameterInstanceRef',
  'ParameterType','Enumeration','Union','ParameterRefRef','ComObjectRefRef','choose','when','ChannelIndependentBlock',
  'LoadProcedure',
  'LdCtrlRelSegment','LdCtrlWriteProp','LdCtrlCompareProp','LdCtrlWriteRelMem','LdCtrlLoadImageProp',
  'LdCtrlAbsSegment',
  'RelativeSegment','AbsoluteSegment','Channel',
]);

const xmlParser = new XMLParser({
  ignoreAttributes    : false,
  attributeNamePrefix : '@_',
  isArray             : name => ALWAYS_ARRAY.has(name),
  processEntities     : true,   // decode &#xD; &#xA; etc. at parse time
  htmlEntities        : true,   // also handle &amp; &lt; etc.
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
const ordA = (el, name) => clean(el?.[':@']?.[`@_${name}`] ?? '');
const ordRaw = (el, name) => (el?.[':@']?.[`@_${name}`] ?? '').toString();
const ordTag = (el) => Object.keys(el || {}).find(k => k !== ':@');
const ordChildren = (el) => { const tag = ordTag(el); const c = tag ? el[tag] : null; return Array.isArray(c) ? c : []; };

// ─── Tiny helpers ─────────────────────────────────────────────────────────────
const toArr  = v  => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Sanitize a string value from an ETS attribute.
 * Strategy:
 *   1. Decode all numeric XML character references (&#xD; → \r, &#10; → \n, etc.)
 *      so they become actual characters regardless of whether fast-xml-parser
 *      decoded them already.
 *   2. Remove every ASCII control character (codes 0–31 and 127) that results.
 *   3. Collapse runs of whitespace and trim.
 */
const clean = s => {
  let str = (s ?? '').toString();
  // Decode hex numeric character references: &#xD; &#x0D; &#XA; etc.
  str = str.replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // Decode decimal numeric character references: &#13; &#10; etc.
  str = str.replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // Strip all ASCII control characters (NUL–US and DEL)
  str = str.replace(/[\x00-\x1F\x7F]+/g, ' ');
  return str.replace(/ {2,}/g, ' ').trim();
};
const a    = (el, name) => clean(el?.[`@_${name}`] ?? '');
const interp = (tpl, map) =>
  clean((tpl || '')
    // Named args: {{argCH}} → map.argCH ?? ''
    .replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? '')
    // Numbered args with default text: {{0: Channel A}} → use default text if arg 0 not in map
    .replace(/\{\{(\d+)\s*:\s*([^}]*)\}\}/g, (_, n, def) => map[n] ?? def.trim())
  ).replace(/[\s:\-–—]+$/, '').trim();

// ─── Build per-application-program index ─────────────────────────────────────
function buildAppIndex(buf) {
  const rawXml = buf.toString('utf8');
  let xml;
  try { xml = xmlParser.parse(rawXml); }
  catch (e) { console.error('[ETS] app parse:', e.message); return null; }

  const mfrNode = toArr(xml?.KNX?.ManufacturerData?.Manufacturer)[0];
  if (!mfrNode) return null;

  // ApplicationProgram may be single object (not array) even with isArray=false for it
  const apRaw = mfrNode?.ApplicationPrograms?.ApplicationProgram;
  const ap    = Array.isArray(apRaw) ? apRaw[0] : apRaw;
  if (!ap) return null;

  const appId = a(ap, 'Id');

  // Parse entire app XML with order-preserving parser to extract Dynamic sections
  // and ParameterBlock indent levels (leading spaces in Text attributes that the
  // main parser trims).
  let orderedDynamic = null;
  const orderedModDynamics = {};
  const pbIndentMap = {};
  try {
    const orderedXml = orderedXmlParser.parse(rawXml);

    // Walk ordered tree to collect ParameterBlock Text indent levels.
    // ETS uses leading spaces in ParameterBlock Text to encode visual hierarchy.
    // The ordered parser is configured with trimValues:false so we can count them.
    const collectPbIndents = (items) => {
      if (!Array.isArray(items)) return;
      for (const el of items) {
        const tag = ordTag(el);
        if (!tag || tag === '#text' || tag === '?xml') continue;
        if (tag === 'ParameterBlock') {
          const id = ordA(el, 'Id');
          const rawText = ordRaw(el, 'Text');
          if (id && rawText) {
            const leadingSpaces = rawText.match(/^(\s*)/)[1].length;
            if (leadingSpaces > 0) pbIndentMap[id] = leadingSpaces;
          }
        }
        collectPbIndents(ordChildren(el));
      }
    };
    collectPbIndents(orderedXml);
    // Navigate: KNX > ManufacturerData > Manufacturer > ApplicationPrograms > ApplicationProgram > Dynamic
    const findDynamic = (items) => {
      if (!items) return null;
      for (const el of Array.isArray(items) ? items : [items]) {
        const tag = ordTag(el);
        if (tag === 'Dynamic') return ordChildren(el);
        // Recurse into known container elements
        for (const key of ['KNX', 'ManufacturerData', 'Manufacturer', 'ApplicationPrograms', 'ApplicationProgram']) {
          if (tag === key) {
            const result = findDynamic(ordChildren(el));
            if (result) return result;
          }
        }
      }
      return null;
    };
    orderedDynamic = findDynamic(orderedXml);

    // Find ModuleDef Dynamic sections
    const findModDefs = (items) => {
      if (!items) return;
      for (const el of Array.isArray(items) ? items : [items]) {
        const tag = ordTag(el);
        if (tag === 'ModuleDef') {
          const mdId = ordA(el, 'Id');
          for (const child of ordChildren(el)) {
            if (ordTag(child) === 'Dynamic') orderedModDynamics[mdId] = ordChildren(child);
          }
        }
        // Recurse into containers
        for (const key of ['KNX', 'ManufacturerData', 'Manufacturer', 'ApplicationPrograms', 'ApplicationProgram', 'Static', 'ModuleDefs']) {
          if (tag === key) findModDefs(ordChildren(el));
        }
      }
    };
    findModDefs(orderedXml);
  } catch (_) {}

  // 1. Translations: refId → { AttributeName → Text }
  //    Collect from all Language elements, English first so it wins over other languages.
  const trans = {};
  const collectTrans = (langs) => {
    for (const langNode of toArr(langs)) {
      for (const tu of toArr(langNode?.TranslationUnit)) {
        for (const el of toArr(tu?.TranslationElement)) {
          const refId = a(el, 'RefId');
          if (!refId) continue;
          if (!trans[refId]) trans[refId] = {};
          for (const t of toArr(el.Translation)) {
            const attr = a(t, 'AttributeName');
            if (attr && !trans[refId][attr]) trans[refId][attr] = a(t, 'Text');
          }
        }
      }
    }
  };
  const allLangs = toArr(mfrNode?.Languages?.Language);
  // English-speaking locales first so they take priority
  const enLangs  = allLangs.filter(l => /^en/i.test(a(l, 'Identifier')));
  const otherLangs = allLangs.filter(l => !/^en/i.test(a(l, 'Identifier')));
  collectTrans(enLangs);
  collectTrans(otherLangs);

  const T = (id, attr) => trans[id]?.[attr] ?? '';

  // No-op — removed pickName/pickText/DIR_RE. Text and FunctionText are stored separately.

  // 2. ComObject definitions (top-level Static + inside each ModuleDef Static)
  const coDefs = {};          // coId → { ft, dpt, objectSize, flags }
  const allStaticSections = [
    ap.Static,
    ...toArr(ap.ModuleDefs?.ModuleDef).map(md => md.Static),
  ].filter(Boolean);

  for (const st of allStaticSections) {
    // ComObjects may be under ComObjects/ComObject OR ComObjectTable/ComObject
    const coList = [
      ...toArr(st.ComObjects?.ComObject),
      ...toArr(st.ComObjectTable?.ComObject),
    ];
    for (const co of coList) {
      const id = a(co, 'Id');
      if (!id) continue;
      coDefs[id] = {
        num:  parseInt(a(co, 'Number')) || 0,
        text: T(id,'Text') || a(co,'Text') || '',
        ft:   T(id,'FunctionText') || a(co,'FunctionText') || '',
        dpt:  a(co, 'DatapointType'),
        size: a(co, 'ObjectSize'),
        read: a(co, 'ReadFlag'), write: a(co, 'WriteFlag'),
        comm: a(co, 'CommunicationFlag'), tx: a(co, 'TransmitFlag'),
      };
    }
  }

  // 3. ComObjectRef definitions (same two scopes)
  const corDefs = {};         // corId → { refId, overrides... }
  for (const st of allStaticSections) {
    for (const cor of toArr(st.ComObjectRefs?.ComObjectRef)) {
      const id = a(cor, 'Id');
      if (!id) continue;
      corDefs[id] = {
        refId: a(cor, 'RefId'),
        text:  T(id,'Text') || a(cor,'Text') || null,
        ft:    T(id,'FunctionText') || a(cor,'FunctionText') || null,
        dpt:   a(cor, 'DatapointType') || null,
        size:  a(cor, 'ObjectSize') || null,
        read:  a(cor, 'ReadFlag') || null, write: a(cor, 'WriteFlag') || null,
        comm:  a(cor, 'CommunicationFlag') || null, tx: a(cor, 'TransmitFlag') || null,
      };
    }
  }

  // 4. Argument definitions: argId → argName
  const argDefs = {};
  for (const md of toArr(ap.ModuleDefs?.ModuleDef)) {
    for (const arg of toArr(md.Arguments?.Argument))
      if (a(arg,'Id')) argDefs[a(arg,'Id')] = a(arg,'Name');
  }

  // 5. Module instantiations (Dynamic section): fullModId → { argName: value, _count: N }
  const modArgs = {};
  const collectMods = mods => {
    for (const mod of mods) {
      const mid = a(mod, 'Id');
      if (!mid) continue;
      const args = {};
      for (const na of toArr(mod.NumericArg)) {
        const name = argDefs[a(na,'RefId')];
        if (name) args[name] = a(na, 'Value');
      }
      const count = parseInt(a(mod, 'Count')) || 1;
      args._count = count;
      modArgs[mid] = args;
    }
  };
  collectMods(toArr(ap.Dynamic?.Module));
  for (const md of toArr(ap.ModuleDefs?.ModuleDef))
    collectMods(toArr(md.Dynamic?.Module));

  // 6. Channel definitions: fullChanId → text template
  const chanDefs = {};
  for (const ch of toArr(ap.ModuleDefs?.ModuleDef).flatMap(md =>
    toArr(md.Dynamic?.Channel))) {
    const id = a(ch, 'Id');
    if (id) chanDefs[id] = T(id,'Text') || a(ch,'Text') || a(ch,'Name');
  }
  // Top-level Dynamic channels
  for (const ch of toArr(ap.Dynamic?.Channel)) {
    const id = a(ch, 'Id');
    if (id) chanDefs[id] = T(id,'Text') || a(ch,'Text') || a(ch,'Name');
  }
  // Static channel definitions (Static/Channels/Channel)
  for (const st of allStaticSections) {
    for (const ch of toArr(st.Channels?.Channel)) {
      const id = a(ch, 'Id');
      if (id) chanDefs[id] = T(id,'Text') || a(ch,'Text') || a(ch,'Name');
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
  function resolveCoRef(relRefId, channelId) {
    const buildResult = (cor, co, args, channel) => ({
      objectNumber: co.num,
      name:        interp(cor.text || co.text, args),
      function_text: interp(cor.ft || co.ft, args),
      channel,
      dpt:         cor.dpt  || co.dpt  || '',
      objectSize:  cor.size || co.size || '',
      read:  (cor.read  ?? co.read)  === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm:  (cor.comm  ?? co.comm)  === 'Enabled',
      tx:    (cor.tx    ?? co.tx)    === 'Enabled',
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
        if (cm) channel = interp(chanDefs[`${appId}_${cm[1]}_${cm[2]}`] || '', args);
        else channel = interp(chanDefs[`${appId}_${channelId}`] || '', args) || chanDefs[channelId] || channelId;
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
      const ch = channelId ? (interp(chanDefs[`${appId}_${channelId}`] || '', {}) || chanDefs[channelId] || channelId) : '';
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
  const paramTypes = {};
  for (const st of allStaticSections) {
    for (const pt of toArr(st.ParameterTypes?.ParameterType)) {
      const tid = a(pt, 'Id');
      if (!tid) continue;
      if ('TypeNone' in pt) { paramTypes[tid] = { kind: 'none', enums: {} }; continue; }
      if (pt.TypeNumber) {
        const tn = Array.isArray(pt.TypeNumber) ? pt.TypeNumber[0] : pt.TypeNumber;
        const uiHint = a(tn,'UIHint') || '';
        const coeff = a(tn,'Coefficient');
        paramTypes[tid] = {
          kind: uiHint === 'CheckBox' ? 'checkbox' : 'number', enums: {},
          min:  a(tn,'minInclusive')!=='' ? Number(a(tn,'minInclusive')) : (a(tn,'Minimum')!=='' ? Number(a(tn,'Minimum')) : null),
          max:  a(tn,'maxInclusive')!=='' ? Number(a(tn,'maxInclusive')) : (a(tn,'Maximum')!=='' ? Number(a(tn,'Maximum')) : null),
          step: a(tn,'Step')!==''    ? Number(a(tn,'Step'))    : null,
          sizeInBit: parseInt(a(tn,'SizeInBit')) || 8,
          ...(coeff ? { coefficient: parseFloat(coeff) } : {}),
          uiHint,
        };
        continue;
      }
      if (pt.TypeFloat) {
        const tf = Array.isArray(pt.TypeFloat) ? pt.TypeFloat[0] : pt.TypeFloat;
        const coeff = a(tf,'Coefficient');
        paramTypes[tid] = {
          kind: 'float', enums: {},
          min:  a(tf,'minInclusive')!=='' ? Number(a(tf,'minInclusive')) : (a(tf,'Minimum')!=='' ? Number(a(tf,'Minimum')) : null),
          max:  a(tf,'maxInclusive')!=='' ? Number(a(tf,'maxInclusive')) : (a(tf,'Maximum')!=='' ? Number(a(tf,'Maximum')) : null),
          step: null,
          sizeInBit: parseInt(a(tf,'SizeInBit')) || 16,
          ...(coeff ? { coefficient: parseFloat(coeff) } : {}),
        };
        continue;
      }
      if (pt.TypeTime) {
        const tt = Array.isArray(pt.TypeTime) ? pt.TypeTime[0] : pt.TypeTime;
        const uiHint = a(tt,'UIHint') || '';
        paramTypes[tid] = {
          kind: 'time', enums: {},
          min:  a(tt,'minInclusive')!=='' ? Number(a(tt,'minInclusive')) : null,
          max:  a(tt,'maxInclusive')!=='' ? Number(a(tt,'maxInclusive')) : null,
          step: null,
          sizeInBit: parseInt(a(tt,'SizeInBit')) || 16,
          unit: a(tt,'Unit') || '',
          uiHint,
        };
        continue;
      }
      if (pt.TypeText) {
        const tt = Array.isArray(pt.TypeText) ? pt.TypeText[0] : pt.TypeText;
        paramTypes[tid] = { kind: 'text', enums: {}, sizeInBit: parseInt(a(tt,'SizeInBit')) || 8 };
        continue;
      }
      const enums = {};
      for (const e of toArr(pt.TypeRestriction?.Enumeration)) {
        const val = a(e, 'Value');
        const txt = T(a(e, 'Id'), 'Text') || a(e, 'Text');
        if (val !== '' && txt) enums[val] = txt;
      }
      const trSizeInBit = parseInt(a(pt.TypeRestriction, 'SizeInBit')) || 8;
      paramTypes[tid] = { kind: Object.keys(enums).length ? 'enum' : 'other', enums, sizeInBit: trSizeInBit };
    }
  }

  // 8. Parameter definitions: paramId → { text, typeRef }
  //    Parameters are always flat under Static/Parameters or inside Union elements.
  //    Parameter.Access is stored so ParameterRef resolution can inherit it when the ref
  //    itself has no Access override. Access="None" means download-only (not shown in ETS UI).
  const paramDefs = {};
  // baseFromMem: true when the parent Union's offset came from a <Memory> child element.
  // In that convention, all Union child params use relSeg-index offsets (not absolute ETS offsets),
  // so they must be treated identically to standalone params with <Memory> children.
  const addParam = (p, baseOffset = 0, baseFromMem = false) => {
    const id = a(p, 'Id');
    if (!id) return;
    let rawOff    = a(p, 'Offset');
    let rawBitOff = a(p, 'BitOffset');
    // Some parameters specify memory via a <Memory> child element rather than direct attributes.
    // This is the standard ETS6 encoding for parameters in <Parameters> (non-Union) sections.
    // Track the source so buildParamMem can distinguish absolute-offset params (Memory child)
    // from Union params (direct Offset="0" attribute) for relSeg blob convention detection.
    let fromMemoryChild = baseFromMem;
    if (rawOff === '') {
      const mem = Array.isArray(p.Memory) ? p.Memory[0] : p.Memory;
      if (mem) {
        rawOff    = a(mem, 'Offset');
        rawBitOff = a(mem, 'BitOffset');
        if (rawOff !== '') fromMemoryChild = true;
      }
    }
    paramDefs[id] = {
      // Use Text attribute (display label), NOT Name (internal code identifier)
      text:      T(id, 'Text') || a(p, 'Text') || '',
      typeRef:   a(p, 'ParameterType'),
      value:     a(p, 'Value'),  // factory default value
      access:    a(p, 'Access') || null,
      // Memory layout — null means not directly memory-mapped (e.g. Union child with no Offset)
      offset:          rawOff !== '' ? baseOffset + parseInt(rawOff) : (baseOffset > 0 ? baseOffset : null),
      bitOffset:       parseInt(rawBitOff) || 0,
      fromMemoryChild: fromMemoryChild,
      // DefaultUnionParameter="0" marks the first (default-active) param in a Union —
      // its default value should be written even when not in currentValues.
      isDefaultUnionParam: a(p, 'DefaultUnionParameter') === '0',
    };
  };
  for (const st of allStaticSections) {
    for (const p of toArr(st.Parameters?.Parameter)) addParam(p);
    for (const u of toArr(st.Parameters?.Union)) {
      // Union children share the union's byte offset; their own @Offset is relative to it.
      // The union's offset may be in a <Memory Offset="X"> child element rather than a direct attribute.
      let uOffset = parseInt(a(u, 'Offset'));
      let uFromMem = false;
      if (isNaN(uOffset) || uOffset === 0) {
        const uMem = Array.isArray(u.Memory) ? u.Memory[0] : u.Memory;
        if (uMem) {
          const memOff = parseInt(a(uMem, 'Offset'));
          if (!isNaN(memOff)) { uOffset = memOff; uFromMem = true; }
        }
      }
      if (isNaN(uOffset)) uOffset = 0;
      for (const p of toArr(u.Parameter)) addParam(p, uOffset, uFromMem);
    }
  }

  // 9. ParameterRef definitions: fullRefId → { paramId, text override, access override }
  //    Collected before 8b so the section-map walk can use it for label resolution.
  const paramRefDefs = {};
  for (const st of allStaticSections) {
    for (const pr of toArr(st.ParameterRefs?.ParameterRef)) {
      const id = a(pr, 'Id');
      if (!id) continue;
      paramRefDefs[id] = {
        paramId:    a(pr, 'RefId'),
        // Use Text attribute (display label), NOT Name (internal code identifier like P_ZeitLang)
        text:       T(id,'Text') || a(pr,'Text') || null,
        access:     a(pr, 'Access') || null,
        // A non-empty Value attribute overrides the Parameter's default value for this ref.
        prDefault:  a(pr, 'Value') || null,
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
  const pbLabel = (pb, fallback) => {
    const id = a(pb, 'Id');
    const indent = pbIndentMap[id] || 0;
    let label = T(id, 'Text') || a(pb, 'Text');
    if (!label) {
      const prId = a(pb, 'ParamRefId');
      if (prId) {
        const pr = paramRefDefs[prId];
        if (pr) label = T(pr.paramId, 'Text') || pr.text || paramDefs[pr.paramId]?.text || '';
      }
    }
    return { label: label || a(pb, 'Name') || fallback || '', indent };
  };

  // 8b. Section map from Dynamic: ParameterRef fullId → section label (template)
  //     Walk Channel / ChannelIndependentBlock / ParameterBlock / choose / when hierarchy.
  //     paramRefGroupMap tracks the Channel label (parent grouping) separately from the
  //     innermost ParameterBlock label (section label), so the UI can show group headers.
  const paramRefSectionMap  = {};
  const paramRefGroupMap    = {};
  const paramRefSectionIndentMap = {};  // indent (leading spaces) of the PB label — encodes ETS hierarchy
  const walkDynamic = (items, sectionTpl, groupLabel = '', sectionIndent = 0) => {
    for (const item of toArr(items)) {
      for (const rr of toArr(item.ParameterRefRef)) {
        const rid = a(rr, 'RefId');
        if (rid && !paramRefSectionMap[rid]) {
          paramRefSectionMap[rid]  = sectionTpl;
          paramRefGroupMap[rid]    = groupLabel;
          paramRefSectionIndentMap[rid] = sectionIndent;
        }
      }
      for (const pb of toArr(item.ParameterBlock)) {
        const { label, indent } = pbLabel(pb, sectionTpl);
        walkDynamic([pb], label, groupLabel, indent);
      }
      for (const ch of toArr(item.choose)) {
        for (const w of toArr(ch.when)) walkDynamic([w], sectionTpl, groupLabel, sectionIndent);
      }
    }
  };
  const walkDynSection = (dyn) => {
    if (!dyn) return;
    for (const ch of toArr(dyn.Channel)) {
      const chLabel = T(a(ch,'Id'),'Text') || a(ch,'Text') || a(ch,'Name') || '';
      walkDynamic([ch], chLabel, chLabel, 0);  // channel label = both section fallback and group
    }
    for (const cib of toArr(dyn.ChannelIndependentBlock)) walkDynamic([cib], '', '', 0);
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
  function resolveParamRef(refId, value) {
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
    let args = {};
    const modMatch = refId.match(/_(MD-\d+)_(M-\d+)_MI-\d+_/);
    if (modMatch) args = modArgs[`${appId}_${modMatch[1]}_${modMatch[2]}`] || {};

    // Section label — from Dynamic map, template-substituted
    const sectionTpl = paramRefSectionMap[prKey] || '';
    const section = sectionTpl ? interp(sectionTpl, args) : '';
    const groupTpl  = paramRefGroupMap[prKey] || '';
    const group     = groupTpl ? interp(groupTpl, args) : '';

    // Display name — ParameterRef text override takes priority, then Parameter text
    const nameTpl = pr.text || pd.text;
    if (!nameTpl) return null;
    const name = interp(nameTpl, args) || nameTpl;
    if (!name || /^calc/i.test(name)) return null;

    // Display value — enum lookup for TypeRestriction, raw otherwise
    const typeInfo = pd.typeRef ? (paramTypes[pd.typeRef] || { kind: 'other', enums: {} }) : { kind: 'other', enums: {} };
    if (typeInfo.kind === 'none') return null; // TypeNone = UI page marker, no value
    const displayVal = typeInfo.kind === 'enum' && typeInfo.enums[value] !== undefined
      ? typeInfo.enums[value]
      : value;

    return { section, group, name, value: displayVal };
  }

  // Return factory default for a paramRef key (stripped, no module instance path).
  const getDefault = (prKey) => {
    const pr = paramRefDefs[prKey];
    if (!pr) return null;
    // ParameterRef Value overrides Parameter Value
    if (pr.prDefault != null && pr.prDefault !== '') return pr.prDefault;
    const pd = paramDefs[pr.paramId];
    return pd ? pd.value : null;
  };

  const getModArgs = (mk) => modArgs[mk] || null;

  // ── Serialize ordered Dynamic tree into items arrays ──────────────────────
  function serOrderedItems(ordItems) {
    if (!ordItems || !ordItems.length) return [];
    const result = [];
    for (const el of ordItems) {
      const tag = ordTag(el);
      if (!tag) continue;
      if (tag === 'ParameterRefRef') {
        const refId = ordA(el, 'RefId');
        if (refId) result.push({ type: 'paramRef', refId, cell: ordA(el, 'Cell') || undefined });
      } else if (tag === 'ParameterSeparator') {
        const id = ordA(el, 'Id');
        result.push({ type: 'separator', id, text: T(id, 'Text') || ordA(el, 'Text'), uiHint: ordA(el, 'UIHint') });
      } else if (tag === 'ParameterBlock') {
        const id = ordA(el, 'Id');
        const children = ordChildren(el);
        let rows, columns;
        if (ordA(el, 'Layout') === 'Table') {
          rows = []; columns = [];
          for (const child of children) {
            const ctag = ordTag(child);
            if (ctag === 'Rows') for (const r of ordChildren(child)) if (ordTag(r) === 'Row') rows.push({ id: ordA(r, 'Id'), text: T(ordA(r, 'Id'), 'Text') || ordA(r, 'Text') || ordA(r, 'Name') });
            if (ctag === 'Columns') for (const c of ordChildren(child)) if (ordTag(c) === 'Column') columns.push({ id: ordA(c, 'Id'), text: T(ordA(c, 'Id'), 'Text') || ordA(c, 'Text') || ordA(c, 'Name'), width: ordA(c, 'Width') || undefined });
          }
        }
        let blockText = T(id, 'Text') || ordA(el, 'Text') || '';
        if (!blockText) {
          const prId = ordA(el, 'ParamRefId');
          if (prId) {
            const pr = paramRefDefs[prId];
            const pd = pr ? paramDefs[pr.paramId] : null;
            blockText = T(pr?.paramId, 'Text') || pr?.text || pd?.text || '';
          }
        }
        result.push({
          type: 'block', id, text: blockText,
          name: ordA(el, 'Name'), inline: ordA(el, 'Inline') === 'true', access: ordA(el, 'Access') || undefined,
          layout: ordA(el, 'Layout') || undefined, rows, columns,
          items: serOrderedItems(children),
        });
      } else if (tag === 'choose') {
        const prId = ordA(el, 'ParamRefId');
        const pr = paramRefDefs[prId];
        const pd = pr ? paramDefs[pr.paramId] : null;
        const effectiveAccess = pr?.access ?? pd?.access ?? '';
        const whens = [];
        for (const w of ordChildren(el)) {
          if (ordTag(w) !== 'when') continue;
          const test = (ordA(w, 'test') || ordA(w, 'Value') || '').split(' ').filter(Boolean);
          const isDefault = ordA(w, 'default') === 'true';
          whens.push({ test, isDefault, items: serOrderedItems(ordChildren(w)) });
        }
        if (prId) result.push({ type: 'choose', paramRefId: prId, accessNone: effectiveAccess === 'None', defaultValue: pr?.prDefault ?? pd?.value ?? null, whens });
      } else if (tag === 'Rename') {
        result.push({ type: 'rename', refId: ordA(el, 'RefId'), text: T(ordA(el, 'Id'), 'Text') || ordA(el, 'Text') });
      } else if (tag === 'Assign') {
        const target = ordA(el, 'TargetParamRefRef');
        const source = ordA(el, 'SourceParamRefRef') || null;
        const value = ordA(el, 'Value');
        if (target && (source || value !== '')) result.push({ type: 'assign', target, source, value: value !== '' ? value : null });
      } else if (tag === 'ComObjectRefRef') {
        result.push({ type: 'comRef', refId: ordA(el, 'RefId') });
      } else if (tag === 'Channel') {
        const chId = ordA(el, 'Id');
        const textPrId = ordA(el, 'TextParameterRefId') || undefined;
        result.push({ type: 'channel', id: chId, label: T(chId, 'Text') || ordA(el, 'Text') || ordA(el, 'Name') || '', textParamRefId: textPrId, items: serOrderedItems(ordChildren(el)) });
      } else if (tag === 'ChannelIndependentBlock') {
        result.push({ type: 'cib', items: serOrderedItems(ordChildren(el)) });
      }
    }
    return result;
  }

  // ── Dynamic condition evaluator ───────────────────────────────────────────
  // Walks the Dynamic choose/when tree using per-device param values.
  // Returns { activeParams: Set<prKey>, activeCorefs: Set<corId> }.
  // Uses the ordered Dynamic tree to correctly evaluate choose/when conditions
  // including operator tests (!=, <, >, etc.) and TypeNone page-marker params.
  function evalDynamic(getVal) {
    const activeParams = new Set();
    const activeCorefs = new Set();
    const activeCorefsByObjNum = new Map(); // objectNumber → [{corId, channel}] in walk order

    function etsTestMatch(val, tests) {
      const n = parseFloat(val);
      for (const t of tests) {
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
        } else if (String(t) === val) return true;
      }
      return false;
    }

    function isTypeNone(prId) {
      const pr = paramRefDefs[prId];
      if (!pr) return true; // unknown param — treat as always-evaluate
      const pd = paramDefs[pr.paramId];
      if (!pd) return true;
      const ti = paramTypes[pd.typeRef];
      return ti?.kind === 'none';
    }

    function walkItems(items, channelLabel) {
      if (!items) return;
      for (const item of items) {
        if (item.type === 'paramRef') { if (item.refId) activeParams.add(item.refId); }
        else if (item.type === 'comRef') {
          if (item.refId) {
            activeCorefs.add(item.refId);
            const cor = corDefs[item.refId];
            const co = cor ? coDefs[cor.refId] : null;
            if (co) {
              if (!activeCorefsByObjNum.has(co.num)) activeCorefsByObjNum.set(co.num, []);
              // Interpolate channel label templates (e.g. {{0: Shutter Actuator A+B}})
              let ch = channelLabel || '';
              if (ch && ch.includes('{{')) {
                const mdMatch = item.refId.match(/_(MD-\w+)_(M-\d+)_/);
                ch = interp(ch, mdMatch ? (modArgs[`${appId}_${mdMatch[1]}_${mdMatch[2]}`] || {}) : {});
              }
              activeCorefsByObjNum.get(co.num).push({ corId: item.refId, channel: ch });
            }
          }
        }
        else if (item.type === 'channel') { walkItems(item.items, item.label || channelLabel); }
        else if (item.type === 'block' || item.type === 'cib') { walkItems(item.items, channelLabel); }
        else if (item.type === 'choose') {
          // Skip if controlling param is known visible but not active (prevents phantom COs)
          if (item.paramRefId && !item.accessNone && !isTypeNone(item.paramRefId) && !activeParams.has(item.paramRefId)) continue;
          const raw = getVal(item.paramRefId);
          const val = String(raw !== '' && raw != null ? raw : (item.defaultValue ?? ''));
          let matched = false, defItems = null;
          for (const w of item.whens || []) {
            if (w.isDefault) { defItems = w.items; continue; }
            if (etsTestMatch(val, w.test)) { matched = true; walkItems(w.items, channelLabel); }
          }
          if (!matched && defItems) walkItems(defItems, channelLabel);
        }
      }
    }

    const mainItems = orderedDynamic ? serOrderedItems(orderedDynamic) : null;
    const modItemsList = Object.entries(orderedModDynamics).map(([id, od]) => od ? serOrderedItems(od) : null).filter(Boolean);
    // Pass 1: evaluate conditions to collect active params, but don't collect corefs yet
    function walkPass1(items) {
      if (!items) return;
      for (const item of items) {
        if (item.type === 'paramRef') { if (item.refId) activeParams.add(item.refId); }
        else if (item.type === 'comRef') { /* skip — collected in pass 2 */ }
        else if (item.type === 'block' || item.type === 'channel' || item.type === 'cib') { walkPass1(item.items); }
        else if (item.type === 'choose') {
          const raw = getVal(item.paramRefId);
          const val = String(raw !== '' && raw != null ? raw : (item.defaultValue ?? ''));
          let matched = false, defItems = null;
          for (const w of item.whens || []) {
            if (w.isDefault) { defItems = w.items; continue; }
            if (etsTestMatch(val, w.test)) { matched = true; walkPass1(w.items); }
          }
          if (!matched && defItems) walkPass1(defItems);
        }
      }
    }
    if (mainItems) walkPass1(mainItems);
    for (const mi of modItemsList) walkPass1(mi);

    // Pass 2: re-evaluate conditions, now skipping chooses on inactive params, collecting corefs
    if (mainItems) walkItems(mainItems);
    for (const mi of modItemsList) walkItems(mi);
    return { activeParams, activeCorefs, activeCorefsByObjNum };
  }

  // Resolve a COM object from its app-level ComObjectRef ID (no instance path).
  // Used to add active-but-unlinked COM objects to the device's object list.
  function resolveCoRefById(corId) {
    const cor = corDefs[corId];
    if (!cor) return null;
    const co  = coDefs[cor.refId];
    if (!co) return null;
    // Try to extract module args for template substitution from corId
    const mdMatch = corId.match(/_(MD-\d+)_(M-\d+)_/);
    const args = mdMatch ? (modArgs[`${appId}_${mdMatch[1]}_${mdMatch[2]}`] || {}) : {};
    return {
      objectNumber: co.num,
      name:         interp(cor.text || co.text, args),
      function_text: interp(cor.ft || co.ft, args),
      dpt:          cor.dpt  || co.dpt  || '',
      objectSize:   cor.size || co.size || '',
      read:  (cor.read  ?? co.read)  === 'Enabled',
      write: (cor.write ?? co.write) === 'Enabled',
      comm:  (cor.comm  ?? co.comm)  === 'Enabled',
      tx:    (cor.tx    ?? co.tx)    === 'Enabled',
      channel: '',
    };
  }

  function buildParamModel() {
    const params = {};
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
        section:       paramRefSectionMap[prKey]       || '',
        group:         paramRefGroupMap[prKey]         || '',
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
        offset:    pd.offset ?? null,
        bitOffset: pd.bitOffset ?? 0,
        bitSize:   ti.sizeInBit ?? 8,
      };
    }

    const dynTree = {
      main: orderedDynamic ? { items: serOrderedItems(orderedDynamic) } : null,
      moduleDefs: toArr(ap.ModuleDefs?.ModuleDef).map(md => {
        const mdId = a(md, 'Id');
        const ordDyn = orderedModDynamics[mdId];
        return { id: mdId, items: ordDyn ? serOrderedItems(ordDyn) : [] };
      }).filter(m => m.items.length > 0),
    };

    // paramMemLayout: ALL paramRefs (including Access=None download-only params)
    // keyed by paramRefId → { offset, bitOffset, bitSize, defaultValue }
    // Used by the download engine to build the parameter memory segment.
    const paramMemLayout = {};
    for (const [prId, pr] of Object.entries(paramRefDefs)) {
      const pd = paramDefs[pr.paramId];
      if (!pd || pd.offset === null || pd.offset === undefined) continue;
      const ti = paramTypes[pd.typeRef] || {};
      // effectiveAccess: ParameterRef.Access overrides Parameter.Access.
      // Access='None' = download-only (hidden from UI). Other values = user-configurable.
      // isVisible: true for params the user can set in ETS. When a visible param is at its
      // default value, ETS may not store it explicitly in the project XML — but it still
      // programs the XML default to the device. So for visible params not in currentValues,
      // we should write the XML default rather than falling back to the relSeg factory blob.
      const effectiveAccess = pr.access ?? pd.access ?? '';
      const isVisible = effectiveAccess !== 'None' && ti.kind !== undefined && ti.kind !== null;
      paramMemLayout[prId] = {
        offset:             pd.offset,
        bitOffset:          pd.bitOffset || 0,
        bitSize:            ti.sizeInBit || 8,
        defaultValue:       pr.prDefault ?? pd.value ?? '',
        isText:             ti.kind === 'text',
        isFloat:            ti.kind === 'float',
        fromMemoryChild:    pd.fromMemoryChild || false,
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
    const relSegData = {};
    for (const st of allStaticSections) {
      for (const rs of toArr(st.Code?.RelativeSegment)) {
        const lsm = parseInt(a(rs, 'LoadStateMachine'));
        if (!lsm) continue;
        const rawData = typeof rs.Data === 'string' ? rs.Data : '';
        if (rawData) {
          try { relSegData[lsm] = Buffer.from(rawData.replace(/\s/g, ''), 'base64').toString('hex'); }
          catch (_) {}
        }
      }
    }

    // absSegData: BASE64-decoded data blobs from Static/Code/AbsoluteSegment elements,
    // keyed by Address (decimal string). Used for devices with ProductProcedure/absolute
    // memory addressing (e.g. Zennio, older BCU2 devices).
    const absSegData = {};
    for (const st of allStaticSections) {
      for (const as of toArr(st.Code?.AbsoluteSegment)) {
        const addr = parseInt(a(as, 'Address'));
        const size = parseInt(a(as, 'Size')) || 0;
        if (isNaN(addr)) continue;
        const rawData = typeof as.Data === 'string' ? as.Data : '';
        let hex = '';
        if (rawData) {
          try { hex = Buffer.from(rawData.replace(/\s/g, ''), 'base64').toString('hex'); }
          catch (_) {}
        }
        absSegData[addr] = { size, hex };
      }
    }

    return { appId, params, dynTree, modArgs, paramMemLayout, relSegData, absSegData };
  }

  // ── LoadProcedures ────────────────────────────────────────────────────────
  // Parse the download steps from Static/LoadProcedures.
  const loadProcedures = [];
  for (const lp of toArr(ap.Static?.LoadProcedures?.LoadProcedure)) {
    for (const el of toArr(lp.LdCtrlRelSegment)) {
      const lsmIdx = parseInt(a(el,'LsmIdx')) || 4;
      const size   = parseInt(a(el,'Size'))   || 0;
      const mode   = a(el,'AppliesTo') || 'full';
      loadProcedures.push({ type: 'RelSegment', lsmIdx, size, mode, fill: parseInt(a(el,'Fill')) || 0 });
    }
    for (const el of toArr(lp.LdCtrlWriteProp)) {
      const raw = a(el, 'InlineData');
      const data = raw ? Buffer.from(raw.replace(/\s/g,''), 'hex') : null;
      if (data && data.length) {
        loadProcedures.push({ type: 'WriteProp', objIdx: parseInt(a(el,'ObjIdx'))||0, propId: parseInt(a(el,'PropId'))||0, data: data.toString('hex') });
      }
    }
    for (const el of toArr(lp.LdCtrlCompareProp)) {
      const raw = a(el, 'InlineData');
      const data = raw ? raw.replace(/\s/g,'') : '';
      loadProcedures.push({ type: 'CompareProp', objIdx: parseInt(a(el,'ObjIdx'))||0, propId: parseInt(a(el,'PropId'))||0, data });
    }
    for (const el of toArr(lp.LdCtrlWriteRelMem)) {
      const mode = a(el,'AppliesTo') || 'full';
      loadProcedures.push({ type: 'WriteRelMem', objIdx: parseInt(a(el,'ObjIdx'))||4, offset: parseInt(a(el,'Offset'))||0, size: parseInt(a(el,'Size'))||0, mode });
    }
    for (const el of toArr(lp.LdCtrlLoadImageProp)) {
      loadProcedures.push({ type: 'LoadImageProp', objIdx: parseInt(a(el,'ObjIdx'))||0, propId: parseInt(a(el,'PropId'))||27 });
    }
    for (const el of toArr(lp.LdCtrlAbsSegment)) {
      loadProcedures.push({ type: 'AbsSegment', lsmIdx: parseInt(a(el,'LsmIdx'))||0,
        address: parseInt(a(el,'Address'))||0, size: parseInt(a(el,'Size'))||0 });
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
    moduleKeys:   Object.keys(modArgs),   // "{appId}_MD-n_M-k" — one per instantiated module
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
function parseLocationsRec(spaceEls, parentIdx, spaces, devSpaceMap, devInstById) {
  for (let i = 0; i < spaceEls.length; i++) {
    const sp = spaceEls[i];
    const idx = spaces.length;
    spaces.push({ name: a(sp, 'Name'), type: a(sp, 'Type') || 'Room', usage_id: a(sp, 'Usage') || '', parent_idx: parentIdx, sort_order: i });
    for (const ref of toArr(sp.DeviceInstanceRef)) {
      const ia = devInstById[a(ref, 'RefId')];
      if (ia) devSpaceMap[ia] = idx;
    }
    parseLocationsRec(toArr(sp.Space), idx, spaces, devSpaceMap, devInstById);
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
function parseKnxproj(buffer, password = null) {
  let zip, entries;
  try { zip = new AdmZip(buffer); entries = zip.getEntries(); }
  catch (e) { throw new Error('Invalid or corrupt .knxproj file: ' + e.message); }
  const byName    = Object.fromEntries(entries.map(e => [e.entryName, e]));

  // ── Manufacturer names ─────────────────────────────────────────────────────
  const mfrById = {};                     // "M-00FA" → "KNX Association"
  const masterE = byName['knx_master.xml'] || entries.find(e => e.entryName.endsWith('/knx_master.xml'));
  let knxMasterXml = null;                // raw XML string for per-project storage
  if (masterE) {
    try {
      knxMasterXml = masterE.getData().toString('utf8');
      const mx = xmlParser.parse(knxMasterXml);
      for (const m of toArr(mx?.KNX?.MasterData?.Manufacturers?.Manufacturer))
        if (a(m,'Id')) mfrById[a(m,'Id')] = a(m,'Name');
    } catch (_) {}
  }

  // ── Hardware lookup ────────────────────────────────────────────────────────
  const hwByProd = {};      // productRefId → {manufacturer,model,orderNumber,hwSerial}
  const hwByH2P  = {};      // h2pRefId     → same

  for (const e of entries.filter(e => /M-[^/]+\/Hardware\.xml$/i.test(e.entryName))) {
    const mfrId   = e.entryName.match(/M-[^/]+/)?.[0] || e.entryName.split('/')[0];
    const mfrName = mfrById[mfrId] || mfrId;
    try {
      const hx = xmlParser.parse(e.getData().toString('utf8'));
      for (const mNode of toArr(hx?.KNX?.ManufacturerData?.Manufacturer)) {
        // Build translation maps from Hardware.xml Languages section
        // hwTrans: refId → text (English preferred, for the model column)
        // hwTransAll: refId → { langId: text } (all languages, stored for runtime lookup)
        const hwTrans = {};
        const hwTransAll = {};
        const hwLangs = toArr(mNode?.Languages?.Language);
        const hwEnLangs = hwLangs.filter(l => /^en/i.test(a(l, 'Identifier')));
        const hwOtherLangs = hwLangs.filter(l => !/^en/i.test(a(l, 'Identifier')));
        for (const langs of [hwEnLangs, hwOtherLangs]) {
          for (const lang of langs) {
            const langId = a(lang, 'Identifier');
            for (const tu of toArr(lang?.TranslationUnit)) {
              for (const el of toArr(tu?.TranslationElement)) {
                const refId = a(el, 'RefId');
                if (!refId) continue;
                for (const t of toArr(el.Translation)) {
                  if (a(t, 'AttributeName') === 'Text' && a(t, 'Text')) {
                    if (!hwTrans[refId]) hwTrans[refId] = a(t, 'Text'); // English first wins
                    if (!hwTransAll[refId]) hwTransAll[refId] = {};
                    hwTransAll[refId][langId] = a(t, 'Text');
                    break;
                  }
                }
              }
            }
          }
        }
        const hwT = (id) => hwTrans[id] || '';
        const hwTAll = (id, baseText, defaultLang) => {
          const t = hwTransAll[id] ? { ...hwTransAll[id] } : {};
          // Add base text under the manufacturer's default language
          if (baseText && defaultLang && !t[defaultLang]) t[defaultLang] = baseText;
          return Object.keys(t).length ? t : null;
        };

        for (const outer of toArr(mNode.Hardware)) {
          for (const hw of toArr(outer.Hardware)) {
            const hwId     = a(hw, 'Id');
            const hwName   = hwT(hwId) || a(hw, 'Name');
            const hwSerial = a(hw, 'SerialNumber');
            const busCurrent   = Math.round(parseFloat(a(hw, 'BusCurrent'))) || 0;
            const widthMm      = parseFloat(a(hw, 'WidthInMillimeter') || a(toArr(hw?.Products?.Product)[0], 'WidthInMillimeter')) || 0;
            const isPowerSupply = a(hw, 'IsPowerSupply') === 'true' || a(hw, 'IsPowerSupply') === '1';
            const isCoupler     = a(hw, 'IsCoupler') === 'true' || a(hw, 'IsCoupler') === '1';
            const isRailMounted = a(toArr(hw?.Products?.Product)[0], 'IsRailMounted') === 'true' || a(toArr(hw?.Products?.Product)[0], 'IsRailMounted') === '1';
            const hwExtra = { busCurrent, widthMm, isPowerSupply, isCoupler, isRailMounted };
            const info     = base => ({ manufacturer: mfrName, model: base, orderNumber: '', hwSerial, ...hwExtra });
            for (const p of [...toArr(hw?.Products?.Product), ...toArr(hw?.Product)]) {
              const pId = a(p, 'Id');
              const baseText = a(p, 'Text') || hwName;
              const pWidth = parseFloat(a(p, 'WidthInMillimeter')) || widthMm;
              const defaultLang = a(p, 'DefaultLanguage');
              if (pId) hwByProd[pId] = { manufacturer: mfrName, model: hwT(pId) || baseText, orderNumber: a(p, 'OrderNumber'), hwSerial, modelTranslations: hwTAll(pId, baseText, defaultLang), ...hwExtra, widthMm: pWidth };
            }
            for (const h of [...toArr(hw?.Hardware2Programs?.Hardware2Program), ...toArr(hw?.Hardware2Program)])
              if (a(h,'Id')) hwByH2P[a(h,'Id')] = info(hwName);
          }
        }
      }
    } catch (e) { console.error('[ETS] Hardware.xml:', e.message); }
  }

  // ── Catalog lookup ──────────────────────────────────────────────────────────
  const catalogSections = [];  // { id, name, number, parent_id (null for roots), mfr_id }
  const catalogItems = [];     // { id, name, number, description, section_id, product_ref, h2p_ref, order_number, manufacturer }

  for (const e of entries.filter(e => /M-[^/]+\/Catalog\.xml$/i.test(e.entryName))) {
    const mfrId   = e.entryName.match(/M-[^/]+/)?.[0] || e.entryName.split('/')[0];
    const mfrName = mfrById[mfrId] || mfrId;
    try {
      const cx = xmlParser.parse(e.getData().toString('utf8'));
      for (const mNode of toArr(cx?.KNX?.ManufacturerData?.Manufacturer)) {
        // Build translation map for catalog names
        const catTrans = {};
        for (const lang of toArr(mNode?.Languages?.Language).filter(l => /^en/i.test(a(l, 'Identifier')))) {
          for (const tu of toArr(lang?.TranslationUnit)) {
            for (const el of toArr(tu?.TranslationElement)) {
              const refId = a(el, 'RefId');
              if (!refId) continue;
              for (const t of toArr(el.Translation)) {
                if (a(t, 'Text')) { catTrans[refId] = a(t, 'Text'); break; }
              }
            }
          }
        }
        const ct = id => catTrans[id] || '';

        const walkSections = (sections, parentId) => {
          for (const sec of toArr(sections)) {
            const secId = a(sec, 'Id');
            const secName = ct(secId) || a(sec, 'Name') || '';
            const secNumber = a(sec, 'Number') || '';
            catalogSections.push({ id: secId, name: secName, number: secNumber, parent_id: parentId, mfr_id: mfrId, manufacturer: mfrName });
            // Items directly in this section
            for (const item of toArr(sec.CatalogItem)) {
              const itemId = a(item, 'Id');
              const prodRef = a(item, 'ProductRefId') || '';
              const h2pRef  = a(item, 'Hardware2ProgramRefId') || '';
              const hw = hwByProd[prodRef] || hwByH2P[h2pRef] || {};
              catalogItems.push({
                id: itemId,
                name: ct(itemId) || a(item, 'Name') || hw.model || '',
                number: a(item, 'Number') || '',
                description: a(item, 'VisibleDescription') || '',
                section_id: secId,
                product_ref: prodRef,
                h2p_ref: h2pRef,
                order_number: hw.orderNumber || a(item, 'VisibleDescription') || '',
                manufacturer: mfrName,
                mfr_id: mfrId,
                model: hw.model || ct(itemId) || a(item, 'Name') || '',
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
    } catch (e) { console.error('[ETS] Catalog.xml:', e.message); }
  }

  // ── Application program indexes ────────────────────────────────────────────
  // Keyed by "M-00FA_A-2504-10-C071" (appId without path/extension)
  const appByAppId = {};
  const appEntries = entries.filter(e => /M-[^/]+\/M-[^/]+_A-[^/]+\.xml$/i.test(e.entryName));
  for (const e of appEntries) {
    try {
      const idx = buildAppIndex(e.getData());
      if (idx?.appId) appByAppId[idx.appId] = idx;
    } catch (e) { console.error('[ETS] app XML:', e.message); }
  }

  // Given a Hardware2ProgramRefId like "M-00FA_H-xxx_HP-2504-10-C071"
  // the matching appId is "M-00FA_A-2504-10-C071".
  // HP may contain multiple concatenated app IDs (e.g. "4A24-11-O0007-4A24-21-O0007"),
  // so try every dash-boundary prefix from longest to shortest.
  const getAppIdx = h2pRefId => {
    const mfr  = h2pRefId.split('_H-')[0];
    const hp   = h2pRefId.split('_HP-')[1] || '';
    const parts = hp.split('-');
    for (let i = parts.length; i >= 1; i--) {
      const key = `${mfr}_A-${parts.slice(0, i).join('-')}`;
      if (appByAppId[key]) return appByAppId[key];
    }
    return null;
  };

  // ── Installation files ─────────────────────────────────────────────────────
  let installEntries = entries.filter(e => /P-[^/]+\/0\.xml$/i.test(e.entryName));
  if (!installEntries.length)
    installEntries = entries.filter(e => e.entryName.endsWith('0.xml'));

  // ── Password-protection check ──────────────────────────────────────────────
  // Encrypted project files are binary (not XML). Detect early and validate
  // the password before attempting full parsing.
  for (const entry of installEntries) {
    const raw = entry.getData();
    if (!looksEncrypted(raw)) break; // plaintext — no password needed
    if (!password) throw Object.assign(
      new Error('Project is password-protected'), { code: 'PASSWORD_REQUIRED' });
    try { decryptEntry(raw, password); }
    catch (_) { throw Object.assign(
      new Error('Incorrect password'), { code: 'PASSWORD_INCORRECT' }); }
    break; // password validated against first encrypted entry
  }

  let projectName = 'Imported Project';
  let projectInfo = null;
  const devices        = [];
  const groupAddresses = [];
  const comObjects     = [];
  const links          = [];
  const spaces         = [];   // flat list of { name, type, parent_idx, sort_order }
  const devSpaceMap    = {};   // individual_address → index in spaces[]
  const topologyEntries = [];  // { area, line (null for area-level), name, medium }

  for (const entry of installEntries) {
    // Try project.xml for name first
    const projKey = entry.entryName.replace('0.xml', 'project.xml');
    if (byName[projKey]) {
      try {
        let projBuf = byName[projKey].getData();
        if (looksEncrypted(projBuf)) projBuf = decryptEntry(projBuf, password);
        const px = xmlParser.parse(projBuf.toString('utf8'));
        const pi = px?.KNX?.Project?.ProjectInformation;
        if (a(pi, 'Name')) projectName = a(pi, 'Name');
        if (pi) {
          projectInfo = {
            lastModified:     a(pi, 'LastModified') || '',
            projectStart:     a(pi, 'ProjectStart') || '',
            archivedVersion:  a(pi, 'ArchivedVersion') || '',
            comment:          a(pi, 'Comment') || '',
            completionStatus: a(pi, 'CompletionStatus') || '',
            groupAddressStyle: a(pi, 'GroupAddressStyle') || '',
            guid:             a(pi, 'Guid') || '',
          };
        }
      } catch (_) {}
    }

    let entryBuf = entry.getData();
    if (looksEncrypted(entryBuf)) {
      try { entryBuf = decryptEntry(entryBuf, password); }
      catch (_) { console.error('[ETS] decrypt failed:', entry.entryName); continue; }
    }

    let xml;
    try { xml = xmlParser.parse(entryBuf.toString('utf8')); }
    catch (e) { console.error('[ETS] 0.xml:', entry.entryName, e.message); continue; }

    const inst = xml?.KNX?.Project?.Installations?.Installation;
    const installation = Array.isArray(inst) ? inst[0] : inst;
    if (!installation) continue;

    // ── Group addresses ──────────────────────────────────────────────────────
    const gaById    = {};   // fullId  → address string "0/0/1"
    const gaByShort = {};   // "GA-3"  → address string

    for (const mainGR of toArr(installation.GroupAddresses?.GroupRanges?.GroupRange)) {
      const mainName = a(mainGR,'Name');
      for (const midGR of toArr(mainGR.GroupRange)) {
        const midName = a(midGR,'Name');
        for (const ga of toArr(midGR.GroupAddress)) {
          const flat   = parseInt(a(ga,'Address'));
          const mainNum   = (flat >> 11) & 0x1F;
          const midNum    = (flat >> 8)  & 0x07;
          const subNum    = flat & 0xFF;
          const addr    = `${mainNum}/${midNum}/${subNum}`;
          const fullId  = a(ga, 'Id');
          const shortId = fullId.split('_').slice(-1)[0];   // "GA-3"
          groupAddresses.push({
            address: addr, name: a(ga,'Name') || addr,
            dpt: a(ga,'DatapointType'), comment: a(ga,'Comment') || '',
            description: a(ga,'Description') || '',
            main: mainNum, mainGroupName: mainName,
            middle: midNum, middleGroupName: midName,
            sub: subNum,
          });
          if (fullId)  gaById[fullId]      = addr;
          if (shortId) gaByShort[shortId]  = addr;
        }
      }
    }
    const resolveGA = ref => ref ? (gaById[ref] || gaByShort[ref] || null) : null;

    // ── Topology ─────────────────────────────────────────────────────────────
    const topology = installation.Topology;
    if (!topology) continue;

    const devInstById = {};  // DeviceInstance @Id → individual_address

    for (const area of toArr(topology.Area)) {
      const areaNum  = parseInt(a(area,'Address')) || 0;
      const areaName = a(area,'Name');
      topologyEntries.push({ area: areaNum, line: null, name: areaName || '', medium: 'TP' });
      for (const line of toArr(area.Line)) {
        const lineNum  = parseInt(a(line,'Address')) || 0;
        const lineName = a(line,'Name');
        const mediumAttr = a(line,'MediumTypeRefId') || a(line,'Medium') || a(line,'DomainAddress') || '';
        const mediumFromName = (() => { const n = lineName.toUpperCase(); if (n.includes(' RF') || n.startsWith('RF ')) return 'RF'; if (n.includes(' PL')) return 'PL'; if (n.includes(' IP')) return 'IP'; return ''; })();
        const medium = mediumAttr || mediumFromName || 'TP';
        topologyEntries.push({ area: areaNum, line: lineNum, name: lineName || '', medium });

        const allDevs = [
          ...toArr(line.DeviceInstance),
          ...toArr(line.Segment).flatMap(s => toArr(s.DeviceInstance)),
        ];

        for (const dev of allDevs) {
          const devNum   = parseInt(a(dev,'Address')) || 0;
          const ia       = `${areaNum}.${lineNum}.${devNum}`;
          const prodRef  = a(dev,'ProductRefId');
          const h2pRef   = a(dev,'Hardware2ProgramRefId');
          const hw       = hwByProd[prodRef] || hwByH2P[h2pRef] || {};
          const appIdx   = getAppIdx(h2pRef);

          // Serial: ETS stores as base64 — decode to hex
          let serial = a(dev,'SerialNumber') || hw.hwSerial || '';
          if (serial && !/^[0-9A-Fa-f]{8,}$/.test(serial)) {
            try { serial = Buffer.from(serial,'base64').toString('hex').toUpperCase(); }
            catch (_) {}
          }

          // Name: user-given name in ETS, else fall back to model
          const devName = a(dev,'Name') || a(dev,'Description') || hw.model || ia;

          // Track DeviceInstance Id so Locations can link back to this device
          const devInstId = a(dev, 'Id');
          if (devInstId) devInstById[devInstId] = ia;

          // ── Parameters ─────────────────────────────────────────────────────
          const parameters = [];
          const pirEls = toArr(dev.ParameterInstanceRefs?.ParameterInstanceRef);

          // instanceValues: full instance key → raw value (from 0.xml)
          // strippedValues: stripped key (no _M-n_MI-n_) → raw value (first instance wins)
          // Both are used: instanceValues for reconstruction, strippedValues for condition eval
          const instanceValues  = new Map();
          const strippedValues  = new Map();
          const seenModInstances = new Set();

          for (const pir of pirEls) {
            const refId = a(pir, 'RefId');
            const value = a(pir, 'Value');
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
              const count = modInfo?._count || 1;
              for (let i = 1; i <= count; i++) {
                const miKey = `${mk}_MI-${i}`;
                if (!seenModInstances.has(miKey)) seenModInstances.add(miKey);
              }
            }
          }

          // Evaluate Dynamic conditions with this device's parameter values.
          // getVal returns the RAW value (not display-translated) for condition checks.
          let activeParams = null, activeCorefs = null, activeCorefsByObjNum = null;
          if (appIdx?.evalDynamic) {
            const getVal = (prKey) => strippedValues.get(prKey) ?? appIdx.getDefault(prKey);
            ({ activeParams, activeCorefs, activeCorefsByObjNum } = appIdx.evalDynamic(getVal));
          }

          if (appIdx?.resolveParamRef) {
            if (appIdx.paramRefKeys) {
              for (const prKey of appIdx.paramRefKeys) {
                // Skip params hidden by Dynamic conditions
                if (activeParams && !activeParams.has(prKey)) continue;

                const modMatch = prKey.match(/^(.+_MD-\d+)_(.+)$/);
                if (modMatch) {
                  const mdBase = modMatch[1];
                  const rest   = modMatch[2];
                  for (const mi of seenModInstances) {
                    const miMatch = mi.match(/^(.+_MD-\d+)_(M-\d+)_(MI-\d+)$/);
                    if (!miMatch || miMatch[1] !== mdBase) continue;
                    const instanceKey = `${mdBase}_${miMatch[2]}_${miMatch[3]}_${rest}`;
                    const value = instanceValues.has(instanceKey)
                      ? instanceValues.get(instanceKey)
                      : appIdx.getDefault(prKey);
                    if (value == null) continue;
                    const resolved = appIdx.resolveParamRef(instanceKey, value);
                    if (resolved) parameters.push(resolved);
                  }
                } else {
                  const value = instanceValues.has(prKey)
                    ? instanceValues.get(prKey)
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
            name:          devName,
            description:        a(dev,'Description') || '',
            comment:            a(dev,'Comment') || '',
            installation_hints: a(dev,'InstallationHints') || '',
            manufacturer:  hw.manufacturer || '',
            model:         hw.model || '',
            order_number:  hw.orderNumber || '',
            serial_number: serial,
            product_ref:   prodRef,
            area: areaNum, area_name: areaName,
            line: lineNum, line_name: lineName,
            medium,
            device_type:   inferType(devName, prodRef, hw.model || '', hw),
            status:        a(dev,'LastDownload') ? 'programmed' : 'unassigned',
            last_modified: a(dev,'LastModified'),
            last_download: a(dev,'LastDownload'),
            apdu_length:   a(dev,'LastUsedAPDULength') || '',
            app_loaded:    a(dev,'ApplicationProgramLoaded') === 'true',
            comm_loaded:   a(dev,'CommunicationPartLoaded')  === 'true',
            ia_loaded:     a(dev,'IndividualAddressLoaded')   === 'true',
            params_loaded: a(dev,'ParametersLoaded')          === 'true',
            app_number: '', app_version: '',
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
          for (const cor of toArr(dev.ComObjectInstanceRefs?.ComObjectInstanceRef)) {
            const refId     = a(cor,'RefId');
            const channelId = a(cor,'ChannelId');
            const linksAttr = a(cor,'Links');

            // Skip direction-label Text on instance refs — these are generic placeholders, not user-given names
            const DIRECTION_RE = /^(input|output|input\/output|in|out|eingang|ausgang|ein\/ausgang|ein|aus|entrée|sortie|entrée\/sortie|ingresso|uscita|ingresso\/uscita|entrada|salida|entrada\/salida)$/i;
            let name = DIRECTION_RE.test(a(cor,'Text')) ? '' : (a(cor,'Text') || '');
            let dpt  = a(cor,'DatapointType') || '';
            let function_text = '';
            let objectSize = '';
            let channel = '';
            let read = false, write = false, comm = false, tx = false;
            // Fallback: extract base object number from O-{n} pattern in refId
            let objNum = parseInt((refId.match(/(?:^|_)O-(\d+)/) || [])[1] ?? '0');

            if (appIdx) {
              const resolved = appIdx.resolveCoRef(refId, channelId);
              if (resolved) {
                if (!name) name = resolved.name;
                function_text = resolved.function_text || '';
                if (!dpt)  dpt  = resolved.dpt;
                objectSize = resolved.objectSize;
                channel    = resolved.channel;
                read = resolved.read; write = resolved.write;
                comm = resolved.comm; tx    = resolved.tx;
                objNum = resolved.objectNumber ?? objNum;
              }
              // Also merge overrides from the active Dynamic tree variants
              if (activeCorefsByObjNum && objNum != null) {
                const entries = activeCorefsByObjNum.get(objNum);
                if (entries) {
                  for (const { corId, channel: ch } of entries) {
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

            const updateFlag = a(cor,'UpdateFlag') === 'Enabled';
            const flags = buildFlags({ read, write, comm, tx, u: updateFlag });
            const coObj = {
              device_address: ia,
              object_number:  objNum,
              channel,
              name,
              function_text,
              dpt,
              object_size: objectSize,
              flags,
              direction: tx && !write ? 'output' : !tx && write ? 'input' : 'both',
              ga_address: '',
              ga_send: '',
              ga_receive: '',
            };

            const coGAs = [], coSend = [], coRecv = [];
            const addGA = (gaAddr, isSend, isRecv) => {
              if (!coGAs.includes(gaAddr)) { coGAs.push(gaAddr); links.push({ deviceAddress: ia, gaAddress: gaAddr }); }
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
              const gaAddr = resolveGA(a(conn,'GroupAddressRefId'));
              if (gaAddr) addGA(gaAddr, true, false);
            }
            for (const conn of toArr(cor.Connectors?.Receive)) {
              const gaAddr = resolveGA(a(conn,'GroupAddressRefId'));
              if (gaAddr) addGA(gaAddr, false, true);
            }

            coObj.ga_address = coGAs.join(' ');
            coObj.ga_send    = coSend.join(' ');
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
              toArr(dev.ComObjectInstanceRefs?.ComObjectInstanceRef).map(cor => {
                const refId = a(cor,'RefId');
                if (!refId) return null;
                const r = appIdx.resolveCoRef(refId, a(cor,'ChannelId'));
                return r ? r.objectNumber : null;
              }).filter(n => n != null)
            );

            // For each object number, resolve all active ComObjectRef variants and merge
            for (const [objNum, entries] of activeCorefsByObjNum) {
              try {
              if (linkedObjNums.has(objNum)) continue;
              // Resolve each variant and merge: later overrides win per-attribute
              let merged = null;
              let channel = '';
              for (const { corId, channel: ch } of entries) {
                const r = appIdx.resolveCoRefById(corId);
                if (!r) continue;
                if (ch) channel = ch;
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
              if (!merged || (!merged.name && !merged.function_text)) continue;
              comObjects.push({
                device_address: ia,
                object_number:  merged.objectNumber,
                channel:        channel || merged.channel,
                name:           merged.name,
                function_text:  merged.function_text,
                dpt:            merged.dpt,
                object_size:    merged.objectSize,
                flags:          buildFlags(merged),
                direction:      merged.tx && !merged.write ? 'output' : !merged.tx && merged.write ? 'input' : 'both',
                ga_address:     '',
              });
              } catch (e) { console.error('[ETS] CO merge error:', objNum, e.message); }
            }
          }
        }
      }
    }

    // ── Locations / building structure ───────────────────────────────────────
    if (installation.Locations) {
      parseLocationsRec(toArr(installation.Locations.Space), null, spaces, devSpaceMap, devInstById);
    }
  }

  // Deduplicate links
  const seen  = new Set();
  const uLinks = links.filter(l => {
    const k = `${l.deviceAddress}||${l.gaAddress}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });

  // Build param models for all app programs found
  const paramModels = {};
  for (const [aid, idx] of Object.entries(appByAppId)) {
    try {
      const m = idx.buildParamModel?.();
      if (m) {
        // Also attach loadProcedures so the client/downloader can use them
        m.loadProcedures = idx.loadProcedures || [];
        paramModels[aid] = m;
      }
    } catch (_) {}
  }

  // ── Project thumbnail ──────────────────────────────────────────────────────
  let thumbnail = null;
  const jpgEntry = entries.find(e => /project\.jpg$/i.test(e.entryName));
  if (jpgEntry) {
    try { thumbnail = jpgEntry.getData().toString('base64'); } catch (_) {}
  }

  return { projectName, devices, groupAddresses, comObjects, links: uLinks, spaces, devSpaceMap, paramModels, thumbnail, projectInfo, knxMasterXml, catalogSections, catalogItems, topologyEntries };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function inferType(name, productRef, model, hw = {}) {
  if (hw.isCoupler) return 'router';
  const n = `${name} ${productRef} ${model}`.toLowerCase();
  if (/router|ip.?coupl|backbone|knxip/.test(n))                           return 'router';
  if (/sensor|button|push|detect|weather|temp|co2|presence|motion|bs\.tp|keypad|panel|scene/.test(n)) return 'sensor';
  return 'actuator';
}

function buildFlags({ read, write, comm, tx, u }) {
  return [comm&&'C', read&&'R', write&&'W', tx&&'T', u&&'U'].filter(Boolean).join('') || 'CW';
}

module.exports = { parseKnxproj, looksEncrypted, inferType, buildFlags };
