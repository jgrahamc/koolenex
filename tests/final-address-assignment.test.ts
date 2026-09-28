/**
 * Address assignment by serial number:
 *
 *  1. assignIndividualAddressBySerial() must survive its pre-check read
 *     THROWING (not merely returning null): the failure is logged and the call
 *     falls through to write-then-verify.
 *  2. The standalone POST /bus/assign-address-by-serial route's response when
 *     the target address is occupied by a different device. The route passes
 *     the connection's result straight through, so an occupied target is
 *     reported as HTTP 200 with `ok: false` and an `occupiedBy` object - the
 *     status code alone does not distinguish success from refusal.
 *
 * A two-device fake bus routes DeviceDescriptor_Read / PropertyValue_Read by
 * destination address and serial-number lookups/writes by serial.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'events';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduExtUnnumbered,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import { createTestServer, req, type TestServer } from './helpers.ts';

const OURS = Buffer.from('0a0b0c0d0e01', 'hex');
const OTHER = Buffer.from('0a0b0c0d0e02', 'hex');
const TARGET = '1.1.10';

interface FakeDev {
  addr: string;
  serial: Buffer;
}

class FakeTwoDeviceBus extends KnxConnection {
  sent: Buffer[] = [];
  devices: FakeDev[];
  /** Number of leading readIndividualAddressBySerial() calls that throw. */
  readFailures = 0;
  readCalls = 0;

  constructor(devices: FakeDev[]) {
    super();
    this.devices = devices;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  readIndividualAddressBySerial(
    serial: Buffer,
    timeoutMs?: number,
  ): Promise<{ address: string } | null> {
    this.readCalls++;
    if (this.readFailures > 0) {
      this.readFailures--;
      return Promise.reject(new Error('simulated pre-check read failure'));
    }
    return super.readIndividualAddressBySerial(serial, timeoutMs);
  }

  private reply(src: string, apdu: Buffer, broadcast = false): void {
    const resp = parseCEMI(
      buildCEMI(src, broadcast ? '0/0/0' : this.localAddr, apdu, broadcast),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const dev = this.devices.find((d) => d.addr === frame.dst);
      if (dev)
        this.reply(
          dev.addr,
          apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
        );
      return Promise.resolve();
    }
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;

    if (fullApci === APCI_EXT.IndividualAddressSerialNumber_Read) {
      const q = frame.apduData.subarray(0, 6);
      for (const d of this.devices) {
        if (d.serial.equals(q)) {
          this.reply(
            d.addr,
            apduExtUnnumbered(
              APCI_EXT.IndividualAddressSerialNumber_Response,
              Buffer.concat([d.serial, Buffer.alloc(4)]),
            ),
            true,
          );
        }
      }
      return Promise.resolve();
    }
    if (fullApci === APCI_EXT.IndividualAddressSerialNumber_Write) {
      const q = frame.apduData.subarray(0, 6);
      const w = frame.apduData.readUInt16BE(6);
      for (const d of this.devices) {
        if (d.serial.equals(q))
          d.addr = `${(w >> 12) & 0xf}.${(w >> 8) & 0xf}.${w & 0xff}`;
      }
      return Promise.resolve();
    }
    if (fullApci === APCI_EXT.PropertyValue_Read) {
      const dev = this.devices.find((d) => d.addr === frame.dst);
      const propId = frame.apduData[1]!;
      if (dev && propId === 11) {
        const meta = Buffer.from([frame.apduData[0]!, propId, 0x11, 0x01]);
        this.reply(
          dev.addr,
          apduExtUnnumbered(
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([meta, dev.serial]),
          ),
        );
      }
      return Promise.resolve();
    }
    if (frame.apciIdx === APCI_EXT.Restart_Extended) {
      const dev = this.devices.find((d) => d.addr === frame.dst);
      if (dev)
        this.reply(
          dev.addr,
          apduExtUnnumbered(
            APCI_EXT.Restart_Extended_Response,
            Buffer.from([0, 0, 0]),
          ),
        );
      return Promise.resolve();
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  addressWrites(): number {
    return this.sent.filter((c) => {
      const f = parseCEMI(c);
      if (!f) return false;
      const a =
        f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      return a === APCI_EXT.IndividualAddressSerialNumber_Write;
    }).length;
  }
}

describe('assignIndividualAddressBySerial(): the pre-check read throws', () => {
  it('falls through to write-then-verify instead of propagating the error', async () => {
    const bus = new FakeTwoDeviceBus([{ addr: '1.1.13', serial: OURS }]);
    bus.readFailures = 1; // only the pre-check read throws

    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );

    assert.equal(r.ok, true);
    assert.equal(r.verified, true, 'the post-write read-back still verifies');
    assert.equal(r.address, TARGET);
    assert.equal(
      r.alreadyCorrect,
      false,
      'a failed pre-check cannot claim the device was already correct',
    );
    assert.equal(r.occupiedBy, undefined);
    assert.equal(bus.addressWrites(), 1, 'the address is written exactly once');
    assert.equal(bus.devices[0]!.addr, TARGET, 'the device was moved');
    assert.ok(
      bus.readCalls >= 2,
      'the pre-check read and at least one verification read were both attempted',
    );
  });

  it('still writes (and verifies) when the pre-check throws for a device that is already at the target', async () => {
    // The pre-check is what would have let the write be skipped. When it
    // cannot answer, the safe fallback is the ordinary write - the device
    // ends up at the target either way, and is verified.
    const bus = new FakeTwoDeviceBus([{ addr: TARGET, serial: OURS }]);
    bus.readFailures = 1;

    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );

    assert.equal(r.ok, true);
    assert.equal(r.alreadyCorrect, false);
    assert.equal(bus.addressWrites(), 1);
    assert.equal(r.verified, true);
    assert.equal(bus.devices[0]!.addr, TARGET);
  });
});

