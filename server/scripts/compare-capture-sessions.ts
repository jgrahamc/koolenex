// Full-session structural comparison tool for two KNXnet/IP packet captures
// (.pcapng, taken with tshark/Wireshark).
//
// Motivation: comparing two write sessions to the same device (e.g. a real
// ETS reference capture vs this engine's own capture) by eyeballing tshark's
// text output, or by only diffing the four core interface-object memory
// regions (GA table / Association table / Object 3 / parameter memory),
// misses real differences: a property read one session sends and the other
// doesn't, session-level feature negotiation, or activity on an interface
// object outside those four (e.g. Object 5 / PEI Program). This tool
// accounts for EVERY SINGLE FRAME in a capture, from the first TCP
// handshake packet to the final disconnect, with zero silent drops - every
// frame not folded into the structural diff is still individually logged
// with an explicit reason, and internally reconciles bucket counts against
// the raw frame count so a classification gap fails loudly instead of
// silently dropping data.
//
// Usage:
//   node --experimental-strip-types server/scripts/compare-capture-sessions.ts \
//     --a "<path to reference capture>" --a-label "ets-reference" \
//     --b "<path to this engine's capture>" --b-label "koolenex-run" \
//     --a-device 1.1.10 --b-device 1.1.10 \
//     [--tshark "C:\\Program Files\\Wireshark\\tshark.exe"] \
//     [--out-dir <directory for the full per-frame audit logs>] \
//     [--content-diff]
//
// What this does NOT do: decide which differences matter. It surfaces every
// structural difference (an operation present in one capture's KNXnet/IP
// traffic and absent from the other's) plus every single non-KNX/undecoded
// frame, for a human to triage - deliberately over-inclusive rather than
// under-inclusive: if anything is dropped or ignored for any reason, even a
// legitimate one, it is logged, not silently discarded.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── CLI arg parsing ──────────────────────────────────────────────────────────

interface Args {
  aPath: string;
  aLabel: string;
  aDevice: string;
  aPort: number;
  bPath: string;
  bLabel: string;
  bDevice: string;
  bPort: number;
  tshark: string;
  outDir: string;
  /**
   * Real, additive byte-content verification. The base structural diff only
   * ever compares STRUCTURE (which operations occur, how many times), never
   * the actual payload bytes. This flag adds that: for every operation
   * signature present the SAME number of times in both captures, pairs up
   * occurrences in capture order and diffs their real memory address (from
   * the Info line, not the truncated `cemi.x` - see the header-parse
   * section below) and raw `cemi.data` bytes, reporting every mismatch.
   * Only meaningful when `--a`/`--b` capture the SAME physical device
   * across two sessions - comparing two different devices' actual content
   * is expected to differ and would just produce noise, so this is opt-in,
   * not the default.
   */
  contentDiff: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const aPath = get('a');
  const bPath = get('b');
  const aDevice = get('a-device');
  const bDevice = get('b-device');
  if (!aPath || !bPath || !aDevice || !bDevice) {
    console.error(
      'Usage: compare-capture-sessions.ts --a <capture1.pcapng> --a-device <individual address> --b <capture2.pcapng> --b-device <individual address> [--a-label x] [--b-label y] [--a-port 3671] [--b-port 3671] [--tshark path] [--out-dir dir] [--content-diff]',
    );
    process.exit(1);
  }
  return {
    aPath: path.resolve(aPath),
    aLabel: get('a-label') || path.basename(aPath, path.extname(aPath)),
    aDevice,
    // `--a-port`/`--b-port` (independent, not shared - the motivating case
    // is comparing a real router's capture on 3671 against a capture taken
    // against a deliberately non-standard test port to avoid clashing with
    // anything real on the capturing machine) default to 3671, the real KNX
    // standard port, so every existing invocation of this tool keeps
    // working unchanged. Needed because the decode-as directive below used
    // to be hardcoded to port 3671 - a capture on any other port made
    // tshark's own KNXnet/IP dissector miss every single frame, which this
    // tool's own dissector-disagreement check then (correctly, per its own
    // logic) reported as a wall of "disagreements" - a false alarm, not a
    // bug in the capture or the comparison itself.
    aPort: get('a-port') ? Number(get('a-port')) : 3671,
    bPath: path.resolve(bPath),
    bLabel: get('b-label') || path.basename(bPath, path.extname(bPath)),
    bDevice,
    bPort: get('b-port') ? Number(get('b-port')) : 3671,
    tshark: get('tshark') || 'C:\\Program Files\\Wireshark\\tshark.exe',
    outDir:
      get('out-dir') || path.resolve(process.cwd(), 'scratch-capture-audit'),
    contentDiff: argv.includes('--content-diff'),
  };
}

// ── Raw frame extraction - ONE broad tshark pass, NO display filter at all ──
//
// Deliberately no `-Y` filter anywhere in this extraction - a display filter
// is exactly how a frame could silently never reach this tool at all. Every
// frame in the file is pulled, classified, and accounted for.
//
// `-d tcp.port==${port},kip` (port defaults to 3671, the real KNX standard
// port, configurable per capture via `--a-port`/`--b-port`, see Args.aPort's
// own doc comment for why) tells tshark to also attempt the KNXnet/IP
// dissector on this port's payload - this is additive to the raw TCP fields
// below, not a filter; a frame that fails to dissect as KNXnet/IP still
// comes through with its raw tcp.payload intact and is classified
// 'tcp-payload-undecoded' below, never dropped.

const FIELDS = [
  'frame.number',
  'frame.time_relative',
  'frame.protocols',
  'ip.src',
  'ip.dst',
  'tcp.srcport',
  'tcp.dstport',
  'tcp.flags.syn',
  'tcp.flags.ack',
  'tcp.flags.fin',
  'tcp.flags.reset',
  'tcp.flags.push',
  'tcp.flags.urg',
  'tcp.seq',
  'tcp.ack',
  'tcp.len',
  'tcp.analysis.retransmission',
  'tcp.analysis.spurious_retransmission',
  'tcp.analysis.duplicate_ack',
  'tcp.analysis.out_of_order',
  'tcp.analysis.lost_segment',
  'tcp.analysis.zero_window',
  'tcp.analysis.keep_alive',
  'tcp.payload',
  // UDP support: this project's own device families use both classic
  // KNXnet/IP tunnelling over UDP port 3671 and the TCP transport - a
  // TCP-only version of this tool would silently bucket real UDP KNXnet/IP
  // frames as generic "non-tcp-frame" noise, never even attempting to
  // decode them.
  'udp.srcport',
  'udp.dstport',
  'udp.length',
  'udp.payload',
  'knxip.service',
  'cemi.mc',
  'cemi.sa',
  'cemi.da',
  'cemi.ac',
  'cemi.ax',
  'cemi.ot',
  'cemi.oi',
  'cemi.ox',
  'cemi.px',
  'cemi.pid',
  'cemi.data',
  'cemi.x',
  '_ws.col.Info',
] as const;
type FieldName = (typeof FIELDS)[number];

interface RawRow {
  values: Record<FieldName, string>;
}

function runTshark(
  tsharkPath: string,
  capturePath: string,
  port: number = 3671,
): RawRow[] {
  // `-d udp.port==3671,kip` is stated explicitly alongside the TCP directive
  // for the same reason the TCP one is explicit - never rely on an unstated
  // default matching what THIS tool assumes (tshark's own kip dissector
  // already recognizes UDP port 3671 by default, but that default could
  // change).
  const args: string[] = [
    '-r',
    capturePath,
    '-d',
    `tcp.port==${port},kip`,
    '-d',
    `udp.port==${port},kip`,
    '-T',
    'fields',
  ];
  for (const f of FIELDS) args.push('-e', f);
  // Explicit, stable separators - tshark's default is a tab between fields
  // and a comma between multiple values of the SAME field within one frame
  // (the "coalesced TCP segment" case handled by explodeOperations() below).
  // Made explicit here rather than relied on as a default, so a future
  // tshark version changing its defaults fails loudly (wrong column count)
  // instead of silently mis-parsing.
  args.push('-E', 'separator=/t', '-E', 'occurrence=a', '-E', 'aggregator=,');
  const out = execFileSync(tsharkPath, args, {
    maxBuffer: 1024 * 1024 * 1024,
  }).toString('utf8');
  const rows: RawRow[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length !== FIELDS.length) {
      throw new Error(
        `tshark column-count mismatch on a line of ${capturePath} - expected ${FIELDS.length} fields, got ${cols.length}. ` +
          `Refusing to silently misalign columns (this is exactly the class of bug that would drop data unnoticed). Line: ${line}`,
      );
    }
    const values = {} as Record<FieldName, string>;
    FIELDS.forEach((f, i) => (values[f] = cols[i] ?? ''));
    rows.push({ values });
  }
  return rows;
}

/** Split a possibly-comma-joined multi-value field into its individual values (empty string -> []). */
function splitMulti(v: string): string[] {
  return v === '' ? [] : v.split(',');
}

// ── Independent raw-byte KNXnet/IP header check - NEVER trusts tshark's dissector ──
//
// tshark's own KNXnet/IP dissector has real, documented gaps for these
// frames: `cemi.x` is silently truncated to its low 16 bits by `-T fields`'
// "show" formatting for MemoryExtended_Write, and on some captures the
// dissector misses real frames entirely (confirmed directly - see the
// `dissectorDisagreement` field below). This function reads the KNXnet/IP
// header DIRECTLY off the raw tcp.payload bytes - the fixed, simple,
// spec-defined 6-byte header (HeaderLength, ProtocolVersion, ServiceType
// uint16 BE, TotalLength uint16 BE) - completely independent of tshark's
// own KNXnet/IP dissector, and cross-checked against `knxip.service` below.
// Deliberately NOT extending this to a full hand-rolled cEMI/APCI parser in
// this pass - the APDU's TPCI/APCI bit-packing (short 4-bit vs extended
// 10-bit APCI, standard vs extended cEMI frame format) is genuinely
// intricate and exactly the area with the documented bug history; a rushed
// reimplementation risks trading a known bug for a new, less-tested one.
interface RawKnxIpHeader {
  headerLength: number;
  protocolVersion: number;
  serviceType: string; // hex, e.g. "0x0420" - same format as tshark's knxip.service for direct comparison
  totalLength: number;
  valid: boolean; // false if the bytes don't even look like a KNXnet/IP header (headerLength!=6 or version!=0x10) - a real signal tshark's dissector may have found something this check can't confirm, or vice versa
}

function parseRawKnxIpHeader(payloadHex: string): RawKnxIpHeader | null {
  const hex = payloadHex.replace(/^0x/, '');
  if (hex.length < 12) return null; // shorter than a bare 6-byte header - can't be a KNXnet/IP frame at all
  const bytes = Buffer.from(hex, 'hex');
  const headerLength = bytes[0]!;
  const protocolVersion = bytes[1]!;
  const serviceType =
    '0x' + bytes.readUInt16BE(2).toString(16).padStart(4, '0');
  const totalLength = bytes.readUInt16BE(4);
  // Every real KNXnet/IP frame this project has ever captured uses
  // HeaderLength=0x06/Version=0x10 unconditionally; a payload not matching
  // this is either genuinely not KNXnet/IP, or a TCP segment boundary that
  // split a KNXnet/IP frame's header across two packets (a real, legitimate
  // case - logged as invalid here, not asserted as definitely wrong).
  const valid = headerLength === 6 && protocolVersion === 0x10;
  return { headerLength, protocolVersion, serviceType, totalLength, valid };
}

