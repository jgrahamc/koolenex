/**
 * Tests for the KnxConnection base class (via test subclass) - the core
 * device write-protocol logic - plus USB HID transport round-trip tests.
 * KNXnet/IP transport-layer tests (KnxIpConnection, KnxBusManager) live in
 * tests/knx-bus.test.ts.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KnxConnection,
  parseCEMI,
  buildCEMI,
  apduGroup,
  encodeGroup,
  delay,
  type DownloadStep,
} from '../server/knx-connection.ts';
import type { CemiFrame } from '../server/knx-cemi.ts';
import {
  _apduGroupRead as apduGroupRead,
  _apduGroupWrite as apduGroupWrite,
  _apduGroupResponse as apduGroupResponse,
  _apduControl as apduControl,
  _TPCI as TPCI,
  apduConnectedFull,
  APCI_EXT,
} from '../server/knx-cemi.ts';

// ── Test subclass ─────────────────────────────────────────────────────────────

class TestKnxConnection extends KnxConnection {
  sent: Buffer[] = [];
  // Routing (multicast) is a separate channel from Tunneling, used by the
  // "System Broadcast" services (checkProgrammingMode, serial-number
  // addressing) - see docs/knx-device-write-protocol.md §9. Set false to
  // exercise the base class's default-throw (no Routing capability).
  sentViaRouting: Buffer[] = [];
  _routingAvailable = true;
  disconnected = false;

  // Opt-in only (default false): auto-answers DeviceDescriptor_Read/
  // PID_MAX_APDULENGTH for tests that just want a fast downloadDevice()/
  // readMemory() run. Several tests (scan(), the DeviceDescriptor_Read
  // timeout/fallback tests) depend on nothing responding by default, so
  // this must stay opt-in rather than the default. See sendCEMI() below
  // for what opting in actually answers.
  autoAnswerIdentityReads = false;

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    // KnxConnection resolves a device's mask (DeviceDescriptor_Read, for
    // the memory-service decision) and PID_MAX_APDULENGTH (property 56,
    // objIdx 0, for chunk sizing) once per downloadDevice()/readMemory()
    // session. No auto-response by default, since some tests exercise the
    // "device never answers DeviceDescriptor_Read" fallback/timeout path
    // itself. Opt in via `autoAnswerIdentityReads` otherwise.
    if (this.autoAnswerIdentityReads) {
      const frame = parseCEMI(cemi);
      if (frame?.apciName === 'DeviceDescriptor_Read') {
        const respApdu = apduGroup(
          'DeviceDescriptor_Response',
          0,
          Buffer.from([0x07, 0xb0]),
        );
        const resp = parseCEMI(
          buildCEMI(frame.dst, frame.src, respApdu, false),
        )!;
        setImmediate(() => this._onCEMI(resp));
      } else {
        const fullApci =
          frame && frame.apdu.length >= 2
            ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]!
            : -1;
        if (fullApci === 0x3d5 /* PropertyValue_Read */) {
          const objIdx = frame!.apduData[0]!;
          const propId = frame!.apduData[1]!;
          if (objIdx === 0 && propId === 56) {
            const meta = Buffer.from([objIdx, propId, 0x10, 0x01]);
            const value = Buffer.from([0x03, 0xe8]); // 1000 - generous, never caps
            const respApdu = apduConnectedFull(
              0,
              APCI_EXT.PropertyValue_Response,
              Buffer.concat([meta, value]),
            );
            const resp = parseCEMI(
              buildCEMI(frame!.dst, frame!.src, respApdu, false),
            )!;
            setImmediate(() => this._onCEMI(resp));
          } else {
            // Any other property (e.g. a load state) reads back as a single
            // zero byte, so a multi-property-read step isn't mistaken for a
            // dead connection.
            const respApdu = apduConnectedFull(
              0,
              APCI_EXT.PropertyValue_Response,
              Buffer.from([objIdx, propId, 0x10, 0x01, 0x00]),
            );
            const resp = parseCEMI(
              buildCEMI(frame!.dst, frame!.src, respApdu, false),
            )!;
            setImmediate(() => this._onCEMI(resp));
          }
        } else if (fullApci === 0x3d7 /* PropertyValue_Write */) {
          // Acknowledge writes too: 3 unanswered in a row abort a download
          // as a dead connection.
          const respApdu = apduConnectedFull(
            0,
            APCI_EXT.PropertyValue_Response,
            frame!.apduData,
          );
          const resp = parseCEMI(
            buildCEMI(frame!.dst, frame!.src, respApdu, false),
          )!;
          setImmediate(() => this._onCEMI(resp));
        }
      }
    }
    return Promise.resolve();
  }

  sendCEMIViaRouting(cemi: Buffer): Promise<void> {
    if (!this._routingAvailable) return super.sendCEMIViaRouting(cemi);
    this.sentViaRouting.push(cemi);
    return Promise.resolve();
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected = false;
  }

  /** Simulate receiving a group telegram from the bus */
  simulateGroupTelegram(src: string, dst: string, apdu: Buffer): void {
    const cemi = buildCEMI(src, dst, apdu, true);
    const parsed = parseCEMI(cemi)!;
    this._onCEMI(parsed);
  }

  /** Simulate receiving a device management frame */
  simulateMgmtFrame(cemi: CemiFrame): void {
    this._onCEMI(cemi);
  }
}

// ── KnxConnection._onCEMI ─────────────────────────────────────────────────────

