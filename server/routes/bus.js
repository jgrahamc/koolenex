'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db.ts');
const { APPS_DIR, getDptInfo } = require('./shared.ts');
const {
  buildGATable,
  buildAssocTable,
  resolveParamSegment,
  buildParamMem,
} = require('./knx-tables.ts');

let bus = null;
const router = express.Router();

// ── Demo mode address remapping ──────────────────────────────────────────────
let _demoDevMap = null; // real IA -> demo IA
let _demoGaMap = null; // real GA -> demo GA
let _demoGaMapRev = null;

function rebuildDemoMap() {
  const mapRow = db.get("SELECT value FROM settings WHERE key='demo_addr_map'");
  if (!mapRow || !mapRow.value) {
    _demoDevMap = null;
    _demoGaMap = null;
    rebuildReverseMaps();
    return;
  }
  try {
    const map = JSON.parse(mapRow.value);
    _demoDevMap = map.devices || null;
    _demoGaMap = map.gas || null;
    console.log(
      `[DEMO] Address map loaded: ${Object.keys(_demoDevMap || {}).length} devices, ${Object.keys(_demoGaMap || {}).length} GAs`,
    );
    rebuildReverseMaps();
  } catch (e) {
    console.error('[DEMO] Failed to parse demo_addr_map:', e.message);
    _demoDevMap = null;
    _demoGaMap = null;
    rebuildReverseMaps();
  }
}

function isDemoProjectActive() {
  const pid = bus.projectId;
  if (!pid) return false;
  const proj = db.get('SELECT name FROM projects WHERE id=?', [+pid]);
  return proj && proj.name.includes('Demo');
}

function remapTelegram(telegram) {
  if ((!_demoDevMap && !_demoGaMap) || !isDemoProjectActive()) return telegram;
  return {
    ...telegram,
    src: (_demoDevMap && _demoDevMap[telegram.src]) || telegram.src,
    dst: (_demoGaMap && _demoGaMap[telegram.dst]) || telegram.dst,
  };
}

function rebuildReverseMaps() {
  _demoGaMapRev = _demoGaMap
    ? Object.fromEntries(Object.entries(_demoGaMap).map(([k, v]) => [v, k]))
    : null;
}

/** Map a demo GA back to the real bus GA for sending */
function demoToReal(demoAddr) {
  if (!_demoGaMapRev || !isDemoProjectActive()) return demoAddr;
  return _demoGaMapRev[demoAddr] || demoAddr;
}

// ── DPT-aware telegram decoding ──────────────────────────────────────────────
function normalizeDptKey(dpt) {
  if (!dpt) return null;
  const m = dpt.match(/^DPS?T-(\d+)-(\d+)$/i);
  if (m) return `${m[1]}.${m[2].padStart(3, '0')}`;
  if (dpt.includes('.')) {
    const [a, b] = dpt.split('.');
    return `${a}.${b.padStart(3, '0')}`;
  }
  return null;
}

