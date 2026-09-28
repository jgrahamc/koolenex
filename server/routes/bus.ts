import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import * as db from '../db.ts';
import { APPS_DIR, getDptInfo } from './shared.ts';
import { getPendingChanges, clearPendingChanges } from './shared.ts';
import { logger, safeErrorOrConnection } from '../log.ts';
import { normalizeDptKey } from '../../shared/dpt-key.ts';
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
  buildParamMemBySegment,
  resolveParamSegments,
  writtenParamKeys,
  diffMemory,
  decodeParamMem,
  type ParamDef,
} from './knx-tables.ts';
import {
  expandParamMemLayoutForActiveModules,
  type ModuleAwareParamMemLayoutEntry,
} from '../resolveModuleParamMemLayout.ts';
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
import { delay, scaledMs } from '../knx-connection.ts';
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

type BusHandler<T> = (
  b: KnxBusManager,
  body: T,
  res: Response,
) => unknown | Promise<unknown>;

/**
 * Shared prologue/epilogue for bus routes: requires the bus, validates the
 * body, runs the handler, and maps failures to a status code + safe error.
 *
 * A handler's return value is sent as JSON; returning undefined means the
 * handler already wrote to `res` itself.
 *
 * Not-connected always maps to 409; `failStatus` (default 502) covers
 * everything else, except the USB enumeration routes where failure is
 * local libusb/HID, not an upstream bus failure.
 *
 * Validation runs outside the try, so a ValidationError reaches the app's
 * error middleware as a 400 rather than being reported as a bus failure.
 */
function busRoute<S extends z.ZodTypeAny>(
  schema: S,
  context: string,
  handler: BusHandler<z.infer<S>>,
  failStatus?: number,
): (req: Request, res: Response) => Promise<void>;
function busRoute(
  schema: null,
  context: string,
  handler: BusHandler<undefined>,
  failStatus?: number,
): (req: Request, res: Response) => Promise<void>;
function busRoute(
  schema: z.ZodTypeAny | null,
  context: string,
  handler: BusHandler<never>,
  failStatus = 502,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const b = requireBus(res);
    if (!b) return;
    const body = (schema ? validateBody(req, schema) : undefined) as never;
    try {
      const result = await handler(b, body, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res
        .status(msg.includes('Not connected') ? 409 : failStatus)
        .json({ error: safeErrorOrConnection('bus', context, e) });
    }
  };
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
export { normalizeDptKey };

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

router.post(
  '/bus/connect',
  busRoute(
    z.object({
      host: z.string().min(1),
      port: z.coerce.number().int().positive().optional(),
      projectId: z.number().int().optional(),
      // KNXnet/IP transport for Tunneling. 'auto' (default) tries TCP first,
      // falls back to UDP - see knx-protocol.ts.
      protocol: z.enum(['udp', 'tcp', 'auto']).optional(),
    }),
    'Bus connection failed',
    async (b, body) => {
      const { host, port, projectId, protocol } = body;
      const result = await b.connect(host, port || 3671, projectId, protocol);
      db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_host',?)", [host]);
      db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_port',?)", [
        String(port || 3671),
      ]);
      db.run("INSERT OR REPLACE INTO settings VALUES ('knxip_protocol',?)", [
        protocol || 'auto',
      ]);
      db.scheduleSave();
      return { ok: true, ...result };
    },
  ),
);

router.get(
  '/bus/usb-devices',
  busRoute(
    null,
    'Failed to list USB devices',
    async (b) => {
      const devices = b.listUsbDevices();
      return { devices };
    },
    500,
  ),
);

router.get(
  '/bus/usb-devices/all',
  busRoute(
    null,
    'Failed to list HID devices',
    async (b) => {
      const devices = b.listAllHidDevices();
      return { devices };
    },
    500,
  ),
);

router.post(
  '/bus/connect-usb',
  busRoute(
    z.object({
      devicePath: z.string().min(1),
      projectId: z.number().int().optional(),
    }),
    'USB connection failed',
    async (b, body) => {
      const { devicePath, projectId } = body;
      const result = await b.connectUsb(devicePath, projectId);
      return { ok: true, type: 'usb', ...result };
    },
  ),
);

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

router.post(
  '/bus/write',
  busRoute(
    z.object({
      ga: z.string().min(1),
      value: z.unknown(),
      dpt: z.string().optional(),
      projectId: z.number().int().optional(),
    }),
    'Bus write failed',
    async (b, body) => {
      const { ga, value, dpt, projectId } = body;
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
      return result;
    },
  ),
);

router.post(
  '/bus/read',
  busRoute(
    z.object({ ga: z.string().min(1) }),
    'Bus read failed',
    async (b, body) => {
      return await b.read(body.ga);
    },
  ),
);

// Probe device reachability
router.post(
  '/bus/ping',
  busRoute(
    z.object({
      gaAddresses: z.array(z.string()).optional().default([]),
      deviceAddress: z.string().optional(),
    }),
    'Ping failed',
    async (b, body) => {
      const { gaAddresses, deviceAddress } = body;
      const result = await b.ping(gaAddresses, deviceAddress || null);
      return result;
    },
  ),
);

// Flash programming LED on device
router.post(
  '/bus/identify',
  busRoute(
    z.object({ deviceAddress: z.string().min(1) }),
    'Identify failed',
    async (b, body) => {
      const { deviceAddress } = body;
      await b.identify(deviceAddress);
      return { ok: true };
    },
  ),
);

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
router.post(
  '/bus/device-info',
  busRoute(
    z.object({ deviceAddress: z.string().min(1) }),
    'Failed to read device info',
    async (b, body) => {
      const { deviceAddress } = body;
      const info = await b.readDeviceInfo(deviceAddress);
      return info;
    },
  ),
);

// Read raw device memory over the bus (non-destructive; read-first validation).
router.post(
  '/bus/read-memory',
  busRoute(
    z
      .object({
        deviceAddress: z.string().min(1),
        // 24-bit address space; readMemory() picks A_Memory_Read vs
        // A_MemoryExtended_Read per chunk based on the address.
        address: z.number().int().min(0).max(0xffffff),
        length: z.number().int().min(1).max(4096),
        // Debug-only: override MemoryExtended_Read chunk size for
        // bisecting a device's real safe read chunk size. Normal path uses
        // readMemory()'s default (12).
        chunkSize: z.number().int().min(1).max(255).optional(),
      })
      // Reads must not run past the top of the 24-bit extended address
      // space, or `address + off` would wrap.
      .refine((v) => v.address + v.length <= 0x1000000, {
        message: 'address + length exceeds the 24-bit memory space (0x1000000)',
        path: ['length'],
      }),
    'Memory read failed',
    async (b, body) => {
      const { deviceAddress, address, length, chunkSize } = body;
      const data = await b.readMemory(
        deviceAddress,
        address,
        length,
        chunkSize,
      );
      return {
        deviceAddress,
        address,
        length: data.length,
        hex: data.toString('hex'),
      };
    },
  ),
);

// Write an exact byte sequence to an absolute memory address. Debug-only
// helper for pinning down write-path issues at the byte level, bypassing
// buildDeviceProgramming()'s computed image. Reuses downloadDevice()'s
// WriteRelMem path by passing `address` as objIdx 0's resolved base with
// offset 0, so addr = base + offset = address exactly.
//
// Optional `relSegment` wraps the write in a full Unload/StartLoading/
// LoadData/LoadCompleted sequence, declaring the segment's real full
// size/fill (as ETS itself declares it, not the size of `hex`) so the
// device accepts a small targeted write without a full blind rewrite.
router.post(
  '/bus/write-memory',
  busRoute(
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
    'Memory write failed',
    async (b, body) => {
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
            {
              type: 'WriteRelMem',
              objIdx,
              propId: 0,
              size: data.length,
              offset: 0,
            },
          ]
        : [
            {
              type: 'WriteRelMem',
              objIdx,
              propId: 0,
              size: data.length,
              offset: 0,
            },
          ];
      const result = await b.downloadDevice(
        deviceAddress,
        steps,
        null,
        null,
        data,
        undefined,
        {
          resolvedBases: { [objIdx]: address },
        },
      );
      return {
        deviceAddress,
        address,
        hex,
        byteCount: data.length,
        loadSequence: !!relSegment,
        unconfirmedWrites: result.unconfirmedWrites,
        unconfirmedDetails: result.unconfirmedDetails,
      };
    },
  ),
);