describe('KnxConnection._onCEMI', () => {
  it('emits telegram event for group frames', async () => {
    const conn = new TestKnxConnection();
    const received: unknown[] = [];
    conn.on('telegram', (tg) => received.push(tg));

    conn.simulateGroupTelegram('1.1.1', '1/0/0', apduGroupWrite(true, '1'));

    assert.equal(received.length, 1);
    const tg = received[0] as Record<string, unknown>;
    assert.equal(tg.src, '1.1.1');
    assert.equal(tg.dst, '1/0/0');
    assert.equal(tg.type, 'GroupValue_Write');
  });

  it('emits _mgmt event for device (non-group) frames', () => {
    const conn = new TestKnxConnection();
    const received: CemiFrame[] = [];
    conn.on('_mgmt', (cemi) => received.push(cemi));

    // Build a device-addressed CEMI (isGroup=false)
    const apdu = apduGroupRead(); // DeviceDescriptor_Read uses same encoding
    const raw = buildCEMI('1.1.1', '1.1.2', apdu, false);
    const parsed = parseCEMI(raw)!;
    conn._onCEMI(parsed);

    assert.equal(received.length, 1);
    assert.equal(received[0].src, '1.1.1');
    assert.equal(received[0].isGroup, false);
  });
});

// ── KnxConnection.write ───────────────────────────────────────────────────────

describe('KnxConnection.write', () => {
  it('sends CEMI and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.write('1/0/0', true, '1');
    assert.deepEqual(result, { ok: true, ga: '1/0/0', value: true, dpt: '1' });
    assert.equal(conn.sent.length, 1);

    // Verify the sent CEMI is parseable and correct
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '1/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'GroupValue_Write');
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.write('1/0/0', true, '1'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.read ────────────────────────────────────────────────────────

describe('KnxConnection.read', () => {
  it('resolves on matching GroupValue_Response', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 2000);

    // Simulate a response after a short delay
    setTimeout(() => {
      conn.simulateGroupTelegram(
        '1.1.2',
        '1/0/0',
        apduGroupResponse(Buffer.from([0x01])),
      );
    }, 10);

    const result = await readPromise;
    assert.equal(result.ga, '1/0/0');
    assert.ok(result.value); // decoded value
  });

  it('ignores non-matching GAs', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 500);

    // Send a response to a different GA — should be ignored
    setTimeout(() => {
      conn.simulateGroupTelegram(
        '1.1.2',
        '2/0/0',
        apduGroupResponse(Buffer.from([0x01])),
      );
    }, 10);

    await assert.rejects(readPromise, { message: 'Read timeout' });
  });

  it('ignores GroupValue_Write (not Response)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 500);

    // Send a Write to the correct GA — should be ignored
    setTimeout(() => {
      conn.simulateGroupTelegram('1.1.2', '1/0/0', apduGroupWrite(true, '1'));
    }, 10);

    await assert.rejects(readPromise, { message: 'Read timeout' });
  });

  it('rejects on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    await assert.rejects(() => conn.read('1/0/0', 100), {
      message: 'Read timeout',
    });
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    assert.throws(() => conn.read('1/0/0'), { message: 'Not connected' });
  });
});

// ── KnxConnection.managementSession ───────────────────────────────────────────

describe('KnxConnection.managementSession', () => {
  it('sends CONNECT, runs function, sends DISCONNECT', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    let fnCalled = false;

    await conn.managementSession('1.1.2', async () => {
      fnCalled = true;
    });

    assert.ok(fnCalled);
    // At minimum: CONNECT control + DISCONNECT control
    assert.ok(
      conn.sent.length >= 2,
      `sent ${conn.sent.length} frames, expected >= 2`,
    );

    // First frame should be CONNECT
    const first = parseCEMI(conn.sent[0]!);
    assert.ok(first);
    assert.equal(first.dst, '1.1.2');
    assert.equal(first.isGroup, false);

    // Last frame should be DISCONNECT
    const last = parseCEMI(conn.sent[conn.sent.length - 1]!);
    assert.ok(last);
    assert.equal(last.dst, '1.1.2');
    assert.equal(last.isGroup, false);
  });

  it('sends DISCONNECT even when function throws', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    await assert.rejects(
      () =>
        conn.managementSession('1.1.2', async () => {
          throw new Error('test error');
        }),
      { message: 'test error' },
    );

    // DISCONNECT should still be sent (last frame)
    assert.ok(conn.sent.length >= 2);
  });

  it('provides working sendData and nextSeq', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const seqs: number[] = [];
    await conn.managementSession('1.1.2', async ({ sendData, nextSeq }) => {
      seqs.push(nextSeq());
      await sendData('DeviceDescriptor_Read', null);
      seqs.push(nextSeq());
      await sendData('Memory_Read', Buffer.from([0x01, 0x00, 0x60]));
    });

    // sendData() consumes and advances the session's sequence counter too -
    // every connection-oriented data frame needs its own number. So the
    // second nextSeq() call sees the counter already bumped by the
    // preceding sendData(): 0, (sendData consumes 1), 2.
    assert.deepEqual(seqs, [0, 2]);
    // CONNECT + 2 data frames + DISCONNECT = 4 frames minimum
    assert.ok(conn.sent.length >= 4, `sent ${conn.sent.length}, expected >= 4`);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(
      () => conn.managementSession('1.1.2', async () => {}),
      { message: 'Not connected' },
    );
  });
});

// ── KnxConnection.ping ────────────────────────────────────────────────────────

