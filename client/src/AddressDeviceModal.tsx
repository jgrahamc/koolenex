import { useState, useRef, useEffect } from 'react';
import { Btn, Spinner } from './primitives.tsx';
import { api } from './api.ts';
import {
  useProjectActions,
  useBusActions,
  useLiveData,
  useVerifyCache,
} from './contexts.ts';
import type { Device } from '../../shared/types.ts';
import styles from './AddressDeviceModal.module.css';

/**
 * Small inline "copy to clipboard" button, used next to a detected serial
 * (or address, when no serial is available) - real request, 2026-08-31:
 * "display the serial when we detect a device (in case it doesn't have an
 * address) and make serial copy'able." Falls back silently if the
 * Clipboard API is unavailable or denied (e.g. a non-HTTPS context) -
 * copying is a convenience, not worth surfacing an error over.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.copyBtn}
      title={`Copy ${text}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Nothing more to do - see doc comment above.
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Guided flow for writing a real KNX individual address onto a physical
 * device - either a device currently in programming mode (pressed once to
 * enter it, not held down) or one identified purely by its serial number.
 * Opened inline on
 * the Programming page (see ProgrammingView.tsx's "Address New Device"
 * button), not a separate view - the operator needs to see this alongside
 * the same device list/log they're already working from.
 *
 * Two real, independently-tested write mechanisms are available, and this
 * UI is deliberately upfront about which is which (see docs/knx-device-
 * write-protocol.md §9, koolenex repo):
 *  - programIA() (`api.busProgramIA`) - broadcasts the new address to
 *    whichever device is CURRENTLY holding its programming button. Real-
 *    hardware confirmed. Only safe when exactly one device answers a
 *    programming-mode scan - broadcasting to "whoever's listening" is
 *    inherently ambiguous with more than one.
 *  - assignIndividualAddressBySerial() (`api.busAssignAddressBySerial`) -
 *    targets one specific device by its serial number, no button-press
 *    needed, safe even with several devices in programming mode at once.
 *    Real-hardware confirmed (a device moved from its factory-default
 *    address to a real target address - see docs/knx-device-write-
 *    protocol.md §9.2).
 *
 * Matching a detected serial to a specific project device: an exact match
 * against the project's own recorded `serial_number` (imported from the
 * .knxproj, or set here by a previous real addressing run) is offered as
 * the default pick; the operator can always override via the dropdown.
 * There's no reliable device-type signal available from either detection
 * service (neither returns a mask/device-descriptor read), so this is the
 * strongest auto-match available without adding a further real-hardware-
 * unconfirmed read to the flow.
 */
