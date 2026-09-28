/**
 * restartDevice() Basic vs Extended Restart variant.
 *
 * restartDevice() (a standalone identity-confirm-and-restart step, reused
 * by the address-write paths - see its own doc comment, knx-connection.ts)
 * used to send the plain/Basic `A_Restart` unconditionally, regardless of
 * device family. This project's own real capture corpus shows otherwise:
 * a System B device (mask low byte 0xB0) gets the Extended variant, with a
 * real response; a non-System-B device gets the plain variant, no response
 * expected - see real ETS captures of 1.1.9/1.1.10 vs. a non-System-B
 * device (1.1.60), and restartDevice()'s own doc comment for details. This is the same real-hardware-evidenced
 * pattern already established elsewhere in this file for other services
 * (`useExtendedMemory`, `(mask & 0xff) === 0xb0`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCEMI,
  buildCEMI,
  apduGroup,
  apduExtUnnumbered,
  APCI_EXT,
} from '../server/knx-cemi.ts';
import { KnxConnection, scaledMs } from '../server/knx-connection.ts';

/** Answers DeviceDescriptor_Read (configurable mask), the two best-effort
 *  identity reads restartDevice() does (P=56/P=11 - no response needed),
 *  and the Extended Restart request/response pair. Ignores the plain
 *  Restart (it has none by design). */
class FakeRestartDevice extends KnxConnection {
  sent: Buffer[] = [];
  private readonly mask: number;

  constructor(mask: number) {
    super();
    this.mask = mask;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  private reply(apdu: Buffer): void {
    const resp = parseCEMI(buildCEMI('1.1.99', this.localAddr, apdu, false))!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.alloc(2);
      maskBuf.writeUInt16BE(this.mask);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }
    if (frame.apciIdx === APCI_EXT.Restart_Extended) {
      this.reply(
        apduExtUnnumbered(
          APCI_EXT.Restart_Extended_Response,
          Buffer.from([0x00, 0x00, 0x00]),
        ),
      );
      return Promise.resolve();
    }
    // P=56/P=11 identity reads, and the plain Restart itself: no response
    // needed (best-effort reads; plain Restart has no response by design).
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  restartVariant(): 'basic' | 'extended' | 'none' {
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      if (f.apciIdx === APCI_EXT.Restart_Extended) return 'extended';
      if (f.apciName === 'Restart') return 'basic';
    }
    return 'none';
  }
}

describe('restartDevice() - Basic vs Extended Restart variant', () => {
  it("sends the EXTENDED Restart to a System B device (mask low byte 0xB0) - matches this project's own real captures", async () => {
    const dev = new FakeRestartDevice(0x07b0);
    await dev.restartDevice('1.1.99', 0, 50);
    assert.equal(
      dev.restartVariant(),
      'extended',
      'a System B device should get the Extended Restart',
    );
  });

  it('falls back to the Basic Restart for a non-System-B device (mask low byte != 0xB0)', async () => {
    const dev = new FakeRestartDevice(0x0700); // arbitrary non-B0 low byte
    await dev.restartDevice('1.1.99', 0, 50);
    assert.equal(
      dev.restartVariant(),
      'basic',
      'a non-System-B device should keep the plain/Basic Restart',
    );
  });

  it('falls back to the Basic Restart when the mask read itself fails (no DeviceDescriptor_Response)', async () => {
    class NoIdentityDevice extends KnxConnection {
      sent: Buffer[] = [];
      constructor() {
        super();
        this.connected = true;
        this.localAddr = '1.0.1';
      }
      sendCEMI(cemi: Buffer): Promise<void> {
        this.sent.push(cemi);
        return Promise.resolve(); // never answers anything
      }
      disconnect(): void {
        this.connected = false;
      }
    }
    const dev = new NoIdentityDevice();
    await dev.restartDevice('1.1.99', 0, 50);
    const restartFrame = dev.sent
      .map((c) => parseCEMI(c))
      .find((f) => f?.apciName === 'Restart');
    assert.ok(
      restartFrame,
      'with no mask signal available at all, the method must still send SOME Restart (the plain/Basic default) rather than silently sending nothing',
    );
  });
});

describe('restartDevice() - settle delay after a successful Extended RestartResp', () => {
  it('waits the full post-restart delay even though the device answered straight away', async () => {
    // A RestartResp only means the restart request was accepted, not that
    // the device has finished rebooting. Callers resume sending as soon as
    // restartDevice() returns, so it must not return after ~200ms.
    const dev = new FakeRestartDevice(0x07b0);
    const started = Date.now();
    await dev.restartDevice('1.1.99', 0, 600);
    const elapsed = Date.now() - started;
    const expected = scaledMs(600);
    assert.ok(
      elapsed >= expected * 0.9,
      `returned after only ${elapsed}ms, expected the full ${expected}ms settle`,
    );
  });
});