describe('KnxConnection.ping', () => {
  it('resolves reachable on matching telegram', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const pingPromise = conn.ping(['1/0/0'], '1.1.2', 2000);

    // Simulate a telegram from the device
    setTimeout(() => {
      conn.simulateGroupTelegram('1.1.2', '1/0/0', apduGroupWrite(true, '1'));
    }, 10);

    const result = await pingPromise;
    assert.equal(result.reachable, true);
    assert.equal(result.ga, '1/0/0');
  });

  it('resolves unreachable on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // Use a very short timeout and disable managementSession by making sendCEMI slow
    const result = await conn.ping([], '', 100);
    assert.equal(result.reachable, false);
    assert.equal(result.ga, null);
  });

  it('rejects when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.ping(['1/0/0'], '1.1.2'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.programIA ──────────────────────────────────────────────────

// ── KnxConnection.sendCEMIViaRouting (default) ────────────────────────────────
// The base class has no Routing capability (only KnxIpConnection in
// knx-protocol.ts overrides this) - see docs/knx-device-write-protocol.md §9.

describe('KnxConnection.sendCEMIViaRouting (base class default)', () => {
  it('throws - no Routing capability without an IP transport override', () => {
    // Synchronous throw, same shape as sendCEMI()'s own base-class default
    // - not a rejected promise.
    const conn = new TestKnxConnection();
    conn._routingAvailable = false; // fall through to the real base-class default
    assert.throws(
      () => conn.sendCEMIViaRouting(Buffer.from([0x29])),
      /Routing/,
    );
  });
});

describe('KnxConnection.programIA', () => {
  it('sends physical address write and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.programIA('1.1.5');
    // ETS restarts the device after an address write; matches that.
    assert.deepEqual(result, { ok: true, newAddr: '1.1.5', restarted: true });
    // PhysicalAddress_Write, then a full management session for the
    // Restart: T_Connect, DeviceDescriptor_Read, PropertyValue_Read (P=56),
    // PropertyValue_Read (P=11), Restart (data), T_Disconnect. The three
    // identity reads are best-effort: nothing answers here, so each times
    // out before the next is sent (the "continues anyway" resilience path) -
    // still 6 frames sent regardless of whether anything answers.
    assert.equal(conn.sent.length, 7);

    // Same wire format as every other network-management broadcast service
    // in this family (see checkProgrammingMode() etc.): GROUP-type frame to
    // 0/0/0 at System priority (ctrl1=0xb0), not an individual-type frame to
    // 0.0.0 at ordinary priority (real devices reject the latter).
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(conn.sent[0]![2], 0xb0);

    // The Restart's own management session addresses the device at its
    // NEW individual address, not the broadcast address used for the
    // write itself.
    const connectFrame = parseCEMI(conn.sent[1]!);
    assert.equal(connectFrame?.dst, '1.1.5');
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.programIA('1.1.5'), {
      message: 'Not connected',
    });
  });

  // The address write is a fire-and-forget broadcast with no response to
  // confirm against, so it's already succeeded before the restart is even
  // attempted - a restart failure surfaces as `restarted: false`, not a
  // rejection of the whole call.
  it('reports restarted: false (not a rejection) when the restart itself fails', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    let calls = 0;
    conn.sendCEMI = (cemi: Buffer): Promise<void> => {
      calls++;
      // Let the PhysicalAddress_Write (1st call) through, fail everything
      // in the restart's own management session after it.
      if (calls === 1) return Promise.resolve();
      return Promise.reject(new Error('simulated send failure'));
    };

    const result = await conn.programIA('1.1.5');
    assert.equal(result.ok, true);
    assert.equal(result.restarted, false);
  });
});

// ── KnxConnection.checkProgrammingMode ────────────────────────────────────────
// A_IndividualAddress_Read broadcast discovery - see
// docs/knx-device-write-protocol.md §9. These tests cover the
// application-layer behavior only (frame shape, response matching,
// timeout) - the same protocol-shape-only coverage every other broadcast
// service in this file gets.

describe('KnxConnection.checkProgrammingMode', () => {
  it('sends a GROUP-type A_IndividualAddress_Read to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(50);
    await delay(10);
    // Sent via the normal Tunneling connection, GROUP-type to 0/0/0 - see
    // docs/knx-device-write-protocol.md §9.
    assert.equal(conn.sent.length, 1);
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'PhysicalAddress_Read');
    assert.equal(conn.sent[0]![2], 0xb0); // ordinary broadcast, System priority
    await p; // let the timeout settle so the test doesn't leave a dangling timer
  });

  it('resolves with the responding device address on a real reply', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(500);
    const raw = buildCEMI(
      '1.1.20',
      '0.0.0',
      apduGroup('PhysicalAddress_Response'),
      false,
    );
    conn.simulateMgmtFrame(parseCEMI(raw)!);

    const result = await p;
    assert.deepEqual(result, { address: '1.1.20' });
  });

  it('resolves with null address on timeout when nothing answers', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.checkProgrammingMode(50);
    assert.deepEqual(result, { address: null });
  });

  it('ignores unrelated _mgmt frames and keeps waiting', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(200);
    const unrelated = buildCEMI('1.1.5', '1.0.1', apduGroupRead(), false);
    conn.simulateMgmtFrame(parseCEMI(unrelated)!);

    const result = await p;
    assert.deepEqual(result, { address: null });
  });

  it('throws when not connected', () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(() => conn.checkProgrammingMode(), /Not connected/);
  });
});

// ── KnxConnection.readSerialNumbersInProgrammingMode ──────────────────────────
// NM_Read_SerialNumber_By_ProgrammingMode - see docs/knx-device-write-
// protocol.md §9: A_SystemNetworkParameter_Read/Response for
// PID_SERIAL_NUMBER (11) on object type 0 (Device), GROUP-type frame to
// 0/0/0 at System priority, response payload
// [objectType(2)][pidField(2)][echoedOperand(1)][serial(6)].