// Replay a literal sequence of raw cEMI frames verbatim - no APDU
// reconstruction, no automatic Connect/Disconnect. Debug-only, writes to
// real hardware. Caller supplies frames (including any Connect/Disconnect
// control frames) as an ordered array of hex strings.
router.post(
  '/bus/replay-frames',
  busRoute(
    z.object({
      deviceAddress: z.string().min(1),
      frames: z
        .array(z.string().regex(/^[0-9a-fA-F]+$/))
        .min(1)
        .max(500),
      delayMs: z.number().int().min(0).max(5000).default(30),
    }),
    'Frame replay failed',
    async (b, body) => {
      const { deviceAddress, frames, delayMs } = body;
      const buffers = frames.map((h) => Buffer.from(h, 'hex'));
      await b.replayFrames(deviceAddress, buffers, delayMs);
      return { deviceAddress, frameCount: buffers.length };
    },
  ),
);

// Read an arbitrary interface-object property. Read-only debug helper for
// checking PID_TABLE_REFERENCE (PID 7) base resolution on any objIdx, the
// same way resolveRelmemBases() does for WriteRelMem. Not used by the
// download/verify pipeline itself.
router.post(
  '/bus/read-property',
  busRoute(
    z.object({
      deviceAddress: z.string().min(1),
      objIdx: z.number().int().min(0).max(255),
      propId: z.number().int().min(0).max(255),
    }),
    'Property read failed',
    async (b, body) => {
      const { deviceAddress, objIdx, propId } = body;
      const [data] = await b.readPropertyMany(deviceAddress, [
        { objIdx, propId },
      ]);
      return {
        deviceAddress,
        objIdx,
        propId,
        hex: (data ?? Buffer.alloc(0)).toString('hex'),
      };
    },
  ),
);

// ── KNX Programming ───────────────────────────────────────────────────────────

// Write individual address (device must be in programming mode)
router.post(
  '/bus/program-ia',
  busRoute(
    z.object({ newAddr: z.string().min(1) }),
    'Program IA failed',
    async (b, body) => {
      const { newAddr } = body;
      const result = await b.programIA(newAddr);
      return result;
    },
  ),
);

// Direct A_Restart against an already-addressed device, no write involved -
// diagnostic tool for testing Restart in isolation from the write path.
router.post(
  '/bus/restart-device',
  busRoute(
    z.object({
      deviceAddress: z.string().min(1),
      settleMs: z.number().int().min(0).max(10000).optional(),
      postRestartDelayMs: z.number().int().min(0).max(10000).optional(),
    }),
    'Restart device failed',
    async (b, body) => {
      await b.restartDevice(
        body.deviceAddress,
        body.settleMs,
        body.postRestartDelayMs,
      );
      return { ok: true };
    },
  ),
);

// Detect a device in physical programming mode (button held down) -
// broadcasts A_IndividualAddress_Read and reports whether/what answered.
// Read-side counterpart to /bus/program-ia; a different mechanism from
// /bus/assign-address-by-serial below.
router.post(
  '/bus/check-programming-mode',
  busRoute(
    z.object({ timeoutMs: z.number().int().min(100).max(30000).optional() }),
    'Check programming mode failed',
    async (b, body) => {
      const result = await b.checkProgrammingMode(body.timeoutMs);
      return result;
    },
  ),
);

// NM_Read_SerialNumber_By_ProgrammingMode: query the serial number of
// whichever device(s) are in physical programming mode, no prior address
// needed. Unlike /bus/check-programming-mode, collects every reply within
// the timeout window instead of stopping at the first - matters for blank
// devices, whose factory-default addresses collide but whose serials don't.
router.post(
  '/bus/read-serials-in-programming-mode',
  busRoute(
    z.object({ timeoutMs: z.number().int().min(100).max(30000).optional() }),
    'Read serials in programming mode failed',
    async (b, body) => {
      const devices = await b.readSerialNumbersInProgrammingMode(
        body.timeoutMs,
      );
      return { devices };
    },
  ),
);

// Assign an individual address via the device's serial number
// (A_IndividualAddressSerialNumber_Write/_Read, spec 3/5/2 §2.5/§2.4) -
// unlike /bus/program-ia, needs no programming-button press or
// programming-mode precondition.
router.post(
  '/bus/assign-address-by-serial',
  busRoute(
    z.object({
      serial: z
        .string()
        .regex(/^[0-9a-fA-F]{12}$/, 'serial must be 12 hex chars (6 bytes)'),
      newAddress: z.string().min(1),
    }),
    'Assign address by serial failed',
    async (b, body) => {
      const { serial, newAddress } = body;
      const result = await b.assignIndividualAddressBySerial(
        Buffer.from(serial, 'hex'),
        newAddress,
      );
      return result;
    },
  ),
);

// Read-only counterpart to /bus/assign-address-by-serial - ask by serial
// for the device's current address, no guess or programming-mode button
// press needed. Same mechanism ETS's own Factory Reset uses to verify.
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
      res.status(msg.includes('Not connected') ? 409 : 502).json({
        error: safeErrorOrConnection('bus', 'Read address by serial failed', e),
      });
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
  // Per-instance module-argument values ("{appId}_MD-x_M-y" ->
  // {argName: value}) and Argument id -> name map. See
  // resolveModuleParamMemLayout.ts. Optional: absent on older cached app
  // models, in which case expandParamMemLayoutForActiveModules() no-ops.
  modArgs?: Record<string, Record<string, string | number>>;
  argDefs?: Record<string, string>;
  // ParamModel.baseValueArgIds (ets-app.ts).
  baseValueArgIds?: Record<string, string>;
  /**
   * ParamModel.paramRefValues - declared value of every ParameterRef,
   * needed to evaluate <choose> elements controlled by a parameter with
   * no memory/UI presence.
   */
  paramRefValues?: Record<string, string>;
  absSegData?: Record<number, { size: number; hex?: string | null }>;
  // Object 3 (Group Object Table) buffer size - see ParamModel.groupObjectTableSize (ets-app.ts).
  groupObjectTableSize?: number;
  // 🔴 SPECULATIVE - see ParamModel.isSecureEnabled (ets-app.ts).
  isSecureEnabled?: boolean;
  // See ParamModel.peiType (ets-app.ts).
  peiType?: string;
  lineCoupler0912NewProgrammingStyle?: boolean;
  // 🟡 See ParamModel.supportsExtendedMemoryServices (ets-app.ts).
  supportsExtendedMemoryServices?: boolean;
  parameterByteOrder?: 'LittleEndian' | 'BigEndian';
  // Connection-free pre-flight capacity check; the Association table also
  // gets an authoritative live-device check (knx-connection.ts,
  // PropertyDescription_Read ObjIdx=2 PropId=23).
  gaTableMaxEntries?: number;
  assocTableMaxEntries?: number;
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
      /**
       * One parameter buffer per declared AbsoluteSegment, when the app
       * model records which segment each parameter belongs to. Null for
       * RelSegment devices and for models cached before segments were
       * tracked, where `paramMem`/`paramBase` remain the single buffer.
       */
      paramMemBySegment: Map<number, Buffer> | null;
      absSegData: Record<number, { size: number; hex?: string | null }>;
      appId: string;
      paramMemLayout: Record<string, unknown>;
      params: Record<string, unknown> | null;
      /**
       * The parameters buildParamMem() actually wrote into paramMem. Every
       * other entry in paramMemLayout kept the segment's fill, so there is
       * no expectation to compare a device against for those - see
       * paramMemWritesParam() (routes/knx-tables.ts). `null` when there is
       * no parameter segment at all.
       */
      writtenParamKeys: Set<string> | null;
      isSecureEnabled?: boolean;
      peiType?: string;
      lineCoupler0912NewProgrammingStyle?: boolean;
      supportsExtendedMemoryServices?: boolean;
      parameterByteOrder?: 'LittleEndian' | 'BigEndian';
      // Device's cached `LastUsedAPDULength` (`Device.apdu_length`); null
      // if never downloaded to from this project.
      cachedMaxApduLength: number | null;
      // Project this device belongs to; knx-mask-procedures.ts uses it to
      // find the project's saved knx_master.xml for mask-Procedure
      // ordering. Same value as `dev.project_id`.
      projectId: number | null;
    }
  | { ok: false; status: number; body: Record<string, unknown> };

