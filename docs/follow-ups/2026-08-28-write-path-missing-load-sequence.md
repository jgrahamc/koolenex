# Investigation: real device writes never take effect — koolenex's write path skips the entire Unload/Load/LoadCompleted sequence

**See also**: `docs/knx-device-write-protocol.md` — a consolidated, topic-organized, evidence-
tagged (CONFIRMED/INFERRED/SPECULATIVE) reference covering everything settled in this
investigation log plus a full frame-by-frame decode of the Full Download and both Partial
Download captures. This log remains the chronological investigation record (dead ends,
retracted theories, exact order of discovery); the reference doc is the place to check current
facts without re-reading the narrative.

**Status: RESOLVED.** Six independent, sequential root causes were found and fixed, each confirmed on real
hardware: (1) the entire missing Unload/StartLoading/LoadData/LoadCompleted sequence (this doc's original
finding, below), (2) a Restart-before-LoadCompleted-confirmed race, (3) a missing `A_Authorize_Request`,
(4) a missing `PID_PROGRAM_VERSION` read-back-and-write-back, (5) the `LoadData` "mode" byte meaning
Full(`0x01`)/Partial(`0x00`) download, not "combined full+par declaration" as first guessed, and (6) — the
final blocker, found via a verbatim real-frame replay that succeeded where koolenex's own reconstruction
kept failing — `WriteRelMem` must use `A_MemoryExtended_Write` for a System B device (mask `0x07B0`),
regardless of whether the address fits in 16 bits. See "Fixes 2-6" and "Final resolution" below for the
full story; the original Fix-1 writeup follows unchanged as the section that started it. This also
un-retracts nothing about the 2026-08-26 "write path proven correct" finding for 1.1.10 — that finding is
still unverified against these fixes and should not be cited until it is (see "Retroactive implication"
below, still open).

**Correction (same day, commit `95805ff`)**: Fix 6 originally shipped as an unconditional "always use
`A_MemoryExtended_Write`" rule, generalized from real-hardware evidence on exactly two devices (1.1.9,
1.1.10). That generalization doesn't hold up before further use - both devices
turned out to share the same mask family (`0x07B0`, "System B" per this project's own bundled KNX Master
Data), so "always extended" happened to be right for them specifically, not because it's universally true.
`WriteRelMem` now reads the device's real mask version (`A_DeviceDescriptor_Read`, mirroring what real ETS
itself does at the start of every download) and gates on it: extended unconditionally for a confirmed
System B device, falling back to the original address-size heuristic otherwise. See "Fix 6, corrected"
below for the full trawl and fix.

## Why this came up

Wanted to close the last real gap in the write-path story: no koolenex-driven write had ever been
independently confirmed to actually change a real device (see `koolenex-reference` memory, 2026-08-28
entry, for the full methodological history — the earlier "actual-vs-actual, byte-identical" test never
ruled out a no-op write matching itself). Picked the smallest real test available: flip one boolean
parameter ("Use standard NTP server (pool.ntp.org)", `M-0004_A-0025-10-1BA6-O00A6_P-2_R-2`, relmem offset
69) on 1.1.9, the smaller of the two testbed devices, and write it for real.

## What happened

