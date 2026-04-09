/**
 * KNX USB transport — HID class interface to KNX USB Interface Devices.
 * Extends KnxConnection (shared protocol logic) with USB HID transport.
 *
 * Protocol per KNX Standard 09/03 "Couplers", clause 3 "KNX USB Interface".
 * Uses node-hid for USB HID communication.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { KnxConnection, parseCEMI, delay } from './knx-connection.ts';
import { logger } from './log.ts';

const require_ = createRequire(import.meta.url);

// ── Interfaces ────────────────────────────────────────────────────────────────

interface HidReport {
  seq: number;
  pktType: number;
  dataLength: number;
  data: Buffer;
}

interface TransferHeader {
  protocolVersion: number;
  headerLength: number;
  bodyLength: number;
  protocolId: number;
  emiId: number;
  mfrCode: number;
}

interface FeatureWaiter {
  featureId: number;
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HidDeviceInfo {
  path?: string;
  manufacturer?: string;
  product?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  usagePage?: number;
  usage?: number;
  interface?: number;
}

interface HidDevice {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): void;
  write(data: number[]): void;
  close(): void;
}

interface NodeHid {
  devices(): HidDeviceInfo[];
  HID: new (path: string) => HidDevice;
}

// ── Known KNX USB interfaces (loaded from known_knx_usb.csv) ──────────────────
// CSV format: VendorID,ProductID,Name
// VendorID and ProductID are hex (e.g. 0x147B) or decimal.

const _knownInterfaces: Map<string, string> = new Map(); // key: "vendorId:productId" → name

function loadKnownInterfaces(): void {
  const csvPath = path.join(process.cwd(), 'known_knx_usb.csv');
  let raw: string;
  try {
    raw = fs.readFileSync(csvPath, 'utf-8');
  } catch (_) {
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.toLowerCase().startsWith('vendorid')
    )
      continue;
    const parts = trimmed.split(',');
    if (parts.length < 2) continue;
    const vid = parseInt(
      parts[0]!.trim(),
      parts[0]!.trim().startsWith('0x') ? 16 : 10,
    );
    const pid = parseInt(
      parts[1]!.trim(),
      parts[1]!.trim().startsWith('0x') ? 16 : 10,
    );
    const name = (parts.slice(2).join(',') || '').trim();
    if (!isNaN(vid) && !isNaN(pid)) _knownInterfaces.set(`${vid}:${pid}`, name);
  }

  if (_knownInterfaces.size > 0) {
    logger.info(
      'knx',
      `Loaded ${_knownInterfaces.size} known interfaces from known_knx_usb.csv`,
    );
  }
}

loadKnownInterfaces();

function isKnownKnxDevice(vendorId: number, productId: number): boolean {
  return _knownInterfaces.has(`${vendorId}:${productId}`);
}

function knownKnxName(vendorId: number, productId: number): string {
  return _knownInterfaces.get(`${vendorId}:${productId}`) || '';
}

// KNX USB Transfer Protocol constants
const REPORT_ID = 0x01;
const PROTOCOL_VERSION = 0x00;
const HEADER_LENGTH = 0x08;

// Protocol IDs (KNX USB Transfer Protocol Header, octet 5)
const PROTO_KNX_TUNNEL = 0x01;
const PROTO_BUS_FEATURE = 0x0f;

// EMI IDs (KNX USB Transfer Protocol Header, octet 6)
const EMI_ID = {
  EMI1: 0x01,
  EMI2: 0x02,
  COMMON: 0x03, // cEMI
} as const;

// Device Feature Service Identifiers
const FEATURE_SVC = {
  GET: 0x01,
  RESPONSE: 0x02,
  SET: 0x03,
  INFO: 0x04,
} as const;

// Device Feature Identifiers
const FEATURE = {
  SUPPORTED_EMI: 0x01, // 2 bytes bitmask
  DEVICE_DESC_0: 0x02, // 2 bytes
  BUS_STATUS: 0x03, // 1 bit
  MFR_CODE: 0x04, // 2 bytes
  ACTIVE_EMI: 0x05, // 1 byte
} as const;

// Packet type flags (in PacketInfo low nibble)
const PKT = {
  START_END: 0x03, // single packet (start + end)
  START: 0x05, // start & partial (more to follow)
  PARTIAL: 0x04, // middle packet
  END: 0x06, // partial & end (last packet)
} as const;

// ── HID Report building / parsing ──────────────────────────────────────────────

/**
 * Build HID report(s) for a KNX USB Transfer Frame.
 * Returns an array of 64-byte Buffers (one per HID report).
 */
