/**
 * Tests for KNXnet/IP Routing (multicast) packet builders/parsers - see
 * server/knx-protocol-routing.ts and docs/knx-device-write-protocol.md §9 /
 * docs/knx-device-write-protocol.md §9. Pure-function coverage only,
 * matching this codebase's existing convention for the other IP transport
 * (KnxIpConnection's dgram-socket integration isn't unit-tested either,
 * relying on real-hardware testing instead - see this branch's commit
 * history for that).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pktRoutingInd,
  parseRoutingPacket,
} from '../server/knx-protocol-routing.ts';
import { _SVC as SVC } from '../server/knx-protocol.ts';

describe('pktRoutingInd', () => {
  it('wraps a cEMI frame with a 6-byte header, no extra fields', () => {
    const cemi = Buffer.from([0x29, 0x00, 0xa0, 0x60, 0x11, 0x02, 0x00, 0x00, 0x01, 0x00, 0x00]);
    const pkt = pktRoutingInd(cemi);
    assert.equal(pkt.length, 6 + cemi.length);
    assert.equal(pkt[0], 0x06);
    assert.equal(pkt[1], 0x10);
    assert.equal(pkt.readUInt16BE(2), SVC.ROUTING_IND);
    assert.equal(pkt.readUInt16BE(4), 6 + cemi.length);
    assert.deepEqual([...pkt.slice(6)], [...cemi]);
  });
});

describe('parseRoutingPacket', () => {
  it('extracts the cEMI frame from a real ROUTING_INDICATION', () => {
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0x50, 0x11, 0x02, 0xff, 0xff, 0x01, 0x03, 0x00]);
    const pkt = pktRoutingInd(cemi);
    const parsed = parseRoutingPacket(pkt);
    assert.ok(parsed);
    assert.equal(parsed!.svc, SVC.ROUTING_IND);
    assert.deepEqual([...parsed!.cemi!], [...cemi]);
  });

  it('recognizes ROUTING_LOST_MESSAGE with no cEMI payload', () => {
    const pkt = Buffer.from([0x06, 0x10, 0x05, 0x31, 0x00, 0x08, 0x00, 0x03]);
    const parsed = parseRoutingPacket(pkt);
    assert.ok(parsed);
    assert.equal(parsed!.svc, SVC.ROUTING_LOST_MSG);
    assert.equal(parsed!.cemi, null);
  });

  it('recognizes ROUTING_BUSY with no cEMI payload', () => {
    const pkt = Buffer.from([0x06, 0x10, 0x05, 0x32, 0x00, 0x08, 0x00, 0x64]);
    const parsed = parseRoutingPacket(pkt);
    assert.ok(parsed);
    assert.equal(parsed!.svc, SVC.ROUTING_BUSY);
    assert.equal(parsed!.cemi, null);
  });

  it('returns null for a too-short buffer', () => {
    assert.equal(parseRoutingPacket(Buffer.from([0x06, 0x10, 0x05])), null);
  });

  it('returns null for a non-KNXnet/IP buffer (wrong magic bytes)', () => {
    const pkt = Buffer.from([0x07, 0x10, 0x05, 0x30, 0x00, 0x08]);
    assert.equal(parseRoutingPacket(pkt), null);
  });

  it('returns null for an unrecognized service type', () => {
    const pkt = Buffer.from([0x06, 0x10, 0x99, 0x99, 0x00, 0x08]);
    assert.equal(parseRoutingPacket(pkt), null);
  });

  it('handles an empty cEMI body without throwing', () => {
    const pkt = pktRoutingInd(Buffer.alloc(0));
    const parsed = parseRoutingPacket(pkt);
    assert.ok(parsed);
    assert.equal(parsed!.cemi!.length, 0);
  });
});