/** A response a route body decided on but has not sent: `status` and the
 * JSON `body` to send with it. Lets the long programming/verify operations
 * be called and asserted on directly, instead of only through HTTP. */
interface RouteResult {
  status: number;
  body: unknown;
}

type ProgrammableDevice =
  | { ok: true; dev: Device }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Look up the device a programming request names, and refuse the ones that
 * must never be written to. Shared by /bus/program-device and
 * /bus/verify-device.
 *
 * The `deviceId` lookup is scoped by `projectId` when present, so a device
 * id belonging to another project reads as not found rather than being
 * programmed against the named project.
 */
export function loadProgrammableDevice(body: {
  deviceAddress: string;
  projectId?: number;
  deviceId?: number;
}): ProgrammableDevice {
  const { deviceAddress, projectId, deviceId } = body;
  const dev = deviceId
    ? projectId
      ? db.get<Device>('SELECT * FROM devices WHERE id=? AND project_id=?', [
          +deviceId,
          +projectId,
        ])
      : db.get<Device>('SELECT * FROM devices WHERE id=?', [+deviceId])
    : db.get<Device>(
        'SELECT * FROM devices WHERE individual_address=? AND project_id=?',
        [deviceAddress, +(projectId ?? 0)],
      );
  if (!dev)
    return { ok: false, status: 404, body: { error: 'Device not found' } };
  // A device imported with no real address (see ets-parser.ts) carries a
  // synthetic individual_address (device number >= 256) purely to have a
  // stable DB key - never a real, writable KNX address. Refuse to program
  // it rather than encoding an out-of-range device number onto the wire,
  // where it could silently wrap into a real device's actual address.
  if (!dev.has_address) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'device_unaddressed',
        message:
          'This device has no individual address assigned yet - use "Address New Device" to give it a real one first.',
      },
    };
  }
  return { ok: true, dev };
}

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

  // Parsed here, before expanding paramMemLayout, since that expansion needs
  // it to resolve which module instances are active on this device - see
  // resolveModuleParamMemLayout.ts.
  let currentValues: Record<string, unknown> = {};
  try {
    currentValues = JSON.parse(dev.param_values || '{}') as Record<
      string,
      unknown
    >;
  } catch (_) {}
  // Expands module-architecture parameters into one correctly-offset entry
  // per active module instance - a no-op for non-module-architecture apps
  // and for app models cached before this existed.
  const expandedParamMemLayout = model.paramMemLayout
    ? expandParamMemLayoutForActiveModules(
        model.paramMemLayout as Record<string, ModuleAwareParamMemLayoutEntry>,
        model.baseValueArgIds ?? {},
        model.argDefs ?? {},
        model.modArgs ?? {},
        model.dynTree as Parameters<
          typeof expandParamMemLayoutForActiveModules
        >[4],
        (model.params ?? {}) as Record<string, ParamDef>,
        currentValues,
      )
    : model.paramMemLayout;
  // Everything below reads paramMemLayout via this expanded view; every
  // other field is still read from `model` itself.
  const modelForParams: DeviceModel = {
    ...model,
    paramMemLayout: expandedParamMemLayout,
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

  // Capacity check against the app program's declared
  // `<AddressTable MaxEntries="...">`/`<AssociationTable MaxEntries="...">`.
  // Entry counts read from each table's own leading 2-byte count field, so
  // this can't drift from what's actually written. `undefined` means not
  // declared - skipped, never treated as "no limit".
  //
  // Connection-free first pass only: the Association table also gets a
  // live, device-reported check inside `downloadDevice()`
  // (`PropertyDescription_Read(ObjIdx=2, PropId=23)`), which wins on
  // disagreement. No equivalent live check exists for the GA table.
  if (model.gaTableMaxEntries != null && gaTable.length >= 2) {
    const realGaEntries = gaTable.readUInt16BE(0);
    if (realGaEntries > model.gaTableMaxEntries) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'ga_table_capacity_exceeded',
          message:
            `This device's real GA table would need ${realGaEntries} entries, but its own application ` +
            `program declares a maximum of ${model.gaTableMaxEntries}. Refusing to write beyond the ` +
            `device's own declared capacity.`,
        },
      };
    }
  }
  if (model.assocTableMaxEntries != null && assocTable.length >= 2) {
    const realAssocEntries = assocTable.readUInt16BE(0);
    if (realAssocEntries > model.assocTableMaxEntries) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'assoc_table_capacity_exceeded',
          message:
            `This device's real Association table would need ${realAssocEntries} entries, but its own ` +
            `application program declares a maximum of ${model.assocTableMaxEntries}. Refusing to write ` +
            `beyond the device's own declared capacity.`,
        },
      };
    }
  }

  // Object 3 (Group Object Table). `size` comes from the app model, not
  // coRows - it's the app's total static declaration range (ETS
  // pre-allocates space for every com object the app could ever expose),
  // not this device's linked/active subset. null when the app model has no
  // groupObjectTableSize - downloadDevice() treats that as nothing to write.
  let groupObjectTable: Buffer | null = null;
  if (model.groupObjectTableSize && model.groupObjectTableSize > 0) {
    const groupObjects: GroupObjectFlags[] = coRows.map((co) => ({
      object_number: co.object_number,
      // Uses the dedicated raw `upd` column (like the other flags), not
      // the composite `flags` string - the latter has a lossy all-false
      // fallback ('CW') that can't be parsed back reliably.
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
      // Companion size-code byte - see groupObjectSizeCode() (knx-tables.ts).
      objectSize: co.object_size,
    }));
    groupObjectTable = buildGroupObjectTable(
      model.groupObjectTableSize,
      groupObjects,
    );
  }

  // Parameter memory: build from param layout + current values, using
  // `modelForParams` (paramMemLayout expanded for active module instances)
  // wherever `model.paramMemLayout` would otherwise be read directly.
  const { paramSize, paramFill, relSegHex, paramBase } = resolveParamSegment(
    modelForParams as Parameters<typeof resolveParamSegment>[0],
  );
  let paramMem: Buffer | null = null;
  let paramMemBySegment: Map<number, Buffer> | null = null;
  let writtenParams: Set<string> | null = null;
  if (paramSize > 0 && modelForParams.paramMemLayout) {
    const bySegment = buildParamMemBySegment(
      modelForParams as Parameters<typeof buildParamMemBySegment>[0],
      currentValues,
      modelForParams.dynTree as Parameters<typeof buildParamMemBySegment>[2],
      modelForParams.params as Parameters<typeof buildParamMemBySegment>[3],
      modelForParams.paramRefValues,
    );
    // `paramMem` is the single buffer the RelSegment write path,
    // planVerify's relmem branch, and pickSourceBuffer's paramBase
    // fallback use. When the app declares segments, it must be one of
    // them, not a flattening of all of them.
    const forBase = paramBase != null ? bySegment.get(paramBase) : undefined;
    if (bySegment.size) paramMemBySegment = bySegment;
    paramMem =
      forBase ??
      buildParamMem(
        paramSize,
        modelForParams.paramMemLayout as Parameters<typeof buildParamMem>[1],
        currentValues,
        paramFill,
        relSegHex,
        modelForParams.dynTree as Parameters<typeof buildParamMem>[5],
        modelForParams.params as Parameters<typeof buildParamMem>[6],
        modelForParams.paramRefValues as Parameters<typeof buildParamMem>[7],
        modelForParams.parameterByteOrder,
      );
    writtenParams = writtenParamKeys(
      modelForParams.paramMemLayout as Parameters<typeof writtenParamKeys>[0],
      currentValues,
      modelForParams.dynTree as Parameters<typeof writtenParamKeys>[2],
      modelForParams.params as Parameters<typeof writtenParamKeys>[3],
      modelForParams.paramRefValues as Parameters<typeof writtenParamKeys>[4],
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
    paramMemBySegment,
    absSegData: model.absSegData ?? {},
    appId: model.appId ?? dev.app_ref,
    paramMemLayout: modelForParams.paramMemLayout ?? {},
    params: model.params ?? null,
    writtenParamKeys: writtenParams,
    isSecureEnabled: model.isSecureEnabled,
    peiType: model.peiType,
    lineCoupler0912NewProgrammingStyle:
      model.lineCoupler0912NewProgrammingStyle,
    supportsExtendedMemoryServices: model.supportsExtendedMemoryServices,
    parameterByteOrder: model.parameterByteOrder,
    // Parses `dev.apdu_length` (cached `LastUsedAPDULength`); empty,
    // non-numeric, or non-positive all fall through to `null`, deferring
    // to the live property-56 read rather than guessing a number.
    cachedMaxApduLength:
      dev.apdu_length && /^\d+$/.test(dev.apdu_length)
        ? parseInt(dev.apdu_length, 10) || null
        : null,
    projectId: dev.project_id ?? null,
  };
}

