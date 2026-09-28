# Partial-download mode, Object 3 trigger test, and full record-layout decode

**Status: implementation history and narrative.** Distilled protocol facts belong in
`docs/knx-device-write-protocol.md` (§4.2 for partial-mode, §6.4 for Object 3) — this is the "how
did we get here" record.

## Part 1: building partial-download mode

Checked directly: no partial/delta mode existed anywhere in koolenex — every call performed the
equivalent of a Full Download.

Added `DownloadExtra.mode: 'full' | 'partial'` to `downloadDevice()`. `'full'` is byte-for-byte the
pre-existing behavior. `'partial'`: before touching an interface object, read its current on-device
content within the same session and compare to the computed image; if it matches, skip the entire
Unload/StartLoading/LoadData/write/LoadCompleted cycle for that object. When a write does happen,
the LoadData mode byte is forced to the real captured Partial value (`0x00`).

Exposed via `POST /bus/program-device`'s `mode` field. New tests:
`tests/partial-download-mode.test.ts` (a fake device answering both reads and writes). All 1198
tests pass. Commit `5ac9aef`.

## Part 2: real-hardware round trip, first try

Against 1.1.9: (1) changed GA 9/1/4→9/1/5 via real ETS Full Download, verified via
`/bus/verify-device` and decoded the capture directly; (2) koolenex Full Download (stale project)
reverted the device to 9/1/4, verified; (3) re-imported the current project (9/1/5) and ran the new
`mode: 'partial'` download — verified `actualValue: "9/1/5"`, `totalDiffering: 0` across all 13
rows.

The capture decode confirms it's a real result: the parameter segment and Association table
(genuinely unchanged) were read, compared, and the whole load-state cycle skipped for each — only
the GA table was written, LoadData mode byte correctly `0x00` (Partial).

## Part 3: the Object 3 trigger test — genuinely inconclusive for 1.1.9

The plain Full Download in Part 2 also wrote Object 3 — tested directly against the standing "why
does ETS only rewrite Object 3 on some Full Downloads" question: deliberately tampered with the
device out-of-band (wrote `000249014904` via `/bus/write-memory` bypassing any project), left ETS's
project unchanged (still 9/1/5), ran a real Full Download.

Result: ETS detected and corrected the tampering, and wrote Object 3. But cross-checked against
every other 1.1.9 Full Download capture, including two clean untampered ones: **every single 1.1.9
Full Download ever captured writes Object 3**, tampered or not. This test can't distinguish
"triggered by tampering" from "1.1.9's app always rewrites Object 3 unconditionally" — the wrong
device was tested for this question. The variation has only ever been observed on 1.1.10 (a single
2026-08-28 session, 2 of 4 downloads).

## Part 4: Object 3's content decoded — a real per-communication-object flag bitfield