// ── Per-frame classification - every frame lands in exactly one bucket ─────

type Bucket =
  | 'tcp-handshake-teardown' // SYN/FIN/RST, no payload
  | 'tcp-pure-ack' // ordinary ACK, no payload, no flag/analysis note
  | 'tcp-duplicate-ack'
  | 'tcp-keepalive'
  | 'tcp-retransmission-empty' // retransmission flag, zero-length payload
  | 'tcp-retransmission-with-payload' // retransmission flag, non-empty payload - logged, excluded from the structural diff to avoid double-counting an already-seen operation, but never silently dropped
  | 'tcp-out-of-order-or-analysis-only' // any other tcp.analysis flag with no payload, not otherwise classified
  | 'udp-empty' // a UDP datagram with zero-length payload - rare for KNXnet/IP but logged, not assumed impossible
  | 'knxip-frame' // payload present (TCP or UDP), tshark's KNXnet/IP dissector recognized it (knxip.service non-empty)
  | 'tcp-payload-undecoded' // TCP payload present, KNXnet/IP dissector found NOTHING - flagged for manual review, never dropped
  | 'udp-payload-undecoded' // UDP payload present, KNXnet/IP dissector found NOTHING - same treatment, own bucket for clarity in the summary
  | 'non-tcp-udp-frame'; // frame.protocols contains neither tcp nor udp - e.g. stray ARP/mDNS on the same interface

interface ClassifiedFrame {
  frameNumber: number;
  bucket: Bucket;
  row: RawRow;
  reason: string;
  /** 'tcp' or 'udp' - which transport actually carried this frame's KNXnet/IP payload, if any. Null for non-tcp-udp-frame. */
  transport: 'tcp' | 'udp' | null;
  /** The raw payload hex actually used for this frame's KNX decode - tcp.payload or udp.payload, whichever applies. Empty if none. */
  payloadHex: string;
  /** Independent raw-byte KNXnet/IP header parse, present whenever a payload existed - see parseRawKnxIpHeader()'s own doc comment for why this exists (never trust tshark's dissector alone). */
  rawHeader: RawKnxIpHeader | null;
  /** Set when tshark's dissector and this script's own independent raw-byte header parse DISAGREE (or one found something the other didn't) - a real, loud finding, never silently resolved either way. */
  dissectorDisagreement: string | null;
}

function classify(row: RawRow): ClassifiedFrame {
  const v = row.values;
  const frameNumber = Number(v['frame.number']);
  const protocols = v['frame.protocols'];
  const isTcp = protocols.includes(':tcp') || protocols === 'tcp';
  const isUdp = !isTcp && (protocols.includes(':udp') || protocols === 'udp');

  if (!isTcp && !isUdp) {
    return {
      frameNumber,
      bucket: 'non-tcp-udp-frame',
      row,
      reason: `frame.protocols="${protocols}" - neither TCP nor UDP`,
      transport: null,
      payloadHex: '',
      rawHeader: null,
      dissectorDisagreement: null,
    };
  }

  const hasKnxip = v['knxip.service'] !== '';

  if (isUdp) {
    const udpLen = Number(v['udp.length'] || '0');
    const payloadLen = udpLen > 8 ? udpLen - 8 : 0; // udp.length includes the 8-byte UDP header itself
    const payloadHex = v['udp.payload'];
    const rawHeader =
      payloadLen > 0 && payloadHex ? parseRawKnxIpHeader(payloadHex) : null;
    let dissectorDisagreement: string | null = null;
    if (payloadLen > 0) {
      const tsharkFirstService = splitMulti(v['knxip.service'])[0] ?? null;
      if (hasKnxip && (!rawHeader || !rawHeader.valid)) {
        dissectorDisagreement = `[UDP] tshark decoded this as KNXnet/IP (service=${v['knxip.service']}) but this script's own raw-byte header parse says INVALID/absent - review raw hex directly.`;
      } else if (
        hasKnxip &&
        rawHeader &&
        rawHeader.valid &&
        tsharkFirstService &&
        tsharkFirstService.toLowerCase() !== rawHeader.serviceType.toLowerCase()
      ) {
        dissectorDisagreement = `[UDP] tshark says knxip.service=${tsharkFirstService} but this script's raw-byte parse says ${rawHeader.serviceType} - review raw hex directly.`;
      } else if (!hasKnxip && rawHeader && rawHeader.valid) {
        dissectorDisagreement = `[UDP] tshark's KNXnet/IP dissector found NOTHING for this frame, but this script's own raw-byte header parse finds a VALID-LOOKING KNXnet/IP header (service=${rawHeader.serviceType}) - tshark's dissector likely MISSED a real frame here.`;
      }
    }
    if (payloadLen === 0) {
      return {
        frameNumber,
        bucket: 'udp-empty',
        row,
        reason: 'zero-length UDP datagram',
        transport: 'udp',
        payloadHex: '',
        rawHeader: null,
        dissectorDisagreement: null,
      };
    }
    if (hasKnxip || (rawHeader && rawHeader.valid)) {
      return {
        frameNumber,
        bucket: 'knxip-frame',
        row,
        reason: hasKnxip
          ? 'UDP payload dissected as KNXnet/IP by tshark'
          : "UDP payload NOT dissected by tshark but this script's own raw-byte header parse found a valid KNXnet/IP header - tshark miss, not a real absence",
        transport: 'udp',
        payloadHex,
        rawHeader,
        dissectorDisagreement,
      };
    }
    return {
      frameNumber,
      bucket: 'udp-payload-undecoded',
      row,
      reason: `${payloadLen}-byte UDP payload present but neither tshark's KNXnet/IP dissector NOR this script's own independent raw-byte header check recognized it - MANUAL REVIEW NEEDED, raw hex in the per-frame audit log`,
      transport: 'udp',
      payloadHex,
      rawHeader,
      dissectorDisagreement,
    };
  }

  // isTcp
  const tcpLen = Number(v['tcp.len'] || '0');
  const isRetrans =
    v['tcp.analysis.retransmission'] !== '' ||
    v['tcp.analysis.spurious_retransmission'] !== '';
  const isDupAck = v['tcp.analysis.duplicate_ack'] !== '';
  const isKeepAlive = v['tcp.analysis.keep_alive'] !== '';
  const isOutOfOrder = v['tcp.analysis.out_of_order'] !== '';
  const isLostSegment = v['tcp.analysis.lost_segment'] !== '';
  const isZeroWindow = v['tcp.analysis.zero_window'] !== '';
  const isSynFinRst =
    v['tcp.flags.syn'] === '1' ||
    v['tcp.flags.fin'] === '1' ||
    v['tcp.flags.reset'] === '1';
  const payloadHex = v['tcp.payload'];
  const rawHeader =
    tcpLen > 0 && payloadHex ? parseRawKnxIpHeader(payloadHex) : null;

  // Cross-check, independent of every other classification decision below -
  // computed whenever a payload exists, regardless of what bucket it lands
  // in, precisely so tshark's own dissector never gets the final, unchecked
  // word on whether/what this frame is.
  let dissectorDisagreement: string | null = null;
  if (tcpLen > 0) {
    const tsharkFirstService = splitMulti(v['knxip.service'])[0] ?? null;
    if (hasKnxip && (!rawHeader || !rawHeader.valid)) {
      dissectorDisagreement = `tshark decoded this as KNXnet/IP (service=${v['knxip.service']}) but this script's own raw-byte header parse says INVALID/absent (rawHeader=${JSON.stringify(rawHeader)}) - review raw hex directly.`;
    } else if (
      hasKnxip &&
      rawHeader &&
      rawHeader.valid &&
      tsharkFirstService &&
      tsharkFirstService.toLowerCase() !== rawHeader.serviceType.toLowerCase()
    ) {
      dissectorDisagreement = `tshark says knxip.service=${tsharkFirstService} but this script's raw-byte parse of the same payload's bytes 2-3 says ${rawHeader.serviceType} - one of the two is wrong, review raw hex directly.`;
    } else if (!hasKnxip && rawHeader && rawHeader.valid) {
      dissectorDisagreement = `tshark's KNXnet/IP dissector found NOTHING for this frame, but this script's own raw-byte header parse finds a VALID-LOOKING KNXnet/IP header (service=${rawHeader.serviceType}) - tshark's dissector likely MISSED a real frame here. Treated as a real operation using the raw-parsed service type; cemi-level fields are unavailable for it since only tshark provides those.`;
    }
  }

  if (tcpLen === 0) {
    if (isRetrans)
      return {
        frameNumber,
        bucket: 'tcp-retransmission-empty',
        row,
        reason: 'zero-length TCP retransmission (e.g. keepalive-triggered)',
        transport: 'tcp',
        payloadHex: '',
        rawHeader,
        dissectorDisagreement,
      };
    if (isDupAck)
      return {
        frameNumber,
        bucket: 'tcp-duplicate-ack',
        row,
        reason: 'duplicate ACK, no payload',
        transport: 'tcp',
        payloadHex: '',
        rawHeader,
        dissectorDisagreement,
      };
    if (isKeepAlive)
      return {
        frameNumber,
        bucket: 'tcp-keepalive',
        row,
        reason: 'TCP keepalive probe/response, no payload',
        transport: 'tcp',
        payloadHex: '',
        rawHeader,
        dissectorDisagreement,
      };
    if (isSynFinRst)
      return {
        frameNumber,
        bucket: 'tcp-handshake-teardown',
        row,
        reason: 'SYN/FIN/RST control segment, no payload',
        transport: 'tcp',
        payloadHex: '',
        rawHeader,
        dissectorDisagreement,
      };
    if (isOutOfOrder || isLostSegment || isZeroWindow) {
      return {
        frameNumber,
        bucket: 'tcp-out-of-order-or-analysis-only',
        row,
        reason: `tcp.analysis flag(s) set with no payload (out_of_order=${isOutOfOrder} lost_segment=${isLostSegment} zero_window=${isZeroWindow})`,
        transport: 'tcp',
        payloadHex: '',
        rawHeader,
        dissectorDisagreement,
      };
    }
    return {
      frameNumber,
      bucket: 'tcp-pure-ack',
      row,
      reason: 'ordinary ACK, no payload, no analysis flags',
      transport: 'tcp',
      payloadHex: '',
      rawHeader,
      dissectorDisagreement,
    };
  }
  // tcpLen > 0
  if (isRetrans) {
    return {
      frameNumber,
      bucket: 'tcp-retransmission-with-payload',
      row,
      reason:
        'TCP-level retransmission of a payload already seen in an earlier frame - excluded from the structural op diff to avoid double-counting, but not dropped: full raw payload is in the per-frame audit log',
      transport: 'tcp',
      payloadHex,
      rawHeader,
      dissectorDisagreement,
    };
  }
  if (hasKnxip || (rawHeader && rawHeader.valid)) {
    // Either tshark recognized it, OR our own raw-byte check found a valid
    // header tshark missed (see dissectorDisagreement above, set in that
    // case) - both land here so the frame contributes a real operation
    // either way, never silently discarded into "undecoded" just because
    // tshark's dissector happened to miss it.
    return {
      frameNumber,
      bucket: 'knxip-frame',
      row,
      reason: hasKnxip
        ? 'payload dissected as KNXnet/IP by tshark'
        : "payload NOT dissected by tshark but this script's own raw-byte header parse found a valid KNXnet/IP header - tshark miss, not a real absence",
      transport: 'tcp',
      payloadHex,
      rawHeader,
      dissectorDisagreement,
    };
  }
  return {
    frameNumber,
    bucket: 'tcp-payload-undecoded',
    row,
    reason: `${tcpLen}-byte TCP payload present but neither tshark's KNXnet/IP dissector NOR this script's own independent raw-byte header check recognized it - MANUAL REVIEW NEEDED, raw hex in the per-frame audit log`,
    transport: 'tcp',
    payloadHex,
    rawHeader,
    dissectorDisagreement,
  };
}