// Test-only export alias (matches _apduPropertyValueWrite in knx-cemi.ts) -
// lets a script compute a device's download artifacts (including Object 3)
// against a real imported project without a live bus connection or the
// /bus/program-device route.
export const _buildDeviceProgramming = buildDeviceProgramming;

// Resolves a device's device_pending_changes rows (routes/shared.ts) into
// the byte ranges DownloadExtra.pendingWriteRanges expects. Does not read
// the device or diff anything - each key is mapped to an offset using the
// same layout logic that builds the target image.
//
// - 'param_value': resolved via paramMemLayout, the same map buildParamMem()
//   uses. A key absent from the map, or with `offset: null`, is a no-op.
// - 'ga_link': entry positions in the GA/Association tables (objIdx 1/2)
//   can shift entirely when one link changes, so this marks both tables'
//   full length dirty. Also marks the affected object's Object 3 byte
//   dirty (bit 2 depends on link presence), same as 'group_object_flag'.
// - 'group_object_flag': resolved via the same `object_number * 2` formula
//   computeGroupObjectByte()/buildGroupObjectTable() use.
//
// ETS always includes the parameter object's own final byte in any partial
// write to that object, so this adds it too whenever objIdx 4 already has
// a pending write. `paramSize` is optional.
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
      const layout = (paramMemLayout as Record<string, ParamMemEntry>)[row.key];
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

// Full (or partial) application download for a device. mode defaults to
// 'full'; mode='partial' is best-effort (see DownloadExtra.mode in
// knx-connection.ts).
/**
 * The real body of `/bus/program-device` - address pre-flight, the
 * download, and DB/broadcast bookkeeping. Extracted from the route so the
 * operation can be called and asserted on directly: returns the status and
 * body to send, or null when the client disconnected mid-operation
 * (Cancel).
 *
 * `isAborted` is checked at each point the operation could return early;
 * the route feeds it from res.on('close'), not req.on('close') (see the
 * route's own comment on why).
 */
