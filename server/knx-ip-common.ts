/**
 * Shared low-level KNXnet/IP wire-format helpers - the 6-byte header, HPAI
 * (Host Protocol Address Information) structure, and service-type codes -
 * used by every KNXnet/IP transport variant this codebase implements
 * (UDP/TCP Tunneling in knx-protocol.ts, Routing/multicast in
 * knx-protocol-routing.ts). Extracted 2026-08-30 so the three transports
 * share one source of truth for these structures instead of drifting.
 *
 * Real spec facts here are cross-checked against Calimero's real
 * open-source implementation (calimero-project/calimero-core), same
 * methodology used for the serial-number addressing research - see
 * docs/knx-device-write-protocol.md §9 for the full evidence trail.
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
  // Routing (connectionless) - real values confirmed against Calimero's
  // KNXnetIPHeader.java (ROUTING_IND/ROUTING_LOST_MSG/ROUTING_BUSY), not
  // guessed. See knx-protocol-routing.ts.
  ROUTING_IND: 0x0530,
  ROUTING_LOST_MSG: 0x0531,
  ROUTING_BUSY: 0x0532,
} as const;

// HPAI "Host Protocol Code" byte - which transport an endpoint describes.
// Confirmed against Calimero's HPAI.java (IPV4_UDP/IPV4_TCP constants).
export const HOST_PROTOCOL = {
  UDP: 0x01,
  TCP: 0x02,
} as const;

// Real KNXnet/IP Routing default multicast group - confirmed against
// Calimero's KNXnetIPRouting.DEFAULT_MULTICAST and matches Falcon SDK's
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
 * Build an 8-byte HPAI. `hostProtocol` defaults to UDP (0x01), matching
 * every existing call site. For TCP, real KNXnet/IP connections use a
 * placeholder HPAI - protocol code TCP, address 0.0.0.0, port 0 (Calimero's
 * `HPAI.Tcp` constant) - since the TCP socket itself already defines the
 * real endpoint; pass ip='0.0.0.0', port=0, hostProtocol=HOST_PROTOCOL.TCP
 * for that case rather than the real local IP/port.
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

export function decodePhysicalRaw(buf: Buffer, off: number): string {
  const b0 = buf[off]!;
  const b1 = buf[off + 1]!;
  return `${b0 >> 4}.${b0 & 0xf}.${b1}`;
}

// ── Local IP detection ─────────────────────────────────────────────────────────

export function getLocalIp(): string {
  // Override for NAT/VPN: set KNX_LOCAL_IP=0.0.0.0 so the gateway replies to the
  // UDP source address instead of an auto-detected (and possibly wrong) interface.
  if (process.env.KNX_LOCAL_IP) return process.env.KNX_LOCAL_IP;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}