Two framing corrections: Object 3 is not the GA holder (that's object 1); Object 3 holds
per-communication-object flags (confirmed via KNX Master Data, per the prior follow-up doc).

Flipped the Update flag on com-object 7 via a real Full Download: Object 3's 98-byte payload
differed at exactly one byte (offset 14, `0x53`→`0xD3`, XOR `0x80`). A second test reverted that and
flipped Read-On-Init on com-object 6: offset 14 correctly reverted, a different byte (offset 12)
changed instead (`0x53`→`0x73`, XOR `0x20`) — two clean, independent mappings, 2 bytes apart.

## Part 5: the "GA never touched on Partial Download" claim was wrong — confounded, not tested

Every Partial Download capture at the time happened to have zero GA changes — "never touched" and
"only touched when a GA changes" were indistinguishable from that data. Tested directly, both
directions: real GA change via genuine Partial Download fired OX=1/2/3, correctly skipped OX=4;
reverting the same change plus a flag revert, same result. **Conclusion**: on Partial Downloads, GA
table/Association table/Object 3 are written together exactly when a GA/link genuinely changes,
skipped together otherwise.

## Part 6: systematic 1.1.10 redo, and the checksum-read discovery

Ran five real Full Downloads to 1.1.10 in sequence (two clean, one out-of-band tamper, two genuine
ETS-driven changes including a same-byte control matching the tamper test). The tampered download
was the only one that wrote Object 3.

Re-examining the capture data (prompted by a direct challenge to a prior "no live memory read"
claim) surfaced that ETS reads `PropertyValue_Read OX=4 P=27` early in every session — every genuine
session got the identical valid response; only the tampered session got empty (`N=0`). This is the
real detection mechanism for the comprehensive-rewrite fallback — not a raw memory read, but a
property-level checksum whose result differs based on real device state.

## Part 7: full bit-by-bit mapping of Object 3's record layout, cross-device confirmed

Toggled one communication-object flag at a time on com-object 7 (1.1.9), confirming a single clean
bit flip each time. Verified on a second object (6): Update/Read landed exactly where the offset
formula (`2 × object number`) predicted, including a two-flags-simultaneous case computed correctly
before decoding. Verified blind on 1.1.10 (different device/app): predicted the expected default
byte from the app's own XML, diffed against the real capture, correctly identified the Write flag as
the single change before being told the answer.

**Result**: `offset = 2 × com-object number`, `bit7=Update, bit6=Transmit, bit4=Write, bit3=Read,
bits1:0=Priority (Low=11/Alarm=10/High=01/System=00 inferred)`; Communication initially found to
have "zero representation" (later corrected, Part 9). Cross-confirmed on three objects, two
devices/apps.

**Still open at this point**: bits 2 and 5 unmapped; Priority=System untested; whether the structure
holds on a non-System-B mask family.

## Part 8: closing the byte — bit 2 (GA-link correlation) and a blind multi-change test

A sanity check on object 5 (linked, 8-byte DPT) found a discrepancy: predicted default `0x4B`
didn't match real `0x4F` — a difference of bit 2. Object 5 has a real GA link, while every other
object tested (6, 7, 96) did not — testable hypothesis: bit 2 tracks link presence.

Blind test 1: toggled Read-On-Init on object 5 — offset 10 went `0x4F`→`0x6F`, XOR `0x20` = bit 5
(Read-On-Init), independently reconfirmed. Blind test 2 (two simultaneous changes, undisclosed):
Read-On-Init reverted on object 5, GA link removed on object 8 — both correctly decoded from the
capture alone: offset 10 reverted; offset 16 bit 2 cleared, and the GA/Association tables correctly
shrank.

**Result**: every bit now has an observed role — `7=Update, 6=Transmit, 5=Read-On-Init, 4=Write,
3=Read, 2=GA-link (correlational), 1:0=Priority`. Scope note: bit 2 is documented as a real,
reproduced correlation with GA-link presence, not proven to be *only* that (link count, specific GA,
direction all rode along in every test so far).

## Part 9: offset reindexing, and a real correction to the Communication-flag finding

Test: disabled Communication on object 6, checked whether higher-numbered objects' offsets moved.
They didn't — the offset formula is safe unconditionally.

A sharp objection surfaced: disabling Communication should physically stop the device responding,
so something must be written. Right — exposed a real confound: every prior Communication toggle
was on an *unlinked* object, exactly what an AND-gated bit pinned at 0 by the missing link would
look like regardless of the flag's own effect.

Decisive test: disabled Communication on object 5 (already linked, link left untouched). GA/
Association tables unchanged (link genuinely still there); Object 3's bit 2 still dropped to 0. Two
independent routes to the same bit — proof it has a real effect, not just a correlation.
**Corrected finding**: bit 2 = `Communication flag AND has a real GA link`, both required.

## Part 10: multi-link test, Priority=System resolved, documentation cleanup

Multi-link test: added a second GA link to object 5 (re-enabling Communication first). Bit 2
stayed `1`, byte-for-byte identical to the single-link case — confirms bit 2 is a plain boolean
("has at least one link"), not link-count-sensitive.

Priority=System: confirmed via KNX's own documentation (support.knx.org) as unreachable from ETS's
UI at all — no real project can exercise it, closing that question without further testing.

Removed correction-narrative paragraphs from the reference doc itself (kept only in this follow-up)
per the project's own docs convention: facts in the reference doc, narrative in follow-ups.

## Part 11: link direction (Send vs receive-only) — lives in Association-table order, not Object 3

ETS's rule: direction isn't independently settable — the first-added link sends, subsequent links
are receive-only. Test: swapped which of two GA links on object 5 sends (removed and re-added).
Object 3 and the GA table stayed byte-for-byte unchanged; the Association table's two entries
swapped position.

**Conclusion**: link direction is real, written to the device, but encoded as Association-table
*order*, not a per-entry flag and not anything in Object 3. This closes Object 3's decode as fully
as this testbed can take it. **Standing gap**: only System B mask family has ever been tested.

## Part 12: wiring Object 3 into the real write path, and a latent LoadImageProp bug

Investigation found the parser only captures C/R/W/T/U — Read-On-Init and Priority, both needed for
Object 3's byte, aren't extracted anywhere. Blocks building a real `groupObjectTable` for now.
Independently useful: `ga_send`/`ga_receive` columns already correctly implement "first link sends"
without having been verified against real hardware before.

Added `DownloadExtra.groupObjectTable?: Buffer | null` and an invocation guarded by
`!declaredTableObjIdxs.has(3)`.

**Real bug found while implementing this**: `declaredTableObjIdxs` was built from both
`WriteRelMem` and `LoadImageProp` step types — wrong, since `LoadImageProp` is read-only for every
objIdx (per Part 7's finding). For 1.1.10's app (declares `LoadImageProp` for objIdx 1/2/3), this
silently suppressed the GA/Association undeclared-table fallback the whole mechanism exists to
provide — never caught because that fallback had only been validated against real ETS's own
captures, never exercised through koolenex's own write path for 1.1.10. Fixed by filtering to only
`WriteRelMem` steps. Two existing tests updated (both had pinned the old, wrong behavior). All 1225
tests pass. Commit `9eaed85`.

**Still not done**: no caller constructs a real `groupObjectTable` yet; Object 3's write itself has
never been exercised against real hardware through this code path.

## Part 13: closing the Read-On-Init/Priority parser gap

Confirmed real attribute names against the live app XML directly: `ReadOnInitFlag="Enabled"/
"Disabled"`, `Priority="Low"/"Alarm"/"High"/"System"`, both overridable per `ComObjectRef`.

Extended `CoDef`/`CorDef` with `readOnInit`/`priority`; added `normalizePriority()`. Threaded
through `ets-parser.ts`'s `ParsedComObject`, `db.ts`'s `com_objects` (new `read_on_init`/`priority`
columns), `routes/projects.ts`'s insert. 5 new tests. All 1230 tests pass. Commit `7301f4b`.

## Part 14: wiring buildDeviceProgramming() to construct and pass a real Object 3

Real blocker: Object 3's table size (98/942 bytes) has no obvious source in per-device data.
Counted real `<ComObject>` declarations directly from the live project XML: 1.1.9's app declares 48
(highest `Number="48"`), 1.1.10's declares 470 — `2×48+2=98` and `2×470+2=942`, both exact matches.
This is the app's total static declaration count, not a device's currently-linked subset.

Added `AppIndex.maxComObjectNumber`, threaded into `ParamModel.groupObjectTableSize`. `bus.ts`'s
`buildDeviceProgramming()` reads it back, builds a real `GroupObjectFlags[]` from `com_objects`.

**Bug caught before shipping**: the DB only stored the composite `flags` display string, which has a
lossy all-false fallback (`'CW'`) unsafe to parse back into booleans. Added dedicated `read`/
`write`/`comm`/`tx` raw columns, mirroring Part 13's treatment. `Update` alone provably always safe
to derive from the string (the fallback text contains no `'U'`).

**A second bug, same class**: `/bus/verify-device`'s own `declaredTableObjIdxs` check had the exact
same LoadImageProp bug Part 12 fixed on the write side. Fixed identically; no pinned tests existed
for it. 2 new tests. All 1232 tests pass. Commit `99d545a`.

## Part 15: first real dry-run comparison against a real captured write

Drove the real pipeline (in-memory DB, real parser, real `_buildDeviceProgramming`) against the
live Test Bed `.knxproj`, comparing `built.groupObjectTable` for 1.1.9 against the chronologically
last real Object 3 write of the whole session.

**Result**: 93/98 bytes matched exactly, including every one of 23 real "Mapper object" channels
and every flag bit except one. Diagnosed the 5 diffs: the same capture's own Association table write
shows zero entries for object 8, while the live project now declares a GA link for it (added since,
never re-downloaded) — explains the one flag-byte diff as real state drift, not a bug.

**4 remaining diffs, left open**: bytes at offsets 1/7/9/11 hold real nonzero content specific to the
app's built-in "internal clock" objects (0/3/4/5) — every other odd byte in the buffer, including
all 23 Mapper channels, is correctly zero on both sides. One speculative, explicitly-unconfirmed
theory: firmware-internal state for these built-in objects. **Solved in Part 17.**

## Part 16: real controlled test on the mystery padding byte — one clean negative result

Toggled Read-On-Init on object 3 (`UhrzeitGO`), real Full Download, diffed against Part 15's
capture byte-for-byte: exactly 1 byte differs, offset 6 (`0x4B`→`0x6B`, the predicted bit) — a third
clean confirmation of the record layout. The mystery byte at offset 7 stayed identical. Rules out
"it's another undecoded flag," at least for Read-On-Init on this object — doesn't confirm the
firmware-state theory either way.

## Part 17: mystery byte solved — the KNX standard Group Object Size code, plus a real header

Scanned all 28 real 1.1.9 captures across the whole investigation: the 4 companion bytes are
byte-for-byte identical in every single one — never move under anything (object 8's own flag byte,
by contrast, correctly varied, confirming the scan methodology was sound).

Tested the Data Type hypothesis using real DPT data pulled from both apps' XML. 1.1.10's one
reconstructable full 942-byte capture yielded a repeating 6-byte pattern across 4 evenly-spaced
per-channel objects; their real DPTs gave companion bytes `0x03`/`0x07`/`0x07` — objects sharing the
same real ETS `ObjectSize` share the same companion byte regardless of DPT identity, a size class.
Checked against the well-known KNX standard "Group Object Size" 4-bit code table: 4 for 4 exact
matches (3, 7, 9, 12).

Bytes 0-1 (previously read as "object 0's slot", always `0x00 0x30` on 1.1.9) don't fit the
size-code table (0x30 alone is out of range 0-15). Read as a big-endian 16-bit value: `0x0030` = 48;
1.1.10's `0x01D6` = 470 — both exactly match `maxComObjectNumber` (Part 14). A genuine 2-byte
header giving the app's total declared object count, not a per-object slot.

**Implementation**: `groupObjectSizeCode()` (`server/routes/knx-tables.ts`) maps ETS's real
`ObjectSize` strings to the 4-bit code, defaulting unrecognized input to `0`. `GroupObjectFlags`
gained `objectSize`. `buildGroupObjectTable()` writes the real header (`(size-2)/2`) and each
object's companion byte. `bus.ts` passes `objectSize: co.object_size` through (already captured by
Part 13's parser work, just never wired in).

11 new tests in `tests/group-object-table.test.ts`, including a full 98-byte real-capture
reproduction from a realistic `GroupObjectFlags[]`. All 1243 tests pass. Commits `a4a9864`
(implementation), `feb1132` (reference doc).

**Re-ran the Part 15 dry-run after the fix**: 97/98 bytes now match exactly (up from 93/98) — the
one remaining diff is object 8's already-explained state-drift case, not a new gap. **This closes
every open question about Object 3's byte-level content format** — 2 bytes per communication object
(flag byte + size-code byte) plus a 2-byte header. Standing gap unchanged: only System B mask
family, two devices, one testbed.

## Part 18: Object 3's write CONFIRMED on real hardware, first attempt

Last standing gap: Object 3's write had never been independently exercised against real hardware
through koolenex's own code path.

**Scope decision**: `buildDeviceProgramming()` always builds GA/Association/Object 3 together, and
the live project currently declares a GA link for object 8 the device doesn't have (Part 15) — a
full `/bus/program-device` write would silently push that change too. Chose a surgical
Object-3-only write instead: confirmed by reading `downloadDevice()`'s source that the Object 3
invocation depends only on `extra.groupObjectTable`/`declaredTableObjIdxs`, independent of
`gaTable`/`assocTable`/`paramMem`/`steps` — `downloadDevice(addr, [], null, null, null, onProgress,
{ groupObjectTable, mode: 'full' })` writes only Object 3.

**Result: clean write, first attempt.** Real protocol sequence completed exactly as expected:
`DeviceDescriptor_Read` (mask `0x07b0`) → `Authorize` → Unload/StartLoading/LoadData/LoadCompleted
for objIdx 3 → `Restart` → done. koolenex chunked the 98 bytes into 10-byte `MemExtWrite` frames at
base `0x00570C`.

One transient `Tunneling ACK timeout` on the first read-back attempt, correctly recognized as
benign (the device briefly unresponsive right after Restart — the same "Restart race" finding from
`2026-08-28-write-path-missing-load-sequence.md`). A fresh connection a few seconds later verified
cleanly.

**Verification: exact match, all 98 bytes**, byte-for-byte identical to what was computed and
written — the same value the Part 17 dry run computed. Confirms both the computation AND the write
mechanism itself now work end to end on real hardware.

Capture: `2026-08-29-koolenex-first-real-object3-write-1.1.9.pcapng`. **This closes the entire
Object 3 investigation** — decode, write-trigger wiring, data availability, the mystery byte, and
now real-hardware write confirmation. Standing gap unchanged: only System B mask family tested.

## Part 19: /bus/verify-device extended to Object 3, and a third LoadImageProp bug

**A third copy of a bug already fixed twice**: `knx-download-plan.ts`'s `buildGaAssocMem()` (used by
`planVerify()`, which `/bus/verify-device` calls) still had the exact LoadImageProp bug from Part
12 — no dedicated unit tests existed for `planVerify()` at all before this. Fixed identically.

`VerifyPlan.gaAssocMem` renamed to `undeclaredTableMem` to reflect covering a third table. Object
3's comparison uses a simpler direct fixed-length read than GA/Association's dynamic count-probe,
since its size (`groupObjectTableSize`) is a static per-app value known before any read happens.
Added `decodeGroupObjectEntry()` (the inverse of `buildGroupObjectTable()`'s placement) so Object 3
gets the same "one named row per communication object" treatment GA rows already have.

New `planVerify()` test suite in `tests/knx-download-plan.test.ts` (none existed before); extended
`tests/bus-routes.test.ts`'s `MockBus` fake device to serve Object 3 reads. 6 new tests, all 1249
pass. Commits `f2ad425` (implementation), `b5d1657` (reference doc).

## Part 20: buildParamMem()'s padding-bit fill bug fixed

The bug was already root-caused on 2026-08-28: a real 1-bit boolean at offset 69, real device value
`0x80` when on (bit 7 set, other 7 bits clear), koolenex computing `0xFF`/`0x7F` because padding
bits sharing that byte got the generic `fill` value instead of `0`.

**Fix**: a pre-pass over `paramMemLayout` before the main write loop, zero-filling any byte a
sub-byte field occupies — with an explicit skip for bytes within `relSegHex`'s coverage range (the
one app seeding the buffer with a real captured default rather than plain `fill`), to avoid
clobbering its own correct padding bits.

No new real-hardware capture was needed — the real byte value (`0x80`/`0x00`) was already
established in the 2026-08-28 investigation, so a synthetic unit test against that known value was
sufficient. 6 new tests, all 1255 pass (one arithmetic slip in the test itself, `0x88` vs the
correct `0x90` for two combined bits, caught immediately by the test failing before being fixed).

This closes a real, standing write-correctness bug independent of the write-path mechanism itself
(already proven working).
