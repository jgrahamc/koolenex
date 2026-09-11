/**
 * The USB HID receive path: KnxUsbConnection._onHidData.
 *
 * protocol.test.ts covers buildHidReports thoroughly - the send side, where
 * a frame is split across 64-byte reports. Nothing covered the other
 * direction, where those reports have to be put back together. That is
 * where a real interface's behaviour bites: a frame split across reports, a
 * dropped END leaving a half-collected buffer, a PARTIAL arriving with no
 * START before it. The failure mode is silent - a telegram that never
 * arrives - so it is worth pinning.
 *
 * Reports are built with the module's own buildHidReports, so this is a
 * genuine round trip rather than a guess at the layout.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KnxUsbConnection,
  _buildHidReports as buildHidReports,
  _PROTO_KNX_TUNNEL as PROTO_KNX_TUNNEL,
  _PROTO_BUS_FEATURE as PROTO_BUS_FEATURE,
  _EMI_ID as EMI_ID,
  _PKT as PKT,
} from '../server/knx-usb.ts';
import { buildCEMI, apduGroupWrite } from '../server/knx-cemi.ts';

/** A connection with the frame handlers captured rather than acted on. */
function harness() {
  const conn = new KnxUsbConnection();
  const bodies: Buffer[] = [];
  const cemis: unknown[] = [];
  conn._onTunnelFrame = (body: Buffer) => {
    bodies.push(Buffer.from(body));
  };
  conn._onCEMI = (cemi: unknown) => {
    cemis.push(cemi);
  };
  return { conn, bodies, cemis };
}

describe('USB HID receive: single-report frames', () => {
  it('delivers a frame that fits in one report', () => {
    const { conn, bodies } = harness();
    const body = Buffer.from([0x11, 0x00, 0xbc]);
    for (const r of buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body))
      conn._onHidData(r);
    assert.equal(bodies.length, 1);
    assert.deepEqual([...bodies[0]!], [...body]);
  });

  it('parses a real cEMI all the way to _onCEMI', () => {
    const conn = new KnxUsbConnection();
    const seen: { dst?: string }[] = [];
    conn._onCEMI = (cemi: { dst?: string }) => {
      seen.push(cemi);
    };
    const cemi = buildCEMI(
      '1.0.1',
      '1/2/3',
      apduGroupWrite(Buffer.from([1])),
      true,
    );
    for (const r of buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, cemi))
      conn._onHidData(r);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.dst, '1/2/3');
  });
});

describe('USB HID receive: frames split across reports', () => {
  // 61 data bytes per report, 8 of which the first one spends on the
  // transfer header - so anything past 53 bytes arrives in pieces.
  const bigBody = Buffer.alloc(120, 0xbb);

  it('reassembles a frame from START, PARTIAL and END', () => {
    const { conn, bodies } = harness();
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, bigBody);
    assert.ok(reports.length > 2, 'wanted a frame with a middle report');
    for (const r of reports) conn._onHidData(r);
    assert.equal(bodies.length, 1, 'one frame, delivered once');
    assert.deepEqual([...bodies[0]!], [...bigBody]);
  });

  it('delivers nothing until the END arrives', () => {
    const { conn, bodies } = harness();
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, bigBody);
    for (const r of reports.slice(0, -1)) conn._onHidData(r);
    assert.equal(bodies.length, 0);
    conn._onHidData(reports[reports.length - 1]!);
    assert.equal(bodies.length, 1);
  });

  it('re-syncs when a START interrupts an unfinished frame', () => {
    // A dropped END would otherwise leave the old pieces in front of the
    // new frame for the rest of the session.
    const { conn, bodies } = harness();
    const first = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, bigBody);
    conn._onHidData(first[0]!); // START, then nothing more

    const second = Buffer.alloc(120, 0xcc);
    for (const r of buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, second))
      conn._onHidData(r);

    assert.equal(bodies.length, 1);
    assert.deepEqual([...bodies[0]!], [...second]);
  });
});

describe('USB HID receive: reports that make no sense', () => {
  it('ignores a PARTIAL with no START before it', () => {
    const { conn, bodies } = harness();
    const reports = buildHidReports(
      PROTO_KNX_TUNNEL,
      EMI_ID.COMMON,
      Buffer.alloc(120, 0xbb),
    );
    const middle = reports.find((r) => (r[1]! & 0x0f) === PKT.PARTIAL)!;
    conn._onHidData(middle);
    assert.equal(bodies.length, 0);
  });

  it('ignores an END with no START before it', () => {
    const { conn, bodies } = harness();
    const reports = buildHidReports(
      PROTO_KNX_TUNNEL,
      EMI_ID.COMMON,
      Buffer.alloc(120, 0xbb),
    );
    conn._onHidData(reports[reports.length - 1]!);
    assert.equal(bodies.length, 0);
  });

  it('drops a frame whose transfer header is not one we speak', () => {
    const { conn, bodies } = harness();
    const [report] = buildHidReports(
      PROTO_KNX_TUNNEL,
      EMI_ID.COMMON,
      Buffer.from([0x11, 0x00]),
    );
    // Byte 3 of the report is the transfer header's protocol version.
    const bad = Buffer.from(report!);
    bad[3] = 0x99;
    conn._onHidData(bad);
    assert.equal(bodies.length, 0);
  });

  it('ignores a report too short to be one', () => {
    const { conn, bodies } = harness();
    conn._onHidData(Buffer.from([0x01]));
    assert.equal(bodies.length, 0);
  });
});

describe('USB HID receive: bus feature frames', () => {
  it('routes a feature frame away from the tunnel handler', () => {
    const { conn, bodies } = harness();
    const seen: number[] = [];
    conn._onFeatureFrame = (body: Buffer) => {
      seen.push(body[0]!);
    };
    for (const r of buildHidReports(
      PROTO_BUS_FEATURE,
      EMI_ID.COMMON,
      Buffer.from([0x03, 0x01]),
    ))
      conn._onHidData(r);
    assert.deepEqual(seen, [0x03]);
    assert.equal(bodies.length, 0, 'must not reach the cEMI path');
  });
});
