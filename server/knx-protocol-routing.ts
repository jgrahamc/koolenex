/**
 * KNXnet/IP Routing (multicast) transport - a second, connectionless
 * channel alongside the normal Tunneling connection (knx-protocol.ts).
 * See docs/knx-device-write-protocol.md §9 for background on the KNX
 * network-management broadcast services this project also implements.
 *
 * Unlike Tunneling, Routing has no connection handshake at all (no
 * CONNECT_REQ/RES, no channel ID, no CONNSTATE heartbeat) - any client on
 * the multicast group `224.0.23.12:3671` sees every ROUTING_INDICATION any
 * KNXnet/IP router on the segment sends, and can send its own the same
 * way. Confirmed on real hardware: this project's own testbed router
 * continuously mirrors live TP-bus traffic onto this multicast group
 * unprompted - joining it is enough to start receiving, no additional
 * negotiation needed.
 */

import dgram from 'dgram';
import {
  hdr,
  SVC,
  ROUTING_MULTICAST_ADDRESS,
  ROUTING_MULTICAST_PORT,
} from './knx-ip-common.ts';

// ── Packet builders ─────────────────────────────────────────────────────────────

/**
 * ROUTING_INDICATION: [6-byte header][cEMI frame] - no channel ID, no
 * sequence number, no extra fields at all, unlike TUNNELING_REQ. Confirmed
 * against Calimero's real KNXnetIPRouting implementation.
 */
export function pktRoutingInd(cemi: Buffer): Buffer {
  return Buffer.concat([hdr(SVC.ROUTING_IND, 6 + cemi.length), cemi]);
}

export interface ParsedRoutingPacket {
  svc: number;
  cemi: Buffer | null;
}

/** Parse a raw datagram from the Routing multicast group. */
export function parseRoutingPacket(msg: Buffer): ParsedRoutingPacket | null {
  if (msg.length < 6) return null;
  if (msg[0] !== 0x06 || msg[1] !== 0x10) return null;
  const svc = msg.readUInt16BE(2);
  if (svc === SVC.ROUTING_IND) {
    return { svc, cemi: msg.length > 6 ? msg.slice(6) : Buffer.alloc(0) };
  }
  // ROUTING_LOST_MESSAGE / ROUTING_BUSY carry no cEMI - recognized so
  // callers can log/react (e.g. back off on Busy), not treated as an
  // unknown/malformed packet. Full spec-compliant Busy backoff isn't
  // implemented (real usage here is light - two occasional commissioning
  // calls, not continuous high-volume routing) but the packet is at least
  // correctly identified rather than silently mis-parsed as something else.
  if (svc === SVC.ROUTING_LOST_MSG || svc === SVC.ROUTING_BUSY) {
    return { svc, cemi: null };
  }
  return null;
}

// ── KnxRoutingSocket ───────────────────────────────────────────────────────────

/**
 * Thin wrapper around a UDP multicast socket joined to the KNXnet/IP
 * Routing group. Not connection-oriented - `start()` joins the group and
 * begins delivering parsed cEMI frames to `onCemi`; `send()` and `stop()`
 * work regardless of whether anything has ever been received.
 */
export class KnxRoutingSocket {
  private socket: dgram.Socket | null = null;
  private onCemi: ((cemi: Buffer) => void) | null = null;
  private onLog: ((msg: string) => void) | null = null;

  /**
   * Join the Routing multicast group and start delivering received cEMI
   * frames to `onCemi`. Resolves once the socket is bound and joined -
   * does NOT wait for any traffic (Routing is receive-whenever, there's no
   * handshake to complete). `onLog`, if given, is called with a short
   * string for every recognized-but-not-forwarded packet (ROUTING_LOST_MSG/
   * ROUTING_BUSY) - purely diagnostic, safe to ignore.
   */
  start(
    onCemi: (cemi: Buffer) => void,
    onLog?: (msg: string) => void,
  ): Promise<void> {
    this.onCemi = onCemi;
    this.onLog = onLog ?? null;
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = sock;

      sock.on('error', (err: Error) => {
        // A Routing failure must never take down the primary Tunneling
        // connection - System Broadcast services simply won't work
        // (surfaced when they're actually called), everything else is
        // unaffected. Swallow post-bind errors; a pre-bind error rejects
        // start() so the caller can decide whether to proceed without
        // Routing at all.
        if (!sock.address) reject(err);
      });

      sock.on('message', (msg: Buffer) => {
        const parsed = parseRoutingPacket(msg);
        if (!parsed) return;
        if (parsed.cemi) this.onCemi?.(parsed.cemi);
        else
          this.onLog?.(
            `Routing: received ${parsed.svc === SVC.ROUTING_BUSY ? 'ROUTING_BUSY' : 'ROUTING_LOST_MESSAGE'}`,
          );
      });

      sock.bind(ROUTING_MULTICAST_PORT, () => {
        try {
          sock.addMembership(ROUTING_MULTICAST_ADDRESS);
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  }

  /** Send a cEMI frame as a ROUTING_INDICATION to the multicast group. */
  send(cemi: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Routing socket not started'));
        return;
      }
      const pkt = pktRoutingInd(cemi);
      this.socket.send(
        pkt,
        0,
        pkt.length,
        ROUTING_MULTICAST_PORT,
        ROUTING_MULTICAST_ADDRESS,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  stop(): void {
    if (!this.socket) return;
    try {
      this.socket.dropMembership(ROUTING_MULTICAST_ADDRESS);
    } catch (_) {}
    try {
      this.socket.close();
    } catch (_) {}
    this.socket = null;
    this.onCemi = null;
    this.onLog = null;
  }

  get active(): boolean {
    return this.socket !== null;
  }
}
