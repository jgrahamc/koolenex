/**
 * Frame-level tests for behaviour around connection set-up and identity reads:
 *
 *  - the two Tunnelling-feature requests sent right after a tunnel connect
 *    (exact bytes, order, two-byte sequence counter) and how feature
 *    responses / unprompted feature info are surfaced
 *  - which source address group write()/read() use, vs management traffic
 *  - the security-object probe issued by readDeviceInfo()
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import { _SVC as SVC } from '../server/knx-protocol.ts';
import {
  pktTunnelFeature,
  TUNNELING_FEATURE,
} from '../server/knx-ip-common.ts';
import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduConnectedFull,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';

// ── Tunnelling feature negotiation ────────────────────────────────────────────

/** A CONNECT_RESPONSE: channel `ch`, status OK, assigned address 1.1.2. */
function connectResponse(ch: number, status = 0x00): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0x06;
  buf[1] = 0x10;
  buf.writeUInt16BE(SVC.CONNECT_RES, 2);
  buf.writeUInt16BE(20, 4);
  buf[6] = ch;
  buf[7] = status;
  buf[8] = 0x04;
  buf[9] = 0x04;
  buf[10] = 0x08;
  buf[11] = 0x01;
  buf[18] = 0x11;
  buf[19] = 0x02;
  return buf;
}

type IpConn = KnxIpConnection & Record<string, any>;

function tcpConn(writes: Buffer[]): IpConn {
  const conn = new KnxIpConnection() as IpConn;
  conn.transport = 'tcp';
  conn.tcpSocket = { write: (b: Buffer) => writes.push(Buffer.from(b)) };
  return conn;
}

describe('tunnel connect: Tunnelling feature negotiation', () => {
  it('sends BusStatus GET then InfoServiceEnable SET (=1) straight after a successful connect, with exact bytes', () => {
    const writes: Buffer[] = [];
    const conn = tcpConn(writes);
    try {
      conn._onConnectRes(connectResponse(0x42));
      assert.equal(writes.length, 2, 'exactly two frames before any heartbeat');
      assert.equal(
        writes[0]!.toString('hex'),
        // header: svc 0x0422, total length 12 | struct len 4, channel 0x42, seq 0x0000, feature 0x03, reserved 0
        '06100422000c044200000300',
      );
      assert.equal(
        writes[1]!.toString('hex'),
        // header: svc 0x0424, total length 13 | struct len 4, channel 0x42, seq 0x0001, feature 0x08, reserved 0, value 0x01
        '06100424000d04420001080001',
      );
      assert.equal(conn._featureSeq, 2);
    } finally {
      conn._clearHeartbeat();
    }
  });

  it('sends them over UDP too (to the gateway endpoint)', () => {
    const sent: Array<{ buf: Buffer; port: number; host: string }> = [];
    const conn = new KnxIpConnection() as IpConn;
    conn.transport = 'udp';
    conn.host = '10.0.0.9';
    conn.port = 3671;
    conn.udpSocket = {
      send: (
        buf: Buffer,
        _off: number,
        _len: number,
        port: number,
        host: string,
      ) => sent.push({ buf: Buffer.from(buf), port, host }),
    };
    try {
      conn._onConnectRes(connectResponse(0x07));
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.buf.toString('hex'), '06100422000c040700000300');
      assert.equal(sent[1]!.buf.toString('hex'), '06100424000d04070001080001');
      assert.ok(sent.every((s) => s.host === '10.0.0.9' && s.port === 3671));
    } finally {
      conn._clearHeartbeat();
    }
  });

  it('the sequence counter is two bytes wide', () => {
    const writes: Buffer[] = [];
    const conn = tcpConn(writes);
    conn._featureSeq = 0x01ff;
    try {
      conn._onConnectRes(connectResponse(0x42));
      // [len][channel][seq hi][seq lo][feature][reserved]
      assert.deepEqual(
        [...writes[0]!.subarray(6, 10)],
        [0x04, 0x42, 0x01, 0xff],
      );
      assert.deepEqual(
        [...writes[1]!.subarray(6, 10)],
        [0x04, 0x42, 0x02, 0x00],
      );
    } finally {
      conn._clearHeartbeat();
    }
  });

  it('sends nothing when the gateway refuses the connection', () => {
    const writes: Buffer[] = [];
    const conn = tcpConn(writes);
    let failed: Error | null = null;
    conn.on('_connectFailed', (e: Error) => {
      failed = e;
    });
    conn._onConnectRes(connectResponse(0x00, 0x24));
    assert.ok(failed);
    assert.equal(writes.length, 0);
    assert.equal(conn.connected, false);
  });

  it('pktTunnelFeature: a GET carries no value byte, a SET carries one', () => {
    assert.equal(
      pktTunnelFeature(
        SVC.TUNNELING_FEATURE_GET,
        5,
        0x0102,
        TUNNELING_FEATURE.BUS_STATUS,
      ).toString('hex'),
      '06100422000c040501020300',
    );
    assert.equal(
      pktTunnelFeature(
        SVC.TUNNELING_FEATURE_SET,
        5,
        0x0102,
        TUNNELING_FEATURE.INFO_SERVICE_ENABLE,
        0x01,
      ).toString('hex'),
      '06100424000d04050102080001',
    );
  });
});

