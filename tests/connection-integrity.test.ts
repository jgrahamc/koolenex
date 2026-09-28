/**
 * Connection-integrity guards.
 *
 *  - managementSession() throws immediately on an EXPLICIT negative
 *    L_Data.con confirmation (confirm bit set) for its T_CONNECT: the device
 *    never received a connection request, so nothing further may be sent into
 *    it. Silence (no echo at all, the normal case for USB and loopback
 *    connections) is deliberately left unchanged.
 *  - downloadDevice() aborts after three consecutive property reads/writes
 *    that got no response at all, instead of running its whole scripted
 *    sequence into a dead connection.
 *  - readDeviceInfo() reports an error when every identity read got no
 *    answer, instead of returning an empty result that looks like success.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnectedFull,
  MC,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import type { CemiFrame } from '../server/knx-cemi.ts';
import { KnxConnection, scaledMs } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

/** Fake device that answers DeviceDescriptor_Read/Authorize normally, but
 *  echoes a NEGATIVE `L_Data.con` confirmation (confirmBit=1) for its
 *  `Connect` - the shape of a router NACK. Nothing else
 *  matters for this test - the session should never get past `Connect`. */
class FakeConnectNackDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;

  constructor(deviceAddr: string) {
    super();
    this.deviceAddr = deviceAddr;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();
    if (frame.tpciType === 'CONNECT') {
      // An L_Data.con echo of our own Connect, src=our address
      // (dst=device), confirmBit=1 (negative - "never reached the bus").
      const nack: CemiFrame = {
        msgCode: MC.CON,
        src: this.localAddr,
        dst: this.deviceAddr,
        isGroup: false,
        apciIdx: null,
        apciName: null,
        apduData: Buffer.alloc(0),
        apdu: Buffer.from([0x80]),
        tpciType: 'CONNECT',
        confirmBit: 1,
      };
      setImmediate(() => this._onCEMI(nack));
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

/** Fake device that connects fine (positive confirm) and answers
 *  DeviceDescriptor_Read/Authorize, but never answers a single
 *  PropertyValue_Write/Read after that - the "connection established but
 *  then dead" shape, distinct from a Connect that never worked. */
class FakeDeadAfterConnectDevice extends KnxConnection {
  sent: Buffer[] = [];
  writeAttempts = 0;
  private readonly deviceAddr: string;

  constructor(deviceAddr: string) {
    super();
    this.deviceAddr = deviceAddr;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.tpciType === 'CONNECT') {
      const ok: CemiFrame = {
        msgCode: MC.CON,
        src: this.localAddr,
        dst: this.deviceAddr,
        isGroup: false,
        apciIdx: null,
        apciName: null,
        apduData: Buffer.alloc(0),
        apdu: Buffer.from([0x80]),
        tpciType: 'CONNECT',
        confirmBit: 0,
      };
      setImmediate(() => this._onCEMI(ok));
      return Promise.resolve();
    }
    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(0x07b0);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }
    const fullApci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    if (fullApci === APCI_EXT.Authorize_Request) {
      this.reply(
        apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])),
      );
      return Promise.resolve();
    }
    if (fullApci === APCI_EXT.PropertyValue_Write) {
      this.writeAttempts++;
      // Deliberately never answers - the "connection alive, device silent"
      // case under test.
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

/** A device that answers DeviceDescriptor_Read (so it counts as reachable)
 *  and confirms its T_CONNECT, but never answers a single property read. */
class FakeSilentDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly deviceAddr: string;

  constructor(deviceAddr: string) {
    super();
    this.deviceAddr = deviceAddr;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();
    if (frame.tpciType === 'CONNECT') {
      const ok: CemiFrame = {
        msgCode: MC.CON,
        src: this.localAddr,
        dst: this.deviceAddr,
        isGroup: false,
        apciIdx: null,
        apciName: null,
        apduData: Buffer.alloc(0),
        apdu: Buffer.from([0x80]),
        tpciType: 'CONNECT',
        confirmBit: 0,
      };
      setImmediate(() => this._onCEMI(ok));
    } else if (frame.apciName === 'DeviceDescriptor_Read') {
      const resp = parseCEMI(
        buildCEMI(
          this.deviceAddr,
          this.localAddr,
          apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
          false,
        ),
      )!;
      setImmediate(() => this._onCEMI(resp));
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('connection integrity guards', () => {
  it('managementSession() throws immediately on an explicit negative Connect confirmation, not after the session silently proceeds', async () => {
    const dev = new FakeConnectNackDevice('1.1.30');
    const before = Date.now();
    // restartDevice() calls managementSession() directly (no preceding
    // _probeSingle() gate, unlike readDeviceInfo()) - the most direct way
    // to exercise the Connect-confirmation check itself in isolation.
    await assert.rejects(
      () => dev.restartDevice('1.1.30'),
      /No device found at/,
    );
    const elapsedMs = Date.now() - before;
    assert.ok(
      elapsedMs < 500,
      `should fail fast on the NACK, not after any real timeout - took ${elapsedMs}ms`,
    );
  });

  it('downloadDevice() aborts after CONSECUTIVE_NO_RESPONSE_LIMIT genuinely-silent writes, not after running the whole scripted sequence', async () => {
    const dev = new FakeDeadAfterConnectDevice('1.1.30');
    // Several app-declared WriteProp steps, all Verify="true" (so each one
    // genuinely waits for - and never gets - a response), like the
    // Unload/StartLoading load-state writes.
    const steps: DownloadStep[] = [
      {
        type: 'WriteProp',
        objIdx: 4,
        propId: 5,
        data: Buffer.from('0400000000000000', 'hex'),
        verify: true,
      },
      {
        type: 'WriteProp',
        objIdx: 3,
        propId: 5,
        data: Buffer.from('0400000000000000', 'hex'),
        verify: true,
      },
      {
        type: 'WriteProp',
        objIdx: 2,
        propId: 5,
        data: Buffer.from('0400000000000000', 'hex'),
        verify: true,
      },
      {
        type: 'WriteProp',
        objIdx: 1,
        propId: 5,
        data: Buffer.from('0400000000000000', 'hex'),
        verify: true,
      },
    ];

    await assert.rejects(
      () =>
        dev.downloadDevice('1.1.30', steps, null, null, null, undefined, {
          mode: 'full',
          cachedMaxApduLength: 228,
        }),
      /connection appears dead/,
    );
    assert.ok(
      dev.writeAttempts <= 3,
      `should abort after at most 3 consecutive silent writes, not all ${steps.length} - made ${dev.writeAttempts} attempts`,
    );
  });

  it('readDeviceInfo() reports an error when every identity read got no answer', async () => {
    const dev = new FakeSilentDevice('1.1.30');
    const info = await dev.readDeviceInfo('1.1.30');
    assert.match(
      info.error ?? '',
      /identity property reads .* got no response/,
    );
    assert.equal(info.serialNumber, undefined);
  });
});

describe('parseCEMI confirm bit', () => {
  it('reads cEMI control field 1 bit 0 into confirmBit', () => {
    const buf = buildCEMI('1.0.1', '1.1.30', Buffer.from([0x80]), false);
    assert.equal(parseCEMI(buf)!.confirmBit, 0);
    const negative = Buffer.from(buf);
    negative[2] = negative[2]! | 0x01; // control field 1 sits right after the 2-byte header
    assert.equal(parseCEMI(negative)!.confirmBit, 1);
  });
});

describe('readPropertyMany per-read options', () => {
  it('requests the given element count and honours a per-read timeout', async () => {
    const dev = new FakeSilentDevice('1.1.31');
    const started = Date.now();
    await assert.rejects(
      () =>
        dev.readPropertyMany('1.1.31', [
          { objIdx: 0, propId: 11, count: 3, timeoutMs: 200 },
        ]),
      /Management timeout/,
    );
    // The default wait is 3000ms; the override must cut it short.
    assert.ok(Date.now() - started < scaledMs(1500));
    const read = dev.sent
      .map((c) => parseCEMI(c))
      .find((f) => f && f.apduData[0] === 0 && f.apduData[1] === 11);
    assert.equal(read!.apduData[2]! >> 4, 3, 'the request asks for 3 elements');
  });
});

describe('downloadDevice refuses a load procedure it cannot run', () => {
  it('throws before sending anything when a declared step is Unhandled', async () => {
    const dev = new FakeSilentDevice('1.1.32');
    await assert.rejects(
      () =>
        dev.downloadDevice(
          '1.1.32',
          [
            {
              type: 'Unhandled',
              tag: 'LdCtrlWriteMem',
              objIdx: 0,
              propId: 0,
            } as unknown as DownloadStep,
          ],
          null,
          null,
          null,
        ),
      /LdCtrlWriteMem/,
    );
    assert.equal(dev.sent.length, 0, 'nothing may be sent to the device');
  });
});

/** Answers every identity property read with a fixed value so readDeviceInfo()
 *  can be checked end to end. */
class FakeIdentityDevice extends KnxConnection {
  private readonly deviceAddr: string;
  private readonly values: Map<number, Buffer>;

  constructor(deviceAddr: string, values: Map<number, Buffer>) {
    super();
    this.deviceAddr = deviceAddr;
    this.values = values;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(
      buildCEMI(this.deviceAddr, this.localAddr, apdu, false),
    )!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();
    if (frame.apciName === 'DeviceDescriptor_Read') {
      this.reply(
        apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
      );
      return Promise.resolve();
    }
    const apci =
      frame.apdu.length >= 2
        ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
        : -1;
    if (apci === APCI_EXT.PropertyValue_Read && frame.apduData[0] === 0) {
      const propId = frame.apduData[1]!;
      const value = this.values.get(propId);
      if (value) {
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            Buffer.concat([Buffer.from([0, propId, 0x11, 0x01]), value]),
          ),
        );
      }
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe('readDeviceInfo reads PID_VERSION', () => {
  it('reports the 2-byte device version from property 25', async () => {
    const dev = new FakeIdentityDevice(
      '1.1.33',
      new Map([
        [12, Buffer.from([0x00, 0x04])],
        [25, Buffer.from([0x12, 0x34])],
      ]),
    );
    const info = await dev.readDeviceInfo('1.1.33');
    assert.equal(info.version, '1234');
    assert.equal(info.manufacturerId, 4);
  });
});
