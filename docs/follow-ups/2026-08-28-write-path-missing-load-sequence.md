# Investigation: real device writes never take effect — koolenex's write path skips the entire Unload/Load/LoadCompleted sequence

**See also**: `docs/knx-device-write-protocol.md` — the consolidated reference, including a
frame-by-frame decode of the Full/Partial Download captures. This log is the narrative record.

**Status: RESOLVED.** Six sequential root causes, each confirmed on real hardware: (1) the entire
missing Unload/StartLoading/LoadData/LoadCompleted sequence, (2) a Restart-before-LoadCompleted-
confirmed race, (3) a missing `A_Authorize_Request`, (4) a missing `PID_PROGRAM_VERSION`
read-back-and-write-back, (5) the `LoadData` mode byte meaning Full(`0x01`)/Partial(`0x00`), not a
"combined declaration", and (6) `WriteRelMem` must use `A_MemoryExtended_Write` for a System B
device regardless of address size. This does not un-retract the earlier "write path proven correct"
finding for 1.1.10 — that finding is still unverified against these fixes.

**Correction (same day)**: Fix 6 originally shipped as an unconditional "always extended" rule,
generalized from exactly two devices (1.1.9, 1.1.10). Both happen to share the same mask family
(`0x07B0`, System B) — right for them specifically, not universal. `WriteRelMem` now reads the
device's real mask version and gates on it, falling back to the address-size heuristic otherwise.

## Why this came up

No koolenex-driven write had ever been independently confirmed to actually change a real device
(the earlier "actual-vs-actual, byte-identical" test never ruled out a no-op write matching
itself). Picked a small real test: flip one boolean parameter on 1.1.9 and write it for real.

## What happened

1. Set the project value to "off". `verify-device` correctly decoded the mismatch.
2. Ran `POST /bus/program-device`. Returned `ok:true`. **The device's byte was unchanged
   afterward.**
3. A second attempt (tshark running) failed outright; a subsequent read-only `verify-device` call
   also failed with a stale-session timeout. Reconnecting restored read health; a third attempt (no
   capture) failed the same way.
4. Added a minimal `POST /bus/write-memory` debug endpoint (a real write, reusing
   `downloadDevice()`/`WriteRelMem`) and wrote a single precisely-targeted byte directly. No error,
   but the readback was unchanged — ruling out addressing and the padding-bit bug (below) as the
   cause.

## Root cause: the entire Unload → Load → LoadCompleted sequence is missing

Captured a full real ETS Full Download to 1.1.9 and compared it against koolenex's own
`model.loadProcedures` for the app.

**Real ETS sequence** (`PID_LOAD_STATE_CONTROL` = property 5):

1. **Unload** every relevant object, reverse index order: `PropValueWrite OX=5,4,3,2,1 P=5 event=$04`.
2. For each object with data to write (4, 3, 2, 1 in that order): `StartLoading` (event `$01`) →
   `LoadData` (event `$03`, the `RelSegment` step, 9 extra bytes) → the real memory write(s).
3. **LoadCompleted**: `PropValueWrite OX=4,3,2,1 P=5 event=$02`.
4. `RestartReq`.

**`LoadData` wire format** (event `0x03` + 9 bytes): `[SCF][rsvd:2][size(BE):2][mode][fill][rsvd:2]`.
`size` matches each object's real write size exactly across all four examples. `mode`/`fill` only
confirmed for objIdx4 (the one object with a model `RelSegment` entry, `fill=255`).

**koolenex's `model.loadProcedures`** for this app has only 2× `CompareProp`, 2× `RelSegment`
(objIdx 4 only), 1× `WriteRelMem` (objIdx 4 only) — no `Unload`, no `StartLoading`, nothing for
objIdx 1/2/3, no `LoadCompleted`, no `Restart`. Even the two `RelSegment` steps the model has are
silently dropped — `downloadDevice()`'s step executor has no `'RelSegment'` case. Every
`WriteRelMem` koolenex ever sent went out raw, with the object never put into "Loading" state —
which device firmware simply ignores.

**Direct wire confirmation**: koolenex's own failed attempt shows, right after resolving objIdx 4's
PID-7 base, a raw legacy `Memory_Write` blind-filling the entire 8178-byte segment with `0xFF`, no
`PropValueWrite ... P=5` frames anywhere.

## A separate bug: wrong padding-bit fill

`buildParamMem()`'s computed byte for offset 69 didn't match reality even in principle: real value
is `0x80` (bit 7 set, others clear) for a 1-bit boolean; koolenex computes `0xFF`/`0x7F`, correctly
toggling bit 7 but filling the other 7 "padding" bits with `1`s instead of `0`s.

## Fixes 2–6

Fix 1 shipped as commit `1620fa5`. Retesting kept finding the byte still didn't persist:

- **Fix 2 (`b09dc1e`)** — Restart-before-confirmation race: `propWrite()` used a fixed `delay(50)`
  instead of waiting for the real `PropertyValue_Response`. Added `propRead()`/rewrote `propWrite()`
  to use `waitResponse()` properly.
- **Fix 3 (`731c36b`)** — missing `A_Authorize_Request` (well-known key `0xFFFFFFFF`) before any
  RelSegment-driven write.
- **Fix 4 (`f5588c7`)** — missing `PID_PROGRAM_VERSION` write-back: real ETS reads it early, writes
  the identical value back right before `LoadCompleted`. Found only via a genuinely complete,
  systematic frame-sequence extraction, after two earlier targeted greps missed it.
