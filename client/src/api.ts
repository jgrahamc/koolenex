// API base

import type {
  Project,
  ProjectFull,
  Device,
  EnrichedGA,
  Space,
  Topology,
  BusTelegram,
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
  // True when a reconnect failure is standing, not just signaled once via
  // the 'knx:reconnect-failed' WS event - lets a plain status refresh (page
  // reload, WS reconnect) show "Disconnected" instead of falling back to
  // "Idle". Tracked server-side in server/knx-bus.ts's _needsAttention.
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
  /**
   * False for a parameter declared `Access="None"` - download-only, never
   * shown in ETS's own UI, and sometimes a device-firmware sentinel that
   * changes on its own after a Download. Excluded from mismatch counts/
   * status shown to the user (see DeviceCompareResults.tsx/
   * ProgrammingView.tsx). Undefined on GA-link/Object 3 rows; treat as
   * visible (true) when absent.
   */
  isVisible?: boolean;
  /** Object 3 rows only - undefined for every other row kind (params, GA links). */
  obj3Expected?: GroupObjectEntryFlags;
  obj3Actual?: GroupObjectEntryFlags | null;
  /**
   * Whether the download actually writes this parameter's bytes. False for
   * a ParamRef buildParamMem() skips (inactive channel alternative, or no
   * value and no default) - its bytes keep the segment's fill, so a
   * mismatch here is meaningless. Undefined on GA-link/Object 3 rows.
   */
  written?: boolean;
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
   * byte totals, present only when the app declares that region - mirrors
   * totalBytes/totalDiffering but for that separate memory region. */
  flagsTotalBytes?: number;
  flagsDifferingBytes?: number;
  /** True when this Verify ran against the "Loopback (test)" harness
   * rather than a real device - the server deliberately does NOT persist
   * this result as the device's real verify/status record in that case
   * (a loopback session is otherwise indistinguishable from a real one,
   * and would leave a real device showing a false "Restart needed"
   * badge). Undefined for a real bus read. */
  testConnection?: boolean;
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

export class ApiError extends Error {
  code?: string;
  // Raw parsed error body, for routes attaching extra fields beyond
  // error/message/code (e.g. /bus/program-device's canUseSerial).
  data?: Record<string, unknown>;
}

/**
 * A caught value's message. TypeScript types a catch binding as `unknown`,
 * and the views were annotating theirs as `any` to get at `.message`; this
 * says the same thing once, honestly.
 */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The API error code on a caught value, when it came from this layer. */
export function errCode(e: unknown): string | undefined {
  return e instanceof ApiError ? e.code : undefined;
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
    // fetch() rejects with TypeError on network failure/abort/socket
    // timeout, and a DOMException named AbortError when `signal` was
    // aborted (e.g. cancelling a real-hardware wait - see
    // busReadSerialsInProgrammingMode). Surface that distinctly.
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
    // Two server-side conventions: project-import routes put friendly text
    // in `error` plus a distinct `code`; most bus routes put a short code
    // in `error` and friendly text in `message`. Prefer `message` when
    // present, falling back to `error` as the code for callers that branch
    // on which error this was.
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
  // The Programming page's "Modified" badge popover's own data source -
  // see the route's own doc comment (server/routes/devices.ts) for what
  // each change kind's shape means and why param_value comes back
  // unresolved.
  getDevicePendingChanges: (pid: number, did: number) =>
    req<{
      count: number;
      changes: Array<{
        kind: string;
        key: string;
        updatedAt: string;
        label: string | null;
        from?: unknown;
        to?: unknown;
        flagDiffs?: Array<{ field: string; from: string; to: string }>;
      }>;
    }>('GET', `/projects/${pid}/devices/${did}/pending-changes`),
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
    }>('PATCH', `/projects/${pid}/devices/${did}/param-values`, values),

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
  // LOCAL TESTING AID ONLY - see /bus/connect-loopback's own doc comment
  // (server/routes/bus.ts).
  busConnectLoopback: (projectId: number, deviceId: number) =>
    req<{ ok: boolean; deviceAddress?: string; [key: string]: unknown }>(
      'POST',
      '/bus/connect-loopback',
      { projectId, deviceId },
    ),
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
  // Read-side counterpart to busProgramIA - detects a device currently in
  // physical programming mode by address (A_IndividualAddress_Read/
  // _Response). Only safe to write against (busProgramIA) when exactly one
  // device is in programming mode - see busReadSerialsInProgrammingMode for
  // the multi-device-safe alternative.
  busCheckProgrammingMode: (timeoutMs?: number, signal?: AbortSignal) =>
    req<{ address: string | null }>(
      'POST',
      '/bus/check-programming-mode',
      { timeoutMs },
      false,
      signal,
    ),
  // Collects every device currently in programming mode by serial number
  // (not just the first to answer) - disambiguates multiple simultaneous
  // devices; see server/knx-connection.ts's
  // readSerialNumbersInProgrammingMode(). `signal` lets a caller give up
  // early on this long wait (operators need real time to reach the
  // device); the server-side scan still runs to its own timeout regardless
  // (a passive read, nothing physically dangerous), the result is just
  // discarded.
  busReadSerialsInProgrammingMode: (timeoutMs?: number, signal?: AbortSignal) =>
    req<{ devices: Array<{ serial: string; src: string }> }>(
      'POST',
      '/bus/read-serials-in-programming-mode',
      { timeoutMs },
      false,
      signal,
    ),
  // Address a device purely by its serial number - no programming-button
  // press needed. See docs/knx-device-write-protocol.md §9: sourced from
  // the Falcon SDK's docs + Calimero's implementation, but unlike every
  // other write path here has NO real-hardware confirmation yet - don't
  // present it as equally proven to busProgramIA.
  // An occupied target address is a 409 (ApiError), not a 200 with an
  // ok:false field - same convention as busProgramDevice's own
  // address_occupied. The thrown error's message is already the full
  // friendly text; err.data.occupantSerial carries the raw serial for a
  // caller that wants it structured rather than parsed out of the message.
  busAssignAddressBySerial: (serial: string, newAddress: string) =>
    req<{
      ok: boolean;
      verified: boolean;
      address: string | null;
      restarted: boolean;
    }>('POST', '/bus/assign-address-by-serial', { serial, newAddress }),
  // `signal`: the route's address pre-flight can wait up to 30s for a
  // physical programming-button press - lets a caller give up early (the
  // "press the button" modal's Cancel button). Same pattern as
  // busReadSerialsInProgrammingMode.
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
      // Best-effort post-write read-back (server/routes/bus.ts). Absent if
      // the device didn't answer; totalBytes is always real (combined size
      // of whatever tables/parameter memory this download actually wrote).
      serialNumber?: string;
      totalBytes: number;
      // Count/detail of writes whose response never arrived - see
      // knx-connection.ts's DownloadResult doc comment. 0 means every
      // write was confirmed.
      unconfirmedWrites?: number;
      unconfirmedDetails?: string[];
      /** True when this download ran against the "Loopback (test)" harness -
       * see VerifyDeviceResult.testConnection's own doc comment for why the
       * server deliberately does not persist status/history for one. */
      testConnection?: boolean;
    }>(
      'POST',
      '/bus/program-device',
      { deviceAddress, projectId, deviceId, mode, addressMethod },
      false,
      signal,
    ),

  // Sends A_Restart directly to an already-addressed device, without a
  // write of any kind - the recovery action offered alongside a
  // restart-withheld indicator, for a device that wrote its content but is
  // still running its previous application.
  busRestartDevice: (deviceAddress: string) =>
    req<{ ok: boolean }>('POST', '/bus/restart-device', { deviceAddress }),

  // Resets a device's last_download/last_download_serial and
  // restart-withheld record - never touches the device itself, only this
  // project's own record of it. See server/routes/bus.ts's own doc comment
  // for the two situations this is the recovery action for.
  busClearDownloadHistory: (projectId: number, deviceId: number) =>
    req<{ ok: boolean; device: Device }>(
      'POST',
      '/bus/clear-download-history',
      {
        projectId,
        deviceId,
      },
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
  // fresh DB state, reusing the cached DEVICE/actual side - no bus access.
  // Editing a com object's flags/GA-link/param values doesn't change what's
  // on the device, only what's expected, so a local edit shouldn't force a
  // live re-read. See server/routes/bus.ts's route doc comment.
  busRecomputeVerify: (deviceId: number, cached: VerifyDeviceResult) =>
    req<VerifyDeviceResult & { recomputedAt: number }>(
      'POST',
      '/bus/verify-device/recompute',
      { deviceId, cached },
    ),

  // Settings
  // GET /settings is Object.fromEntries over the settings table - a
  // key->value map, not a row array.
  getSettings: () => req<Record<string, string>>('GET', '/settings'),
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
    // Without onOpen, a reconnect (e.g. after a server restart) never
    // re-syncs bus status - the client would keep showing stale
    // `busStatus` indefinitely. Lets the caller re-fetch on every connect.
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
    // Best-effort: dropped silently if the socket isn't open (e.g. between
    // reconnect attempts). Used for lightweight signals like the Monitor
    // view's watch:start/watch:stop (see KnxBusManager.addKeepAliveRef())
    // - not a queue, and doesn't survive a WS reconnect.
    send(data: Record<string, unknown>) {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(data));
        } catch (_) {}
      }
    },
  };
}