// ── KNXnet/IP service names (from tshark's own protocol registry, confirmed via `tshark -G values`) ──

const KNXIP_SERVICE_NAMES: Record<string, string> = {
  '0x0201': 'SEARCH_REQUEST',
  '0x0202': 'SEARCH_RESPONSE',
  '0x0203': 'DESCRIPTION_REQUEST',
  '0x0204': 'DESCRIPTION_RESPONSE',
  '0x0205': 'CONNECT_REQUEST',
  '0x0206': 'CONNECT_RESPONSE',
  '0x0207': 'CONNECTIONSTATE_REQUEST',
  '0x0208': 'CONNECTIONSTATE_RESPONSE',
  '0x0209': 'DISCONNECT_REQUEST',
  '0x020a': 'DISCONNECT_RESPONSE',
  '0x0310': 'DEVICE_CONFIGURATION_REQUEST',
  '0x0311': 'DEVICE_CONFIGURATION_ACK',
  '0x0420': 'TUNNELING_REQUEST',
  '0x0421': 'TUNNELING_ACK',
  '0x0422': 'TUNNELING_FEATURE_GET',
  '0x0423': 'TUNNELING_FEATURE_RESPONSE',
  '0x0424': 'TUNNELING_FEATURE_SET',
  '0x0425': 'TUNNELING_FEATURE_INFO',
  '0x0530': 'ROUTING_INDICATION',
  '0x0531': 'ROUTING_LOST_MESSAGE',
  '0x0532': 'ROUTING_BUSY',
};

/** cEMI message codes we may encounter - both bus-level (L_Data) and local device-management (M_*). Anything not listed still gets a signature via its raw hex code, never dropped for lack of a name. */
const CEMI_MC_NAMES: Record<string, string> = {
  '0x11': 'L_Data.req',
  '0x2e': 'L_Data.con',
  '0x29': 'L_Data.ind',
  '0xfc': 'M_PropRead.req',
  '0xfb': 'M_PropRead.con',
  '0xf6': 'M_PropWrite.req',
  '0xf5': 'M_PropWrite.con',
  '0xf7': 'M_PropInfo.ind',
  '0xf1': 'M_Reset.req',
  '0xf0': 'M_Connect.req',
  '0xf3': 'M_Disconnect.req',
};

// ── Explode coalesced multi-value fields into one operation per logical PDU ──
//
// When tshark coalesces more than one KNXnet/IP PDU into a single TCP
// segment, every multi-value field (knxip.service, cemi.*) gets
// comma-joined with one value per logical PDU, in order. Zip them back into
// N separate logical operations - every one of them kept, none dropped or
// collapsed.

interface Operation {
  frameNumber: number;
  /** Seconds since the start of the capture (tshark's own frame.time_relative) - used for write-cadence and restart-timing analysis (see printTimingAnalysis). */
  timeRelative: number;
  subIndex: number; // 0-based index within a coalesced frame; logged so a coalescing event is traceable, not just silently exploded
  coalescedCount: number; // how many logical PDUs shared this physical frame (1 = not coalesced)
  knxipService: string; // raw hex, e.g. "0x0420"
  knxipServiceName: string;
  rawParseOnly: boolean; // true when tshark's dissector missed this frame entirely and it's present ONLY because this script's own independent raw-byte header parse found it (see parseRawKnxIpHeader) - cemi-level fields are unavailable in this case
  cemiMc: string;
  cemiMcName: string;
  cemiSa: string;
  cemiDa: string;
  cemiAc: string;
  cemiAx: string;
  cemiOt: string;
  cemiOi: string;
  cemiOx: string;
  cemiPx: string;
  cemiPid: string;
  cemiDataHex: string;
  /**
   * Full, untruncated memory address, read from the Info line's own
   * `X=$...` text - NOT from `cemi.x` (which `-T fields`' "show" formatting
   * silently truncates to its low 16 bits for MemoryExtended_Write - a real
   * tshark bug). Deliberately excluded from `operationSignature()` (a real
   * per-device value, not a structural difference) but used by the
   * optional `--content-diff` pass below, which only makes sense
   * same-device.
   */
  memAddrFromInfo: string | null;
  /**
   * The array/element index for a multi-element property (e.g. `PropValueWrite
   * OX=4 P=27 X=2 $...` - a real, distinct thing from `memAddrFromInfo`'s
   * `X=$...` memory-address form, always digits with no `$`). Needed for
   * `reconciliationKey()` below - two writes to the same OX/PID but
   * different array elements are NOT the same address and must not be
   * conflated into one "last write wins" slot.
   */
  arrayIndex: number | null;
  infoLine: string;
}

const MEM_ADDR_RE = /X=\$([0-9A-Fa-f]+)/;
const ARRAY_INDEX_RE = /\bX=(\d+)\b/;

function explodeOperations(cf: ClassifiedFrame): Operation[] {
  const v = cf.row.values;
  const services = splitMulti(v['knxip.service']);
  // The "tshark missed it entirely" case (dissectorDisagreement flags this):
  // knxip.service is empty, but this script's own raw-byte parse found a
  // valid header. One operation, service type from OUR parse, no cEMI
  // detail available (tshark is still the only source for that - see this
  // file's header comment on the deliberately-deferred hand-rolled cEMI
  // parser).
  if (services.length === 0 && cf.rawHeader?.valid) {
    return [
      {
        frameNumber: cf.frameNumber,
        timeRelative: Number(v['frame.time_relative'] || '0'),
        subIndex: 0,
        coalescedCount: 1,
        knxipService: cf.rawHeader.serviceType,
        knxipServiceName:
          (KNXIP_SERVICE_NAMES[cf.rawHeader.serviceType.toLowerCase()] ??
            `UNKNOWN(${cf.rawHeader.serviceType})`) +
          ' [raw-parse-only, tshark missed this frame]',
        rawParseOnly: true,
        cemiMc: '',
        cemiMcName: '',
        cemiSa: '',
        cemiDa: '',
        cemiAc: '',
        cemiAx: '',
        cemiOt: '',
        cemiOi: '',
        cemiOx: '',
        cemiPx: '',
        cemiPid: '',
        cemiDataHex: '',
        memAddrFromInfo: null,
        arrayIndex: null,
        infoLine: v['_ws.col.Info'],
      },
    ];
  }
  const n = Math.max(1, services.length);
  const get = (field: FieldName, i: number): string => {
    const parts = splitMulti(v[field]);
    return parts[i] ?? '';
  };
  const infoLine = v['_ws.col.Info'];
  const addrMatches = [...infoLine.matchAll(new RegExp(MEM_ADDR_RE, 'g'))];
  const arrayIndexMatches = [
    ...infoLine.matchAll(new RegExp(ARRAY_INDEX_RE, 'g')),
  ];
  const ops: Operation[] = [];
  // When tshark coalesces multiple logical PDUs into one physical frame,
  // `knxip.service` and the `cemi.*` fields can have DIFFERENT lengths -
  // confirmed on a real frame carrying two bare TUNNELING_ACKs (no cEMI
  // content at all - ACKs never carry one) plus two real TUNNELING_REQUESTs
  // (each with real cEMI content): `knxip.service` had 4 values, `cemi.mc`
  // only 2. Naively indexing cemi.* fields by the raw position (0..3) with
  // an out-of-bounds fallback to the LAST value means both bare-ACK
  // positions would silently borrow the real second TUNNELING_REQUEST's
  // cEMI content (address, data, everything), producing PHANTOM duplicate
  // "chunk write" operations at the exact same timestamp as the real one -
  // which drags every aggregate chunk-timing statistic toward zero.
  //
  // Fix: only a KNXnet/IP service that genuinely carries a cEMI frame
  // (TUNNELING_REQUEST 0x0420, DEVICE_CONFIGURATION_REQUEST 0x0310) reads
  // from the cemi.* arrays at all, indexed by its own running count among
  // ONLY the cEMI-bearing positions seen so far in this frame (not the raw
  // position `i`) - every other service (ACK, Connect, ConnectionState,
  // etc.) gets cEMI fields forced empty, exactly matching its real
  // content. The same cEMI-bearing counter also indexes the Info-line
  // regex matches (address, array index) - not perfect for every possible
  // coalescing shape (a cEMI-bearing frame with no address interleaved
  // with one that has one could still misalign), but correctly handles the
  // dominant, confirmed real pattern (ACKs plus real ops) and is a major
  // correctness improvement over indexing by raw position against
  // mismatched-length arrays.
  const CEMI_BEARING_SERVICES = new Set(['0x0420', '0x0310']);
  let cemiPos = 0;
  for (let i = 0; i < n; i++) {
    const svc = (services[i] ?? services[0] ?? '').toLowerCase();
    const isCemiBearing = CEMI_BEARING_SERVICES.has(svc);
    let mc = '',
      cemiSa = '',
      cemiDa = '',
      cemiAc = '',
      cemiAx = '',
      cemiOt = '',
      cemiOi = '',
      cemiOx = '',
      cemiPx = '',
      cemiPid = '',
      cemiDataHex = '';
    let memAddrFromInfo: string | null = null;
    let arrayIndex: number | null = null;
    if (isCemiBearing) {
      mc = get('cemi.mc', cemiPos);
      cemiSa = get('cemi.sa', cemiPos);
      cemiDa = get('cemi.da', cemiPos);
      cemiAc = get('cemi.ac', cemiPos);
      cemiAx = get('cemi.ax', cemiPos);
      cemiOt = get('cemi.ot', cemiPos);
      cemiOi = get('cemi.oi', cemiPos);
      cemiOx = get('cemi.ox', cemiPos);
      cemiPx = get('cemi.px', cemiPos);
      cemiPid = get('cemi.pid', cemiPos);
      cemiDataHex = get('cemi.data', cemiPos);
      const am = addrMatches[cemiPos]?.[1];
      memAddrFromInfo = am ? '0x' + am.toLowerCase() : null;
      const aim = arrayIndexMatches[cemiPos]?.[1];
      arrayIndex = aim != null ? Number(aim) : null;
      cemiPos++;
    }
    ops.push({
      frameNumber: cf.frameNumber,
      timeRelative: Number(v['frame.time_relative'] || '0'),
      subIndex: i,
      coalescedCount: n,
      knxipService: services[i] ?? services[0] ?? '',
      knxipServiceName:
        KNXIP_SERVICE_NAMES[svc] ?? `UNKNOWN(${services[i] ?? services[0]})`,
      rawParseOnly: false,
      cemiMc: mc,
      cemiMcName:
        CEMI_MC_NAMES[mc.toLowerCase()] ?? (mc ? `UNKNOWN(${mc})` : ''),
      cemiSa,
      cemiDa,
      cemiAc,
      cemiAx,
      cemiOt,
      cemiOi,
      cemiOx,
      cemiPx,
      cemiPid,
      cemiDataHex,
      memAddrFromInfo,
      arrayIndex,
      infoLine,
    });
  }
  return ops;
}