/** A TunnelFeatureResponse/Info message: [hdr][04][channel][seq:2][feature][ret][value...]. */
function featureMsg(svc: number, featureId: number, value: number[]): Buffer {
  const body = Buffer.from([0x04, 0x42, 0x00, 0x00, featureId, 0x00, ...value]);
  const hdr = Buffer.from([0x06, 0x10, 0, 0, 0, 0]);
  hdr.writeUInt16BE(svc, 2);
  hdr.writeUInt16BE(6 + body.length, 4);
  return Buffer.concat([hdr, body]);
}

describe('_onTunnelingFeature (via the message dispatcher)', () => {
  function collect(conn: IpConn): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    conn.on('_featureInfo', (p: Record<string, unknown>) => seen.push(p));
    return seen;
  }

  it('a response to BusStatus is surfaced as a solicited, named feature value', () => {
    const conn = new KnxIpConnection() as IpConn;
    const seen = collect(conn);
    conn._onMsg(
      featureMsg(
        SVC.TUNNELING_FEATURE_RESPONSE,
        TUNNELING_FEATURE.BUS_STATUS,
        [0x01],
      ),
    );
    assert.deepEqual(seen, [
      {
        featureId: 0x03,
        featureName: 'BusStatus',
        valueHex: '01',
        unprompted: false,
      },
    ]);
  });

  it('an unprompted TunnelFeatureInfo is flagged unprompted', () => {
    const conn = new KnxIpConnection() as IpConn;
    const seen = collect(conn);
    conn._onMsg(
      featureMsg(
        SVC.TUNNELING_FEATURE_INFO,
        TUNNELING_FEATURE.BUS_STATUS,
        [0x00],
      ),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.unprompted, true);
    assert.equal(seen[0]!.featureName, 'BusStatus');
    assert.equal(seen[0]!.valueHex, '00');
  });

  it('names InfoServiceEnable, and reports an unknown feature id in hex', () => {
    const conn = new KnxIpConnection() as IpConn;
    const seen = collect(conn);
    conn._onMsg(
      featureMsg(
        SVC.TUNNELING_FEATURE_RESPONSE,
        TUNNELING_FEATURE.INFO_SERVICE_ENABLE,
        [0x01],
      ),
    );
    conn._onMsg(featureMsg(SVC.TUNNELING_FEATURE_RESPONSE, 0x77, [0xab, 0xcd]));
    assert.equal(seen[0]!.featureName, 'InfoServiceEnable');
    assert.equal(seen[1]!.featureName, '0x77');
    assert.equal(seen[1]!.valueHex, 'abcd');
  });

  it('reads the feature id from the two-byte-sequence layout (byte 10), not byte 9', () => {
    const conn = new KnxIpConnection() as IpConn;
    const seen = collect(conn);
    // Non-zero sequence bytes: a one-byte-sequence reading would take the low
    // sequence byte (0x08) as the feature id, which happens to be a valid one.
    const msg = featureMsg(
      SVC.TUNNELING_FEATURE_RESPONSE,
      TUNNELING_FEATURE.BUS_STATUS,
      [0x01],
    );
    msg[9] = 0x08;
    conn._onMsg(msg);
    assert.equal(seen[0]!.featureName, 'BusStatus');
  });

  it('ignores a truncated message', () => {
    const conn = new KnxIpConnection() as IpConn;
    const seen = collect(conn);
    const msg = featureMsg(
      SVC.TUNNELING_FEATURE_RESPONSE,
      TUNNELING_FEATURE.BUS_STATUS,
      [0x01],
    ).subarray(0, 11);
    conn._onTunnelingFeature(msg, false);
    assert.equal(seen.length, 0);
  });
});