describe('KnxConnection.readSerialNumbersInProgrammingMode', () => {
  it('sends a GROUP-type A_SystemNetworkParameter_Read to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    await delay(10);
    assert.equal(conn.sent.length, 1);
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(conn.sent[0]![2], 0xb0); // ordinary broadcast, System priority
    // fullApci 0x1C8 (SystemNetworkParam_Read), objType=0, pid=11<<4=0xB0, operand=1
    assert.deepEqual(
      [...parsed.apdu.slice(0, 7)],
      [0x01, 0xc8, 0x00, 0x00, 0x00, 0xb0, 0x01],
    );
    await p;
  });

  it('collects a real device reply, using the byte after the echoed operand as the serial', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    // [objType(2)=0000][pidField(2)=00b0][echoedOperand=01][serial(6)]
    const apduData = Buffer.from([
      0x00, 0x00, 0x00, 0xb0, 0x01, 0x00, 0x0a, 0x57, 0x82, 0x04, 0x19,
    ]);
    const apdu = Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.deepEqual(result, [{ serial: '000a57820419', src: '15.15.255' }]);
  });

  it('collects multiple distinct devices within the window', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    const makeApdu = (serial: number[]): { apdu: Buffer; apduData: Buffer } => {
      const apduData = Buffer.from([0x00, 0x00, 0x00, 0xb0, 0x01, ...serial]);
      return {
        apduData,
        apdu: Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]),
      };
    };
    const a = makeApdu([0x00, 0x0a, 0x57, 0x82, 0x04, 0x19]);
    const b = makeApdu([0x00, 0x73, 0x3c, 0x00, 0x5b, 0x42]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData: a.apduData,
      apdu: a.apdu,
      tpciType: 'DATA_GROUP',
    });
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData: b.apduData,
      apdu: b.apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    const serials = result.map((r) => r.serial).sort();
    assert.deepEqual(serials, ['000a57820419', '00733c005b42'].sort());
  });

  it('de-duplicates repeated replies from the same device (normal KNX frame repetition)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    const apduData = Buffer.from([
      0x00, 0x00, 0x00, 0xb0, 0x01, 0x00, 0x0a, 0x57, 0x82, 0x04, 0x19,
    ]);
    const apdu = Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]);
    for (let i = 0; i < 2; i++) {
      conn.simulateMgmtFrame({
        msgCode: 0x29,
        src: '15.15.255',
        dst: '0/0/0',
        isGroup: true,
        apciIdx: null,
        apciName: 'OTHER',
        apduData,
        apdu,
        tpciType: 'DATA_GROUP',
      });
    }

    const result = await p;
    assert.equal(result.length, 1);
  });

  it('resolves with an empty array on timeout when nothing answers', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const result = await conn.readSerialNumbersInProgrammingMode(50);
    assert.deepEqual(result, []);
  });

  it('throws when not connected', () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(
      () => conn.readSerialNumbersInProgrammingMode(),
      /Not connected/,
    );
  });
});

// ── KnxConnection: individual address by serial number ───────────────────────
// NM_IndividualAddress_SerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4) - see
// docs/knx-device-write-protocol.md §9. Protocol-level shape only (frame
// addressing, system-broadcast priority bit, response matched by serial,
// not by source address) - no hardware capture backs this path.

describe('KnxConnection.writeIndividualAddressBySerial', () => {
  it('sends a GROUP-type frame to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const result = await conn.writeIndividualAddressBySerial(serial, '1.1.20');
    assert.deepEqual(result, { ok: true });
    // Sent via the normal Tunneling connection, GROUP-type to 0/0/0 - see
    // docs/knx-device-write-protocol.md §9.
    assert.equal(conn.sent.length, 1);

    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    // ctrl1 (byte 2): ordinary broadcast + System priority (0xB0), not
    // the plain 0xBC every other frame this codebase builds uses.
    assert.equal(conn.sent[0]![2], 0xb0);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    await assert.rejects(
      () => conn.writeIndividualAddressBySerial(Buffer.alloc(6), '1.1.20'),
      { message: 'Not connected' },
    );
  });
});