// ── Normalize an operation into a comparable signature (strip session/device-specific values, keep structure) ──
//
// Address normalization: cemi.sa/da are swapped to TOOL/DEVICE/OTHER rather
// than compared literally, since the two captures are necessarily different
// physical devices (different individual addresses) and, for a
// non-ETS-driven session, a different tool source address than ETS's own
// 0.0.0. Comparing literal addresses would produce a wall of false
// "differences" that are really just "this is a different device", masking
// the real structural gaps this tool exists to find.

function normalizeAddr(
  addr: string,
  deviceWord: string,
): 'TOOL' | 'DEVICE' | `OTHER(${string})` {
  if (addr === deviceWord) return 'DEVICE';
  // 0x0000 (0.0.0, ETS's unconfigured tool address) and any other source are
  // both "the thing driving the download, not the device" - both normalize
  // to TOOL. Broadcast/group addresses (0/0/0-shaped, seen for
  // IndAddrSerNumRead/SysNwkParamRead) are real, distinct, kept as OTHER.
  if (addr === '0x0000' || addr === '0') return 'TOOL';
  return `OTHER(${addr})`;
}

function individualAddressToWord(addr: string): string {
  const [a, b, c] = addr.split('.').map(Number);
  const word = ((a! & 0x0f) << 12) | ((b! & 0x0f) << 8) | (c! & 0xff);
  return '0x' + word.toString(16).padStart(4, '0');
}

// The raw APCI code (cemi.ac/cemi.ax) is NOT sufficient to tell a
// PropertyValue READ request from a WRITE request - both share the same
// extended APCI value, differentiated instead by the request's own data
// length (a read carries none, a write carries the value) - which tshark's
// own Info-line text already names correctly
// ("PropValueRead"/"PropValueWrite"/"PropValueResp"/etc.). Extracting that
// word from the Info text is a real, useful SECONDARY signal here (not a
// replacement for the raw-byte checks above).
//
// Some real captures use the LEGACY `Memory_Write`/`Memory_Read` service
// (Info text "MemWrite"/"MemRead", APCI 0x0A/0x00) rather than the extended
// one - never assume every device uses the extended service.
const KNX_SERVICE_WORD_RE =
  /\b(PropValueRead|PropValueWrite|PropValueResp|PropDescrRead|PropDescrResp|MemExtWrite|MemExtWriteResp|MemExtRead|MemExtReadResp|MemWrite|MemWriteResp|MemRead|MemReadResp|FuncPropExtRead|FuncPropExtResp|FuncPropExtCmd|DevDescrRead|DevDescrResp|RestartReq|RestartResp|Connect|Disconnect|AuthReq|AuthResp)\b/;
function serviceWordFromInfo(info: string): string | null {
  const m = KNX_SERVICE_WORD_RE.exec(info);
  return m ? m[1]! : null;
}

function operationSignature(op: Operation, deviceWord: string): string {
  const sa = normalizeAddr(op.cemiSa, deviceWord);
  const da = normalizeAddr(op.cemiDa, deviceWord);
  const dir =
    sa === 'DEVICE'
      ? 'DEVICE->TOOL'
      : da === 'DEVICE'
        ? 'TOOL->DEVICE'
        : `${sa}->${da}`;
  const parts = [op.knxipServiceName];
  if (op.cemiMcName) parts.push(op.cemiMcName, dir);
  // The Info-derived service word (PropValueRead vs PropValueWrite vs ...) is
  // the PRIMARY read/write discriminator - see the comment above. Raw APCI is
  // still included alongside it (not replaced) so an unnamed/unknown service
  // still produces a distinguishable signature. `serviceWordFromInfo`
  // matches ANYWHERE in the frame's shared Info text, not this specific
  // sub-operation's own position - only meaningful for an op that actually
  // HAS cEMI content (`cemiMcName` non-empty); applying it to a bare
  // TUNNELING_ACK or other non-cEMI-bearing op would produce a nonsensical
  // signature borrowed from an unrelated coalesced sibling.
  const svcWord = op.cemiMcName ? serviceWordFromInfo(op.infoLine) : null;
  if (svcWord) parts.push(svcWord);
  // APCI-bearing detail, when present - object/property addressing.
  // cemi.x (memory address) is DELIBERATELY excluded from the signature - it's
  // a real per-device value (different devices, different memory maps), not
  // a structural difference, and known to be truncated by tshark's `-T
  // fields` "show" formatting anyway - the actual byte-content-at-an-address
  // question is the --content-diff / address-reconciliation passes' job,
  // not this signature's.
  const apci = op.cemiAx || op.cemiAc;
  if (apci) parts.push(`APCI=${apci}`);
  if (op.cemiOt) parts.push(`OT=${op.cemiOt}`);
  if (op.cemiOi) parts.push(`OI=${op.cemiOi}`);
  if (op.cemiOx) parts.push(`OX=${op.cemiOx}`);
  if (op.cemiPx) parts.push(`PX=${op.cemiPx}`);
  if (op.cemiPid) parts.push(`PID=${op.cemiPid}`);
  return parts.join(' | ');
}

// ── Per-capture processing ──────────────────────────────────────────────────

interface CaptureAudit {
  label: string;
  totalFrames: number;
  bucketCounts: Record<Bucket, number>;
  operations: Operation[];
  operationSignatures: string[]; // one per operation, in capture order
  undecodedFrames: ClassifiedFrame[];
  nonTcpFrames: ClassifiedFrame[];
  dissectorDisagreements: ClassifiedFrame[]; // frames where tshark's own KNX dissector and this script's independent raw-byte parse disagreed - see parseRawKnxIpHeader()'s doc comment
  allClassified: ClassifiedFrame[];
  /** The real device address word this capture was processed for - used by filterToDevice() below. */
  deviceWord: string;
}

/**
 * Some captures bundle MULTIPLE devices' traffic in one file. Without this
 * filter, every content/chunk/timing analysis function would silently mix
 * another device's writes into the target device's numbers - exactly the
 * kind of silent contamination this whole tool exists to prevent. Keeps an
 * operation if it's genuinely addressed to/from the target device (cEMI
 * source or destination matches), OR if it has no cEMI addressing at all (a
 * pure KNXnet/IP session-level frame - Connect/Disconnect/ConnState/
 * TunnelingAck - not tied to any one device's bus traffic).
 */
function filterToDevice(audit: CaptureAudit): CaptureAudit {
  const dw = audit.deviceWord.toLowerCase();
  const operations: Operation[] = [];
  const operationSignatures: string[] = [];
  audit.operations.forEach((op, i) => {
    const sa = op.cemiSa.toLowerCase();
    const da = op.cemiDa.toLowerCase();
    const keep = (!sa && !da) || sa === dw || da === dw; // no addressing at all (session-level) OR matches the target device
    if (keep) {
      operations.push(op);
      operationSignatures.push(audit.operationSignatures[i]!);
    }
  });
  return { ...audit, operations, operationSignatures };
}

function processCapture(
  tsharkPath: string,
  capturePath: string,
  label: string,
  deviceAddress: string,
  port: number = 3671,
): CaptureAudit {
  const deviceWord = individualAddressToWord(deviceAddress);
  const rawRows = runTshark(tsharkPath, capturePath, port);
  const bucketCounts: Record<Bucket, number> = {
    'tcp-handshake-teardown': 0,
    'tcp-pure-ack': 0,
    'tcp-duplicate-ack': 0,
    'tcp-keepalive': 0,
    'tcp-retransmission-empty': 0,
    'tcp-retransmission-with-payload': 0,
    'tcp-out-of-order-or-analysis-only': 0,
    'udp-empty': 0,
    'knxip-frame': 0,
    'tcp-payload-undecoded': 0,
    'udp-payload-undecoded': 0,
    'non-tcp-udp-frame': 0,
  };
  const allClassified: ClassifiedFrame[] = [];
  const operations: Operation[] = [];
  const undecodedFrames: ClassifiedFrame[] = [];
  const nonTcpFrames: ClassifiedFrame[] = [];
  const dissectorDisagreements: ClassifiedFrame[] = [];

  for (const row of rawRows) {
    const cf = classify(row);
    allClassified.push(cf);
    bucketCounts[cf.bucket]++;
    if (cf.bucket === 'knxip-frame') {
      operations.push(...explodeOperations(cf));
    } else if (
      cf.bucket === 'tcp-payload-undecoded' ||
      cf.bucket === 'udp-payload-undecoded'
    ) {
      undecodedFrames.push(cf);
    } else if (cf.bucket === 'non-tcp-udp-frame') {
      nonTcpFrames.push(cf);
    }
    if (cf.dissectorDisagreement) dissectorDisagreements.push(cf);
  }

  // Reconciliation - the whole point of this tool. If this ever fails, STOP:
  // it means a frame existed that this script's classification logic didn't
  // account for, which is precisely the silent-drop failure mode being
  // guarded against.
  const total = rawRows.length;
  const sum = Object.values(bucketCounts).reduce((a, b) => a + b, 0);
  if (sum !== total) {
    throw new Error(
      `[${label}] RECONCILIATION FAILURE: ${total} total frames but bucket counts sum to ${sum}. ` +
        `Some frame was not classified into any bucket - this must be fixed before trusting this tool's output.`,
    );
  }

  const operationSignatures = operations.map((op) =>
    operationSignature(op, deviceWord),
  );

  return {
    label,
    totalFrames: total,
    bucketCounts,
    operations,
    operationSignatures,
    undecodedFrames,
    nonTcpFrames,
    dissectorDisagreements,
    allClassified,
    deviceWord,
  };
}

// ── Multiset diff of operation signatures ───────────────────────────────────

function multisetCounts(sigs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sigs) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}

// ── Output ───────────────────────────────────────────────────────────────────

