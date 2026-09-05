// API base

import type {
  Project,
  ProjectFull,
  Device,
  EnrichedGA,
  Space,
  Topology,
  BusTelegram,
  Setting,
  DptInfoEntry,
  ComObjectWithDevice,
  CatalogSection,
  CatalogItem,
  AuditLogEntry,
} from '../../shared/types.ts';

interface BusStatusResponse {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
  // Real bug, found live 2026-08-31: previously only ever arrived via a
  // live 'knx:reconnect-failed' WebSocket event - a plain status refresh
  // (page reload, or the client's own WebSocket reconnecting mid-session)
  // had no way to learn a standing reconnect failure was real, and
  // silently read back to a calm "Idle" instead of "Disconnected". Now
  // tracked server-side (server/knx-bus.ts's _needsAttention) and included
  // in every /bus/status response.
  needsAttention?: boolean;
}

/** Object 3 (Group Object Table) row only - structured flags for the compact per-flag chip
 * display (server: decodeGroupObjectEntryFlags(), knx-tables.ts). `commLinked` is bit 2 -
 * Communication AND has-a-real-GA-link combined, not separable from the byte alone. */
export interface GroupObjectEntryFlags {
  update: boolean;
  transmit: boolean;
  readOnInit: boolean;
  write: boolean;
  read: boolean;
  commLinked: boolean;
  priority: string;
  size: string;
}

export interface VerifyDecodedParam {
  key: string;
  label: string;
  section: string;
  group: string;
  unit: string;
  offset: number;
  bitOffset: number;
  bitSize: number;
  rawValue: number | string;
  expectedValue: string;
  actualValue: string | null;
  match: boolean | null;
  /** Object 3 rows only - undefined for every other row kind (params, GA links). */
  obj3Expected?: GroupObjectEntryFlags;
  obj3Actual?: GroupObjectEntryFlags | null;
}

export interface VerifyDeviceResult {
  deviceAddress: string;
  family: string;
  match: boolean;
  totalBytes: number;
  totalDiffering: number;
  segments: Array<{
    label: string;
    offset: number;
    size: number;
    matching: number;
    differing: number;
    expectedHex: string;
    actualHex: string;
  }>;
  props: Array<{
    label: string;
    obj: number;
    pid: number;
    match: boolean;
    expectedHex: string;
    actualHex: string;
  }>;
  decoded?: VerifyDecodedParam[];
  /** Object 3 (Group Object Table / "Communication Flags")'s own raw
   * byte-level totals, present only when this app declares that region -
   * mirrors totalBytes/totalDiffering but for that separate memory region,
   * so a log line can quote a real "N/M bytes match" figure for flags too,
   * not just a count of differing named rows. */
  flagsTotalBytes?: number;
  flagsDifferingBytes?: number;
}

export interface ImportSummary {
  devices: number;
  groupAddresses: number;
  comObjects: number;
  links: number;
}

interface ImportKickoffResult {
  ok: true;
  importId: string;
}

export type ImportJobStatus =
  | 'parsing'
  | 'password-required'
  | 'done'
  | 'failed';

export interface ImportStatusSnapshot {
  importId: string;
  mode: 'import' | 'reimport';
  fileName: string;
  status: ImportJobStatus;
  projectId?: number;
  summary?: ImportSummary;
  error?: string;
  code?: string;
  passwordRetry?: boolean;
}

const BASE = '/api';

class ApiError extends Error {
  code?: string;
  // Raw parsed error body, for routes that attach extra fields beyond
  // error/message/code (e.g. /bus/program-device's canUseSerial) - see
  // req()'s own handling below for why code/message are split the way
  // they are.
  data?: Record<string, unknown>;
}

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
  signal?: AbortSignal,
): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (signal) opts.signal = signal;
  if (body && !isFormData) {
    (opts.headers as Record<string, string>)['Content-Type'] =
      'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body as FormData;
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, opts);
  } catch (e) {
    // fetch() rejects with TypeError on network failure, abort, or browser
    // socket timeout - and with a DOMException named AbortError when a
    // passed-in `signal` was aborted (e.g. the user cancelling a real-
    // hardware wait, 2026-08-31 - see busReadSerialsInProgrammingMode).
    // Surface that distinctly rather than the generic network-error text.
    if ((e as { name?: string }).name === 'AbortError') {
      const abortErr = new ApiError('Cancelled');
      abortErr.code = 'aborted';
      throw abortErr;
    }
    throw new ApiError(
      `Network error or request timed out (${(e as Error).message}). Check the server console for details.`,
    );
  }
  const data = await res.json();
  if (!res.ok) {
    // Two conventions exist server-side: some routes (project import)
    // put the friendly text directly in `error` and a distinct `code`;
    // most bus routes put a short identifying string in `error` and the
    // friendly text in `message`. Prefer `message` when present (so the
    // log shows real prose, not a raw code like
    // "no_device_in_programming_mode"), and fall back to `error` as the
    // code for callers that need to branch on which error this was.
    const e = new ApiError(data.message || data.error || res.statusText);
    if (data.code) e.code = data.code;
    else if (data.message) e.code = data.error;
    e.data = data;
    throw e;
  }
  return data as T;
}

