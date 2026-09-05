import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import * as db from '../db.ts';
import { APPS_DIR, getDptInfo } from './shared.ts';
import { getPendingChanges, clearPendingChanges } from './shared.ts';
import { logger, safeErrorOrConnection } from '../log.ts';
import { resolveRelmemBases } from '../knx-segment-base.ts';
import { validateBody } from '../validate.ts';
import {
  buildGATable,
  buildAssocTable,
  buildGroupObjectTable,
  decodeGATable,
  decodeAssocTable,
  decodeGroupObjectEntry,
  describeGroupObjectEntry,
  decodeGroupObjectEntryFlags,
  resolveParamSegment,
  buildParamMem,
  diffMemory,
  decodeParamMem,
} from './knx-tables.ts';
import type {
  GroupObjectFlags,
  GroupObjectEntryFlags,
  ParamMemEntry,
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
import { delay } from '../knx-connection.ts';
import { planVerify } from '../knx-download-plan.ts';
import type { PlanStep } from '../knx-download-plan.ts';

let bus: KnxBusManager | null = null;
export const router = express.Router();

// ── GA→DPT cache (avoids per-telegram DB queries) ──────────────────────────
let _gaDptCache: Record<string, string> | null = null;
let _gaDptCacheProjectId: number | null = null;

function getGaDpt(projectId: number, gaAddress: string): string | null {
  if (_gaDptCacheProjectId !== projectId) {
    // Rebuild cache for the new project
    const rows = db.all<{ address: string; dpt: string }>(
      "SELECT address, dpt FROM group_addresses WHERE project_id=? AND dpt IS NOT NULL AND dpt != ''",
      [projectId],
    );
    _gaDptCache = Object.fromEntries(rows.map((r) => [r.address, r.dpt]));
    _gaDptCacheProjectId = projectId;
  }
  return _gaDptCache![gaAddress] ?? null;
}

/** Invalidate the GA→DPT cache (call after project import/update). */
export function invalidateGaDptCache(): void {
  _gaDptCache = null;
  _gaDptCacheProjectId = null;
}

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

  const dpt = getGaDpt(telegram.projectId as number, telegram.dst);
  if (!dpt) return telegram;

  const key = normalizeDptKey(dpt);
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
      // Which KNXnet/IP transport to use for Tunneling. 'auto' (default)
      // tries TCP first, falling back to UDP - see knx-protocol.ts and
      // docs/knx-device-write-protocol.md §9 for why TCP matters here (real
      // ETS uses it against this project's own testbed router; this app
      // only ever spoke UDP before 2026-08-30).
      protocol: z.enum(['udp', 'tcp', 'auto']).optional(),
    }),
  );
  const { host, port, projectId, protocol } = body;
  try {
    const result = await b.connect(host, port || 3671, projectId, protocol);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_host',?)", [host]);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_port',?)", [
      String(port || 3671),
    ]);
    db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_protocol',?)", [
      protocol || 'auto',
    ]);
    db.scheduleSave();
    res.json({ ok: true, ...result });
  } catch (e) {
    res
      .status(502)
      .json({ error: safeErrorOrConnection('bus', 'Bus connection failed', e) });
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
      .json({ error: safeErrorOrConnection('bus', 'Failed to list USB devices', e) });
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
      .json({ error: safeErrorOrConnection('bus', 'Failed to list HID devices', e) });
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
      .json({ error: safeErrorOrConnection('bus', 'USB connection failed', e) });
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
    res.status(502).json({ error: safeErrorOrConnection('bus', 'Bus write failed', e) });
  }
});

router.post('/bus/read', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(req, z.object({ ga: z.string().min(1) }));
  try {
    res.json(await b.read(body.ga));
  } catch (e) {
    res.status(502).json({ error: safeErrorOrConnection('bus', 'Bus read failed', e) });
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
      .json({ error: safeErrorOrConnection('bus', 'Ping failed', e) });
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
      .json({ error: safeErrorOrConnection('bus', 'Identify failed', e) });
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
  try {
    const info = await b.readDeviceInfo(deviceAddress);
    res.json(info);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 500)
      .json({ error: safeErrorOrConnection('bus', 'Failed to read device info', e) });
  }
});

// Read raw device memory over the bus (non-destructive; read-first validation).
router.post('/bus/read-memory', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z
      .object({
        deviceAddress: z.string().min(1),
        // Up to 24-bit: readMemory()/readRegionInSession() already picks
        // A_Memory_Read vs A_MemoryExtended_Read per chunk based on the
        // address (see the 16-bit truncation fix) - this route's own cap
        // just needs to stop rejecting addresses the underlying read path
        // already handles correctly.
        address: z.number().int().min(0).max(0xffffff),
        length: z.number().int().min(1).max(4096),
        // Debug-only knob, added 2026-08-30 to bisect the real max safe
        // MemoryExtended_Read chunk size on real hardware directly (a
        // guessed value of 228, by analogy to the confirmed-safe write
        // chunk size, was rejected by a real device with rc=252 - see
        // readMemory()'s own comment in knx-connection.ts) - not exposed
        // in the normal read path (readMemory()'s own default, 12,
        // covers that).
        chunkSize: z.number().int().min(1).max(255).optional(),
      })
      // Reads must not run past the top of the 24-bit extended address
      // space, or `address + off` would wrap.
      .refine((v) => v.address + v.length <= 0x1000000, {
        message: 'address + length exceeds the 24-bit memory space (0x1000000)',
        path: ['length'],
      }),
  );
  const { deviceAddress, address, length, chunkSize } = body;
  try {
    const data = await b.readMemory(deviceAddress, address, length, chunkSize);
    res.json({
      deviceAddress,
      address,
      length: data.length,
      hex: data.toString('hex'),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Memory read failed', e) });
  }
});

// Write an exact byte sequence to an absolute memory address. Debug-only
// helper (unlike everything else in this file, this ONE writes to real
// hardware) - built to manually pin down a write-path question without
// going through buildDeviceProgramming()'s full computed image, e.g. when
// that image itself is suspected of being wrong for unrelated bits packed
// into the same byte as the parameter under test. Reuses the real
// downloadDevice()/WriteRelMem code path (same address-selection logic as
// program-device, including the 16-bit truncation fix) - not a separate
// write implementation - by passing `address` as objIdx 0's own
// "resolved base" with offset 0, so addr = base + offset = address exactly.
//
// Optional `relSegment` opts into the real Unload/StartLoading/LoadData/
// LoadCompleted sequence (see docs/follow-ups/2026-08-28-write-path-
// missing-load-sequence.md and the fix in downloadDevice()) around this
// write, declaring the REAL full segment size/fill (matching what ETS
// itself declares for this object - not the size of `hex`, which can be a
// small, fast, targeted slice) so the device accepts the write exactly
// like a real ETS load, without needing to blind-write the entire segment.
router.post('/bus/write-memory', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      address: z.number().int().min(0).max(0xffffff),
      hex: z
        .string()
        .regex(/^[0-9a-fA-F]+$/)
        .refine((h) => h.length % 2 === 0, 'hex must have an even length'),
      relSegment: z
        .object({
          objIdx: z.number().int().min(0).max(255),
          size: z.number().int().min(1),
          fill: z.number().int().min(0).max(255).default(0),
          combined: z.boolean().default(false),
        })
        .optional(),
    }),
  );
  const { deviceAddress, address, hex, relSegment } = body;
  const data = Buffer.from(hex, 'hex');
  const objIdx = relSegment?.objIdx ?? 0;
  const steps = relSegment
    ? [
        {
          type: 'RelSegment' as const,
          objIdx,
          propId: 0,
          lsmIdx: objIdx,
          size: relSegment.size,
          fill: relSegment.fill,
          mode: relSegment.combined ? 'full,par' : 'full',
        },
        ...(relSegment.combined
          ? [
              {
                type: 'RelSegment' as const,
                objIdx,
                propId: 0,
                lsmIdx: objIdx,
                size: relSegment.size,
                fill: relSegment.fill,
                mode: 'par',
              },
            ]
          : []),
        { type: 'WriteRelMem', objIdx, propId: 0, size: data.length, offset: 0 },
      ]
    : [{ type: 'WriteRelMem', objIdx, propId: 0, size: data.length, offset: 0 }];
  try {
    const result = await b.downloadDevice(deviceAddress, steps, null, null, data, undefined, {
      resolvedBases: { [objIdx]: address },
    });
    res.json({
      deviceAddress,
      address,
      hex,
      byteCount: data.length,
      loadSequence: !!relSegment,
      unconfirmedWrites: result.unconfirmedWrites,
      unconfirmedDetails: result.unconfirmedDetails,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Memory write failed', e) });
  }
});

// Replay a literal sequence of raw CEMI frames, verbatim - no APDU
// reconstruction, no automatic Connect/Disconnect. Debug-only, writes to
// real hardware - built to test whether a real captured ETS session's exact
// bytes actually persist a write, bypassing koolenex's own step/APDU
// reconstruction entirely (see docs/follow-ups/2026-08-28-write-path-
// missing-load-sequence.md). Caller supplies the real captured frames
// (including any Connect/Disconnect control frames) as an ordered array of
// hex strings, extracted straight from a real capture.
router.post('/bus/replay-frames', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      frames: z.array(z.string().regex(/^[0-9a-fA-F]+$/)).min(1).max(500),
      delayMs: z.number().int().min(0).max(5000).default(30),
    }),
  );
  const { deviceAddress, frames, delayMs } = body;
  try {
    const buffers = frames.map((h) => Buffer.from(h, 'hex'));
    await b.replayFrames(deviceAddress, buffers, delayMs);
    res.json({ deviceAddress, frameCount: buffers.length });
  } catch (e) {
    res.status(502).json({ error: safeErrorOrConnection('bus', 'Frame replay failed', e) });
  }
});

// Read an arbitrary interface-object property. Read-only debug helper - built
// to check whether other interface objects (e.g. the Address/Association
// tables, objIdx 1/2) resolve their own PID 7 (PID_TABLE_REFERENCE) base to a
// specific address, the same way resolveRelmemBases() does for WriteRelMem's
// own objIdx. Not used by the download/verify pipeline itself.
router.post('/bus/read-property', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      objIdx: z.number().int().min(0).max(255),
      propId: z.number().int().min(0).max(255),
    }),
  );
  const { deviceAddress, objIdx, propId } = body;
  try {
    const [data] = await b.readPropertyMany(deviceAddress, [
      { objIdx, propId },
    ]);
    res.json({
      deviceAddress,
      objIdx,
      propId,
      hex: (data ?? Buffer.alloc(0)).toString('hex'),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Property read failed', e) });
  }
});

// ── KNX Programming ───────────────────────────────────────────────────────────