function buildHidReports(
  protocolId: number,
  emiId: number,
  body: Buffer | null,
  mfrCode: number = 0x0000,
): Buffer[] {
  const bodyLen = body ? body.length : 0;

  // KNX USB Transfer Protocol Header (8 bytes)
  const transferHeader = Buffer.alloc(8);
  transferHeader[0] = PROTOCOL_VERSION;
  transferHeader[1] = HEADER_LENGTH;
  transferHeader.writeUInt16BE(bodyLen, 2); // body length
  transferHeader[4] = protocolId; // Protocol ID
  transferHeader[5] = emiId; // EMI ID
  transferHeader.writeUInt16BE(mfrCode, 6); // Manufacturer Code

  // Full transfer frame = header + body
  const frame = body ? Buffer.concat([transferHeader, body]) : transferHeader;

  // Split into HID reports (max 61 data bytes per report)
  const MAX_DATA = 61;
  const reports: Buffer[] = [];

  if (frame.length <= MAX_DATA) {
    // Single report: start + end
    const report = Buffer.alloc(64);
    report[0] = REPORT_ID;
    report[1] = (0x1 << 4) | PKT.START_END; // seq=1, type=start+end
    report[2] = frame.length; // data length
    frame.copy(report, 3);
    reports.push(report);
  } else {
    // Multi-report: split the frame
    let seq = 1;

    // First report gets the transfer header + as much body as fits
    const firstChunkLen = Math.min(frame.length, MAX_DATA);
    const firstReport = Buffer.alloc(64);
    firstReport[0] = REPORT_ID;
    firstReport[1] =
      (seq << 4) |
      (frame.length - firstChunkLen > 0 ? PKT.START : PKT.START_END);
    firstReport[2] = firstChunkLen;
    frame.copy(firstReport, 3, 0, firstChunkLen);
    reports.push(firstReport);
    let offset = firstChunkLen;
    seq++;

    // Subsequent reports carry remaining body data only (no transfer header)
    while (offset < frame.length) {
      const remaining = frame.length - offset;
      const chunkLen = Math.min(remaining, MAX_DATA);
      const isLast = offset + chunkLen >= frame.length;

      const report = Buffer.alloc(64);
      report[0] = REPORT_ID;
      report[1] = (seq << 4) | (isLast ? PKT.END : PKT.PARTIAL);
      report[2] = chunkLen;
      frame.copy(report, 3, offset, offset + chunkLen);
      reports.push(report);
      offset += chunkLen;
      seq++;
    }
  }

  return reports;
}

/**
 * Parse a received HID report.
 * Returns { seq, pktType, dataLength, data } or null on error.
 */
function parseHidReport(buf: Buffer): HidReport | null {
  if (!buf || buf.length < 3) return null;
  // Some HID implementations include the Report ID byte, some don't
  let off = 0;
  if (buf[0] === REPORT_ID && buf.length >= 4) off = 1;
  else if (buf[0] !== REPORT_ID) off = 0; // no report ID prefix

  const packetInfo = buf[off]!;
  const seq = (packetInfo >> 4) & 0x0f;
  const pktType = packetInfo & 0x0f;
  const dataLen = buf[off + 1]!;
  const data = buf.slice(off + 2, off + 2 + dataLen);

  return { seq, pktType, dataLength: dataLen, data };
}

/**
 * Parse the KNX USB Transfer Protocol Header from the data portion of a start packet.
 */
function parseTransferHeader(data: Buffer): TransferHeader | null {
  if (!data || data.length < 8) return null;
  return {
    protocolVersion: data[0]!,
    headerLength: data[1]!,
    bodyLength: data.readUInt16BE(2),
    protocolId: data[4]!,
    emiId: data[5]!,
    mfrCode: data.readUInt16BE(6),
  };
}