1. Set the project's configured value for that parameter to "off" via `PATCH
   /projects/6/devices/191/param-values`. Confirmed `verify-device` correctly decoded the resulting mismatch
   (`expectedValue: "off"`, `actualValue: "on"`).
2. Ran `POST /bus/program-device` for 1.1.9. Returned `{"ok":true}`. **The device's byte was unchanged
   afterward** (`0x80` before and after — bit 7 set = "on").
3. A second attempt (with tshark running) failed outright: `"Device programming failed"`. A subsequent
   read-only `verify-device` call then also failed: `"Tunneling ACK timeout"` — the known stale-session
   failure mode from 2026-08-26. Reconnecting the bus (`/bus/disconnect` then `/bus/connect`) restored read
   health; a third program attempt (no capture running, to rule out capture overhead) failed the same way.
4. To isolate the question cleanly, added a minimal `POST /bus/write-memory` debug endpoint (real write,
   unlike every other debug route in `bus.ts` — reuses the actual `downloadDevice()`/`WriteRelMem` code by
   passing the target address as objIdx `0`'s own "resolved base" with offset `0`) and manually wrote a
   single, precisely-targeted byte: read the device's real current byte (`0x80`), cleared just bit 7 to get
   `0x00`, wrote that one byte to the real absolute address (`0x5F53` = base `0x5F0E` + offset 69). **No
   error, but the readback was still `0x80` — completely unchanged.** This ruled out addressing as the
   cause (the address was independently confirmed correct via the same segment's earlier `expected`/`actual`
   chunk data) and ruled out the byte-packing bug below as the cause (a single, hand-picked correct byte
   still didn't take).

At this point the server needed restarting to pick up the new endpoint — it wasn't running under a
supervised/tracked process, so it was killed and restarted under session tracking, giving visibility
into its own logs for the first time.

## Root cause: the entire Unload → Load → LoadCompleted sequence is missing

Captured yesterday's real ETS Full Download to 1.1.9 in full (not just the `MemExtWrite`/PID-7 frames
already documented in `2026-08-27-relmem-write-scope-investigation.md` — every frame, including the
`PropValueWrite`/`PropValueResp` traffic around them) and compared it directly against koolenex's own
`model.loadProcedures` for this app (`data/apps/M-0004_A-0025-10-1BA6-O00A6.json`).

**Real ETS sequence** (`PID_LOAD_STATE_CONTROL` = property 5 on each interface object):

1. **Unload** every relevant object, in reverse index order: `PropValueWrite OX=5,4,3,2,1 P=5 event=$04`
   (Unload) → each replies state `$00` (Unloaded).
2. For **each** object that has data to write — `4` (parameters), `3` (unidentified, 98 bytes), `2`
   (association table), `1` (GA table), in that order:
   - `StartLoading`: `OX=<n> P=5 event=$01` → state `$02` (Loading)
   - `LoadData` — **this *is* the `RelSegment` step**: `OX=<n> P=5 event=$03 data=...` (exact byte layout
     below) → state stays `$02`
   - Real memory write(s) (`MemExtWrite`/`Memory_Write`) to that object's PID-7-resolved base
3. **LoadCompleted**: `PropValueWrite OX=4,3,2,1 P=5 event=$02` → state `$01` (Loaded)
4. `RestartReq`

**`LoadData` wire format**, decoded from all four real examples (event `0x03` + 9 more bytes):

```
byte:   0    1    2-3    4-5        6      7      8-9
        evt  SCF  rsvd   size(BE)   mode?  fill   rsvd