function writeAuditLog(outDir: string, audit: CaptureAudit): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${audit.label}.audit.jsonl`);
  const lines: string[] = [];
  for (const cf of audit.allClassified) {
    lines.push(
      JSON.stringify({
        frame: cf.frameNumber,
        bucket: cf.bucket,
        transport: cf.transport ?? undefined,
        reason: cf.reason,
        info: cf.row.values['_ws.col.Info'],
        payloadHex: cf.payloadHex || undefined,
        rawHeader: cf.rawHeader ?? undefined,
        dissectorDisagreement: cf.dissectorDisagreement ?? undefined,
      }),
    );
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function printCaptureSummary(audit: CaptureAudit, logFile: string): void {
  console.log(`\n=== ${audit.label} ===`);
  console.log(
    `Total frames: ${audit.totalFrames} (reconciliation OK - every frame classified)`,
  );
  for (const [bucket, count] of Object.entries(audit.bucketCounts)) {
    if (count > 0) console.log(`  ${bucket}: ${count}`);
  }
  // knxip-frame is a merged bucket (TCP and UDP both land there - KNXnet/IP
  // content is what matters, not which transport carried it) - broken out
  // explicitly here so a capture with real UDP traffic (e.g. the discovery
  // SearchRequest/SearchResponse broadcasts ETS sends before opening its TCP
  // tunnel) doesn't look like it went unprocessed just because the top-level
  // bucket count doesn't show the split.
  const udpOps = audit.operations.filter(
    (o) =>
      audit.allClassified.find((cf) => cf.frameNumber === o.frameNumber)
        ?.transport === 'udp',
  ).length;
  console.log(
    `  -> ${audit.operations.length} KNXnet/IP logical operations extracted (${audit.operations.length - udpOps} over TCP, ${udpOps} over UDP; some frames carried >1 coalesced PDU)`,
  );
  const coalesced = audit.operations.filter((o) => o.coalescedCount > 1);
  if (coalesced.length > 0) {
    console.log(
      `  -> ${coalesced.length} of those were coalesced (>1 logical PDU sharing one physical TCP segment) - see audit log`,
    );
  }
  if (audit.undecodedFrames.length > 0) {
    console.log(
      `  ⚠ ${audit.undecodedFrames.length} frame(s) had a payload tshark's KNXnet/IP dissector could NOT decode - MANUAL REVIEW NEEDED:`,
    );
    for (const cf of audit.undecodedFrames) {
      console.log(
        `     frame ${cf.frameNumber} [${cf.transport}]: ${cf.payloadHex}`,
      );
    }
  }
  if (audit.nonTcpFrames.length > 0) {
    console.log(
      `  ⚠ ${audit.nonTcpFrames.length} non-TCP/UDP frame(s) present in this capture (see audit log for protocol stacks)`,
    );
  }
  if (audit.dissectorDisagreements.length > 0) {
    console.log(
      `  ⚠⚠ ${audit.dissectorDisagreements.length} frame(s) where tshark's KNX dissector and this script's OWN independent raw-byte header parse DISAGREED - never silently resolved, review directly:`,
    );
    for (const cf of audit.dissectorDisagreements) {
      console.log(`     frame ${cf.frameNumber}: ${cf.dissectorDisagreement}`);
    }
  } else {
    console.log(
      `  tshark's dissector and this script's independent raw-byte header check agreed on every frame (service-type level).`,
    );
  }
  console.log(`Full per-frame audit log: ${logFile}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const a = processCapture(
    args.tshark,
    args.aPath,
    args.aLabel,
    args.aDevice,
    args.aPort,
  );
  const b = processCapture(
    args.tshark,
    args.bPath,
    args.bLabel,
    args.bDevice,
    args.bPort,
  );

  const aLog = writeAuditLog(args.outDir, a);
  const bLog = writeAuditLog(args.outDir, b);
  printCaptureSummary(a, aLog);
  printCaptureSummary(b, bLog);

  // Filtered-to-device views, needed by the LSM sequence check below AND by
  // the --content-diff analyses further down - computed once, unconditionally,
  // so the LSM check runs on every invocation, not just --content-diff ones.
  const aDevEarly = filterToDevice(a);
  const bDevEarly = filterToDevice(b);
  printLsmSequenceAnalysis(aDevEarly, bDevEarly);

  const aCounts = multisetCounts(a.operationSignatures);
  const bCounts = multisetCounts(b.operationSignatures);
  const allSigs = new Set([...aCounts.keys(), ...bCounts.keys()]);

  const onlyInA: { sig: string; count: number }[] = [];
  const onlyInB: { sig: string; count: number }[] = [];
  const countMismatch: { sig: string; aCount: number; bCount: number }[] = [];

  for (const sig of allSigs) {
    const ac = aCounts.get(sig) ?? 0;
    const bc = bCounts.get(sig) ?? 0;
    if (ac > 0 && bc === 0) onlyInA.push({ sig, count: ac });
    else if (bc > 0 && ac === 0) onlyInB.push({ sig, count: bc });
    else if (ac !== bc) countMismatch.push({ sig, aCount: ac, bCount: bc });
  }

  console.log(`\n=== STRUCTURAL DIFF: ${a.label} vs ${b.label} ===`);
  console.log(
    `(Excludes tcp-* transport noise and retransmissions - those are logged per-capture above/in the audit logs, but expected to differ trivially and are not part of this comparison.)\n`,
  );

  console.log(
    `Operations present in ${a.label} but ABSENT from ${b.label} (${onlyInA.length}):`,
  );
  if (onlyInA.length === 0) console.log('  (none)');
  for (const { sig, count } of onlyInA.sort((x, y) =>
    x.sig.localeCompare(y.sig),
  )) {
    console.log(`  [x${count}] ${sig}`);
  }

  console.log(
    `\nOperations present in ${b.label} but ABSENT from ${a.label} (${onlyInB.length}):`,
  );
  if (onlyInB.length === 0) console.log('  (none)');
  for (const { sig, count } of onlyInB.sort((x, y) =>
    x.sig.localeCompare(y.sig),
  )) {
    console.log(`  [x${count}] ${sig}`);
  }

  console.log(
    `\nOperations present in BOTH but with a different COUNT (${countMismatch.length}):`,
  );
  if (countMismatch.length === 0) console.log('  (none)');
  for (const { sig, aCount, bCount } of countMismatch.sort((x, y) =>
    x.sig.localeCompare(y.sig),
  )) {
    console.log(`  ${a.label}=x${aCount} vs ${b.label}=x${bCount}: ${sig}`);
  }

  const anyUndecoded =
    a.undecodedFrames.length > 0 || b.undecodedFrames.length > 0;
  const anyNonTcp = a.nonTcpFrames.length > 0 || b.nonTcpFrames.length > 0;
  const anyDisagreement =
    a.dissectorDisagreements.length > 0 || b.dissectorDisagreements.length > 0;
  console.log(
    `\nSummary: ${onlyInA.length} A-only, ${onlyInB.length} B-only, ${countMismatch.length} count-mismatch operations.` +
      (anyUndecoded
        ? ' ⚠ UNDECODED FRAMES EXIST - see above, review before trusting this diff as complete.'
        : ' No undecoded frames in either capture.') +
      (anyNonTcp
        ? ' ⚠ Non-TCP/UDP frames exist in at least one capture - see audit log.'
        : '') +
      (anyDisagreement
        ? " ⚠⚠ tshark/raw-parse DISAGREEMENTS EXIST - see above; this means tshark's own KNX dissector missed or misreported at least one frame (a known real risk for this dissector) - review those frames directly before trusting the diff around them."
        : " tshark's dissector and this script's independent raw-byte check agreed on every frame in both captures (service-type level; cEMI-level fields below that are still tshark-sourced only - see this file's header comment)."),
  );

  if (!args.contentDiff) {
    console.log(
      '\n(--content-diff not passed: this diff compares STRUCTURE only - which operations occur, how many times - never the actual payload bytes. ' +
        'Answering "does every single byte match" requires --content-diff, and is only meaningful when --a/--b capture the SAME physical device.)',
    );
    return;
  }
  // Filter to the target device's own traffic before any content/chunk/
  // timing analysis - see filterToDevice()'s doc comment. A no-op for a
  // capture that only ever contained one device; essential for one that
  // bundles several. Reuses the early filter computed above (for the
  // always-on LSM check) rather than recomputing.
  const aDev = aDevEarly;
  const bDev = bDevEarly;
  if (aDev.operations.length !== a.operations.length) {
    console.log(
      `\n(Note: ${a.label} contains other devices' traffic too - filtered from ${a.operations.length} to ${aDev.operations.length} operations relevant to ${args.aDevice} before content/chunk/timing analysis below.)`,
    );
  }
  if (bDev.operations.length !== b.operations.length) {
    console.log(
      `\n(Note: ${b.label} contains other devices' traffic too - filtered from ${b.operations.length} to ${bDev.operations.length} operations relevant to ${args.bDevice} before content/chunk/timing analysis below.)`,
    );
  }
  printContentDiff(aDev, bDev, args.aDevice === args.bDevice);
  printAddressReconciliation(aDev, bDev, args.aDevice === args.bDevice);
  printChunkAnalysis(aDev, bDev);
  printTimingAnalysis(aDev, bDev);
  printResponseLatencyAnalysis(aDev, bDev);
}

// ── LSM (Load State Machine) sequence check - object order, every download ─
//
// The structural diff above buckets by operation SIGNATURE and is blind to
// ORDER - two captures can have the identical multiset of PropValueWrite
// OX=N P=5 (LoadStateControl) writes and still differ in the sequence a
// real device actually saw them in, which matters for any "device went
// permanently unresponsive after a write" investigation. This runs
// UNCONDITIONALLY (not gated behind --content-diff) since it only needs the
// LoadStateControl event byte, not a full memory image, and is a
// safety-tier check, not an optional deep-dive.
//
// LoadState event codes (byte 0 of the PropValueWrite OX=N P=5 payload) -
// per KNX standard LSM (Load State Machine): 0x00 NoOperation, 0x01
// StartLoading, 0x02 LoadCompleted, 0x03 AdditionalLoadControls (used for
// LoadData/segment-info sub-steps, real payload varies), 0x04 Unload. Any
// other byte is logged as UNKNOWN(hex), never silently dropped or guessed.

const LSM_EVENT_NAMES: Record<string, string> = {
  '00': 'NoOperation',
  '01': 'StartLoading',
  '02': 'LoadCompleted',
  '03': 'AdditionalLoadControls',
  '04': 'Unload',
};

interface LsmEvent {
  ox: string;
  eventCode: string;
  eventName: string;
  frameNumber: number;
  timeRelative: number;
  raw: string;
}

/** Real per-request tool->device PropValueWrite OX=N P=5 writes, in capture order - the actual LSM event sequence a device saw. */
function extractLsmSequence(audit: CaptureAudit): LsmEvent[] {
  const dw = audit.deviceWord.toLowerCase();
  const events: LsmEvent[] = [];
  for (const op of audit.operations) {
    if (op.cemiMcName !== 'L_Data.req') continue; // only the tool's own request - .con/.ind echoes of the same write are a real, expected duplicate on some transports (router relay), not a second event
    if (op.cemiDa.toLowerCase() !== dw) continue; // must be addressed TO this device
    const svcWord = serviceWordFromInfo(op.infoLine);
    if (svcWord !== 'PropValueWrite') continue;
    const oxMatch = /\bOX=(\d+)\b/.exec(op.infoLine);
    const pMatch = /\bP=(\d+)\b/.exec(op.infoLine);
    if (!oxMatch || !pMatch || pMatch[1] !== '5') continue; // PID=5 is PID_LOAD_STATE_CONTROL
    const dataHex = op.cemiDataHex.replace(/^0x/, '');
    const eventCode = dataHex.slice(0, 2).toLowerCase();
    events.push({
      ox: oxMatch[1]!,
      eventCode,
      eventName: LSM_EVENT_NAMES[eventCode] ?? `UNKNOWN(0x${eventCode})`,
      frameNumber: op.frameNumber,
      timeRelative: op.timeRelative,
      raw: op.infoLine,
    });
  }
  return events;
}

