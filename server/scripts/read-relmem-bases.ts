/**
 * Read-only: fetches PID_TABLE_REFERENCE (property 7) for interface objects
 * 1-4 (GA / Association / Group Object Table / Parameter memory) from a
 * live device, and prints the real absolute base addresses.
 *
 * Built for the case where a project record describes a physical unit
 * that has since moved to a different real address. Reading the unit's
 * real bases directly, live, lets a loopback simulation for the old
 * address use REAL table addresses instead of guessed/synthesized ones -
 * matching this project's own established discipline: table bases always
 * come from a real capture or a real live read, never a guess.
 *
 * Opens its own short-lived connection, separate from koolenex-server's own
 * standing tunnel to the same router - real KNXnet/IP routers support more
 * than one simultaneous tunnel connection, and this disconnects as soon as
 * the four reads complete. No writes of any kind.
 *
 * Run:
 *   node server/scripts/read-relmem-bases.ts --host <router-ip> --addr 1.1.10
 */
import { KnxConnection } from '../knx-protocol.ts';
import { parseTableReference } from '../knx-segment-base.ts';

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const host = argVal('host');
  const addr = argVal('addr');
  if (!host || !addr) {
    console.error('Usage: --host <ip> --addr <individual address>');
    process.exit(1);
  }

  const conn = new KnxConnection();
  console.log(`Connecting to ${host}:3671...`);
  await conn.connect(host, 3671, 8000, 'auto');
  // Settle delay after a fresh connect, before touching the bus - matching
  // established practice elsewhere in this codebase (routes/bus.ts's own
  // program-device/verify-device both do `await delay(500)` after
  // forceReconnect(), for the same reason). Missing this exact delay is a
  // real, previously-diagnosed root cause of a "device not answering"
  // false negative - a fresh connection genuinely needs a moment before
  // the router/bus is ready for a real management session.
  await new Promise((r) => setTimeout(r, 1000));
  console.log(
    `Connected (${conn.transport}). Reading PID_TABLE_REFERENCE from ${addr}, objIdx 1-4...`,
  );
  try {
    const values = await conn.readPropertyMany(addr, [
      { objIdx: 1, propId: 7 },
      { objIdx: 2, propId: 7 },
      { objIdx: 3, propId: 7 },
      { objIdx: 4, propId: 7 },
    ]);
    const labels = [
      'GA table',
      'Association table',
      'Group Object Table',
      'Parameter memory',
    ];
    values.forEach((v, i) => {
      const base = parseTableReference(v);
      console.log(
        `objIdx ${i + 1} (${labels[i]}): raw=0x${v.toString('hex')} -> ${
          base == null ? 'UNALLOCATED' : `0x${base.toString(16)}`
        }`,
      );
    });
  } finally {
    conn.disconnect();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