objIdx4: 03   0B   0000   1FF2(8178) 01     FF     0000   (matches model's declared size=8178,fill=255)
objIdx3: 03   0B   0000   0062(98)   00     00     0000
objIdx2: 03   0B   0000   000A(10)   00     00     0000
objIdx1: 03   0B   0000   0006(6)    00     00     0000
```

`size` matches each object's real write size exactly across all four independent real examples - high
confidence. `mode`/`fill` bytes only confirmed non-zero for objIdx4 (the one object with an explicit
`RelSegment` entry - `fill: 255` - in the model); the other three objects have no model entry to
cross-check against, so `mode=0x01` (possibly a "combined full+par" flag, since only objIdx4 has separate
`full`/`par` `RelSegment` declarations in the model) is a working guess, not confirmed.

**koolenex's `model.loadProcedures` for this app** has only: 2× `CompareProp`, 1× `CompareProp`, 2×
`RelSegment` (objIdx 4 only, `full`/`par`), 1× `WriteRelMem` (objIdx 4 only). **No `Unload`, no
`StartLoading`, nothing at all for objIdx 1/2/3, no `LoadCompleted`, no `Restart`.** And even the two
`RelSegment` steps the model *does* have are silently dropped - `downloadDevice()`'s step executor
(`server/knx-connection.ts`, the legacy inline-loop switch) has cases for `WriteProp`/`CompareProp`/
`WriteRelMem`/`LoadImageProp` only; `'RelSegment'` isn't one of them, so it hits no case and does nothing.

**This is not two separate gaps to weigh differently - they compound into one outcome**: koolenex's model
of what a download *is*, as extracted from the real project data, doesn't include the load-state machinery
or the objIdx 1/2/3 steps at all; and the one piece of load-state machinery the model does encode isn't
even executed. Every `WriteRelMem` koolenex has ever sent goes out completely raw, with the target
interface object never put into "Loading" state - which real device firmware is expected to (and, per
every test above, does) simply ignore.

## Direct confirmation from koolenex's own real wire traffic (not just code reading)

Captured koolenex's own second `program-device` attempt (the one that later errored) via tshark. Its real
UDP traffic to the router shows, immediately after resolving `objIdx 4`'s PID-7 base:

```
Connect → PropValueRead OX=4 P=7 → PropValueResp $00005F0E → Disconnect → Connect →
MemWrite N=10 X=$5F0E $FFFFFFFFFFFFFFFFFFFF  (raw legacy Memory_Write, no Unload/StartLoading/LoadData at all)
MemWrite N=10 X=$5F18 $FF...
... (repeats ~818 times, 10 bytes/chunk, the entire 8178-byte segment blind-filled with 0xFF) ...
```

(Note: Wireshark's own KNXnet/IP dissector mis-displays this frame's address in its summary column as
`X=$0A5F` - manually decoding the raw APDU bytes the same way `parseCEMI()` does confirms the real address
field is `0x5F0E`, correct. Don't trust the summary column for this frame shape; decode the hex directly.)

Zero `PropValueWrite ... P=5` frames appear anywhere in this capture. This is direct, wire-level proof of
the code-reading conclusion above, not an inference from it.

**Also observed, likely consequential**: this blind full-segment write takes ~25 seconds (818 chunks ×
30ms delay) and ends in a `Disconnect`/failed `Connect` reconnect storm - plausibly the device's own
protection against a sustained flood of writes it can't act on (every chunk outside Loading state), though
this specific causal link isn't confirmed.

## A separate, smaller bug found along the way: wrong padding-bit fill

Before any of the above, `buildParamMem()`'s computed byte for offset 69 didn't match reality even in
principle: real device (and real ETS) value is `0x80` (bit 7 set for "on", all other bits **clear**) -
`P-2_R-2` is a 1-bit boolean (`bitOffset:0, bitSize:1`) packed into that byte alongside other, unnamed
bits. koolenex computes `0xFF` for "on" and `0x7F` for "off" - correctly toggling bit 7, but filling the
*other* 7 bits with `1`s as "unknown padding" default, when the real device has them as `0`. Confirmed via
direct code test (`buildParamMem()` called standalone with `{}` vs the changed param value). This is a
genuine, separate write-correctness bug (independent of the missing Load sequence above) that would still
need fixing even once writes actually reach the device.

## Fixes 2-6: what it took to get from "Fix 1 shipped" to an actual persisting write

Fix 1 (the sequence above) shipped as koolenex commit `1620fa5`. Real-hardware retesting after each
subsequent fix kept finding the byte still didn't persist, prompting the next fix. This section is the log
of that chain, compressed — full detail lives in `koolenex-reference` memory (knx-ets-manager repo) and the
git history of `test/relmem-real-device-fixtures`.

- **Fix 2 (`b09dc1e`) — Restart-before-confirmation race.** `propWrite()` originally used a fixed `delay(50)`
  after each Load State write instead of waiting for the device's actual `PropertyValue_Response`. Rewrote
  it (and added `propRead()`) to use the pre-existing `waitResponse()` pattern properly.
- **Fix 3 (`731c36b`) — missing `A_Authorize_Request`.** Real ETS sends this (well-known key `0xFFFFFFFF`)
  before any RelSegment-driven write; koolenex never did. Neither `Authorize_Request/Response` nor
  `PropertyValue_Write/Read` are in `parseCEMI`'s `APCI_EXT_NAMES` table, so matching frames requires
  recomputing the full 10-bit APCI manually (`((apdu[0]&0x03)<<8)|apdu[1]`) rather than trusting
  `apciName`.
- **Fix 4 (`f5588c7`) — missing `PID_PROGRAM_VERSION` write-back.** Real ETS reads `PID_PROGRAM_VERSION`
  (objIdx 4, property 13) early, then writes the identical value straight back right before
  `LoadCompleted` — found only after revisiting the methodology directly ("I am wondering if
  there is more in the total captured data that we are missing/inadvertently ignoring") when two prior
  narrow, hypothesis-driven greps of the same full capture had both missed it. A genuinely complete,
  systematic frame-type-sequence extraction of every frame (not a targeted grep) is what actually found
  this gap.
- **Fix 5 (no code change, a corrected understanding) — the `LoadData` "mode" byte.** Originally guessed as
  a "combined full+par declaration" flag (see the original Fix-1 section above, `mode=0x01` "possibly...").
  A dedicated real-hardware experiment — three consecutive user-triggered ETS downloads (Full, Partial
  NTP-off, Partial NTP-on), captured and split into
  `2026-08-28-ets-{1,2,3}-*-1.1.9.pcapng` (`docs/data/captures/`, knx-ets-manager repo) — showed the mode
  byte is `0x00` on **both** independent Partial Downloads despite the model still declaring `full`+`par`
  RelSegment entries for objIdx 4, while the Full Download showed `0x01`. Real meaning: Full(`0x01`) vs
  Partial(`0x00`) download type. This on its own stopped the erasure-to-`0xFF` behavior seen before, but
  still didn't make a targeted new value persist — a real, necessary, but not sufficient fix.
- **The decisive experiment — verbatim frame replay.** Rather than keep guessing, built
  `POST /bus/replay-frames` (`server/routes/bus.ts` + `KnxBusManager.replayFrames()`,
  `server/knx-bus.ts`, commit `541c134`) to fire the real captured Partial-Download-NTP-off frame sequence
  (all 49 ETS→device request frames from `2026-08-28-ets-2-partial-download-ntp-off-1.1.9.pcapng`, extracted
  and byte-verified) at real hardware **verbatim** — no koolenex APDU reconstruction at all, just the raw
  bytes replayed through the existing tunnel. **This persisted correctly**
  (`2026-08-28-verbatim-replay-success-1.1.9.pcapng`): `0x5F53` read back `0x00` after reconnect, matching
  ETS's own real written value exactly. This proved the wire-level content itself is sufficient — the
  remaining bug was entirely in koolenex's own reconstruction, not anything fundamental about the device,
  the network path, or KNX Secure/tunneling behavior.
- **Fix 6 (`68c0394`) — the actual final bug: legacy vs extended memory write.** Diffed koolenex's own
  `/bus/write-memory` reconstruction of the identical operation (same address `0x5F53`, same count, same
  data, mode-byte fix from Fix 5 already applied) frame-by-frame against the successful verbatim replay.
  Captured as `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` — confirmed to silently fail to persist,
  twice reproducibly. The diff found exactly one byte-level difference: koolenex's `WriteRelMem` loop
  (`server/knx-connection.ts`) picked legacy `A_Memory_Write` for this chunk because `addr <= 0xFFFF`
  (`0x5F53` fits easily), while real ETS used `A_MemoryExtended_Write` unconditionally — confirmed via raw
  hex decode, not tshark's own (known-unreliable, see the note in the original Fix-1 section) summary
  column. This device's application program apparently only honors the extended service on the
  RelSegment-gated download path; the legacy write is a **silent** no-op — no error, no rejected-write
  signal, nothing — which is exactly why every earlier fix (1 through 5) succeeded at the protocol level
  (correct Load State transitions, correct `PropValueResp ... $01` confirming "Loaded", correct `Restart`)
  while the underlying byte write itself was quietly ignored the whole time. Originally shipped (commit
  `68c0394`) as an unconditional rule — removed the `addr > 0xFFFF` conditional entirely, `WriteRelMem`
  always uses `A_MemoryExtended_Write` — see "Fix 6, corrected" below for why that generalization was
  wrong and what replaced it.

## Fix 6, corrected: gate on the device's real mask version, not a blanket rule

"Always extended" doesn't hold up on inspection: it was generalized from real-hardware evidence on
exactly two devices (1.1.9, 1.1.10), both tested only because they happened to be available on this
testbed — not because they were chosen to represent device diversity. The real question: *"is it
possible that the manufacturer device library has some config value that specifies this? Can you trawl
through the ETS project file and make sure we have not missed anything."*

**Trawled the project's own bundled KNX Master Data** (`data/knx_master_<projectId>.xml`, ETS's own
standardized reference table, not manufacturer-specific config — every project bundles the same one).
Its `<MaskVersion>` elements carry a `ManagementModel` attribute per mask-version family: `Bcu1` (masks
`0010`-`0013`, `0900`-`091A`), `Bcu2` (`0020`-`0025`), `PropertyBased` (`0300`), `BimM112` (`0700`-`0705`,
`1900`, `5705`), and — the one that matters here — **`SystemB`** for masks `07B0`/`17B0`/`27B0`/`57B0`
(TP/PL/RF/IP medium variants of the same device generation). This is a real, standardized KNX
classification bundled in every project, not a guess.

**Checked both real tested devices' actual mask version** via a live `A_DeviceDescriptor_Read` against the
real testbed:

```
1.1.9  → descriptor "07b0"
1.1.10 → descriptor "07b0"
```

Both are `MV-07B0` = `ManagementModel="SystemB"`. This confirms "always extended" was correct for *these
two devices specifically*, because they're both System B — not because it generalizes. A genuinely older
BCU1/BCU2/System-7-family device (mask outside the `xxB0` pattern) has never been tested against this write
path and could still require the legacy service; the blanket rule would have silently broken it the exact
same way the original bug broke System B writes.

**Fix** (commit `95805ff`): `WriteRelMem` now reads the device's real mask version via
`A_DeviceDescriptor_Read` at the very start of any RelSegment-driven download session — mirroring what real
ETS itself does (every capture this project has starts with a `DevDescrRead`, almost certainly for this
exact reason) — and gates the memory-write service on it: `A_MemoryExtended_Write` unconditionally when the
mask's low byte is `0xB0` (confirmed System B), falling back to the original conservative address-size
heuristic (`addr > 0xFFFF` → extended, else legacy) when the mask is unread or doesn't match a recognized
System B pattern, rather than assuming the blanket rule holds. Reconfirmed on real hardware afterward:
1.1.9's NTP-source byte flipped `0x80`↔`0x00` correctly through this refined path across 3 more real
downloads/reconnects.

## Final resolution: confirmed on real hardware

After Fix 6 (corrected), the NTP-server-source parameter at 1.1.9 (`0x5F53`) was flipped
`0x80`→`0x00`→`0x80`→`0x00`→`0x00`→`0x80` across seven separate real downloads/reconnects total (four
against the original unconditional Fix 6, three more against the corrected mask-gated version), each value
independently confirmed via a fresh `read-memory` call after a full disconnect/reconnect cycle. The write
path genuinely works now, for confirmed System B devices at least (a real legacy/non-System-B device has
never been tested against this write path at all — see "What this does and doesn't settle" below — and
1.1.10, the still-unidentified objIdx 3, and the GA/Association table format for objIdx 1/2, all remain
open).

## Retroactive implication: the 2026-08-26 "write path proven correct" finding is now unsafe to rely on

That finding (koolenex-driven download vs fresh ETS-native download, `actualHex` diffed directly,
0/10433 bytes differ) used **1.1.10**, an app with the same `RelSegment`-based load-procedure shape as
1.1.9 (confirmed - see `docs/data/apps/M-0004_A-3030-23-F0EA-O000A.json`'s `loadProcedures`, which also
opens with two `RelSegment` steps). If the same gap applies there (not yet independently re-tested, but
there is no reason to expect otherwise - same step type, same missing switch case), the most likely
explanation for that "success" is a false positive: koolenex's download was a no-op, so "device state
after koolenex's no-op" trivially equals "device state ETS had just written moments before" - identical
readbacks that look like proof of a working write, produced by a write that never happened.

**Don't cite that 2026-08-26 result as evidence the write path works** until it's re-run against a real
fix for this gap.

## What this does and doesn't settle

**Settled**:
- Root cause of every failed/no-op write attempt this project has made against 1.1.9: six compounding gaps
  (Fixes 1-6 above), the last and most stubborn being a silent legacy-vs-extended memory write mismatch
  with no error signal of any kind.
- The real wire format for `LoadData` (the `RelSegment` step's real on-the-wire shape, mode byte meaning
  finally settled as Full/Partial), decoded from real examples across both a Full and two independent
  Partial Downloads.
- `A_Authorize_Request` and `PID_PROGRAM_VERSION` write-back are both required parts of the real sequence,
  not optional.
- `WriteRelMem` must use `A_MemoryExtended_Write` for a confirmed System B device (mask `0x07B0`,
  identified via a live `A_DeviceDescriptor_Read` and this project's own bundled KNX Master Data's
  `ManagementModel` classification), regardless of address size - gated on the real mask, not a blanket
  rule (see "Fix 6, corrected" above).
- **The write path works**: confirmed reproducibly on real hardware (1.1.9, a confirmed System B device),
  seven separate real downloads/reconnects total, byte flipped both directions correctly every time.
- A separate, unrelated byte-packing bug in `buildParamMem()`'s padding-bit fill (still not fixed - see
  below).

**Not yet done / open**:
- The `buildParamMem()` padding-bit fill bug - root-caused, not fixed. Real device value is `0x80` (bit 7
  set, others clear); koolenex fills the other 7 "padding" bits with `1`s instead of `0`s.
- Whether 1.1.10 (and any other `RelSegment`-family device) needed all six fixes too, confirmed empirically
  rather than by analogy - not yet re-tested since these fixes landed. The 2026-08-26 "write path proven
  correct" finding for 1.1.10 specifically should still not be cited until it is (see "Retroactive
  implication" below). (1.1.10 is also mask `0x07B0` per a live check, so it should take the
  same System B code path once re-tested - not yet confirmed for the WriteRelMem path specifically.)
- The GA/Association table (objIdx 1/2) wire format - still uses a guessed format, unfixed (per the
  2026-08-27/28 GA-wire-format work).
- What objIdx 3 actually is (still just "possibly per-channel mapper config", unconfirmed, per the
  2026-08-27 doc).
- **A genuinely legacy (non-System-B) device has never been tested against this write path at all.** The
  mask-gating fix's fallback branch (address-size heuristic for non-System-B/unrecognized masks) is
  currently only protocol-level-tested (fake device, `tests/relmem-write-protocol.test.ts`), not confirmed
  against real BCU1/BCU2/System-7 hardware - if/when a real device of that family becomes available for
  testing, this is the next thing to verify. Don't assume the fallback is correct just because it's
  conservative and mirrors the pre-08-28 behavior; it's never been proven against real hardware, only the
  System B path has.
- **Longer-term**: none of these fixes came from fixing the *model extraction* (how `model.loadProcedures`
  is built from real project XML during import) - they're all in the hand-written `downloadDevice()`
  executor. The original Fix-1 writeup's "two shapes to choose between" framing (fix the importer vs.
  reconstruct generically in the executor) was effectively resolved in favor of the executor approach by
  default, not by a deliberate decision - worth revisiting once more apps/devices are tested, since a
  model-extraction fix would generalize automatically where the executor approach needs each new
  requirement (Auth, PID13, mode byte, extended-vs-legacy) hand-added.

## Artifacts

- Capture: `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` (`docs/data/captures/` in the knx-ets-manager
  repo, already saved for the GA/Association table wire-format work) - the real ETS Full Download used to
  decode the `LoadData` format above.
- Capture: `2026-08-28-koolenex-write-attempt-1.1.9.pcapng` (same folder) - koolenex's own failed write
  attempt from Fix 1's investigation, showing the missing Load sequence directly on the wire (raw `MemWrite`
  straight after the PID-7 resolve, no `PropValueWrite ... P=5` anywhere).
- Captures: `2026-08-28-ets-{1,2,3}-{full,partial-ntp-off,partial-ntp-on}-download-1.1.9.pcapng` (same
  folder) - the three consecutive real ETS downloads used to settle the LoadData mode-byte meaning (Fix 5)
  and as the source frames for the verbatim replay (below).
- Capture: `2026-08-28-verbatim-replay-success-1.1.9.pcapng` (same folder) - koolenex replaying the real
  Partial-Download frames verbatim; succeeded, pinning the remaining bug to koolenex's own reconstruction.
- Capture: `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` (same folder) - koolenex's own
  reconstruction of the identical operation, captured specifically to diff against the verbatim replay;
  this diff found Fix 6.
- Endpoint: `POST /bus/write-memory` (`server/routes/bus.ts`) - writes an exact byte sequence to an
  absolute address, reusing the real `downloadDevice()`/`WriteRelMem` path (not a separate implementation).
  Optionally opts into the real Load State sequence via a `relSegment` param. Real-hardware debug tool, not
  intended for routine use.
- Endpoint: `POST /bus/replay-frames` (`server/routes/bus.ts` + `KnxBusManager.replayFrames()` in
  `server/knx-bus.ts`) - replays a literal sequence of real captured CEMI frames verbatim, no
  reconstruction at all. Built for, and instrumental in, the decisive experiment above. Real-hardware debug
  tool, not intended for routine use.
- `koolenex-reference` memory (knx-ets-manager repo's persistent memory) has the fuller methodological
  history, including the 2026-08-28 update documenting all six fixes and the final resolution.
