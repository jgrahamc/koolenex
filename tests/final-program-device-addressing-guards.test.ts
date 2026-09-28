/**
 * runProgramDevice(): guards that run after a device has been (re)addressed and
 * before anything is downloaded to it.
 *
 *  - Manufacturer mismatch: refused with `manufacturer_mismatch` at BOTH
 *    re-addressing paths - locating the device by its serial number, and
 *    identifying it via its programming button - not only when the device was
 *    already answering at the target address.
 *  - Occupied address (programming-button path): when a DIFFERENT device already
 *    answers at the target address, writing that address onto the device in
 *    programming mode would leave two devices on one address, so the route
 *    answers `address_occupied` and neither addresses nor downloads anything.
 *
 * The bus is a scripted stand-in: readDeviceInfo() answers from a queue (the
 * last entry repeats), so a test can say "nothing/someone else answers at the
 * target first, then this device answers after the address write".
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';
import fs from 'node:fs';
import path from 'node:path';

import { createTestServer, type TestServer } from './helpers.ts';
import { APPS_DIR } from '../server/routes/shared.ts';
import { runProgramDevice } from '../server/routes/bus.ts';

const DEV_ADDR = '1.1.61';
const RECORDED_SERIAL = 'aabbccddeeff';
const NEW_UNIT_SERIAL = '112233445566';
const OCCUPANT_SERIAL = 'ffeeddccbbaa';

type Info = {
  serialNumber?: string;
  manufacturerId?: number;
};

class ScriptedBus extends EventEmitter {
  connected = true;
  calls: string[] = [];
  progress: string[] = [];
  /** null = the device does not answer (readDeviceInfo throws). */
  infoScript: Array<Info | null> = [];
  private infoIdx = 0;
  serialsInProgrammingMode: Array<{ serial: string; src: string }> = [];
  assignVerified = true;

  reset(): void {
    this.calls = [];
    this.progress = [];
    this.infoScript = [];
    this.infoIdx = 0;
    this.serialsInProgrammingMode = [];
    this.assignVerified = true;
  }

  addKeepAliveRef(): () => void {
    return () => {};
  }
  broadcast(_evt: string, payload: { msg?: string }): void {
    if (payload?.msg) this.progress.push(payload.msg);
  }
  async forceReconnect(): Promise<void> {}

  async readDeviceInfo(
    deviceAddr: string,
  ): Promise<Info & Record<string, unknown>> {
    this.calls.push('readDeviceInfo');
    const idx = Math.min(this.infoIdx++, this.infoScript.length - 1);
    const entry = this.infoScript[idx];
    if (!entry) throw new Error('No answer from device');
    return { descriptor: '07b0', address: deviceAddr, ...entry };
  }
  // No live program-version answer: that check is skipped, leaving only the
  // manufacturer comparison against readDeviceInfo()'s result under test.
  async readPropertyMany(
    _addr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]> {
    return reads.map(() => Buffer.alloc(0));
  }
  async readSerialNumbersInProgrammingMode(): Promise<
    Array<{ serial: string; src: string }>
  > {
    this.calls.push('readSerialNumbersInProgrammingMode');
    return this.serialsInProgrammingMode;
  }
  async checkProgrammingMode(): Promise<{ address: string | null }> {
    this.calls.push('checkProgrammingMode');
    return { address: null };
  }
  async programIA(newAddr: string): Promise<{ ok: boolean; newAddr: string }> {
    this.calls.push('programIA');
    return { ok: true, newAddr };
  }
  async assignIndividualAddressBySerial(): Promise<{
    ok: boolean;
    verified: boolean;
    address: string | null;
  }> {
    this.calls.push('assignIndividualAddressBySerial');
    return { ok: true, verified: this.assignVerified, address: DEV_ADDR };
  }
  async downloadDevice(): Promise<{
    unconfirmedWrites: number;
    unconfirmedDetails: string[];
    verificationIssues: string[];
  }> {
    this.calls.push('downloadDevice');
    return {
      unconfirmedWrites: 0,
      unconfirmedDetails: [],
      verificationIssues: [],
    };
  }

  did(call: string): boolean {
    return this.calls.includes(call);
  }
}

