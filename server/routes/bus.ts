import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import * as db from '../db.ts';
import { APPS_DIR, getDptInfo } from './shared.ts';
import { logger, safeError } from '../log.ts';
import { validateBody } from '../validate.ts';
import {
  buildGATable,
  buildAssocTable,
  resolveParamSegment,
  buildParamMem,
} from './knx-tables.ts';
import type {
  Setting,
  Device,
  ComObject,
  GroupAddress,
  Telegram,
  DptInfoEntry,
} from '../../shared/types.ts';
import type KnxBusManager from '../knx-bus.ts';
import type { DownloadStep, DownloadProgress } from '../knx-connection.ts';

let bus: KnxBusManager | null = null;
export const router = express.Router();

/** Return the bus instance or send a 503 and return null. */
function requireBus(res: Response): KnxBusManager | null {
  if (!bus) {
    res.status(503).json({ error: 'Bus not initialised' });
    return null;
  }
  return bus;
}

// ── Demo mode address remapping ──────────────────────────────────────────────
let _demoDevMap: Record<string, string> | null = null;
let _demoGaMap: Record<string, string> | null = null;
let _demoGaMapRev: Record<string, string> | null = null;

export function rebuildDemoMap(): void {
  const mapRow = db.get<Setting>(
    "SELECT value FROM settings WHERE key='demo_addr_map'",
  );
  if (!mapRow || !mapRow.value) {
    _demoDevMap = null;
    _demoGaMap = null;
    rebuildReverseMaps();
    return;
  }
  try {
    const map = JSON.parse(mapRow.value) as {
      devices?: Record<string, string>;
      gas?: Record<string, string>;
    };
    _demoDevMap = map.devices || null;
    _demoGaMap = map.gas || null;
    logger.info(
      'bus',
      `Address map loaded: ${Object.keys(_demoDevMap || {}).length} devices, ${Object.keys(_demoGaMap || {}).length} GAs`,
    );
    rebuildReverseMaps();
  } catch (e) {
    const err = e as Error;
    logger.error('bus', 'Failed to parse demo_addr_map', {
      error: err.message,
    });
    _demoDevMap = null;
    _demoGaMap = null;
    rebuildReverseMaps();
  }
}

function isDemoProjectActive(): boolean {
  if (!bus) return false;
  const pid = bus.projectId;
  if (!pid) return false;
  const proj = db.get<{ name: string }>(
    'SELECT name FROM projects WHERE id=?',
    [+pid],
  );
  return proj != null && proj.name.includes('Demo');
}

function remapTelegram(telegram: Telegram): Telegram {
  if ((!_demoDevMap && !_demoGaMap) || !isDemoProjectActive()) return telegram;
  return {
    ...telegram,
    src: (_demoDevMap && _demoDevMap[telegram.src]) || telegram.src,
    dst: (_demoGaMap && _demoGaMap[telegram.dst]) || telegram.dst,
  };
}

function rebuildReverseMaps(): void {
  _demoGaMapRev = _demoGaMap
    ? Object.fromEntries(Object.entries(_demoGaMap).map(([k, v]) => [v, k]))
    : null;
}

/** Map a demo GA back to the real bus GA for sending */
function demoToReal(demoAddr: string): string {
  if (!_demoGaMapRev || !isDemoProjectActive()) return demoAddr;
  return _demoGaMapRev[demoAddr] || demoAddr;
}

// ── DPT-aware telegram decoding ──────────────────────────────────────────────
export function normalizeDptKey(dpt: string | null | undefined): string | null {
  if (!dpt) return null;
  const m = dpt.match(/^DPS?T-(\d+)-(\d+)$/i);
  if (m) return `${m[1]}.${m[2]!.padStart(3, '0')}`;
  if (dpt.includes('.')) {
    const [a, b] = dpt.split('.');
    return `${a}.${b!.padStart(3, '0')}`;
  }
  return null;
}