// ── Group communication source address ────────────────────────────────────────

describe('group write()/read() source address', () => {
  function ipConn(sent: Buffer[], assigned: string | null): IpConn {
    const conn = new KnxIpConnection() as IpConn;
    conn.connected = true;
    conn.localAddr = '1.0.1';
    conn.assignedAddr = assigned;
    conn.sendCEMI = async (c: Buffer) => {
      sent.push(c);
    };
    return conn;
  }

  it('write() is sourced from the gateway-assigned tunnel address once known', async () => {
    const sent: Buffer[] = [];
    const conn = ipConn(sent, '1.1.250');
    await conn.write('1/2/3', true, '1');
    const f = parseCEMI(sent[0]!)!;
    assert.equal(f.src, '1.1.250');
    assert.equal(f.dst, '1/2/3');
    assert.equal(f.isGroup, true);
    assert.equal(f.apciName, 'GroupValue_Write');
  });

  it('read() is sourced from the gateway-assigned tunnel address once known', async () => {
    const sent: Buffer[] = [];
    const conn = ipConn(sent, '1.1.250');
    await assert.rejects(() => conn.read('1/2/3', 50), /Read timeout/);
    const f = parseCEMI(sent[0]!)!;
    assert.equal(f.src, '1.1.250');
    assert.equal(f.dst, '1/2/3');
    assert.equal(f.apciName, 'GroupValue_Read');
  });

  it('before any address has been assigned, group frames use the local address', async () => {
    const sent: Buffer[] = [];
    const conn = ipConn(sent, null);
    await conn.write('1/2/3', false, '1');
    assert.equal(parseCEMI(sent[0]!)!.src, '1.0.1');
  });

  it('a transport with no assigned-address concept (base class) uses the local address', async () => {
    const sent: Buffer[] = [];
    class Plain extends KnxConnection {
      constructor() {
        super();
        this.connected = true;
        this.localAddr = '1.0.7';
      }
      sendCEMI(c: Buffer): Promise<void> {
        sent.push(c);
        return Promise.resolve();
      }
    }
    const conn = new Plain();
    assert.equal(conn.groupCommAddr, '1.0.7');
    await conn.write('4/5/6', true, '1');
    assert.equal(parseCEMI(sent[0]!)!.src, '1.0.7');
  });

  it('management traffic keeps the local address even when a tunnel address was assigned', async () => {
    const sent: Buffer[] = [];
    const conn = ipConn(sent, '1.1.250');
    await conn.managementSession('1.1.9', async () => {});
    const frames = sent.map((c) => parseCEMI(c)!);
    assert.deepEqual(
      frames.map((f) => f.tpciType),
      ['CONNECT', 'DISCONNECT'],
    );
    for (const f of frames)
      assert.equal(
        f.src,
        '1.0.1',
        'management frames must not use the tunnel address',
      );
  });
});

// ── Security-object probe in readDeviceInfo() ─────────────────────────────────

/**
 * Answers DeviceDescriptor_Read and every device-object property read with a
 * fixed value, so readDeviceInfo() can run end to end; the security-object
 * probe (A_FunctionPropertyExtState_Read) is never answered.
 */
