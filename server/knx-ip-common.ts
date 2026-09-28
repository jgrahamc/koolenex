/**
 * Shared low-level KNXnet/IP wire-format helpers: the 6-byte header, HPAI
 * (Host Protocol Address Information) structure, and service-type codes,
 * used by every transport variant (UDP/TCP Tunneling in knx-protocol.ts,
 * Routing/multicast in knx-protocol-routing.ts).
 *
 * Spec facts cross-checked against Calimero (calimero-project/calimero-core)
 * - see docs/knx-device-write-protocol.md §9.
 */

import os from 'os';

// ── KNXnet/IP service types ────────────────────────────────────────────────────

export const SVC = {
  SEARCH_REQ: 0x0201,
  SEARCH_RES: 0x0202,
  CONNECT_REQ: 0x0205,
  CONNECT_RES: 0x0206,
  CONNSTATE_REQ: 0x0207,
  CONNSTATE_RES: 0x0208,
  DISCONNECT_REQ: 0x0209,
  DISCONNECT_RES: 0x020a,
  TUNNELING_REQ: 0x0420,
  TUNNELING_ACK: 0x0421,
  // KNXnet/IP Tunnelling v2 "Feature" services - ETS sends
  // TUNNELING_FEATURE_GET/SET on every Tunnel connect (BusStatus /
  // InfoServiceEnable). Codes match Qt KNX's documented
  // TunnelingFeatureGet/Response/Set values.
  TUNNELING_FEATURE_GET: 0x0422,
  TUNNELING_FEATURE_RESPONSE: 0x0423,
  TUNNELING_FEATURE_SET: 0x0424,
  // Server-initiated, unprompted - sent only when InfoServiceEnable is on
  // and a negotiated feature's value changes.
  TUNNELING_FEATURE_INFO: 0x0425,
  // Routing (connectionless) - matches Calimero's KNXnetIPHeader.java
  // (ROUTING_IND/ROUTING_LOST_MSG/ROUTING_BUSY). See knx-protocol-routing.ts.
  ROUTING_IND: 0x0530,
  ROUTING_LOST_MSG: 0x0531,
  ROUTING_BUSY: 0x0532,
} as const;

// HPAI "Host Protocol Code" byte - which transport an endpoint describes.
// Matches Calimero's HPAI.java (IPV4_UDP/IPV4_TCP constants).
export const HOST_PROTOCOL = {
  UDP: 0x01,
  TCP: 0x02,
} as const;

// KNXnet/IP Routing default multicast group - matches Calimero's
// KNXnetIPRouting.DEFAULT_MULTICAST and Falcon SDK's
// IpRoutingConnectorParameters.MulticastAddress default.
export const ROUTING_MULTICAST_ADDRESS = '224.0.23.12';
export const ROUTING_MULTICAST_PORT = 3671;

// ── Packet builders ─────────────────────────────────────────────────────────────

export function hdr(svc: number, totalLen: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 0x06;
  b[1] = 0x10;
  b.writeUInt16BE(svc, 2);
  b.writeUInt16BE(totalLen, 4);
  return b;
}

/**
 * Build an 8-byte HPAI. `hostProtocol` defaults to UDP (0x01). For TCP, use
 * the spec placeholder HPAI - protocol code TCP, address 0.0.0.0, port 0
 * (Calimero's `HPAI.Tcp`) - since the TCP socket itself is the real
 * endpoint; pass ip='0.0.0.0', port=0, hostProtocol=HOST_PROTOCOL.TCP.
 */
export function hpai(
  ip: string,
  port: number,
  hostProtocol: number = HOST_PROTOCOL.UDP,
): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 0x08;
  b[1] = hostProtocol;
  ip.split('.').forEach((o, i) => {
    b[2 + i] = parseInt(o, 10);
  });
  b.writeUInt16BE(port, 6);
  return b;
}

// Tunnelling v2 Feature identifiers: `FeatureId 0x03` = BusStatus,
// `FeatureId 0x08` = InfoServiceEnable. Matches Qt KNX's documented
// `QKnx::InterfaceFeature` enum (`BusConnectionStatus`,
// `InterfaceFeatureInfoServiceEnable`).
export const TUNNELING_FEATURE = {
  BUS_STATUS: 0x03,
  INFO_SERVICE_ENABLE: 0x08,
} as const;

/**
 * Build a TunnelFeatureGet or TunnelFeatureSet body.
 *
 * SeqCounter is a two-byte field (a 1-byte SeqCounter shifts every
 * following field and the gateway rejects it with a TunnelFeatureResp
 * error). Wire shape: `[StructLength=4][ChannelId:1][SeqCounter:2]
 * [FeatureId:1][Reserved=0:1][Value...]` (Value omitted for Get). `value`,
 * when given, is a single byte - every feature covered here (BusStatus's
 * response, InfoServiceEnable's set value) is 1 byte.
 */
export function pktTunnelFeature(
  svc: number,
  channelId: number,
  seq: number,
  featureId: number,
  value?: number,
): Buffer {
  const seqBytes = [(seq >> 8) & 0xff, seq & 0xff];
  const body = Buffer.from(
    value === undefined
      ? [0x04, channelId, ...seqBytes, featureId, 0x00]
      : [0x04, channelId, ...seqBytes, featureId, 0x00, value],
  );
  return Buffer.concat([hdr(svc, 6 + body.length), body]);
}

export function decodePhysicalRaw(buf: Buffer, off: number): string {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  return `${b0 >> 4}.${b0 & 0xf}.${b1}`;
}

// ── Local IP detection ─────────────────────────────────────────────────────────

export function getLocalIp(): string {
  // Override for NAT/VPN: set KNX_LOCAL_IP=0.0.0.0 so the gateway replies to
  // the UDP source address instead of an auto-detected interface.
  if (process.env.KNX_LOCAL_IP) return process.env.KNX_LOCAL_IP;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}