export const api = {
  // Projects
  listProjects: () => req<Project[]>('GET', '/projects'),
  getProject: (id: number) => req<ProjectFull>('GET', `/projects/${id}`),
  createProject: (name: string) => req<Project>('POST', '/projects', { name }),
  updateProject: (id: number, name: string) =>
    req<Project>('PUT', `/projects/${id}`, { name }),
  deleteProject: (id: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${id}`),
  importETS: (formData: FormData) =>
    req<ImportKickoffResult>('POST', '/projects/import', formData, true),
  reimportETS: (id: number, formData: FormData) =>
    req<ImportKickoffResult>(
      'POST',
      `/projects/${id}/reimport`,
      formData,
      true,
    ),
  submitImportPassword: (importId: string, password: string) =>
    req<{ ok: true }>('POST', `/projects/import/${importId}/password`, {
      password,
    }),
  getImportStatus: (importId: string) =>
    req<ImportStatusSnapshot>('GET', `/projects/import/${importId}/status`),

  // Devices
  listDevices: (pid: number) =>
    req<Device[]>('GET', `/projects/${pid}/devices`),
  createDevice: (pid: number, body: Record<string, unknown>) =>
    req<Device>('POST', `/projects/${pid}/devices`, body),
  updateDevice: (pid: number, did: number, body: Record<string, unknown>) =>
    req<Device>('PUT', `/projects/${pid}/devices/${did}`, body),
  unassignDevice: (pid: number, did: number) =>
    req<Device>('PATCH', `/projects/${pid}/devices/${did}/unassign`, {}),
  setDeviceStatus: (pid: number, did: number, status: string) =>
    req<{ ok: boolean }>('PATCH', `/projects/${pid}/devices/${did}/status`, {
      status,
    }),
  deleteDevice: (pid: number, did: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/devices/${did}`),

  uploadFloorPlan: (pid: number, spaceId: number, formData: FormData) =>
    req<{ ok: boolean; [key: string]: unknown }>(
      'POST',
      `/projects/${pid}/floor-plan/${spaceId}`,
      formData,
      true,
    ),
  getFloorPlanUrl: (pid: number, spaceId: number) =>
    `${BASE}/projects/${pid}/floor-plan/${spaceId}`,
  deleteFloorPlan: (pid: number, spaceId: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/floor-plan/${spaceId}`),

  getParamModel: (pid: number, did: number) =>
    req<Record<string, unknown>>(
      'GET',
      `/projects/${pid}/devices/${did}/param-model`,
    ),
  saveParamValues: (
    pid: number,
    did: number,
    values: Record<string, unknown>,
  ) =>
    req<{
      ok: boolean;
      device_status?: string;
      last_verify_match?: null;
      last_verify_at?: null;
    }>(
      'PATCH',
      `/projects/${pid}/devices/${did}/param-values`,
      values,
    ),

  // DPT info (per-project, from project's knx_master.xml)
  getDptInfo: (pid?: number) =>
    req<Record<string, DptInfoEntry>>(
      'GET',
      `/dpt-info?projectId=${pid || ''}`,
    ),
  getSpaceUsages: (pid?: number) =>
    req<Array<{ id: string; number: number; text: string }>>(
      'GET',
      `/space-usages?projectId=${pid || ''}`,
    ),
  getMediumTypes: (pid?: number) =>
    req<Record<string, string>>('GET', `/medium-types?projectId=${pid || ''}`),
  getMaskVersions: (pid?: number) =>
    req<
      Record<string, { name: string; managementModel: string; medium: string }>
    >('GET', `/mask-versions?projectId=${pid || ''}`),
  getTranslations: (pid?: number) =>
    req<{
      languages: Array<{ id: string; name: string }>;
      translations: Record<string, Record<string, string>>;
    }>('GET', `/translations?projectId=${pid || ''}`),

  // Group Addresses
  listGAs: (pid: number) => req<EnrichedGA[]>('GET', `/projects/${pid}/gas`),
  createGA: (pid: number, body: Record<string, unknown>) =>
    req<EnrichedGA>('POST', `/projects/${pid}/gas`, body),
  updateGA: (pid: number, gid: number, body: Record<string, unknown>) =>
    req<EnrichedGA>('PUT', `/projects/${pid}/gas/${gid}`, body),
  renameGAGroup: (pid: number, body: Record<string, unknown>) =>
    req<{ ok: boolean }>('PATCH', `/projects/${pid}/gas/group-name`, body),
  deleteGA: (pid: number, gid: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/gas/${gid}`),

  // Com Objects
  listComObjects: (pid: number) =>
    req<ComObjectWithDevice[]>('GET', `/projects/${pid}/comobjects`),
  updateComObjectGAs: (
    pid: number,
    coid: number,
    body: Record<string, unknown>,
  ) =>
    req<ComObjectWithDevice>(
      'PATCH',
      `/projects/${pid}/comobjects/${coid}/gas`,
      body,
    ),
  updateComObjectFlags: (
    pid: number,
    coid: number,
    body: Record<string, unknown>,
  ) =>
    req<ComObjectWithDevice>(
      'PATCH',
      `/projects/${pid}/comobjects/${coid}/flags`,
      body,
    ),

  // Catalog
  getCatalog: (pid: number) =>
    req<{
      sections: CatalogSection[];
      items: (CatalogItem & { in_use: boolean })[];
    }>('GET', `/projects/${pid}/catalog`),
  importKnxprod: (pid: number, formData: FormData) =>
    req<{
      ok: boolean;
      sections: CatalogSection[];
      items: (CatalogItem & { in_use: boolean })[];
    }>('POST', `/projects/${pid}/catalog/import`, formData, true),

  // Topology
  getTopology: (pid: number) =>
    req<Topology[]>('GET', `/projects/${pid}/topology`),
  createTopology: (pid: number, body: Record<string, unknown>) =>
    req<Topology>('POST', `/projects/${pid}/topology`, body),
  updateTopology: (pid: number, tid: number, body: Record<string, unknown>) =>
    req<Topology>('PUT', `/projects/${pid}/topology/${tid}`, body),
  deleteTopology: (pid: number, tid: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/topology/${tid}`),

  // Spaces
  createSpace: (pid: number, body: Record<string, unknown>) =>
    req<Space>('POST', `/projects/${pid}/spaces`, body),
  updateSpace: (pid: number, sid: number, body: Record<string, unknown>) =>
    req<Space>('PUT', `/projects/${pid}/spaces/${sid}`, body),
  deleteSpace: (pid: number, sid: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/spaces/${sid}`),

  // Audit Log
  getAuditLog: (pid: number, limit?: number) =>
    req<AuditLogEntry[]>(
      'GET',
      `/projects/${pid}/audit-log?limit=${limit || 500}`,
    ),
  auditLogCsvUrl: (pid: number) => `${BASE}/projects/${pid}/audit-log/csv`,

  // Telegrams
  listTelegrams: (pid: number, limit?: number) =>
    req<BusTelegram[]>(
      'GET',
      `/projects/${pid}/telegrams?limit=${limit || 200}`,
    ),
  clearTelegrams: (pid: number) =>
    req<{ ok: boolean }>('DELETE', `/projects/${pid}/telegrams`),

  // Bus
  busStatus: () => req<BusStatusResponse>('GET', '/bus/status'),
  busConnect: (
    host: string,
    port: number,
    projectId: number,
    protocol?: 'udp' | 'tcp' | 'auto',
  ) =>
    req<{ ok: boolean; type?: 'udp' | 'tcp'; [key: string]: unknown }>(
      'POST',
      '/bus/connect',
      { host, port, projectId, protocol },
    ),
  busConnectUsb: (devicePath: string, projectId: number) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/connect-usb', {
      devicePath,
      projectId,
    }),
  busUsbDevices: () =>
    req<{ devices: Record<string, unknown>[] }>('GET', '/bus/usb-devices'),
  busUsbDevicesAll: () =>
    req<{ devices: Record<string, unknown>[] }>('GET', '/bus/usb-devices/all'),
  busSetProject: (projectId: number) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/project', {
      projectId,
    }),
  busDisconnect: () =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/disconnect'),
  busWrite: (
    ga: string,
    value: unknown,
    dpt: string | number,
    projectId: number,
  ) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/write', {
      ga,
      value,
      dpt,
      projectId,
    }),
  busRead: (ga: string) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/read', { ga }),
  busPing: (gaAddresses: string[], deviceAddress: string) =>
    req<{ reachable: boolean; ga: string | null }>('POST', '/bus/ping', {
      gaAddresses,
      deviceAddress,
    }),
  busIdentify: (deviceAddress: string) =>
    req<{ ok: boolean }>('POST', '/bus/identify', { deviceAddress }),
  busScan: (area: number, line: number, timeout?: number) =>
    req<{ ok: boolean }>('POST', '/bus/scan', { area, line, timeout }),
  busScanAbort: () => req<{ ok: boolean }>('POST', '/bus/scan/abort'),
  busDeviceInfo: (deviceAddress: string) =>
    req<Record<string, unknown>>('POST', '/bus/device-info', { deviceAddress }),
  busProgramIA: (newAddr: string) =>
    req<{ ok: boolean; newAddr: string; restarted: boolean }>(
      'POST',
      '/bus/program-ia',
      { newAddr },
    ),
  // Read-side counterpart to busProgramIA - detects a device currently held
  // in physical programming mode by its address (A_IndividualAddress_Read/
  // _Response), without needing to know its serial or address ahead of time.
  // Only safe to write against (busProgramIA) when exactly one device is in
  // programming mode - see busReadSerialsInProgrammingMode below for the
  // multi-device-safe alternative.
  busCheckProgrammingMode: (timeoutMs?: number, signal?: AbortSignal) =>
    req<{ address: string | null }>(
      'POST',
      '/bus/check-programming-mode',
      { timeoutMs },
      false,
      signal,
    ),
  // Collects every device currently in programming mode by serial number
  // (not just the first to answer) - server/knx-connection.ts's
  // readSerialNumbersInProgrammingMode(), real-hardware confirmed
  // 2026-08-30 to disambiguate multiple simultaneous devices cleanly.
  // `signal` (2026-08-31): lets a caller give up on a long real-hardware
  // wait early - a real timing complaint from live testing ("this needs to
  // be at least 30 seconds or more as it will take time for people to go
  // to the device to set prog mode... We should have a cancel write option
  // to stop the search"). Aborting only stops the CLIENT from waiting on
  // this response; the server-side scan still runs to its own timeout
  // server-side (nothing physically dangerous keeps happening - it's a
  // passive read), the result is just discarded.
  busReadSerialsInProgrammingMode: (timeoutMs?: number, signal?: AbortSignal) =>
    req<{ devices: Array<{ serial: string; src: string }> }>(
      'POST',
      '/bus/read-serials-in-programming-mode',
      { timeoutMs },
      false,
      signal,
    ),
  // Address a device purely by its serial number - no programming-button
  // press needed. See docs/knx-device-write-protocol.md §9 (koolenex repo):
  // sourced from the Falcon SDK's own docs + Calimero's implementation, but
  // unlike every other write path this app exposes, has NO real-hardware
  // confirmation yet - surface that to the user, don't present it as
  // equally proven to busProgramIA.
  busAssignAddressBySerial: (serial: string, newAddress: string) =>
    req<{
      ok: boolean;
      verified: boolean;
      address: string | null;
      restarted: boolean;
    }>('POST', '/bus/assign-address-by-serial', { serial, newAddress }),
  // `signal` (2026-08-31): the route's own address pre-flight can now
  // genuinely wait up to 30s for a physical programming-button press -
  // lets a caller give up early (the "press the button" modal's own
  // Cancel button) rather than being stuck waiting the full window. See
  // busReadSerialsInProgrammingMode's own doc comment for the identical
  // pattern used there first.
  busProgramDevice: (
    deviceAddress: string,
    projectId: number,
    deviceId: number,
    mode?: 'full' | 'partial',
    signal?: AbortSignal,
    // How to locate/(re)address the device when it doesn't currently
    // answer with a matching serial - omit on the first attempt; the
    // route returns a distinguishable 'address_needs_confirmation' error
    // (canUseSerial on the thrown ApiError's `data`) when it needs the
    // caller to choose. See server/routes/bus.ts's own doc comment.
    addressMethod?: 'button' | 'serial',
  ) =>
    req<{
      ok: boolean;
      deviceAddress: string;
      mode: 'full' | 'partial';
      // Best-effort post-write read-back (server/routes/bus.ts) - real
      // request, 2026-08-31: capture and surface the same identity/size
      // info the log should show. serialNumber absent if the device
      // didn't answer that read; totalBytes is always a real number (the
      // combined size of whatever tables/parameter memory were actually
      // part of this download's plan).
      serialNumber?: string;
      totalBytes: number;
      // Count/detail of writes whose response never arrived during this
      // download - see knx-connection.ts's DownloadResult doc comment. 0
      // means every write was confirmed.
      unconfirmedWrites?: number;
      unconfirmedDetails?: string[];
    }>(
      'POST',
      '/bus/program-device',
      { deviceAddress, projectId, deviceId, mode, addressMethod },
      false,
      signal,
    ),

  // Read-only: compare a device's actual memory to the computed image (no writes)
  busVerifyDevice: (
    deviceAddress: string,
    projectId: number,
    deviceId: number,
  ) =>
    req<VerifyDeviceResult>('POST', '/bus/verify-device', {
      deviceAddress,
      projectId,
      deviceId,
    }),

  // Re-runs a cached verify comparison's PROJECT/expected side against
  // fresh DB state, reusing the already-cached DEVICE/actual side - no bus
  // access at all. See server/routes/bus.ts's route doc comment for the
  // full reasoning (real user feedback, 2026-08-31: editing a com object's
  // flags/GA-link/param values doesn't change what's on the device, only
  // what we now expect, so there's no reason a local edit should force a
  // live re-read just to see an accurate comparison again).
  busRecomputeVerify: (deviceId: number, cached: VerifyDeviceResult) =>
    req<VerifyDeviceResult & { recomputedAt: number }>(
      'POST',
      '/bus/verify-device/recompute',
      { deviceId, cached },
    ),

  // Settings
  getSettings: () => req<Setting[]>('GET', '/settings'),
  saveSettings: (body: Record<string, string>) =>
    req<{ ok: boolean }>('PATCH', '/settings', body),

  // RTF to HTML
  rtfToHtml: async (rtf: string): Promise<string> => {
    const res = await fetch(BASE + '/rtf-to-html', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rtf,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data.html;
  },
};