describe('KnxConnection.readIndividualAddressBySerial', () => {
  it('resolves with the address from a matching broadcast reply', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const p = conn.readIndividualAddressBySerial(serial, 500);
    // Broadcast reply payload is [serial(6)][4 reserved zero bytes] - no
    // address field; src carries the device's address instead. Matched by
    // serial, not by source address (unknown ahead of time) - see
    // docs/knx-device-write-protocol.md §9.
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([
      Buffer.from([0x03, 0xdd & 0xff]), // TPCI=DATA_GROUP + full APCI 0x3DD
      apduData,
    ]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.20',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.deepEqual(result, { address: '1.1.20' });
  });

  it('ignores a reply for a different serial number and eventually times out', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);
    const otherSerial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x95]);

    const p = conn.readIndividualAddressBySerial(serial, 50);
    const apduData = Buffer.concat([otherSerial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([Buffer.from([0x03, 0xdd]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.21',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.equal(result, null);
  });

  it('throws when not connected', () => {
    // Synchronous throw, same shape as read()/write() above - the
    // connected-check runs before the `new Promise(...)` is even
    // constructed, so it's a plain thrown error, not a rejected promise.
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(
      () => conn.readIndividualAddressBySerial(Buffer.alloc(6)),
      /Not connected/,
    );
  });
});

describe('KnxConnection.assignIndividualAddressBySerial', () => {
  it('writes then reads back to verify', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const assignP = conn.assignIndividualAddressBySerial(serial, '1.1.20', 500);
    // Let the Write's sendCEMI (a resolved promise) settle before the Read
    // is issued, then answer the Read.
    await delay(10);
    // [serial(6)][4 reserved zero bytes] - src carries the device's
    // (newly-assigned) address instead - see
    // docs/knx-device-write-protocol.md §9.
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([Buffer.from([0x03, 0xdd]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.20',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await assignP;
    // Restart only happens once the read-back confirms the write landed.
    assert.deepEqual(result, {
      ok: true,
      verified: true,
      address: '1.1.20',
      restarted: true,
    });
    // Write, then Read (both GROUP-type to 0/0/0 via the normal Tunneling
    // connection), then a full management session for the Restart:
    // T_Connect, DeviceDescriptor_Read, PropertyValue_Read (P=56),
    // PropertyValue_Read (P=11), Restart (data), T_Disconnect - same three
    // best-effort identity reads as programIA()'s test above (see its
    // comment for why the count includes them even though nothing answers).
    assert.equal(conn.sent.length, 8);
    // The Restart's own management session addresses the device at its
    // NEW individual address (1.1.20), not the broadcast address used for
    // the write/read-verify.
    const connectFrame = parseCEMI(conn.sent[2]!);
    assert.equal(connectFrame?.dst, '1.1.20');
  });

  it('does not attempt a restart when verification fails', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    // No mgmt frame is simulated, so readIndividualAddressBySerial() times
    // out with a null result on every retry and verified stays false (the
    // retry itself is tested below).
    //
    // verifyDeadlineMs is 1, not 50: matching timeoutMs made the number of
    // attempts a coin flip on the 1ms boundary between the timer clock and
    // Date.now(), occasionally buying an extra attempt and an intermittent
    // `sent.length 3, expected 2`.
    const result = await conn.assignIndividualAddressBySerial(
      serial,
      '1.1.20',
      50,
      1,
    );
    assert.deepEqual(result, {
      ok: true,
      verified: false,
      address: null,
      restarted: false,
    });
    // Asserts by frame addressing rather than count, to avoid coupling to
    // the retry loop's timing: no restart session was opened against the
    // new address (1.1.20, checked in the successful-verify test above) -
    // write and read-back stay broadcasts to 0/0/0.
    assert.ok(conn.sent.length >= 2, 'expected at least the write and a read');
    for (const frame of conn.sent) {
      assert.equal(parseCEMI(frame)?.dst, '0/0/0');
    }
  });

  it('retries the read-back verification when the first attempt times out', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    // First read-back attempt (t=0 to t=2000ms) times out - nothing
    // answers. The loop's 2000ms between-attempt delay pushes the second
    // attempt's read to start at t≈4000ms, with its own window open until
    // t≈6000ms. The frame is simulated at t≈5000ms - inside the SECOND
    // attempt's window, not the first - proving a real second attempt
    // answers it, not just a longer single wait. Windows are wide because
    // the suite runs on a compressed clock, where a narrow one is shorter
    // than timer jitter.
    const assignP = conn.assignIndividualAddressBySerial(
      serial,
      '1.1.20',
      2000, // each individual read-back attempt's own timeout
      8000, // overall retry deadline - comfortably covers a second attempt
    );
    await delay(5000);
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([Buffer.from([0x03, 0xdd]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.20',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await assignP;
    assert.equal(result.verified, true);
    assert.equal(result.address, '1.1.20');
    assert.equal(result.restarted, true);
    // Write + 2 Reads (first timed out, second answered) + the same
    // 6-frame restart session as the single-attempt success case above
    // (8 total there) = 9 - confirms a real second read-back attempt went
    // out, not just a single longer-timeout read.
    assert.equal(
      conn.sent.length,
      9,
      'expected Write + 2 Reads (one retried) + the 6-frame restart session',
    );
  });
});

// ── KnxConnection.scan ───────────────────────────────────────────────────────

describe('KnxConnection.scan', () => {
  it('iterates addresses and reports progress', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const progressCalls: Array<{ address: string; done: number }> = [];
    const found = await conn.scan(1, 1, 10, (p) => {
      progressCalls.push({ address: p.address, done: p.done });
    });

    // All probes should time out with 10ms timeout
    assert.equal(found.length, 0);
    // Should have reported progress for all 256 addresses
    assert.equal(progressCalls.length, 256);
    assert.equal(progressCalls[0].address, '1.1.0');
    assert.equal(progressCalls[0].done, 1);
    assert.equal(progressCalls[255].address, '1.1.255');
    assert.equal(progressCalls[255].done, 256);
  });

  it('abortScan stops early', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    // Relies on every probed address finding nothing - auto-answer would
    // make every DeviceDescriptor_Read "succeed".
    conn.autoAnswerIdentityReads = false;

    let progressCount = 0;
    // Abort after 3 probes
    const scanPromise = conn.scan(1, 1, 10, () => {
      progressCount++;
      if (progressCount >= 3) conn.abortScan();
    });

    const found = await scanPromise;
    assert.equal(found.length, 0);
    assert.ok(progressCount >= 3 && progressCount <= 4);
  });

  it('rejects when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.scan(1, 1, 100), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection._probeSingle ───────────────────────────────────────────────

describe('KnxConnection._probeSingle', () => {
  it('returns null on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    // This IS the "device never answers" case - auto-answer would defeat
    // the point of it.
    conn.autoAnswerIdentityReads = false;

    const result = await conn._probeSingle('1.1.1', 50);
    assert.equal(result, null);
  });

  it('resolves with descriptor on DeviceDescriptor_Response', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const probePromise = conn._probeSingle('1.1.1', 2000);

    // Simulate a DeviceDescriptor_Response
    setTimeout(() => {
      const mgmtFrame: CemiFrame = {
        msgCode: 0x29,
        src: '1.1.1',
        dst: '1.0.1',
        isGroup: false,
        apciIdx: 13,
        apciName: 'DeviceDescriptor_Response',
        apduData: Buffer.from([0x07, 0xb0]),
        apdu: Buffer.alloc(4),
        tpciType: 'DATA_CONNECTED',
      };
      conn.emit('_mgmt', mgmtFrame);
    }, 10);

    const result = await probePromise;
    assert.ok(result);
    assert.equal(result.descriptor, '07b0');
  });

  it('returns null when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    const result = await conn._probeSingle('1.1.1', 50);
    assert.equal(result, null);
  });
});

// ── KnxConnection.downloadDevice ─────────────────────────────────────────────

describe('KnxConnection.downloadDevice', () => {
  it('processes WriteProp steps', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    // Not testing the identity-read fallback here - opt into the fast path
    // (see TestKnxConnection's doc comment) to avoid an unnecessary timeout.
    conn.autoAnswerIdentityReads = true;

    const steps: DownloadStep[] = [
      { type: 'WriteProp', objIdx: 0, propId: 56, data: Buffer.from([0x01]) },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.some((m) => m.includes('WriteProp')));
    assert.ok(progress.includes('Download complete'));
  });

  it('resolves the write service from a declared WriteProp[PropId=27] InlineData byte ==0x33 (see knx-connection-write-service.test.ts)', async () => {
    // PID_MCB_TABLE (property 27) byte 5 == 0x33 selects the extended
    // memory-write service; 0xFF or other values (e.g. 0x32) do not - see
    // docs/knx-device-write-protocol.md §4.1 for the evidence trail and
    // knx-connection-write-service.test.ts for the full resolution-chain
    // suite. This test covers the declared-WriteProp path specifically, in
    // situ inside downloadDevice().
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      {
        type: 'WriteProp',
        objIdx: 4,
        propId: 27,
        data: Buffer.from([0x00, 0x00, 0x18, 0x04, 0x00, 0x33, 0x00, 0x00]),
      },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(
      progress.some(
        (m) =>
          m.includes('PID_MCB_TABLE byte5=0x33') &&
          m.includes('static declaration'),
      ),
      'a declared WriteProp[PropId=27] byte 5 == 0x33 must resolve extended memory writes via the restored PID_MCB_TABLE signal',
    );
    // The write-service decision short-circuits on the static declaration
    // alone - it never re-derives via a live mask read. A separate live
    // DeviceDescriptor_Read still always happens when the mask is otherwise
    // unknown (see hasPeiProgramObject's doc comment, knx-connection.ts):
    // the mask decides whether to Unload interface object 5 (PEI Program),
    // independent of write-service resolution. This fake device never
    // answers it (autoAnswerIdentityReads off), so it times out and the
    // object-5 step is just skipped.
    assert.ok(
      progress.some((m) =>
        m.includes(
          'No DeviceDescriptor_Response received (object-5/PEI Program step will be skipped)',
        ),
      ),
      'the real mask is still probed once, for the object-5/PEI Program decision',
    );
  });

  it('LoadImageProp is read-only for every objIdx, including 4 (ETS never writes it there)', async () => {
    // ETS only reads this property for objIdx 1/2/3/4 - identical value
    // before/after - it never writes image/table/checksum bytes via this
    // step for any object. Writes to objIdx4/P27 come from a separate
    // WriteProp step the app's model declares explicitly (see the
    // WriteProp test below), not from LoadImageProp.
    // gaTable/assocTable are omitted (null) so downloadDevice()'s separate
    // "write undeclared GA/Association table" fallback (Part 6 of the
    // reference doc) doesn't also fire here - that's exercised by its own
    // tests.
    const hasPropWrite = (cemi: Buffer): boolean => {
      const parsed = parseCEMI(cemi);
      return (
        !!parsed &&
        parsed.apciName === 'OTHER' &&
        parsed.apdu.length >= 2 &&
        (parsed.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7
      );
    };

    for (const objIdx of [1, 2, 3, 4]) {
      const conn = new TestKnxConnection();
      conn.connected = true;
      conn.localAddr = '1.0.1';
      // Not testing the identity-read fallback here - opt into the fast
      // path to avoid a timeout per objIdx.
      conn.autoAnswerIdentityReads = true;

      const steps: DownloadStep[] = [
        { type: 'LoadImageProp', objIdx, propId: 27 },
      ];
      const progress: string[] = [];

      await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
        progress.push(p.msg),
      );

      assert.ok(
        progress.some(
          (m) => m.includes('LoadImageProp') && m.includes('read-only'),
        ),
        `objIdx=${objIdx} should log a read-only LoadImageProp message`,
      );
      assert.equal(
        conn.sent.filter(hasPropWrite).length,
        0,
        `objIdx=${objIdx} must not write PropertyValue`,
      );
    }

    // Separately: LoadImageProp itself never fabricates a property-27
    // content write for a supplied gaTable - it stays read-only. A declared
    // LoadImageProp step does not suppress the separate undeclared-table
    // fallback (see declaredTableObjIdxs in knx-connection.ts and
    // ga-assoc-table-write.test.ts), so with a gaTable supplied here that
    // fallback fires and writes it via its own
    // Unload/StartLoading/LoadData/Memory_Write/LoadCompleted cycle,
    // including PID_LOAD_STATE_CONTROL (property 5) PropertyValue_Write
    // frames - a different mechanism, so the matcher below is narrowed to
    // property 27, the only signature a LoadImageProp-driven content write
    // could plausibly use.
    const hasProp27Write = (cemi: Buffer): boolean =>
      hasPropWrite(cemi) && parseCEMI(cemi)!.apdu[3] === 27;
    const conn2 = new TestKnxConnection();
    conn2.connected = true;
    conn2.localAddr = '1.0.1';
    conn2.autoAnswerIdentityReads = true;
    const gaTable = Buffer.from([0x02, 0x08, 0x00, 0x08, 0x01]);
    await conn2.downloadDevice(
      '1.1.2',
      [{ type: 'LoadImageProp', objIdx: 1, propId: 27 }],
      gaTable,
      null,
      null,
      () => {},
    );
    assert.equal(
      conn2.sent.filter(hasProp27Write).length,
      0,
      'LoadImageProp must not itself write the supplied gaTable via a property-27 PropertyValue_Write',
    );
  });

  it('WriteProp trims propId=27 data to its real 8-byte element size', async () => {
    // The project file's declared InlineData for objIdx4/propId27 WriteProp
    // steps is always 2 bytes longer than what ETS puts on the wire -
    // consistently 10 bytes across manufacturers, with 2 trailing
    // zero-padding bytes beyond the real 8-byte element. Not observed for
    // any other property, so the trim is scoped to propId 27 only.
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.autoAnswerIdentityReads = true;

    // Real literal data from 1.1.10's own app model (M-0004_A-3030-23-F0EA-O000A).
    const declared = Buffer.from('000028c0003300000000', 'hex'); // 10 bytes
    const steps: DownloadStep[] = [
      { type: 'WriteProp', objIdx: 4, propId: 27, data: declared },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    const propFrames = conn.sent
      .map((cemi) => parseCEMI(cemi))
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p &&
          p.apdu.length >= 2 &&
          (p.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7,
      );

    assert.equal(propFrames.length, 1);
    const sentData = propFrames[0]!.apduData.subarray(4);
    assert.equal(
      sentData.length,
      8,
      'must send exactly the 8-byte element, not the declared 10',
    );
    assert.equal(sentData.toString('hex'), '000028c000330000');
  });

  it('WriteProp does NOT trim data for other properties', async () => {
    // Sanity check that the propId===27 trim is scoped correctly and
    // doesn't clip an unrelated property's legitimate multi-byte value.
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.autoAnswerIdentityReads = true;

    const data = Buffer.from('0007080770', 'hex'); // real PID_PROGRAM_VERSION-shaped example
    const steps: DownloadStep[] = [
      { type: 'WriteProp', objIdx: 4, propId: 13, data },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    const propFrames = conn.sent
      .map((cemi) => parseCEMI(cemi))
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p &&
          p.apdu.length >= 2 &&
          (p.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7,
      );

    assert.equal(propFrames.length, 1);
    assert.equal(
      propFrames[0]!.apduData.subarray(4).toString('hex'),
      '0007080770',
    );
  });

  it('processes WriteRelMem steps with chunking', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.autoAnswerIdentityReads = true;

    // 25 bytes of param memory - well under MEM_CHUNK (228, see
    // knx-connection.ts), so this exercises the single-chunk path; the
    // boundary-straddle test in relmem-write-protocol.test.ts covers the
    // multi-chunk case.
    const paramMem = Buffer.alloc(25, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 25, offset: 0x100 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, (p) =>
      progress.push(p.msg),
    );

    // Should have progress updates for each chunk
    assert.ok(progress.some((m) => m.includes('WriteRelMem')));
    assert.ok(progress.includes('Download complete'));
  });

  it('falls back to legacy Memory_Write for a 16-bit-fitting address when the device never answers DeviceDescriptor_Read', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    // This IS the "device never answers DeviceDescriptor_Read" case -
    // auto-answer would defeat the point of it.
    conn.autoAnswerIdentityReads = false;

    const paramMem = Buffer.alloc(8, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 8, offset: 0x100 },
    ];
    // No resolvedBases entry -> base defaults to 0, so addr = 0x100, well
    // under 0xFFFF. WriteRelMem reads the device's mask (A_DeviceDescriptor_
    // Read) and only forces A_MemoryExtended_Write unconditionally for a
    // System B device (mask 0x07B0) - see knx-connection.ts's WriteRelMem
    // case and the mask-gating tests in tests/relmem-write-protocol.test.ts.
    // This connection never answers the descriptor read, so this test
    // exercises the fallback: the address-size heuristic (legacy service
    // for a 16-bit-fitting address) applies when the mask is unknown.
    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, undefined);

    const writes = conn.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Write');
    assert.equal(writes.length, 1);
    const extWrites = conn.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'MemoryExtended_Write');
    assert.equal(extWrites.length, 0);
  });

  it('uses MemoryExtended_Write when the resolved relmem base pushes the address above 0xFFFF (address encoded correctly, not truncated)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    // Safe to opt into the fast path here: an address that doesn't fit in
    // 16 bits forces the extended service regardless of mask (a wire
    // constraint, not a mask-based choice), unlike the sibling
    // "falls back to legacy..." test above.
    conn.autoAnswerIdentityReads = true;

    const paramMem = Buffer.alloc(8, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 8, offset: 0x100 },
    ];
    // base 0x10000 + offset 0x100 = 0x10100 - doesn't fit in 16 bits.
    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, undefined, {
      resolvedBases: { 0: 0x10000 },
    });

    const frames = conn.sent.map((c) => parseCEMI(c));
    const extWrites = frames.filter(
      (f) => f && f.apciName === 'MemoryExtended_Write',
    );
    assert.equal(extWrites.length, 1);
    assert.equal(
      frames.filter((f) => f && f.apciName === 'Memory_Write').length,
      0,
    );
    // Verify the address actually encoded is the resolved 0x10100, not a
    // 16-bit-truncated 0x0100 - this is the exact failure mode being fixed:
    // the legacy service would have silently written to the wrong address.
    const extApduData = extWrites[0]!.apduData;
    const encodedAddr =
      (extApduData[1]! << 16) | (extApduData[2]! << 8) | extApduData[3]!;
    assert.equal(encodedAddr, 0x10100);
  });

  it('throws on WriteRelMem without paramMem', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.autoAnswerIdentityReads = true;

    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 10, offset: 0 },
    ];

    await assert.rejects(
      () => conn.downloadDevice('1.1.2', steps, null, null, null),
      { message: 'Parameter memory not available' },
    );
  });

  it('skips CompareProp steps', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.autoAnswerIdentityReads = true;

    const steps: DownloadStep[] = [
      { type: 'CompareProp', objIdx: 0, propId: 56 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.some((m) => m.includes('CompareProp')));
    assert.ok(progress.includes('Download complete'));
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(
      () => conn.downloadDevice('1.1.2', [], null, null, null),
      { message: 'Not connected' },
    );
  });

  // ── AbsoluteSegment (MDT-style) procedure — routes through planDownload ──

  it('routes AbsSegment-style steps through planDownload and sends the PID-5 sequence', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'Connect', objIdx: 0, propId: 0 },
      { type: 'Unload', objIdx: 0, propId: 0, lsmIdx: 1 },
      { type: 'Load', objIdx: 0, propId: 0, lsmIdx: 1 },
      {
        type: 'AbsSegment',
        objIdx: 0,
        propId: 0,
        lsmIdx: 1,
        address: 0x4000,
        size: 3,
      },
      { type: 'LoadCompleted', objIdx: 0, propId: 0, lsmIdx: 1 },
      { type: 'Restart', objIdx: 0, propId: 0 },
      { type: 'Disconnect', objIdx: 0, propId: 0 },
    ];
    const gaTable = Buffer.from([0x01, 0x08, 0x00]); // count=1, one GA entry
    const progress: string[] = [];

    await conn.downloadDevice(
      '1.1.2',
      steps,
      gaTable,
      null,
      null,
      (p) => progress.push(p.msg),
      {},
    );

    assert.ok(progress.includes('Download complete'));
    // 4 PID-5 propWrites (Unload, Load, Segment descriptor, LoadCompleted) +
    // the address-table memory writes (count byte + entries) + Restart.
    assert.ok(progress.some((m) => m.includes('PropWrite ObjIdx=1 PropId=5')));
    assert.ok(progress.some((m) => m.includes('MemWrite Addr=0x4000')));
    assert.ok(progress.some((m) => m.includes('Restart')));
    // Every frame actually went out over sendCEMI (still fully in-process —
    // TestKnxConnection.sendCEMI never touches a socket).
    assert.ok(conn.sent.length > 0);
  });

  it('skips memory writes for AbsSegments with no source buffer', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'Load', objIdx: 0, propId: 0, lsmIdx: 3 },
      {
        type: 'AbsSegment',
        objIdx: 0,
        propId: 0,
        lsmIdx: 3,
        address: 0x0700,
        size: 132,
      },
      { type: 'LoadCompleted', objIdx: 0, propId: 0, lsmIdx: 3 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.includes('Download complete'));
    assert.ok(!progress.some((m) => m.includes('MemWrite')));
  });
});