export async function runProgramDevice(
  b: KnxBusManager,
  dev: Device,
  body: {
    deviceAddress: string;
    projectId?: number;
    deviceId?: number;
    mode: 'full' | 'partial';
    addressMethod?: 'button' | 'serial';
  },
  isAborted: () => boolean,
  /**
   * How long to keep asking a device to answer after its address was
   * written, before giving up with address_write_unconfirmed. 35s covers a
   * device's post-address-write reboot; tests pass a smaller value.
   */
  opts: { confirmDeadlineMs?: number } = {},
): Promise<RouteResult | null> {
  const { deviceAddress, mode, addressMethod } = body;

  const built = buildDeviceProgramming(dev);
  if (!built.ok) return { status: built.status, body: built.body };
  const {
    steps,
    gaTable,
    assocTable,
    groupObjectTable,
    paramMem,
    paramBase,
    paramMemBySegment,
    absSegData,
    appId,
    isSecureEnabled,
    peiType,
    lineCoupler0912NewProgrammingStyle,
    supportsExtendedMemoryServices,
    cachedMaxApduLength,
    projectId,
  } = built;

  // An app declaring real PEI program content (PeiType != "0") is
  // unsupported - refuse before touching the bus. downloadDevice() repeats
  // this check for other callers. An app with no declared PeiType is
  // treated as "0".
  const effectivePeiType = peiType ?? '0';
  if (effectivePeiType !== '0') {
    return {
      status: 409,
      body: {
        error: 'untested_pei_type',
        message:
          `This device's application declares PEI program content (PeiType=${effectivePeiType}). ` +
          `Only applications with PeiType="0" have been validated, so the download was refused.`,
        peiType: effectivePeiType,
      },
    };
  }

  // Edit log -> write ranges - only meaningful in 'partial' mode (full
  // mode always writes everything regardless of what changed). The `-1`
  // sentinel length from resolvePendingWriteRanges() (GA/Association
  // tables have no stable per-key offset) gets expanded here to each
  // table's already-built length.
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

  // Device-resident relmem bases (PID 7) aren't pre-resolved here -
  // downloadDevice() resolves each interface object's base AFTER that
  // object's own Unload/StartLoading/LoadData cycle, matching ETS. An
  // upfront PID-7 check would wrongly reject a device's first-ever
  // download, where PID 7 legitimately starts at 0 and only becomes valid
  // once the load cycle runs; ETS itself never pre-checks it either.

  // Stream progress via WebSocket
  const onProgress = (p: DownloadProgress): void =>
    b.broadcast('program:progress', { deviceAddress, ...p });
  onProgress({ msg: `Starting download to ${deviceAddress}`, pct: 0 });

  // One connection held across a whole multi-device session, opened fresh
  // only when none exists (matches ETS) - forcing a reconnect per device
  // would repeat the handshake and routers react badly to rapid reconnects.
  // Explicit try/catch since Express doesn't catch an async handler's
  // rejection on its own.
  try {
    if (!b.connected) {
      await b.forceReconnect();
      await delay(500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: msg.includes('Not connected') ? 409 : 502,
      body: {
        error: safeErrorOrConnection(
          'bus',
          'Failed to reconnect before programming',
          e,
        ),
      },
    };
  }

  // Hold a keep-alive ref for the duration, protecting any pause between
  // steps against an unexpected drop. See KnxBusManager.addKeepAliveRef().
  // Also covers the address pre-flight below, which can run up to 30s
  // waiting on a programming-button press.
  const releaseKeepAlive = b.addKeepAliveRef();
  try {
    // `deviceAddress` may only exist as a project/DB record with no write
    // ever sent to the physical device. Mirrors ETS's own Full Download
    // procedure: if a serial is on record, confirm the device actually
    // answering at deviceAddress carries it before doing anything else. If
    // not, a physical programming-button press is needed to (re)address the
    // device first - the same detect-before-write gate as
    // AddressDeviceModal.tsx client-side. Uses both broadcast mechanisms
    // (serial scan + legacy address broadcast) and refuses if zero or more
    // than one device answers.
    let addressConfirmed = false;
    // The serial of the device this session actually found at the address
    // (confirmed by a read, or captured while addressing it). Used to decide
    // whether this physical unit has been downloaded to before.
    let sessionSerial: string | undefined;
    if (dev.serial_number) {
      try {
        const info = await b.readDeviceInfo(deviceAddress);
        if (
          info.serialNumber &&
          info.serialNumber.toLowerCase() === dev.serial_number.toLowerCase()
        ) {
          addressConfirmed = true;
          sessionSerial = info.serialNumber;
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

    // Shared by both re-addressing paths: a device can take up to ~20s to
    // come back up after an address write, even after
    // programIA()/assignIndividualAddressBySerial()'s own post-Restart
    // settle wait. Deadline-based, not a fixed attempt count, so retry
    // spacing stays 2s regardless of budget.
    const waitForDeviceBackUp = async (): Promise<{
      serialNumber?: string;
    } | null> => {
      onProgress({ msg: `Confirming device at ${deviceAddress}…` });
      const confirmStart = Date.now();
      const confirmDeadlineMs = scaledMs(opts.confirmDeadlineMs ?? 35000);
      let confirmedInfo: { serialNumber?: string } | null = null;
      let attempt = 0;
      let lastHeartbeatMs = 0;
      while (
        !confirmedInfo &&
        Date.now() - confirmStart < confirmDeadlineMs &&
        !isAborted()
      ) {
        attempt++;
        if (attempt > 1) await delay(Math.min(2000, confirmDeadlineMs));
        const elapsedMs = Date.now() - confirmStart;
        // Heartbeat every ~5s so a long wait doesn't read as stuck.
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
      // A serial on record can also relocate/readdress the device directly
      // via A_IndividualAddressSerialNumber_Write/_Read, no button press
      // needed. Real ETS offers this as an operator choice; so does this
      // route, unless 'auto_address_by_serial' (server/routes/settings.ts)
      // says to do it automatically. `addressMethod` carries the choice
      // once made (the client's follow-up request after the prompt below).
      const canUseSerial = !!dev.serial_number;
      // Guards a client sending addressMethod:'serial' with no serial on
      // record; falls through to the button-press flow instead of
      // crashing on a null serial.
      let useSerial = addressMethod === 'serial' && canUseSerial;
      if (addressMethod === undefined && canUseSerial) {
        const autoSetting = db.get<{ value: string }>(
          "SELECT value FROM settings WHERE key='auto_address_by_serial'",
        );
        if (autoSetting?.value === 'true') {
          useSerial = true;
        } else {
          return {
            status: 409,
            body: {
              error: 'address_needs_confirmation',
              message: `Device not found at ${deviceAddress} with a matching serial - choose how to locate/address it.`,
              canUseSerial: true,
            },
          };
        }
      }

      if (useSerial) {
        onProgress({
          msg: `Locating device by serial ${dev.serial_number}…`,
        });
        let bySerial;
        try {
          bySerial = await retryOnConnectivityIssue(
            () =>
              b.assignIndividualAddressBySerial(
                Buffer.from(dev.serial_number!, 'hex'),
                deviceAddress,
              ),
            { deviceAddress, label: 'Locate device by serial', onProgress },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            status: msg.includes('Not connected') ? 409 : 502,
            body: {
              error: safeErrorOrConnection(
                'bus',
                'Locate device by serial failed',
                e,
              ),
            },
          };
        }
        if (!bySerial.verified) {
          return {
            status: 409,
            body: {
              error: 'serial_address_failed',
              message: `No device with serial ${dev.serial_number} answered, or the address write to ${deviceAddress} could not be verified. Try Press Programming Button instead.`,
            },
          };
        }
        // The write is verified (assignIndividualAddressBySerial's own
        // read-back), but the device still restarts, so wait for it to
        // come back up, same as the button-press path.
        const confirmedInfo = await waitForDeviceBackUp();
        if (isAborted()) return null;
        if (!confirmedInfo) {
          return {
            status: 502,
            body: {
              error: 'address_write_unconfirmed',
              message: `Address ${deviceAddress} was written by serial, but the device did not answer afterward - the write could not be confirmed, so the rest of the download was not attempted.`,
            },
          };
        }
        onProgress({
          msg: `Confirmed device at ${deviceAddress} via serial - continuing with the rest of the download`,
        });
        addressConfirmed = true;
        sessionSerial = confirmedInfo.serialNumber ?? dev.serial_number;
      }
    }
    if (!addressConfirmed) {
      // `awaitingButton: true` is the client's cue to show a dedicated
      // modal (Cancel-only, auto-dismisses once the wait resolves either
      // way) rather than just updating the button's own inline text.
      onProgress({
        msg: 'Press the programming button on the device now…',
        awaitingButton: true,
      });
      const roundMs = 3000;
      const deadline = Date.now() + scaledMs(30000);
      const bySrc = new Map<string, string>(); // src -> serial ('' if unknown)
      while (bySrc.size === 0 && Date.now() < deadline && !isAborted()) {
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
      // The client already disconnected (Cancel) - there is nobody left to
      // answer, so return null rather than a response the route would try
      // to write to a destroyed socket.
      if (isAborted()) return null;
      if (bySrc.size === 0) {
        return {
          status: 409,
          body: {
            error: 'no_device_in_programming_mode',
            message:
              'No device answered the programming-mode scan - press and release the programming button on the target device, then try again.',
          },
        };
      }
      if (bySrc.size > 1) {
        const ids = [...bySrc.entries()]
          .map(([addr, serial]) => (serial ? `${serial} @ ${addr}` : addr))
          .join(', ');
        return {
          status: 409,
          body: {
            error: 'ambiguous_programming_mode',
            message: `${bySrc.size} devices are in programming mode at once (${ids}) - this write would be ambiguous. Press the button on only the one device you mean to program, then try again.`,
          },
        };
      }
      // This message (no awaitingButton flag) is the client's cue to
      // dismiss the modal - a real device was found, the wait is over.
      const [foundAddr, foundSerial] = [...bySrc.entries()][0]!;
      onProgress({
        msg: `Identified device ${foundSerial || foundAddr} in programming mode - writing address ${deviceAddress}…`,
      });
      // programIA() already restarts the device internally
      // (KnxConnection.restartDevice(), with its own ~3s post-Restart
      // settle wait); waitForDeviceBackUp() above is on top of that.
      await b.programIA(deviceAddress);
      const confirmedInfo = await waitForDeviceBackUp();
      if (isAborted()) return null;
      if (!confirmedInfo) {
        return {
          status: 502,
          body: {
            error: 'address_write_unconfirmed',
            message: `Address ${deviceAddress} was written, but the device did not answer afterward - the write could not be confirmed, so the rest of the download was not attempted.`,
          },
        };
      }
      if (confirmedInfo.serialNumber) {
        sessionSerial = confirmedInfo.serialNumber;
        db.run('UPDATE devices SET serial_number=?, has_address=1 WHERE id=?', [
          confirmedInfo.serialNumber,
          dev.id,
        ]);
        onProgress({
          msg: `Confirmed device at ${deviceAddress}, serial ${confirmedInfo.serialNumber} - rebooted, continuing with the rest of the download`,
        });
      } else {
        onProgress({
          msg: `Device answered at ${deviceAddress} but reported no serial - continuing anyway`,
        });
      }
    }
    if (isAborted()) return null;

    const downloadResult = await b.downloadDevice(
      deviceAddress,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
      {
        paramBase,
        paramMemBySegment,
        absSegData,
        appId,
        mode,
        groupObjectTable,
        isSecureEnabled,
        supportsExtendedMemoryServices,
        cachedMaxApduLength,
        pendingWriteRanges,
        projectId,
        lineCoupler0912NewProgrammingStyle,
        shouldAbort: isAborted,
        peiType: effectivePeiType,
        // This unit counts as previously downloaded to only when a download
        // is on record AND it went to the very unit found at the address this
        // session (a replacement unit has a different serial).
        hasPriorDownloadHistory:
          !!dev.last_download &&
          !!dev.last_download_serial &&
          !!sessionSerial &&
          dev.last_download_serial.toLowerCase() ===
            sessionSerial.toLowerCase(),
      },
    );
    // Cancelled mid-write: the device keeps whatever objects had fully
    // loaded and is otherwise untouched - neither "matches the project" nor
    // a failure, so status is left alone for a fresh Download/Verify to
    // resolve. The client has already disconnected.
    if (downloadResult.aborted) return null;
    // Verify requires both address and serial on record; a plain
    // Program/Full-Download never captured the serial (only the addressing
    // flow's read-back did), so read it back here best-effort - failure is
    // logged but doesn't fail the already-succeeded download. One retry
    // with a settle delay, since the device may not yet accept a fresh
    // connection right after its own download session closes.
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
    const unconfirmedWritesDetail = JSON.stringify(
      downloadResult.unconfirmedDetails,
    );
    // last_verify_match/last_verify_at cleared back to NULL here too - a
    // verify result describes content that this download just replaced,
    // so verify status can't be trusted regardless of whether this
    // download's own writes were all confirmed.
    if (serialNumber) {
      db.run(
        'UPDATE devices SET status=?, last_download=?, last_download_serial=?, serial_number=?, unconfirmed_writes_count=?, unconfirmed_writes_detail=?, last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
        [
          'programmed',
          new Date().toISOString(),
          serialNumber,
          serialNumber,
          unconfirmedWritesCount,
          unconfirmedWritesDetail,
          dev.id,
        ],
      );
    } else {
      db.run(
        'UPDATE devices SET status=?, last_download=?, last_download_serial=?, unconfirmed_writes_count=?, unconfirmed_writes_detail=?, last_verify_match=NULL, last_verify_at=NULL WHERE id=?',
        [
          'programmed',
          new Date().toISOString(),
          sessionSerial ?? '',
          unconfirmedWritesCount,
          unconfirmedWritesDetail,
          dev.id,
        ],
      );
    }
    // downloadDevice() completed without throwing, so whatever was pending
    // has now been written - cleared unconditionally, not gated on mode.
    clearPendingChanges(dev.id);
    db.scheduleSave();
    // Completing without throwing means the protocol sequence ran to
    // completion, not that every write was confirmed - a device may not
    // answer an individual write. `status` is still 'programmed' (the
    // device did receive the attempt); the client uses `unconfirmedWrites`
    // to show "completed with N unconfirmed writes" instead of plain success.
    return {
      status: 200,
      body: {
        ok: true,
        deviceAddress,
        mode,
        serialNumber,
        totalBytes,
        unconfirmedWrites: downloadResult.unconfirmedWrites,
        unconfirmedDetails: downloadResult.unconfirmedDetails,
      },
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    b.broadcast('program:progress', {
      deviceAddress,
      msg: `Error: ${errMsg}`,
      pct: -1,
      error: true,
    });
    return {
      status: errMsg.includes('Not connected') ? 409 : 502,
      body: {
        error: safeErrorOrConnection('bus', 'Device programming failed', e),
      },
    };
  } finally {
    releaseKeepAlive();
  }
}

router.post('/bus/program-device', async (req: Request, res: Response) => {
  const b = requireBus(res);
  if (!b) return;
  // runProgramDevice's address pre-flight can wait up to 30s for a
  // physical button press, checked at each polling round so Cancel stops
  // the wait promptly.
  //
  // req.on('close') is NOT a reliable disconnect signal in Express - it
  // can fire once the request body is fully read, well before a response
  // is sent, while the client is still waiting. res.on('close'), gated on
  // res.writableEnded, is correct: it fires when the connection actually
  // closes, and writableEnded distinguishes a normal response finish from
  // a genuine client disconnect.
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
      // How to locate/(re)address the device when it doesn't answer at
      // `deviceAddress` and a serial is on record - see the
      // 'address_needs_confirmation' response in runProgramDevice.
      // Omitted on a fresh request; set on the client's follow-up call once
      // the user (or 'auto_address_by_serial') has decided.
      addressMethod: z.enum(['button', 'serial']).optional(),
    }),
  );

  const loaded = loadProgrammableDevice(body);
  if (!loaded.ok) return res.status(loaded.status).json(loaded.body);

  const result = await runProgramDevice(b, loaded.dev, body, () => aborted);
  // null means the client disconnected mid-operation - nobody to answer.
  if (result) res.status(result.status).json(result.body);
});

// Read-only verification: compute the parameter-memory image for a device and
// compare it against what the device actually has, reading over the bus.
// Writes nothing — safe to run against a live installation.
// A device is transiently unresponsive for a few seconds right after a
// hardware Restart, surfacing as "Tunneling ACK timeout". Retry once rather
// than fail immediately. Scoped to this one specific error message - not a
// general retry-on-any-bus-error policy (a real ACK *error* response is a
// genuine protocol-level NAK, not a timeout, and isn't retried here).
const VERIFY_TRANSIENT_RETRY_DELAY_MS = 4000;

// An error message that looks like a transient connectivity blip (router
// dropped the tunnel, reconnect timed out) rather than a real protocol or
// device failure.
const CONNECTIVITY_ERROR_PATTERN =
  /not connected|connect timeout|econnreset|econnrefused|etimedout|epipe/i;

/** Retries `op` (default 3 attempts, 2s apart) but ONLY for an error that
 *  looks like a transient connectivity blip; any other error is thrown at
 *  once, unchanged. Every retry is logged and reported through `onProgress`. */
async function retryOnConnectivityIssue<T>(
  op: () => Promise<T>,
  opts: {
    deviceAddress: string;
    label: string;
    onProgress: (p: DownloadProgress) => void;
    maxAttempts?: number;
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (
        !CONNECTIVITY_ERROR_PATTERN.test(err.message) ||
        attempt >= maxAttempts
      )
        throw err;
      logger.warn('knx', `${opts.label}: connectivity issue, retrying`, {
        deviceAddr: opts.deviceAddress,
        attempt,
        maxAttempts,
        error: err.message,
      });
      opts.onProgress({
        msg: `Router connection dropped - retrying ${opts.label.toLowerCase()} (attempt ${attempt + 1} of ${maxAttempts})…`,
      });
      await delay(2000);
    }
  }
}
const VERIFY_TRANSIENT_MAX_ATTEMPTS = 3;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, scaledMs(ms)));
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
  const { deviceAddress } = body;

  const loaded = loadProgrammableDevice(body);
  if (!loaded.ok) return res.status(loaded.status).json(loaded.body);
  const dev = loaded.dev;

  // See /bus/program-device above - connect only when there is no live
  // connection, as per ETS.
  try {
    if (!b.connected) {
      await b.forceReconnect();
      await delay(500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(msg.includes('Not connected') ? 409 : 502).json({
      error: safeErrorOrConnection(
        'bus',
        'Failed to reconnect before verifying',
        e,
      ),
    });
  }

  // See /bus/program-device above - protects the retry loop (including
  // waits between transient-timeout retries) against an idle-timeout drop.
  const releaseKeepAlive = b.addKeepAliveRef();
  try {
    for (let attempt = 1; attempt <= VERIFY_TRANSIENT_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await runVerifyDevice(b, dev, deviceAddress);
        res.status(result.status).json(result.body);
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
        res.status(msg.includes('Not connected') ? 409 : 502).json({
          error: safeErrorOrConnection('bus', 'Device verify failed', e),
        });
        return;
      }
    }
  } finally {
    releaseKeepAlive();
  }
});