// Pure DPT-aware decode: takes raw hex string, normalized DPT key, and optional
// DPT info (enums, coefficient). Returns decoded string or null if no decoding applied.
function decodeRawValue(rawHex, dptKey, info) {
  if (!rawHex || !dptKey) return null;
  const major = parseInt(dptKey.split('.')[0]);
  const rawBuf = Buffer.from(rawHex, 'hex');
  if (!rawBuf.length) return null;

  // Use enums if available (e.g. DPT 1: On/Off, DPT 20: HVAC modes)
  if (info?.enums) {
    const v = rawBuf.length === 1 ? rawBuf[0] : rawBuf.readUInt16BE(0);
    if (info.enums[v] !== undefined) return info.enums[v];
  }

  if (rawBuf.length === 1) {
    const v = rawBuf[0];
    if (major === 2) {
      // DPT 2: control + value (2 bits)
      const c = (v >> 1) & 1;
      const val = v & 1;
      return `c=${c} v=${val}`;
    }
    if (major === 3) {
      // DPT 3: control + stepcode (4 bits)
      const c = (v >> 3) & 1;
      const stepcode = v & 0x07;
      return `c=${c} step=${stepcode}`;
    }
    if (major === 4) {
      // DPT 4: ASCII/8859-1 character
      return String.fromCharCode(v);
    }
    if (major === 6) {
      // DPT 6: signed int8
      return String(rawBuf.readInt8(0));
    }
    if (major === 17) {
      // DPT 17: scene number (0-63)
      return String(v & 0x3f);
    }
    if (major === 18) {
      // DPT 18: scene control
      const ctrl = (v >> 7) & 1;
      const scene = v & 0x3f;
      return ctrl ? `learn scene ${scene}` : `activate scene ${scene}`;
    }
    const coeff = info?.coefficient;
    return coeff != null
      ? (v * coeff).toFixed(1).replace(/\.0$/, '')
      : String(v);
  }
  if (rawBuf.length === 2) {
    if (major === 9) {
      // DPT 9: KNX 2-byte float
      const raw = rawBuf.readUInt16BE(0);
      const sign = (raw >> 15) & 1,
        exp = (raw >> 11) & 0xf,
        mant = raw & 0x7ff;
      const signedMant = sign ? mant - 2048 : mant;
      return (0.01 * signedMant * Math.pow(2, exp)).toFixed(2);
    }
    if (major === 7) {
      // DPT 7: 16-bit unsigned integer
      const v = rawBuf.readUInt16BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
    if (major === 8) {
      // DPT 8: 16-bit signed integer
      const v = rawBuf.readInt16BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
  }
  if (rawBuf.length === 3) {
    if (major === 10) {
      // DPT 10: time of day
      const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const day = (rawBuf[0] >> 5) & 0x07;
      const hour = rawBuf[0] & 0x1f;
      const min = rawBuf[1] & 0x3f;
      const sec = rawBuf[2] & 0x3f;
      const dayStr = DAYS[day] || '';
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      return dayStr ? `${dayStr} ${timeStr}` : timeStr;
    }
    if (major === 11) {
      // DPT 11: date
      const day = rawBuf[0] & 0x1f;
      const month = rawBuf[1] & 0x0f;
      const yr = rawBuf[2] & 0x7f;
      const year = yr >= 90 ? 1900 + yr : 2000 + yr;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (major === 232) {
      // DPT 232: RGB colour
      return '#' + rawBuf.toString('hex');
    }
  }
  if (rawBuf.length === 4) {
    if (major === 14) {
      // DPT 14: 32-bit IEEE 754 float
      return rawBuf.readFloatBE(0).toFixed(2);
    }
    if (major === 12) {
      // DPT 12: 32-bit unsigned
      const v = rawBuf.readUInt32BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
    if (major === 13) {
      // DPT 13: 32-bit signed
      const v = rawBuf.readInt32BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
  }
  if (rawBuf.length === 6) {
    if (major === 242) {
      // DPT 242: xyY colour
      const xRaw = rawBuf.readUInt16BE(0);
      const yRaw = rawBuf.readUInt16BE(2);
      const bri = rawBuf[4];
      const x = (xRaw / 65535).toFixed(3);
      const y = (yRaw / 65535).toFixed(3);
      const briPct = Math.round((bri / 255) * 100);
      return `xyY(${x}, ${y}, ${briPct}%)`;
    }
    if (major === 251) {
      // DPT 251: RGBW colour
      const r = rawBuf[0],
        g = rawBuf[1],
        b = rawBuf[2],
        w = rawBuf[3];
      return `RGBW(${r},${g},${b},${w})`;
    }
  }
  if (rawBuf.length === 8 && major === 19) {
    // DPT 19: date/time
    const year = 1900 + rawBuf[0];
    const month = rawBuf[1] & 0x0f;
    const day = rawBuf[2] & 0x1f;
    const hour = rawBuf[3] & 0x1f;
    const min = rawBuf[4] & 0x3f;
    const sec = rawBuf[5] & 0x3f;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  if (rawBuf.length === 14 && major === 16) {
    // DPT 16: 14-byte string
    let end = rawBuf.indexOf(0x00);
    if (end === -1) end = 14;
    return rawBuf.subarray(0, end).toString('latin1');
  }
  return null;
}

function decodeTelegram(telegram) {
  if (
    !telegram.projectId ||
    !telegram.dst?.includes('/') ||
    !telegram.raw_value
  )
    return telegram;

  const ga = db.get(
    'SELECT dpt FROM group_addresses WHERE project_id=? AND address=?',
    [telegram.projectId, telegram.dst],
  );
  if (!ga?.dpt) return telegram;

  const key = normalizeDptKey(ga.dpt);
  if (!key) return telegram;
  const info = getDptInfo(telegram.projectId)[key];
  const decoded = decodeRawValue(telegram.raw_value, key, info);
  return decoded != null ? { ...telegram, decoded } : telegram;
}

// Bus event wiring — deferred until setBus() is called
function wireBusEvents() {
  if (!bus) return;
  bus.setRemapper((telegram) => decodeTelegram(remapTelegram(telegram)));
  setTimeout(() => {
    try {
      rebuildDemoMap();
    } catch (_) {}
  }, 0);
  bus.on('telegram', (telegram) => {
    if (!telegram.projectId) return;
    try {
      db.run(
        'INSERT INTO bus_telegrams (project_id,src,dst,type,raw_value,decoded,priority) VALUES (?,?,?,?,?,?,?)',
        [
          telegram.projectId,
          telegram.src,
          telegram.dst,
          telegram.type,
          telegram.raw_value,
          telegram.decoded,
          telegram.priority || 'low',
        ],
      );
      db.scheduleSave(500);
    } catch (_) {}
  });
}

// ── KNX Bus routes ───────────────────────────────────────────────────────────
router.get('/bus/status', (req, res) => res.json(bus.status()));

router.post('/bus/connect', async (req, res) => {
  const { host, port, projectId } = req.body;
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const result = await bus.connect(host, parseInt(port) || 3671, projectId);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_host',?)", [host]);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_port',?)", [
      String(port || 3671),
    ]);
    db.scheduleSave();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/bus/usb-devices', (req, res) => {
  try {
    const devices = bus.listUsbDevices();
    res.json({ devices });
  } catch (err) {
    res.json({ devices: [], error: err.message });
  }
});

router.get('/bus/usb-devices/all', (req, res) => {
  try {
    const devices = bus.listAllHidDevices();
    res.json({ devices });
  } catch (err) {
    res.json({ devices: [], error: err.message });
  }
});

router.post('/bus/connect-usb', async (req, res) => {
  const { devicePath, projectId } = req.body;
  if (!devicePath)
    return res.status(400).json({ error: 'devicePath required' });
  try {
    const result = await bus.connectUsb(devicePath, projectId);
    res.json({ ok: true, type: 'usb', ...result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/bus/project', (req, res) => {
  const { projectId } = req.body;
  bus.projectId = projectId || null;
  res.json({ ok: true });
});

router.post('/bus/disconnect', (req, res) => {
  bus.disconnect();
  res.json({ ok: true });
});

router.post('/bus/write', (req, res) => {
  const { ga, value, dpt, projectId } = req.body;
  if (!ga) return res.status(400).json({ error: 'ga required' });
  try {
    const busGa = demoToReal(ga); // demo GA -> real bus GA
    const result = bus.write(busGa, value, dpt);
    if (projectId) {
      db.run(
        'INSERT INTO bus_telegrams (project_id,src,dst,type,raw_value,decoded,priority) VALUES (?,?,?,?,?,?,?)',
        [
          projectId,
          'local',
          ga,
          'GroupValue_Write',
          String(value),
          String(value),
          'low',
        ],
      );
      db.scheduleSave();
      bus.broadcast('knx:telegram', {
        telegram: {
          timestamp: new Date().toISOString(),
          src: 'local',
          dst: ga,
          type: 'GroupValue_Write',
          raw_value: String(value),
          decoded: String(value),
        },
        projectId,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/bus/read', async (req, res) => {
  try {
    res.json(await bus.read(req.body.ga));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Probe device reachability
router.post('/bus/ping', async (req, res) => {
  const { gaAddresses = [], deviceAddress } = req.body;
  try {
    const result = await bus.ping(gaAddresses, deviceAddress || null);
    res.json(result);
  } catch (err) {
    res
      .status(err.message.includes('Not connected') ? 409 : 502)
      .json({ error: err.message });
  }
});

// Flash programming LED on device
router.post('/bus/identify', async (req, res) => {
  const { deviceAddress } = req.body;
  if (!deviceAddress)
    return res.status(400).json({ error: 'deviceAddress required' });
  try {
    await bus.identify(deviceAddress);
    res.json({ ok: true });
  } catch (err) {
    res
      .status(err.message.includes('Not connected') ? 409 : 502)
      .json({ error: err.message });
  }
});

// Bus scan -- streams progress via WebSocket, returns immediately
let _activeScan = null;
router.post('/bus/scan', (req, res) => {
  const { area = 1, line = 1, timeout = 200 } = req.body;
  if (!bus.connected) return res.status(409).json({ error: 'Not connected' });
  if (_activeScan) bus.abortScan();
  res.json({ ok: true });
  _activeScan = bus
    .scan(parseInt(area), parseInt(line), parseInt(timeout), (prog) => {
      bus.broadcast('scan:progress', prog);
    })
    .then((results) => {
      bus.broadcast('scan:done', {
        results,
        area: parseInt(area),
        line: parseInt(line),
      });
      _activeScan = null;
    })
    .catch((err) => {
      bus.broadcast('scan:error', { error: err.message });
      _activeScan = null;
    });
});

router.post('/bus/scan/abort', (req, res) => {
  bus.abortScan();
  _activeScan = null;
  res.json({ ok: true });
});

// ── Device info ──────────────────────────────────────────────────────────────
router.post('/bus/device-info', async (req, res) => {
  const { deviceAddress } = req.body;
  if (!deviceAddress)
    return res.status(400).json({ error: 'deviceAddress required' });
  if (!bus.connected) return res.status(409).json({ error: 'Not connected' });
  try {
    const info = await bus.readDeviceInfo(deviceAddress);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KNX Programming ───────────────────────────────────────────────────────────

// Write individual address (device must be in programming mode)
router.post('/bus/program-ia', async (req, res) => {
  const { newAddr } = req.body;
  if (!newAddr) return res.status(400).json({ error: 'newAddr required' });
  if (!bus.connected)
    return res.status(409).json({ error: 'Bus not connected' });
  try {
    const result = await bus.programIA(newAddr);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Full application download for a device
router.post('/bus/program-device', async (req, res) => {
  const { deviceAddress, projectId, deviceId } = req.body;
  if (!deviceAddress)
    return res.status(400).json({ error: 'deviceAddress required' });
  if (!bus.connected)
    return res.status(409).json({ error: 'Bus not connected' });

  // Load device data
  const dev = deviceId
    ? db.get('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get(
        'SELECT * FROM devices WHERE individual_address=? AND project_id=?',
        [deviceAddress, +projectId],
      );
  if (!dev) return res.status(404).json({ error: 'Device not found' });

  // Load app model (load procedures)
  if (!dev.app_ref)
    return res.status(400).json({
      error: 'no_app',
      message:
        'Device has no application program reference. Re-import the project.',
    });
  const safe = dev.app_ref.replace(/[^a-zA-Z0-9_-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath))
    return res.status(400).json({
      error: 'no_model',
      message: 'App model not found. Re-import the project.',
    });
  let model;
  try {
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch {
    return res.status(500).json({ error: 'Failed to read app model' });
  }
  if (!model.loadProcedures?.length)
    return res.status(400).json({
      error: 'no_ldctrl',
      message: 'No load procedures found. Re-import the project.',
    });

  // Build GA table from project data
  const coRows = db.all(
    'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
    [dev.id],
  );
  const gaAddrsUsed = new Set();
  for (const co of coRows)
    for (const a of (co.ga_address || '').split(/\s+/).filter(Boolean))
      gaAddrsUsed.add(a);
  const gaLinks =
    gaAddrsUsed.size > 0
      ? db.all(
          `SELECT address, main_g, middle_g, sub_g FROM group_addresses WHERE project_id=? AND address IN (${[...gaAddrsUsed].map(() => '?').join(',')}) ORDER BY main_g, middle_g, sub_g`,
          [dev.project_id, ...gaAddrsUsed],
        )
      : [];

  const gaTable = buildGATable(gaLinks);
  const assocTable = buildAssocTable(coRows, gaLinks);

  // Parameter memory: build from param layout + current values
  const { paramSize, paramFill, relSegHex } = resolveParamSegment(model);
  let paramMem = null;
  if (paramSize > 0 && model.paramMemLayout) {
    let currentValues = {};
    try {
      currentValues = JSON.parse(dev.param_values || '{}');
    } catch (_) {}
    paramMem = buildParamMem(
      paramSize,
      model.paramMemLayout,
      currentValues,
      paramFill,
      relSegHex,
      model.dynTree,
      model.params,
    );
  } else if (paramSize > 0) {
    paramMem = Buffer.alloc(paramSize, 0xff);
  }

  // Convert step data from hex strings back to Buffers
  const steps = model.loadProcedures.map((s) => ({
    ...s,
    data: s.data ? Buffer.from(s.data, 'hex') : null,
  }));

  // Stream progress via WebSocket
  const onProgress = (p) =>
    bus.broadcast('program:progress', { deviceAddress, ...p });
  onProgress({ msg: `Starting download to ${deviceAddress}`, pct: 0 });

  try {
    await bus.downloadDevice(
      deviceAddress,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
    );
    db.run('UPDATE devices SET status=? WHERE id=?', ['programmed', dev.id]);
    db.scheduleSave();
    res.json({ ok: true, deviceAddress });
  } catch (err) {
    onProgress({ msg: `Error: ${err.message}`, pct: -1, error: true });
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
module.exports.normalizeDptKey = normalizeDptKey;
module.exports.decodeRawValue = decodeRawValue;
module.exports.rebuildDemoMap = rebuildDemoMap;
module.exports.setBus = (b) => {
  bus = b;
  wireBusEvents();
};