// Write individual address (device must be in programming mode)
router.post('/bus/program-ia', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(req, z.object({ newAddr: z.string().min(1) }));
  const { newAddr } = body;
  try {
    const result = await b.programIA(newAddr);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Program IA failed', e) });
  }
});

// Direct A_Restart trigger against an already-addressed device - no
// address write involved. Added 2026-08-31 as a real diagnostic tool
// (docs/knx-device-write-protocol.md §9.5): lets Restart be tested in
// isolation from the write path, to check whether a given device visibly
// reboots on A_Restart at all, independent of anything else in flight.
router.post('/bus/restart-device', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      settleMs: z.number().int().min(0).max(10000).optional(),
      postRestartDelayMs: z.number().int().min(0).max(10000).optional(),
    }),
  );
  try {
    await b.restartDevice(body.deviceAddress, body.settleMs, body.postRestartDelayMs);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Restart device failed', e) });
  }
});

// Detect a device currently in physical programming mode (button held
// down) - broadcasts A_IndividualAddress_Read and reports whether/what
// answered. Read-side counterpart to /bus/program-ia above; independent of
// (not the same mechanism as) /bus/assign-address-by-serial below.
router.post(
  '/bus/check-programming-mode',
  async (req: Request, res: Response) => {
    const b = requireBus(res);
    if (!b) return;
    const body = validateBody(
      req,
      z.object({ timeoutMs: z.number().int().min(100).max(30000).optional() }),
    );
    try {
      const result = await b.checkProgrammingMode(body.timeoutMs);
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(msg.includes('Not connected') ? 409 : 502)
        .json({ error: safeErrorOrConnection('bus', 'Check programming mode failed', e) });
    }
  },
);

// Real KNX network-management procedure NM_Read_SerialNumber_By_
// ProgrammingMode: query the serial number of whichever device(s) are
// currently in physical programming mode - no prior knowledge of the
// device needed. Unlike /bus/check-programming-mode above, collects every
// reply within the timeout window rather than stopping at the first -
// real-hardware confirmed (2026-08-30) that multiple devices reply cleanly
// with no collision, which matters specifically for genuinely blank
// devices, whose *addresses* would be indistinguishable (same factory
// default) but whose serials are always unique.
router.post(
  '/bus/read-serials-in-programming-mode',
  async (req: Request, res: Response) => {
    const b = requireBus(res);
    if (!b) return;
    const body = validateBody(
      req,
      z.object({ timeoutMs: z.number().int().min(100).max(30000).optional() }),
    );
    try {
      const devices = await b.readSerialNumbersInProgrammingMode(body.timeoutMs);
      res.json({ devices });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(msg.includes('Not connected') ? 409 : 502)
        .json({
          error: safeErrorOrConnection('bus', 'Read serials in programming mode failed', e),
        });
    }
  },
);

// Assign an individual address via the device's own serial number
// (A_IndividualAddressSerialNumber_Write/_Read, spec 3/5/2 §2.5/§2.4) -
// unlike /bus/program-ia above, this needs no physical programming-button
// press and no programming-mode precondition. Real-hardware confirmed
// (a device moved from its factory-default address to a real target
// address) - see docs/knx-device-write-protocol.md §9.2.
router.post(
  '/bus/assign-address-by-serial',
  async (req: Request, res: Response) => {
    const b = requireBus(res);
    if (!b) return;
    const body = validateBody(
      req,
      z.object({
        serial: z
          .string()
          .regex(/^[0-9a-fA-F]{12}$/, 'serial must be 12 hex chars (6 bytes)'),
        newAddress: z.string().min(1),
      }),
    );
    const { serial, newAddress } = body;
    try {
      const result = await b.assignIndividualAddressBySerial(
        Buffer.from(serial, 'hex'),
        newAddress,
      );
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(msg.includes('Not connected') ? 409 : 502)
        .json({ error: safeErrorOrConnection('bus', 'Assign address by serial failed', e) });
    }
  },
);

