// API base
const BASE = '/api';

class ApiError extends Error {
  code?: string;
}

async function req(
  method: string,
  path: string,
  body?: any,
  isFormData = false,
): Promise<any> {
  const opts: RequestInit = { method, headers: {} };
  if (body && !isFormData) {
    (opts.headers as Record<string, string>)['Content-Type'] =
      'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body; // FormData
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
  listProjects: () => req('GET', '/projects'),
  getProject: (id: number) => req('GET', `/projects/${id}`),
  createProject: (name: string) => req('POST', '/projects', { name }),
  updateProject: (id: number, name: string) =>
    req('PUT', `/projects/${id}`, { name }),
  deleteProject: (id: number) => req('DELETE', `/projects/${id}`),
  importETS: (formData: FormData) =>
    req('POST', '/projects/import', formData, true),
  reimportETS: (id: number, formData: FormData) =>
    req('POST', `/projects/${id}/reimport`, formData, true),

  // Devices
  listDevices: (pid: number) => req('GET', `/projects/${pid}/devices`),
  createDevice: (pid: number, body: any) =>
    req('POST', `/projects/${pid}/devices`, body),
  updateDevice: (pid: number, did: number, body: any) =>
    req('PUT', `/projects/${pid}/devices/${did}`, body),
  setDeviceStatus: (pid: number, did: number, status: string) =>
    req('PATCH', `/projects/${pid}/devices/${did}/status`, { status }),
  deleteDevice: (pid: number, did: number) =>
    req('DELETE', `/projects/${pid}/devices/${did}`),

  uploadFloorPlan: (pid: number, spaceId: number, formData: FormData) =>
    req('POST', `/projects/${pid}/floor-plan/${spaceId}`, formData, true),
  getFloorPlanUrl: (pid: number, spaceId: number) =>
    `${BASE}/projects/${pid}/floor-plan/${spaceId}`,
  deleteFloorPlan: (pid: number, spaceId: number) =>
    req('DELETE', `/projects/${pid}/floor-plan/${spaceId}`),

  getParamModel: (pid: number, did: number) =>
    req('GET', `/projects/${pid}/devices/${did}/param-model`),
  saveParamValues: (pid: number, did: number, values: any) =>
    req('PATCH', `/projects/${pid}/devices/${did}/param-values`, values),

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
  listGAs: (pid: number) => req('GET', `/projects/${pid}/gas`),
  createGA: (pid: number, body: any) =>
    req('POST', `/projects/${pid}/gas`, body),
  updateGA: (pid: number, gid: number, body: any) =>
    req('PUT', `/projects/${pid}/gas/${gid}`, body),
  renameGAGroup: (pid: number, body: any) =>
    req('PATCH', `/projects/${pid}/gas/group-name`, body),
  deleteGA: (pid: number, gid: number) =>
    req('DELETE', `/projects/${pid}/gas/${gid}`),

  // Com Objects
  listComObjects: (pid: number) => req('GET', `/projects/${pid}/comobjects`),
  updateComObjectGAs: (pid: number, coid: number, body: any) =>
    req('PATCH', `/projects/${pid}/comobjects/${coid}/gas`, body),

  // Catalog
  getCatalog: (pid: number) => req('GET', `/projects/${pid}/catalog`),
  importKnxprod: (pid: number, formData: FormData) =>
    req('POST', `/projects/${pid}/catalog/import`, formData, true),

  // Topology
  getTopology: (pid: number) => req('GET', `/projects/${pid}/topology`),
  createTopology: (pid: number, body: any) =>
    req('POST', `/projects/${pid}/topology`, body),
  updateTopology: (pid: number, tid: number, body: any) =>
    req('PUT', `/projects/${pid}/topology/${tid}`, body),
  deleteTopology: (pid: number, tid: number) =>
    req('DELETE', `/projects/${pid}/topology/${tid}`),

  // Spaces
  createSpace: (pid: number, body: any) =>
    req('POST', `/projects/${pid}/spaces`, body),
  updateSpace: (pid: number, sid: number, body: any) =>
    req('PUT', `/projects/${pid}/spaces/${sid}`, body),
  deleteSpace: (pid: number, sid: number) =>
    req('DELETE', `/projects/${pid}/spaces/${sid}`),

  // Audit Log
  getAuditLog: (pid: number, limit?: number) =>
    req('GET', `/projects/${pid}/audit-log?limit=${limit || 500}`),
  auditLogCsvUrl: (pid: number) => `${BASE}/projects/${pid}/audit-log/csv`,

  // Telegrams
  listTelegrams: (pid: number, limit?: number) =>
    req('GET', `/projects/${pid}/telegrams?limit=${limit || 200}`),
  clearTelegrams: (pid: number) => req('DELETE', `/projects/${pid}/telegrams`),

  // Bus
  busStatus: () => req('GET', '/bus/status'),
  busConnect: (host: string, port: number, projectId: number) =>
    req('POST', '/bus/connect', { host, port, projectId }),
  busConnectUsb: (devicePath: string, projectId: number) =>
    req('POST', '/bus/connect-usb', { devicePath, projectId }),
  busUsbDevices: () => req('GET', '/bus/usb-devices'),
  busUsbDevicesAll: () => req('GET', '/bus/usb-devices/all'),
  busSetProject: (projectId: number) =>
    req('POST', '/bus/project', { projectId }),
  busDisconnect: () => req('POST', '/bus/disconnect'),
  busWrite: (ga: string, value: any, dpt: string | number, projectId: number) =>
    req('POST', '/bus/write', { ga, value, dpt, projectId }),
  busRead: (ga: string) => req('POST', '/bus/read', { ga }),
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
    req('POST', '/bus/program-device', { deviceAddress, projectId, deviceId }),

  // Settings
  getSettings: () => req('GET', '/settings'),
  saveSettings: (body: any) => req('PATCH', '/settings', body),

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
export function createWS(onMessage: (data: any) => void): {
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
