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
} from '../../shared/types.ts';

interface BusStatusResponse {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
}

interface ImportResult {
  ok: boolean;
  projectId: number;
  summary: {
    devices: number;
    groupAddresses: number;
    comObjects: number;
    links: number;
  };
  data: ProjectFull;
}

const BASE = '/api';

class ApiError extends Error {
  code?: string;
}

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body && !isFormData) {
    (opts.headers as Record<string, string>)['Content-Type'] =
      'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body as FormData;
  }
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  if (!res.ok) {
    const e = new ApiError(data.error || res.statusText);
    if (data.code) e.code = data.code;
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
    req<ImportResult>('POST', '/projects/import', formData, true),
  reimportETS: (id: number, formData: FormData) =>
    req<ImportResult>('POST', `/projects/${id}/reimport`, formData, true),

  // Devices
  listDevices: (pid: number) =>
    req<Device[]>('GET', `/projects/${pid}/devices`),
  createDevice: (pid: number, body: Record<string, unknown>) =>
    req<Device>('POST', `/projects/${pid}/devices`, body),
  updateDevice: (pid: number, did: number, body: Record<string, unknown>) =>
    req<Device>('PUT', `/projects/${pid}/devices/${did}`, body),
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
    req('GET', `/projects/${pid}/devices/${did}/param-model`),
  saveParamValues: (
    pid: number,
    did: number,
    values: Record<string, unknown>,
  ) => req('PATCH', `/projects/${pid}/devices/${did}/param-values`, values),

  // DPT info (per-project, from project's knx_master.xml)
  getDptInfo: (pid?: number) => req('GET', `/dpt-info?projectId=${pid || ''}`),
  getSpaceUsages: (pid?: number) =>
    req('GET', `/space-usages?projectId=${pid || ''}`),
  getMediumTypes: (pid?: number) =>
    req('GET', `/medium-types?projectId=${pid || ''}`),
  getMaskVersions: (pid?: number) =>
    req('GET', `/mask-versions?projectId=${pid || ''}`),
  getTranslations: (pid?: number) =>
    req('GET', `/translations?projectId=${pid || ''}`),

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
  listComObjects: (pid: number) => req('GET', `/projects/${pid}/comobjects`),
  updateComObjectGAs: (
    pid: number,
    coid: number,
    body: Record<string, unknown>,
  ) => req('PATCH', `/projects/${pid}/comobjects/${coid}/gas`, body),

  // Catalog
  getCatalog: (pid: number) => req('GET', `/projects/${pid}/catalog`),
  importKnxprod: (pid: number, formData: FormData) =>
    req('POST', `/projects/${pid}/catalog/import`, formData, true),

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
    req('GET', `/projects/${pid}/audit-log?limit=${limit || 500}`),
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
  busConnect: (host: string, port: number, projectId: number) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/connect', {
      host,
      port,
      projectId,
    }),
  busConnectUsb: (devicePath: string, projectId: number) =>
    req<{ ok: boolean; [key: string]: unknown }>('POST', '/bus/connect-usb', {
      devicePath,
      projectId,
    }),
  busUsbDevices: () => req('GET', '/bus/usb-devices'),
  busUsbDevicesAll: () => req('GET', '/bus/usb-devices/all'),
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
    req('POST', '/bus/ping', { gaAddresses, deviceAddress }),
  busIdentify: (deviceAddress: string) =>
    req('POST', '/bus/identify', { deviceAddress }),
  busScan: (area: number, line: number, timeout?: number) =>
    req('POST', '/bus/scan', { area, line, timeout }),
  busScanAbort: () => req('POST', '/bus/scan/abort'),
  busDeviceInfo: (deviceAddress: string) =>
    req('POST', '/bus/device-info', { deviceAddress }),
  busProgramIA: (newAddr: string) =>
    req('POST', '/bus/program-ia', { newAddr }),
  busProgramDevice: (
    deviceAddress: string,
    projectId: number,
    deviceId: number,
  ) =>
    req('POST', '/bus/program-device', {
      deviceAddress,
      projectId,
      deviceId,
    }),

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
export function createWS(onMessage: (data: Record<string, unknown>) => void): {
  close: () => void;
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
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (_) {}
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
  };
}
