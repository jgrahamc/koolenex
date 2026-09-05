/**
 * Tests for bus route endpoints (server/routes/bus.ts).
 * Uses createTestServer() with a mock KnxBusManager injected via setBus().
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, req, type TestServer } from './helpers.ts';
import { planVerify, type PlanStep } from '../server/knx-download-plan.ts';
import {
  buildGATable,
  buildAssocTable,
  buildGroupObjectTable,
  decodeGATable,
  decodeAssocTable,
  buildParamMem,
  resolveParamSegment,
} from '../server/routes/knx-tables.ts';
import type { GroupObjectFlags } from '../server/routes/knx-tables.ts';
import { APPS_DIR } from '../server/routes/shared.ts';

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

  // Mirrors the real KnxBusManager.addKeepAliveRef() shape (see
  // server/knx-bus.ts) - routes that hold a keep-alive ref for the
  // duration of an operation (program-device, verify-device) call this
  // on the bus, real or fake.
  _keepAliveRefs = 0;
  addKeepAliveRef(): () => void {
    this._keepAliveRefs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._keepAliveRefs = Math.max(0, this._keepAliveRefs - 1);
    };
  }

  setRemapper(fn: (tg: any) => any): void {
    this._remapFn = fn;
  }

  // Mirrors the real KnxBusManager.forceReconnect() shape (see
  // server/knx-bus.ts) - /bus/program-device and /bus/verify-device both
  // call this unconditionally before starting, real bus or fake.
  async forceReconnect(): Promise<void> {
    this.calls.push({ method: 'forceReconnect', args: [] });
    if (!this.host || this.type === 'usb') return;
    await this.connect(this.host, this.port ?? 3671, this.projectId);
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

  // serialNumber default matches seedDevice()'s own default serial_number
  // (see that function) - real request, 2026-08-31, verbatim: "ETS when it
  // does a full download ALWAYS writes the address first, reboots and
  // then the params... We should first check if we have the serial
  // number. If so we should then check if that device address exists on
  // the bus... validate the serial number". /bus/program-device's new
  // pre-flight now calls this FIRST, before downloadDevice() - matching
  // by default means every existing test's seeded device passes that
  // check immediately (addressConfirmed=true) without needing its own
  // programming-mode/address-write simulation, keeping every test that
  // isn't specifically about the pre-flight itself unaffected beyond one
  // extra logged call. Override via deviceInfoSerialOverride for a test
  // that specifically wants a mismatch/no-serial scenario.
  deviceInfoSerialOverride: string | null | undefined = undefined;
  async readDeviceInfo(deviceAddr: string): Promise<any> {
    this.calls.push({ method: 'readDeviceInfo', args: [deviceAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return {
      descriptor: '07b0',
      address: deviceAddr,
      serialNumber:
        this.deviceInfoSerialOverride !== undefined
          ? this.deviceInfoSerialOverride
          : 'aabbccddeeff',
    };
  }

  async programIA(newAddr: string): Promise<{ ok: boolean; newAddr: string }> {
    this.calls.push({ method: 'programIA', args: [newAddr] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { ok: true, newAddr };
  }

  // Configurable per-test for the pre-flight's own re-addressing branch
  // (see readDeviceInfo's own comment) - empty by default, since most
  // tests never reach this call at all (a matching readDeviceInfo serial
  // short-circuits the whole re-addressing flow before this would run).
  serialsInProgrammingMode: Array<{ serial: string; src: string }> = [];
  async readSerialNumbersInProgrammingMode(
    timeoutMs?: number,
  ): Promise<Array<{ serial: string; src: string }>> {
    this.calls.push({
      method: 'readSerialNumbersInProgrammingMode',
      args: [timeoutMs],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return this.serialsInProgrammingMode;
  }

  async checkProgrammingMode(
    timeoutMs?: number,
  ): Promise<{ address: string | null }> {
    this.calls.push({ method: 'checkProgrammingMode', args: [timeoutMs] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { address: '1.1.20' };
  }

  // Configurable per-test for the address-by-serial choice flow
  // (/bus/program-device) - real hardware confirmed working (see
  // docs/knx-device-write-protocol.md §9.2), but a real device can still
  // fail to answer/verify, and that failure needs its own coverage.
  assignBySerialVerified = true;
  async assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; verified: boolean; address: string | null }> {
    this.calls.push({
      method: 'assignIndividualAddressBySerial',
      args: [serial, newAddr, timeoutMs],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return {
      ok: true,
      verified: this.assignBySerialVerified,
      address: this.assignBySerialVerified ? newAddr : null,
    };
  }

  async downloadDevice(): Promise<{
    unconfirmedWrites: number;
    unconfirmedDetails: string[];
  }> {
    this.calls.push({ method: 'downloadDevice', args: [...arguments] });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return { unconfirmedWrites: 0, unconfirmedDetails: [] };
  }

  // Optional canned device image: address -> byte. readMemory serves from it
  // (defaulting to 0xFF for unmapped bytes) so verify-device round-trips can be
  // driven to an exact match or mismatch. propImage does the same for props.
  memImage: Map<number, number> | null = null;
  propImage: Map<string, Buffer> | null = null;

  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
  ): Promise<Buffer> {
    this.calls.push({
      method: 'readMemory',
      args: [deviceAddr, address, length],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    if (!this.memImage) return Buffer.alloc(length);
    const out = Buffer.alloc(length, 0xff);
    for (let i = 0; i < length; i++) {
      const b = this.memImage.get(address + i);
      if (b != null) out[i] = b;
    }
    return out;
  }

  // Batched read used by verify-device: one call reads every region (the real
  // KnxConnection drives them all inside a single management session).
  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
  ): Promise<Buffer[]> {
    this.calls.push({
      method: 'readMemoryMany',
      args: [deviceAddr, regions],
    });
    return Promise.all(
      regions.map((r) => this.readMemory(deviceAddr, r.address, r.length)),
    );
  }

  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    this.calls.push({
      method: 'readProperty',
      args: [deviceAddr, objIdx, propId],
    });
    if (!this.connected) throw new Error('Not connected to KNX bus');
    return this.propImage?.get(`${objIdx}/${propId}`) ?? Buffer.alloc(0);
  }

  async readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]> {
    this.calls.push({
      method: 'readPropertyMany',
      args: [deviceAddr, reads],
    });
    return Promise.all(
      reads.map((rd) => this.readProperty(deviceAddr, rd.objIdx, rd.propId)),
    );
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

  // /bus/scan is fire-and-forget by design: it responds {ok:true}
  // immediately (line 594 in the route) and runs the actual scan
  // afterward, reporting success/failure only via scan:progress/scan:done/
  // scan:error WebSocket broadcasts - never via the HTTP response itself.
  // A disconnected bus at request time is no exception: b.scan() goes
  // through the same lazy-reconnect path as every other bus operation, so
  // the request still returns 200 even when not connected - whether the
  // scan itself then succeeds (via a reconnect) or fails (a scan:error
  // broadcast) happens after this response, not observable from it.
  it('still returns 200 immediately even when not connected (fire-and-forget)', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/scan', {});
    assert.equal(r.status, 200);
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

// ── POST /bus/check-programming-mode ────────────────────────────────────────
// A_IndividualAddress_Read broadcast discovery - see
// docs/knx-device-write-protocol.md §9. Route-level coverage only, same as
// every other bus route in this file.

describe('POST /bus/check-programming-mode', () => {
  it('returns the responding address', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/check-programming-mode', {});
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.deepEqual(data, { address: '1.1.20' });
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/check-programming-mode', {});
    assert.equal(r.status, 409);
  });

  it('rejects an out-of-range timeoutMs', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/check-programming-mode', {
      timeoutMs: 999999,
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/assign-address-by-serial ──────────────────────────────────────
// NM_IndividualAddress_SerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4) - see
// docs/knx-device-write-protocol.md §9. No real-hardware
// confirmation for this service yet.

describe('POST /bus/assign-address-by-serial', () => {
  it('assigns an address by serial number', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: '00a625401d94',
      newAddress: '1.1.20',
    });
    assert.equal(r.status, 200);
    const data = r.data as any;
    assert.deepEqual(data, { ok: true, verified: true, address: '1.1.20' });
  });

  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: '00a625401d94',
      newAddress: '1.1.20',
    });
    assert.equal(r.status, 409);
  });

  it('rejects a serial that is not 12 hex chars', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: 'not-hex',
      newAddress: '1.1.20',
    });
    assert.equal(r.status, 400);
  });

  it('rejects missing newAddress', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: '00a625401d94',
    });
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
  // Same ordering as /bus/verify-device: the device lookup runs before any
  // bus operation, so with no device seeded for this address that's what
  // fails first regardless of connection state - real "not connected"
  // coverage lives in the relmem-fixture describe block below, where a
  // real device exists to get past this check.
  it('returns 404 for a non-existent device even when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 404);
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

// ── POST /bus/read-memory ───────────────────────────────────────────────────

describe('POST /bus/read-memory', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x100,
      length: 16,
    });
    assert.equal(r.status, 409);
  });

  it('reads memory and returns hex when connected', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x100,
      length: 4,
    });
    assert.equal(r.status, 200);
    const data = r.data as { hex: string; length: number };
    assert.equal(data.length, 4);
    assert.equal(data.hex, '00000000');
    assert.ok(mockBus.calls.some((c) => c.method === 'readMemory'));
  });

  it('rejects an out-of-range address', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0x100_0000,
      length: 4,
    });
    assert.equal(r.status, 400);
  });

  it('accepts an extended (24-bit) address beyond the old 16-bit cap', async () => {
    mockBus.connected = true;
    // Extended addressing (see the 16-bit truncation fix) - readMemory()
    // already picks A_Memory_Read vs A_MemoryExtended_Read per chunk based
    // on the address, so this route must not reject valid high addresses.
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0xc3000,
      length: 4,
    });
    assert.equal(r.status, 200);
  });

  it('rejects a read that would run past the 24-bit address space', async () => {
    mockBus.connected = true;
    // address + length = 0x1000002 > 0x1000000 → would wrap on the wire.
    const r = await req(ts.baseUrl, 'POST', '/bus/read-memory', {
      deviceAddress: '1.1.1',
      address: 0xfffffe,
      length: 4,
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/read-property ─────────────────────────────────────────────────

describe('POST /bus/read-property', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-property', {
      deviceAddress: '1.1.1',
      objIdx: 1,
      propId: 7,
    });
    assert.equal(r.status, 409);
  });

  it('reads a property and returns hex when connected', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([['1/7', Buffer.from('000f0000', 'hex')]]);
    const r = await req(ts.baseUrl, 'POST', '/bus/read-property', {
      deviceAddress: '1.1.1',
      objIdx: 1,
      propId: 7,
    });
    assert.equal(r.status, 200);
    const data = r.data as { hex: string };
    assert.equal(data.hex, '000f0000');
    assert.ok(mockBus.calls.some((c) => c.method === 'readPropertyMany'));
  });

  it('rejects missing deviceAddress', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/read-property', {
      objIdx: 1,
      propId: 7,
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/write-memory ──────────────────────────────────────────────────

describe('POST /bus/write-memory', () => {
  it('returns 409 when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/write-memory', {
      deviceAddress: '1.1.1',
      address: 0x5f53,
      hex: '00',
    });
    assert.equal(r.status, 409);
  });

  it('writes via downloadDevice with a single WriteRelMem step targeting the exact address', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/write-memory', {
      deviceAddress: '1.1.1',
      address: 0x5f53,
      hex: '00',
    });
    assert.equal(r.status, 200);
    const data = r.data as {
      deviceAddress: string;
      address: number;
      hex: string;
      byteCount: number;
    };
    assert.equal(data.address, 0x5f53);
    assert.equal(data.hex, '00');
    assert.equal(data.byteCount, 1);
    const call = mockBus.calls.find((c) => c.method === 'downloadDevice');
    assert.ok(call, 'expected downloadDevice to be called');
    const [deviceAddr, steps, gaTable, assocTable, paramMem, , extra] =
      call!.args as [
        string,
        Array<{ type: string; objIdx: number; size?: number; offset?: number }>,
        unknown,
        unknown,
        Buffer,
        unknown,
        { resolvedBases?: Record<number, number> },
      ];
    assert.equal(deviceAddr, '1.1.1');
    assert.equal(gaTable, null);
    assert.equal(assocTable, null);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.type, 'WriteRelMem');
    assert.equal(steps[0]!.objIdx, 0);
    assert.equal(steps[0]!.size, 1);
    assert.equal(steps[0]!.offset, 0);
    assert.deepEqual([...paramMem], [0x00]);
    assert.equal(extra.resolvedBases?.[0], 0x5f53);
  });

  it('rejects odd-length hex', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/write-memory', {
      deviceAddress: '1.1.1',
      address: 0x5f53,
      hex: '0',
    });
    assert.equal(r.status, 400);
  });

  it('rejects missing deviceAddress', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/write-memory', {
      address: 0x5f53,
      hex: '00',
    });
    assert.equal(r.status, 400);
  });
});

// ── POST /bus/verify-device ─────────────────────────────────────────────────

describe('POST /bus/verify-device', () => {
  // The device lookup runs before any bus operation - with no device
  // seeded for this address, that's what fails first regardless of
  // connection state (real "not connected" coverage for this route lives
  // in the fixture-backed describe blocks below, where a real device
  // exists to get past this check).
  it('returns 404 for a non-existent device even when not connected', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: '1.1.1',
    });
    assert.equal(r.status, 404);
  });

  it('returns 404 for non-existent device', async () => {
    mockBus.connected = true;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: '1.1.99',
      projectId: 999,
    });
    assert.equal(r.status, 404);
  });

  it('rejects missing deviceAddress', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {});
    assert.equal(r.status, 400);
  });
});

// ── verify-device across ALL device families (read-back byte-diff) ───────────
// Proves the generalized read-back path: an AbsSegment device and a
// property-configured device can both be validated purely by reading the
// device and diffing against the computed bytes — the "program by comparing,
// never writing" capability. Everything here is FICTIONAL: the two device
// application models below are invented for the test and written into the
// app-model directory during setup (removed on teardown); the mock bus serves
// a canned image. No real project, manufacturer product data, or hardware is
// involved.

// A fictional AbsSegment device: address table (LSM 1), association table
// (LSM 2), parameter segment (LSM 3) at 0x4400.
const ABS_APP = 'M-00FA_A-0001-01-ABCD';
const ABS_MODEL = {
  appId: ABS_APP,
  loadProcedures: [
    { type: 'Connect' },
    { type: 'Unload', lsmIdx: 1 },
    { type: 'Unload', lsmIdx: 2 },
    { type: 'Unload', lsmIdx: 3 },
    { type: 'Load', lsmIdx: 1 },
    { type: 'AbsSegment', lsmIdx: 1, address: 16384, size: 7 },
    { type: 'TaskSegment', lsmIdx: 1, address: 16384 },
    { type: 'LoadCompleted', lsmIdx: 1 },
    { type: 'Load', lsmIdx: 2 },
    { type: 'AbsSegment', lsmIdx: 2, address: 16896, size: 4 },
    { type: 'TaskSegment', lsmIdx: 2, address: 16896 },
    { type: 'LoadCompleted', lsmIdx: 2 },
    { type: 'Load', lsmIdx: 3 },
    { type: 'AbsSegment', lsmIdx: 3, address: 17408, size: 8 },
    { type: 'TaskSegment', lsmIdx: 3, address: 17408 },
    { type: 'LoadCompleted', lsmIdx: 3 },
    { type: 'Restart' },
    { type: 'Disconnect' },
  ],
  absSegData: { '17408': { size: 8, hex: '0000000000000000' } },
  paramMemLayout: {
    [`${ABS_APP}_P-1_R-1`]: {
      offset: 4,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '170',
      isText: false,
      isFloat: false,
      fromMemoryChild: false,
      isVisible: true,
    },
  },
  params: { [`${ABS_APP}_P-1_R-1`]: { defaultValue: '170' } },
  dynTree: { main: { items: [] } },
};

// A fictional property-configured device (no downloadable memory image): its
// load procedure is only identity CompareProps + a trigger WriteProp.
const PROP_APP = 'M-00FA_A-0002-01-EF01';
const PROP_MODEL = {
  appId: PROP_APP,
  loadProcedures: [
    { type: 'Connect' },
    { type: 'CompareProp', objIdx: 0, propId: 12, data: '00fa' },
    { type: 'CompareProp', objIdx: 0, propId: 78, data: '0000fa07000a' },
    { type: 'WriteProp', objIdx: 0, propId: 201, data: '' },
    { type: 'Disconnect' },
  ],
  paramMemLayout: {},
  params: {},
  dynTree: { main: { items: [] } },
};

const GA_LINKS = [
  { address: '0/0/1', main_g: 0, middle_g: 0, sub_g: 1 },
  { address: '0/0/2', main_g: 0, middle_g: 0, sub_g: 2 },
  { address: '2/1/2', main_g: 2, middle_g: 1, sub_g: 2 },
  { address: '2/1/3', main_g: 2, middle_g: 1, sub_g: 3 },
];
const CO_ROWS = [
  { object_number: 0, ga_address: '2/1/2' },
  { object_number: 12, ga_address: '2/1/3 2/1/2' },
  { object_number: 48, ga_address: '0/0/1 0/0/2' },
];

const writtenModels: string[] = [];
function writeModel(appRef: string, model: unknown): void {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  const p = path.join(APPS_DIR, `${appRef}.json`);
  fs.writeFileSync(p, JSON.stringify(model));
  writtenModels.push(p);
}

// Seed a device + its GA/com-object rows; returns the device id.
function seedDevice(
  dbmod: typeof import('../server/db.ts'),
  projectId: number,
  addr: string,
  appRef: string,
  gaLinks: {
    address: string;
    main_g: number;
    middle_g: number;
    sub_g: number;
  }[],
  coRows: { object_number: number; ga_address: string }[],
): number {
  dbmod.run(
    // serial_number matches MockBus.readDeviceInfo()'s own default - see
    // that method's doc comment - so /bus/program-device's pre-flight
    // address-confirmation check (added 2026-08-31) passes immediately
    // for every test using this helper, without needing its own
    // programming-mode simulation.
    `INSERT INTO devices (project_id, individual_address, name, app_ref, param_values, serial_number) VALUES (?,?,?,?,?,?)`,
    [projectId, addr, `dev-${addr}`, appRef, '{}', 'aabbccddeeff'],
  );
  const dev = dbmod.get<{ id: number }>(
    'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
    [projectId, addr],
  )!;
  for (const g of gaLinks)
    dbmod.run(
      `INSERT OR IGNORE INTO group_addresses (project_id, address, name, main_g, middle_g, sub_g) VALUES (?,?,?,?,?,?)`,
      [projectId, g.address, g.address, g.main_g, g.middle_g, g.sub_g],
    );
  for (const c of coRows)
    dbmod.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address) VALUES (?,?,?,?)`,
      [projectId, dev.id, c.object_number, c.ga_address],
    );
  return dev.id;
}

after(() => {
  for (const p of writtenModels) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
});

describe('POST /bus/verify-device — AbsSegment read-back diff', () => {
  let projectId: number;
  const deviceAddr = '1.1.30';

  before(() => {
    writeModel(ABS_APP, ABS_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-abs')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-abs'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, ABS_APP, GA_LINKS, CO_ROWS);
  });

  // Recompute the exact bytes verify-device will expect, so the mock bus can
  // serve a byte-perfect (or deliberately corrupted) image.
  function expectedMemMap(): Map<number, number> {
    const gaTable = buildGATable(GA_LINKS);
    const assocTable = buildAssocTable(CO_ROWS, GA_LINKS);
    const { paramSize, paramFill, relSegHex, paramBase } = resolveParamSegment(
      ABS_MODEL as never,
    );
    const paramMem =
      paramSize > 0
        ? buildParamMem(
            paramSize,
            ABS_MODEL.paramMemLayout as never,
            {},
            paramFill,
            relSegHex,
            ABS_MODEL.dynTree as never,
            ABS_MODEL.params as never,
          )
        : null;
    const plan = planVerify(
      ABS_MODEL.loadProcedures as PlanStep[],
      gaTable,
      assocTable,
      paramMem,
      paramBase,
      ABS_MODEL.absSegData as never,
      ABS_MODEL.appId,
    );
    assert.equal(plan.family, 'absmem');
    assert.ok(plan.mem.length > 0);
    const map = new Map<number, number>();
    for (const r of plan.mem)
      for (let i = 0; i < r.expected.length; i++)
        map.set(r.addr + i, r.expected[i]!);
    return map;
  }

  it('reports match=true when the device holds the exact computed bytes', async () => {
    mockBus.connected = true;
    mockBus.memImage = expectedMemMap();
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.family, 'absmem');
    assert.equal(body.match, true);
    assert.equal(body.totalDiffering, 0);
    assert.ok(body.segments.length > 0);
    assert.ok(mockBus.calls.some((c) => c.method === 'readMemory'));
  });

  it('returns 409 when not connected (real device, past the lookup)', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    assert.equal(r.status, 409);
  });

  it('reports match=false when a single config byte differs', async () => {
    mockBus.connected = true;
    const map = expectedMemMap();
    // Corrupt one byte inside the parameter segment (>= 0x4400).
    const target = [...map.keys()].find((a) => a >= 0x4400)!;
    map.set(target, (map.get(target)! ^ 0xff) & 0xff);
    mockBus.memImage = map;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.match, false);
    assert.ok(body.totalDiffering >= 1);
  });
});

describe('POST /bus/verify-device — property-configured device', () => {
  let projectId: number;
  const deviceAddr = '1.0.0';

  before(() => {
    writeModel(PROP_APP, PROP_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-prop')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-prop'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, PROP_APP, [], []);
  });

  it('matches when identity properties read back as expected', async () => {
    mockBus.connected = true;
    // The app compares PID 12 (manufacturer) and PID 78 (hardware type).
    mockBus.propImage = new Map([
      ['0/12', Buffer.from('00fa', 'hex')],
      ['0/78', Buffer.from('0000fa07000a', 'hex')],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.family, 'prop');
    assert.equal(body.match, true);
    assert.ok(body.props.length >= 2);
    assert.ok(mockBus.calls.some((c) => c.method === 'readProperty'));
  });

  it('flags a mismatch when a property differs', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([
      ['0/12', Buffer.from('9999', 'hex')], // wrong manufacturer
      ['0/78', Buffer.from('0000fa07000a', 'hex')],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    const body = r.data as any;
    assert.equal(body.match, false);
  });
});

// A minimal relmem device: one WriteRelMem segment on interface object 4. Used
// to exercise the PID-7 base resolution + zero-pointer guard in program-device.
const RELMEM_APP = 'M-00FB_A-0001-01-AB01';
const RELMEM_MODEL = {
  appId: RELMEM_APP,
  loadProcedures: [
    { type: 'RelSegment', lsmIdx: 4, size: 4 },
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ],
  relSegData: { '4': '00000000' },
  paramMemLayout: {
    [`${RELMEM_APP}_P-1_R-1`]: {
      offset: 0,
      bitOffset: 0,
      bitSize: 8,
      defaultValue: '1',
      isText: false,
      isFloat: false,
      fromMemoryChild: false,
      isVisible: true,
    },
  },
  params: { [`${RELMEM_APP}_P-1_R-1`]: { defaultValue: '1' } },
  dynTree: { main: { items: [] } },
};

describe('POST /bus/program-device — no longer gates on PID 7 upfront', () => {
  let projectId: number;
  const deviceAddr = '1.1.31';

  before(() => {
    writeModel(RELMEM_APP, RELMEM_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('program-relmem')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='program-relmem'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, RELMEM_APP, [], []);
  });

  it('returns 409 when not connected (real device, past the lookup)', async () => {
    mockBus.connected = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    assert.equal(r.status, 409);
  });

  // Real bug, fixed 2026-08-30: this route used to pre-resolve PID 7
  // (PID_TABLE_REFERENCE) and reject the whole request with 409
  // "segment_unallocated" before ever attempting a download - correct for
  // re-programming an already-provisioned device, but wrong for a
  // device's very first-ever download, where PID 7 legitimately starts
  // unallocated and only becomes valid once downloadDevice()'s own
  // Unload/StartLoading/LoadData cycle actually runs (confirmed against a
  // real ETS Full Download capture against a freshly-reset device).
  // downloadDevice() itself (see knx-connection.test.ts) now resolves and
  // handles this per-object internally - this route no longer pre-checks
  // it at all, so even PID 7 reporting unallocated here proceeds straight
  // through to a real downloadDevice() call.
  it('proceeds to downloadDevice() even when PID 7 currently reports unallocated', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([['4/7', Buffer.from('00000000', 'hex')]]);
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);
    assert.equal(
      mockBus.calls.some((c) => c.method === 'downloadDevice'),
      true,
    );
  });
});

// ── program-device: pendingWriteRanges wiring (2026-09-01) ─────────────────
// Real redesign, replacing partial mode's original device-read-and-diff
// mechanism - see DownloadExtra.pendingWriteRanges' own doc comment
// (knx-connection.ts) for the full reasoning. This confirms the actual
// wiring: a real device_pending_changes row resolves through
// resolvePendingWriteRanges() and reaches downloadDevice()'s `extra`
// unchanged, and gets cleared once the download completes.
describe('POST /bus/program-device — pendingWriteRanges wiring', () => {
  let projectId: number;
  const deviceAddr = '1.1.36';
  const paramKey = `${RELMEM_APP}_P-1_R-1`;

  before(() => {
    writeModel(RELMEM_APP, RELMEM_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('program-pending-ranges')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='program-pending-ranges'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, RELMEM_APP, [], []);
  });

  it('resolves a real pending param_value row into extra.pendingWriteRanges and clears it on success', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([['4/7', Buffer.from('00000000', 'hex')]]);
    const dev = ts.db.get<{ id: number }>(
      'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
      [projectId, deviceAddr],
    )!;
    ts.db.run(
      'INSERT INTO device_pending_changes (device_id, kind, key, baseline_value, current_value) VALUES (?,?,?,?,?)',
      [dev.id, 'param_value', paramKey, '1', '5'],
    );

    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
      mode: 'partial',
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);

    const call = mockBus.calls
      .filter((c) => c.method === 'downloadDevice')
      .at(-1)!;
    const extra = call.args[6] as {
      pendingWriteRanges?: Record<number, Array<{ offset: number; length: number }>>;
    };
    // RELMEM_MODEL's param object is 4 bytes (WriteRelMem size:4) - real
    // ETS trailer-byte behavior (see resolvePendingWriteRanges()'s own doc
    // comment) means the object's own final byte (offset 3) is expected
    // alongside the real edit (offset 0), not just the edit alone.
    assert.deepEqual(extra.pendingWriteRanges, {
      4: [
        { offset: 0, length: 1 },
        { offset: 3, length: 1 },
      ],
    });

    const rows = ts.db.all(
      'SELECT * FROM device_pending_changes WHERE device_id=?',
      [dev.id],
    );
    assert.equal(rows.length, 0, 'pending changes should be cleared after a successful download');
  });

  it('passes an empty pendingWriteRanges when nothing is pending for this device', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([['4/7', Buffer.from('00000000', 'hex')]]);
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
      mode: 'partial',
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);

    const call = mockBus.calls
      .filter((c) => c.method === 'downloadDevice')
      .at(-1)!;
    const extra = call.args[6] as {
      pendingWriteRanges?: Record<number, Array<{ offset: number; length: number }>>;
    };
    assert.deepEqual(extra.pendingWriteRanges, {});
  });

  it('omits pendingWriteRanges entirely in full mode (the default)', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([['4/7', Buffer.from('00000000', 'hex')]]);
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);

    const call = mockBus.calls
      .filter((c) => c.method === 'downloadDevice')
      .at(-1)!;
    const extra = call.args[6] as { pendingWriteRanges?: unknown };
    assert.equal(extra.pendingWriteRanges, undefined);
  });
});

// ── program-device: address-by-serial choice, real request 2026-09-01 ──────
// A serial on record was previously only ever used for the fast-path check
// (readDeviceInfo at deviceAddress) - if that failed (e.g. a factory-reset
// device no longer sitting at its assigned address), the route went
// straight into a forced button-press wait with no alternative, even
// though the same serial can locate/readdress the device with no button
// press at all (real-hardware confirmed, docs/knx-device-write-protocol.md
// §9.2). Real ETS offers this as an operator choice; so does this route
// now, gated on the 'auto_address_by_serial' setting.
describe('POST /bus/program-device — address-by-serial choice', () => {
  let projectId: number;
  const deviceAddr = '1.1.32';

  before(() => {
    // RELMEM_MODEL already written by an earlier describe block (writeModel/
    // APPS_DIR is shared, keyed by appId) - no need to re-write it.
    ts.db.run(`INSERT INTO projects (name) VALUES ('program-address-by-serial')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='program-address-by-serial'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, RELMEM_APP, [], []);
  });

  after(() => {
    // This setting is a single global row (server/routes/settings.ts), not
    // scoped per-project - reset it so later describe blocks in this file
    // that also call /bus/program-device aren't silently affected by
    // whatever this block last left it as.
    ts.db.run("UPDATE settings SET value='' WHERE key='auto_address_by_serial'");
    // mockBus is a single shared, file-scoped instance (see `before()`
    // above) - the global beforeEach() only resets calls/connected/host/
    // port/type/projectId, not these two fields, so leaving them set
    // would silently affect every /bus/program-device test elsewhere in
    // this file that runs after this block.
    mockBus.deviceInfoSerialOverride = undefined;
    mockBus.assignBySerialVerified = true;
  });

  beforeEach(() => {
    mockBus.connected = true;
    // seedDevice() always sets serial_number to match readDeviceInfo()'s
    // own default ('aabbccddeeff') - override it here so the fast-path
    // check genuinely fails and the choice logic actually runs, matching
    // a real factory-reset device no longer answering at deviceAddress.
    mockBus.deviceInfoSerialOverride = null;
    mockBus.assignBySerialVerified = true;
    ts.db.run("UPDATE settings SET value='' WHERE key='auto_address_by_serial'");
  });

  it('offers a choice instead of forcing the button-press wait, when auto_address_by_serial is off', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    assert.equal(r.status, 409);
    assert.equal((r.data as any).error, 'address_needs_confirmation');
    assert.equal((r.data as any).canUseSerial, true);
    // No download attempted, no button-press wait started either - a pure
    // "ask the client" response.
    assert.equal(
      mockBus.calls.some((c) => c.method === 'downloadDevice'),
      false,
    );
    assert.equal(
      mockBus.calls.some((c) => c.method === 'checkProgrammingMode'),
      false,
    );
  });

  it('uses serial-based addressing automatically when auto_address_by_serial is on', async () => {
    ts.db.run("UPDATE settings SET value='true' WHERE key='auto_address_by_serial'");
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    assert.equal(r.status, 200);
    assert.equal(
      mockBus.calls.some((c) => c.method === 'assignIndividualAddressBySerial'),
      true,
    );
    assert.equal(
      mockBus.calls.some((c) => c.method === 'downloadDevice'),
      true,
    );
    // The setting decided this on its own - no button-press wait involved.
    assert.equal(
      mockBus.calls.some((c) => c.method === 'checkProgrammingMode'),
      false,
    );
  });

  it('uses serial-based addressing when the client explicitly chooses it (addressMethod:"serial")', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
      addressMethod: 'serial',
    });
    assert.equal(r.status, 200);
    assert.equal(
      mockBus.calls.some((c) => c.method === 'assignIndividualAddressBySerial'),
      true,
    );
    assert.equal(
      mockBus.calls.some((c) => c.method === 'downloadDevice'),
      true,
    );
    // Real bug, found live 2026-09-01: this branch used to declare the
    // address confirmed immediately after a verified serial write, with
    // no wait for the device to actually finish restarting -
    // assignIndividualAddressBySerial()'s own ~3.3s internal settle wait
    // alone wasn't always enough on real hardware, and downloadDevice()
    // connecting immediately afterward genuinely failed. Fixed by reusing
    // the same waitForDeviceBackUp() step the button-press path already
    // had - assert the real call ORDER proves it's actually in the
    // sequence now, not just present somewhere: a readDeviceInfo call
    // AFTER assignIndividualAddressBySerial, still BEFORE downloadDevice.
    const order = mockBus.calls.map((c) => c.method);
    const assignIdx = order.indexOf('assignIndividualAddressBySerial');
    const downloadIdx = order.indexOf('downloadDevice');
    const confirmReadIdx = order.indexOf('readDeviceInfo', assignIdx + 1);
    assert.ok(
      assignIdx !== -1 && confirmReadIdx !== -1 && downloadIdx !== -1,
      'expected assignIndividualAddressBySerial, a follow-up readDeviceInfo, and downloadDevice all present',
    );
    assert.ok(
      assignIdx < confirmReadIdx && confirmReadIdx < downloadIdx,
      `expected order assign(${assignIdx}) < confirm-read(${confirmReadIdx}) < download(${downloadIdx})`,
    );
  });

  it('falls through to the button-press flow when the client explicitly chooses it (addressMethod:"button")', async () => {
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
      addressMethod: 'button',
    });
    // mockBus.checkProgrammingMode() reports a device by default (see its
    // own doc comment) and readDeviceInfo() always resolves once
    // connected, so this reaches a real download here - the pre-existing
    // button-press flow already has its own dedicated coverage elsewhere
    // in this file (found/ambiguous/unconfirmed cases). What matters here
    // is that the CHOICE was honored - the serial-based branch was never
    // touched, even though a serial is on record and the fast-path check
    // failed, exactly the same starting condition the other tests in this
    // block use to go the OTHER way.
    assert.equal(r.status, 200);
    assert.equal(
      mockBus.calls.some((c) => c.method === 'assignIndividualAddressBySerial'),
      false,
    );
    assert.equal(
      mockBus.calls.some((c) => c.method === 'checkProgrammingMode'),
      true,
    );
    assert.equal(
      mockBus.calls.some((c) => c.method === 'programIA'),
      true,
    );
  });

  it('returns serial_address_failed when the serial-based write cannot be verified', async () => {
    mockBus.assignBySerialVerified = false;
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
      addressMethod: 'serial',
    });
    assert.equal(r.status, 409);
    assert.equal((r.data as any).error, 'serial_address_failed');
    assert.equal(
      mockBus.calls.some((c) => c.method === 'downloadDevice'),
      false,
    );
  });
});

// ── verify-device: GA table / Association table fallback (RELMEM_APP declares
// only objIdx 4, matching 1.1.9's real shape - see docs/knx-device-write-
// protocol.md Part 6 in the koolenex repo) ─────────────────────────────────
describe('POST /bus/verify-device — GA/Association table fallback for an app that only declares objIdx 4', () => {
  let projectId: number;
  const deviceAddr = '1.1.33';
  const PARAM_BASE = 0x5000;
  const GA_BASE = 0x6000;
  const ASSOC_BASE = 0x6100;

  before(() => {
    // RELMEM_MODEL is already written by the earlier "relmem zero-pointer
    // guard" describe block above (writeModel/APPS_DIR is shared, keyed by
    // appId) - no need to re-write it.
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-ga-fallback')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-ga-fallback'`,
    )!.id;
    seedDevice(ts.db, projectId, deviceAddr, RELMEM_APP, GA_LINKS, CO_ROWS);
  });

  // Recompute the exact GA/Association table bytes verify-device will
  // expect, from the same GA_LINKS/CO_ROWS fixtures used elsewhere in this
  // file, matching buildGATable()/buildAssocTable()'s real (corrected)
  // wire format.
  const gaTable = buildGATable(GA_LINKS);
  const assocTable = buildAssocTable(CO_ROWS, GA_LINKS);
  // 4-byte param segment (RELMEM_MODEL declares size:4) - content doesn't
  // matter for this test, just needs to exist and match itself.
  const paramMem = Buffer.from([0x01, 0x00, 0x00, 0x00]);

  function seedPropAndMem(actualGaTable: Buffer, actualAssocTable: Buffer) {
    mockBus.propImage = new Map([
      ['4/7', Buffer.from([0, 0, PARAM_BASE >> 8, PARAM_BASE & 0xff])],
      ['1/7', Buffer.from([0, 0, GA_BASE >> 8, GA_BASE & 0xff])],
      ['2/7', Buffer.from([0, 0, ASSOC_BASE >> 8, ASSOC_BASE & 0xff])],
    ]);
    const map = new Map<number, number>();
    for (let i = 0; i < paramMem.length; i++) map.set(PARAM_BASE + i, paramMem[i]!);
    for (let i = 0; i < actualGaTable.length; i++)
      map.set(GA_BASE + i, actualGaTable[i]!);
    for (let i = 0; i < actualAssocTable.length; i++)
      map.set(ASSOC_BASE + i, actualAssocTable[i]!);
    mockBus.memImage = map;
  }

  it('adds one GA comparison row per linked communication object when the device holds the correct tables', async () => {
    mockBus.connected = true;
    seedPropAndMem(gaTable, assocTable);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    const gaRows = (body.decoded ?? []).filter(
      (d: any) => d.section === 'Group Addresses',
    );
    // CO_ROWS: object 0 -> '2/1/2' (1 GA), object 12 -> '2/1/3 2/1/2' (2 GAs,
    // must both survive - the multi-GA-per-object aggregation bug this test
    // was written to catch), object 48 -> '0/0/1 0/0/2' (2 GAs).
    assert.equal(gaRows.length, 3);
    const byCO = new Map(gaRows.map((r: any) => [r.key, r]));
    const co0 = byCO.get('co-0-ga') as any;
    assert.equal(co0.expectedValue, '2/1/2');
    assert.equal(co0.actualValue, '2/1/2');
    assert.equal(co0.match, true);
    const co12 = byCO.get('co-12-ga') as any;
    // buildAssocTable() preserves the real declared entry order (fixed
    // 2026-08-30 - it used to sort by gaIndex ascending, discarding the
    // order in CO_ROWS's own ga_address string; see its own doc comment).
    // '2/1/3 2/1/2' is CO_ROWS's own declared order for object 12.
    assert.equal(co12.expectedValue, '2/1/3 2/1/2');
    assert.equal(co12.actualValue, '2/1/3 2/1/2');
    assert.equal(co12.match, true);
    const co48 = byCO.get('co-48-ga') as any;
    assert.equal(co48.expectedValue, '0/0/1 0/0/2');
    assert.equal(co48.actualValue, '0/0/1 0/0/2');
    assert.equal(co48.match, true);
    // Named-parameter row(s) for objIdx 4 should still be present alongside
    // the GA rows, not replaced by them.
    assert.ok((body.decoded ?? []).some((d: any) => d.section !== 'Group Addresses'));
    // GA/Association bytes must NOT be folded into the raw byte totals -
    // those stay scoped to the parameter segment only (4 bytes).
    assert.equal(body.totalBytes, paramMem.length);
  });

  it('flags a mismatch when the device\'s actual GA table differs from the project', async () => {
    mockBus.connected = true;
    // Device's real GA/Association tables only carry object 0's own link
    // (2/1/2 = GA_LINKS[2]) - object 12's links and object 48 entirely are
    // missing on the device side, so they should mismatch while object 0
    // stays correct.
    const corruptedGa = buildGATable([GA_LINKS[2]!]);
    const corruptedAssoc = buildAssocTable(
      CO_ROWS.filter((c) => c.object_number === 0),
      [GA_LINKS[2]!],
    );
    seedPropAndMem(corruptedGa, corruptedAssoc);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    const gaRows = (body.decoded ?? []).filter(
      (d: any) => d.section === 'Group Addresses',
    );
    const byCO = new Map(gaRows.map((r: any) => [r.key, r]));
    assert.equal((byCO.get('co-0-ga') as any).match, true);
    assert.equal((byCO.get('co-12-ga') as any).match, false);
    assert.equal((byCO.get('co-48-ga') as any).match, false);
  });

  // Regression test for a real bug found on real hardware (2026-08-29):
  // sizing the actual-bytes read off the PROJECT's currently-computed
  // "expected" buffer, rather than the device's own real on-device table
  // size - if the project's GA/Association tables happen to be SMALLER
  // than what's genuinely on the device (e.g. a GA link was just removed
  // in the project, or the device was programmed with more entries than
  // the project currently declares), the read silently truncates and
  // decodes the device's real, larger table as if the entries past the
  // truncation point don't exist - reporting them as missing/null instead
  // of what's really there.
  it('reads the device\'s real table size, not the project\'s currently-smaller expected size', async () => {
    mockBus.connected = true;
    // Project currently only expects object 0's link (as if object 12's
    // and 48's GA links were just removed, matching what actually happened
    // live) - a SHORTER table than what's really on the device.
    ts.db.run(
      `UPDATE com_objects SET ga_address='' WHERE device_id=(SELECT id FROM devices WHERE project_id=? AND individual_address=?) AND object_number IN (12,48)`,
      [projectId, deviceAddr],
    );
    // Device's real bytes are unchanged - still the FULL table (all three
    // objects' links), exactly as if it was programmed before the project
    // edit and never re-downloaded since.
    seedPropAndMem(gaTable, assocTable);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    // Restore for any later test in this file that might reuse this device.
    ts.db.run(
      `UPDATE com_objects SET ga_address='2/1/3 2/1/2' WHERE device_id=(SELECT id FROM devices WHERE project_id=? AND individual_address=?) AND object_number=12`,
      [projectId, deviceAddr],
    );
    ts.db.run(
      `UPDATE com_objects SET ga_address='0/0/1 0/0/2' WHERE device_id=(SELECT id FROM devices WHERE project_id=? AND individual_address=?) AND object_number=48`,
      [projectId, deviceAddr],
    );
    assert.equal(r.status, 200);
    const body = r.data as any;
    const gaRows = (body.decoded ?? []).filter(
      (d: any) => d.section === 'Group Addresses',
    );
    const byCO = new Map(gaRows.map((r: any) => [r.key, r]));
    // Object 0 still matches (project and device agree).
    assert.equal((byCO.get('co-0-ga') as any).match, true);
    // Objects 12/48 mismatch (project no longer expects a link) - but their
    // REAL device values must still be correctly recovered, not silently
    // dropped to null by a truncated read.
    const co12 = byCO.get('co-12-ga') as any;
    assert.equal(co12.expectedValue, '(none)');
    // '2/1/3 2/1/2' - the real declared order (see buildAssocTable()'s own
    // fix, 2026-08-30): `assocTable` above is built from CO_ROWS's own
    // declared ga_address order, not re-sorted by gaIndex.
    assert.equal(co12.actualValue, '2/1/3 2/1/2');
    assert.equal(co12.match, false);
    const co48 = byCO.get('co-48-ga') as any;
    assert.equal(co48.expectedValue, '(none)');
    assert.equal(co48.actualValue, '0/0/1 0/0/2');
    assert.equal(co48.match, false);
  });
});

// ── verify-device/recompute: local (no-bus) re-diff against cached device
// data — real user feedback, 2026-08-31: "If we have previously verified
// the device and have its data in cache, why make it stale when DB items
// are modified? ... Better we just re-run the comparison of our modified
// DB values against the previously cached device values." ─────────────────
describe('POST /bus/verify-device/recompute', () => {
  let projectId: number;
  let deviceId: number;
  const deviceAddr = '1.1.34';
  const PARAM_BASE = 0x5200;
  const GA_BASE = 0x6200;
  const ASSOC_BASE = 0x6300;
  const gaTable = buildGATable(GA_LINKS);
  const assocTable = buildAssocTable(CO_ROWS, GA_LINKS);
  const paramMem = Buffer.from([0x01, 0x00, 0x00, 0x00]);

  before(() => {
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-recompute')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='verify-recompute'`,
    )!.id;
    deviceId = seedDevice(
      ts.db,
      projectId,
      deviceAddr,
      RELMEM_APP,
      GA_LINKS,
      CO_ROWS,
    );
  });

  // Gets a genuine cached VerifyDeviceResult by running a real (mocked)
  // /bus/verify-device against a device that currently matches exactly -
  // the recompute tests below then edit the DB and recompute LOCALLY
  // against this same cached result, with no further bus access.
  async function realVerify(): Promise<any> {
    mockBus.connected = true;
    mockBus.propImage = new Map([
      ['4/7', Buffer.from([0, 0, PARAM_BASE >> 8, PARAM_BASE & 0xff])],
      ['1/7', Buffer.from([0, 0, GA_BASE >> 8, GA_BASE & 0xff])],
      ['2/7', Buffer.from([0, 0, ASSOC_BASE >> 8, ASSOC_BASE & 0xff])],
    ]);
    const map = new Map<number, number>();
    for (let i = 0; i < paramMem.length; i++) map.set(PARAM_BASE + i, paramMem[i]!);
    for (let i = 0; i < gaTable.length; i++) map.set(GA_BASE + i, gaTable[i]!);
    for (let i = 0; i < assocTable.length; i++)
      map.set(ASSOC_BASE + i, assocTable[i]!);
    mockBus.memImage = map;
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    assert.equal((r.data as any).match, true);
    return r.data;
  }

  it('returns 404 for a device that does not exist', async () => {
    const cached = await realVerify();
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device/recompute', {
      deviceId: 999999,
      cached,
    });
    assert.equal(r.status, 404);
  });

  it('recomputes clean (no changes) with no bus calls, reusing the cached actual bytes', async () => {
    const cached = await realVerify();
    mockBus.calls = [];
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device/recompute', {
      deviceId,
      cached,
    });
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.match, true);
    assert.equal(body.totalDiffering, 0);
    assert.ok(typeof body.recomputedAt === 'number');
    // The whole point - no bus interaction at all for a recompute.
    assert.deepEqual(mockBus.calls, []);
  });

  it('flags a GA-link row as mismatched after the project GA link changes, without touching the device side', async () => {
    const cached = await realVerify();
    // Change com object 0's GA link in the DB - the device side (what's
    // cached in `cached`) is untouched.
    ts.db.run(
      `UPDATE com_objects SET ga_address=?, ga_send=?, ga_receive=? WHERE device_id=? AND object_number=0`,
      ['2/1/3', '2/1/3', '2/1/3', deviceId],
    );
    mockBus.calls = [];
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device/recompute', {
      deviceId,
      cached,
    });
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.match, false);
    assert.deepEqual(mockBus.calls, []);
    const co0 = (body.decoded ?? []).find((d: any) => d.key === 'co-0-ga');
    assert.equal(co0.expectedValue, '2/1/3');
    assert.equal(co0.actualValue, '2/1/2'); // unchanged - the device's own last real reading
    assert.equal(co0.match, false);
    // Untouched rows still report a clean match.
    const co12 = (body.decoded ?? []).find((d: any) => d.key === 'co-12-ga');
    assert.equal(co12.match, true);

    // Restore for the next test.
    ts.db.run(
      `UPDATE com_objects SET ga_address=?, ga_send=?, ga_receive=? WHERE device_id=? AND object_number=0`,
      ['2/1/2', '2/1/2', '2/1/2', deviceId],
    );
  });

  it('flags the parameter row as mismatched after a param value changes', async () => {
    const cached = await realVerify();
    ts.db.run(`UPDATE devices SET param_values=? WHERE id=?`, [
      JSON.stringify({ [`${RELMEM_APP}_P-1_R-1`]: '99' }),
      deviceId,
    ]);
    mockBus.calls = [];
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device/recompute', {
      deviceId,
      cached,
    });
    assert.equal(r.status, 200);
    const body = r.data as any;
    assert.equal(body.match, false);
    assert.ok(body.totalDiffering > 0);
    assert.deepEqual(mockBus.calls, []);
    const paramRow = (body.decoded ?? []).find(
      (d: any) => d.key === `${RELMEM_APP}_P-1_R-1`,
    );
    assert.ok(paramRow);
    assert.equal(paramRow.match, false);

    // Restore for isolation from any later test reusing this device.
    ts.db.run(`UPDATE devices SET param_values=? WHERE id=?`, ['{}', deviceId]);
  });
});

// ── program-device: buildDeviceProgramming() constructs a real Object 3
// (Group Object Table) and passes it through to downloadDevice() (2026-08-29)
// ─────────────────────────────────────────────────────────────────────────
const OBJ3_APP = 'M-00FB_A-0002-01-AB01';
const OBJ3_MODEL = {
  appId: OBJ3_APP,
  loadProcedures: [
    { type: 'RelSegment', lsmIdx: 4, size: 4 },
    { type: 'WriteRelMem', objIdx: 4, offset: 0, size: 4 },
  ],
  relSegData: { '4': '00000000' },
  paramMemLayout: {},
  params: {},
  dynTree: { main: { items: [] } },
  // The value under test - see ParamModel.groupObjectTableSize's doc
  // comment (ets-app.ts) for the real-hardware-verified formula this
  // mirrors (2 x maxComObjectNumber + 2).
  groupObjectTableSize: 20,
};

describe('POST /bus/program-device — builds and passes a real Object 3 (Group Object Table)', () => {
  let projectId: number;
  const deviceAddr = '1.1.34';
  const GA_BASE = 0x7000;
  const ASSOC_BASE = 0x7100;
  const OBJ3_BASE = 0x7200;
  const PARAM_BASE = 0x7300;

  before(() => {
    writeModel(OBJ3_APP, OBJ3_MODEL);
    ts.db.run(`INSERT INTO projects (name) VALUES ('program-obj3')`);
    projectId = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='program-obj3'`,
    )!.id;
    ts.db.run(
      // serial_number matches MockBus.readDeviceInfo()'s own default - see
      // seedDevice()'s identical comment above.
      `INSERT INTO devices (project_id, individual_address, name, app_ref, param_values, serial_number) VALUES (?,?,?,?,?,?)`,
      [projectId, deviceAddr, `dev-${deviceAddr}`, OBJ3_APP, '{}', 'aabbccddeeff'],
    );
    const dev = ts.db.get<{ id: number }>(
      'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
      [projectId, deviceAddr],
    )!;
    ts.db.run(
      `INSERT OR IGNORE INTO group_addresses (project_id, address, name, main_g, middle_g, sub_g) VALUES (?,?,?,?,?,?)`,
      [projectId, '2/1/2', '2/1/2', 2, 1, 2],
    );
    // Object 5: linked, Read-On-Init on, Priority=alarm, Read+Communication
    // (Write/Transmit/Update off) - exercises every new column at once.
    ts.db.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address, read_on_init, priority, read, write, comm, tx, flags) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [projectId, dev.id, 5, '2/1/2', 1, 'alarm', 1, 0, 1, 0, 'CR'],
    );
    // Object 7: unlinked, real 1.1.9-shaped default (Communication+Transmit
    // on, Read-On-Init/Priority both absent -> readOnInit=false/'low').
    ts.db.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address, read, write, comm, tx, flags) VALUES (?,?,?,?,?,?,?,?,?)`,
      [projectId, dev.id, 7, '', 0, 1, 1, 1, 'CWT'],
    );
  });

  it('constructs Object 3 from the real com_objects columns (read_on_init/priority/read/write/comm/tx) and passes it as extra.groupObjectTable', async () => {
    mockBus.connected = true;
    mockBus.propImage = new Map([
      ['4/7', Buffer.from([0, 0, PARAM_BASE >> 8, PARAM_BASE & 0xff])],
      ['1/7', Buffer.from([0, 0, GA_BASE >> 8, GA_BASE & 0xff])],
      ['2/7', Buffer.from([0, 0, ASSOC_BASE >> 8, ASSOC_BASE & 0xff])],
      ['3/7', Buffer.from([0, 0, OBJ3_BASE >> 8, OBJ3_BASE & 0xff])],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);

    const call = mockBus.calls.find((c) => c.method === 'downloadDevice');
    assert.ok(call, 'expected downloadDevice to be called');
    const extra = call!.args[6] as { groupObjectTable?: Buffer | null };
    assert.ok(extra.groupObjectTable, 'expected extra.groupObjectTable to be set');

    const expectedFlags: GroupObjectFlags[] = [
      {
        object_number: 5,
        update: false,
        transmit: false,
        readOnInit: true,
        write: false,
        read: true,
        communication: true,
        linked: true,
        priority: 'alarm',
      },
      {
        object_number: 7,
        update: false,
        transmit: true,
        readOnInit: false,
        write: true,
        read: false,
        communication: true,
        linked: false,
        priority: 'low',
      },
    ];
    const expected = buildGroupObjectTable(
      OBJ3_MODEL.groupObjectTableSize,
      expectedFlags,
    );
    assert.deepEqual([...extra.groupObjectTable!], [...expected]);
    assert.equal(extra.groupObjectTable!.length, OBJ3_MODEL.groupObjectTableSize);
  });

  it('omits groupObjectTable (null) when the app model has no groupObjectTableSize', async () => {
    mockBus.connected = true;
    // Reuse RELMEM_APP/RELMEM_MODEL (declared earlier in this file) -
    // identical shape, but with no groupObjectTableSize field at all.
    ts.db.run(`INSERT INTO projects (name) VALUES ('program-obj3-none')`);
    const noObj3Project = ts.db.get<{ id: number }>(
      `SELECT id FROM projects WHERE name='program-obj3-none'`,
    )!.id;
    const addr = '1.1.35';
    seedDevice(ts.db, noObj3Project, addr, RELMEM_APP, [], []);
    mockBus.propImage = new Map([
      ['4/7', Buffer.from([0, 0, PARAM_BASE >> 8, PARAM_BASE & 0xff])],
    ]);
    const r = await req(ts.baseUrl, 'POST', '/bus/program-device', {
      deviceAddress: addr,
      projectId: noObj3Project,
    });
    mockBus.propImage = null;
    assert.equal(r.status, 200);
    const call = [...mockBus.calls]
      .reverse()
      .find((c) => c.method === 'downloadDevice');
    assert.ok(call, 'expected downloadDevice to be called');
    const extra = call!.args[6] as { groupObjectTable?: Buffer | null };
    assert.equal(extra.groupObjectTable, null);
  });
});

// ── verify-device: Object 3 (Group Object Table) fallback, added 2026-08-29
// alongside the real-hardware write confirmation (docs/knx-device-write-
// protocol.md Part 18) and the buildUndeclaredTableMem() LoadImageProp bug
// fix (knx-download-plan.ts). Reuses OBJ3_APP/OBJ3_MODEL from the
// program-device Object 3 tests above - same "fake" MockBus device, this
// time serving reads (propImage/memImage) instead of recording a write. ──
describe('POST /bus/verify-device — Object 3 (Group Object Table) fallback', () => {
  let projectId: number;
  const deviceAddr = '1.1.36';
  const GA_BASE = 0x7400;
  const ASSOC_BASE = 0x7500;
  const OBJ3_BASE = 0x7600;
  const PARAM_BASE = 0x7700;

  const expectedFlags: GroupObjectFlags[] = [
    {
      object_number: 5,
      update: false,
      transmit: false,
      readOnInit: true,
      write: false,
      read: true,
      communication: true,
      linked: true,
      priority: 'alarm',
    },
    {
      object_number: 7,
      update: false,
      transmit: true,
      readOnInit: false,
      write: true,
      read: false,
      communication: true,
      linked: false,
      priority: 'low',
    },
  ];
  const expectedObj3 = buildGroupObjectTable(OBJ3_MODEL.groupObjectTableSize, expectedFlags);
  // 4-byte param segment (OBJ3_MODEL declares size:4 via its RelSegment step).
  const paramMem = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const gaTable = buildGATable([{ address: '2/1/2', main_g: 2, middle_g: 1, sub_g: 2 }]);
  const assocTable = buildAssocTable(
    [{ object_number: 5, ga_address: '2/1/2' }],
    [{ address: '2/1/2', main_g: 2, middle_g: 1, sub_g: 2 }],
  );

  before(() => {
    // OBJ3_APP/OBJ3_MODEL already written by the program-device describe
    // block above (writeModel/APPS_DIR is shared, keyed by appId).
    ts.db.run(`INSERT INTO projects (name) VALUES ('verify-obj3')`);
    projectId = ts.db.get<{ id: number }>(`SELECT id FROM projects WHERE name='verify-obj3'`)!.id;
    ts.db.run(
      // serial_number matches MockBus.readDeviceInfo()'s own default - see
      // seedDevice()'s identical comment above.
      `INSERT INTO devices (project_id, individual_address, name, app_ref, param_values, serial_number) VALUES (?,?,?,?,?,?)`,
      [projectId, deviceAddr, `dev-${deviceAddr}`, OBJ3_APP, '{}', 'aabbccddeeff'],
    );
    const dev = ts.db.get<{ id: number }>(
      'SELECT id FROM devices WHERE project_id=? AND individual_address=?',
      [projectId, deviceAddr],
    )!;
    ts.db.run(
      `INSERT OR IGNORE INTO group_addresses (project_id, address, name, main_g, middle_g, sub_g) VALUES (?,?,?,?,?,?)`,
      [projectId, '2/1/2', '2/1/2', 2, 1, 2],
    );
    ts.db.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address, read_on_init, priority, read, write, comm, tx, flags) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [projectId, dev.id, 5, '2/1/2', 1, 'alarm', 1, 0, 1, 0, 'CR'],
    );
    ts.db.run(
      `INSERT INTO com_objects (project_id, device_id, object_number, ga_address, read, write, comm, tx, flags) VALUES (?,?,?,?,?,?,?,?,?)`,
      [projectId, dev.id, 7, '', 0, 1, 1, 1, 'CWT'],
    );
  });

  function seedReads(actualObj3: Buffer): void {
    mockBus.propImage = new Map([
      ['4/7', Buffer.from([0, 0, PARAM_BASE >> 8, PARAM_BASE & 0xff])],
      ['1/7', Buffer.from([0, 0, GA_BASE >> 8, GA_BASE & 0xff])],
      ['2/7', Buffer.from([0, 0, ASSOC_BASE >> 8, ASSOC_BASE & 0xff])],
      ['3/7', Buffer.from([0, 0, OBJ3_BASE >> 8, OBJ3_BASE & 0xff])],
    ]);
    const map = new Map<number, number>();
    for (let i = 0; i < paramMem.length; i++) map.set(PARAM_BASE + i, paramMem[i]!);
    for (let i = 0; i < gaTable.length; i++) map.set(GA_BASE + i, gaTable[i]!);
    for (let i = 0; i < assocTable.length; i++) map.set(ASSOC_BASE + i, assocTable[i]!);
    for (let i = 0; i < actualObj3.length; i++) map.set(OBJ3_BASE + i, actualObj3[i]!);
    mockBus.memImage = map;
  }

  it('adds one Object 3 comparison row per communication object when the device holds the correct table', async () => {
    mockBus.connected = true;
    seedReads(expectedObj3);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    const obj3Rows = (body.decoded ?? []).filter(
      (d: any) => d.section === 'Group Object Table',
    );
    assert.equal(obj3Rows.length, 2);
    const byKey = new Map(obj3Rows.map((r: any) => [r.key, r]));
    const co5 = byKey.get('co-5-obj3') as any;
    assert.equal(co5.match, true);
    assert.equal(co5.expectedValue, co5.actualValue);
    // Human-readable, not a raw hex byte pair - covers object 5's real
    // expected flags (readOnInit=true, write=false, read=true, comm=true,
    // linked=true, priority=alarm) plus its size code (default -> 1 Bit).
    assert.match(co5.expectedValue, /ReadOnInit=Yes/);
    assert.match(co5.expectedValue, /Write=No/);
    assert.match(co5.expectedValue, /Read=Yes/);
    assert.match(co5.expectedValue, /Comm\+Linked=Yes/);
    assert.match(co5.expectedValue, /Priority=Alarm/);
    assert.match(co5.expectedValue, /Size=1 Bit/);
    // Structured flags for the per-flag chip display (2026-08-29) - real
    // booleans, not a string to re-parse, mirroring the same expectations.
    assert.deepEqual(co5.obj3Expected, {
      update: false,
      transmit: false,
      readOnInit: true,
      write: false,
      read: true,
      commLinked: true,
      priority: 'Alarm',
      size: '1 Bit',
    });
    assert.deepEqual(co5.obj3Actual, co5.obj3Expected);
    const co7 = byKey.get('co-7-obj3') as any;
    assert.equal(co7.match, true);
    // object 7: transmit=true, write=true, read=false, comm=true,
    // linked=false (so Comm+Linked=No despite comm=true), priority=low.
    assert.match(co7.expectedValue, /Transmit=Yes/);
    assert.match(co7.expectedValue, /Write=Yes/);
    assert.match(co7.expectedValue, /Comm\+Linked=No/);
    assert.match(co7.expectedValue, /Priority=Low/);
    // Object 3 rows stay out of the raw-byte scope (matches GA rows' own convention).
    assert.equal(body.totalBytes, paramMem.length);
    // Top-level match must still be true when everything genuinely matches
    // (the fix below only needed to catch the false-true case, not
    // introduce a false-false one).
    assert.equal(body.match, true);
  });

  it('flags a mismatch when the device\'s actual Object 3 content differs from the project', async () => {
    mockBus.connected = true;
    const corrupted = Buffer.from(expectedObj3);
    corrupted[14] ^= 0xff; // object 7's flag byte (offset 2*7)
    seedReads(corrupted);
    const r = await req(ts.baseUrl, 'POST', '/bus/verify-device', {
      deviceAddress: deviceAddr,
      projectId,
    });
    mockBus.propImage = null;
    mockBus.memImage = null;
    assert.equal(r.status, 200);
    const body = r.data as any;
    const obj3Rows = (body.decoded ?? []).filter(
      (d: any) => d.section === 'Group Object Table',
    );
    const byKey = new Map(obj3Rows.map((r: any) => [r.key, r]));
    assert.equal((byKey.get('co-5-obj3') as any).match, true);
    assert.equal((byKey.get('co-7-obj3') as any).match, false);
    // Regression test for a real bug found live, 2026-08-29: the top-level
    // `match` flag was computed purely from `totalDiffering === 0` (raw
    // parameter memory bytes only - Object 3 is deliberately kept OUT of
    // that scope), so a genuine Object 3 mismatch here previously left
    // `body.match` reporting `true` ("matches computed image") even while a
    // real row showed `match: false` - visibly inconsistent between the
    // top-level summary/log line and the per-row table. `match` must now
    // reflect every decoded row too, not just the raw byte total.
    assert.equal(
      body.match,
      false,
      'top-level match must be false when any decoded row (here, Object 3) differs, even if raw parameter bytes match exactly',
    );
  });
});