export function AddressDeviceModal({
  devices: allDevices,
  initialDeviceId,
  initialTab,
  initialSerial,
  lockDevice,
  onClose,
  addLog,
}: {
  devices: Device[];
  // Pre-selects a specific device (the row the modal was opened from) in
  // both tabs' "ASSIGN TO" dropdowns, instead of leaving them blank/
  // auto-matched-by-serial only. Still changeable - opening from one row
  // doesn't prevent addressing a different device if the scan turns up
  // something else - UNLESS lockDevice is also set (see below).
  initialDeviceId?: number;
  // Opens directly on the given tab instead of always defaulting to
  // 'detect' - added 2026-08-30 for the serial icon's "already has a
  // known serial" case (ProgrammingView.tsx), which makes more sense to
  // open straight on the serial tab with that value pre-filled than to
  // make the operator re-scan/re-enter something already on record.
  initialTab?: 'detect' | 'serial';
  // Pre-fills the manual serial-entry field (serial tab only).
  initialSerial?: string;
  // The target device is already fully known (a real serial is already
  // recorded against it) - hides the "ASSIGN TO" picker entirely rather
  // than offering a choice that doesn't apply. Only meaningful together
  // with initialDeviceId.
  lockDevice?: boolean;
  onClose: () => void;
  addLog: (line: string) => void;
}) {
  const { updateDevice, unassignDevice, addScannedDevice } = useProjectActions();
  const { connect } = useBusActions();
  const { busStatus } = useLiveData();
  const { clearResult: clearVerifyResult } = useVerifyCache();
  const [tab, setTab] = useState<'detect' | 'serial'>(initialTab ?? 'detect');
  const [showAllDevices, setShowAllDevices] = useState(false);

  // A device with no real project address at all (has_address=0, a
  // synthetic placeholder - see ets-parser.ts) is never offered here.
  // Writing that placeholder onto a physical unit via programIA/
  // assignIndividualAddressBySerial would be as hazardous as letting
  // Program/Verify touch it - it needs a real address assigned first
  // (AssignProjectAddressModal), a separate, required prior step.
  const devices = allDevices.filter((d) => d.has_address);

  // Candidate pool for the "assign to" dropdown. `status` here is the
  // download/program status (see server/ets-parser.ts's deriveStatus), not
  // a dedicated "has this physical unit been addressed yet" field - this
  // app has no such field. Used as a proxy instead: a device can only ever
  // have been successfully Programmed or found Modified if a real unit
  // already answered at its planned individual_address, so 'unassigned'
  // (never downloaded) is a reasonable stand-in for "still needs a real
  // device addressed to it". showAllDevices overrides this for the real
  // edge case (a working device gets factory-reset again).
  const candidates = showAllDevices
    ? devices
    : devices.filter((d) => d.status === 'unassigned');

  // Broader candidate pool, general (unlocked) "Scan for New Device" flow
  // only - unlike `candidates` above, this DOES include has_address=0
  // devices ("not yet given a project address at all"). Safe here
  // specifically because this flow no longer writes anything to the bus
  // (see recordDetectedSerial() below) - it's bookkeeping-only, so the
  // has_address=0 hazard the comment above `devices` warns about (writing
  // a synthetic placeholder address to a physical unit) doesn't apply.
  // Real request, 2026-08-31: "allow the device to be added as if it were
  // a new unassigned device."
  const generalCandidates = showAllDevices
    ? allDevices
    : allDevices.filter((d) => d.status === 'unassigned' || !d.has_address);

  const matchBySerial = (serial: string): Device | null =>
    devices.find(
      (d) =>
        d.serial_number &&
        d.serial_number.toLowerCase() === serial.toLowerCase(),
    ) ?? null;

  // ── Detect tab (programming-mode scan) ──────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const [detected, setDetected] = useState<
    Array<{ serial: string; src: string }> | null
  >(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  // 'new' is a real, addressable choice, not just a device id - real
  // request, 2026-08-31 (general/unlocked flow only): "in the Assign To,
  // we should have an option (maybe first in the list) to add as New
  // Device (i.e. something not already in our DB)."
  const [detectSelection, setDetectSelection] = useState<
    Record<string, number | 'new' | ''>
  >({});
  const [detectBusy, setDetectBusy] = useState<Record<string, boolean>>({});
  const [detectResult, setDetectResult] = useState<
    Record<string, { ok: boolean; msg: string }>
  >({});

  // Real user request, 2026-08-31: "Detect should also auto-initiate a
  // connection if possible" - then, once a device write also came up
  // (about to fail outright with no connection at all): "please wire up
  // autoconnect to the write button (and in fact to all write buttons)."
  // Shared by every bus-write action below (scan/writeAddressDirect/
  // writeBySerial/writeDetected/writeManual). `busStatus` still carries
  // the last known host/port/type even while disconnected (see AppShell's
  // own connection badge) - reused here as "if possible": nothing to
  // auto-connect to if the bus has never been told a host at all (the
  // badge itself, or the standalone Bus Connection panel, is where that
  // first happens - this can't invent a host it was never given).
  const ensureBusConnected = async (): Promise<void> => {
    if (busStatus.connected) return;
    if (!busStatus.host) {
      throw new Error(
        'Not connected to the bus, and no previous connection to reuse - connect from the status badge first.',
      );
    }
    addLog(
      `[${new Date().toLocaleTimeString()}] Connecting to ${busStatus.host}…`,
    );
    await connect(
      busStatus.host,
      busStatus.port ?? 3671,
      (busStatus.type as 'udp' | 'tcp' | 'auto' | undefined) ?? 'auto',
    );
    addLog(`[${new Date().toLocaleTimeString()}] Connected`);
  };

  // Status indicator specifically for the scan's own "press the button
  // now" reminder - real user request, 2026-08-31: "when it is clicked,
  // and connection made, it should show a status indicator reminding the
  // user to press prog on their device."
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setDetectError(null);
    setDetected(null);
    setScanStatus(null);
    try {
      await ensureBusConnected();
      setScanStatus('Press the programming button on the device now…');
      addLog(`[${new Date().toLocaleTimeString()}] Scanning for devices in programming mode…`);
      // Real live-test finding, 2026-08-31: "our Scan for New Device
      // functionality does not seem to pick up our device in prog mode" -
      // this only ever tried the serial-number scan
      // (A_SystemNetworkParameter_Read), which gets zero replies from a
      // non-Albrecht-Jung device (HDL) even with the button genuinely
      // held - see writeAddressDirect()'s own dual-mechanism fix, same
      // day, for the full real-hardware finding. Applying the same fix
      // here: run both broadcasts concurrently in short (3s) rounds,
      // exiting as soon as either reports at least one device, for up to
      // 30s total. A device found ONLY via the legacy address broadcast
      // has no real serial - `serial: ''` marks that case; every
      // dictionary below is keyed by `src` (the address, always real and
      // unique) rather than `serial` (which can't be, when empty) - see
      // the render blocks' own comments.
      const roundMs = 3000;
      const deadline = Date.now() + 30000;
      const bySrc = new Map<string, string>(); // src -> serial ('' if unknown)
      while (bySrc.size === 0 && Date.now() < deadline) {
        const thisRound = Math.min(roundMs, Math.max(deadline - Date.now(), 100));
        const [serialScan, addrCheck] = await Promise.all([
          api.busReadSerialsInProgrammingMode(thisRound),
          api.busCheckProgrammingMode(thisRound),
        ]);
        for (const d of serialScan.devices) bySrc.set(d.src, d.serial);
        if (addrCheck.address && !bySrc.has(addrCheck.address)) {
          bySrc.set(addrCheck.address, '');
        }
      }
      // Real user question, 2026-08-31: "how does ETS grab the serial -
      // after assigning an address?" - checked against our own real
      // capture (docs/knx-device-write-protocol.md §9.3): ETS does NOT
      // need to assign a NEW address first. It connects point-to-point to
      // the device's CURRENT address (found via the same classic broadcast
      // used above) and reads Property 11 (PID_SERIAL_NUMBER-family,
      // Object Index 0) via a real PropertyValue_Read - the exact same
      // mechanism `busDeviceInfo()` already uses (confirmed working
      // earlier the same session, reading this device's real serial right
      // after an address write). Mirrored here for any device found only
      // via the legacy broadcast (no serial from either broadcast
      // mechanism itself): a best-effort point-to-point follow-up read,
      // same as ETS's own real sequence. Failure is expected/non-fatal for
      // a device this doesn't work against - left blank, same as before.
      for (const [src, serial] of [...bySrc.entries()]) {
        if (serial) continue;
        try {
          addLog(
            `[${new Date().toLocaleTimeString()}] Reading serial from ${src} (point-to-point, same as ETS)…`,
          );
          const info = await api.busDeviceInfo(src);
          const found = (info as { serialNumber?: string }).serialNumber;
          if (found) {
            bySrc.set(src, found);
            addLog(
              `[${new Date().toLocaleTimeString()}] Read serial ${found} from ${src}`,
            );
          }
        } catch (e: any) {
          addLog(
            `[${new Date().toLocaleTimeString()}] Could not read serial from ${src} → ${e.message}`,
          );
        }
      }
      const devicesFound = [...bySrc.entries()].map(([src, serial]) => ({
        serial,
        src,
      }));
      setDetected(devicesFound);
      const sel: Record<string, number | ''> = {};
      for (const d of devicesFound) {
        const m = d.serial ? matchBySerial(d.serial) : null;
        sel[d.src] = m ? m.id : (initialDeviceId ?? '');
      }
      setDetectSelection(sel);
      addLog(
        `[${new Date().toLocaleTimeString()}] Scan complete — ${devicesFound.length} device(s) found in programming mode`,
      );
    } catch (e: any) {
      setDetectError(e.message);
    }
    setScanStatus(null);
    setScanning(false);
  };

  // General (unlocked) "Scan for New Device" flow's only action, replacing
  // the earlier write-via-broadcast/write-by-serial buttons entirely - real
  // request, 2026-08-31: "the Write Address buttons here shouldn't be
  // present as we don't have an address editor. Remove the buttons
  // entirely, and allow the device to be added as if it were a new
  // unassigned device." This flow was never the right place for a real
  // bus write anyway (no visible confirmation of exactly which address is
  // about to be written, unlike the locked single-device flow's own
  // Device Address tab) - it's bookkeeping-only now, same idea as
  // confirmSerial() below but for the general flow: record the detected
  // serial against whichever project device the operator picks (including
  // one with no project address at all yet - see generalCandidates above),
  // no bus write. Keyed by `src` throughout, same reasoning as before.
  //
  // A 'new' selection (see detectSelection's own comment) creates a real
  // project device first, using the address this scan already knows
  // (d.src is the device's real, live-reported address - reusing
  // addScannedDevice(), the same action BusScanView.tsx's own "add a
  // device found by address scan" flow already uses), then records the
  // serial on it too if one is known. Unlike recording onto an EXISTING
  // device, creating one is worth doing even with no serial at all - at
  // minimum the address gets captured, which is the real point of "add as
  // if it were a new unassigned device".
  const recordDetectedSerial = async (src: string, serial: string) => {
    const selection = detectSelection[src];
    if (!selection) return;
    setDetectBusy((b) => ({ ...b, [src]: true }));
    setDetectResult((r) => {
      const next = { ...r };
      delete next[src];
      return next;
    });
    try {
      if (selection === 'new') {
        const created = await addScannedDevice(src);
        addLog(
          `[${new Date().toLocaleTimeString()}] Added new device at ${src}`,
        );
        if (serial) {
          await updateDevice(created.id, { serial_number: serial });
          addLog(
            `[${new Date().toLocaleTimeString()}] Recorded serial ${serial} on ${src}`,
          );
        }
        setDetectResult((r) => ({
          ...r,
          [src]: {
            ok: true,
            msg: serial
              ? `✓ Added as a new device, serial recorded`
              : `✓ Added as a new device`,
          },
        }));
      } else {
        const target = allDevices.find((d) => d.id === selection);
        if (!target || !serial) return;
        await updateDevice(target.id, { serial_number: serial });
        setDetectResult((r) => ({
          ...r,
          [src]: { ok: true, msg: `✓ Recorded on ${target.name}` },
        }));
        addLog(
          `[${new Date().toLocaleTimeString()}] Recorded serial ${serial} on ${target.name}`,
        );
      }
    } catch (e: any) {
      setDetectResult((r) => ({ ...r, [src]: { ok: false, msg: e.message } }));
      addLog(
        `[${new Date().toLocaleTimeString()}] Recording failed → ${e.message}`,
      );
    }
    setDetectBusy((b) => ({ ...b, [src]: false }));
  };

  // ── lockDevice-only: confirm a detected serial with no bus write ────────
  // Real request 2026-08-31: when the modal was opened for a specific,
  // already-addressed device, a scan that finds it already reporting the
  // EXPECTED address has nothing to write - programIA/assignAddressBySerial
  // would just be re-asserting an address the device already has. This
  // just records the serial (`updateDevice`), the same bookkeeping every
  // real write already does at the end, without touching the bus at all.
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmSerial = async (serial: string) => {
    if (!lockedTarget) return;
    setConfirmBusy(true);
    try {
      await updateDevice(lockedTarget.id, { serial_number: serial });
      addLog(
        `[${new Date().toLocaleTimeString()}] Confirmed serial ${serial} for ${lockedTarget.individual_address}`,
      );
    } catch (e: any) {
      addLog(
        `[${new Date().toLocaleTimeString()}] Confirming serial failed → ${e.message}`,
      );
    }
    setConfirmBusy(false);
  };

  // ── Serial-entry tab ─────────────────────────────────────────────────────
  const [manualSerial, setManualSerial] = useState(initialSerial ?? '');
  const [manualDeviceId, setManualDeviceId] = useState<number | ''>(
    initialDeviceId ?? '',
  );
  const [manualBusy, setManualBusy] = useState(false);
  const [manualResult, setManualResult] = useState<
    { ok: boolean; msg: string } | null
  >(null);

  const manualSerialValid = /^[0-9a-fA-F]{12}$/.test(manualSerial);
  const manualMatch = manualSerialValid ? matchBySerial(manualSerial) : null;
  // Resolved from allDevices, not the has_address-filtered `devices` above
  // - real request 2026-08-31: opening this modal from the serial icon of
  // an unaddressed device (has_address=0) was inconsistent, popping the
  // "assign a project address" modal instead of this one. A locked target
  // can legitimately have no real address yet; what changes is which
  // actions are offered below (lockedNoAddress), not whether the target
  // itself can be found.
  const lockedTarget = lockDevice
    ? (allDevices.find((d) => d.id === initialDeviceId) ?? null)
    : null;

  // Real bug, live-tested 2026-08-31: manualSerial only ever seeded once
  // from initialSerial at mount (a snapshot of lockedTarget.serial_number
  // taken when the modal opened) - a real address+serial write completing
  // WHILE the modal stayed open (e.g. via Write Address on the other tab)
  // never touched this box again, so it kept showing whatever it had at
  // mount (often blank) even after the project record itself was updated.
  // That produced a spurious "Serial must be exactly 12 hex characters"
  // warning on a perfectly valid just-recorded serial - the box was stale,
  // not the data. Resync whenever the locked device's own recorded serial
  // changes. Scoped to the lockDevice case only - in the general
  // (non-locked) flow below, this same input is a genuine blank-slate
  // manual entry field (optionally pre-filled once via initialSerial),
  // with no single "locked" device whose own recorded serial it should
  // ever be forced to track.
  useEffect(() => {
    if (!lockDevice) return;
    setManualSerial(lockedTarget?.serial_number ?? '');
  }, [lockDevice, lockedTarget?.serial_number]);

  // No real address to write to at all - only serial CAPTURE is safe here
  // (updateDevice, no bus write), same reasoning as the has_address guard
  // on `devices` above: writing to a synthetic placeholder address would
  // be hazardous, so no write path is offered for this case at all, not
  // even the normally-safe programIA/assignAddressBySerial ones.
  const lockedNoAddress = !!lockedTarget && !lockedTarget.has_address;

  // ── Project address editing, folded into this modal 2026-08-31 ──────────
  // Previously a separate popup (AssignProjectAddressModal), opened only
  // from the "-.-.-" placeholder badge for a not-yet-addressed device -
  // real user feedback: "clicking the address takes me to the device info
  // page, nowhere to edit/change the address again" (once has_address was
  // true, there was no way back into that modal at all) and "address write
  // in serial box doesn't make sense, unless we have address edit there
  // too... let's combine address edit and serial edit into the one
  // popup." Folded in here instead of kept separate - this section covers
  // both the original "assign for the first time" case and a genuinely
  // new "edit/reassign later" capability.
  const REAL_MAX = 15;
  const [addrEditing, setAddrEditing] = useState(lockedNoAddress);
  const suggestAddr = (): { a: number; l: number; n: number } => {
    const a =
      lockedTarget && lockedTarget.area <= REAL_MAX ? lockedTarget.area : 1;
    const l =
      lockedTarget && lockedTarget.line <= REAL_MAX ? lockedTarget.line : 1;
    const used = new Set(
      allDevices
        .filter(
          (d) =>
            d.id !== lockedTarget?.id &&
            d.has_address &&
            d.area === a &&
            d.line === l,
        )
        .map((d) => Number(d.individual_address.split('.')[2]))
        .filter((n) => Number.isFinite(n)),
    );
    let n = 1;
    while (used.has(n) && n <= 255) n++;
    return { a, l, n };
  };
  // Two tabs for the lockDevice layout - real user feedback, 2026-08-31,
  // on the first single-scroll merged version: "our popup for address/
  // serial change is looking a bit convoluted. Please make two tabs - one
  // for device address and one for serial number." Defaults to the
  // 'serial' tab when opened via the serial icon on a device with an
  // already-known serial (matches the old initialTab behavior - jumping
  // straight to the thing you're most likely here to re-confirm), 'address'
  // otherwise (including lockedNoAddress, where the address form itself
  // still needs to be filled in first).
  const [deviceTab, setDeviceTab] = useState<'address' | 'serial'>(
    initialTab === 'serial' ? 'serial' : 'address',
  );
  const initialAddr = lockedTarget?.has_address
    ? {
        a: Number(lockedTarget.individual_address.split('.')[0]),
        l: Number(lockedTarget.individual_address.split('.')[1]),
        n: Number(lockedTarget.individual_address.split('.')[2]),
      }
    : suggestAddr();
  const [addrArea, setAddrArea] = useState(initialAddr.a);
  const [addrLine, setAddrLine] = useState(initialAddr.l);
  const [addrDevNum, setAddrDevNum] = useState(initialAddr.n);
  const [addrBusy, setAddrBusy] = useState(false);
  const [addrError, setAddrError] = useState<string | null>(null);
  const newAddr = `${addrArea}.${addrLine}.${addrDevNum}`;
  const addrConflict = allDevices.find(
    (d) => d.id !== lockedTarget?.id && d.has_address && d.individual_address === newAddr,
  );
  const addrUnchanged =
    !!lockedTarget?.has_address && lockedTarget.individual_address === newAddr;

  const saveAddr = async () => {
    if (!lockedTarget || addrConflict || addrUnchanged) return;
    setAddrBusy(true);
    setAddrError(null);
    try {
      await updateDevice(lockedTarget.id, { individual_address: newAddr });
      addLog(
        `[${new Date().toLocaleTimeString()}] Assigned project address ${newAddr} to ${lockedTarget.name}`,
      );
      setAddrEditing(false);
    } catch (e: any) {
      setAddrError(e.message || 'Failed to assign address');
    }
    setAddrBusy(false);
  };

  // Refuses on a device with a physically-confirmed serial - matches the
  // server's own guard (server/routes/devices.ts) - surfaced here as a
  // disabled button with an explanatory title rather than letting the
  // request round-trip just to fail.
  const [unassignBusy, setUnassignBusy] = useState(false);
  const doUnassign = async () => {
    if (!lockedTarget) return;
    setUnassignBusy(true);
    try {
      await unassignDevice(lockedTarget.id);
      // A cached verify result describes a PRIOR commissioning of this
      // device identity - unassigning means we no longer stand behind
      // that (see ProgrammingView's own status==='unassigned' gate on the
      // Verify button) - drop it so a later re-address doesn't leave a
      // stale "Re-verify" label/result sitting around for what's now, as
      // far as the project is concerned, a device waiting to be
      // recommissioned.
      clearVerifyResult(lockedTarget.id);
      addLog(
        `[${new Date().toLocaleTimeString()}] Unassigned project address for ${lockedTarget.name}`,
      );
    } catch (e: any) {
      setAddrError(e.message || 'Failed to unassign');
    }
    setUnassignBusy(false);
  };

  // Direct broadcast write of the CURRENT project address, no serial
  // needed - moved onto the Device Address tab itself, 2026-08-31: "Put
  // the Write Address button below this [the address display/edit]." The
  // serial-based write (busAssignAddressBySerial) stays on the Serial tab
  // below, since it inherently needs a serial to target by.
  const [writeAddrBusy, setWriteAddrBusy] = useState(false);
  const [writeAddrResult, setWriteAddrResult] = useState<
    { ok: boolean; msg: string } | null
  >(null);
  // Status line for the detect-first flow below - mirrors scanStatus's
  // "press the button now" pattern, but scoped to this button since scan()
  // and writeAddressDirect() are independent flows that can each be
  // mid-run at the same time (different tabs).
  const [writeAddrStatus, setWriteAddrStatus] = useState<string | null>(null);
  // True only while actively waiting on the programming-mode scan (i.e. a
  // real cancel window) - false once the scan has resolved and the actual
  // address write is in flight, where cancelling would no longer mean
  // anything. Drives the Write Address button's real user request,
  // 2026-08-31: "The cancel can be the write button itself."
  const [writeAddrWaiting, setWriteAddrWaiting] = useState(false);
  const writeAddrAbortRef = useRef<AbortController | null>(null);
  // Real user finding, 2026-08-31: "It is showing a tick but I did not
  // press the prog button" + "how is it writing to the device if I
  // haven't pressed the prog button? i.e. how does it know which device?"
  // - programIA()/A_IndividualAddress_Write is a fire-and-forget broadcast
  // to 0/0/0 with no device identifier in the frame at all - it's accepted
  // by whichever single device physically has its button held, and there
  // was previously NOTHING in this flow that told the operator to press it
  // before firing the write, or that confirmed a device was actually
  // listening first. Real follow-up: "FYI, there was no notification that
  // prog button press is required." Fixed by reusing the same
  // busReadSerialsInProgrammingMode() scan the Serial tab's Detect button
  // already uses (real-hardware confirmed there) as a mandatory
  // detect-before-write gate: (a) tell the operator to press the button,
  // (b) wait for the scan and see who answers, (c) refuse to proceed
  // unless EXACTLY one device answers (zero = nothing pressed / didn't
  // register; more than one = genuinely ambiguous, the broadcast has no
  // way to pick between them), (d) only then send the write. Every step
  // logged, per explicit request ("each step should go into log").
  //
  // Real live-test finding, same day: the original 3s window was much too
  // short - "this needs to be at least 30 seconds or more as it will take
  // time for people to go to the device to set prog mode" - raised to
  // 30000ms (the server route's own hard cap, server/routes/bus.ts). A
  // long wait needs a real way out, so it's paired with an AbortController
  // wired to the button itself (see writeAddrWaiting/cancelWriteAddress).
  const writeAddressDirect = async () => {
    if (!lockedTarget?.has_address) return;
    // Real bug, live-tested 2026-08-31: "I change the address to 1.1.21 in
    // the UI selectors, but did NOT click Save to the project, and instead
    // directly clicked Write. This then wrote the old address, 1.1.20." -
    // this write path used lockedTarget.individual_address (the last SAVED
    // project value) throughout, ignoring newAddr (the live selector
    // value) entirely unless Save had already been clicked first. Fixed:
    // write whatever the selectors currently show, and persist that same
    // value to the project automatically on a confirmed write (see the
    // updateDevice call below) - the operator's real request, not just a
    // bug fix: "We need to write whatever is in the selectors AND
    // automatically update the project DB with this value as soon as we
    // write."
    if (addrConflict) {
      setWriteAddrResult({
        ok: false,
        msg: `⚠ ${newAddr} is already assigned to ${addrConflict.name} in this project — resolve the conflict before writing.`,
      });
      return;
    }
    setWriteAddrBusy(true);
    setWriteAddrResult(null);
    setWriteAddrStatus(null);
    const controller = new AbortController();
    writeAddrAbortRef.current = controller;
    try {
      await ensureBusConnected();
      setWriteAddrStatus('Press the programming button on the device now…');
      setWriteAddrWaiting(true);
      addLog(
        `[${new Date().toLocaleTimeString()}] Waiting for a device in programming mode before writing ${newAddr}…`,
      );
      // Real live-test finding, 2026-08-31: on a non-Albrecht-Jung device
      // (HDL M/AG40B.1), the serial-number scan alone (A_SystemNetworkParameter_
      // Read, PID_SERIAL_NUMBER) got zero responses even with the physical
      // button genuinely held/pressed - cross-checked against a real ETS
      // capture taken against this exact device the same day, which shows
      // ETS itself using the older, more universally-supported
      // A_IndividualAddress_Read broadcast instead (checkProgrammingMode()
      // below) for this manufacturer. Running both concurrently and
      // merging by responding address covers both cases without slowing
      // down the devices that do answer the serial scan (Albrecht Jung,
      // real-hardware confirmed there).
      //
      // Real live-test finding, same day, after the above: a single
      // Promise.all([...30000ms calls]) took the FULL 30s to resolve even
      // when the device answered within a few seconds - readSerialsInProgrammingMode
      // deliberately never resolves early (it collects for its whole
      // window, by design, to catch multiple simultaneous devices), so
      // Promise.all was always blocked on whichever of the two calls
      // didn't get a match, however fast the other one was. Real ETS
      // itself (per capture) reacts within a few seconds of a real press.
      // Fixed by polling in short (3s) rounds instead of one long call,
      // exiting the loop the instant either mechanism reports a device,
      // while still allowing up to 30s total for someone to physically
      // reach the device and press its button.
      const roundMs = 3000;
      const deadline = Date.now() + 30000;
      const byAddress = new Map<string, string | null>(); // address -> serial (null if unknown)
      let sawAnySerialReply = false;
      while (byAddress.size === 0 && Date.now() < deadline) {
        const thisRound = Math.min(roundMs, Math.max(deadline - Date.now(), 100));
        const [serialScan, addrCheck] = await Promise.all([
          api.busReadSerialsInProgrammingMode(thisRound, controller.signal),
          api.busCheckProgrammingMode(thisRound, controller.signal),
        ]);
        if (serialScan.devices.length > 0) sawAnySerialReply = true;
        for (const d of serialScan.devices) byAddress.set(d.src, d.serial);
        if (addrCheck.address && !byAddress.has(addrCheck.address)) {
          byAddress.set(addrCheck.address, null);
        }
      }
      setWriteAddrWaiting(false);
      addLog(
        `[${new Date().toLocaleTimeString()}] Scan complete — ${byAddress.size} device(s) found in programming mode` +
          (byAddress.size > 0 && !sawAnySerialReply
            ? ' (via legacy address broadcast — no serial available)'
            : ''),
      );
      if (byAddress.size === 0) {
        setWriteAddrStatus(null);
        setWriteAddrResult({
          ok: false,
          msg: '⚠ No device detected in programming mode — press and release the programming button on the target device, then try again.',
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Write aborted — no device answered either programming-mode scan`,
        );
        setWriteAddrBusy(false);
        return;
      }
      if (byAddress.size > 1) {
        const ids = [...byAddress.entries()]
          .map(([addr, serial]) => (serial ? `${serial} @ ${addr}` : addr))
          .join(', ');
        setWriteAddrStatus(null);
        setWriteAddrResult({
          ok: false,
          msg: `⚠ ${byAddress.size} devices are in programming mode at once (${ids}) — this write is ambiguous. Press the button on only the one device you mean to address, then try again.`,
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Write aborted — ${byAddress.size} devices answered at once (${ids}), refusing to guess`,
        );
        setWriteAddrBusy(false);
        return;
      }
      const [detectedAddr, detectedSerial] = [...byAddress.entries()][0]!;
      setWriteAddrStatus(null);
      addLog(
        `[${new Date().toLocaleTimeString()}] Identified device ${detectedSerial ?? detectedAddr} in programming mode — writing address ${newAddr}…`,
      );
      const r = await api.busProgramIA(newAddr);
      // Real user finding, 2026-08-31: a green checkmark showed up even
      // though the programming button was never pressed. Root cause:
      // A_IndividualAddress_Write is a fire-and-forget broadcast with NO
      // application-layer response at all (matches real ETS's own blind
      // spot for this exact service) - busProgramIA() resolving without
      // throwing only means the frame was sent, never that any device
      // received or acted on it. Treating "no exception" as "success" was
      // simply wrong for a service that structurally cannot confirm
      // itself. The read-back below (originally added just to grab the
      // serial - "Did it also grab the serial at the same time? If not it
      // should do") is now the ONLY thing this result is allowed to call
      // success: a real point-to-point read of the target address,
      // succeeding only if a real device is actually there to answer.
      let serialMsg = '';
      let confirmed = false;
      try {
        const info = await api.busDeviceInfo(newAddr);
        confirmed = true;
        const serial = (info as { serialNumber?: string }).serialNumber;
        // Persist the address that was actually written - not just the
        // serial - the moment it's confirmed, per the real request above.
        // serial_number is included in the SAME call deliberately: the
        // server clears serial_number whenever individual_address changes
        // unless the caller also supplies a new one in that request
        // (server/routes/devices.ts) - carrying forward the freshly-read
        // (or, failing that, previously-known) serial here avoids that
        // guard wiping out exactly the value this write just confirmed.
        await updateDevice(lockedTarget.id, {
          individual_address: newAddr,
          serial_number: serial ?? lockedTarget.serial_number ?? '',
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Project address updated to ${newAddr}`,
        );
        if (serial) {
          serialMsg = `, serial ${serial} recorded`;
          addLog(
            `[${new Date().toLocaleTimeString()}] Read back serial ${serial} from ${newAddr}`,
          );
        }
      } catch (e: any) {
        addLog(
          `[${new Date().toLocaleTimeString()}] No device answered at ${newAddr} after the write → ${e.message}`,
        );
      }
      if (confirmed) {
        setWriteAddrResult({
          ok: true,
          msg: r.restarted
            ? `✓ Confirmed — device now responds at ${newAddr}${serialMsg}`
            : `✓ Confirmed — device now responds at ${newAddr}${serialMsg} (restart itself may not have completed)`,
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Confirmed device at ${newAddr}`,
        );
      } else {
        setWriteAddrResult({
          ok: false,
          msg: `⚠ Write sent, but no device answered at ${newAddr} afterward — was the programming button actually pressed? This broadcast write has no confirmation of its own.`,
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Could not confirm any device at ${newAddr} after the write`,
        );
      }
    } catch (e: any) {
      setWriteAddrStatus(null);
      setWriteAddrWaiting(false);
      if (e.code === 'aborted') {
        setWriteAddrResult({
          ok: false,
          msg: 'Cancelled — no address was written.',
        });
        addLog(
          `[${new Date().toLocaleTimeString()}] Cancelled — no address was written`,
        );
      } else {
        setWriteAddrResult({ ok: false, msg: e.message });
        addLog(
          `[${new Date().toLocaleTimeString()}] Address write failed → ${e.message}`,
        );
      }
    }
    writeAddrAbortRef.current = null;
    setWriteAddrBusy(false);
  };

  // Aborts the in-flight programming-mode wait, wired to the same button
  // that started it - real user request, 2026-08-31: "The cancel can be
  // the write button itself."
  const cancelWriteAddress = () => {
    writeAddrAbortRef.current?.abort();
  };

  // Plain bookkeeping - clears a recorded serial with no bus interaction
  // at all, distinct from confirmSerial (records one) - real user request,
  // 2026-08-31: "a button next to the serial number, which allows us to
  // clear any existing number from the DB."
  const [clearSerialBusy, setClearSerialBusy] = useState(false);
  const clearSerial = async () => {
    if (!lockedTarget?.serial_number) return;
    setClearSerialBusy(true);
    try {
      await updateDevice(lockedTarget.id, { serial_number: '' });
      addLog(
        `[${new Date().toLocaleTimeString()}] Cleared recorded serial for ${lockedTarget.name}`,
      );
    } catch (e: any) {
      addLog(
        `[${new Date().toLocaleTimeString()}] Failed to clear serial → ${e.message}`,
      );
    }
    setClearSerialBusy(false);
  };

  // Write-by-serial, using whatever serial is currently recorded (edited
  // on the Serial tab) - moved here from the Serial tab, 2026-08-31: "The
  // Write Address button should not show on the serials tab at all, as it
  // is unrelated" - both real write mechanisms (button-press above, and
  // this one) now live together on the Device Address tab; the Serial tab
  // is pure bookkeeping only (view/detect/clear).
  const [writeBySerialBusy, setWriteBySerialBusy] = useState(false);
  const [writeBySerialResult, setWriteBySerialResult] = useState<
    { ok: boolean; msg: string } | null
  >(null);
  // Same real bug/fix as writeAddressDirect() above, 2026-08-31: this used
  // lockedTarget.individual_address (the last SAVED project value)
  // regardless of unsaved edits sitting in the address selectors - fixed
  // to write newAddr (the live selector value) and persist it to the
  // project automatically once the write is verified.
  const writeBySerial = async () => {
    if (!lockedTarget?.has_address || !lockedTarget?.serial_number) return;
    if (addrConflict) {
      setWriteBySerialResult({
        ok: false,
        msg: `⚠ ${newAddr} is already assigned to ${addrConflict.name} in this project — resolve the conflict before writing.`,
      });
      return;
    }
    setWriteBySerialBusy(true);
    setWriteBySerialResult(null);
    addLog(
      `[${new Date().toLocaleTimeString()}] Writing (by serial) ${lockedTarget.serial_number} → ${newAddr}`,
    );
    try {
      await ensureBusConnected();
      const r = await api.busAssignAddressBySerial(
        lockedTarget.serial_number,
        newAddr,
      );
      if (!r.verified) {
        throw new Error(
          r.address
            ? `Device reported ${r.address}, not ${newAddr}`
            : 'No read-back confirmation from the device',
        );
      }
      // Persist the address that was actually verified written - serial_
      // number is resupplied in the same call to avoid the server's
      // clear-serial-on-address-change guard wiping it (server/routes/
      // devices.ts) - see writeAddressDirect()'s own doc comment above.
      await updateDevice(lockedTarget.id, {
        individual_address: newAddr,
        serial_number: lockedTarget.serial_number,
      });
      setWriteBySerialResult({
        ok: true,
        msg: `✓ Address written to ${newAddr}`,
      });
      addLog(
        `[${new Date().toLocaleTimeString()}] Address ${newAddr} written and project updated`,
      );
    } catch (e: any) {
      setWriteBySerialResult({ ok: false, msg: e.message });
      addLog(
        `[${new Date().toLocaleTimeString()}] Address write failed → ${e.message}`,
      );
    }
    setWriteBySerialBusy(false);
  };

  const manualTarget = devices.find(
    (d) => d.id === (manualDeviceId || manualMatch?.id),
  );
  // Nothing to write - the entered serial already matches what's on
  // record for this device (real request 2026-08-31: don't offer a write
  // that would just be re-recording the same value).
  const manualNoChange =
    !!manualTarget &&
    !!manualTarget.serial_number &&
    manualTarget.serial_number.toLowerCase() === manualSerial.toLowerCase();

  const writeManual = async () => {
    const deviceId = manualDeviceId || manualMatch?.id;
    const target = devices.find((d) => d.id === deviceId);
    if (!target || !manualSerialValid) return;
    setManualBusy(true);
    setManualResult(null);
    addLog(
      `[${new Date().toLocaleTimeString()}] Addressing (by serial) ${manualSerial} → ${target.individual_address} (${target.name})`,
    );
    try {
      await ensureBusConnected();
      const r = await api.busAssignAddressBySerial(
        manualSerial,
        target.individual_address,
      );
      if (!r.verified) {
        throw new Error(
          r.address
            ? `Device reported ${r.address}, not ${target.individual_address}`
            : 'No read-back confirmation from the device',
        );
      }
      await updateDevice(target.id, { serial_number: manualSerial });
      setManualResult({ ok: true, msg: `✓ Addressed as ${target.individual_address}` });
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressed ${manualSerial} → ${target.individual_address}`,
      );
    } catch (e: any) {
      setManualResult({ ok: false, msg: e.message });
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressing failed → ${manualSerial} — ${e.message}`,
      );
    }
    setManualBusy(false);
  };

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>
            {lockDevice
              ? lockedNoAddress
                ? 'Capture Device Serial Number'
                : 'Edit/Update Device Serial Number'
              : 'Address New Device'}
          </span>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.intro}>
            {lockDevice ? (
              lockedNoAddress ? (
                <>
                  Capture this device's serial number, either by pressing
                  its programming button to detect it, or by entering the
                  serial directly. No project address is assigned yet, so
                  nothing is written to the device - it just records the
                  serial.
                </>
              ) : (
                <>
                  Re-confirm or update the recorded serial number for this
                  device, either by pressing its programming button to
                  detect it, or by entering the serial directly.
                </>
              )
            ) : (
              <>
                Write a real KNX individual address onto a physical device,
                either by pressing its programming button to detect it, or by
                entering its serial number directly.
              </>
            )}
          </div>

          {lockDevice ? (
            // ── Known-device layout, split into two tabs 2026-08-31 (real
            // user feedback: "our popup for address/serial change is
            // looking a bit convoluted. Please make two tabs - one for
            // device address and one for serial number.") - no candidate
            // picker in either tab, the target is already fixed
            // (lockedTarget).
            <>
              <div className={styles.tabRow}>
                <button
                  className={`${styles.tabBtn} ${deviceTab === 'address' ? styles.tabBtnActive : ''}`}
                  onClick={() => setDeviceTab('address')}
                >
                  Device Address
                </button>
                <button
                  className={`${styles.tabBtn} ${deviceTab === 'serial' ? styles.tabBtnActive : ''}`}
                  onClick={() => setDeviceTab('serial')}
                >
                  Serial Number
                </button>
              </div>

              {deviceTab === 'address' ? (
                <>
                  {addrEditing ? (
                    <>
                      <div className={styles.row}>
                        <div className={styles.col}>
                          <div className={styles.fieldLabel}>AREA</div>
                          <input
                            type="number"
                            min={0}
                            max={15}
                            className={styles.textInput}
                            value={addrArea}
                            onChange={(e) => setAddrArea(Number(e.target.value) || 0)}
                          />
                        </div>
                        <div className={styles.col}>
                          <div className={styles.fieldLabel}>LINE</div>
                          <input
                            type="number"
                            min={0}
                            max={15}
                            className={styles.textInput}
                            value={addrLine}
                            onChange={(e) => setAddrLine(Number(e.target.value) || 0)}
                          />
                        </div>
                        <div className={styles.col}>
                          <div className={styles.fieldLabel}>DEVICE</div>
                          <input
                            type="number"
                            min={0}
                            max={255}
                            className={styles.textInput}
                            value={addrDevNum}
                            onChange={(e) => setAddrDevNum(Number(e.target.value) || 0)}
                          />
                        </div>
                      </div>
                      {addrConflict && (
                        <div className={styles.errorMsg}>
                          &#x2717; {newAddr} is already used by {addrConflict.name}
                        </div>
                      )}
                      {addrError && (
                        <div className={styles.errorMsg}>&#x2717; {addrError}</div>
                      )}
                      {/* Real user note, 2026-08-31: "the save button on
                          editing the device address may be confusing.
                          People may not recognise the distinction between
                          saving locally and writing to device." */}
                      <div className={styles.emptyState}>
                        Saving only updates the project's planned address -
                        it does not write anything to the physical device.
                        Use ⚡ Write Address below for that.
                      </div>
                      <div className={styles.row}>
                        <Btn
                          onClick={saveAddr}
                          disabled={addrBusy || !!addrConflict || addrUnchanged}
                          title="Saves the planned address to the project only - does not write to the physical device"
                        >
                          {addrBusy ? <Spinner /> : `Save ${newAddr} (Project Only)`}
                        </Btn>
                        {!!lockedTarget?.has_address && (
                          <Btn
                            onClick={() => setAddrEditing(false)}
                            color="var(--dim)"
                            disabled={addrBusy}
                          >
                            Cancel
                          </Btn>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className={styles.row}>
                      <div className={styles.matchedTag}>
                        DEVICE ADDRESS: {lockedTarget?.individual_address}
                      </div>
                      <Btn onClick={() => setAddrEditing(true)} color="var(--dim)">
                        Edit
                      </Btn>
                      <Btn
                        onClick={doUnassign}
                        disabled={unassignBusy || !!lockedTarget?.serial_number}
                        color="var(--red)"
                        title={
                          lockedTarget?.serial_number
                            ? 'This device has a physically-confirmed serial at this address - clear the serial number above first, then unassign'
                            : 'Revert to no project address'
                        }
                      >
                        {unassignBusy ? <Spinner /> : 'Unassign'}
                      </Btn>
                    </div>
                  )}

                  <div className={styles.row}>
                    <Btn
                      onClick={
                        writeAddrWaiting ? cancelWriteAddress : writeAddressDirect
                      }
                      disabled={
                        (writeAddrBusy && !writeAddrWaiting) ||
                        !lockedTarget?.has_address
                      }
                      color={writeAddrWaiting ? 'var(--red)' : undefined}
                      title={
                        writeAddrWaiting
                          ? 'Cancel — stop waiting for a device in programming mode'
                          : lockedTarget?.has_address
                            ? `Write ${newAddr} via the programming-mode broadcast — press the physical programming button on the device first, real-hardware confirmed. Writes whatever is shown in the address fields above, saved or not, and updates the project automatically once confirmed.`
                            : 'Save a project address above first'
                      }
                    >
                      {writeAddrWaiting ? (
                        'Cancel'
                      ) : writeAddrBusy ? (
                        <>
                          <Spinner /> Writing…
                        </>
                      ) : (
                        `⚡ Write ${newAddr}`
                      )}
                    </Btn>
                    <Btn
                      onClick={writeBySerial}
                      disabled={
                        writeBySerialBusy ||
                        !lockedTarget?.has_address ||
                        !lockedTarget?.serial_number
                      }
                      color="var(--amber)"
                      title={
                        !lockedTarget?.serial_number
                          ? 'No serial recorded — record one on the Serial Number tab first'
                          : `Write ${newAddr} by targeting this exact serial number — no programming-button press needed, real-hardware confirmed. Writes whatever is shown in the address fields above, saved or not, and updates the project automatically once confirmed.`
                      }
                    >
                      {writeBySerialBusy ? <Spinner /> : 'Write by Serial'}
                    </Btn>
                  </div>
                  {writeAddrStatus && (
                    <div className={styles.pressPromptBadge}>
                      {writeAddrStatus}
                    </div>
                  )}
                  {writeAddrResult && (
                    <div
                      className={
                        writeAddrResult.ok ? styles.successMsg : styles.errorMsg
                      }
                    >
                      {writeAddrResult.msg}
                    </div>
                  )}
                  {writeBySerialResult && (
                    <div
                      className={
                        writeBySerialResult.ok
                          ? styles.successMsg
                          : styles.errorMsg
                      }
                    >
                      {writeBySerialResult.msg}
                    </div>
                  )}
                  {/* Pointer, not a duplicate control - the real toggle
                      lives on the Programming page header (a per-device
                      modal is the wrong scope for an all-devices setting).
                      Real request, 2026-09-01: someone landing here first
                      (like this one) should still discover it exists. */}
                  <div className={styles.emptyState}>
                    This is also used automatically during Program when
                    "Auto-program by Serial No." is enabled — see the
                    Programming page header.
                  </div>
                </>
              ) : (
                // ── Serial tab, redesigned 2026-08-31: real user feedback
                // ("just show the number in the edit box... Clear to its
                // right... Detect... on one line") - the recorded serial IS
                // the manual-entry box now, pre-filled instead of a
                // separate read-only display; write actions (button-press
                // AND by-serial) both moved to the Device Address tab -
                // this tab is pure bookkeeping (view/detect/clear) only.
                <>
                  <div className={styles.row}>
                    <input
                      className={styles.serialTopInput}
                      value={manualSerial}
                      onChange={(e) => setManualSerial(e.target.value.trim())}
                      onKeyDown={(e) => {
                        if (
                          e.key === 'Enter' &&
                          manualSerialValid &&
                          !manualNoChange
                        ) {
                          confirmSerial(manualSerial);
                        }
                      }}
                      placeholder="12 hex chars"
                      title="Recorded serial number — edit and press Enter or click Save"
                    />
                    {/* Real bug, found live 2026-08-31: "we don't have a
                        save button" - Enter-to-save (above) was the only
                        way to commit an edit, with no visible affordance
                        for it at all. */}
                    <Btn
                      onClick={() => confirmSerial(manualSerial)}
                      disabled={confirmBusy || !manualSerialValid || manualNoChange}
                      className={styles.serialSideBtn}
                      title={
                        manualNoChange
                          ? 'No change — this is already the recorded serial'
                          : 'Save this serial to the project - no bus interaction'
                      }
                    >
                      {confirmBusy ? <Spinner /> : 'Save'}
                    </Btn>
                    <Btn
                      onClick={clearSerial}
                      disabled={clearSerialBusy || !lockedTarget?.serial_number}
                      color="var(--red)"
                      className={styles.serialSideBtn}
                      title="Clear the recorded serial from the project - no bus interaction"
                    >
                      {clearSerialBusy ? <Spinner /> : 'Clear'}
                    </Btn>
                    <Btn
                      onClick={scan}
                      disabled={scanning}
                      className={styles.serialSideBtn}
                      title="Detect the serial via the device's physical programming button"
                    >
                      {scanning ? <Spinner /> : 'Detect'}
                    </Btn>
                  </div>
                  {manualSerial && !manualSerialValid && (
                    <div className={styles.errorMsg}>
                      Serial must be exactly 12 hex characters (6 bytes).
                    </div>
                  )}
                  {scanStatus && (
                    <div className={styles.pressPromptBadge}>{scanStatus}</div>
                  )}
                  {detectError && (
                    <div className={styles.errorMsg}>&#x2717; {detectError}</div>
                  )}
                  {detected && detected.length === 0 && (
                    <div className={styles.emptyState}>
                      No devices answered. Press the physical programming button
                      on this device, then scan again.
                    </div>
                  )}
                  {detected && detected.length > 0 && (
                    <div className={styles.detectedList}>
                      {detected.map((d) => {
                        // No real project address to compare against at
                        // all - capture-only regardless of what this
                        // device currently reports (see lockedNoAddress
                        // above).
                        const isMatch =
                          lockedNoAddress ||
                          (!!lockedTarget &&
                            d.src === lockedTarget.individual_address);
                        return (
                          <div key={d.src} className={styles.detectedRow}>
                            <div className={styles.detectedSerial}>
                              {d.serial
                                ? `Serial ${d.serial} @ ${d.src}`
                                : `${d.src} (no serial — detected via legacy address broadcast)`}
                              <CopyButton text={d.serial || d.src} />
                            </div>
                            <div className={isMatch ? styles.matchedTag : styles.unmatchedTag}>
                              {lockedNoAddress
                                ? 'No project address assigned yet.'
                                : isMatch
                                  ? `Already reports ${lockedTarget!.individual_address}.`
                                  : `Reports ${d.src || 'no address'}, not ${lockedTarget?.individual_address}.`}
                            </div>
                            <Btn
                              onClick={() => confirmSerial(d.serial)}
                              disabled={confirmBusy || !d.serial}
                              title={
                                !d.serial
                                  ? 'No real serial number to confirm - this device was only found via the legacy address broadcast'
                                  : undefined
                              }
                            >
                              {confirmBusy ? (
                                <Spinner />
                              ) : lockedNoAddress ? (
                                'Use This Serial'
                              ) : (
                                'Confirm Serial'
                              )}
                            </Btn>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
          <div className={styles.tabRow}>
            <button
              className={`${styles.tabBtn} ${tab === 'detect' ? styles.tabBtnActive : ''}`}
              onClick={() => setTab('detect')}
            >
              Press Programming Button
            </button>
            <button
              className={`${styles.tabBtn} ${tab === 'serial' ? styles.tabBtnActive : ''}`}
              onClick={() => {
                // Real request, 2026-08-31: "once I select the device to
                // assign it to, shouldn't that selection carry over to the
                // Enter Serial Number tab (along with the serial of the
                // selected device)?" - only meaningful with exactly one
                // detected device (detectSelection is keyed by address, so
                // there's no single "the" selection to carry over when
                // several are on screen at once).
                if (detected?.length === 1) {
                  const d = detected[0]!;
                  const pickedId = detectSelection[d.src];
                  // 'new' (see detectSelection's own comment) has no
                  // existing device id to carry over - the manual tab has
                  // no equivalent "add as new" concept of its own, so
                  // there's nothing meaningful to pre-fill for that case.
                  if (pickedId && pickedId !== 'new') {
                    setManualDeviceId(pickedId);
                    const picked = allDevices.find((dev) => dev.id === pickedId);
                    setManualSerial(d.serial || picked?.serial_number || '');
                  }
                }
                setTab('serial');
              }}
            >
              Enter Serial Number
            </button>
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={showAllDevices}
              onChange={(e) => setShowAllDevices(e.target.checked)}
            />
            Show already-programmed devices too (re-addressing a factory-reset unit)
          </label>

          {tab === 'detect' ? (
            <>
              <Btn onClick={scan} disabled={scanning}>
                {scanning ? (
                  <>
                    <Spinner /> Scanning…
                  </>
                ) : (
                  '⟲ Scan for devices in programming mode'
                )}
              </Btn>
              {detectError && (
                <div className={styles.errorMsg}>&#x2717; {detectError}</div>
              )}
              {detected && detected.length === 0 && (
                <div className={styles.emptyState}>
                  No devices answered. Press the physical programming button
                  on the target device, then scan again.
                </div>
              )}
              {detected && detected.length > 0 && (
                <div className={styles.detectedList}>
                  {detected.map((d) => {
                    // Keyed by d.src throughout (see scan()'s own comment) -
                    // d.serial can be '' for a device found only via the
                    // legacy address broadcast (real live-test finding,
                    // 2026-08-31: "Scan for New Device... does not seem to
                    // pick up our device in prog mode" - a non-Albrecht-
                    // Jung device that doesn't answer the serial-number
                    // scan at all).
                    const matched = d.serial ? matchBySerial(d.serial) : null;
                    const busy = detectBusy[d.src];
                    const result = detectResult[d.src];
                    return (
                      <div key={d.src} className={styles.detectedRow}>
                        <div className={styles.detectedSerial}>
                          {d.serial
                            ? `Serial ${d.serial} @ ${d.src}`
                            : `${d.src} (no serial — detected via legacy address broadcast)`}
                          <CopyButton text={d.serial || d.src} />
                        </div>
                        {matched ? (
                          <div className={styles.matchedTag}>
                            Matched project record: {matched.name}
                          </div>
                        ) : (
                          <div className={styles.unmatchedTag}>
                            {d.serial
                              ? 'No matching serial in the project — pick manually'
                              : 'No serial to match — pick the target device manually'}
                          </div>
                        )}
                        <div className={styles.row}>
                          <div className={styles.col}>
                            <div className={styles.fieldLabel}>ASSIGN TO</div>
                            <select
                              className={styles.select}
                              value={detectSelection[d.src] ?? ''}
                              onChange={(e) =>
                                setDetectSelection((s) => ({
                                  ...s,
                                  [d.src]:
                                    e.target.value === 'new'
                                      ? 'new'
                                      : e.target.value
                                        ? Number(e.target.value)
                                        : '',
                                }))
                              }
                            >
                              <option value="">— select a device —</option>
                              {/* Real request, 2026-08-31: "in the Assign
                                  To, we should have an option (maybe first
                                  in the list) to add as New Device (i.e.
                                  something not already in our DB)." */}
                              <option value="new">+ Add as New Device</option>
                              {generalCandidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.has_address
                                    ? `${c.individual_address} — ${c.name}`
                                    : `(unassigned) — ${c.name}`}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {/* No bus write happens from this general/unlocked
                            flow at all any more - real request, 2026-08-31:
                            "the Write Address buttons here shouldn't be
                            present as we don't have an address editor.
                            Remove the buttons entirely, and allow the
                            device to be added as if it were a new
                            unassigned device." Recording the serial is
                            bookkeeping only (see recordDetectedSerial()) -
                            a real write happens later via that project
                            device's own row (which now offers a real
                            address editor - the locked flow's Device
                            Address tab). */}
                        <div className={styles.row}>
                          <Btn
                            onClick={() => recordDetectedSerial(d.src, d.serial)}
                            disabled={
                              busy ||
                              !detectSelection[d.src] ||
                              (detectSelection[d.src] !== 'new' && !d.serial)
                            }
                            title={
                              detectSelection[d.src] === 'new'
                                ? `Add a new project device at ${d.src}${d.serial ? ', with this serial recorded' : ''} - no write to the physical device`
                                : !d.serial
                                  ? 'No real serial number available — this device was only found via the legacy address broadcast, nothing to record yet'
                                  : 'Record this serial against the selected project device - bookkeeping only, no write to the physical device'
                            }
                          >
                            {busy ? (
                              <Spinner />
                            ) : detectSelection[d.src] === 'new' ? (
                              'Add as New Device'
                            ) : (
                              'Record Serial'
                            )}
                          </Btn>
                        </div>
                        {result && (
                          <div
                            className={
                              result.ok ? styles.successMsg : styles.errorMsg
                            }
                          >
                            {result.msg}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.fieldLabel}>SERIAL NUMBER (12 hex chars)</div>
                  <input
                    className={styles.textInput}
                    value={manualSerial}
                    onChange={(e) => setManualSerial(e.target.value.trim())}
                    placeholder="e.g. 00fa1234abcd"
                  />
                </div>
              </div>
              {manualSerial && !manualSerialValid && (
                <div className={styles.errorMsg}>
                  Serial must be exactly 12 hex characters (6 bytes).
                </div>
              )}
              {lockDevice ? (
                lockedTarget && (
                  <div className={styles.matchedTag}>
                    Addressing: {lockedTarget.individual_address} —{' '}
                    {lockedTarget.name}
                  </div>
                )
              ) : (
                <>
                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.fieldLabel}>ASSIGN TO</div>
                      <select
                        className={styles.select}
                        value={manualDeviceId || manualMatch?.id || ''}
                        onChange={(e) =>
                          setManualDeviceId(
                            e.target.value ? Number(e.target.value) : '',
                          )
                        }
                      >
                        <option value="">— select a device —</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.individual_address} — {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {manualMatch && !manualDeviceId && (
                    <div className={styles.matchedTag}>
                      Matched project record: {manualMatch.name}
                    </div>
                  )}
                </>
              )}
              <Btn
                onClick={writeManual}
                disabled={
                  manualBusy ||
                  !manualSerialValid ||
                  !(manualDeviceId || manualMatch) ||
                  manualNoChange
                }
                color="var(--amber)"
                title={
                  manualNoChange
                    ? 'No change — this is already the recorded serial for this device'
                    : 'Write by targeting this exact serial number — no programming-button press needed, real-hardware confirmed'
                }
              >
                {manualBusy ? <Spinner /> : 'Write Address'}
              </Btn>
              {manualResult && (
                <div
                  className={
                    manualResult.ok ? styles.successMsg : styles.errorMsg
                  }
                >
                  {manualResult.msg}
                </div>
              )}
            </>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