// ── KnxConnection.identify ───────────────────────────────────────────────────

describe('KnxConnection.identify', () => {
  it('sends memory write on then off', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const origDelay = delay;
    const delayModule = await import('../server/knx-connection.ts');

    // identify has a 3s delay - just verify it completes and sends frames.
    // The test subclass makes sendCEMI instant.
    await conn.identify('1.1.2');

    // Should have sent: CONNECT, memory_write(on), memory_write(off), DISCONNECT
    assert.ok(conn.sent.length >= 4, `sent ${conn.sent.length}, expected >= 4`);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.identify('1.1.2'), {
      message: 'Not connected',
    });
  });
});

// ── USB HID round-trip tests ──────────────────────────────────────────────────

import {
  _buildHidReports as buildHidReports,
  _parseHidReport as parseHidReport,
  _parseTransferHeader as parseTransferHeader,
  _PROTO_KNX_TUNNEL as PROTO_KNX_TUNNEL,
  _EMI_ID as EMI_ID,
  _PKT as PKT,
} from '../server/knx-usb.ts';

describe('USB HID: multi-report round-trip', () => {
  it('round-trips a frame that exactly fills one report (61 bytes)', () => {
    // 61 - 8 (header) = 53 bytes body
    const body = Buffer.alloc(53, 0xcc);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][1] & 0x0f, PKT.START_END);

    const parsed = parseHidReport(reports[0])!;
    assert.equal(parsed.dataLength, 61);
    const hdr = parseTransferHeader(parsed.data)!;
    assert.equal(hdr.bodyLength, 53);
  });

  it('round-trips a frame that needs exactly 2 reports', () => {
    // 62 bytes total frame = needs 2 reports
    // 62 - 8 (header) = 54 bytes body
    const body = Buffer.alloc(54, 0xdd);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.equal(reports.length, 2);
    assert.equal(reports[0][1] & 0x0f, PKT.START);
    assert.equal(reports[1][1] & 0x0f, PKT.END);

    // Reassemble: first report data + second report data = full frame
    const part1 = parseHidReport(reports[0])!;
    const part2 = parseHidReport(reports[1])!;
    const full = Buffer.concat([part1.data, part2.data]);
    const hdr = parseTransferHeader(full)!;
    assert.equal(hdr.bodyLength, 54);
    assert.equal(hdr.protocolId, PROTO_KNX_TUNNEL);
    assert.equal(hdr.emiId, EMI_ID.COMMON);

    // Verify body content
    const reassembledBody = full.slice(8, 8 + 54);
    assert.deepEqual(reassembledBody, body);
  });

  it('round-trips a large frame needing 3+ reports', () => {
    const body = Buffer.alloc(150, 0xee);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.ok(
      reports.length >= 3,
      `expected >= 3 reports, got ${reports.length}`,
    );

    // First is START, middle is PARTIAL, last is END
    assert.equal(reports[0][1] & 0x0f, PKT.START);
    for (let i = 1; i < reports.length - 1; i++) {
      assert.equal(reports[i][1] & 0x0f, PKT.PARTIAL);
    }
    assert.equal(reports[reports.length - 1][1] & 0x0f, PKT.END);

    // Reassemble and verify
    const parts = reports.map((r) => parseHidReport(r)!);
    const full = Buffer.concat(parts.map((p) => p.data));
    const hdr = parseTransferHeader(full)!;
    assert.equal(hdr.bodyLength, 150);

    const reassembledBody = full.slice(8, 8 + 150);
    assert.deepEqual(reassembledBody, body);
  });

  it('sequence numbers increment across reports', () => {
    const body = Buffer.alloc(150, 0x00);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);

    const seqs = reports.map((r) => parseHidReport(r)!.seq);
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1);
    }
  });
});