function printLsmSequenceAnalysis(a: CaptureAudit, b: CaptureAudit): void {
  console.log(
    `\n=== LSM (LOAD STATE MACHINE) SEQUENCE CHECK: ${a.label} vs ${b.label} ===`,
  );
  console.log(
    '(Every PropValueWrite OX=N P=5 LoadStateControl write, in real capture order - checks the SEQUENCE, not just presence. Runs on every comparison, unconditionally.)',
  );

  const aSeq = extractLsmSequence(a);
  const bSeq = extractLsmSequence(b);

  const fmtSeq = (seq: LsmEvent[]) =>
    seq.map((e) => `OX=${e.ox}:${e.eventName}`).join('  ->  ');
  console.log(
    `\n${a.label} (${aSeq.length} events):\n  ${fmtSeq(aSeq) || '(none found)'}`,
  );
  console.log(
    `\n${b.label} (${bSeq.length} events):\n  ${fmtSeq(bSeq) || '(none found)'}`,
  );

  if (aSeq.length === 0 || bSeq.length === 0) {
    console.log(
      '\n⚠ At least one capture has ZERO LoadStateControl events - either a genuinely non-full-download session, or this check missed them. Do not assume "no LSM activity" without checking why.',
    );
    return;
  }

  // Object 5 (PEI Program) presence is checked explicitly and called out by
  // name - a common, specific question for device-death-style investigations,
  // not just a generic diff.
  const aHasObj5 = aSeq.some((e) => e.ox === '5');
  const bHasObj5 = bSeq.some((e) => e.ox === '5');
  console.log(
    `\nObject 5 (PEI Program) LSM activity: ${a.label}=${aHasObj5 ? 'PRESENT' : 'ABSENT'}, ${b.label}=${bHasObj5 ? 'PRESENT' : 'ABSENT'}${aHasObj5 !== bHasObj5 ? '  ⚠ MISMATCH' : ''}`,
  );

  // Position-by-position sequence diff - reports the first divergence AND
  // every mismatched position, not just a boolean "differs somewhere".
  const len = Math.max(aSeq.length, bSeq.length);
  const mismatches: { i: number; a: string; b: string }[] = [];
  for (let i = 0; i < len; i++) {
    const av = aSeq[i] ? `OX=${aSeq[i]!.ox}:${aSeq[i]!.eventName}` : '(none)';
    const bv = bSeq[i] ? `OX=${bSeq[i]!.ox}:${bSeq[i]!.eventName}` : '(none)';
    if (av !== bv) mismatches.push({ i, a: av, b: bv });
  }
  if (mismatches.length === 0) {
    console.log(
      `\n✅ LSM sequence order is IDENTICAL between the two captures - ${aSeq.length} events, same object order, same event types, position-for-position.`,
    );
  } else {
    console.log(
      `\n⚠ LSM sequence ORDER DIFFERS at ${mismatches.length} of ${len} position(s):`,
    );
    for (const m of mismatches) {
      console.log(
        `  position ${m.i}: ${a.label}="${m.a}"  vs  ${b.label}="${m.b}"`,
      );
    }
  }
}

// ── Timing analysis - write cadence and restart-timing safety margin ───────
//
// Directly relevant to any "device died/went unresponsive after a write"
// investigation: (1) triggering a reboot while a device is mid-write, and
// (2) leaving a device in an incomplete state - both are fundamentally
// TIMING questions the byte-content checks above cannot see at all
// (identical final bytes can still be reached via a write cadence that
// gives a device's flash controller no time to commit before the next
// chunk, or via a Restart sent too soon after the last write for a commit
// to have genuinely finished).

function printTimingAnalysis(a: CaptureAudit, b: CaptureAudit): void {
  console.log(`\n=== TIMING ANALYSIS: ${a.label} vs ${b.label} ===`);

  const printSide = (label: string, audit: CaptureAudit) => {
    const chunks = extractChunkWrites(audit.operations).sort(
      (x, y) => x.timeRelative - y.timeRelative,
    );
    if (chunks.length < 2) {
      console.log(
        `\n${label}: fewer than 2 real chunk writes - no cadence to analyze.`,
      );
      return { label, chunks, restartTime: null as number | null };
    }
    const gaps: number[] = [];
    for (let i = 1; i < chunks.length; i++)
      gaps.push(chunks[i]!.timeRelative - chunks[i - 1]!.timeRelative);
    const sum = gaps.reduce((s, g) => s + g, 0);
    const mean = sum / gaps.length;
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    const sortedGaps = [...gaps].sort((x, y) => x - y);
    const median = sortedGaps[Math.floor(sortedGaps.length / 2)]!;
    console.log(
      `\n${label}: ${chunks.length} real chunk writes over ${(chunks[chunks.length - 1]!.timeRelative - chunks[0]!.timeRelative).toFixed(3)}s. ` +
        `Inter-chunk gap: mean=${(mean * 1000).toFixed(1)}ms, median=${(median * 1000).toFixed(1)}ms, min=${(min * 1000).toFixed(1)}ms, max=${(max * 1000).toFixed(1)}ms.`,
    );
    // Anomaly: any single gap far larger than the median (a real pause,
    // stall, or retry mid-write) - flagged, not assumed benign.
    const stalls = gaps
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g > Math.max(median * 10, 0.5));
    if (stalls.length > 0) {
      console.log(
        `  ⚠ ${stalls.length} unusually long gap(s) between consecutive chunk writes (>10x median and >500ms):`,
      );
      for (const { g, i } of stalls.slice(0, 20)) {
        console.log(
          `     between frame ${chunks[i]!.frameNumber} and frame ${chunks[i + 1]!.frameNumber}: ${(g * 1000).toFixed(0)}ms gap`,
        );
      }
    }
    // The safety-margin question: how long between the LAST real chunk
    // write and the Restart command actually sent? A short margin here is
    // exactly the "reboot mid-write" candidate mechanism - the device may
    // not have finished committing the last chunk to flash before being
    // told to restart. A reference capture can bundle several real actions
    // in one file, so `.find()`-first-RestartReq could pick an EARLIER
    // restart than the write sequence being measured, producing a
    // nonsensical negative margin - fixed by taking the restart with the
    // smallest NON-NEGATIVE gap after the last chunk write instead: the
    // restart that actually, chronologically follows this specific write
    // pass.
    const restartCandidates = audit.operations
      .filter(
        (op) =>
          op.cemiMcName === 'L_Data.req' &&
          serviceWordFromInfo(op.infoLine) === 'RestartReq',
      )
      .map((op) => ({
        op,
        margin: op.timeRelative - chunks[chunks.length - 1]!.timeRelative,
      }))
      .filter(({ margin }) => margin >= 0)
      .sort((x, y) => x.margin - y.margin);
    const restartOp = restartCandidates[0]?.op ?? null;
    let restartTime: number | null = null;
    if (restartOp) {
      restartTime = restartOp.timeRelative;
      const margin = restartCandidates[0]!.margin;
      console.log(
        `  Time from last chunk write to Restart command: ${(margin * 1000).toFixed(1)}ms (frame ${chunks[chunks.length - 1]!.frameNumber} -> frame ${restartOp.frameNumber}).`,
      );
    } else {
      console.log(
        `  No RestartReq found AFTER the last chunk write in this capture - cannot compute write-to-restart margin.`,
      );
    }
    return { label, chunks, restartTime };
  };

  const aResult = printSide(a.label, a);
  const bResult = printSide(b.label, b);

  if (aResult.chunks.length >= 2 && bResult.chunks.length >= 2) {
    const aMean =
      (aResult.chunks[aResult.chunks.length - 1]!.timeRelative -
        aResult.chunks[0]!.timeRelative) /
      (aResult.chunks.length - 1);
    const bMean =
      (bResult.chunks[bResult.chunks.length - 1]!.timeRelative -
        bResult.chunks[0]!.timeRelative) /
      (bResult.chunks.length - 1);
    const ratio = bMean > 0 ? aMean / bMean : Infinity;
    console.log(
      `\nWrite cadence comparison: ${a.label} averages ${(aMean * 1000).toFixed(1)}ms/chunk, ${b.label} averages ${(bMean * 1000).toFixed(1)}ms/chunk` +
        (ratio > 3 || ratio < 1 / 3
          ? ` - ⚠ one side writes ${ratio > 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x ${ratio > 1 ? 'SLOWER' : 'FASTER'} than the other, a real cadence difference worth investigating (a device given less time per chunk to process/commit could behave differently under load).`
          : ' - comparable cadence, no gross anomaly.'),
    );
  }
}

// ── Device response latency - tests whether the DEVICE itself answers each
// engine at a different speed, as opposed to a pure send-side pacing
// difference ─────────────────────────────────────────────────────────────
//
// Directly tests the hypothesis that emerges from the timing analysis
// above: a real write loop typically waits for each chunk's own device
// response before sending the next (not a naive blast-without-waiting).
// That means the SEND-side gap (printTimingAnalysis above) is downstream of
// whatever the DEVICE's own real response latency is - measuring the actual
// request->response latency directly (not just the gap between successive
// sends) is the real test of whether the device responds at genuinely
// different speeds to each engine, or whether this is a pure send-side
// artifact.

interface ChunkResponse {
  frameNumber: number;
  timeRelative: number;
  address: number;
  addressHex: string;
}

/** The device's own real write-confirmation responses (L_Data.ind direction - the device replying, not the tool's own request or its link-layer .con echo). */
function extractChunkResponses(ops: Operation[]): ChunkResponse[] {
  const responses: ChunkResponse[] = [];
  for (const op of ops) {
    if (op.cemiMcName !== 'L_Data.ind') continue;
    const svcWord = serviceWordFromInfo(op.infoLine);
    if (svcWord !== 'MemExtWriteResp' && svcWord !== 'MemWriteResp') continue;
    if (!op.memAddrFromInfo) continue;
    responses.push({
      frameNumber: op.frameNumber,
      timeRelative: op.timeRelative,
      address: parseInt(op.memAddrFromInfo.replace(/^0x/, ''), 16),
      addressHex: op.memAddrFromInfo,
    });
  }
  return responses;
}

function printResponseLatencyAnalysis(a: CaptureAudit, b: CaptureAudit): void {
  console.log(`\n=== DEVICE RESPONSE LATENCY: ${a.label} vs ${b.label} ===`);
  console.log(
    '(Real request -> device-confirmation latency per chunk, matched by address - NOT the gap between successive sends. Tests whether the device itself answers each engine at a different speed.)',
  );

  const printSide = (label: string, audit: CaptureAudit) => {
    const chunks = extractChunkWrites(audit.operations);
    const responses = extractChunkResponses(audit.operations);
    const byAddr = new Map<number, number[]>();
    for (const r of responses) {
      const list = byAddr.get(r.address) ?? [];
      list.push(r.timeRelative);
      byAddr.set(r.address, list);
    }
    for (const list of byAddr.values()) list.sort((x, y) => x - y);

    const latencies: number[] = [];
    const slowChunks: { chunk: ChunkWrite; latency: number }[] = [];
    let unanswered = 0;
    for (const c of chunks) {
      const candidates = byAddr.get(c.address) ?? [];
      const match = candidates.find((t) => t >= c.timeRelative);
      if (match == null) {
        unanswered++;
        continue;
      }
      const latency = match - c.timeRelative;
      latencies.push(latency);
      slowChunks.push({ chunk: c, latency });
    }
    if (latencies.length === 0) {
      console.log(
        `\n${label}: no matched request->response pairs found (cannot measure device response latency).`,
      );
      return;
    }
    const sorted = [...latencies].sort((x, y) => x - y);
    const mean = latencies.reduce((s, l) => s + l, 0) / latencies.length;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
    console.log(
      `\n${label}: ${latencies.length} matched request->response pairs (${unanswered} chunk(s) had no matching device response found). ` +
        `Device response latency: mean=${(mean * 1000).toFixed(1)}ms, median=${(median * 1000).toFixed(1)}ms, p90=${(p90 * 1000).toFixed(1)}ms, min=${(sorted[0]! * 1000).toFixed(1)}ms, max=${(sorted[sorted.length - 1]! * 1000).toFixed(1)}ms.`,
    );
    const slow = slowChunks.filter(
      ({ latency }) => latency > Math.max(median * 5, 0.3),
    );
    if (slow.length > 0) {
      console.log(
        `  ⚠ ${slow.length} chunk(s) had a device response latency >5x median (and >300ms) - a real, individual slow DEVICE response, not just a send-side gap:`,
      );
      for (const { chunk, latency } of slow.slice(0, 20)) {
        console.log(
          `     frame ${chunk.frameNumber}, address ${chunk.addressHex}: ${(latency * 1000).toFixed(0)}ms`,
        );
      }
      if (slow.length > 20)
        console.log(`     ... and ${slow.length - 20} more`);
    } else {
      console.log(
        `  No individually slow device responses found - this capture's periodic send-gaps (if any, see timing analysis above) are NOT explained by the device itself responding slowly to specific chunks.`,
      );
    }
  };
  printSide(a.label, a);
  printSide(b.label, b);
}