class InfoFake extends KnxConnection {
  sent: Buffer[] = [];
  /** When set, the security-object probe is answered with this value. */
  probeAnswer: Buffer | null = null;
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
    const f = parseCEMI(cemi);
    if (!f || f.apdu.length < 2) return Promise.resolve();
    if (f.apciName === 'DeviceDescriptor_Read') {
      this.reply(
        apduGroup('DeviceDescriptor_Response', 0, Buffer.from([0x07, 0xb0])),
      );
      return Promise.resolve();
    }
    const fullApci = ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]!;
    if (fullApci === APCI_EXT.FunctionPropertyExtState_Read) {
      if (this.probeAnswer) {
        // [object type hi][object type lo][instance-1][0x10][property id]
        // [count][start index hi][start index lo][value...]
        this.reply(
          apduConnectedFull(
            0,
            APCI_EXT.FunctionPropertyExt_Response,
            Buffer.concat([
              Buffer.from([0x00, 17, 0x00, 0x10, 51, 0x01, 0x00, 0x01]),
              this.probeAnswer,
            ]),
          ),
        );
      }
    } else if (
      fullApci === APCI_EXT.PropertyValue_Read &&
      f.apduData[0] === 0
    ) {
      const propId = f.apduData[1]!;
      const value =
        propId === 11
          ? Buffer.from('010203040506', 'hex')
          : Buffer.from('00040102030405060708', 'hex');
      this.reply(
        apduConnectedFull(
          0,
          APCI_EXT.PropertyValue_Response,
          Buffer.concat([Buffer.from([0, propId, 0x11, 0x01]), value]),
        ),
      );
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Index into `sent` of the first frame matching a predicate. */
  indexOf(
    pred: (f: NonNullable<ReturnType<typeof parseCEMI>>) => boolean,
  ): number {
    return this.sent.findIndex((c) => {
      const f = parseCEMI(c);
      return !!f && pred(f);
    });
  }
}

const isExtStateRead = (
  f: NonNullable<ReturnType<typeof parseCEMI>>,
): boolean =>
  f.apdu.length >= 2 &&
  (((f.apdu[0]! & 0x03) << 8) | f.apdu[1]!) ===
    APCI_EXT.FunctionPropertyExtState_Read;

describe('readDeviceInfo() - security-object probe', () => {
  it('is sent early, inside the session and before the first identity property read, addressing object type 17 property 51', async () => {
    const dev = new InfoFake('1.1.30');
    await dev.readDeviceInfo('1.1.30');

    const descAt = dev.indexOf((f) => f.apciName === 'DeviceDescriptor_Read');
    const connectAt = dev.indexOf((f) => f.tpciType === 'CONNECT');
    const probeAt = dev.indexOf(isExtStateRead);
    const firstIdentityAt = dev.indexOf(
      (f) =>
        f.apdu.length >= 2 &&
        (((f.apdu[0]! & 0x03) << 8) | f.apdu[1]!) ===
          APCI_EXT.PropertyValue_Read,
    );
    assert.ok(probeAt >= 0, 'the probe is sent');
    assert.ok(
      descAt < connectAt && connectAt < probeAt,
      'after the descriptor read and the connect',
    );
    assert.ok(probeAt < firstIdentityAt, 'before every identity read');

    const probe = parseCEMI(dev.sent[probeAt]!)!;
    // [object type hi][object type lo][instance-1][0x10][property id][0][0]
    assert.deepEqual(
      [...probe.apduData.subarray(0, 5)],
      [0x00, 17, 0x00, 0x10, 51],
    );
  });

  it('an answered probe is matched and its value is reported as the security mode', async () => {
    const dev = new InfoFake('1.1.30');
    dev.probeAnswer = Buffer.from('0102', 'hex');
    const info = await dev.readDeviceInfo('1.1.30');
    assert.equal(info.error, undefined);
    assert.equal(info.securityMode, '0102');
    assert.equal(info.serialNumber, '010203040506');
  });

  it('silence does not change the outcome: every identity read still completes and no error is reported', async () => {
    const dev = new InfoFake('1.1.30');
    const info = await dev.readDeviceInfo('1.1.30');
    assert.equal(info.error, undefined);
    assert.equal(info.securityMode, undefined);
    assert.equal(info.serialNumber, '010203040506');
    assert.equal(info.manufacturerId, 0x0004);
  });
});
