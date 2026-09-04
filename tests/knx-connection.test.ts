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
  encodePhysical,
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
} from '../server/knx-cemi.ts';

// ── Test subclass ─────────────────────────────────────────────────────────────

class TestKnxConnection extends KnxConnection {
  sent: Buffer[] = [];
  disconnected = false;

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
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

    assert.deepEqual(seqs, [0, 1]);
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

describe('KnxConnection.programIA', () => {
  it('sends physical address write and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.programIA('1.1.5');
    assert.deepEqual(result, { ok: true, newAddr: '1.1.5' });
    assert.equal(conn.sent.length, 1);

    // Verify the CEMI is addressed to 0.0.0 (broadcast for programming)
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0.0.0');
    assert.equal(parsed.isGroup, false);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.programIA('1.1.5'), {
      message: 'Not connected',
    });
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

  it('processes LoadImageProp steps with gaTable', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const gaTable = Buffer.from([0x02, 0x08, 0x00, 0x08, 0x01]);
    const steps: DownloadStep[] = [
      { type: 'LoadImageProp', objIdx: 1, propId: 56 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, gaTable, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.some((m) => m.includes('LoadImageProp')));
  });

  it('processes WriteRelMem steps with chunking', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // 25 bytes of param memory — should be split into 3 chunks (10+10+5)
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

  it('throws on WriteRelMem without paramMem', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

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

    // Patch delay to speed up the 3-second wait
    const origDelay = delay;
    const delayModule = await import('../server/knx-connection.ts');

    // identify has a 3s delay — we just verify it runs without error
    // and sends frames. The test subclass makes sendCEMI instant.
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