// ── Chunk-level analysis - the PROCESS, not just the final result ──────────
//
// The address reconciliation below proves the FINAL content ends up the
// same - it does NOT prove the WRITE PROCESS itself was safe. A real,
// standing candidate mechanism for device instability: an over-length chunk
// could overflow a device's fixed-size receive buffer even if, had it been
// split differently, the final reassembled content would have been
// identical. This section never assumes "final content matches" is
// sufficient - it independently inspects every real chunk this engine ever
// sent, in either capture, looking for size anomalies.

interface ChunkWrite {
  frameNumber: number;
  timeRelative: number;
  address: number;
  addressHex: string;
  length: number;
  dataHex: string;
}

/**
 * Every real MemExtWrite/MemWrite chunk actually SENT (L_Data.req direction
 * only - the .con is the same logical write echoed back at the link layer,
 * and MemExtWriteResp is an empty acknowledgement, not a second chunk of
 * real payload; counting either would double/triple-count the same chunk).
 */
function extractChunkWrites(ops: Operation[]): ChunkWrite[] {
  const chunks: ChunkWrite[] = [];
  for (const op of ops) {
    if (op.cemiMcName !== 'L_Data.req') continue;
    const svcWord = serviceWordFromInfo(op.infoLine);
    if (svcWord !== 'MemExtWrite' && svcWord !== 'MemWrite') continue;
    if (!op.memAddrFromInfo || !op.cemiDataHex) continue;
    chunks.push({
      frameNumber: op.frameNumber,
      timeRelative: op.timeRelative,
      address: parseInt(op.memAddrFromInfo.replace(/^0x/, ''), 16),
      addressHex: op.memAddrFromInfo,
      length: op.cemiDataHex.length / 2,
      dataHex: op.cemiDataHex,
    });
  }
  return chunks;
}

/** Group chunks (already real, distinct writes) into contiguous address runs - a "run" is one real logical write pass over one memory region, regardless of how many chunks it took. */
interface ChunkRun {
  startAddress: number;
  endAddress: number; // exclusive
  chunks: ChunkWrite[];
}

function groupIntoRuns(chunks: ChunkWrite[]): ChunkRun[] {
  const sorted = [...chunks].sort((a, b) => a.address - b.address);
  const runs: ChunkRun[] = [];
  for (const c of sorted) {
    const last = runs[runs.length - 1];
    if (last && c.address === last.endAddress) {
      last.chunks.push(c);
      last.endAddress = c.address + c.length;
    } else {
      runs.push({
        startAddress: c.address,
        endAddress: c.address + c.length,
        chunks: [c],
      });
    }
  }
  return runs;
}

function histogram(chunks: ChunkWrite[]): Map<number, number> {
  const h = new Map<number, number>();
  for (const c of chunks) h.set(c.length, (h.get(c.length) ?? 0) + 1);
  return h;
}

function printChunkAnalysis(a: CaptureAudit, b: CaptureAudit): void {
  console.log(`\n=== CHUNK-LEVEL ANALYSIS: ${a.label} vs ${b.label} ===`);
  console.log(
    '(Every real MemExtWrite chunk this engine sent, either side - checking the WRITE PROCESS itself, not just the final reconciled content above.)',
  );

  const aChunks = extractChunkWrites(a.operations);
  const bChunks = extractChunkWrites(b.operations);
  const aMax = aChunks.length ? Math.max(...aChunks.map((c) => c.length)) : 0;
  const bMax = bChunks.length ? Math.max(...bChunks.map((c) => c.length)) : 0;
  const aHist = histogram(aChunks);
  const bHist = histogram(bChunks);

  const printSide = (
    label: string,
    chunks: ChunkWrite[],
    hist: Map<number, number>,
  ) => {
    console.log(
      `\n${label}: ${chunks.length} real chunk writes, ${chunks.reduce((s, c) => s + c.length, 0)} total bytes.`,
    );
    const sizes = [...hist.keys()].sort((x, y) => y - x);
    for (const size of sizes)
      console.log(`  ${size} bytes x ${hist.get(size)}`);
  };
  printSide(a.label, aChunks, aHist);
  printSide(b.label, bChunks, bHist);

  // Anomaly 1: one side's largest-ever chunk exceeds the other's - a chunk
  // size genuinely never exercised by the other engine for this device is
  // worth explicit attention (the real candidate mechanism this section
  // exists to catch: an over-length chunk overflowing a fixed receive
  // buffer).
  console.log(`\n--- Anomaly checks ---`);
  if (aMax !== bMax) {
    const bigger = aMax > bMax ? a.label : b.label;
    const biggerVal = Math.max(aMax, bMax);
    const smallerVal = Math.min(aMax, bMax);
    console.log(
      `⚠ MAX CHUNK SIZE DIFFERS: ${bigger} used a chunk as large as ${biggerVal} bytes; the other side's largest chunk was only ${smallerVal} bytes. ` +
        `A chunk size larger than anything the OTHER engine ever sent to this device is genuinely untested by that comparison and worth explicit verification the device safely accepts it.`,
    );
  } else {
    console.log(
      `✓ Both sides' largest chunk is the same size (${aMax} bytes) - no max-chunk-size anomaly.`,
    );
  }

  // Anomaly 2: a "short" chunk (smaller than that capture's own established
  // max) that is NOT the last chunk of its contiguous run - the established
  // normal pattern is exactly one short "remainder" chunk at the end of
  // each run; a short chunk anywhere else is irregular and could indicate a
  // retry, a fragmentation quirk, or something else worth a direct look.
  const checkRunAnomalies = (
    label: string,
    chunks: ChunkWrite[],
    maxSize: number,
  ) => {
    const runs = groupIntoRuns(chunks);
    const irregular: { run: number; chunk: ChunkWrite }[] = [];
    for (const [runIdx, run] of runs.entries()) {
      for (let i = 0; i < run.chunks.length - 1; i++) {
        // Not the last chunk in this run, but shorter than the max chunk
        // size this capture ever used elsewhere - a real irregularity.
        if (run.chunks[i]!.length < maxSize)
          irregular.push({ run: runIdx, chunk: run.chunks[i]! });
      }
    }
    if (irregular.length > 0) {
      console.log(
        `⚠ ${label}: ${irregular.length} chunk(s) are SHORTER than this capture's own max chunk size (${maxSize}) but are NOT the final chunk of their write run - irregular, worth review:`,
      );
      for (const { run, chunk } of irregular.slice(0, 20)) {
        console.log(
          `   run #${run}, frame ${chunk.frameNumber}, address ${chunk.addressHex}, length ${chunk.length}`,
        );
      }
      if (irregular.length > 20)
        console.log(`   ... and ${irregular.length - 20} more`);
    } else {
      console.log(
        `✓ ${label}: every non-final chunk uses the max chunk size (${maxSize}) - no mid-run irregular chunk found.`,
      );
    }
    return runs;
  };
  const aRuns = checkRunAnomalies(a.label, aChunks, aMax);
  const bRuns = checkRunAnomalies(b.label, bChunks, bMax);

  // Per-run comparison: match runs between captures by address-range overlap
  // (the same real memory region, regardless of how it was chunked) and
  // report the actual chunk-count/size-sequence difference explicitly -
  // informational when the two sequences just differ in shape (benign,
  // already proven byte-identical by the reconciliation above), but a run
  // present in only one capture is a real, distinct finding from a chunking
  // difference and is called out separately.
  console.log(
    `\n--- Per-run comparison (${a.label}: ${aRuns.length} runs, ${b.label}: ${bRuns.length} runs) ---`,
  );
  const overlaps = (r1: ChunkRun, r2: ChunkRun) =>
    r1.startAddress < r2.endAddress && r2.startAddress < r1.endAddress;
  const matchedB = new Set<number>();
  for (const r1 of aRuns) {
    const j = bRuns.findIndex(
      (r2, idx) => !matchedB.has(idx) && overlaps(r1, r2),
    );
    if (j === -1) {
      console.log(
        `  Run only in ${a.label}: 0x${r1.startAddress.toString(16)}-0x${r1.endAddress.toString(16)} (${r1.chunks.length} chunks, ${r1.endAddress - r1.startAddress} bytes)`,
      );
      continue;
    }
    matchedB.add(j);
    const r2 = bRuns[j]!;
    const sameRange =
      r1.startAddress === r2.startAddress && r1.endAddress === r2.endAddress;
    const sameChunking =
      r1.chunks.length === r2.chunks.length &&
      r1.chunks.every((c, k) => c.length === r2.chunks[k]!.length);
    if (!sameRange) {
      console.log(
        `  ⚠ Run range MISMATCH: ${a.label} 0x${r1.startAddress.toString(16)}-0x${r1.endAddress.toString(16)} vs ${b.label} 0x${r2.startAddress.toString(16)}-0x${r2.endAddress.toString(16)} - overlapping but NOT identical coverage.`,
      );
    } else if (!sameChunking) {
      console.log(
        `  Run 0x${r1.startAddress.toString(16)}-0x${r1.endAddress.toString(16)}: same byte range, DIFFERENT chunking - ${a.label} used ${r1.chunks.length} chunks [${r1.chunks.map((c) => c.length).join(',')}], ${b.label} used ${r2.chunks.length} chunks [${r2.chunks.map((c) => c.length).join(',')}] (informational - final content already checked above).`,
      );
    }
  }
  for (const [j, r2] of bRuns.entries()) {
    if (!matchedB.has(j)) {
      console.log(
        `  Run only in ${b.label}: 0x${r2.startAddress.toString(16)}-0x${r2.endAddress.toString(16)} (${r2.chunks.length} chunks, ${r2.endAddress - r2.startAddress} bytes)`,
      );
    }
  }
}

// ── Address-based reconciliation - the technique that ACTUALLY works ───────
//
// Pairing operations by POSITION in the capture is the wrong technique
// whenever the number of operations differs between captures (chunked
// writes split differently, or a reference capture bundling multiple real
// actions into one file). The RIGHT technique is: build a "last write wins"
// map keyed by REAL ADDRESS (memory address for MemExtWrite, or
// OT/OI/OX/PID/array-index for property services), completely independent
// of how many chunks/operations it took to get there or what order they
// arrived in. Comparing two such maps directly answers "does the device end
// up being told to store the same thing", which is the actual question -
// not "did the same number of wire operations occur".