// WebSocket for real-time bus updates
export function createWS(
  onMessage: (data: Record<string, unknown>) => void,
  onOpen?: () => void,
): {
  close: () => void;
  send: (data: Record<string, unknown>) => void;
} {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In dev (Vite dev server) connect directly to backend on :4000; in prod use same host
  const serverPort = '4000';
  const host =
    location.port !== serverPort
      ? `${location.hostname}:${serverPort}`
      : location.host;

  let ws: WebSocket;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    ws = new WebSocket(`${proto}//${host}`);
    // Real bug, fixed 2026-08-29: this had no onopen handler at all, so a
    // reconnect (e.g. after the koolenex server restarts) never re-synced
    // real bus status - if the physical KNX bus connection dropped or
    // changed while the WebSocket itself was down, the client kept showing
    // whatever `busStatus` it last had, indefinitely (the top-bar badge
    // stuck on "connected" even while genuinely disconnected). `onOpen` lets
    // the caller re-fetch real state on every connect, not just the first.
    ws.onopen = () => onOpen?.();
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.warn('[ws] failed to parse message:', err);
      }
    };
    ws.onclose = () => {
      if (!closed) retryTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => {};
  }

  connect();
  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    },
    // Best-effort: silently dropped if the socket isn't open (e.g. between
    // reconnect attempts). Used for lightweight signals like the Monitor
    // view's watch:start/watch:stop (see KnxBusManager.addKeepAliveRef())
    // - not a queue, and does not currently survive a WS reconnect while
    // the caller expects the signal to still apply.
    send(data: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(data));
        } catch (_) {}
      }
    },
  };
}