// A minimal stand-in for KnxBusManager: the route only needs the bus to exist
// and to expose assignIndividualAddressBySerial(); the call is delegated to the
// fake connection above so the real occupancy logic runs behind the HTTP layer.
class RouteBus extends EventEmitter {
  connected = true;
  conn: FakeTwoDeviceBus;
  constructor(conn: FakeTwoDeviceBus) {
    super();
    this.conn = conn;
  }
  setRemapper(): void {}
  assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs?: number,
    verifyDeadlineMs?: number,
  ): ReturnType<KnxConnection['assignIndividualAddressBySerial']> {
    return this.conn.assignIndividualAddressBySerial(
      serial,
      newAddr,
      timeoutMs ?? 2000,
      verifyDeadlineMs ?? 4000,
    );
  }
  addKeepAliveRef(): () => void {
    return () => {};
  }
  broadcast(): void {}
}

describe('POST /bus/assign-address-by-serial: response when the target is occupied', () => {
  let ts: TestServer;
  let routeBus: RouteBus;

  before(async () => {
    ts = await createTestServer();
    routeBus = new RouteBus(new FakeTwoDeviceBus([]));
    const { router } = await import('../server/routes/index.ts');
    (router as unknown as { setBus: (b: unknown) => void }).setBus(routeBus);
  });
  after(() => ts.close());

  it('answers 409 address_occupied, not a 200, and writes nothing', async () => {
    const conn = new FakeTwoDeviceBus([
      { addr: '1.1.13', serial: OURS },
      { addr: TARGET, serial: OTHER },
    ]);
    routeBus.conn = conn;

    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: OURS.toString('hex'),
      newAddress: TARGET,
    });

    // Standardised to the same convention /bus/program-device's own
    // address_occupied already uses - a refusal is an error status, not a
    // 200 with an ok:false field.
    assert.equal(r.status, 409);
    const data = r.data as { error: string; occupantSerial?: string };
    assert.equal(data.error, 'address_occupied');
    assert.equal(data.occupantSerial, OTHER.toString('hex'));
    assert.equal(conn.addressWrites(), 0, 'no address write may be sent');
    assert.equal(conn.devices[0]!.addr, '1.1.13', 'our device was not moved');
    assert.equal(conn.devices[1]!.addr, TARGET, 'the occupant was not touched');
  });

  it('a free target answers HTTP 200 too, but with ok:true and no occupiedBy', async () => {
    const conn = new FakeTwoDeviceBus([{ addr: '1.1.13', serial: OURS }]);
    routeBus.conn = conn;

    const r = await req(ts.baseUrl, 'POST', '/bus/assign-address-by-serial', {
      serial: OURS.toString('hex'),
      newAddress: TARGET,
    });

    assert.equal(r.status, 200);
    const body = r.data as {
      ok: boolean;
      verified: boolean;
      address: string | null;
      occupiedBy?: unknown;
    };
    assert.equal(body.ok, true);
    assert.equal(body.verified, true);
    assert.equal(body.address, TARGET);
    assert.equal('occupiedBy' in body, false);
    assert.equal(conn.addressWrites(), 1);
  });
});