/**
 * A reconciliation key identifying WHAT real thing on the device an
 * operation addresses - deliberately independent of chunk count/order. Null
 * for operations with no addressable content (session management: Connect/
 * Disconnect/Restart/Auth/DevDescr - already covered by the structural diff
 * above, nothing to reconcile by address).
 */
function reconciliationKey(op: Operation): string | null {
  // Memory writes (MemExtWrite/MemWrite and their .con echoes) - keyed by
  // the real, untruncated memory address.
  if (op.memAddrFromInfo && /MemExtWrite|MemWrite/.test(op.infoLine)) {
    return `mem:${op.memAddrFromInfo}`;
  }
  // PropertyValue services (PropValueWrite/Read/Resp) - keyed by object
  // index + property id + array element index if this property is
  // multi-element (X=N, not to be confused with a memory address's X=$...).
  if (op.cemiOx && op.cemiPid) {
    return `prop:OX=${op.cemiOx}:PID=${op.cemiPid}${op.arrayIndex != null ? `:X=${op.arrayIndex}` : ''}`;
  }
  // FuncPropExt services (Object Type/Instance addressed, not object index).
  if (op.cemiOt && op.cemiPid) {
    return `funcprop:OT=${op.cemiOt}:OI=${op.cemiOi || '0'}:PID=${op.cemiPid}`;
  }
  // PropDescr (property descriptor, not value) - keyed by object index +
  // property index (PX, not PID - a real, distinct addressing scheme for
  // descriptor reads).
  if (op.cemiOx && op.cemiPx) {
    return `propdescr:OX=${op.cemiOx}:PX=${op.cemiPx}`;
  }
  return null;
}

/** Whether this operation actually carries content worth reconciling (a write, or a response echoing back real device state) - a bare Read/Get request carries no data, only its own presence (already covered by the structural diff). */
function isContentBearing(op: Operation): boolean {
  const svcWord = serviceWordFromInfo(op.infoLine);
  // MemExtWriteResp/MemWriteResp are ALWAYS empty acknowledgements (never
  // real content), so including them here would mean a later-arriving empty
  // ack could silently overwrite the REAL value its own preceding *Write
  // already recorded under the same reconciliation key ("last write wins"),
  // producing a false mismatch. The real written value is already captured
  // by the *Write operation itself, which IS content-bearing - the *Resp
  // ack adds no information worth keeping here and actively destroys real
  // information if kept.
  return (
    svcWord === 'PropValueWrite' ||
    svcWord === 'PropValueResp' ||
    svcWord === 'PropDescrResp' ||
    svcWord === 'FuncPropExtResp' ||
    svcWord === 'FuncPropExtCmd' ||
    /\bMemExtWrite\b|\bMemWrite\b/.test(op.infoLine)
  );
}

interface ReconciledEntry {
  key: string;
  dataHex: string;
  frameNumber: number;
  infoLine: string;
}

function buildReconciliationMap(
  ops: Operation[],
): Map<string, ReconciledEntry> {
  const map = new Map<string, ReconciledEntry>();
  for (const op of ops) {
    if (!isContentBearing(op)) continue;
    const key = reconciliationKey(op);
    if (!key) continue;
    // Last write/response wins - matches real device behavior (a later
    // write to the same address supersedes an earlier one).
    map.set(key, {
      key,
      dataHex: op.cemiDataHex,
      frameNumber: op.frameNumber,
      infoLine: op.infoLine,
    });
  }
  return map;
}

function printAddressReconciliation(
  a: CaptureAudit,
  b: CaptureAudit,
  sameDevice: boolean,
): void {
  console.log(
    `\n=== ADDRESS-BASED RECONCILIATION: ${a.label} vs ${b.label} ===`,
  );
  console.log(
    '(Applies to EVERY addressable operation - property writes/reads, memory writes, FuncPropExt, PropDescr. ' +
      'Chunk-count and ordering independent: only the FINAL value at each real address is compared.)',
  );
  if (!sameDevice) {
    console.log(
      '⚠ --a-device and --b-device differ - real content is EXPECTED to differ between different physical devices/apps. Treat every mismatch below as informational, not necessarily a bug.',
    );
  }

  const aMap = buildReconciliationMap(a.operations);
  const bMap = buildReconciliationMap(b.operations);
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);

  let matches = 0;
  const onlyInA: ReconciledEntry[] = [];
  const onlyInB: ReconciledEntry[] = [];
  const mismatches: { key: string; a: ReconciledEntry; b: ReconciledEntry }[] =
    [];

  for (const key of allKeys) {
    const av = aMap.get(key);
    const bv = bMap.get(key);
    if (av && !bv) onlyInA.push(av);
    else if (bv && !av) onlyInB.push(bv);
    else if (av && bv) {
      if (av.dataHex === bv.dataHex) matches++;
      else mismatches.push({ key, a: av, b: bv });
    }
  }

  console.log(`Real addressable locations reconciled: ${allKeys.size} total.`);
  console.log(`  Present in BOTH with IDENTICAL final content: ${matches}`);
  console.log(
    `  Present in BOTH but DIFFERENT final content: ${mismatches.length}`,
  );
  console.log(`  Present ONLY in ${a.label}: ${onlyInA.length}`);
  console.log(`  Present ONLY in ${b.label}: ${onlyInB.length}`);

  if (mismatches.length > 0) {
    console.log(
      `\nContent mismatches (final value differs at the same real address):`,
    );
    for (const m of mismatches.slice(0, 200)) {
      console.log(
        `  [${m.key}] ${a.label} frame ${m.a.frameNumber}: ${m.a.dataHex || '(none)'}  vs  ${b.label} frame ${m.b.frameNumber}: ${m.b.dataHex || '(none)'}`,
      );
    }
    if (mismatches.length > 200)
      console.log(`  ... and ${mismatches.length - 200} more`);
  }
  if (onlyInA.length > 0) {
    console.log(
      `\nAddresses only ever written/read in ${a.label} (never appears in ${b.label} at all):`,
    );
    for (const e of onlyInA.slice(0, 100))
      console.log(
        `  [${e.key}] frame ${e.frameNumber}: ${e.dataHex || '(none)'} (${e.infoLine.trim()})`,
      );
    if (onlyInA.length > 100)
      console.log(`  ... and ${onlyInA.length - 100} more`);
  }
  if (onlyInB.length > 0) {
    console.log(
      `\nAddresses only ever written/read in ${b.label} (never appears in ${a.label} at all):`,
    );
    for (const e of onlyInB.slice(0, 100))
      console.log(
        `  [${e.key}] frame ${e.frameNumber}: ${e.dataHex || '(none)'} (${e.infoLine.trim()})`,
      );
    if (onlyInB.length > 100)
      console.log(`  ... and ${onlyInB.length - 100} more`);
  }

  console.log(
    `\nSummary: of ${allKeys.size} real addressable locations touched by either session, ${matches} match exactly, ` +
      `${mismatches.length} genuinely differ, ${onlyInA.length + onlyInB.length} appear in only one side. ` +
      (sameDevice
        ? 'Same device on both sides - a mismatch or one-sided address here is a real, meaningful finding, not expected noise.'
        : 'Different devices - treat mismatches as informational, not necessarily bugs.'),
  );
}

// ── Content diff - the actual byte-level answer to "is every byte the same" ──
//
// The structural diff above answers a different question (which OPERATIONS
// occur) - this answers "is every byte the same": for operations whose
// structural signature and COUNT match in both captures, pair them up in
// capture order and diff their real memory address (from the Info line, not
// the truncated `cemi.x`) and raw `cemi.data` bytes. A signature with a
// DIFFERENT count between captures is not paired here (no well-defined 1:1
// mapping) - it's already surfaced in the count-mismatch list above.
function printContentDiff(
  a: CaptureAudit,
  b: CaptureAudit,
  sameDevice: boolean,
): void {
  console.log(
    `\n=== CONTENT DIFF (--content-diff): ${a.label} vs ${b.label} ===`,
  );
  if (!sameDevice) {
    console.log(
      '⚠ --a-device and --b-device differ - these are (or may be) two DIFFERENT physical devices. ' +
        'Real content (memory addresses, written values) is EXPECTED to differ between different devices/apps - ' +
        "every mismatch below may be entirely legitimate, not a bug. This mode is only conclusive same-device (e.g. an ETS reference download vs this engine's download to the IDENTICAL device).",
    );
  }

  const bySig = (
    ops: Operation[],
    sigs: string[],
  ): Map<string, Operation[]> => {
    const m = new Map<string, Operation[]>();
    ops.forEach((op, i) => {
      const sig = sigs[i]!;
      (m.get(sig) ?? m.set(sig, []).get(sig)!).push(op);
    });
    return m;
  };
  const aBySig = bySig(a.operations, a.operationSignatures);
  const bBySig = bySig(b.operations, b.operationSignatures);

  let pairedSignatures = 0;
  let pairedOperations = 0;
  let contentMatches = 0;
  const mismatches: {
    sig: string;
    index: number;
    aOp: Operation;
    bOp: Operation;
    addrMismatch: boolean;
    dataMismatch: boolean;
  }[] = [];

  for (const [sig, aOps] of aBySig) {
    const bOps = bBySig.get(sig);
    if (!bOps || bOps.length !== aOps.length) continue; // count mismatch - not paired here, already in the structural diff
    pairedSignatures++;
    for (let i = 0; i < aOps.length; i++) {
      pairedOperations++;
      const aOp = aOps[i]!;
      const bOp = bOps[i]!;
      const addrMismatch = !!(
        aOp.memAddrFromInfo &&
        bOp.memAddrFromInfo &&
        aOp.memAddrFromInfo !== bOp.memAddrFromInfo
      );
      const dataMismatch = aOp.cemiDataHex !== bOp.cemiDataHex;
      if (addrMismatch || dataMismatch) {
        mismatches.push({
          sig,
          index: i,
          aOp,
          bOp,
          addrMismatch,
          dataMismatch,
        });
      } else {
        contentMatches++;
      }
    }
  }

  console.log(
    `Paired ${pairedOperations} operations across ${pairedSignatures} matching signatures (same structure, same count in both captures).`,
  );
  console.log(`  Byte-for-byte content match: ${contentMatches}`);
  console.log(`  Content MISMATCHES: ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches.slice(0, 100)) {
      console.log(
        `  [${m.sig}] occurrence #${m.index}: frame ${m.aOp.frameNumber} vs frame ${m.bOp.frameNumber}` +
          (m.addrMismatch
            ? ` | ADDR ${a.label}=${m.aOp.memAddrFromInfo} vs ${b.label}=${m.bOp.memAddrFromInfo}`
            : '') +
          (m.dataMismatch
            ? ` | DATA ${a.label}=${m.aOp.cemiDataHex || '(none)'} vs ${b.label}=${m.bOp.cemiDataHex || '(none)'}`
            : ''),
      );
    }
    if (mismatches.length > 100)
      console.log(
        `  ... and ${mismatches.length - 100} more (see full operation lists in the audit logs)`,
      );
  }
  const unpaired =
    a.operations.length + b.operations.length - pairedOperations * 2;
  console.log(
    `\n${unpaired} operation(s) could NOT be paired for content comparison (signature present a different number of times in each capture - see the structural diff's count-mismatch list above for those).`,
  );
}

main();