- **Fix 5** (no code change, corrected understanding) — the `LoadData` mode byte. Three consecutive
  ETS downloads (Full, Partial off, Partial on) showed mode `0x00` on both Partials, `0x01` on
  Full — real meaning is Full/Partial, not "combined declaration". Necessary but not sufficient on
  its own.
- **The decisive experiment** — built `POST /bus/replay-frames` (`server/routes/bus.ts` +
  `KnxBusManager.replayFrames()`, commit `541c134`) to fire a real captured Partial-Download frame
  sequence verbatim at hardware, no koolenex reconstruction at all. **This persisted correctly**,
  proving the wire content itself is sufficient — the bug was entirely in koolenex's own
  reconstruction.
- **Fix 6 (`68c0394`)** — the actual final bug: diffing koolenex's reconstruction against the
  successful verbatim replay found one difference: koolenex picked legacy `A_Memory_Write` because
  `addr <= 0xFFFF`, while real ETS used `A_MemoryExtended_Write` unconditionally. This app's
  firmware only honors the extended service on the RelSegment-gated path; the legacy write is a
  **silent** no-op — no error at any layer — which is why fixes 1–5 all succeeded at the protocol
  level while the underlying write was quietly ignored. Shipped as an unconditional rule (removed
  the `addr > 0xFFFF` conditional entirely) — see "Fix 6, corrected" below for why that was wrong.

## Fix 6, corrected: gate on the device's real mask version

"Always extended" was generalized from exactly two devices, both happening to be available on this
testbed, not chosen for diversity. Trawled the project's bundled KNX Master Data
(`data/knx_master_<projectId>.xml`): its `<MaskVersion>` elements carry `ManagementModel` per mask
family — `Bcu1`, `Bcu2`, `PropertyBased`, `BimM112`, and `SystemB` for masks `07B0`/`17B0`/`27B0`/
`57B0`. Checked both tested devices' real mask via `A_DeviceDescriptor_Read`: both `07b0` = System
B — confirming "always extended" was right for these two specifically, not that it generalizes. A
genuinely older BCU1/BCU2/System-7 device has never been tested and could require legacy.

**Fix (commit `95805ff`)**: `WriteRelMem` reads the real mask version via `A_DeviceDescriptor_Read`
at session start (mirroring what real ETS does) and gates: extended unconditionally for confirmed
System B, falling back to the address-size heuristic otherwise. Reconfirmed on 1.1.9 across 3 more
real downloads/reconnects.

## Final resolution: confirmed on real hardware

The NTP-server-source parameter at 1.1.9 was flipped across seven separate real downloads/
reconnects total, each independently confirmed via a fresh read-memory call after a full
disconnect/reconnect. The write path works, for confirmed System B devices at least.

## Retroactive implication: the earlier "write path proven correct" finding is unsafe

That finding (koolenex-driven download vs fresh ETS-native download, 0/10433 bytes differ) used
1.1.10, which shares the same `RelSegment`-based load-procedure shape as 1.1.9. If the same gap
applied there (not yet independently re-tested), the likely explanation is a false positive:
koolenex's download was a no-op, so "device state after a no-op" trivially equals "device state ETS
had just written moments before." **Don't cite that result as evidence the write path works** until
re-run against this fix.

## What this does and doesn't settle

**Settled**: root cause of every failed/no-op write against 1.1.9 (Fixes 1–6); the real `LoadData`
wire format; `A_Authorize_Request` and `PID_PROGRAM_VERSION` write-back are required; `WriteRelMem`
must use `A_MemoryExtended_Write` for confirmed System B, gated on real mask not a blanket rule; the
write path works, confirmed reproducibly (1.1.9, seven downloads/reconnects); a separate padding-
bit-fill bug, root-caused but not yet fixed here.

**Not yet done/open**: the padding-bit fill bug; whether 1.1.10 needed all six fixes (not
re-tested since; also mask `0x07B0`, so should take the same path once re-tested); the GA/
Association table wire format (still guessed, unfixed here); what objIdx 3 actually is; a genuinely
legacy (non-System-B) device has never been tested against this write path at all — the fallback
branch is only protocol-level-tested; none of these fixes came from fixing model extraction itself,
only the hand-written `downloadDevice()` executor — worth revisiting once more apps are tested.

## Artifacts

- `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` — the real ETS Full Download used to decode
  `LoadData`.
- `2026-08-28-koolenex-write-attempt-1.1.9.pcapng` — koolenex's failed write attempt, showing the
  missing Load sequence directly.
- `2026-08-28-ets-{1,2,3}-{full,partial-ntp-off,partial-ntp-on}-download-1.1.9.pcapng` — the three
  downloads settling the mode-byte meaning and sourcing the verbatim replay.
- `2026-08-28-verbatim-replay-success-1.1.9.pcapng` — the successful verbatim replay.
- `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` — koolenex's own reconstruction, diffed
  against the verbatim replay to find Fix 6.
- `POST /bus/write-memory` (`server/routes/bus.ts`) — writes an exact byte sequence to an absolute
  address, real-hardware debug tool.
- `POST /bus/replay-frames` (`server/routes/bus.ts` + `KnxBusManager.replayFrames()`) — replays a
  literal captured CEMI frame sequence verbatim, real-hardware debug tool.
- The git history of `test/relmem-real-device-fixtures` has the fuller methodological history.