let ts: TestServer;
const bus = new ScriptedBus();
const writtenModels: string[] = [];
let counter = 0;

function writeModel(appRef: string, model: unknown): void {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  const p = path.join(APPS_DIR, `${appRef}.json`);
  fs.writeFileSync(p, JSON.stringify(model));
  writtenModels.push(p);
}

/** Seeds a project + a device with a recorded serial; returns the row. */
function seed(): { dev: any; pid: number } {
  // Manufacturer 0x00FA comes from the application Id.
  const appRef = `M-00FA_A-0001-01-GRD${++counter}`;
  writeModel(appRef, {
    appId: appRef,
    loadProcedures: [{ type: 'Connect' }],
    params: {},
  });
  ts.db.run("INSERT INTO projects (name) VALUES ('addressing-guards')");
  const pid = ts.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  ts.db.run(
    `INSERT INTO devices (project_id, individual_address, name, app_ref, param_values, serial_number) VALUES (?,?,?,?,?,?)`,
    [pid, DEV_ADDR, `dev-${DEV_ADDR}`, appRef, '{}', RECORDED_SERIAL],
  );
  const dev = ts.db.get<any>(
    'SELECT * FROM devices WHERE project_id=? AND individual_address=?',
    [pid, DEV_ADDR],
  )!;
  return { dev, pid };
}

async function run(
  addressMethod: 'button' | 'serial',
): Promise<{ result: { status: number; body: any }; dev: any }> {
  const { dev, pid } = seed();
  const result = await runProgramDevice(
    bus as any,
    dev,
    {
      deviceAddress: DEV_ADDR,
      projectId: pid,
      deviceId: dev.id,
      mode: 'full',
      addressMethod,
    },
    () => false,
    { confirmDeadlineMs: 200 },
  );
  assert.ok(result, 'expected a response, not an abort');
  return { result: result as { status: number; body: any }, dev };
}

const storedSerial = (id: number): string =>
  ts.db.get<{ serial_number: string }>(
    'SELECT serial_number FROM devices WHERE id=?',
    [id],
  )!.serial_number;

before(async () => {
  ts = await createTestServer();
});
after(() => {
  for (const p of writtenModels) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  ts.close();
});
beforeEach(() => bus.reset());

describe('runProgramDevice(): manufacturer check after addressing by serial', () => {
  it('refuses a device from a different manufacturer and never downloads', async () => {
    // Pre-flight: nothing answers at the target. After the serial-based
    // address write, the device answers - but as another manufacturer's.
    bus.infoScript = [
      null,
      { serialNumber: RECORDED_SERIAL, manufacturerId: 0x0004 },
    ];
    const { result } = await run('serial');

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'manufacturer_mismatch');
    assert.match(result.body.message, /0x0004/);
    assert.match(result.body.message, /0x00fa/);
    assert.ok(bus.did('assignIndividualAddressBySerial'));
    assert.equal(bus.did('downloadDevice'), false);
    assert.ok(
      bus.progress.some((m) =>
        m.includes('Manufacturer check (after addressing by serial)'),
      ),
      'the refusal comes from the after-addressing-by-serial check',
    );
    // The address write already happened by this point (it's what let
    // this check run at all - a KNX identity read needs a resolvable
    // address first) - the message must say so, not read as if nothing
    // was written, and it must name the actual device now holding the
    // address (RECORDED_SERIAL - the same device this session located and
    // wrote to), not just the address itself.
    assert.equal(result.body.addressAlreadyWritten, true);
    assert.match(
      result.body.message,
      /already been written to a device with serial/,
    );
    assert.match(result.body.message, new RegExp(RECORDED_SERIAL));
  });

  it('proceeds to the download when the manufacturer matches', async () => {
    bus.infoScript = [
      null,
      { serialNumber: RECORDED_SERIAL, manufacturerId: 0x00fa },
    ];
    const { result } = await run('serial');

    assert.equal(result.status, 200);
    assert.ok(bus.did('downloadDevice'));
  });
});