// Pure DPT-aware decode: takes raw hex string, normalized DPT key, and optional
// DPT info (enums, coefficient). Returns decoded string or null if no decoding applied.
export function decodeRawValue(
  rawHex: string | null | undefined,
  dptKey: string | null | undefined,
  info?: DptInfoEntry | undefined,
): string | null {
  if (!rawHex || !dptKey) return null;
  const major = parseInt(dptKey.split('.')[0]!, 10);
  const rawBuf = Buffer.from(rawHex, 'hex');
  if (!rawBuf.length) return null;

  // Use enums if available (e.g. DPT 1: On/Off, DPT 20: HVAC modes)
  if (info?.enums) {
    const v = rawBuf.length === 1 ? rawBuf[0]! : rawBuf.readUInt16BE(0);
    if (info.enums[v] !== undefined) return info.enums[v]!;
  }

  if (rawBuf.length === 1) {
    const v = rawBuf[0]!;
    if (major === 2) {
      const c = (v >> 1) & 1;
      const val = v & 1;
      return `c=${c} v=${val}`;
    }
    if (major === 3) {
      const c = (v >> 3) & 1;
      const stepcode = v & 0x07;
      return `c=${c} step=${stepcode}`;
    }
    if (major === 4) {
      return String.fromCharCode(v);
    }
    if (major === 6) {
      return String(rawBuf.readInt8(0));
    }
    if (major === 17) {
      return String(v & 0x3f);
    }
    if (major === 18) {
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
      const raw = rawBuf.readUInt16BE(0);
      const sign = (raw >> 15) & 1,
        exp = (raw >> 11) & 0xf,
        mant = raw & 0x7ff;
      const signedMant = sign ? mant - 2048 : mant;
      return (0.01 * signedMant * Math.pow(2, exp)).toFixed(2);
    }
    if (major === 7) {
      const v = rawBuf.readUInt16BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
    if (major === 8) {
      const v = rawBuf.readInt16BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
  }
  if (rawBuf.length === 3) {
    if (major === 10) {
      const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const day = (rawBuf[0]! >> 5) & 0x07;
      const hour = rawBuf[0]! & 0x1f;
      const min = rawBuf[1]! & 0x3f;
      const sec = rawBuf[2]! & 0x3f;
      const dayStr = DAYS[day] || '';
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      return dayStr ? `${dayStr} ${timeStr}` : timeStr;
    }
    if (major === 11) {
      const day = rawBuf[0]! & 0x1f;
      const month = rawBuf[1]! & 0x0f;
      const yr = rawBuf[2]! & 0x7f;
      const year = yr >= 90 ? 1900 + yr : 2000 + yr;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (major === 232) {
      return '#' + rawBuf.toString('hex');
    }
  }
  if (rawBuf.length === 4) {
    if (major === 14) {
      return rawBuf.readFloatBE(0).toFixed(2);
    }
    if (major === 12) {
      const v = rawBuf.readUInt32BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
    if (major === 13) {
      const v = rawBuf.readInt32BE(0);
      const coeff = info?.coefficient;
      return coeff != null
        ? (v * coeff).toFixed(1).replace(/\.0$/, '')
        : String(v);
    }
  }
  if (rawBuf.length === 6) {
    if (major === 242) {
      const xRaw = rawBuf.readUInt16BE(0);
      const yRaw = rawBuf.readUInt16BE(2);
      const bri = rawBuf[4]!;
      const x = (xRaw / 65535).toFixed(3);
      const y = (yRaw / 65535).toFixed(3);
      const briPct = Math.round((bri / 255) * 100);
      return `xyY(${x}, ${y}, ${briPct}%)`;
    }
    if (major === 251) {
      const r = rawBuf[0]!,
        g = rawBuf[1]!,
        b = rawBuf[2]!,
        w = rawBuf[3]!;
      return `RGBW(${r},${g},${b},${w})`;
    }
  }
  if (rawBuf.length === 8 && major === 19) {
    const year = 1900 + rawBuf[0]!;
    const month = rawBuf[1]! & 0x0f;
    const day = rawBuf[2]! & 0x1f;
    const hour = rawBuf[3]! & 0x1f;
    const min = rawBuf[4]! & 0x3f;
    const sec = rawBuf[5]! & 0x3f;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  if (rawBuf.length === 14 && major === 16) {
    let end = rawBuf.indexOf(0x00);
    if (end === -1) end = 14;
    return rawBuf.subarray(0, end).toString('latin1');
  }
  return null;
}

function decodeTelegram(telegram: Telegram): Telegram {
  if (
    !telegram.projectId ||
    !telegram.dst?.includes('/') ||
    !telegram.raw_value
  )
    return telegram;

  const ga = db.get<{ dpt: string }>(
    'SELECT dpt FROM group_addresses WHERE project_id=? AND address=?',
    [telegram.projectId, telegram.dst],
  );
  if (!ga?.dpt) return telegram;

  const key = normalizeDptKey(ga.dpt);
  if (!key) return telegram;
  const dptInfo = getDptInfo(telegram.projectId as number);
  const info = dptInfo[key];
  const decoded = decodeRawValue(telegram.raw_value, key, info);
  return decoded != null ? { ...telegram, decoded } : telegram;
}

// Bus event wiring — deferred until setBus() is called
function wireBusEvents(): void {
  if (!bus) return;
  bus.setRemapper((telegram: Telegram) =>
    decodeTelegram(remapTelegram(telegram)),
  );
  setTimeout(() => {
    try {
      rebuildDemoMap();
    } catch (e) {
      logger.error('bus', 'rebuildDemoMap failed', {
        error: (e as Error).message,
      });
    }
  }, 0);
  bus.on('telegram', (...args: unknown[]) => {
    const telegram = args[0] as Telegram;
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
    } catch (e) {
      logger.error('knx', 'telegram log failed', {
        error: (e as Error).message,
      });
    }
  });
}

// ── KNX Bus routes ───────────────────────────────────────────────────────────
router.get('/bus/status', (_req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  res.json(b.status());
});

router.post('/bus/connect', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      host: z.string().min(1),
      port: z.coerce.number().int().positive().optional(),
      projectId: z.number().int().optional(),
    }),
  );
  const { host, port, projectId } = body;
  try {
    const result = await b.connect(host, port || 3671, projectId);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_host',?)", [host]);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_port',?)", [
      String(port || 3671),
    ]);
    db.scheduleSave();
    res.json({ ok: true, ...result });
  } catch (e) {
    res
      .status(502)
      .json({ error: safeError('bus', 'Bus connection failed', e) });
  }
});

