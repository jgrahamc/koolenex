/**
 * Tests for bus route endpoints (server/routes/bus.ts).
 * Uses createTestServer() with a mock KnxBusManager injected via setBus().
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import { createTestServer, req, type TestServer } from './helpers.ts';

// ── Mock KnxBusManager ───────────────────────────────────────────────────────

class MockBus extends EventEmitter {
  connected = false;
  host: string | null = null;
  port: number | null = 3671;
  type: string | null = null;
  projectId: number | string | null = null;
  _wss: unknown = null;
  _remapFn: ((tg: any) => any) | null = null;
  _scanAbort = false;

  // Track calls for assertions
  calls: Array<{ method: string; args: unknown[] }> = [];

  setRemapper(fn: (tg: any) => any): void {
    this._remapFn = fn;
  }

  attachWSS(): void {}

  broadcast(): void {}

  connect(
    host: string,
    port: number,
    projectId?: number | string | null,
  ): Promise<{ host: string; port: number }> {
    this.calls.push({ method: 'connect', args: [host, port, projectId] });
    this.connected = true;
    this.host = host;
    this.port = port;
    this.type = 'udp';
    this.projectId = projectId ?? null;
    return Promise.resolve({ host, port });
  }

  connectUsb(
    devicePath: string,
    projectId?: number | string | null,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method: 'connectUsb', args: [devicePath, projectId] });
    this.connected = true;
    this.type = 'usb';
    this.projectId = projectId ?? null;
    return Promise.resolve({ path: devicePath });
  }

  disconnect(): void {
    this.calls.push({ method: 'disconnect', args: [] });
    this.connected = false;
    this.host = null;
    this.type = null;
  }

  write(ga: string, value: unknown, dpt?: string): any {
    this.calls.push({ method: 'write', args: [ga, value, dpt] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ok: true, ga, value, dpt };
  }

  async read(ga: string): Promise<{ ga: string; value: string }> {
    this.calls.push({ method: 'read', args: [ga] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ga, value: '1' };
  }

  async ping(
    gaAddresses: string[],
    deviceAddress: string | null,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    this.calls.push({ method: 'ping', args: [gaAddresses, deviceAddress] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { reachable: true, ga: gaAddresses[0] ?? null };
  }

  async identify(deviceAddress: string): Promise<void> {
    this.calls.push({ method: 'identify', args: [deviceAddress] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
  }

  async scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (p: any) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    this.calls.push({ method: 'scan', args: [area, line, timeoutMs] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return [];
  }

  abortScan(): void {
    this.calls.push({ method: 'abortScan', args: [] });
    this._scanAbort = true;
  }

  async readDeviceInfo(deviceAddr: string): Promise<any> {
    this.calls.push({ method: 'readDeviceInfo', args: [deviceAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { descriptor: '07b0', address: deviceAddr };
  }

  async programIA(newAddr: string): Promise<{ ok: boolean; newAddr: string }> {
    this.calls.push({ method: 'programIA', args: [newAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ok: true, newAddr };
  }

  async downloadDevice(): Promise<void> {
    this.calls.push({ method: 'downloadDevice', args: [...arguments] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
  }

  listUsbDevices(): any[] {
    return [];
  }

  listAllHidDevices(): any[] {
    return [];
  }

  status(): any {
    return {
      connected: this.connected,
      type: this.type,
      host: this.host,
      port: this.port,
      hasLib: true,
    };
  }
}

// ── Test setup ──────────────────────────────────────────────────────────────

let ts: TestServer;
let mockBus: MockBus;

before(async () => {
  ts = await createTestServer();
  mockBus = new MockBus();
  // Inject mock bus via the router's setBus method
  const { router } = await import('../server/routes/index.ts');
  (router as any).setBus(mockBus);
});

after(() => ts.close());

beforeEach(() => {
  mockBus.calls = [];
  mockBus.connected = false;
  mockBus.host = null;
  mockBus.port = 3671;
  mockBus.type = null;
  mockBus.projectId = null;
});

// ── GET /bus/status ─────────────────────────────────────────────────────────

describe('GET /bus/status', () => {
  it('returns bus status', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/status');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.connected, false);
    assert.equal(data.hasLib, true);
  });

  it('reflects connected state', async () => {
    mockBus.connected = true;
    mockBus.host = '192.168.1.1';
    mockBus.type = 'udp';

    const r = await req(ts.baseUrl, 'GET', '/bus/status');
    const data = r.data as any;
    assert.equal(data.connected, true);
    assert.equal(data.host, '192.168.1.1');
    assert.equal(data.type, 'udp');
  });
});

// ── POST /bus/connect ───────────────────────────────────────────────────────

describe('POST /bus/connect', () => {
  it('connects with host and default port', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '192.168.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.host, '192.168.1.1');
    assert.equal(data.port, 3671);

    assert.equal(mockBus.calls[0].method, 'connect');
    assert.equal(mockBus.calls[0].args[0], '192.168.1.1');
    assert.equal(mockBus.calls[0].args[1], 3671);
  });

  it('connects with custom port', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
      port: 3672,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].args[1], 3672);
  });

  it('passes projectId', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
      projectId: 42,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].args[2], 42);
  });

  it('saves host and port to settings', async () => {
    await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.5',
      port: 3675,
    });
    const host = ts.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key='knxip_host'",
    );
    const port = ts.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key='knxip_port'",
    );
    assert.equal(host!.value, '10.0.0.5');
    assert.equal(port!.value, '3675');
  });

  it('rejects missing host', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {});
    assert.equal(r.status, 400);
  });

  it('returns 502 on connection failure', async () => {
    const origConnect = mockBus.connect.bind(mockBus);
    mockBus.connect = () => Promise.reject(new Error('Connection refused'));
    const r = await req(ts.baseUrl, 'POST', '/bus/connect', {
      host: '10.0.0.1',
    });
    assert.equal(r.status, 502);
    mockBus.connect = origConnect;
  });
});

// ── POST /bus/connect-usb ───────────────────────────────────────────────────

describe('POST /bus/connect-usb', () => {
  it('connects via USB', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect-usb', {
      devicePath: '/dev/hidraw0',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.type, 'usb');
    assert.equal(mockBus.calls[0].method, 'connectUsb');
  });

  it('rejects missing devicePath', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/connect-usb', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/disconnect ────────────────────────────────────────────────────

describe('POST /bus/disconnect', () => {
  it('disconnects', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/disconnect');
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'disconnect');
  });
});

// ── POST /bus/project ───────────────────────────────────────────────────────

describe('POST /bus/project', () => {
  it('sets project ID on bus', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/project', {
      projectId: 42,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.projectId, 42);
  });

  it('clears project ID with null', async () => {
    mockBus.projectId = 42;
    const r = await req(ts.baseUrl, 'POST', '/bus/project', {
      projectId: null,
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.projectId, null);
  });
});

// ── POST /bus/write ─────────────────────────────────────────────────────────

describe('POST /bus/write', () => {
  it('writes to GA', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: true,
      dpt: '1',
    });
    assert.equal(r.status, 200);
    assert.equal(mockBus.calls[0].method, 'write');
    assert.equal(mockBus.calls[0].args[0], '1/0/0');
  });

  it('returns 502 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: true,
    });
    assert.equal(r.status, 502);
  });

  it('rejects missing ga', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/write', { value: true });
    assert.equal(r.status, 400);
  });

  it('logs telegram to bus_telegrams when projectId provided', async () => {
    mockBus.connected = true;

    // Create a project first so projectId exists
    ts.db.run("INSERT INTO projects (name) VALUES ('Test')");
    const proj = ts.db.get<{ id: number }>(
      'SELECT id FROM projects ORDER BY id DESC LIMIT 1',
    );

    await req(ts.baseUrl, 'POST', '/bus/write', {
      ga: '1/0/0',
      value: 1,
      dpt: '1',
      projectId: proj!.id,
    });

    const tg = ts.db.get<{ dst: string; type: string }>(
      'SELECT dst, type FROM bus_telegrams WHERE project_id=? ORDER BY id DESC LIMIT 1',
      [proj!.id],
    );
    assert.ok(tg);
    assert.equal(tg.dst, '1/0/0');
    assert.equal(tg.type, 'GroupValue_Write');
  });
});

// ── POST /bus/read ──────────────────────────────────────────────────────────

describe('POST /bus/read', () => {
  it('reads from GA', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/read', { ga: '1/0/0' });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ga, '1/0/0');
    assert.equal(data.value, '1');
    assert.equal(mockBus.calls[0].method, 'read');
  });

  it('returns 502 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/read', { ga: '1/0/0' });
    assert.equal(r.status, 502);
  });

  it('rejects missing ga', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/read', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/ping ──────────────────────────────────────────────────────────

describe('POST /bus/ping', () => {
  it('pings with GA addresses', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/ping', {
      gaAddresses: ['1/0/0'],
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.reachable, true);
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/ping', {
      gaAddresses: ['1/0/0'],
    });
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/identify ──────────────────────────────────────────────────────

describe('POST /bus/identify', () => {
  it('identifies device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'identify');
    assert.equal(mockBus.calls[0].args[0], '1.1.1');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/identify', {});
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/scan ──────────────────────────────────────────────────────────

describe('POST /bus/scan', () => {
  it('starts scan and returns immediately', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {
      area: 1,
      line: 1,
    });
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.equal(mockBus.calls[0].method, 'scan');
  });

  it('uses default area/line/timeout', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {});
    assert.equal(r.status, 200);
    // Defaults: area=1, line=1, timeout=200
    assert.deepEqual(mockBus.calls[0].args, [1, 1, 200]);
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {});
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/scan/abort ────────────────────────────────────────────────────

describe('POST /bus/scan/abort', () => {
  it('aborts scan', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/scan/abort');
    assert.equal(r.status, 200);
    assert.equal((r.data as any).ok, true);
    assert.ok(mockBus.calls.some((c) => c.method === 'abortScan'));
  });
});

// ── POST /bus/device-info ───────────────────────────────────────────────────

describe('POST /bus/device-info', () => {
  it('reads device info', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/device-info', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.descriptor, '07b0');
    assert.equal(data.address, '1.1.1');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/device-info', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });
});

// ── POST /bus/program-ia ────────────────────────────────────────────────────

describe('POST /bus/program-ia', () => {
  it('programs individual address', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {
      newAddr: '1.1.5',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.equal(data.ok, true);
    assert.equal(data.newAddr, '1.1.5');
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {
      newAddr: '1.1.5',
    });
    assert.equal(r.status, 409);
  });

  it('rejects missing newAddr', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-ia', {});
    assert.equal(r.status, 400);
  });
});

// ── GET /bus/usb-devices ────────────────────────────────────────────────────

describe('GET /bus/usb-devices', () => {
  it('returns device list', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/usb-devices');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.ok(Array.isArray(data.devices));
  });
});

describe('GET /bus/usb-devices/all', () => {
  it('returns all HID devices', async () => {
    const r = await req(ts.baseUrl, 'GET', '/bus/usb-devices/all');
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.ok(Array.isArray(data.devices));
  });
});

// ── POST /bus/program-device ────────────────────────────────────────────────

describe('POST /bus/program-device', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 409);
  });

  it('returns 404 for non-existent device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: '1.1.99',
      projectId: 999,
    });
    assert.equal(r.status, 404);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {});
    assert.equal(r.status, 400);
  });
});