// ── Device Feature Service frame builders ──────────────────────────────────────

function buildFeatureGet(featureId: number): Buffer[] {
  // Body is just the feature identifier (1 byte)
  const body = Buffer.from([featureId]);
  return buildHidReports(PROTO_BUS_FEATURE, FEATURE_SVC.GET, body);
}

function buildFeatureSet(featureId: number, data: Buffer): Buffer[] {
  const body = Buffer.concat([Buffer.from([featureId]), data]);
  return buildHidReports(PROTO_BUS_FEATURE, FEATURE_SVC.SET, body);
}

// ── KnxUsbConnection ───────────────────────────────────────────────────────────

class KnxUsbConnection extends KnxConnection {
  _device: HidDevice | null;
  _devicePath: string | null;
  _activeEmi: number;
  _mfrCode: number;
  _busActive: boolean;
  _rxBuf: Buffer[] | null;
  _rxExpected: number;
  _featureWaiters: FeatureWaiter[];

  constructor() {
    super();
    this._device = null;
    this._devicePath = null;
    this._activeEmi = EMI_ID.COMMON; // default to cEMI
    this._mfrCode = 0x0000;
    this._busActive = false;
    this._rxBuf = null; // reassembly buffer for multi-report frames
    this._rxExpected = 0;
    this._featureWaiters = []; // pending feature response waiters
  }

  /**
   * List available KNX USB HID devices.
   * Matches connected HID devices against known_knx_usb.csv (VendorID + ProductID).
   */
  static listDevices(): {
    path: string | undefined;
    manufacturer: string;
    product: string;
    vendorId: number | undefined;
    productId: number | undefined;
    serialNumber: string;
    knxName: string;
  }[] {
    let HID: NodeHid;
    try {
      HID = require_('node-hid') as NodeHid;
    } catch (_) {
      return [];
    }

    return HID.devices()
      .filter((d: HidDeviceInfo) =>
        isKnownKnxDevice(d.vendorId ?? 0, d.productId ?? 0),
      )
      .map((d: HidDeviceInfo) => ({
        path: d.path,
        manufacturer: d.manufacturer || '',
        product: d.product || '',
        vendorId: d.vendorId,
        productId: d.productId,
        serialNumber: d.serialNumber || '',
        knxName: knownKnxName(d.vendorId ?? 0, d.productId ?? 0),
      }));
  }

