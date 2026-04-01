// API base
const BASE = '/api';

async function req(method, path, body, isFormData = false) {
  const opts = { method, headers: {} };
  if (body && !isFormData) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (isFormData) {
    opts.body = body; // FormData
  }
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.error || res.statusText); if (data.code) e.code = data.code; throw e; }
  return data;
}

export const api = {
  // Projects
  listProjects:   ()          => req('GET',    '/projects'),
  getProject:     (id)        => req('GET',    `/projects/${id}`),
  createProject:  (name)      => req('POST',   '/projects', { name }),
  updateProject:  (id, name)  => req('PUT',    `/projects/${id}`, { name }),
  deleteProject:  (id)        => req('DELETE', `/projects/${id}`),
  importETS:      (formData)  => req('POST',   '/projects/import', formData, true),
  reimportETS:    (id, formData) => req('POST', `/projects/${id}/reimport`, formData, true),

  // Devices
  listDevices:    (pid)        => req('GET',  `/projects/${pid}/devices`),
  createDevice:   (pid, body)  => req('POST', `/projects/${pid}/devices`, body),
  updateDevice:   (pid, did, body) => req('PUT', `/projects/${pid}/devices/${did}`, body),
  setDeviceStatus:(pid,did,status) => req('PATCH', `/projects/${pid}/devices/${did}/status`, { status }),
  deleteDevice:   (pid, did)   => req('DELETE', `/projects/${pid}/devices/${did}`),

  uploadFloorPlan:   (pid, spaceId, formData) => req('POST', `/projects/${pid}/floor-plan/${spaceId}`, formData, true),
  getFloorPlanUrl:   (pid, spaceId) => `${BASE}/projects/${pid}/floor-plan/${spaceId}`,
  deleteFloorPlan:   (pid, spaceId) => req('DELETE', `/projects/${pid}/floor-plan/${spaceId}`),

  getParamModel:      (pid, did) => req('GET', `/projects/${pid}/devices/${did}/param-model`),
  saveParamValues:    (pid, did, values) => req('PATCH', `/projects/${pid}/devices/${did}/param-values`, values),

  // DPT info (per-project, from project's knx_master.xml)
  getDptInfo:     (pid)        => req('GET',  `/dpt-info?projectId=${pid || ''}`),
  getSpaceUsages: (pid)        => req('GET',  `/space-usages?projectId=${pid || ''}`),
  getMediumTypes: (pid)        => req('GET',  `/medium-types?projectId=${pid || ''}`),
  getMaskVersions:(pid)        => req('GET',  `/mask-versions?projectId=${pid || ''}`),
  getTranslations:(pid)        => req('GET',  `/translations?projectId=${pid || ''}`),

  // Group Addresses
  listGAs:        (pid)        => req('GET',  `/projects/${pid}/gas`),
  createGA:       (pid, body)  => req('POST', `/projects/${pid}/gas`, body),
  updateGA:       (pid, gid, body) => req('PUT', `/projects/${pid}/gas/${gid}`, body),
  renameGAGroup:  (pid, body)  => req('PATCH', `/projects/${pid}/gas/group-name`, body),
  deleteGA:       (pid, gid)   => req('DELETE', `/projects/${pid}/gas/${gid}`),

  // Com Objects
  listComObjects: (pid)        => req('GET',  `/projects/${pid}/comobjects`),
  updateComObjectGAs: (pid, coid, body) => req('PATCH', `/projects/${pid}/comobjects/${coid}/gas`, body),

  // Catalog
  getCatalog:    (pid) => req('GET', `/projects/${pid}/catalog`),
  importKnxprod: (pid, formData) => req('POST', `/projects/${pid}/catalog/import`, formData, true),

  // Spaces
  createSpace:    (pid, body)      => req('POST', `/projects/${pid}/spaces`, body),
  updateSpace:    (pid, sid, body) => req('PUT', `/projects/${pid}/spaces/${sid}`, body),
  deleteSpace:    (pid, sid)       => req('DELETE', `/projects/${pid}/spaces/${sid}`),

  // Audit Log
  getAuditLog:    (pid, limit) => req('GET', `/projects/${pid}/audit-log?limit=${limit||500}`),
  auditLogCsvUrl: (pid) => `${BASE}/projects/${pid}/audit-log/csv`,

  // Telegrams
  listTelegrams:  (pid, limit) => req('GET',  `/projects/${pid}/telegrams?limit=${limit||200}`),
  clearTelegrams: (pid)        => req('DELETE', `/projects/${pid}/telegrams`),

  // Bus
  busStatus:      ()           => req('GET',  '/bus/status'),
  busConnect:     (host, port, projectId) => req('POST', '/bus/connect', { host, port, projectId }),
  busConnectUsb:  (devicePath, projectId) => req('POST', '/bus/connect-usb', { devicePath, projectId }),
  busUsbDevices:  ()           => req('GET',  '/bus/usb-devices'),
  busUsbDevicesAll: ()         => req('GET',  '/bus/usb-devices/all'),
  busSetProject:  (projectId)  => req('POST', '/bus/project', { projectId }),
  busDisconnect:  ()           => req('POST', '/bus/disconnect'),
  busWrite:       (ga, value, dpt, projectId) => req('POST', '/bus/write', { ga, value, dpt, projectId }),
  busRead:        (ga)         => req('POST', '/bus/read', { ga }),
  busPing:        (gaAddresses, deviceAddress) => req('POST', '/bus/ping', { gaAddresses, deviceAddress }),
  busIdentify:    (deviceAddress) => req('POST', '/bus/identify', { deviceAddress }),
  busScan:        (area, line, timeout) => req('POST', '/bus/scan', { area, line, timeout }),
  busScanAbort:   ()               => req('POST', '/bus/scan/abort'),
  busDeviceInfo:  (deviceAddress)  => req('POST', '/bus/device-info', { deviceAddress }),
  busProgramIA:   (newAddr)        => req('POST', '/bus/program-ia', { newAddr }),
  busProgramDevice: (deviceAddress, projectId, deviceId) => req('POST', '/bus/program-device', { deviceAddress, projectId, deviceId }),

  // Settings
  getSettings:    ()           => req('GET',  '/settings'),
  saveSettings:   (body)       => req('PATCH','/settings', body),

  // RTF to HTML
  rtfToHtml: async (rtf) => {
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
export function createWS(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In dev (Vite on :5173) connect directly to backend; in prod use same host
  const host = location.port === '5173' ? `${location.hostname}:4000` : location.host;

  let ws;
  let closed = false;
  let retryTimer = null;

  function connect() {
    ws = new WebSocket(`${proto}//${host}`);
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (_) {}
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
      clearTimeout(retryTimer);
      ws?.close();
    },
  };
}