router.get('/bus/usb-devices', (_req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  try {
    const devices = b.listUsbDevices();
    res.json({ devices });
  } catch (e) {
    res
      .status(500)
      .json({ error: safeError('bus', 'Failed to list USB devices', e) });
  }
});

router.get('/bus/usb-devices/all', (_req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  try {
    const devices = b.listAllHidDevices();
    res.json({ devices });
  } catch (e) {
    res
      .status(500)
      .json({ error: safeError('bus', 'Failed to list HID devices', e) });
  }
});

router.post('/bus/connect-usb', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      devicePath: z.string().min(1),
      projectId: z.number().int().optional(),
    }),
  );
  const { devicePath, projectId } = body;
  try {
    const result = await b.connectUsb(devicePath, projectId);
    res.json({ ok: true, type: 'usb', ...result });
  } catch (e) {
    res
      .status(502)
      .json({ error: safeError('bus', 'USB connection failed', e) });
  }
});

router.post('/bus/project', (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({ projectId: z.number().int().positive().nullable() }),
  );
  b.projectId = body.projectId;
  res.json({ ok: true });
});

router.post('/bus/disconnect', (_req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  b.disconnect();
  res.json({ ok: true });
});

router.post('/bus/write', (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      ga: z.string().min(1),
      value: z.unknown(),
      dpt: z.string().optional(),
      projectId: z.number().int().optional(),
    }),
  );
  const { ga, value, dpt, projectId } = body;
  try {
    const busGa = demoToReal(ga);
    const result = b.write(busGa, value, dpt);
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
      b.broadcast('knx:telegram', {
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
  } catch (e) {
    res.status(502).json({ error: safeError('bus', 'Bus write failed', e) });
  }
});

router.post('/bus/read', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(req, z.object({ ga: z.string().min(1) }));
  try {
    res.json(await b.read(body.ga));
  } catch (e) {
    res.status(502).json({ error: safeError('bus', 'Bus read failed', e) });
  }
});

// Probe device reachability
router.post('/bus/ping', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      gaAddresses: z.array(z.string()).optional().default([]),
      deviceAddress: z.string().optional(),
    }),
  );
  const { gaAddresses, deviceAddress } = body;
  try {
    const result = await b.ping(gaAddresses, deviceAddress || null);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeError('bus', 'Ping failed', e) });
  }
});

// Flash programming LED on device
router.post('/bus/identify', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({ deviceAddress: z.string().min(1) }),
  );
  const { deviceAddress } = body;
  try {
    await b.identify(deviceAddress);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeError('bus', 'Identify failed', e) });
  }
});

// Bus scan -- streams progress via WebSocket, returns immediately
let _activeScan: Promise<void> | null = null;
router.post('/bus/scan', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      area: z.coerce.number().int().min(0).optional().default(1),
      line: z.coerce.number().int().min(0).optional().default(1),
      timeout: z.coerce.number().int().positive().optional().default(200),
    }),
  );
  const { area, line, timeout } = body;
  if (!b.connected) return res.status(409).json({ error: 'Not connected' });
  if (_activeScan) {
    b.abortScan();
    try {
      await _activeScan;
    } catch (_) {}
  }
  res.json({ ok: true });
  _activeScan = b
    .scan(area, line, timeout, (prog) => {
      b.broadcast('scan:progress', { ...prog });
    })
    .then((results) => {
      b.broadcast('scan:done', { results, area, line });
      _activeScan = null;
    })
    .catch((err: Error) => {
      b.broadcast('scan:error', { error: err.message });
      _activeScan = null;
    });
});

router.post('/bus/scan/abort', (_req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  b.abortScan();
  _activeScan = null;
  res.json({ ok: true });
});