// Real-only-read counterpart to /bus/assign-address-by-serial above - ask
// by serial "whatever address you're at, report it", no address guess and
// no programming-mode button-press needed. Real request, 2026-08-31:
// verifying a real ETS Factory Reset actually took effect, the same
// mechanism ETS's own Factory Reset uses for its own final verify step
// (docs/knx-device-write-protocol.md §9.3).
router.post(
  '/bus/read-address-by-serial',
  async (req: Request, res: Response) => {
    const b = requireBus(res);
    if (!b) return;
    const body = validateBody(
      req,
      z.object({
        serial: z
          .string()
          .regex(/^[0-9a-fA-F]{12}$/, 'serial must be 12 hex chars (6 bytes)'),
        timeoutMs: z.number().int().min(100).max(30000).optional(),
      }),
    );
    try {
      const result = await b.readIndividualAddressBySerial(
        Buffer.from(body.serial, 'hex'),
        body.timeoutMs,
      );
      res.json(result ?? { address: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(msg.includes('Not connected') ? 409 : 502)
        .json({ error: safeErrorOrConnection('bus', 'Read address by serial failed', e) });
    }
  },
);

interface DeviceModel {
  appId?: string;
  loadProcedures?: Array<{
    type: string;
    data?: string;
    size?: number;
    offset?: number;
    [key: string]: unknown;
  }>;
  paramMemLayout?: Record<string, unknown>;
  dynTree?: unknown;
  params?: Record<string, unknown>;
  absSegData?: Record<number, { size: number; hex?: string | null }>;
  // Object 3 (Group Object Table) real buffer size - see ets-app.ts's
  // ParamModel.groupObjectTableSize's doc comment for the formula/rationale.
  groupObjectTableSize?: number;
  // 🔴 SPECULATIVE - see ets-app.ts's ParamModel.isSecureEnabled's own doc
  // comment for the full real-hardware evidence and status before
  // trusting this for anything real.
  isSecureEnabled?: boolean;
}

type DeviceProgramming =
  | {
      ok: true;
      steps: DownloadStep[];
      gaTable: Buffer;
      assocTable: Buffer;
      groupObjectTable: Buffer | null;
      paramMem: Buffer | null;
      paramBase: number | null;
      absSegData: Record<number, { size: number; hex?: string | null }>;
      appId: string;
      paramMemLayout: Record<string, unknown>;
      params: Record<string, unknown> | null;
      isSecureEnabled?: boolean;
      // Real request, 2026-08-31: this device's own cached
      // `LastUsedAPDULength` (from `Device.apdu_length`) - see that
      // field's own doc comment (shared/types.ts) for the real evidence.
      // `null` when this device has never been downloaded to from this
      // project (no cached value parsed as a valid number yet).
      cachedMaxApduLength: number | null;
    }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Build the download artifacts (load-procedure steps, GA/association tables,
 * parameter memory image) for a device from its imported app model + current
 * parameter values. Shared by program-device (writes them) and verify-device
 * (reads the device back and diffs against them).
 */
function buildDeviceProgramming(dev: Device): DeviceProgramming {
  if (!dev.app_ref)
    return {
      ok: false,
      status: 400,
      body: {
        error: 'no_app',
        message:
          'Device has no application program reference. Re-import the project.',
      },
    };
  const safe = dev.app_ref.replace(/[^a-zA-Z0-9_-]/g, '_');
  const modelPath = path.join(APPS_DIR, safe + '.json');
  if (!fs.existsSync(modelPath))
    return {
      ok: false,
      status: 400,
      body: {
        error: 'no_model',
        message: 'App model not found. Re-import the project.',
      },
    };

  let model: DeviceModel;
  try {
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as DeviceModel;
  } catch {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to read app model' },
    };
  }
  if (!model.loadProcedures?.length)
    return {
      ok: false,
      status: 400,
      body: {
        error: 'no_ldctrl',
        message: 'No load procedures found. Re-import the project.',
      },
    };

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

  // Object 3 (Group Object Table) - added 2026-08-29. `size` comes from the
  // app model, not from coRows (see ParamModel.groupObjectTableSize's doc
  // comment: it's the app's total static declaration range, not this
  // device's linked/active subset - real ETS pre-allocates space for every
  // com object the app could ever expose). null (not an empty Buffer) when
  // the app model has no groupObjectTableSize at all (e.g. a prop-only or
  // AbsSegment-family app never captured one) - downloadDevice() already
  // treats a falsy/empty groupObjectTable as "nothing to write" the same
  // way it does for gaTable/assocTable being empty.
  // 🟡 Not yet independently proven against real hardware for Object 3
  // itself (see docs/knx-device-write-protocol.md Part 12) - the
  // computation itself is golden-image tested (tests/group-object-table.
  // test.ts), but no real device has been written to via this exact path.
  let groupObjectTable: Buffer | null = null;
  if (model.groupObjectTableSize && model.groupObjectTableSize > 0) {
    const groupObjects: GroupObjectFlags[] = coRows.map((co) => ({
      object_number: co.object_number,
      // Real bug, fixed 2026-08-29: this used to read `co.flags.includes('U')`
      // on the reasoning that Update was always safely recoverable from the
      // composite `flags` string (its only lossy case, the ALL-false
      // fallback 'CW', never contains 'U'). That reasoning was correct
      // GIVEN an accurate `flags` string - but `flags` itself was built from
      // a value that was wrong at the source: ets-parser.ts read Update
      // directly off the ComObjectRef's own UpdateFlag attribute with no
      // fallback to the base ComObject's declared value (unlike every other
      // flag, which already went through the proper base+override merge) -
      // confirmed live on 1.1.10, where every project-side Update flag was
      // wrongly off. Now uses the same dedicated raw column (`upd`) the
      // other four flags already have.
      update: !!co.upd,
      transmit: !!co.tx,
      readOnInit: !!co.read_on_init,
      write: !!co.write,
      read: !!co.read,
      communication: !!co.comm,
      linked: (co.ga_address || '').trim().length > 0,
      priority: (['low', 'alarm', 'high', 'system'].includes(co.priority)
        ? co.priority
        : 'low') as GroupObjectFlags['priority'],
      // Companion size-code byte - see groupObjectSizeCode()'s doc comment
      // (knx-tables.ts) for the real-hardware confirmation (2026-08-29).
      objectSize: co.object_size,
    }));
    groupObjectTable = buildGroupObjectTable(
      model.groupObjectTableSize,
      groupObjects,
    );
  }

  // Parameter memory: build from param layout + current values
  const { paramSize, paramFill, relSegHex, paramBase } = resolveParamSegment(
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

  return {
    ok: true,
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    paramMem,
    paramBase,
    absSegData: model.absSegData ?? {},
    appId: model.appId ?? dev.app_ref,
    paramMemLayout: model.paramMemLayout ?? {},
    params: model.params ?? null,
    isSecureEnabled: model.isSecureEnabled,
    // Real request, 2026-08-31: parses `dev.apdu_length` (the project's
    // own cached `LastUsedAPDULength`, see shared/types.ts's own doc
    // comment) - empty string / non-numeric / non-positive all correctly
    // fall through to `null` (never downloaded from this project yet, or
    // a genuinely malformed cached value - either way, the real fallback
    // is the live property-56 read, not a guessed number here).
    cachedMaxApduLength:
      dev.apdu_length && /^\d+$/.test(dev.apdu_length)
        ? parseInt(dev.apdu_length, 10) || null
        : null,
  };
}

// Test-only export alias (matches the existing convention elsewhere in this
// project, e.g. knx-cemi.ts's `_apduPropertyValueWrite`) - lets a script
// compute a device's real download artifacts (including Object 3) directly
// against a real imported project, without needing a live bus connection or
// going through the write-triggering /bus/program-device route at all.
export const _buildDeviceProgramming = buildDeviceProgramming;

// Resolves a device's device_pending_changes rows (routes/shared.ts) into
// the byte ranges DownloadExtra.pendingWriteRanges expects (see that
// field's own doc comment in knx-connection.ts for the full redesign this
// is part of, 2026-09-01). Deliberately does NOT read the device or diff
// anything - each key is mapped to an offset using the SAME layout logic
// that already builds the target image, from data koolenex already has.
//
// - 'param_value': resolved via paramMemLayout, the same map buildParamMem()
//   itself uses. A key absent from the map, or with `offset: null` (a real,
//   separate, already-tracked gap - see koolenex_checkbox_param_no_memory_offset
//   memory), simply contributes nothing here - there's no byte to write for
//   it, same as buildParamMem() itself would produce.
// - 'ga_link': GA/Association table (objIdx 1/2) entry positions can shift
//   entirely when one link changes (not a fixed per-key offset the way the
//   other two kinds are) - marks both tables' FULL length dirty rather than
//   guessing a sub-range. A comm object's Object 3 byte (bit 2: Communication
//   AND has-a-GA-link) can also change alongside a link edit, so this ALSO
//   marks that object's own 2-byte entry dirty, same as 'group_object_flag'.
// - 'group_object_flag': resolved via the same `object_number * 2` formula
//   computeGroupObjectByte()/buildGroupObjectTable() already use.
//
// Real ETS behavior, confirmed via a byte-for-byte capture of a real
// Partial Download that changed one parameter value: ETS wrote two bytes,
// not one - the edited byte itself, and a second, unconditional write to
// the parameter object's own final byte (offset paramSize-1), regardless
// of what was actually edited. See docs/knx-device-write-protocol.md §6.1
// for the full evidence. `paramSize` is optional so a caller/test that
// doesn't have it (or doesn't touch objIdx 4 at all) sees no behavior
// change - the trailer byte is only added when objIdx 4 already has at
// least one real write pending, matching ETS's own "alongside whatever
// else it writes" behavior, not a write on its own.
function resolvePendingWriteRanges(
  deviceId: number,
  paramMemLayout: Record<string, unknown>,
  paramSize?: number,
): Record<number, Array<{ offset: number; length: number }>> {
  const pending = getPendingChanges(deviceId);
  const ranges: Record<number, Array<{ offset: number; length: number }>> = {};
  const add = (objIdx: number, offset: number, length: number): void => {
    (ranges[objIdx] ??= []).push({ offset, length });
  };
  let touchedGaOrAssoc = false;
  const touchedComObjNums = new Set<number>();

  for (const row of pending) {
    if (row.kind === 'param_value') {
      const layout = (paramMemLayout as Record<string, ParamMemEntry>)[
        row.key
      ];
      if (layout && layout.offset != null) {
        const length = Math.max(
          1,
          Math.ceil((layout.bitOffset + layout.bitSize) / 8),
        );
        add(4, layout.offset, length);
      }
    } else if (row.kind === 'ga_link') {
      touchedGaOrAssoc = true;
      const n = Number(row.key);
      if (Number.isFinite(n)) touchedComObjNums.add(n);
    } else if (row.kind === 'group_object_flag') {
      const n = Number(row.key);
      if (Number.isFinite(n)) touchedComObjNums.add(n);
    }
  }

  // GA/Association tables: no stable per-key offset, so any link change
  // marks the whole table dirty. The caller fills in the real length (it
  // has gaTable/assocTable already built); a length of -1 here is a
  // sentinel the caller expands to "whole table".
  if (touchedGaOrAssoc) {
    add(1, 0, -1);
    add(2, 0, -1);
  }
  for (const n of touchedComObjNums) {
    add(3, n * 2, 2);
  }
  // See this function's own doc comment above for the real-capture evidence
  // behind this - real ETS always includes the parameter object's own
  // final byte in any partial write to that object.
  if (ranges[4] && ranges[4].length && paramSize && paramSize > 0) {
    const lastByteOffset = paramSize - 1;
    const alreadyCovered = ranges[4].some(
      (r) => lastByteOffset >= r.offset && lastByteOffset < r.offset + r.length,
    );
    if (!alreadyCovered) add(4, lastByteOffset, 1);
  }
  return ranges;
}

// Test-only export alias (same convention as _buildDeviceProgramming above).
export const _resolvePendingWriteRanges = resolvePendingWriteRanges;

// Full (or, since 2026-08-29, partial) application download for a device.
// mode defaults to 'full' - the original, only-ever-tested behavior, kept
// as the default so existing callers/tests see zero change. mode='partial'
// is a new, best-effort code path (see DownloadExtra.mode's doc comment in
// knx-connection.ts) - only exercised so far against 1.1.9's RelSegment-
// style app (mask 07B0).
router.post('/bus/program-device', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  // Real request, 2026-08-31: a modal "press the button" prompt (client-
  // side) needs a real Cancel action, and this route's own pre-flight can
  // now genuinely wait up to 30s for a physical button press - checked at
  // each polling round below rather than only at the very start, so
  // cancelling actually stops the wait promptly instead of only being
  // honored before the first round begins.
  //
  // Real bug, caught before ever reaching real hardware: req.on('close')
  // is NOT a reliable "the client disconnected" signal in Express - it
  // can fire once the REQUEST body has been fully read, which can happen
  // well before a response is sent, even while the client is still very
  // much there waiting. Using it made every test suddenly think it had
  // been cancelled instantly, hitting the new `if (aborted) return;`
  // guards with no response ever sent - hanging every test client
  // indefinitely (confirmed live: the whole test file, previously a ~3.4s
  // run, exceeded a 45s timeout with zero output). res.on('close'),
  // gated on res.writableEnded, is the standard, correct pattern - it
  // fires when the underlying connection actually closes, and
  // writableEnded distinguishes "closed because we already finished
  // responding normally" from a genuine client-side disconnect.
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });
  const body = validateBody(
    req,
    z.object({
      deviceAddress: z.string().min(1),
      projectId: z.number().int().optional(),
      deviceId: z.number().int().optional(),
      mode: z.enum(['full', 'partial']).optional().default('full'),
      // How to locate/(re)address the device when it doesn't currently
      // answer at `deviceAddress` and a serial is on record - see the
      // 'address_needs_confirmation' response below. Omitted on a fresh
      // request (the client hasn't chosen yet); set on the client's
      // follow-up call once the user (or the 'auto_address_by_serial'
      // setting) has decided.
      addressMethod: z.enum(['button', 'serial']).optional(),
    }),
  );
  const { deviceAddress, projectId, deviceId, mode, addressMethod } = body;

  // Load device data
  const dev = deviceId
    ? db.get<Device>('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get<Device>(
        'SELECT * FROM devices WHERE individual_address=? AND project_id=?',
        [deviceAddress, +(projectId ?? 0)],
      );
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  // A device imported with no real address (see ets-parser.ts) carries a
  // synthetic individual_address (device number >= 256) purely to have a
  // stable DB key - never a real, writable KNX address. Refuse to program
  // it rather than encoding an out-of-range device number onto the wire,
  // where it could silently wrap into a real device's actual address.
  if (!dev.has_address) {
    return res.status(409).json({
      error: 'device_unaddressed',
      message:
        'This device has no individual address assigned yet - use "Address New Device" to give it a real one first.',
    });
  }

  const built = buildDeviceProgramming(dev);
  if (!built.ok) return res.status(built.status).json(built.body);
  const {
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    paramMem,
    paramBase,
    absSegData,
    appId,
    isSecureEnabled,
    cachedMaxApduLength,
  } = built;

  // Real edit log -> write ranges, 2026-09-01 - only meaningful in
  // 'partial' mode (full mode always writes everything regardless of what
  // changed). The `-1` sentinel length from resolvePendingWriteRanges()
  // (GA/Association tables have no stable per-key offset) gets expanded
  // here to each table's real, already-built length.
  let pendingWriteRanges:
    | Record<number, Array<{ offset: number; length: number }>>
    | undefined;
  if (mode === 'partial') {
    const resolved = resolvePendingWriteRanges(
      dev.id,
      built.paramMemLayout,
      paramMem?.length,
    );
    for (const [objIdxStr, ranges] of Object.entries(resolved)) {
      for (const r of ranges) {
        if (r.length === -1) {
          const objIdx = Number(objIdxStr);
          r.length =
            objIdx === 1
              ? (gaTable?.length ?? 0)
              : objIdx === 2
                ? (assocTable?.length ?? 0)
                : 0;
        }
      }
    }
    pendingWriteRanges = resolved;
  }

  // Real device-resident relmem bases (PID 7) are no longer pre-resolved
  // (and no longer gate the download with a 409) here - downloadDevice()
  // itself now resolves each relevant interface object's base AFTER that
  // object's own Unload/StartLoading/LoadData cycle, matching real ETS's
  // actual behavior. Real bug, found live 2026-08-30: this upfront check
  // used to reject the whole request outright ("segment_unallocated")
  // whenever the parameter object's PID 7 hadn't been allocated yet -
  // correct for re-programming an already-provisioned device (its base
  // genuinely doesn't change across a reload), but wrong for a device's
  // very first-ever download, where PID 7 legitimately starts at 0 and
  // only becomes valid once Unload/StartLoading/LoadData actually runs -
  // exactly the scenario a genuinely blank/factory-reset device is in.
  // Confirmed against a real ETS Full Download capture (2026-08-30): ETS
  // never pre-checks PID 7 before attempting a device's first load either.

  // Stream progress via WebSocket
  const onProgress = (p: DownloadProgress): void =>
    b.broadcast('program:progress', { deviceAddress, ...p });
  onProgress({ msg: `Starting download to ${deviceAddress}`, pct: 0 });

  // Real request 2026-08-31, after a real live failure: forces a fresh
  // connection before starting rather than reusing whatever's left of the
  // current one, so a download always gets the full gateway idle-timeout
  // budget from a clean baseline - see KnxBusManager.forceReconnect()'s
  // own doc comment for the live failure that prompted this. Explicitly
  // try/caught here (not left to throw into the handler) - this route has
  // no surrounding try/catch until the keep-alive ref below, and Express
  // does not catch an async handler's rejection on its own; an uncaught
  // one here would hang the response instead of returning a real error.
  try {
    await b.forceReconnect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Failed to reconnect before programming', e) });
  }

  // A download can run long enough for the gateway's own idle timeout to
  // never actually apply mid-write (real traffic is flowing throughout),
  // but hold a keep-alive ref regardless for the duration - protects any
  // real pause between steps against an unexpected drop interrupting the
  // download partway through. See KnxBusManager.addKeepAliveRef(). Now
  // also covers the address pre-flight below (moved up here from just
  // before downloadDevice()) - that phase can itself run for up to 30s
  // waiting on a real programming-button press, and deserves the same
  // protection.
  const releaseKeepAlive = b.addKeepAliveRef();
  try {
    // Real root-cause fix, 2026-08-31 - the user's own exact diagnosis,
    // verbatim: "Our Write is assuming that the device [...] already has
    // an address - it does not. That address is only in our DB... ETS
    // when it does a full download ALWAYS writes the address first,
    // reboots and then the params etc. We just go straight into the
    // params, without bothering to verify whether the address exists or
    // not." Confirmed the hard way: a genuinely factory-
    // reset device (independently verified via a real bus query to be at
    // 15.15.255) was given a project address purely as a DB record, with
    // no write ever sent to the physical device - the subsequent Full
    // Download still reported "successful", because the per-chunk
    // WriteRelMem loop is deliberately fault-tolerant (a missing response
    // is logged and continued, not a hard failure - see that loop's own
    // comment) - it had been writing into the void the whole time, and
    // koolenex's own "successful" claim was never independently confirmed
    // by anything the device itself said.
    //
    // Mirrors real ETS's own Full Download procedure exactly: if a serial
    // is on record, confirm a REAL device
    // answering at deviceAddress actually carries that same serial before
    // touching anything else. If it doesn't (no answer, a different
    // serial, or no serial on record at all), there is no way around a
    // real physical programming-button press to identify and (re)address
    // the device first - exactly what ETS itself requires, and exactly
    // the same detect-before-write safety gate already proven in the
    // client's own addressing flow (AddressDeviceModal.tsx), reused here
    // server-side: both broadcast mechanisms (serial scan +
    // legacy address broadcast - a non-Albrecht-Jung device may only
    // answer one of the two, see docs/knx-device-write-protocol.md §9.5),
    // and a hard refusal if zero or more than one device answers - this
    // is a real write, the same ambiguity hazard applies here as there.
    let addressConfirmed = false;
    if (dev.serial_number) {
      try {
        const info = await b.readDeviceInfo(deviceAddress);
        if (
          info.serialNumber &&
          info.serialNumber.toLowerCase() === dev.serial_number.toLowerCase()
        ) {
          addressConfirmed = true;
          onProgress({
            msg: `Confirmed device at ${deviceAddress} (serial ${info.serialNumber})`,
          });
        } else {
          onProgress({
            msg: info.serialNumber
              ? `Device at ${deviceAddress} reports a different serial (${info.serialNumber}) - re-addressing required`
              : `Device at ${deviceAddress} answered but reported no serial - re-addressing required`,
          });
        }
      } catch {
        onProgress({
          msg: `No device answered at ${deviceAddress} - re-addressing required`,
        });
      }
    } else {
      onProgress({
        msg: 'No serial on record for this device - re-addressing required',
      });
    }

    // Shared by both re-addressing paths below (button-press and serial) -
    // real request, 2026-08-31: "I have seen ETS wait between 9 seconds
    // and 19 seconds at times" for a device to come back up and answer
    // again after an address write. programIA()/assignIndividualAddress
    // BySerial() each already restart the device internally (KnxConnection
    // .restartDevice(), including its own real-capture-confirmed ~3s
    // post-Restart settle wait) - this retry is on TOP of that built-in
    // wait, not instead of it: even after a full settle wait, a first
    // confirmation attempt can still genuinely fail ("did not respond"),
    // so this doesn't rely on a single attempt succeeding. Deadline-based
    // (not a fixed attempt count) so the spacing stays 2s regardless of
    // how long the budget ends up needing to be - same pattern as the
    // programming-mode detection loop below.
    //
    // Real bug, found live 2026-09-01: the serial-based branch below
    // originally set addressConfirmed=true immediately after a verified
    // write, with no equivalent wait at all - assignIndividualAddress
    // BySerial()'s own ~3.3s internal settle wait alone wasn't always
    // enough, and downloadDevice() connecting immediately afterward
    // genuinely failed on a real device that hadn't finished rebooting
    // yet (confirmed live: the first Program attempt failed right after
    // the address update/reboot, the second succeeded once the device had
    // had more wall-clock time to come back up on its own). This helper -
    // previously inline, button-press-only - is now shared by both paths.
    const waitForDeviceBackUp = async (): Promise<{
      serialNumber?: string;
    } | null> => {
      onProgress({ msg: `Confirming device at ${deviceAddress}…` });
      const confirmStart = Date.now();
      const confirmDeadlineMs = 35000;
      let confirmedInfo: { serialNumber?: string } | null = null;
      let attempt = 0;
      let lastHeartbeatMs = 0;
      while (
        !confirmedInfo &&
        Date.now() - confirmStart < confirmDeadlineMs &&
        !aborted
      ) {
        attempt++;
        if (attempt > 1) await delay(2000);
        const elapsedMs = Date.now() - confirmStart;
        // Heartbeat every ~5s so a long real wait doesn't read as "stuck"
        // in the log panel - a genuinely-still-working wait with no
        // visible sign of life looks indistinguishable from a hang.
        if (elapsedMs - lastHeartbeatMs >= 5000) {
          lastHeartbeatMs = elapsedMs;
          onProgress({
            msg: `Still waiting for ${deviceAddress} to come back up after restart… (${Math.round(elapsedMs / 1000)}s)`,
          });
        }
        try {
          confirmedInfo = await b.readDeviceInfo(deviceAddress);
        } catch (e) {
          logger.warn('knx', 'Post-address-write confirmation read failed', {
            deviceAddress,
            attempt,
            elapsedMs,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return confirmedInfo;
    };

    if (!addressConfirmed) {
      // Real gap, found live 2026-09-01: a serial on record was only ever
      // used for the fast-path check above - if that failed (e.g. a
      // factory-reset device, no longer sitting at deviceAddress), this
      // route went straight into the button-press flow below with no
      // alternative offered, even though the same serial can locate and
      // readdress the device directly - A_IndividualAddressSerialNumber_
      // Write/_Read, no button press needed, real-hardware confirmed (see
      // docs/knx-device-write-protocol.md §9.2). Real ETS offers this as
      // an operator choice; so does this route now, unless
      // 'auto_address_by_serial' (server/routes/settings.ts) says to just
      // do it automatically. `addressMethod` carries the choice once
      // made (the client's follow-up request after the prompt below).
      const canUseSerial = !!dev.serial_number;
      // Guards a client sending addressMethod:'serial' for a device with
      // no serial on record (shouldn't happen - the client only offers
      // this choice when canUseSerial is true - but falls through to the
      // button-press flow below rather than crashing on a null serial).
      let useSerial = addressMethod === 'serial' && canUseSerial;
      if (addressMethod === undefined && canUseSerial) {
        const autoSetting = db.get<{ value: string }>(
          "SELECT value FROM settings WHERE key='auto_address_by_serial'",
        );
        if (autoSetting?.value === 'true') {
          useSerial = true;
        } else {
          return res.status(409).json({
            error: 'address_needs_confirmation',
            message: `Device not found at ${deviceAddress} with a matching serial - choose how to locate/address it.`,
            canUseSerial: true,
          });
        }
      }

      if (useSerial) {
        onProgress({
          msg: `Locating device by serial ${dev.serial_number}…`,
        });
        let bySerial;
        try {
          bySerial = await b.assignIndividualAddressBySerial(
            Buffer.from(dev.serial_number!, 'hex'),
            deviceAddress,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return res
            .status(msg.includes('Not connected') ? 409 : 502)
            .json({
              error: safeErrorOrConnection('bus', 'Locate device by serial failed', e),
            });
        }
        if (!bySerial.verified) {
          return res.status(409).json({
            error: 'serial_address_failed',
            message: `No device with serial ${dev.serial_number} answered, or the address write to ${deviceAddress} could not be verified. Try Press Programming Button instead.`,
          });
        }
        // The write itself is verified (assignIndividualAddressBySerial's
        // own read-back), but the device still restarts after this -
        // same "wait for it to actually come back up" step the button-
        // press path already has, see waitForDeviceBackUp's own doc
        // comment for the real live failure this fixes.
        const confirmedInfo = await waitForDeviceBackUp();
        if (aborted) return;
        if (!confirmedInfo) {
          return res.status(502).json({
            error: 'address_write_unconfirmed',
            message: `Address ${deviceAddress} was written by serial, but the device did not answer afterward - the write could not be confirmed, so the rest of the download was not attempted.`,
          });
        }
        onProgress({
          msg: `Confirmed device at ${deviceAddress} via serial - continuing with the rest of the download`,
        });
        addressConfirmed = true;
      }
    }
    if (!addressConfirmed) {
      // `awaitingButton: true` is the client's cue to show a dedicated
      // modal (Cancel-only, auto-dismisses once the wait resolves either
      // way) rather than just updating the button's own inline text -
      // real request, 2026-08-31: "somewhere to display the press prog
      // button. Maybe a modal pop-up with just a cancel button, which
      // automatically disappears once the device is found."
      onProgress({
        msg: 'Press the programming button on the device now…',
        awaitingButton: true,
      });
      const roundMs = 3000;
      const deadline = Date.now() + 30000;
      const bySrc = new Map<string, string>(); // src -> serial ('' if unknown)
      while (bySrc.size === 0 && Date.now() < deadline && !aborted) {
        const thisRound = Math.min(
          roundMs,
          Math.max(deadline - Date.now(), 100),
        );
        const [serialScan, addrCheck] = await Promise.all([
          b.readSerialNumbersInProgrammingMode(thisRound),
          b.checkProgrammingMode(thisRound),
        ]);
        for (const d of serialScan) bySrc.set(d.src, d.serial);
        if (addrCheck.address && !bySrc.has(addrCheck.address)) {
          bySrc.set(addrCheck.address, '');
        }
      }
      // The client already disconnected (Cancel) - res.json() below would
      // throw on a destroyed socket; nothing left to do or respond to.
      if (aborted) return;
      if (bySrc.size === 0) {
        return res.status(409).json({
          error: 'no_device_in_programming_mode',
          message:
            'No device answered the programming-mode scan - press and release the programming button on the target device, then try again.',
        });
      }
      if (bySrc.size > 1) {
        const ids = [...bySrc.entries()]
          .map(([addr, serial]) => (serial ? `${serial} @ ${addr}` : addr))
          .join(', ');
        return res.status(409).json({
          error: 'ambiguous_programming_mode',
          message: `${bySrc.size} devices are in programming mode at once (${ids}) - this write would be ambiguous. Press the button on only the one device you mean to program, then try again.`,
        });
      }
      // This message (no awaitingButton flag) is the client's cue to
      // dismiss the modal - a real device was found, the wait is over.
      const [foundAddr, foundSerial] = [...bySrc.entries()][0]!;
      onProgress({
        msg: `Identified device ${foundSerial || foundAddr} in programming mode - writing address ${deviceAddress}…`,
      });
      // programIA() already restarts the device internally
      // (KnxConnection.restartDevice(), including its own real-capture-
      // confirmed ~3s post-Restart settle wait) - real request, 2026-08-31:
      // "Don't forget the device reboot that ETS does once address is
      // written, waiting till the device is back up". waitForDeviceBackUp()
      // (above) is on TOP of that built-in wait, not instead of it.
      await b.programIA(deviceAddress);
      const confirmedInfo = await waitForDeviceBackUp();
      if (aborted) return;
      if (!confirmedInfo) {
        return res.status(502).json({
          error: 'address_write_unconfirmed',
          message: `Address ${deviceAddress} was written, but the device did not answer afterward - the write could not be confirmed, so the rest of the download was not attempted.`,
        });
      }
      if (confirmedInfo.serialNumber) {
        db.run(
          'UPDATE devices SET serial_number=?, has_address=1 WHERE id=?',
          [confirmedInfo.serialNumber, dev.id],
        );
        onProgress({
          msg: `Confirmed device at ${deviceAddress}, serial ${confirmedInfo.serialNumber} - rebooted, continuing with the rest of the download`,
        });
      } else {
        onProgress({
          msg: `Device answered at ${deviceAddress} but reported no serial - continuing anyway`,
        });
      }
    }
    if (aborted) return;

    const downloadResult = await b.downloadDevice(
      deviceAddress,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
      {
        paramBase,
        absSegData,
        appId,
        mode,
        groupObjectTable,
        isSecureEnabled,
        cachedMaxApduLength,
        pendingWriteRanges,
      },
    );
    // Real bug, found live 2026-08-31: this only ever updated `status` -
    // `last_download` was never touched by a live koolenex download at
    // all, so it silently kept whatever value the device last had from
    // its original .knxproj import (a real ETS-reported download
    // timestamp), even after a genuine, confirmed-on-hardware koolenex
    // write. Set it here too, to the moment this write actually completed.
    //
    // Real gap, found live 2026-08-31: a plain Program/Full-Download never
    // captured the device's serial at all (only the addressing flow's own
    // read-back did - AddressDeviceModal), so the Verify button's real,
    // deliberate gate on serial_number (a physically-confirmed serial is
    // the genuine "this exact unit was actually commissioned" signal -
    // real user confirmation, same day: "we should have both address and
    // serial number for a device before we enable verify") stayed
    // permanently unsatisfiable for a device programmed this way. Best-
    // effort read-back here, same mechanism/spirit as the addressing
    // flow's own busDeviceInfo() call - failure is logged but does not
    // fail the overall (already-succeeded) download.
    // Real live-test finding, 2026-08-31: a first attempt right after a
    // real Full Download (much more content to process than a plain
    // address write) genuinely failed - "Device 1.1.20 did not respond" -
    // the device plausibly not yet ready to accept a fresh point-to-point
    // connection the instant its own download session closes. Same
    // pattern already established elsewhere (restartDevice()'s own
    // settleMs) - a brief settle delay plus one retry, rather than giving
    // up on a single fleeting failure right when this data is most wanted.
    let serialNumber: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await delay(attempt === 1 ? 500 : 1500);
      try {
        const info = await b.readDeviceInfo(deviceAddress);
        serialNumber = info.serialNumber;
        break;
      } catch (e) {
        logger.warn('knx', 'Post-download serial read-back failed', {
          deviceAddress,
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const totalBytes =
      (gaTable?.length ?? 0) +
      (assocTable?.length ?? 0) +
      (paramMem?.length ?? 0) +
      (groupObjectTable?.length ?? 0);
    const unconfirmedWritesCount = downloadResult.unconfirmedWrites;
    const unconfirmedWritesDetail = JSON.stringify(downloadResult.unconfirmedDetails);
    // last_verify_match/last_verify_at cleared back to NULL here too -
    // real request, 2026-09-01: "clear last verify on each download" - a
    // verify result describes content that this download just replaced,
    // so it can't still be trusted regardless of whether this specific
    // download's own writes were all confirmed.
    if (serialNumber) {
      db.run(
        'UPDATE devices SET status=?, last_download=?, serial_number=?, unconfirmed_writes_count=?, unconfirmed_writes_detail=?, last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
        [
          'programmed',
          new Date().toISOString(),
          serialNumber,
          unconfirmedWritesCount,
          unconfirmedWritesDetail,
          dev.id,
        ],
      );
    } else {
      db.run(
        'UPDATE devices SET status=?, last_download=?, unconfirmed_writes_count=?, unconfirmed_writes_detail=?, last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
        [
          'programmed',
          new Date().toISOString(),
          unconfirmedWritesCount,
          unconfirmedWritesDetail,
          dev.id,
        ],
      );
    }
    // Real request, 2026-09-01: "track changes we have made, until we have
    // programmed successfully" - reaching here means downloadDevice()
    // completed without throwing, so whatever was pending (full or
    // partial) has now genuinely been written. A device now matches its
    // own DB state either way: full mode always writes everything
    // regardless of what was tracked, partial mode just wrote exactly the
    // tracked deltas - so the log is cleared unconditionally here, not
    // gated on mode.
    clearPendingChanges(dev.id);
    // Real request, 2026-08-31: "the log doesn't say that the download was
    // successful. We should show this in the logs, including serial
    // number of the device, and the number of bytes written." - the
    // client's own success log line (ProgrammingView.tsx's programDevice())
    // reads straight from this response.
    db.scheduleSave();
    // downloadDevice() completing without throwing means the protocol
    // sequence ran to completion, not that every write was confirmed - a
    // device may not answer an individual write, previously only ever
    // logged server-side with no way for the client to know. `status` is
    // still set to 'programmed' above regardless (the device did receive
    // the download attempt), but the client can use `unconfirmedWrites` to
    // show a "completed with N unconfirmed writes - verify recommended"
    // state instead of an unconditional success.
    res.json({
      ok: true,
      deviceAddress,
      mode,
      serialNumber,
      totalBytes,
      unconfirmedWrites: downloadResult.unconfirmedWrites,
      unconfirmedDetails: downloadResult.unconfirmedDetails,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    b.broadcast('program:progress', {
      deviceAddress,
      msg: `Error: ${errMsg}`,
      pct: -1,
      error: true,
    });
    res
      .status(errMsg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Device programming failed', e) });
  } finally {
    releaseKeepAlive();
  }
});

// Read-only verification: compute the parameter-memory image for a device and
// compare it against what the device actually has, reading over the bus. Writes
// nothing — safe to run against a live installation.
// A device is genuinely, transiently unresponsive for a few seconds right
// after a real hardware Restart - confirmed on real hardware (Part 18/§5,
// docs/knx-device-write-protocol.md): a Tunneling ACK timeout right after a
// Program action, followed by a clean reconnect ~10s later with no other
// intervention. Found live (2026-08-29): clicking Verify right after a
// Program finished hit exactly this window and surfaced as a raw, unhelpful
// "Tunneling ACK timeout" 500 - the route's error handling below already
// returns a clean 502 for genuine failures, but a real transient timeout
// deserves a retry, not an immediate failure. Scoped to this one, specific,
// well-evidenced error message - NOT a general "retry on any bus error"
// policy (a real ACK *error* response, e.g. `Tunneling ACK error 0x..`, is a
// genuine protocol-level negative acknowledgement, not a timeout, and isn't
// retried here).
const VERIFY_TRANSIENT_RETRY_DELAY_MS = 4000;
const VERIFY_TRANSIENT_MAX_ATTEMPTS = 3;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const isTransientBusTimeout = (e: unknown): boolean =>
  e instanceof Error && e.message === 'Tunneling ACK timeout';

router.post('/bus/verify-device', async (req: Request, res: Response) => {
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

  const dev = deviceId
    ? db.get<Device>('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get<Device>(
        'SELECT * FROM devices WHERE individual_address=? AND project_id=?',
        [deviceAddress, +(projectId ?? 0)],
      );
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  // See the matching comment/guard in /bus/program-device above.
  if (!dev.has_address) {
    return res.status(409).json({
      error: 'device_unaddressed',
      message:
        'This device has no individual address assigned yet - use "Address New Device" to give it a real one first.',
    });
  }

  // See the matching comment in /bus/program-device above - forces a
  // fresh connection before starting rather than reusing whatever's left
  // of the current one. Also explicitly try/caught for the same reason
  // (no surrounding try/catch this early in the handler).
  try {
    await b.forceReconnect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res
      .status(msg.includes('Not connected') ? 409 : 502)
      .json({ error: safeErrorOrConnection('bus', 'Failed to reconnect before verifying', e) });
  }

  // See the matching comment in /bus/program-device above -
  // KnxBusManager.addKeepAliveRef() protects the whole retry loop
  // (including the real multi-second waits between transient-timeout
  // retries) against an idle-timeout drop interrupting verification.
  const releaseKeepAlive = b.addKeepAliveRef();
  try {
    for (
      let attempt = 1;
      attempt <= VERIFY_TRANSIENT_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        await runVerifyDevice(b, dev, deviceAddress, res);
        return;
      } catch (e) {
        if (
          isTransientBusTimeout(e) &&
          attempt < VERIFY_TRANSIENT_MAX_ATTEMPTS
        ) {
          logger.warn('bus', 'verify-device: transient timeout, retrying', {
            deviceAddress,
            attempt,
          });
          await sleep(VERIFY_TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        res
          .status(msg.includes('Not connected') ? 409 : 502)
          .json({ error: safeErrorOrConnection('bus', 'Device verify failed', e) });
        return;
      }
    }
  } finally {
    releaseKeepAlive();
  }
});

/** The real body of `/bus/verify-device` - extracted so the route above can
 * retry it whole on a transient timeout (§ above) without duplicating this
 * logic. Sends the response itself (success or an "expected" 4xx) and
 * returns normally; throws for anything the caller's retry loop should
 * catch (a real bus-communication failure). */
async function runVerifyDevice(
  b: KnxBusManager,
  dev: Device,
  deviceAddress: string,
  res: Response,
): Promise<void> {
  const built = buildDeviceProgramming(dev);
  if (!built.ok) {
    res.status(built.status).json(built.body);
    return;
  }
  const {
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    paramMem,
    paramBase,
    absSegData,
    appId,
    paramMemLayout,
    params: paramDefs,
    cachedMaxApduLength,
  } = built;

  // Derive the read-back plan from the SAME artifacts the download would use.
  // planVerify covers every device family we own:
  //   absmem — each AbsSegment memory transfer becomes a memory read/diff;
  //   relmem — each WriteRelMem segment becomes a paramMem read/diff;
  //   prop   — property-configured devices (no image) become property reads.
  //
  // System B relmem segments live at a device-resident base (PID 7), not at
  // the step's relative offset. Resolve it over the bus and refuse to verify
  // an unallocated segment (a zero base would read the wrong low-memory region
  // and report a bogus all-zeros mismatch).
  //
  // Also resolve the GA table (objIdx 1) / Association table (objIdx 2) /
  // Group Object Table (objIdx 3, added 2026-08-29) base whenever the app's
  // own model doesn't already declare a step for it but a table exists to
  // compare - real ETS verifies/writes these via the same RelSegment
  // mechanism even without an explicit declaration (see knx-download-plan.ts's
  // `buildUndeclaredTableMem` and knx-connection.ts's writeUndeclaredTable()
  // for the write-side twin of this same gap).
  // Only for genuinely RelSegment-family apps (at least one real WriteRelMem
  // step somewhere) - real ETS's GA/Association/Object-3-via-RelSegment
  // behavior has only ever been confirmed on this family (System B masks).
  // AbsSegment (MDT-style) and prop-only devices have no such mechanism
  // confirmed at all, and forcing a PID 7 resolve for objIdx 1/2/3 on those
  // would 409 the whole verify on a genuinely unrelated/unallocated
  // interface object.
  const isRelSegmentApp = (
    steps as Array<{ type: string; objIdx?: number }>
  ).some((s) => s.type === 'WriteRelMem');
  // Only a genuine WriteRelMem step (a real content write) counts as
  // "already handled" here - LoadImageProp is confirmed read-only for every
  // objIdx (docs/knx-device-write-protocol.md Part 7), so a model
  // declaring it never actually reads/writes the GA/Association table
  // content itself. Same fix as knx-connection.ts's downloadDevice()
  // (2026-08-29, koolenex 9eaed85) - this verify-side copy had the
  // identical bug: for 1.1.10's app (which declares LoadImageProp for
  // objIdx 1/2/3), verify silently skipped comparing the real GA/
  // Association table content against the device at all.
  const declaredTableObjIdxs = new Set(
    (steps as Array<{ type: string; objIdx?: number }>)
      .filter((s) => s.type === 'WriteRelMem')
      .map((s) => s.objIdx),
  );
  const extraObjIdxs: number[] = [];
  if (isRelSegmentApp && gaTable && gaTable.length && !declaredTableObjIdxs.has(1))
    extraObjIdxs.push(1);
  if (isRelSegmentApp && assocTable && assocTable.length && !declaredTableObjIdxs.has(2))
    extraObjIdxs.push(2);
  if (
    isRelSegmentApp &&
    groupObjectTable &&
    groupObjectTable.length &&
    !declaredTableObjIdxs.has(3)
  )
    extraObjIdxs.push(3);
  const { bases, unallocated } = await resolveRelmemBases(
    b,
    deviceAddress,
    steps as Array<{ type: string; objIdx?: number }>,
    extraObjIdxs,
  );
  if (unallocated.length) {
    res.status(409).json({
      error: 'segment_unallocated',
      message: `Interface object(s) ${unallocated.join(', ')} report an unallocated segment (PID 7 = 0); device is not in a verifiable state.`,
    });
    return;
  }

  const plan = planVerify(
    steps as PlanStep[],
    gaTable,
    assocTable,
    paramMem,
    paramBase,
    absSegData,
    appId,
    bases,
    groupObjectTable,
  );

  if (plan.family === 'none' || (!plan.mem.length && !plan.props.length)) {
    res.status(400).json({
      error: 'nothing_to_verify',
      message:
        'Device exposes no downloadable memory image or comparable properties to verify.',
    });
    return;
  }

  const segments = [];
  const props = [];
  let totalBytes = 0;
  let totalDiffering = 0;
  // Object 3's own raw byte-level totals, set only when this app declares
  // a Group Object Table region to verify - see the assignment further
  // down for why this is tracked as a separate pair rather than folded
  // into totalBytes/totalDiffering above.
  let flagsTotalBytes: number | undefined;
  let flagsDifferingBytes: number | undefined;

  // Read every region/property for this device inside ONE management session
  // (one Connect/Disconnect for the whole verify), instead of churning a
  // fresh connection-oriented session per read. The total byte count is
  // known upfront (it's the same computed-image size "expected" is built
  // from), so real progress can be broadcast as chunks come in rather than
  // only reporting done/not-done - the UI no longer has to guess.
  const progressTotal = plan.mem.reduce(
    (sum, r) => sum + r.expected.length,
    0,
  );
  const memActuals = plan.mem.length
    ? await b.readMemoryMany(
        deviceAddress,
        plan.mem.map((r) => ({ address: r.addr, length: r.expected.length })),
        undefined,
        (bytesRead) =>
          b.broadcast('verify:progress', {
            deviceAddress,
            bytesRead,
            totalBytes: progressTotal,
            pct: progressTotal
              ? Math.min(100, Math.round((bytesRead / progressTotal) * 100))
              : 0,
          }),
        cachedMaxApduLength,
      )
    : [];
  for (let i = 0; i < plan.mem.length; i++) {
    const region = plan.mem[i]!;
    const expected = region.expected;
    const actual = memActuals[i] ?? Buffer.alloc(0);
    const diff = diffMemory(expected, actual, region.addr);
    totalBytes += diff.total;
    totalDiffering += diff.differing;
    segments.push({
      label: region.label,
      offset: region.addr,
      size: expected.length,
      matching: diff.matching,
      differing: diff.differing,
      chunks: diff.chunks,
      expectedHex: expected.toString('hex'),
      actualHex: actual.toString('hex'),
    });
  }

  const propActuals = plan.props.length
    ? await b.readPropertyMany(
        deviceAddress,
        plan.props.map((p) => ({ objIdx: p.obj, propId: p.pid })),
      )
    : [];
  for (let i = 0; i < plan.props.length; i++) {
    const p = plan.props[i]!;
    const actual = propActuals[i] ?? Buffer.alloc(0);
    // Compare over the length ETS supplies as the expected value; the device
    // may return a longer property array than the compared prefix.
    const cmpLen = Math.min(p.expected.length, actual.length);
    const differ =
      actual.length < p.expected.length ||
      !actual.subarray(0, cmpLen).equals(p.expected.subarray(0, cmpLen));
    totalBytes += p.expected.length;
    totalDiffering += differ ? p.expected.length : 0;
    props.push({
      label: p.label,
      obj: p.obj,
      pid: p.pid,
      match: !differ,
      expectedHex: p.expected.toString('hex'),
      actualHex: actual.toString('hex'),
    });
  }

  // Decode the raw relmem bytes just read/compared into human-readable
  // parameter values, purely as an additional view on data already
  // fetched above — no extra bus reads. Reuses the exact same
  // paramMemLayout/params definitions used to build the download image and
  // to compute "expected", so decoded expected/actual values are directly
  // comparable to (and should explain) the byte-level diff in `segments`.
  // relmem-family only for now (single contiguous buffer to decode
  // against one paramMemLayout); prop-family devices have no equivalent
  // memory image to decode.
  type DecodedComparison = Omit<
    ReturnType<typeof decodeParamMem>[number],
    'value'
  > & {
    expectedValue: string;
    actualValue: string | null;
    match: boolean | null;
    // Object 3 rows only - structured (not string) flag data for the
    // compact per-flag chip display, added 2026-08-29 alongside the
    // chip redesign. `expectedValue`/`actualValue` (the full sentence
    // from describeGroupObjectEntry()) stay the hover-tooltip content;
    // undefined for every other row kind (params, GA links).
    obj3Expected?: GroupObjectEntryFlags;
    obj3Actual?: GroupObjectEntryFlags | null;
  };
  let decoded: DecodedComparison[] | undefined;
  if (
    plan.family === 'relmem' &&
    segments.length === 1 &&
    paramMemLayout &&
    Object.keys(paramMemLayout).length
  ) {
    const expectedBuf = Buffer.from(segments[0]!.expectedHex, 'hex');
    const actualBuf = Buffer.from(segments[0]!.actualHex, 'hex');
    const layout = paramMemLayout as Parameters<typeof decodeParamMem>[1];
    const defs = paramDefs as Parameters<typeof decodeParamMem>[2];
    const expectedDecoded = decodeParamMem(expectedBuf, layout, defs);
    const actualDecoded = decodeParamMem(actualBuf, layout, defs);
    const actualByKey = new Map(actualDecoded.map((d) => [d.key, d]));
    decoded = expectedDecoded.map(({ value, ...exp }) => {
      const act = actualByKey.get(exp.key);
      return {
        ...exp,
        expectedValue: value,
        actualValue: act?.value ?? null,
        match: act ? act.value === value : null,
      };
    });
  }

  // Verify the GA table / Association table too, when the model didn't
  // already declare (and get read/decoded as) an ordinary WriteRelMem
  // step - see the `undeclaredTableMem` field comment in
  // knx-download-plan.ts. Surfaced as one comparison row per
  // communication object (its expected vs. actual linked GA), not raw
  // bytes - deliberately kept out of `segments`/`totalBytes` so the
  // existing "raw memory bytes match" scope (named-parameter segment
  // only) is unaffected; folded into `decoded` instead, so it shows up
  // in the same named-comparison table the frontend already renders.
  // Scoped to just gatable@/assoctable@ here - Object 3 (object3@) is
  // handled separately below, since its real size is already known
  // (groupObjectTableSize) rather than needing GA/Assoc's own dynamic
  // "read the real count field first" probe.
  const gaAssocMem = plan.undeclaredTableMem.filter(
    (r) => r.label.startsWith('gatable@') || r.label.startsWith('assoctable@'),
  );
  if (gaAssocMem.length) {
    // The device's own real table can be a DIFFERENT size than the
    // project's currently-computed `expected` buffer (e.g. a GA link was
    // just removed/added in the project but never re-downloaded, or the
    // device simply has more/fewer entries than the project currently
    // declares) - reading `expected.length` bytes would silently truncate
    // a real table that's larger than expected, decoding it as if entries
    // past the truncation point don't exist. Read each table's real
    // 2-byte count field first, then read the real full length it
    // implies - not the project's assumed length. Capped defensively
    // (2000 bytes ~ 500 GA entries / 250 association entries) against a
    // corrupt/garbage count field driving an unbounded read.
    const countActuals = await b.readMemoryMany(
      deviceAddress,
      gaAssocMem.map((r) => ({ address: r.addr, length: 2 })),
      undefined,
      undefined,
      cachedMaxApduLength,
    );
    const realLengths = gaAssocMem.map((r, i) => {
      const countBuf = countActuals[i];
      const realCount =
        countBuf && countBuf.length >= 2 ? countBuf.readUInt16BE(0) : 0;
      const entryWidth = r.label.startsWith('gatable@') ? 2 : 4;
      const realLen = 2 + realCount * entryWidth;
      return Math.min(Math.max(realLen, r.expected.length), 2000);
    });
    const gaAssocActuals = await b.readMemoryMany(
      deviceAddress,
      gaAssocMem.map((r, i) => ({ address: r.addr, length: realLengths[i]! })),
      undefined,
      undefined,
      cachedMaxApduLength,
    );
    const coRows = db.all<ComObject>(
      'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
      [dev.id],
    );
    const gaRegion = gaAssocMem.find((r) => r.label.startsWith('gatable@'));
    const assocRegion = gaAssocMem.find((r) => r.label.startsWith('assoctable@'));
    const gaIdx = gaRegion ? gaAssocMem.indexOf(gaRegion) : -1;
    const assocIdx = assocRegion ? gaAssocMem.indexOf(assocRegion) : -1;

    const expectedGAs = gaRegion ? decodeGATable(gaRegion.expected) : [];
    const actualGAs =
      gaIdx >= 0 ? decodeGATable(gaAssocActuals[gaIdx] ?? Buffer.alloc(0)) : [];
    const expectedAssoc = assocRegion
      ? decodeAssocTable(assocRegion.expected, expectedGAs)
      : [];
    const actualAssoc =
      assocIdx >= 0
        ? decodeAssocTable(gaAssocActuals[assocIdx] ?? Buffer.alloc(0), actualGAs)
        : [];
    // A com object can have more than one GA link (see buildAssocTable) -
    // aggregate every link per com object rather than keeping only the
    // last one, then join for display/comparison the same way
    // co.ga_address is already stored (space-separated).
    const groupByCO = (
      entries: Array<{ coNumber: number; ga: string | null }>,
    ): Map<number, string> => {
      const m = new Map<number, string[]>();
      for (const e of entries) {
        if (!m.has(e.coNumber)) m.set(e.coNumber, []);
        if (e.ga) m.get(e.coNumber)!.push(e.ga);
      }
      return new Map([...m].map(([co, gas]) => [co, gas.join(' ')]));
    };
    const expectedByCO = groupByCO(expectedAssoc);
    const actualByCO = groupByCO(actualAssoc);

    // One row per com object that has (or should have) a GA link on
    // either side - matches the existing "only named parameters" scope
    // convention (nothing to compare = not shown).
    const gaRows: DecodedComparison[] = [];
    for (const co of coRows) {
      const expectedGA = expectedByCO.get(co.object_number) ?? null;
      const actualGA = actualByCO.get(co.object_number) ?? null;
      if (expectedGA == null && actualGA == null) continue;
      gaRows.push({
        key: `co-${co.object_number}-ga`,
        label: co.name || `CO ${co.object_number}`,
        section: 'Group Addresses',
        group: co.channel || '',
        unit: '',
        offset: 0,
        bitOffset: 0,
        bitSize: 0,
        rawValue: '',
        expectedValue: expectedGA ?? '(none)',
        actualValue: actualGA,
        match: expectedGA === actualGA,
      });
    }
    if (gaRows.length) decoded = [...(decoded ?? []), ...gaRows];
  }

  // Verify Object 3 (Group Object Table) too, when the model didn't
  // already declare it - added 2026-08-29 alongside the real-hardware
  // write confirmation (docs/knx-device-write-protocol.md Part 18).
  // Unlike GA/Association, Object 3's real size is already known
  // (`groupObjectTable.length`, computed from `maxComObjectNumber` -
  // ets-app.ts) rather than needing a dynamic count-probe read first -
  // it isn't a variable-length, user-editable-link-count table the way
  // GA/Association are. One comparison row per communication object
  // (its expected vs. actual raw flag+size-code byte pair), matching the
  // GA rows' "named comparison, not raw bytes" convention.
  const object3Region = plan.undeclaredTableMem.find((r) =>
    r.label.startsWith('object3@'),
  );
  if (object3Region) {
    const [actualObject3] = await b.readMemoryMany(
      deviceAddress,
      [
        {
          address: object3Region.addr,
          length: object3Region.expected.length,
        },
      ],
      undefined,
      undefined,
      cachedMaxApduLength,
    );
    const actual = actualObject3 ?? Buffer.alloc(0);
    // Object 3's own raw byte-level diff count, mirroring `totalBytes`/
    // `totalDiffering` for the named-parameter segment - surfaced
    // separately (`flagsTotalBytes`/`flagsDifferingBytes`) so the log line
    // can quote a real "N/M bytes match" figure for this region too,
    // rather than only ever reporting it as a count of differing named
    // rows. Genuinely a different number from the per-communication-object
    // row mismatch count below: one flag bit differing inside one row's
    // byte still counts as the whole byte differing here.
    flagsTotalBytes = object3Region.expected.length;
    flagsDifferingBytes = 0;
    for (let i = 0; i < object3Region.expected.length; i++) {
      if (object3Region.expected[i] !== actual[i]) flagsDifferingBytes++;
    }
    const coRows = db.all<ComObject>(
      'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
      [dev.id],
    );
    const obj3Rows: DecodedComparison[] = [];
    // Human-readable, not a raw hex byte pair - every flag bit
    // computeGroupObjectByte() writes (Update/Transmit/Read-On-Init/
    // Write/Read/Comm+Linked), Priority, and the real Object Size, not
    // just the GA link already shown in its own row above. See
    // describeGroupObjectEntry()'s own doc comment (knx-tables.ts).
    const fmtEntry = (e: { flagByte: number; sizeCodeByte: number } | null): string =>
      e ? describeGroupObjectEntry(e) : '(out of range)';
    for (const co of coRows) {
      const expectedEntry = decodeGroupObjectEntry(
        object3Region.expected,
        co.object_number,
      );
      const actualEntry = decodeGroupObjectEntry(actual, co.object_number);
      // Nothing to show for an object with no real entry on either side
      // (matches the GA rows' "nothing to compare = not shown" convention).
      if (!expectedEntry && !actualEntry) continue;
      const expectedStr = fmtEntry(expectedEntry);
      const actualStr = fmtEntry(actualEntry);
      obj3Rows.push({
        key: `co-${co.object_number}-obj3`,
        label: co.name || `CO ${co.object_number}`,
        section: 'Group Object Table',
        group: co.channel || '',
        unit: '',
        offset: co.object_number * 2,
        bitOffset: 0,
        bitSize: 0,
        rawValue: '',
        expectedValue: expectedStr,
        actualValue: actualStr,
        match: expectedStr === actualStr,
        // Structured flags for the compact per-flag chip display -
        // expectedEntry is only null when the object falls outside the
        // buffer, which can't happen here (coRows only ever holds real
        // com objects, and buildGroupObjectTable() sizes the buffer to
        // cover every one of them) - the fallback is defensive, not a
        // real expected case.
        obj3Expected: expectedEntry
          ? decodeGroupObjectEntryFlags(expectedEntry)
          : undefined,
        obj3Actual: actualEntry ? decodeGroupObjectEntryFlags(actualEntry) : null,
      });
    }
    if (obj3Rows.length) decoded = [...(decoded ?? []), ...obj3Rows];
  }

  // `totalDiffering`/`totalBytes` are deliberately scoped to raw memory
  // only (segments) - GA table, Association table, and Object 3 rows are
  // kept OUT of that scope on purpose (see `undeclaredTableMem`'s own doc
  // comment in knx-download-plan.ts), so a real mismatch in any of those
  // would previously leave `totalDiffering === 0` true and this top-level
  // `match` flag reporting a false "everything matches" - inconsistent
  // with the real per-row mismatches shown in `decoded` (found live,
  // 2026-08-29: a real Object 3 mismatch on 1.1.9 showed up correctly as
  // a row and a summary badge, but the overall match flag - and the
  // ProgrammingView log line derived from it - still said "matches
  // computed image"). `match` now requires every decoded row to match
  // too, not just the raw byte scope.
  const allDecodedMatch = !decoded || decoded.every((d) => d.match !== false);
  const match = totalDiffering === 0 && allDecodedMatch;
  // A clean verify is real, positive confirmation the device's actual
  // content matches the project - clears any "verify recommended"
  // indicator left over from a download with unconfirmed writes (see
  // /bus/program-device's own unconfirmed_writes_count/detail write).
  if (match) {
    db.run(
      'UPDATE devices SET unconfirmed_writes_count=0, unconfirmed_writes_detail=? WHERE id=?',
      ['[]', dev.id],
    );
  }
  // Persisted verify indicator, added 2026-09-01 - real request: "we
  // should consider an indicator for both successful verify and
  // failed". Written unconditionally (both match and mismatch), unlike
  // the unconfirmed_writes reset above which only applies on a clean
  // match - a real, live bus verify just happened either way, and the
  // whole point is to surface a failed one just as visibly as a clean
  // one. See last_verify_match's own migration comment (db.ts) for why
  // this only ever happens here (a real live bus read), never from the
  // cache-only recompute path below.
  db.run(
    'UPDATE devices SET last_verify_match=?, last_verify_at=? WHERE id=?',
    [match ? 1 : 0, new Date().toISOString(), dev.id],
  );
  db.scheduleSave();
  res.json({
    deviceAddress,
    family: plan.family,
    match,
    totalBytes,
    totalDiffering,
    segments,
    props,
    ...(decoded ? { decoded } : {}),
    ...(flagsTotalBytes !== undefined
      ? { flagsTotalBytes, flagsDifferingBytes }
      : {}),
  });
}

// Recomputes a verify comparison's PROJECT/expected side fresh from current
// DB state, reusing whatever DEVICE/actual side is already cached client-
// side from the last real bus read - deliberately NO bus access at all.
// Real user feedback, 2026-08-31: "If we have previously verified the
// device and have its data in cache, why make it stale when DB items are
// modified? ... no real gain in forcing a re-read of device memory. Better
// we just re-run the comparison of our modified DB values against the
// previously cached device values." Correct: nothing about editing a com
// object's flags, a GA link, or a parameter value changes what's actually
// sitting in the device's memory - only what we now expect to find there -
// so there's no reason a local edit should force the user back through a
// live bus round trip just to see an accurate comparison again.
//
// buildDeviceProgramming(dev) and every decode helper this reuses
// (decodeParamMem/decodeGATable/decodeAssocTable/decodeGroupObjectEntry)
// are pure DB/model functions - none of them touch the bus, confirmed by
// inspection: runVerifyDevice() above already calls buildDeviceProgramming
// BEFORE resolving any live device addressing. The one thing genuinely
// impossible without a live read is a FRESH actual/device-side reading -
// this route never attempts that, it only re-diffs the caller's existing
// actual bytes/values against a newly-computed expected side.
//
// Scope, honestly limited rather than silently wrong: the raw byte-level
// `segments` comparison (and its derived param `decoded` rows) is only
// recomputed for the common relmem/single-segment case this project has
// real hardware confirmation for (see paramMemLayout gate below) - other
// shapes (absmem/MDT-style, multi-segment) pass the cached segment through
// unchanged rather than risk a wrong recompute for a family this project
// has never proven the technique against. GA-link and Object 3 flag rows,
// by contrast, are always recomputed when the device's app model supports
// them at all - both are pure function-of-(com_objects, fresh table)
// lookups with no family-specific memory-layout assumptions, so there's no
// analogous gap to guard against there.
// .passthrough() on both - the client's real segment/decoded-row shapes
// (VerifyDeviceResult in client/src/api.ts) carry extra fields this route
// doesn't need to touch (matching/differing/chunks on a segment; unit/
// bitOffset/bitSize/rawValue/section/group on a decoded row) - stripping
// them here would silently corrupt any row this route DOESN'T recompute
// (the "can't safely recompute this shape, pass it through unchanged"
// fallback paths below) by handing back an incomplete object in place of
// the real one.
const RecomputeSegmentSchema = z
  .object({
    label: z.string(),
    offset: z.number(),
    size: z.number(),
    expectedHex: z.string(),
    actualHex: z.string(),
  })
  .passthrough();
type RecomputeSegment = z.infer<typeof RecomputeSegmentSchema> & {
  matching?: number;
  differing?: number;
};
const RecomputeDecodedSchema = z
  .object({ key: z.string().optional() })
  .passthrough();
type RecomputeDecoded = z.infer<typeof RecomputeDecodedSchema> & {
  actualValue?: unknown;
  obj3Actual?: unknown;
  match?: boolean | null;
};

router.post(
  '/bus/verify-device/recompute',
  (req: Request, res: Response): void => {
    const body = validateBody(
      req,
      z.object({
        deviceId: z.number().int(),
        cached: z.object({
          deviceAddress: z.string(),
          family: z.string(),
          totalBytes: z.number(),
          totalDiffering: z.number(),
          segments: z.array(RecomputeSegmentSchema),
          props: z.array(z.record(z.string(), z.unknown())).default([]),
          decoded: z.array(RecomputeDecodedSchema).optional(),
          flagsTotalBytes: z.number().optional(),
          flagsDifferingBytes: z.number().optional(),
        }),
      }),
    );
    const { deviceId, cached } = body;

    const dev = db.get<Device>('SELECT * FROM devices WHERE id=?', [
      deviceId,
    ]);
    if (!dev) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const built = buildDeviceProgramming(dev);
    if (!built.ok) {
      res.status(built.status).json(built.body);
      return;
    }
    const {
      paramMem,
      paramMemLayout,
      params: paramDefs,
      gaTable,
      assocTable,
      groupObjectTable,
    } = built;

    let segments: RecomputeSegment[] = cached.segments;
    let totalBytes = 0;
    let totalDiffering = 0;
    let paramRows: RecomputeDecoded[] | null = null;

    // Only the exact shape runVerifyDevice()'s own decode gate covers
    // (single relmem segment, a real paramMemLayout) - see this function's
    // own doc comment above for why other shapes are left untouched.
    const cachedSeg = cached.segments.length === 1 ? cached.segments[0] : null;
    const cachedActualBuf = cachedSeg
      ? Buffer.from(cachedSeg.actualHex, 'hex')
      : null;
    const canRecomputeParams =
      cached.family === 'relmem' &&
      cachedSeg &&
      cachedActualBuf &&
      paramMem &&
      paramMem.length === cachedActualBuf.length &&
      paramMemLayout &&
      Object.keys(paramMemLayout).length > 0;

    if (canRecomputeParams && cachedSeg && cachedActualBuf) {
      const diff = diffMemory(paramMem!, cachedActualBuf, cachedSeg.offset);
      segments = [
        {
          ...cachedSeg,
          expectedHex: paramMem!.toString('hex'),
          matching: diff.matching,
          differing: diff.differing,
        },
      ];
      totalBytes += diff.total;
      totalDiffering += diff.differing;

      const layout = paramMemLayout as Parameters<typeof decodeParamMem>[1];
      const defs = paramDefs as Parameters<typeof decodeParamMem>[2];
      const expectedDecoded = decodeParamMem(paramMem!, layout, defs);
      const actualDecoded = decodeParamMem(cachedActualBuf, layout, defs);
      const actualByKey = new Map(actualDecoded.map((d) => [d.key, d]));
      paramRows = expectedDecoded.map(({ value, ...exp }) => {
        const act = actualByKey.get(exp.key);
        return {
          ...exp,
          expectedValue: value,
          actualValue: act?.value ?? null,
          match: act ? act.value === value : null,
        };
      });
    } else {
      // Can't safely recompute this shape - keep the cached segment/totals
      // exactly as they were rather than guess.
      totalBytes = cached.totalBytes;
      totalDiffering = cached.totalDiffering;
    }

    const cachedDecoded: RecomputeDecoded[] = cached.decoded ?? [];
    const priorParamRows = cachedDecoded.filter(
      (d) => !String(d.key ?? '').startsWith('co-'),
    );
    const priorGaRows = new Map(
      cachedDecoded
        .filter((d) => String(d.key ?? '').endsWith('-ga'))
        .map((d) => [d.key as string, d]),
    );
    const priorObj3Rows = new Map(
      cachedDecoded
        .filter((d) => String(d.key ?? '').endsWith('-obj3'))
        .map((d) => [d.key as string, d]),
    );

    const coRows = db.all<ComObject>(
      'SELECT * FROM com_objects WHERE device_id=? ORDER BY object_number',
      [dev.id],
    );

    // GA-link rows - always recomputed when the app model has a GA table at
    // all, regardless of device family (pure com_objects + fresh gaTable/
    // assocTable lookup, no raw-byte/addressing dependency - see this
    // function's doc comment above).
    const gaRows: RecomputeDecoded[] = [];
    if (gaTable && assocTable) {
      const expectedGAs = decodeGATable(gaTable);
      const expectedAssoc = decodeAssocTable(assocTable, expectedGAs);
      const groupByCO = (
        entries: Array<{ coNumber: number; ga: string | null }>,
      ): Map<number, string> => {
        const m = new Map<number, string[]>();
        for (const e of entries) {
          if (!m.has(e.coNumber)) m.set(e.coNumber, []);
          if (e.ga) m.get(e.coNumber)!.push(e.ga);
        }
        return new Map([...m].map(([co, gas]) => [co, gas.join(' ')]));
      };
      const expectedByCO = groupByCO(expectedAssoc);
      for (const co of coRows) {
        const key = `co-${co.object_number}-ga`;
        const prior = priorGaRows.get(key);
        const expectedGA = expectedByCO.get(co.object_number) ?? null;
        const actualGA = (prior?.actualValue as string | null) ?? null;
        if (expectedGA == null && actualGA == null) continue;
        gaRows.push({
          key,
          label: co.name || `CO ${co.object_number}`,
          section: 'Group Addresses',
          group: co.channel || '',
          unit: '',
          offset: 0,
          bitOffset: 0,
          bitSize: 0,
          rawValue: '',
          expectedValue: expectedGA ?? '(none)',
          actualValue: actualGA,
          match: expectedGA === actualGA,
        });
      }
    }

    // Object 3 rows - same reasoning, always recomputed when a Group
    // Object Table exists for this app.
    const obj3Rows: RecomputeDecoded[] = [];
    if (groupObjectTable) {
      const fmtEntry = (
        e: { flagByte: number; sizeCodeByte: number } | null,
      ): string => (e ? describeGroupObjectEntry(e) : '(out of range)');
      for (const co of coRows) {
        const key = `co-${co.object_number}-obj3`;
        const prior = priorObj3Rows.get(key);
        const expectedEntry = decodeGroupObjectEntry(
          groupObjectTable,
          co.object_number,
        );
        const actualStr = (prior?.actualValue as string | null) ?? null;
        if (!expectedEntry && actualStr == null) continue;
        const expectedStr = fmtEntry(expectedEntry);
        obj3Rows.push({
          key,
          label: co.name || `CO ${co.object_number}`,
          section: 'Group Object Table',
          group: co.channel || '',
          unit: '',
          offset: co.object_number * 2,
          bitOffset: 0,
          bitSize: 0,
          rawValue: '',
          expectedValue: expectedStr,
          actualValue: actualStr,
          match: expectedStr === actualStr,
          obj3Expected: expectedEntry
            ? decodeGroupObjectEntryFlags(expectedEntry)
            : undefined,
          obj3Actual: prior?.obj3Actual ?? null,
        });
      }
    }

    const decoded = [
      ...(paramRows ?? priorParamRows),
      ...(gaTable && assocTable
        ? gaRows
        : [...priorGaRows.values()]),
      ...(groupObjectTable ? obj3Rows : [...priorObj3Rows.values()]),
    ];
    const allDecodedMatch =
      !decoded.length || decoded.every((d) => d.match !== false);

    res.json({
      deviceAddress: cached.deviceAddress,
      family: cached.family,
      match: totalDiffering === 0 && allDecodedMatch,
      totalBytes,
      totalDiffering,
      segments,
      props: cached.props,
      decoded,
      ...(cached.flagsTotalBytes !== undefined
        ? {
            flagsTotalBytes: cached.flagsTotalBytes,
            flagsDifferingBytes: cached.flagsDifferingBytes,
          }
        : {}),
      // Marks this as a LOCAL recompute, not a fresh device read - the
      // client keeps its original `fetchedAt` (the last real bus read
      // time) and layers this on top, so the UI can be honest about what
      // actually happened ("recomputed just now, device last read 5m
      // ago") instead of implying a new bus round trip occurred.
      recomputedAt: Date.now(),
    });
  },
);

export function setBus(b: KnxBusManager): void {
  bus = b;
  wireBusEvents();
}

/** Lazy accessor for the bus instance. Returns null until setBus() runs. */
export function getBus(): KnxBusManager | null {
  return bus;
}