describe('runProgramDevice(): manufacturer check after addressing by programming button', () => {
  it('refuses a device from a different manufacturer, never downloads, and leaves the recorded serial alone', async () => {
    bus.infoScript = [
      null, // nothing answers at the target address yet
      { serialNumber: NEW_UNIT_SERIAL, manufacturerId: 0x0004 },
    ];
    bus.serialsInProgrammingMode = [
      { src: '15.15.255', serial: NEW_UNIT_SERIAL },
    ];
    const { result, dev } = await run('button');

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'manufacturer_mismatch');
    assert.equal(bus.did('downloadDevice'), false);
    assert.equal(result.body.addressAlreadyWritten, true);
    assert.match(
      result.body.message,
      /already been written to a device with serial/,
    );
    assert.match(result.body.message, new RegExp(NEW_UNIT_SERIAL));
    assert.ok(
      bus.progress.some((m) =>
        m.includes(
          'Manufacturer check (after addressing by programming button)',
        ),
      ),
      'the refusal comes from the after-addressing-by-programming-button check',
    );
    assert.equal(
      storedSerial(dev.id),
      RECORDED_SERIAL,
      'a refused unit must not be recorded as this device',
    );
  });

  it("proceeds and records the new unit's serial when the manufacturer matches", async () => {
    bus.infoScript = [
      null,
      { serialNumber: NEW_UNIT_SERIAL, manufacturerId: 0x00fa },
    ];
    bus.serialsInProgrammingMode = [
      { src: '15.15.255', serial: NEW_UNIT_SERIAL },
    ];
    const { result, dev } = await run('button');

    assert.equal(result.status, 200);
    assert.ok(bus.did('downloadDevice'));
    assert.equal(storedSerial(dev.id), NEW_UNIT_SERIAL);
  });
});

describe('runProgramDevice(): programming-button path refuses an occupied target address', () => {
  it('a different device answers at the target and another is in programming mode: address_occupied, nothing written', async () => {
    // Upper case on purpose: the occupant serial is reported normalised.
    bus.infoScript = [{ serialNumber: OCCUPANT_SERIAL.toUpperCase() }];
    bus.serialsInProgrammingMode = [
      { src: '15.15.255', serial: NEW_UNIT_SERIAL },
    ];
    const { result, dev } = await run('button');

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'address_occupied');
    assert.equal(result.body.occupantSerial, OCCUPANT_SERIAL);
    assert.match(
      result.body.message,
      new RegExp(DEV_ADDR.replace(/\./g, '\\.')),
    );
    assert.equal(
      bus.did('programIA'),
      false,
      'the address must not be written',
    );
    assert.equal(bus.did('downloadDevice'), false);
    assert.equal(storedSerial(dev.id), RECORDED_SERIAL);
  });

  it('not refused when the device in programming mode already sits at the target address', async () => {
    bus.infoScript = [{ serialNumber: OCCUPANT_SERIAL }];
    bus.serialsInProgrammingMode = [{ src: DEV_ADDR, serial: OCCUPANT_SERIAL }];
    const { result } = await run('button');

    assert.equal(result.status, 200);
    assert.ok(bus.did('programIA'));
    assert.ok(bus.did('downloadDevice'));
  });

  it('not refused when the device in programming mode IS the one answering at the target (same serial)', async () => {
    bus.infoScript = [{ serialNumber: OCCUPANT_SERIAL }];
    bus.serialsInProgrammingMode = [
      { src: '15.15.255', serial: OCCUPANT_SERIAL.toUpperCase() },
    ];
    const { result } = await run('button');

    assert.equal(result.status, 200);
    assert.ok(bus.did('downloadDevice'));
  });

  it('not refused when whatever answers at the target reports no serial (the occupant is unknown)', async () => {
    bus.infoScript = [{}];
    bus.serialsInProgrammingMode = [
      { src: '15.15.255', serial: NEW_UNIT_SERIAL },
    ];
    const { result } = await run('button');

    assert.equal(result.status, 200);
    assert.ok(bus.did('programIA'));
  });
});