/** The real body of `/bus/verify-device` - extracted so the route above can
 * retry it whole on a transient timeout without duplicating this logic.
 * Returns the status and body to send for a successful comparison or an
 * "expected" 4xx; throws for a real bus-communication failure the caller's
 * retry loop should catch. */
export async function runVerifyDevice(
  b: KnxBusManager,
  dev: Device,
  deviceAddress: string,
): Promise<RouteResult> {
  const built = buildDeviceProgramming(dev);
  if (!built.ok) return { status: built.status, body: built.body };
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
    paramMemBySegment,
    writtenParamKeys: writtenParams,
    parameterByteOrder,
  } = built;

  // Derive the read-back plan from the same artifacts the download would use.
  // planVerify covers every device family:
  //   absmem — each AbsSegment memory transfer becomes a memory read/diff;
  //   relmem — each WriteRelMem segment becomes a paramMem read/diff;
  //   prop   — property-configured devices (no image) become property reads.
  //
  // System B relmem segments live at a device-resident base (PID 7), not the
  // step's relative offset - resolve it over the bus and refuse to verify an
  // unallocated segment (a zero base would read the wrong low-memory region).
  //
  // Also resolve the GA/Association/Group Object Table base (objIdx 1/2/3)
  // whenever the app model doesn't declare a step for it but a table exists
  // to compare - ETS verifies/writes these via the same RelSegment mechanism
  // without an explicit declaration (see knx-download-plan.ts's
  // buildUndeclaredTableMem and knx-connection.ts's writeUndeclaredTable()).
  // RelSegment-family apps only (System B masks); AbsSegment and prop-only
  // devices have no such mechanism.
  const isRelSegmentApp = (
    steps as Array<{ type: string; objIdx?: number }>
  ).some((s) => s.type === 'WriteRelMem');
  // Only a genuine WriteRelMem step counts as "already handled" -
  // LoadImageProp is read-only for every objIdx, so a model declaring it
  // never actually writes the GA/Association table content (same fix as
  // downloadDevice() in knx-connection.ts).
  const declaredTableObjIdxs = new Set(
    (steps as Array<{ type: string; objIdx?: number }>)
      .filter((s) => s.type === 'WriteRelMem')
      .map((s) => s.objIdx),
  );
  const extraObjIdxs: number[] = [];
  if (
    isRelSegmentApp &&
    gaTable &&
    gaTable.length &&
    !declaredTableObjIdxs.has(1)
  )
    extraObjIdxs.push(1);
  if (
    isRelSegmentApp &&
    assocTable &&
    assocTable.length &&
    !declaredTableObjIdxs.has(2)
  )
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
    return {
      status: 409,
      body: {
        error: 'segment_unallocated',
        message: `Interface object(s) ${unallocated.join(', ')} report an unallocated segment (PID 7 = 0); device is not in a verifiable state.`,
      },
    };
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
    paramMemBySegment,
  );

  if (plan.family === 'none' || (!plan.mem.length && !plan.props.length)) {
    return {
      status: 400,
      body: {
        error: 'nothing_to_verify',
        message:
          'Device exposes no downloadable memory image or comparable properties to verify.',
      },
    };
  }

  const segments = [];
  const props = [];
  let totalBytes = 0;
  let totalDiffering = 0;
  // Object 3's own raw byte-level totals; set only when this app declares a
  // Group Object Table region to verify, kept separate from
  // totalBytes/totalDiffering above.
  let flagsTotalBytes: number | undefined;
  let flagsDifferingBytes: number | undefined;

  // Read every region/property for this device inside one management
  // session, not a fresh connection per read. Total byte count is known
  // upfront, so real progress can be broadcast as chunks come in.
  const progressTotal = plan.mem.reduce((sum, r) => sum + r.expected.length, 0);
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
  // parameter values - a view on data already fetched, no extra bus reads.
  // relmem-family only; prop-family devices have no memory image to decode.
  type DecodedComparison = Omit<
    ReturnType<typeof decodeParamMem>[number],
    'value'
  > & {
    expectedValue: string;
    actualValue: string | null;
    match: boolean | null;
    // Object 3 rows only - structured flag data for the per-flag chip
    // display. `expectedValue`/`actualValue` (full sentence from
    // describeGroupObjectEntry()) stay the hover-tooltip content;
    // undefined for every other row kind (params, GA links).
    obj3Expected?: GroupObjectEntryFlags;
    obj3Actual?: GroupObjectEntryFlags | null;
    /**
     * Whether the download actually writes this parameter's bytes. Some
     * paramMemLayout entries (an inactive channel alternative, a parameter
     * with no value or default) keep the segment's fill instead - see
     * paramMemWritesParam(); comparing their decode to the device means
     * nothing. Diagnostic only, not a verdict - stays visible and counted.
     * Undefined on GA-link and Object 3 rows.
     */
    written?: boolean;
  };
  let decoded: DecodedComparison[] | undefined;
  // Which of the compared segments is the parameter image.
  //
  // relmem devices read one region and that region IS the parameter image.
  // absmem (MDT-style) devices read several (address table, association
  // table, group-object table, parameters) and only one is decodable;
  // planDownload picks `paramMem` as a segment's source when the segment's
  // address equals `paramBase` (pickSourceBuffer, knx-download-plan.ts).
  //
  // An absmem application may declare more than one parameter-carrying
  // segment, each numbering its offsets from zero, so "the parameter image"
  // is a list: each compared region paired with the parameters that name
  // its address.
  const fullLayout = (paramMemLayout ?? {}) as Parameters<
    typeof decodeParamMem
  >[1];
  const layoutFor = (keys: string[]): Parameters<typeof decodeParamMem>[1] => {
    const sub: Record<string, (typeof fullLayout)[string]> = {};
    for (const k of keys) {
      const e = fullLayout[k];
      if (e) sub[k] = e;
    }
    return sub;
  };

  type DecodePair = {
    segment: (typeof segments)[number];
    layout: Parameters<typeof decodeParamMem>[1];
  };
  const decodePairs: DecodePair[] = [];
  if (plan.family === 'relmem' && segments.length === 1 && segments[0]) {
    // One region, and it IS the parameter image.
    decodePairs.push({ segment: segments[0], layout: fullLayout });
  } else if (plan.family === 'absmem') {
    const declared = resolveParamSegments({
      paramMemLayout,
      absSegData,
    } as Parameters<typeof resolveParamSegments>[0]);
    if (declared.length) {
      for (const d of declared) {
        const seg = segments.find((x) => x.offset === d.address);
        if (seg) decodePairs.push({ segment: seg, layout: layoutFor(d.keys) });
      }
    } else if (paramBase != null) {
      // No segment information in this app model - the single-segment
      // behaviour, unchanged.
      const seg = segments.find((x) => x.offset === paramBase);
      if (seg) decodePairs.push({ segment: seg, layout: fullLayout });
    }
  }

  if (decodePairs.length && Object.keys(fullLayout).length) {
    const defs = paramDefs as Parameters<typeof decodeParamMem>[2];
    const rows: DecodedComparison[] = [];
    for (const { segment: seg, layout } of decodePairs) {
      if (!Object.keys(layout).length) continue;
      const expectedBuf = Buffer.from(seg.expectedHex, 'hex');
      const actualBuf = Buffer.from(seg.actualHex, 'hex');
      const expectedDecoded = decodeParamMem(
        expectedBuf,
        layout,
        defs,
        parameterByteOrder,
      );
      const actualDecoded = decodeParamMem(
        actualBuf,
        layout,
        defs,
        parameterByteOrder,
      );
      const actualByKey = new Map(actualDecoded.map((d) => [d.key, d]));
      for (const { value, ...exp } of expectedDecoded) {
        const act = actualByKey.get(exp.key);
        rows.push({
          ...exp,
          expectedValue: value,
          actualValue: act?.value ?? null,
          match: act ? act.value === value : null,
          written: writtenParams ? writtenParams.has(exp.key) : true,
        });
      }
    }
    if (rows.length) decoded = rows;
  }
  // Verify the GA table / Association table too, when the model didn't
  // already declare (and get read/decoded as) an ordinary WriteRelMem step
  // - see `undeclaredTableMem` in knx-download-plan.ts. Surfaced as one
  // comparison row per communication object, folded into `decoded` rather
  // than `segments`/`totalBytes`. Scoped to gatable@/assoctable@ - Object 3
  // is handled separately below since its size is already known
  // (groupObjectTableSize), unlike GA/Assoc's dynamic count-probe.
  const gaAssocMem = plan.undeclaredTableMem.filter(
    (r) => r.label.startsWith('gatable@') || r.label.startsWith('assoctable@'),
  );
  if (gaAssocMem.length) {
    // The device's real table can be a different size than the project's
    // computed `expected` buffer, so read each table's real 2-byte count
    // field first, then its real full length. Capped at 2000 bytes against
    // a corrupt count field driving an unbounded read.
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
    const assocRegion = gaAssocMem.find((r) =>
      r.label.startsWith('assoctable@'),
    );
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
        ? decodeAssocTable(
            gaAssocActuals[assocIdx] ?? Buffer.alloc(0),
            actualGAs,
          )
        : [];
    // A com object can have more than one GA link (see buildAssocTable) -
    // aggregate every link per com object, then join space-separated like
    // co.ga_address is already stored.
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
    // either side - nothing to compare = not shown.
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
        // Not a parameter - the Access="None" concept doesn't apply, and
        // this GA-link row should count normally either way.
        isVisible: true,
      });
    }
    if (gaRows.length) decoded = [...(decoded ?? []), ...gaRows];
  }

  // Verify Object 3 (Group Object Table) too, when the model didn't already
  // declare it. Unlike GA/Association, its size is already known
  // (`groupObjectTable.length`, from `maxComObjectNumber` in ets-app.ts),
  // so no count-probe read is needed first. One comparison row per
  // communication object, matching the GA rows' convention.
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
    // Object 3's own raw byte-level diff count (`flagsTotalBytes`/
    // `flagsDifferingBytes`), separate from the per-com-object row mismatch
    // count below - one differing flag bit still counts as a whole byte here.
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
    // Write/Read/Comm+Linked), Priority, and Object Size. See
    // describeGroupObjectEntry() (knx-tables.ts).
    const fmtEntry = (
      e: { flagByte: number; sizeCodeByte: number } | null,
    ): string => (e ? describeGroupObjectEntry(e) : '(out of range)');
    for (const co of coRows) {
      const expectedEntry = decodeGroupObjectEntry(
        object3Region.expected,
        co.object_number,
      );
      const actualEntry = decodeGroupObjectEntry(actual, co.object_number);
      // Nothing to show for an object with no real entry on either side.
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
        // expectedEntry is only null if the object falls outside the
        // buffer, which can't happen here; the fallback is defensive.
        obj3Expected: expectedEntry
          ? decodeGroupObjectEntryFlags(expectedEntry)
          : undefined,
        obj3Actual: actualEntry
          ? decodeGroupObjectEntryFlags(actualEntry)
          : null,
        // Not a parameter - the Access="None" concept doesn't apply, and
        // this Object 3 row should count normally either way.
        isVisible: true,
      });
    }
    if (obj3Rows.length) decoded = [...(decoded ?? []), ...obj3Rows];
  }

  // `totalDiffering`/`totalBytes` are scoped to raw memory only (segments) -
  // GA table, Association table, and Object 3 rows are kept out of that
  // scope (see `undeclaredTableMem`'s doc comment in knx-download-plan.ts).
  // `match` therefore requires every decoded row to match too, not just the
  // raw byte scope, or a mismatch there would report a false "everything
  // matches".
  // An Access="None" (isVisible: false) parameter is a download-only value
  // ETS never shows in its own UI, sometimes a device-firmware sentinel
  // that legitimately changes after a Download - see DecodedParam.isVisible.
  // Doesn't count as a real mismatch here.
  const allDecodedMatch =
    !decoded ||
    decoded.every((d) => d.match !== false || d.isVisible === false);
  // `totalDiffering` is a raw byte-level count computed independently of
  // `decoded`, so a hidden parameter's differing byte(s) still show up
  // there even once `allDecodedMatch` excludes it. Subtract that byte
  // length back out before gating `match`, so it doesn't count twice.
  // Whole-byte-aligned only - a sub-byte hidden parameter isn't handled.
  const hiddenMismatchBytes = (decoded ?? [])
    .filter((d) => d.isVisible === false && d.match === false)
    .reduce((sum, d) => sum + Math.ceil(d.bitSize / 8), 0);
  const match =
    Math.max(0, totalDiffering - hiddenMismatchBytes) === 0 && allDecodedMatch;
  // A clean verify clears any "verify recommended" indicator left over
  // from a download with unconfirmed writes.
  if (match) {
    db.run(
      'UPDATE devices SET unconfirmed_writes_count=0, unconfirmed_writes_detail=? WHERE id=?',
      ['[]', dev.id],
    );
  }
  // Persisted verify indicator, written unconditionally (match or
  // mismatch) - a live bus verify just happened either way. Only ever
  // written here (a live bus read), never from the cache-only recompute
  // path below.
  db.run(
    'UPDATE devices SET last_verify_match=?, last_verify_at=? WHERE id=?',
    [match ? 1 : 0, new Date().toISOString(), dev.id],
  );
  db.scheduleSave();
  return {
    status: 200,
    body: {
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
    },
  };
}

