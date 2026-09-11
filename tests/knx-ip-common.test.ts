/**
 * server/knx-ip-common.ts - the KNXnet/IP header and HPAI byte layouts, and
 * local-IP detection.
 *
 * Untested until now. These are small functions writing fixed offsets, and
 * every KNXnet/IP frame the app sends starts with them, so an off-by-one
 * here is a gateway that silently ignores everything.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hdr,
  hpai,
  decodePhysicalRaw,
  getLocalIp,
  HOST_PROTOCOL,
  ROUTING_MULTICAST_ADDRESS,
  ROUTING_MULTICAST_PORT,
} from '../server/knx-ip-common.ts';

describe('hdr', () => {
  it('writes the KNXnet/IP header', () => {
    // 0x06 header length, 0x10 protocol version 1.0, then the service
    // type and the total frame length, both big-endian.
    const b = hdr(0x0205, 26);
    assert.equal(b.length, 6);
    assert.deepEqual([...b], [0x06, 0x10, 0x02, 0x05, 0x00, 0x1a]);
  });

  it('carries a length past a byte', () => {
    assert.deepEqual([...hdr(0x0420, 300).subarray(4)], [0x01, 0x2c]);
  });
});

describe('hpai', () => {
  it('writes an 8-byte UDP endpoint by default', () => {
    const b = hpai('192.168.1.20', 3671);
    assert.equal(b.length, 8);
    assert.deepEqual(
      [...b],
      [0x08, HOST_PROTOCOL.UDP, 192, 168, 1, 20, 0x0e, 0x57],
    );
  });

  it('writes the TCP placeholder endpoint', () => {
    // A TCP connection's socket already defines the endpoint, so the HPAI
    // is 0.0.0.0:0 with the TCP protocol code.
    const b = hpai('0.0.0.0', 0, HOST_PROTOCOL.TCP);
    assert.deepEqual([...b], [0x08, HOST_PROTOCOL.TCP, 0, 0, 0, 0, 0, 0]);
  });

  it('writes the routing multicast endpoint', () => {
    const b = hpai(ROUTING_MULTICAST_ADDRESS, ROUTING_MULTICAST_PORT);
    assert.deepEqual([...b.subarray(2, 6)], [224, 0, 23, 12]);
    assert.equal(b.readUInt16BE(6), 3671);
  });
});

describe('decodePhysicalRaw', () => {
  it('unpacks an individual address from two bytes', () => {
    // High nibble area, low nibble line, second byte device.
    assert.equal(decodePhysicalRaw(Buffer.from([0x11, 0x0a]), 0), '1.1.10');
    assert.equal(decodePhysicalRaw(Buffer.from([0x00, 0x00]), 0), '0.0.0');
    assert.equal(decodePhysicalRaw(Buffer.from([0xff, 0xff]), 0), '15.15.255');
  });

  it('reads from an offset', () => {
    const buf = Buffer.from([0xaa, 0xbb, 0x21, 0x05]);
    assert.equal(decodePhysicalRaw(buf, 2), '2.1.5');
  });
});

describe('getLocalIp', () => {
  const original = process.env.KNX_LOCAL_IP;

  afterEach(() => {
    if (original === undefined) delete process.env.KNX_LOCAL_IP;
    else process.env.KNX_LOCAL_IP = original;
  });

  it('honours the override', () => {
    // The documented NAT/VPN escape hatch: 0.0.0.0 makes the gateway reply
    // to the UDP source address instead of a possibly-wrong detected one.
    process.env.KNX_LOCAL_IP = '0.0.0.0';
    assert.equal(getLocalIp(), '0.0.0.0');
    process.env.KNX_LOCAL_IP = '10.1.2.3';
    assert.equal(getLocalIp(), '10.1.2.3');
  });

  it('finds an address without the override', () => {
    delete process.env.KNX_LOCAL_IP;
    const ip = getLocalIp();
    // Either a real external IPv4 or the 0.0.0.0 fallback, never a
    // loopback address - binding to 127.0.0.1 would make the gateway
    // unreachable.
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.notEqual(ip.split('.')[0], '127');
  });
});