  /**
   * List all HID devices without filtering (for discovery/debugging).
   */
  static listAllHidDevices(): {
    path: string | undefined;
    manufacturer: string;
    product: string;
    vendorId: number | undefined;
    productId: number | undefined;
    serialNumber: string;
    usagePage: number | undefined;
    usage: number | undefined;
    interface: number | undefined;
  }[] {
    let HID: NodeHid;
    try {
      HID = require_('node-hid') as NodeHid;
    } catch (_) {
      return [];
    }
    return HID.devices().map((d: HidDeviceInfo) => ({
      path: d.path,
      manufacturer: d.manufacturer || '',
      product: d.product || '',
      vendorId: d.vendorId,
      productId: d.productId,
      serialNumber: d.serialNumber || '',
      usagePage: d.usagePage,
      usage: d.usage,
      interface: d.interface,
    }));
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  async connect(
    devicePath: string,
    _unused: unknown = null,
    timeoutMs: number = 5000,
  ): Promise<{ path: string }> {
    let HID: NodeHid;
    try {
      HID = require_('node-hid') as NodeHid;
    } catch (err) {
      throw new Error(
        'node-hid package not installed. Run: npm install node-hid',
        { cause: err },
      );
    }

    this._device = new HID.HID(devicePath);
    this._devicePath = devicePath;

    // Set up data reception
    this._device.on('data', (buf: Buffer) => this._onHidData(buf));
    this._device.on('error', (err: Error) => {
      logger.error('knx', 'HID error', { error: err.message });
      this.connected = false;
      this.emit('error', err);
    });

    // Negotiate EMI type
    await this._negotiateEmi(timeoutMs);

    // Check bus connection status
    await this._checkBusStatus(timeoutMs);

    this.connected = true;
    // USB devices use a fixed address (typically 0.0.0 or read from device)
    this.localAddr = '0.0.0';

    logger.info(
      'knx',
      `Connected to ${devicePath}, EMI=${this._activeEmi}, bus=${this._busActive ? 'active' : 'inactive'}`,
    );
    this.emit('connected');

    return { path: devicePath };
  }

  async _negotiateEmi(timeoutMs: number): Promise<void> {
    // Step 1: Get supported EMI types
    const supported = await this._featureGet(FEATURE.SUPPORTED_EMI, timeoutMs);
    if (!supported || supported.length < 2) {
      throw new Error('Failed to read supported EMI types from USB device');
    }

    const emiBits = (supported[0]! << 8) | supported[1]!;
    logger.debug(
      'knx',
      `Supported EMI bitmask: 0x${emiBits.toString(16).padStart(4, '0')}`,
    );

    // Prefer cEMI (bit 2), then EMI2 (bit 1), then EMI1 (bit 0)
    let targetEmi: number;
    if (emiBits & 0x04) targetEmi = EMI_ID.COMMON;
    else if (emiBits & 0x02) targetEmi = EMI_ID.EMI2;
    else if (emiBits & 0x01) targetEmi = EMI_ID.EMI1;
    else throw new Error('USB device supports no known EMI type');

    // Step 2: Check current active EMI
    const activeRaw = await this._featureGet(FEATURE.ACTIVE_EMI, timeoutMs);
    const currentActive =
      activeRaw && activeRaw.length >= 1 ? activeRaw[0]! : 0;

    // Step 3: Set active EMI if different
    if (currentActive !== targetEmi) {
      logger.debug(
        'knx',
        `Setting active EMI from ${currentActive} to ${targetEmi}`,
      );
      await this._featureSet(FEATURE.ACTIVE_EMI, Buffer.from([targetEmi]));
      await delay(100);
    }

    this._activeEmi = targetEmi;
  }

  async _checkBusStatus(timeoutMs: number): Promise<void> {
    try {
      const status = await this._featureGet(FEATURE.BUS_STATUS, timeoutMs);
      this._busActive = status && status.length >= 1 && status[0] === 0x01;
    } catch (e) {
      logger.error('knx', 'Bus status check failed', {
        error: (e as Error).message,
      });
      this._busActive = false;
    }
  }

  // ── Device Feature Get/Set ──────────────────────────────────────────────────

  _featureGet(featureId: number, timeoutMs: number = 2000): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const waiter: FeatureWaiter = {
        featureId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this._featureWaiters = this._featureWaiters.filter(
            (w) => w !== waiter,
          );
          reject(
            new Error(
              `Feature Get timeout for feature 0x${featureId.toString(16)}`,
            ),
          );
        }, timeoutMs),
      };

      this._featureWaiters.push(waiter);

      const reports = buildFeatureGet(featureId);
      for (const report of reports) this._sendReport(report);
    });
  }

  async _featureSet(featureId: number, data: Buffer): Promise<void> {
    const reports = buildFeatureSet(featureId, data);
    for (const report of reports) this._sendReport(report);
    // Feature Set has no confirmation per spec
  }

  _resolveFeatureWaiter(featureId: number, data: Buffer): void {
    const idx = this._featureWaiters.findIndex(
      (w) => w.featureId === featureId,
    );
    if (idx >= 0) {
      const waiter = this._featureWaiters.splice(idx, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    }
  }

  // ── Send CEMI via USB HID ─────────────────────────────────────────────────────

  sendCEMI(cemi: Buffer): Promise<void> {
    if (!this._device) return Promise.reject(new Error('USB device not open'));
    // Wrap cEMI in KNX USB Transfer Protocol with KNX Tunnel protocol ID
    const reports = buildHidReports(
      PROTO_KNX_TUNNEL,
      this._activeEmi,
      cemi,
      this._mfrCode,
    );
    for (const report of reports) this._sendReport(report);
    // USB HID is reliable — no ACK loop needed
    return Promise.resolve();
  }

  _sendReport(report: Buffer): void {
    if (!this._device) return;
    // node-hid write() expects the report data; on some platforms the first byte
    // must be the report ID, on others it's prepended automatically.
    // We always include it and let node-hid handle platform differences.
    const arr = Array.from(report);
    this._device.write(arr);
  }

  // ── Receive HID data ──────────────────────────────────────────────────────────

  _onHidData(buf: Buffer): void {
    const report = parseHidReport(Buffer.from(buf));
    if (!report) return;

    const { pktType, data } = report;

    if (pktType === PKT.START_END) {
      // Single-packet frame — process immediately
      this._processTransferFrame(data);
    } else if (pktType === PKT.START) {
      // Start of multi-packet frame
      this._rxBuf = [data];
      this._rxExpected = 0; // we'll know total from header
    } else if (pktType === PKT.PARTIAL) {
      if (this._rxBuf) this._rxBuf.push(data);
    } else if (pktType === PKT.END) {
      if (this._rxBuf) {
        this._rxBuf.push(data);
        const fullData = Buffer.concat(this._rxBuf);
        this._rxBuf = null;
        this._processTransferFrame(fullData);
      }
    }
  }

  _processTransferFrame(data: Buffer): void {
    const hdr = parseTransferHeader(data);
    if (!hdr) return;

    if (hdr.protocolVersion !== PROTOCOL_VERSION) return;
    if (hdr.headerLength !== HEADER_LENGTH) return;

    const body = data.slice(HEADER_LENGTH, HEADER_LENGTH + hdr.bodyLength);

    if (hdr.protocolId === PROTO_KNX_TUNNEL) {
      this._onTunnelFrame(body, hdr.emiId);
    } else if (hdr.protocolId === PROTO_BUS_FEATURE) {
      this._onFeatureFrame(body, hdr.emiId);
    }
  }

  _onTunnelFrame(body: Buffer, _emiId: number): void {
    if (!body || body.length === 0) return;

    // For cEMI: body starts with EMI Message Code, then the cEMI frame
    // parseCEMI expects the full cEMI starting from message code
    const cemi = parseCEMI(body, 0);
    if (cemi) this._onCEMI(cemi);
  }

  _onFeatureFrame(body: Buffer, svcId: number): void {
    if (!body || body.length < 1) return;

    const featureId = body[0]!;
    const featureData = body.slice(1);

    if (svcId === FEATURE_SVC.RESPONSE) {
      // Device Feature Response — resolve pending waiter
      this._resolveFeatureWaiter(featureId, featureData);
    } else if (svcId === FEATURE_SVC.INFO) {
      // Device Feature Info — unsolicited notification
      if (featureId === FEATURE.BUS_STATUS) {
        const wasActive = this._busActive;
        this._busActive = featureData.length >= 1 && featureData[0] === 0x01;
        logger.info(
          'knx',
          `Bus status changed: ${this._busActive ? 'active' : 'inactive'}`,
        );
        if (wasActive && !this._busActive) {
          this.emit('error', new Error('KNX bus disconnected'));
        }
      }
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────────

  disconnect(): void {
    if (this._device) {
      try {
        this._device.close();
      } catch (_) {}
      this._device = null;
    }
    this.connected = false;
    this._busActive = false;
    this._rxBuf = null;
    this._featureWaiters.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(new Error('Disconnected'));
    });
    this._featureWaiters = [];
  }

  status(): {
    connected: boolean;
    type: string;
    path: string | null;
    busActive: boolean;
    activeEmi: number;
    hasLib: boolean;
  } {
    return {
      connected: this.connected,
      type: 'usb',
      path: this._devicePath,
      busActive: this._busActive,
      activeEmi: this._activeEmi,
      hasLib: true,
    };
  }
}

export { KnxUsbConnection };

// Export pure helpers for testing
export {
  buildHidReports as _buildHidReports,
  parseHidReport as _parseHidReport,
  parseTransferHeader as _parseTransferHeader,
  buildFeatureGet as _buildFeatureGet,
  buildFeatureSet as _buildFeatureSet,
  PROTO_KNX_TUNNEL as _PROTO_KNX_TUNNEL,
  PROTO_BUS_FEATURE as _PROTO_BUS_FEATURE,
  EMI_ID as _EMI_ID,
  FEATURE as _FEATURE,
  PKT as _PKT,
  FEATURE_SVC as _FEATURE_SVC,
};