// Recomputes a verify comparison's PROJECT/expected side fresh from current
// DB state, reusing the DEVICE/actual side already cached client-side from
// the last real bus read - no bus access at all. A local DB edit only
// changes what's now expected, not what's actually in device memory.
//
// Scope: the raw byte-level `segments` comparison (and derived param
// `decoded` rows) is only recomputed for the relmem/single-segment case -
// other shapes pass the cached segment through unchanged. GA-link and
// Object 3 flag rows are always recomputed when the app model supports them.
// .passthrough() on both schemas: the client's shapes carry extra fields
// this route doesn't touch; stripping them would corrupt rows it doesn't
// recompute.
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

    const dev = db.get<Device>('SELECT * FROM devices WHERE id=?', [deviceId]);
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
      parameterByteOrder,
    } = built;

    let segments: RecomputeSegment[] = cached.segments;
    let totalBytes = 0;
    let totalDiffering = 0;
    let paramRows: RecomputeDecoded[] | null = null;

    // Only the exact shape runVerifyDevice()'s decode gate covers (single
    // relmem segment, a real paramMemLayout) - other shapes left untouched.
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
      const expectedDecoded = decodeParamMem(
        paramMem!,
        layout,
        defs,
        parameterByteOrder,
      );
      const actualDecoded = decodeParamMem(
        cachedActualBuf,
        layout,
        defs,
        parameterByteOrder,
      );
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

    // GA-link rows - always recomputed when the app model has a GA table,
    // regardless of device family (pure com_objects + fresh gaTable/
    // assocTable lookup, no raw-byte/addressing dependency).
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
      ...(gaTable && assocTable ? gaRows : [...priorGaRows.values()]),
      ...(groupObjectTable ? obj3Rows : [...priorObj3Rows.values()]),
    ];
    // An Access="None" (isVisible: false) parameter doesn't count as a
    // mismatch here - see DecodedParam.isVisible.
    const allDecodedMatch =
      !decoded.length ||
      decoded.every((d) => d.match !== false || d.isVisible === false);
    // `totalDiffering` is a raw byte count independent of `decoded`, so a
    // hidden parameter's differing byte(s) must be subtracted back out
    // before gating `match` on it, or the mismatch counts twice.
    // `totalDiffering` itself stays the honest raw count for display.
    const hiddenMismatchBytes = decoded
      .filter((d) => d.isVisible === false && d.match === false)
      .reduce((sum, d) => sum + Math.ceil(Number(d.bitSize ?? 0) / 8), 0);

    res.json({
      deviceAddress: cached.deviceAddress,
      family: cached.family,
      match:
        Math.max(0, totalDiffering - hiddenMismatchBytes) === 0 &&
        allDecodedMatch,
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
      // Marks this as a local recompute, not a fresh device read - the
      // client keeps its original `fetchedAt` and layers this on top.
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
