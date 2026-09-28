import { useState, useEffect } from 'react';
import { errMessage } from './api.ts';
import { Btn, Spinner } from './primitives.tsx';
import { api } from './api.ts';
import { useLiveData, useBusActions, useAppData } from './contexts.ts';
// Reuses ProjectInfoView's own styles rather than duplicating them - this
// panel was extracted from ProjectInfoView's inline "BUS CONNECTION" card
// so the quick-connect popover on the top-bar status badge (see
// AppShell.tsx) can show the exact same real connect UI (IP/USB tabs, USB
// device scan, error display) instead of a second, thinner one.
import styles from './views/ProjectInfoView.module.css';

/**
 * The bus connect/disconnect UI (KNXnet/IP host+port, or USB device scan +
 * select), usable standalone (ProjectInfoView) or inside a popover
 * (AppShell's status badge). `onConnected` fires after a successful
 * connect/disconnect - the popover uses it to close itself.
 */
/** One row of GET /bus/usb-devices. */
interface UsbDevice {
  path: string;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
  /** A recognised KNX interface's product name, from known_knx_usb.csv. */
  knxName?: string;
  vendorId?: number;
  productId?: number;
  known?: boolean;
  name?: string;
}

export function BusConnectionPanel({
  onConnected,
}: {
  onConnected?: () => void;
}) {
  const { busStatus } = useLiveData();
  // LOCAL TESTING AID ONLY - see connectLoopback's own doc comment
  // (contexts.ts).
  const { projectData } = useAppData();
  const {
    connect: onConnect,
    connectUsb: onConnectUsb,
    connectLoopback: onConnectLoopback,
    disconnect: onDisconnect,
  } = useBusActions();

  const [tab, setTab] = useState(busStatus.type === 'usb' ? 'usb' : 'ip');
  const [host, setHost] = useState(busStatus.host || '');
  const [port, setPort] = useState(String(busStatus.port || '3671'));
  const [protocol, setProtocol] = useState<'udp' | 'tcp' | 'auto'>('auto');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // USB state
  const [usbDevices, setUsbDevices] = useState<UsbDevice[] | null>(null);
  const [usbLoading, setUsbLoading] = useState(false);
  const [selectedUsb, setSelectedUsb] = useState('');

  // LOCAL TESTING AID ONLY state - see connectLoopback's own doc comment.
  const [selectedLoopbackDevice, setSelectedLoopbackDevice] = useState('');

  useEffect(() => {
    if (busStatus.connected) return;
    api
      .getSettings()
      .then((s) => {
        if (s.knxip_host) setHost(s.knxip_host);
        if (s.knxip_port) setPort(s.knxip_port);
        // The settings table stores plain strings; only the three the
        // picker knows about are meaningful here.
        if (
          s.knxip_protocol === 'udp' ||
          s.knxip_protocol === 'tcp' ||
          s.knxip_protocol === 'auto'
        )
          setProtocol(s.knxip_protocol);
      })
      .catch(() => {});
  }, []);

  const doConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await onConnect(host, parseInt(port), protocol);
      onConnected?.();
    } catch (e) {
      setError(errMessage(e));
    }
    setConnecting(false);
  };

  const doConnectUsb = async () => {
    if (!selectedUsb) return;
    setConnecting(true);
    setError(null);
    try {
      await onConnectUsb(selectedUsb);
      onConnected?.();
    } catch (e) {
      setError(errMessage(e));
    }
    setConnecting(false);
  };

  // LOCAL TESTING AID ONLY - see connectLoopback's own doc comment.
  const doConnectLoopback = async () => {
    if (!selectedLoopbackDevice) return;
    setConnecting(true);
    setError(null);
    try {
      await onConnectLoopback(Number(selectedLoopbackDevice));
      onConnected?.();
    } catch (e) {
      setError(errMessage(e));
    }
    setConnecting(false);
  };

  const doDisconnect = async () => {
    await onDisconnect();
    onConnected?.();
  };

  const scanUsb = async () => {
    setUsbLoading(true);
    setError(null);
    try {
      const res = (await api.busUsbDevices()) as unknown as {
        devices?: UsbDevice[];
        error?: string;
      };
      setUsbDevices(res.devices || []);
      if (res.error) setError(res.error);
      if (res.devices?.length === 1) setSelectedUsb(res.devices[0]!.path);
    } catch (e) {
      setError(errMessage(e));
      setUsbDevices([]);
    }
    setUsbLoading(false);
  };

  const tabClass = (id: string) =>
    tab === id ? styles.tabActive : styles.tabInactive;

  return (
    <div className={styles.card}>
      <div className={styles.sectionTitle}>BUS CONNECTION</div>

      {!busStatus.connected && (
        <div className={styles.tabRow}>
          <button
            className={`${styles.tabBtn} ${tabClass('ip')}`}
            onClick={() => setTab('ip')}
          >
            KNXnet/IP
          </button>
          <button
            className={`${styles.tabBtn} ${tabClass('usb')}`}
            onClick={() => setTab('usb')}
          >
            USB
          </button>
          {/* LOCAL TESTING AID ONLY - simulates one device from the active
              project so the whole app can be driven with no hardware
              attached. */}
          <button
            className={`${styles.tabBtn} ${tabClass('loopback')}`}
            onClick={() => setTab('loopback')}
          >
            Loopback (test)
          </button>
        </div>
      )}

      {busStatus.connected ? (
        <div className={styles.connectedRow}>
          <span className={styles.connectedLabel}>
            {busStatus.type === 'usb'
              ? '● Connected via USB'
              : busStatus.type === 'loopback'
                ? '● Connected via Loopback (test - no real device)'
                : `● Connected to ${busStatus.host}:${busStatus.port || 3671} (${(busStatus.type || 'udp').toUpperCase()})`}
          </span>
          <Btn onClick={doDisconnect} color="var(--red)" bg="#1a0a0a">
            Disconnect
          </Btn>
        </div>
      ) : tab === 'loopback' ? (
        <>
          <div className={styles.fieldLabel}>
            SIMULATE DEVICE (from this project)
          </div>
          <select
            value={selectedLoopbackDevice}
            onChange={(e) => setSelectedLoopbackDevice(e.target.value)}
            className={styles.textInput}
          >
            <option value="">Choose a device…</option>
            {(projectData?.devices ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.individual_address} · {d.name}
              </option>
            ))}
          </select>
          {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}
          <Btn
            onClick={doConnectLoopback}
            disabled={connecting || !selectedLoopbackDevice}
          >
            {connecting ? (
              <>
                <Spinner /> Connecting...
              </>
            ) : (
              '⟲ Connect (test)'
            )}
          </Btn>
        </>
      ) : tab === 'ip' ? (
        <>
          <div className={styles.ipRow}>
            <div className={styles.ipCol}>
              <div className={styles.fieldLabel}>IP ADDRESS</div>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className={styles.textInput}
              />
            </div>
            <div className={styles.portCol}>
              <div className={styles.fieldLabel}>PORT</div>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className={styles.textInput}
              />
            </div>
          </div>
          <div className={styles.ipRow}>
            <div className={styles.ipCol}>
              <div className={styles.fieldLabel}>TRANSPORT</div>
              <select
                value={protocol}
                onChange={(e) =>
                  setProtocol(e.target.value as 'udp' | 'tcp' | 'auto')
                }
                className={styles.textInput}
              >
                <option value="auto">Auto (TCP, falls back to UDP)</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </div>
          </div>
          {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}
          <Btn onClick={doConnect} disabled={connecting}>
            {connecting ? (
              <>
                <Spinner /> Connecting...
              </>
            ) : (
              '⟲ Connect'
            )}
          </Btn>
        </>
      ) : (
        <>
          <div className={styles.usbScanBtn}>
            <Btn onClick={scanUsb} disabled={usbLoading}>
              {usbLoading ? (
                <>
                  <Spinner /> Scanning...
                </>
              ) : (
                '⟲ Scan for USB devices'
              )}
            </Btn>
          </div>

          {usbDevices !== null && usbDevices.length === 0 && !usbLoading && (
            <div className={styles.noUsbMsg}>
              No KNX USB devices found. Make sure the device is plugged in and{' '}
              <code className={styles.codeBg}>node-hid</code> is installed.
            </div>
          )}

          {usbDevices && usbDevices.length > 0 && (
            <div className={styles.usbList}>
              <div className={styles.fieldLabel}>SELECT DEVICE</div>
              {usbDevices.map((d) => {
                const label =
                  d.knxName ||
                  [d.manufacturer, d.product].filter(Boolean).join(' ') ||
                  `USB ${d.vendorId?.toString(16)}:${d.productId?.toString(16)}`;
                const subtitle = d.knxName
                  ? [d.manufacturer, d.product].filter(Boolean).join(' ')
                  : '';
                const sel = selectedUsb === d.path;
                return (
                  <div
                    key={d.path}
                    onClick={() => setSelectedUsb(d.path)}
                    className={`${styles.usbDevice} ${sel ? styles.usbDeviceSelected : styles.usbDeviceUnselected}`}
                  >
                    <div
                      className={`${styles.usbDevLabel} ${sel ? styles.usbDevLabelSelected : styles.usbDevLabelUnselected}`}
                    >
                      {label}
                    </div>
                    {subtitle && (
                      <div className={styles.usbDevSub}>{subtitle}</div>
                    )}
                    {d.serialNumber && (
                      <div className={styles.usbDevSerial}>
                        SN: {d.serialNumber}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}
          {usbDevices && usbDevices.length > 0 && (
            <Btn onClick={doConnectUsb} disabled={connecting || !selectedUsb}>
              {connecting ? (
                <>
                  <Spinner /> Connecting...
                </>
              ) : (
                '⟲ Connect USB'
              )}
            </Btn>
          )}
        </>
      )}

      {!busStatus.hasLib && (
        <div className={`${styles.warningBox} ${styles.warningBorder}`}>
          &#x26A0; KNX package not installed. Run{' '}
          <code className={styles.warningCodeBg}>npm install knx</code> in the
          server directory.
        </div>
      )}
    </div>
  );
}
