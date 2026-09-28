/**
 * assignIndividualAddressBySerial() refuses to write onto an occupied address.
 *
 * Writing an address onto a bus that already has a DIFFERENT device answering
 * there leaves two devices sharing one individual address: every later
 * point-to-point connection (including a download) then reaches whichever
 * answers first, or both. The write is refused when another device already
 * answers at the target, and skipped entirely when the device is already
 * there. ETS probes the target address before claiming it (see
 * docs/knx-device-write-protocol.md 9.4); what it does when the address is
 * not free was never captured, so this refuses rather than guessing.
 *
 * A two-device fake bus: routes DeviceDescriptor_Read / PropertyValue_Read by
 * destination address, and serial-number lookups/writes by serial.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduExtUnnumbered,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

const OURS = Buffer.from('aabbccddeeff', 'hex');
const OTHER = Buffer.from('112233445566', 'hex');

interface FakeDev {
  addr: string;
  serial: Buffer;
  /** false = the device answers DeviceDescriptor_Read but never answers a P=11 read */
  answersSerialRead: boolean;
}

class FakeTwoDeviceBus extends KnxConnection {
  sent: Buffer[] = [];
  devices: FakeDev[];

  constructor(devices: FakeDev[]) {
    super();
    this.devices = devices;
    this.connected = true;
    this.localAddr = '1.0.1';
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
      if (dev && propId === 11 && dev.answersSerialRead) {
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

  descriptorReadsTo(addr: string): number {
    return this.sent.filter((c) => {
      const f = parseCEMI(c);
      return !!f && f.apciName === 'DeviceDescriptor_Read' && f.dst === addr;
    }).length;
  }
}

const TARGET = '1.1.10';

describe('assignIndividualAddressBySerial() refuses to write onto an occupied address', () => {
  it('a DIFFERENT device with a readable serial already at the target: no write, occupiedBy carries its serial', async () => {
    const bus = new FakeTwoDeviceBus([
      { addr: '1.1.13', serial: OURS, answersSerialRead: true },
      { addr: TARGET, serial: OTHER, answersSerialRead: true },
    ]);
    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );
    assert.equal(bus.addressWrites(), 0, 'no address write may be sent');
    assert.equal(r.ok, false);
    assert.equal(r.verified, false);
    assert.equal(r.restarted, false);
    assert.deepEqual(r.occupiedBy, { serial: OTHER.toString('hex') });
    assert.equal(r.address, '1.1.13', 'reports where our device actually is');
    assert.equal(bus.devices[0]!.addr, '1.1.13', 'our device was not moved');
  });

  it('something answers at the target but its serial is unreadable, and our device is known to be elsewhere: refused (serial null)', async () => {
    const bus = new FakeTwoDeviceBus([
      { addr: '1.1.13', serial: OURS, answersSerialRead: true },
      { addr: TARGET, serial: OTHER, answersSerialRead: false },
    ]);
    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );
    assert.equal(bus.addressWrites(), 0);
    assert.deepEqual(r.occupiedBy, { serial: null });
  });

  it('a FREE target address is written and verified exactly as before', async () => {
    const bus = new FakeTwoDeviceBus([
      { addr: '1.1.13', serial: OURS, answersSerialRead: true },
    ]);
    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );
    assert.equal(bus.addressWrites(), 1);
    assert.equal(r.occupiedBy, undefined);
    assert.equal(r.verified, true);
    assert.equal(bus.devices[0]!.addr, TARGET);
  });

  it('already at the target: no write AND no probe of the target (the normal case pays nothing)', async () => {
    const bus = new FakeTwoDeviceBus([
      { addr: TARGET, serial: OURS, answersSerialRead: true },
    ]);
    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );
    assert.equal(bus.addressWrites(), 0);
    assert.equal(r.alreadyCorrect, true);
    assert.equal(r.occupiedBy, undefined);
    // restartDevice() itself does one DeviceDescriptor_Read to the (correct) device; the guard probe must not add another.
    assert.equal(bus.descriptorReadsTo(TARGET), 1);
  });

  it('AMBIGUOUS - something answers, its serial is unreadable, and our own location is unknown: not refused on a guess (unchanged behaviour)', async () => {
    const bus = new FakeTwoDeviceBus([
      { addr: TARGET, serial: OTHER, answersSerialRead: false },
    ]); // ours is not on the bus at all
    const r = await bus.assignIndividualAddressBySerial(
      OURS,
      TARGET,
      2000,
      4000,
    );
    assert.equal(r.occupiedBy, undefined);
    assert.equal(
      bus.addressWrites(),
      1,
      'falls through to the pre-existing write-then-verify path',
    );
    assert.equal(r.verified, false);
  });
});