// ── Device info ──────────────────────────────────────────────────────────────
router.post('/bus/device-info', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({ deviceAddress: z.string().min(1) }),
  );
  const { deviceAddress } = body;
  if (!b.connected) return res.status(409).json({ error: 'Not connected' });
  try {
    const info = await b.readDeviceInfo(deviceAddress);
    res.json(info);
  } catch (e) {
    res
      .status(500)
      .json({ error: safeError('bus', 'Failed to read device info', e) });
  }
});

// ── KNX Programming ───────────────────────────────────────────────────────────

// Write individual address (device must be in programming mode)
router.post('/bus/program-ia', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(req, z.object({ newAddr: z.string().min(1) }));
  const { newAddr } = body;
  if (!b.connected) return res.status(409).json({ error: 'Bus not connected' });
  try {
    const result = await b.programIA(newAddr);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: safeError('bus', 'Program IA failed', e) });
  }
});

// Full application download for a device
router.post('/bus/program-device', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      projectId: z.number().int().optional(),
      deviceId: z.number().int().optional(),
    }),
  );
  const { deviceAddress, projectId, deviceId } = body;
  if (!b.connected) return res.status(409).json({ error: 'Bus not connected' });

  // Load device data
  const dev = deviceId
    ? db.get<Device>('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get<Device>(
        'SELECT * FROM devices WHERE individual_address=? AND project_id=?',
        [deviceAddress, +(projectId ?? 0)],
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

  interface AppModel {
    loadProcedures?: Array<{
      type: string;
      data?: string;
      [key: string]: unknown;
    }>;
    paramMemLayout?: Record<string, unknown>;
    dynTree?: unknown;
    params?: Record<string, unknown>;
  }

  let model: AppModel;
  try {
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as AppModel;
  } catch {
    return res.status(500).json({ error: 'Failed to read app model' });
  }
  if (!model.loadProcedures?.length)
    return res.status(400).json({
      error: 'no_ldctrl',
      message: 'No load procedures found. Re-import the project.',
    });

  // Build GA table from project data
  const coRows = db.all<ComObject>(
    'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
    [dev.id],
  );
  const gaAddrsUsed = new Set<string>();
  for (const co of coRows)
    for (const a of (co.ga_address || '').split(/\s+/).filter(Boolean))
      gaAddrsUsed.add(a);
  const gaLinks =
    gaAddrsUsed.size > 0
      ? db.all<GroupAddress>(
          `SELECT address, main_g, middle_g, sub_g FROM group_addresses WHERE project_id=? AND address IN (${[...gaAddrsUsed].map(() => '?').join(',')}) ORDER BY main_g, middle_g, sub_g`,
          [dev.project_id, ...gaAddrsUsed],
        )
      : [];

  const gaTable = buildGATable(gaLinks);
  const assocTable = buildAssocTable(coRows, gaLinks);

  // Parameter memory: build from param layout + current values
  const { paramSize, paramFill, relSegHex } = resolveParamSegment(
    model as Parameters<typeof resolveParamSegment>[0],
  );
  let paramMem: Buffer | null = null;
  if (paramSize > 0 && model.paramMemLayout) {
    let currentValues: Record<string, unknown> = {};
    try {
      currentValues = JSON.parse(dev.param_values || '{}') as Record<
        string,
        unknown
      >;
    } catch (_) {}
    paramMem = buildParamMem(
      paramSize,
      model.paramMemLayout as Parameters<typeof buildParamMem>[1],
      currentValues,
      paramFill,
      relSegHex,
      model.dynTree as Parameters<typeof buildParamMem>[5],
      model.params as Parameters<typeof buildParamMem>[6],
    );
  } else if (paramSize > 0) {
    paramMem = Buffer.alloc(paramSize, 0xff);
  }

  // Convert step data from hex strings back to Buffers
  const steps: DownloadStep[] = model.loadProcedures.map((s) => ({
    ...s,
    data: s.data ? Buffer.from(s.data, 'hex') : undefined,
  })) as DownloadStep[];

  // Stream progress via WebSocket
  const onProgress = (p: DownloadProgress): void =>
    b.broadcast('program:progress', { deviceAddress, ...p });
  onProgress({ msg: `Starting download to ${deviceAddress}`, pct: 0 });

  try {
    await b.downloadDevice(
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
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    b.broadcast('program:progress', {
      deviceAddress,
      msg: `Error: ${errMsg}`,
      pct: -1,
      error: true,
    });
    res
      .status(502)
      .json({ error: safeError('bus', 'Device programming failed', e) });
  }
});

export function setBus(b: KnxBusManager): void {
  bus = b;
  wireBusEvents();
}
