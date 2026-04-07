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

async function req(
  method: string,
  path: string,
  body?: unknown,
  isFormData = false,
): Promise<unknown> {
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
  return data;
}

export const api = {
  // Projects
  listProjects: () => req('GET', '/projects') as Promise<Project[]>,
  getProject: (id: number) =>
    req('GET', `/projects/${id}`) as Promise<ProjectFull>,
  createProject: (name: string) =>
    req('POST', '/projects', { name }) as Promise<Project>,
  updateProject: (id: number, name: string) =>
    req('PUT', `/projects/${id}`, { name }) as Promise<Project>,
  deleteProject: (id: number) =>
    req('DELETE', `/projects/${id}`) as Promise<{ ok: boolean }>,
  importETS: (formData: FormData) =>
    req('POST', '/projects/import', formData, true) as Promise<ImportResult>,
  reimportETS: (id: number, formData: FormData) =>
    req(
      'POST',
      `/projects/${id}/reimport`,
      formData,
      true,
    ) as Promise<ImportResult>,

  // Devices
  listDevices: (pid: number) =>
    req('GET', `/projects/${pid}/devices`) as Promise<Device[]>,
  createDevice: (pid: number, body: Record<string, unknown>) =>
    req('POST', `/projects/${pid}/devices`, body) as Promise<Device>,
  updateDevice: (pid: number, did: number, body: Record<string, unknown>) =>
    req('PUT', `/projects/${pid}/devices/${did}`, body) as Promise<Device>,
  setDeviceStatus: (pid: number, did: number, status: string) =>
    req('PATCH', `/projects/${pid}/devices/${did}/status`, {
      status,
    }) as Promise<{ ok: boolean }>,
  deleteDevice: (pid: number, did: number) =>
    req('DELETE', `/projects/${pid}/devices/${did}`) as Promise<{
      ok: boolean;
    }>,

  uploadFloorPlan: (pid: number, spaceId: number, formData: FormData) =>
    req(
      'POST',
      `/projects/${pid}/floor-plan/${spaceId}`,
      formData,
      true,
    ) as Promise<{ ok: boolean; [key: string]: unknown }>,
  getFloorPlanUrl: (pid: number, spaceId: number) =>
    `${BASE}/projects/${pid}/floor-plan/${spaceId}`,
  deleteFloorPlan: (pid: number, spaceId: number) =>
    req('DELETE', `/projects/${pid}/floor-plan/${spaceId}`) as Promise<{
      ok: boolean;
    }>,

  getParamModel: (pid: number, did: number) =>
    req(
      'GET',
      `/projects/${pid}/devices/${did}/param-model`,
    ) as Promise<unknown>,
  saveParamValues: (
    pid: number,
    did: number,
    values: Record<string, unknown>,
  ) =>
    req(
      'PATCH',
      `/projects/${pid}/devices/${did}/param-values`,
      values,
    ) as Promise<unknown>,

  // DPT info (per-project, from project's knx_master.xml)
  getDptInfo: (pid?: number) =>
    req('GET', `/dpt-info?projectId=${pid || ''}`) as Promise<unknown>,
  getSpaceUsages: (pid?: number) =>
    req('GET', `/space-usages?projectId=${pid || ''}`) as Promise<unknown>,
  getMediumTypes: (pid?: number) =>
    req('GET', `/medium-types?projectId=${pid || ''}`) as Promise<unknown>,
  getMaskVersions: (pid?: number) =>
    req('GET', `/mask-versions?projectId=${pid || ''}`) as Promise<unknown>,
  getTranslations: (pid?: number) =>
    req('GET', `/translations?projectId=${pid || ''}`) as Promise<unknown>,

  // Group Addresses
  listGAs: (pid: number) =>
    req('GET', `/projects/${pid}/gas`) as Promise<EnrichedGA[]>,
  createGA: (pid: number, body: Record<string, unknown>) =>
    req('POST', `/projects/${pid}/gas`, body) as Promise<EnrichedGA>,
  updateGA: (pid: number, gid: number, body: Record<string, unknown>) =>
    req('PUT', `/projects/${pid}/gas/${gid}`, body) as Promise<EnrichedGA>,
  renameGAGroup: (pid: number, body: Record<string, unknown>) =>
    req('PATCH', `/projects/${pid}/gas/group-name`, body) as Promise<{
      ok: boolean;
    }>,
  deleteGA: (pid: number, gid: number) =>
    req('DELETE', `/projects/${pid}/gas/${gid}`) as Promise<{ ok: boolean }>,

  // Com Objects
  listComObjects: (pid: number) =>
    req('GET', `/projects/${pid}/comobjects`) as Promise<unknown>,
  updateComObjectGAs: (
    pid: number,
    coid: number,
    body: Record<string, unknown>,
  ) =>
    req(
      'PATCH',
      `/projects/${pid}/comobjects/${coid}/gas`,
      body,
    ) as Promise<unknown>,

  // Catalog
  getCatalog: (pid: number) =>
    req('GET', `/projects/${pid}/catalog`) as Promise<unknown>,
  importKnxprod: (pid: number, formData: FormData) =>
    req(
      'POST',
      `/projects/${pid}/catalog/import`,
      formData,
      true,
    ) as Promise<unknown>,

  // Topology
  getTopology: (pid: number) =>
    req('GET', `/projects/${pid}/topology`) as Promise<Topology[]>,
  createTopology: (pid: number, body: Record<string, unknown>) =>
    req('POST', `/projects/${pid}/topology`, body) as Promise<Topology>,
  updateTopology: (pid: number, tid: number, body: Record<string, unknown>) =>
    req('PUT', `/projects/${pid}/topology/${tid}`, body) as Promise<Topology>,
  deleteTopology: (pid: number, tid: number) =>
    req('DELETE', `/projects/${pid}/topology/${tid}`) as Promise<{
      ok: boolean;
    }>,

  // Spaces
  createSpace: (pid: number, body: Record<string, unknown>) =>
    req('POST', `/projects/${pid}/spaces`, body) as Promise<Space>,
  updateSpace: (pid: number, sid: number, body: Record<string, unknown>) =>
    req('PUT', `/projects/${pid}/spaces/${sid}`, body) as Promise<Space>,
  deleteSpace: (pid: number, sid: number) =>
    req('DELETE', `/projects/${pid}/spaces/${sid}`) as Promise<{
      ok: boolean;
    }>,

  // Audit Log
  getAuditLog: (pid: number, limit?: number) =>
    req(
      'GET',
      `/projects/${pid}/audit-log?limit=${limit || 500}`,
    ) as Promise<unknown>,
  auditLogCsvUrl: (pid: number) => `${BASE}/projects/${pid}/audit-log/csv`,

  // Telegrams
  listTelegrams: (pid: number, limit?: number) =>
    req('GET', `/projects/${pid}/telegrams?limit=${limit || 200}`) as Promise<
      BusTelegram[]
    >,
  clearTelegrams: (pid: number) =>
    req('DELETE', `/projects/${pid}/telegrams`) as Promise<{ ok: boolean }>,

  // Bus
  busStatus: () => req('GET', '/bus/status') as Promise<BusStatusResponse>,
  busConnect: (host: string, port: number, projectId: number) =>
    req('POST', '/bus/connect', {
      host,
      port,
      projectId,
    }) as Promise<{ ok: boolean; [key: string]: unknown }>,
  busConnectUsb: (devicePath: string, projectId: number) =>
    req('POST', '/bus/connect-usb', {
      devicePath,
      projectId,
    }) as Promise<{ ok: boolean; [key: string]: unknown }>,
  busUsbDevices: () => req('GET', '/bus/usb-devices') as Promise<unknown>,
  busUsbDevicesAll: () =>
    req('GET', '/bus/usb-devices/all') as Promise<unknown>,
  busSetProject: (projectId: number) =>
    req('POST', '/bus/project', {
      projectId,
    }) as Promise<{ ok: boolean; [key: string]: unknown }>,
  busDisconnect: () =>
    req('POST', '/bus/disconnect') as Promise<{
      ok: boolean;
      [key: string]: unknown;
    }>,
  busWrite: (
    ga: string,
    value: unknown,
    dpt: string | number,
    projectId: number,
  ) =>
    req('POST', '/bus/write', {
      ga,
      value,
      dpt,
      projectId,
    }) as Promise<{ ok: boolean; [key: string]: unknown }>,
  busRead: (ga: string) =>
    req('POST', '/bus/read', { ga }) as Promise<{
      ok: boolean;
      [key: string]: unknown;
    }>,
  busPing: (gaAddresses: string[], deviceAddress: string) =>
    req('POST', '/bus/ping', {
      gaAddresses,
      deviceAddress,
    }) as Promise<unknown>,
  busIdentify: (deviceAddress: string) =>
    req('POST', '/bus/identify', { deviceAddress }) as Promise<unknown>,
  busScan: (area: number, line: number, timeout?: number) =>
    req('POST', '/bus/scan', { area, line, timeout }) as Promise<unknown>,
  busScanAbort: () => req('POST', '/bus/scan/abort') as Promise<unknown>,
  busDeviceInfo: (deviceAddress: string) =>
    req('POST', '/bus/device-info', { deviceAddress }) as Promise<unknown>,
  busProgramIA: (newAddr: string) =>
    req('POST', '/bus/program-ia', { newAddr }) as Promise<unknown>,
  busProgramDevice: (
    deviceAddress: string,
    projectId: number,
    deviceId: number,
  ) =>
    req('POST', '/bus/program-device', {
      deviceAddress,
      projectId,
      deviceId,
    }) as Promise<unknown>,

  // Settings
  getSettings: () => req('GET', '/settings') as Promise<Setting[]>,
  saveSettings: (body: Record<string, string>) =>
    req('PATCH', '/settings', body) as Promise<{ ok: boolean }>,

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
  // In dev (Vite on :5173) connect directly to backend; in prod use same host
  const host =
    location.port === '5173' ? `${location.hostname}:4000` : location.host;

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
