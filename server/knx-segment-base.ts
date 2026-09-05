// server/knx-segment-base.ts
//
// Resolve the absolute base address of a relmem (RelativeSegment) parameter
// segment on a System B / BCU2-style device. The base is not in the .knxproj;
// it lives in the device and is read from interface-object Property 7
// (PID_TABLE_REFERENCE), the pointer ETS itself reads before writing.

/** PID_TABLE_REFERENCE — the interface-object property holding a segment's
 *  absolute base address on BCU2/System B masks. */
export const PID_TABLE_REFERENCE = 7;

/**
 * Parse a PID 7 property value into an absolute base address. The value is a
 * 4-byte big-endian pointer. A `0x00000000` pointer means the segment is NOT
 * allocated — writing then targets near-zero addresses and fails (the observed
 * ETS first-attempt failure). Returns null for that case and for short values.
 */
export function parseTableReference(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  const addr = buf.readUInt32BE(0);
  return addr === 0 ? null : addr;
}

interface RelmemStep {
  type: string;
  objIdx?: number;
}

interface PropertyReader {
  readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]>;
}

/**
 * Read PID 7 over the bus for each distinct WriteRelMem interface object and
 * resolve its absolute base. Objects whose pointer is unallocated (0x00000000)
 * are returned in `unallocated` so the caller can refuse to write.
 *
 * `extraObjIdxs` (optional) adds further objects to resolve regardless of
 * whether a WriteRelMem step exists for them - used for the GA table
 * (objIdx 1) / Association table (objIdx 2), which real ETS writes/verifies
 * via the same RelSegment mechanism even when the app's own model doesn't
 * declare a step for them (see knx-connection.ts's WriteRelMem case and
 * knx-download-plan.ts's `buildGaAssocMem`).
 */
export async function resolveRelmemBases(
  bus: PropertyReader,
  deviceAddr: string,
  steps: RelmemStep[],
  extraObjIdxs: number[] = [],
): Promise<{ bases: Record<number, number>; unallocated: number[] }> {
  const objIdxs = [
    ...new Set([
      ...steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx ?? 4),
      ...extraObjIdxs,
    ]),
  ];
  if (objIdxs.length === 0) return { bases: {}, unallocated: [] };

  const values = await bus.readPropertyMany(
    deviceAddr,
    objIdxs.map((objIdx) => ({ objIdx, propId: PID_TABLE_REFERENCE })),
  );

  const bases: Record<number, number> = {};
  const unallocated: number[] = [];
  objIdxs.forEach((objIdx, i) => {
    const base = parseTableReference(values[i] ?? Buffer.alloc(0));
    if (base == null) unallocated.push(objIdx);
    else bases[objIdx] = base;
  });
  return { bases, unallocated };
}
