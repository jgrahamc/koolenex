# 2026-08-29: partial-download mode built, real-hardware round trip, and an Object 3 trigger test

**Status: implementation history and narrative.** Distilled protocol facts belong in
`docs/knx-device-write-protocol.md` (Part 11 for the partial-mode facts, Part 10 for the
Object 3 update) - this file is the "how did we get here" record: code changes, commit
hashes, methodology, and the honest result of a test that turned out inconclusive.

## Background

User picked up the still-outstanding "write path" work with an explicit ask: revert a GA
change (9/1/4 → 9/1/5, set via a real ETS Full Download) back using koolenex, specifically
via "a partial download mode." Checking `POST /bus/program-device` and `downloadDevice()`
directly (not assuming) showed **no partial/delta mode existed anywhere in koolenex** -
every call, regardless of intent, always performed the equivalent of a Full Download.

## Part 1: building partial-download mode

Added `DownloadExtra.mode: 'full' | 'partial'` to `knx-connection.ts`'s `downloadDevice()`.
`'full'` (the default) is byte-for-byte the pre-existing behavior - no regression risk, all
1195 pre-existing tests pass unchanged. `'partial'` is new:

- Before touching an interface object (the parameter segment via `WriteRelMem`, or the
  synthesized GA/Association table writes via `writeUndeclaredTable`), read its current
  on-device content within the SAME management session (reusing the private
  `readRegionInSession` helper, previously only used by the read-only verify path) and
  compare it to the computed image. If it already matches, skip the ENTIRE
  Unload/StartLoading/LoadData/write/LoadCompleted cycle for that object - not just the
  memory-write chunks, the whole thing, mirroring the "17 bytes only, rest skipped"
  optimization observed in an earlier real ETS Partial Download capture (see the reference
  doc's §1.2).
- When a write does happen, the LoadData mode byte is forced to the real captured Partial
  value (`0x00`) instead of following the model's own declared full/combined shape (which
  `'full'` mode still follows unchanged).

Exposed via `POST /bus/program-device`'s new `mode` body field (`z.enum(['full',
'partial']).optional().default('full')`).

New test coverage: `tests/partial-download-mode.test.ts` (3 tests) - a self-contained
protocol-level fake device that answers both reads AND writes against its own backing
buffer (existing fixtures only handled one or the other). Locks in: (1) the object is
skipped entirely when it already matches, (2) it's written with mode byte `0x00` when it
genuinely differs, (3) `'full'` mode's behavior is completely unaffected either way. All
1198 tests pass (1195 existing + 3 new). Typechecked clean.

Commit `5ac9aef` on `test/relmem-real-device-fixtures`, pushed.

## Part 2: real-hardware round trip, first try

Against 1.1.9 (local testbed):

1. User changed GA 9/1/4→9/1/5 in ETS, ran a real Full Download - captured
   (`2026-08-29-ets-full-download-ga-9-1-4-to-9-1-5-1.1.9.pcapng`, knx-ets-manager repo).
   Verified directly against the device via `/bus/verify-device` (not inferred from ETS's
   own report): `actualValue: "9/1/5"`. Decoded the capture directly too:
   `MemExtWrite X=$004000 $000249014905` is the real GA table write; `MemExtWrite
   X=$00470A $00020001000500020008` the Association table, independently confirming the
   GA-index↔com-object mapping.
2. koolenex Full Download (existing `mode: 'full'` default, against a stale cached project
   still declaring 9/1/4) reverted the device to 9/1/4 - verified directly
   (`totalDiffering: 0`).
3. Re-imported the current, now-updated `.knxproj` (declaring 9/1/5 again, post step 1) as
   a fresh koolenex project. Ran the brand-new `mode: 'partial'` download against the same
   device - captured (`2026-08-29-koolenex-partial-download-revert-9-1-5-1.1.9.pcapng`).
   Verified directly: `actualValue: "9/1/5"`, `totalDiffering: 0` across all 13 rows.

**The capture decode is what makes step 3 a real confirmation, not just a passing test**:
the parameter segment (objIdx4, 8178 bytes, genuinely unchanged) and the Association table
(objIdx2, 10 bytes, genuinely unchanged) were both read, compared, and the entire
load-state cycle was skipped for each - no `PropValueWrite OX=4` or `OX=2` frames anywhere
in the capture. Only the GA table (objIdx1, the one real change) was written, with the
LoadData mode byte correctly `0x00` (Partial), not the `0x01` (Full) byte seen in every
earlier Full Download capture.

## Part 3: the Object 3 trigger test - result is genuinely inconclusive, not positive

Separately, reviewing today's own captures surfaced that the plain ETS Full Download in
step 1 above **also wrote Object 3** - worth a direct check against the standing open
question from the reference doc's Part 10 (why does ETS only rewrite Object 3 on *some*
Full Downloads?). The leading pattern from 1.1.10's 08-28 session was "only after an
out-of-band write" - user proposed testing that directly on 1.1.9: deliberately tamper with
the device out-of-band, leave ETS's project unchanged, and see if a real Full Download both
corrects the tampering AND writes Object 3.

**Setup**: resolved the GA table's live base via `POST /bus/read-property`
(`objIdx=1, propId=7` → `0x4000`), then used `POST /bus/write-memory` with a real
`RelSegment` load sequence (`objIdx=1, size=6, fill=0, combined=false`) to write
`000249014904` (GA 9/1/1 + 9/1/4) directly into device memory - bypassing any project
entirely. Confirmed via `POST /bus/read-memory` that this genuinely persisted
(`000249014904`), while the koolenex-imported project (and ETS's own, unchanged) still
declared 9/1/5.

**Result**: user ran a real ETS Full Download of the unchanged project - captured
(`2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng`). ETS detected and corrected
the tampering (`MemExtWrite X=$004000 $000249014905`, confirmed via read-back) -
reconfirms Part 8's history-independence finding on a second device. Object 3's LoadData
(`OX=3 P=5 $030B...`) fired too.

**Why this doesn't actually confirm the hypothesis**: cross-checked against every other
1.1.9 Full Download capture this project has, including two clean captures with NO
tampering beforehand:

| Capture | Tampering beforehand? | Object 3 written? |
|---|---|---|
| `2026-08-28-ets-1-full-download-1.1.9.pcapng` | No | Yes |
| `2026-08-29-ets-full-download-ga-9-1-4-to-9-1-5-1.1.9.pcapng` (today, clean GA change) | No | Yes |
| `2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng` (this test) | Yes | Yes |

Every single 1.1.9 Full Download ever captured writes Object 3, tampered or not. The
tampering hypothesis predicts "written when tampered" - true here - but the untampered
baseline for 1.1.9 is *also* always "written," so this test cannot distinguish "triggered
by tampering" from "1.1.9's app always rewrites Object 3 on every Full Download,
unconditionally." The only place the hypothesis has actually been observed to vary is
1.1.10's single 08-28 session (2 of 4 downloads) - a genuinely different device/app
(different manufacturer app entirely, not just a different unit of the same one).

**Honest conclusion**: not confirmed, not refuted for 1.1.10 - genuinely inconclusive for
1.1.9 specifically, because the wrong device was tested for this particular question (its
baseline behavior doesn't vary, so no test on it can show a trigger). To actually settle
this, the next test needs to be on 1.1.10 (or another device known to sometimes skip
Object 3): a clean, untampered Full Download to confirm the "no write" baseline still
reproduces, followed by a deliberately tampered one, in a controlled A/B rather than relying
on the single historical 08-28 session alone.

## Part 4: Object 3's content decoded - a real per-communication-object flag bitfield

The trigger test's framing needed correcting twice, both corrections real and load-bearing:

1. **"Are you sure obj 3 is a GA holder?"** - a fair check given the name similarity between
   "Group Address table" (object 1) and "Group Object Table" (object 3). Clarified: they're
   different objects with different real content - object 1 holds the GAs themselves, object 3
   holds per-communication-object metadata (flags etc.), confirmed via KNX Master Data (Part 10).
2. **"Could obj 3 be related to communication flags?"** - a much better-targeted hypothesis than
   the tampering/uncertain-state theory, given what a Group Object Table actually is.

Tested directly: flipped the **Update** flag on com-object 7 (NTP sync input, off→on) via a real
ETS Full Download, nothing else changed. Object 3's own 98-byte payload differed from the
previous capture at **exactly one byte** (offset 14: `0x53`→`0xD3`), and those two values differ
by **exactly one bit** (`XOR 0x80`). A second test reverted that flag AND
flipped **Read-On-Init** on com-object 6 (Date/time input, off→on) - offset 14 correctly reverted
to `0x53` (confirming the first mapping wasn't a coincidence) while a *different* byte, offset 12,
changed instead (`0x53`→`0x73`, `XOR 0x20`) - a clean, independent second mapping. Both objects
sit 2 bytes apart, consistent with a small regular per-object record.

## Part 5: the "GA never touched on Partial Download" claim was wrong - confounded, not tested

This doesn't hold up (stated as fact in Part 4's own trigger-test framing above):
every Partial Download capture that existed at the time happened to have zero GA changes in it,
so "never touched" and "only touched when a GA changes" were indistinguishable from that data -
an overclaim, not a lie, but a real methodology gap. A systematic redo
of 1.1.10's 2-of-4 Full Download pattern is also needed before trusting it (a single historical
capture, never reproduced) - noted as still outstanding, not done yet.

Tested directly, twice, in both directions:
- Real GA change (9/1/4→9/1/5) via genuine Partial Download: `OX=1/2/3` all fired,
  `OX=4` (unrelated parameters) correctly skipped. (First attempt at this specific test was
  actually a Full Download by mistake - user caught and corrected it immediately; kept as a
  labeled record, not counted as a Partial Download result.)
- Reverting that same GA change (9/1/5→9/1/4) plus reverting the Read-On-Init flag from Part 4,
  same download: same result, `OX=1/2/3` fired, `OX=4` skipped, and Object 3's content correctly
  showed the flag reverted (offset 12 back to `0x53`).

**Clean, reproduced conclusion**: on Partial Downloads, GA table / Association table / Object 3
are written together exactly when a GA/link genuinely changes, and skipped together otherwise -
not "never touched," a real conditional trigger, symmetric in both directions. Full details and
the exact per-capture table: reference doc §10.2.

## Part 6: systematic 1.1.10 redo, and the checksum-read discovery

Treating 1.1.10's historical 08-28 2-of-4 Object 3 pattern as
settled turned out to be premature - it was a single, unreproduced capture session, and the two
"not written" cases could have been anomalies, methodology errors, or any number of other things.
A systematic, controlled redo was needed before forming any strong opinion - the right call, and
it paid off.

Ran five real Full Downloads to 1.1.10 in sequence, each separately captured: two genuinely clean
(no project changes at all), one with an out-of-band tamper (same offset-172 parameter used
throughout the original investigation, written via `/bus/write-memory` bypassing any project),
and - to test "does an intended project write to a parameter
also trigger Object 3" - two genuine, ETS-driven changes: a GA link re-point, and a change to the
*exact same* offset-172 byte the tamper test used, this time via ETS itself (confirmed by decoding
the resulting real write: `MemExtWrite X=$0C30AC $1E` = 30 decimal, matching the 30-second
"Display length" value set). Result table in the reference doc's Part 10.3 - the tampered
download was the only one that wrote Object 3, and the same-byte control (test 5) is what makes
this decisive rather than just "tampering vs nothing."

**Along the way, a genuine correction**: "are you 100% sure
ETS does not read anything from the device before it starts the full download?" - a fair
challenge to a claim in this document taken on faith rather than freshly re-checked. Re-examining
the actual capture data (not just recalling the earlier "no live memory read" finding) surfaced
that ETS DOES read something meaningful early in every session: `PropertyValue_Read OX=4 P=27`,
the same content-dependent checksum property already known from Part 7. Every genuine session
got back the identical valid 2-element response; only the tampered session's identical request
came back empty (`N=0`). This is the real detection mechanism for Part 8's comprehensive-rewrite
fallback - not a raw memory read (there genuinely are none, that part of the original claim
holds), but a property-level checksum whose result differs based on real device state. Full
decode: reference doc's Part 8 and Part 10.3.

**Lesson worth repeating**: the "no live memory read anywhere, detection mechanism unknown"
framing had stood unchallenged in this document since 2026-08-28 - re-verifying it from the raw
capture data (rather than trusting the prior write-up) is what surfaced the actual mechanism.
Don't assume an established claim in this doc is still fully checked just because it's tagged
🟢 - re-derive from source when it matters, especially when directly asked to confirm something.

## Part 7: full bit-by-bit mapping of Object 3's record layout, cross-device confirmed

User asked directly whether koolenex could now *build* Object 3 write packets, given the identity
and two flag mappings already known. Correct answer at the time: no - two bit positions out of a
98/942-byte object, no known record layout or offset formula, no idea whether Communication or
Priority were even represented. User: "let's investigate in turn and try to break the back on
this one."

**Methodology**: toggled one communication-object flag at a time on com-object 7 (1.1.9),
comparing each capture's Object 3 payload against the immediately preceding one, confirming a
single clean bit flip each time before moving to the next flag. User's own methodological
choices along the way, all correct and load-bearing:

- Used Partial Download for most tests (faster, and - as it turned out - itself confirmed a real
  finding: Object 3 gets written on Partial Downloads for flag-only changes too, not just GA
  changes, broadening §10.2, reference doc).
- After the Communication-flag test came back with literally zero change anywhere, asked for a
  full 98-byte comparison (not just the region already being watched) against the immediately
  prior capture - confirmed byte-for-byte identical, then asked for a retry to rule out a UI/save
  mistake before accepting it as real. Reproduced identically on retry.
- Then asked for a full **whole-capture** frame-by-frame comparison (every read, every write, not
  just the three memory writes) between the two captures - found exactly one difference, an
  ACK-coalescing timing artifact with zero content difference. This is the level of rigor that
  makes the negative Communication-flag result trustworthy rather than "we didn't look hard
  enough."
- Independently caught and corrected an assumed "Priority" field before it had been confirmed to
  exist in this device's actual ETS UI (not in the flags row - a dropdown just above it, found
  after the correction).
- After mapping Priority's three available values (Low/Alarm/High showed a clean linear
  2-bit pattern; System was not available as an option on this object, so `00` is inferred by
  pattern, not confirmed), asked for a full reset-and-compare sanity check: reverted every flag
  and Priority back to manufacturer default, then diffed the resulting capture against the very
  first pre-testing baseline - byte-for-byte identical, full whole-stream comparison, confirming
  the whole test sequence was self-consistent and left nothing lingering.
- Requested verification on a **second communication object** (6) before trusting the layout
  generalizes - Update and Read both landed exactly where the offset formula (`2 × 12` and
  `2 × 14`... i.e. `2 × object number`) predicted, including a two-flags-simultaneously case
  computed correctly (`0xD3 | 0x08 = 0xDB`) before the capture was even decoded.
- Requested one final test on **1.1.10** (a different device, different manufacturer app
  entirely) specifically to test whether the structure is app-specific or a real mask/device-
  generation-level standard - and, rather than saying what had changed, asked me to determine it
  from the capture alone. Computed the expected default byte from the app's own XML
  (`M-0004_A-3030-23-F0EA-O000A.xml`, object 96 "Dimming channel 4") and diffed against the real
  captured value (`0xDB` at offset `0xC0` = `2×96`) - correctly identified the Write flag as the
  single change, blind, before being told the answer. Confirmed correct.

**Result**: a complete, computable record structure -
`offset = 2 × communication-object-number`, `bit7=Update, bit6=Transmit, bit4=Write, bit3=Read,
bits1:0=Priority (Low=11/Alarm=10/High=01/System=00 inferred)`, `Communication=no representation
anywhere`. Cross-confirmed on two objects on 1.1.9 and one object on a completely different
device/app (1.1.10) - the blind prediction against 1.1.10 is the strongest evidence yet that this
is a mask-level standard structure, not an app-specific quirk. Full details, tables, and evidence
tags: reference doc's §10.1 (rewritten) and §10.2 (broadened).

**Still genuinely open**: bits 2 and 5 (always observed as `0` - reserved/unused, not confirmed);
Priority's `System` value (inferred by pattern, no object available to test it directly); whether
the structure holds on a non-System-B mask family (untested, as with everything else in this
project).

## Part 8: closing out the byte - bit 2 (GA-link correlation) and a blind multi-change test

Immediately after Part 7's cross-app confirmation, user asked the practical follow-on question:
"what is left with Object 3 that prevents us writing it?" Answer at the time included two real
unmapped bits (2 and 5 - though 5 was already Read-On-Init from day one, just not re-verified
with the newer blind-prediction rigor) and the untested question of whether disabling
Communication on an object shifts other objects' offsets.

**A useful accident**: sanity-checking the offset formula against object 5 (a real, already-
linked communication object, chosen specifically to test a different DPT/size - 8
bytes, `DPST-19-1`) before running any new capture turned up a live discrepancy: the predicted
manufacturer-default byte (`0x4B`) didn't match the real captured value (`0x4F`) - a difference of
exactly bit 2, one of the two bits previously marked unmapped. Checking the live project data
showed object 5 has a real GA link, while every other object tested until then (6, 7, 96) did not
- a real, testable hypothesis that bit 2 tracks link presence, not a coincidence.

**Test 1** (blind): toggled Read-On-Init on object 5, with the change identified from the capture
alone, no advance knowledge of what had been changed. Offset 10 (`2×5`) went `0x4F`→`0x6F`, XOR
`0x20` = bit 5 - Read-On-Init, independently reconfirmed on a third object with a different
DPT/size, exactly as predicted before being told the answer.

**Test 2** (blind, explicitly to test whether the methodology handles multiple simultaneous
changes): object 5's Read-On-Init was reverted AND communication object 8's only GA link was
removed, in the same download, with neither change disclosed in advance. Correctly decoded both
from the capture alone: offset 10 reverted to `0x4F` (Read-On-Init back off); offset 16 (`2×8`)
went `0x4F`→`0x4B` (bit 2 cleared) - and, decisively, the GA table shrank from 6 to 4 bytes and the
Association table from 10 to 6 bytes, both losing exactly the entry for object 8's link, in the
same download. Two unrelated changes on two different objects, both correctly isolated with zero
cross-contamination.

**Scope**: bit 2 is documented as a real, reproduced *correlation*
with GA-link presence - confirmed both directions (present→absent via a real removal, and
consistently present/absent across three other objects) - but explicitly NOT asserted to be
*only* that. Every test so far varied exactly one thing (link existing or not); a distinguishing
factor that happens to ride along with link presence in every case tested (link count, which
specific GA, object direction/DPT, or an ETS-internal derived value) has not been ruled out. See
reference doc §10.1 for the exact wording used there, worth keeping consistent if this is cited
elsewhere.

**Result**: every bit in the byte now has an observed role - `7=Update, 6=Transmit,
5=Read-On-Init, 4=Write, 3=Read, 2=GA-link (correlational), 1:0=Priority`. Combined with the
Communication-flag negative result (Part 7), this is now a complete, evidenced picture of the
byte, with one item (bit 2's exact mechanism) explicitly flagged as narrower than it might look.

## Part 9: closing item 2 (offset reindexing), and a real correction to the Communication-flag finding

Next on the earlier open list ("what prevents us writing Object 3"): does
disabling Communication on one object shift other objects' offsets, breaking the fixed-formula
assumption for real projects with disabled objects?

**Test 1**: disabled Communication on a lower-numbered object (6), checked whether higher-numbered
objects (7 at offset 14, 8 at offset 16) moved. Neither did - the offset formula is safe to use
unconditionally, no table compaction/reindexing occurs regardless of which objects are disabled.

**A sharp, correct objection to the standing Communication-flag finding surfaced next**: "my
understanding is that disabling it turns off all comms on that device... there absolutely must be
something written to the device." Right instinct, and it exposed a real confound in every prior
test: toggling Communication had only ever been tried on *unlinked* objects (6, 7) - both times
producing zero change, which is exactly what an AND-gated bit pinned at 0 by the missing link
would look like, with or without the flag's own effect. This is precisely the caution already
raised when bit 2 was first documented as "linked to GAs being present, we don't know if it
is more than that" - now vindicated directly.

**Test 2, decisive**: disabled Communication on object 5 (already linked, GA link deliberately
left untouched). Checked the GA and Association tables explicitly - byte-for-byte unchanged, the
link genuinely still there. Object 3's bit 2 (offset 10) still dropped from `1` to `0`. Two
independent routes to the same bit (a real link removal in the earlier test, and now a
Communication-disable on a still-fully-linked object) that don't touch the same memory region -
proof the flag has a real, demonstrated effect, not just a correlation with link presence.

**Correction applied everywhere this was documented**: reference doc §10.1 (the original
"confirmed rigorously, twice" claim replaced with the corrected finding, kept visible as a
correction rather than silently edited away), CLAUDE.md, captures/README.md. Real bit 2 meaning:
`Communication flag AND has a real GA link` - both required for `1`.

**Reusable lesson, explicit user callback**: "hence my caution when you last documented it!!" -
a documented finding that's technically true of every test run so far can still be wrong about
the general mechanism if every test shares an unexamined confound (here: link presence). The
user's insistence on hedging language ("correlation, not proven to be only that") rather than
accepting the first clean-looking result is what kept this catchable and cheap to fix, rather than
a wrong fact quietly propagating through later work.

## Part 10: multi-link test, Priority=System resolved via external documentation, and a documentation cleanup request

User asked to move forward with item 1's last real gap (bit 2 under multiple links) while noting
item 2 (Priority=System) needed no further testing - they'd found KNX's own documentation
(support.knx.org, "Group Object") confirming System priority isn't settable from ETS at all, so
no real project can ever exercise it.

**Multi-link test**: added a second GA link to communication object 5 (already linked once), with
Communication explicitly re-enabled first (object 5's Communication had been left disabled from
the prior correction test - re-enabling it first was necessary, otherwise bit 2 would stay pinned
at 0 regardless of link count, telling us nothing). Result: Association table correctly showed
both links pointing to object 5; Object 3's bit 2 was `1`, byte-for-byte identical to the
single-link case. Confirms bit 2 is a plain boolean ("has at least one link"), not something that
varies with link count.

**Documentation cleanup, explicit user request**: after the Communication-flag correction was
documented (with the retracted old claim kept visible in the reference doc as a "CORRECTED"
note), keeping the reference doc itself "clean/factual" - no need to keep
the incorrect assertion visible there. Removed the correction-narrative paragraphs from the
reference doc entirely (net -20 lines), keeping the full retraction narrative only in this
follow-up doc (Part 9) where it belongs. A good instance of the same principle the reference
doc's own intro already states - protocol facts in the reference doc, implementation/discovery
narrative in follow-ups - now applied to a correction, not just new findings.

**Property 27 cross-reference**: Part 10's heading gave no context for "Object
3", so it needed linking back to Property 27. To clarify (a genuine open
question, not just a docs gap): property 27 is one property ID, read on four different
interface objects (1/2/3/4) - Object 3 (objIdx 3) is one of the four, with its own checksum value
(`PropValueRead OX=3 P=27`, visible in the §1.1' 1.1.10 timeline), same mechanism Part 8 used on
objIdx 4 for the Full-Download trigger finding. Part 10's heading and intro now state this
explicitly.

## Part 11: link direction (Send vs receive-only) - not in Object 3, lives in Association-table order

Last remaining item on bit 2's scope: does mixed-direction linking (one Send GA, one receive-only
GA on the same object) change anything? ETS's own rule turned out to matter first - direction isn't an
independently settable flag, it's implicit: the first-added link sends, every subsequent link is
receive-only. That meant the earlier multi-link test (Part 10) already had one send + one receive
link, unnoticed at the time.

**Test**: kept the same two GA links on object 5 from Part 10, swapped which one sends (removed
and re-added, changing which was "first"). Result: Object 3 and the GA table both stayed
byte-for-byte unchanged. The Association table's two entries swapped position - same two entries
(same `gaIndex`/`coNumber` pairs), same target object, order flipped.

**Conclusion**: link direction is real, written to the device, but the encoding is table *order*,
not a per-entry flag and not anything in Object 3. This is a clean, informative negative result
for Object 3 specifically (bit 2 only ever tracks "has a link," never which one sends) and a real
new positive finding for the Association table's own wire format - added to the reference doc's
§2.6 alongside the existing GA/Association table format facts.

**This closes out Object 3's decode as fully as real-hardware testing on this project's testbed
can take it.** The one remaining, explicitly-flagged gap is structural, not something a further
test on this hardware can resolve: **only System B mask family has ever been tested** (both real
devices this whole project has used share that mask). User: "we cannot do much about that as yet,
but will do in due course... keep this flagged and on our ultimate to-check list" - kept visible
as a standing gap in the reference doc, CLAUDE.md, and memory, not silently dropped now that
everything else is closed.

## Part 12: wiring Object 3 into the real write path, and a latent LoadImageProp bug found along the way

Next step after Part 11 closed out Object 3's decode: actually invoke `buildGroupObjectTable()`
(Part 4/7's decode, already real code with golden-image tests) from `downloadDevice()` itself,
using the same undeclared-table mechanism Part 6/reference-doc-Part-6 built for GA/Association
tables.

**Investigation first**: checked how GA/Association data is currently sourced for a real download
(`bus.ts`'s `buildDeviceProgramming()`, `ets-parser.ts`'s `buildFlags()`) before writing any code.
Found a real, separate gap: the parser only captures Communication/Read/Write/Transmit/Update
(`C`/`R`/`W`/`T`/`U`) - Read-On-Init and Priority, both needed for Object 3's byte, aren't
extracted anywhere in the current parser or `com_objects` DB schema. This blocks actually building
a real `groupObjectTable` from DB data for now - noted, not fixed yet (out of the
explicit "write trigger" framing this step was scoped to). Also found, independently useful:
`ga_send`/`ga_receive` columns in the existing schema already correctly implement "first link
sends" - the exact rule Part 11 discovered empirically, already right in the parser without
having previously been verified against real hardware.

**Implementation**: added `DownloadExtra.groupObjectTable?: Buffer | null`, and a new invocation
right after the existing GA/Association ones:

```ts
if (
  extra?.groupObjectTable &&
  extra.groupObjectTable.length &&
  !declaredTableObjIdxs.has(3)
) {
  await writeUndeclaredTable(3, extra.groupObjectTable, 'Group Object Table');
}
```

**The real bug, found while doing this, not looked for**: while re-reading `declaredTableObjIdxs`
to decide what should count as "already handled" for Object 3, noticed it was built from *both*
`WriteRelMem` and `LoadImageProp` step types. That's wrong per Part 7's own finding - `LoadImageProp`
is read-only for every objIdx, confirmed against 3 independent real 1.1.10 downloads, so a step
declaring it can't possibly be "already handling" a content write. For 1.1.10's app specifically -
which declares `LoadImageProp` for objIdx 1/2/3 - this meant the GA/Association undeclared-table
fallback (Part 6, the whole reason this mechanism exists) was silently suppressed for 1.1.10, the
exact same silent-no-write failure mode Part 6 fixed for 1.1.9. Never caught before because that
fallback had only ever been validated against real ETS's own captures (comparing bytes), never
exercised end-to-end through koolenex's own `downloadDevice()` call for 1.1.10's declared-step
shape specifically. Fixed by filtering to only `WriteRelMem` steps:

```ts
const declaredTableObjIdxs = new Set(
  steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx),
);
```

**Test fallout, both expected and correct**: two existing tests broke, both because they'd been
written to assert the old (wrong) behavior directly:
- `ga-assoc-table-write.test.ts`'s 1.1.10-shape test previously asserted the fallback was
  suppressed when `LoadImageProp` was declared for objIdx 1/2 - updated to assert the opposite:
  the fallback now correctly runs and lands both tables at their resolved bases.
- `knx-connection.test.ts`'s LoadImageProp read-only test had a final check asserting *no*
  property write happens at all when a gaTable is supplied alongside a `LoadImageProp` step for
  objIdx 1. With the fix, the fallback now correctly fires and writes real Load State Machine
  control writes (property 5, part of its own legitimate Unload/StartLoading/LoadData cycle) -
  which the old broad "any property write" matcher couldn't distinguish from a hypothetical
  LoadImageProp-driven content write. Narrowed the matcher to specifically check for a property-27
  write (the only signature a `LoadImageProp`-driven content write could plausibly use) - the
  actual invariant being tested (LoadImageProp itself stays read-only) is still true and still
  covered.

**Result**: typechecked clean, all 1225 tests pass (1223 unchanged + 2 updated in place).
Committed to `test/relmem-real-device-fixtures` and pushed
(`9eaed85 Wire Object 3 into the real write path; fix a latent LoadImageProp bug`).

**Still explicitly not done**: no caller constructs a real `groupObjectTable` buffer yet (blocked
on the Read-On-Init/Priority parser gap above) - this invocation is real, tested code with no real
production trigger behind it yet. And Object 3's write itself, unlike GA/Association's, has never
been exercised against real hardware through this code path - it inherits the GA/Assoc precedent's
real-hardware proof by construction (same mechanism) but isn't itself independently confirmed.

## Part 13: closing the Read-On-Init/Priority parser gap

Direct follow-up to Part 12's finding, explicitly prioritized by the user ("Let's fix the
Read-On-Init/Priority first, as this should be straightforward").

**Confirming the real attribute names first**, rather than guessing from the KNX spec in the
abstract: unzipped the live Test Bed `.knxproj` again and grepped the two real app XML files
(1.1.9's `M-0004_A-0025-10-1BA6-O00A6.xml`, 1.1.10's `M-0004_A-3030-23-F0EA-O000A.xml`) directly.
Confirmed: `ReadOnInitFlag="Enabled"/"Disabled"` (identical vocabulary to `ReadFlag`/`WriteFlag`/
etc.), `Priority="Low"/"Alarm"/"High"/"System"`. Interesting real-data note: 1.1.9's app never
declares `Priority` at all on any `ComObject` (consistent with the earlier finding that absent
means "Low"); 1.1.10's app does declare it explicitly, and - genuinely useful - also overrides it
per-instance on individual `ComObjectRef`s (e.g. `Priority="Low"` on the `ComObject`, still
`Priority="Low"` on every `ComObjectRef` in the real file, but the override mechanism is real and
exercised by ETS's own schema even when the value doesn't change in this particular project).

**Implementation**: extended `CoDef`/`CorDef` (`server/ets-app.ts`) with `readOnInit`/`priority`
fields, extracted identically to the existing flags. Added a small `normalizePriority()` helper
converting the XML's Title-Case vocabulary to the lowercase one `knx-tables.ts`'s
`GroupObjectFlags` already uses (`'low'|'alarm'|'high'|'system'`) - kept as a local type rather
than importing `GroupObjectFlags` directly, to avoid coupling the parser module to the Object 3
write-path code for what's really just a shared vocabulary, not a shared abstraction. Both
`resolveCoRef()` and `resolveCoRefById()` (and the `AppIndex` interface they implement) now return
these two fields, following the exact same `cor.X ?? co.X` override-wins pattern the other flags
already use - confirmed this correctly lets a `ComObjectRef`-level override win over the
`ComObject` default via a dedicated test.

Threaded the two fields through `ets-parser.ts`'s `ParsedComObject` (both the main
`ComObjectInstanceRef` loop and the supplement path for active-but-unlinked COM objects), then
`db.ts`'s `com_objects` table (`read_on_init INTEGER`, `priority TEXT` - both in the `CREATE TABLE`
for fresh DBs and via the existing `migrate()` helper for upgrading existing ones), then
`routes/projects.ts`'s `INSERT INTO com_objects`.

**Testing**: 5 new cases in `tests/com-object-read-on-init-priority.test.ts`, using synthetic app
XML built from real attribute combinations (same pattern `ets-app.test.ts` already uses for its
Union/Memory tests) - default-when-absent, an explicit Enabled/Alarm combo, a `ComObjectRef`-level
override winning over the `ComObject` default, `Priority="System"` normalizing correctly (even
though it's confirmed unreachable from ETS's own UI, per Part 10 - the parser should still
round-trip it faithfully if a file somehow carries it), and `resolveCoRefById()` matching
`resolveCoRef()`'s behavior. All 1230 tests pass (1225 existing + 5 new). Typechecked clean.
Committed and pushed (`7301f4b Capture Read-On-Init and Priority for com objects (parser + DB
schema)`).

**What this does and doesn't close**: the data is now captured and stored - a real project's
Read-On-Init/Priority values are available in the DB per com object. `bus.ts`'s
`buildDeviceProgramming()` still doesn't construct a real `groupObjectTable` from this data and
pass it to `downloadDevice()` - that's the next, separate step before Object 3's write can be
exercised against real hardware for the first time.

## Part 14: wiring buildDeviceProgramming() to construct and pass a real Object 3

Direct continuation, user-directed ("yes pls" to continue past Part 13) - the last remaining gap
from Part 12: no real caller built a `groupObjectTable`.

**The real blocker turned out to be table SIZE, not the data itself.** GA/Association tables are
self-describing (`buildGATable`/`buildAssocTable` compute their own size from the linked GA count),
but Object 3 isn't - its real size (98 bytes for 1.1.9, 942 for 1.1.10, per Part 10) has no obvious
source in the per-device data koolenex already had. Rather than guess, re-extracted the live Test
Bed `.knxproj` again and counted real `<ComObject>` declarations directly:
1.1.9's app declares 48 (highest `Number="48"`); 1.1.10's declares 470 (highest `Number="470"`).
`2 × 48 + 2 = 98` and `2 × 470 + 2 = 942` - both exact matches, first try. The key realization: this
must be the app's TOTAL static declaration count, not a given device's currently-linked/active
com-objects (which is all `com_objects`'s existing per-device rows ever tracked) - real ETS clearly
pre-allocates space for every com object the app could ever expose, confirmed by the byte counts
not correlating with per-device active-object counts at all.

**Implementation**: added `AppIndex.maxComObjectNumber` (`server/ets-app.ts`, computed once from
the full `coDefs` map covering every `Static` section including modules) and threaded it into
`ParamModel.groupObjectTableSize` (`= 2 × max + 2`) in `ets-parser.ts`, stored in the per-app
`model.json` alongside `loadProcedures`. `bus.ts`'s `buildDeviceProgramming()` reads it back and
builds a real `GroupObjectFlags[]` from `com_objects`, calling `buildGroupObjectTable()`.

**A real correctness bug caught before it shipped, not after**: mapping `com_objects` rows to
`GroupObjectFlags` needs the raw Read/Write/Communication/Transmit booleans, but the DB only ever
stored the composite `flags` display string (`buildFlags()`) - and that string has a genuine lossy
case: when ALL of comm/read/write/tx/update are false, it falls back to the literal string `'CW'`,
which would make `flags.includes('C')`/`flags.includes('W')` wrongly report `true`. Checked whether
this is actually reachable in practice (every real com object seen so far has had
`CommunicationFlag="Enabled"`, so probably rare) but chose not to rely on that - added dedicated
`read`/`write`/`comm`/`tx` raw columns to `com_objects`, exactly mirroring Part 13's
`read_on_init`/`priority` treatment. Worked out that `Update` alone is provably always safe to
derive from `flags` (`'U'` can only ever appear in the string when Update is genuinely true, since
the fallback text itself contains no `'U'`) - documented this reasoning inline rather than adding a
fifth column for a flag that didn't need one.

**A second bug, same class, found by pattern-matching my own earlier fix**: while working in this
area, noticed `/bus/verify-device`'s own `declaredTableObjIdxs` check (a separate implementation
from `downloadDevice()`'s, used only for read-side verification) had the exact same LoadImageProp
bug Part 12 fixed on the write side. Fixed identically. Ran the full suite first to check for
pinned-behavior tests before committing to the fix - none existed, so no test updates were needed
this time (unlike Part 12's write-side fix, which did break two tests).

**Testing**: two new tests in `tests/bus-routes.test.ts` - one seeds two communication objects
exercising every new column at once (linked+unlinked, every flag combination, an explicit Priority
override) and asserts the real `extra.groupObjectTable` passed to the mocked `downloadDevice()`
matches `buildGroupObjectTable()` computed independently from the same fixture data; the other
confirms `groupObjectTable` stays `null` for an app model with no `groupObjectTableSize`. Both
passed on the first attempt. All 1232 tests pass (1230 existing + 2 new). Typechecked clean.
Committed and pushed (`99d545a Wire buildDeviceProgramming() to construct and pass a real Object 3`).

**What this closes and doesn't**: every gap flagged in Part 12/13 about "no real caller exists" is
now closed - the full chain from `com_objects` through to `downloadDevice()`'s `extra.
groupObjectTable` is real, wired, and tested at the unit level. What's still NOT done: no actual
device has been written to via `/bus/program-device` with a real `groupObjectTable` - Object 3's
write itself remains unproven on real hardware through this exact path, inheriting only the
GA/Assoc precedent's proof by construction (same underlying mechanism, Part 6/11).

## Part 15: first real dry-run comparison against a real captured write

User-directed, explicitly separated from an actual real-hardware write: "Before we do that, let's
do a final dry run, where we compare Koolenex's output with our actual previously captured ETS
data."

**Methodology**: rather than a synthetic fixture, drove the REAL pipeline against the REAL, live
Test Bed `.knxproj`. Added two minimal test-only export aliases (matching the existing
`_apduPropertyValueWrite` convention): `insertParsedData` (`routes/projects.ts`) and
`_buildDeviceProgramming` (`routes/bus.ts`). A small standalone script then:
1. `db.init({ inMemory: true })` - no risk to the real `koolenex.db`.
2. `parseKnxproj()` on the real `.knxproj` buffer (the exact same parser the real import route
   uses) → real `devices`/`comObjects`/`groupAddresses`/`paramModels`.
3. `insertParsedData()` + `saveModelsAndMasterXml()` - the exact same insert/model-write logic the
   real `/api/projects/import` route uses.
4. Looked up device `1.1.9`, called `_buildDeviceProgramming(dev)` - the exact same function
   `/bus/program-device` calls, but with no bus connection at all (nothing was written anywhere,
   nothing touched the real device).
5. Compared `built.groupObjectTable` byte-for-byte against a real capture.

**Picking the comparison target**: rather than the earliest/most-documented Object 3 capture
(frame 289 from an EARLIER session, referenced in §1.1'), deliberately picked the chronologically
LAST real Object 3 write of the entire 2026-08-29 session for 1.1.9
(`2026-08-29-ets-partial-download-obj3-swap-send-direction-1.1.9.pcapng`, 16:10:31) - the live
project's state should be closest to that capture's, minimizing the risk of comparing against a
stale historical device state (a real risk given how many flag/GA changes 1.1.9 went through this
one session). Decoded via `tshark`'s `cemi.data` field (a cleaner field for this purpose than the
raw `data.data`/`-x` hex-dump approach used in earlier sessions - confirmed it exposes exactly the
cEMI-layer payload, verified against the full `-V` decode which independently confirmed
`MemExtWrite N=98 X=$00570C`).

**Result**: 93/98 bytes matched exactly, first attempt - including every one of the 23 real
"Mapper object" channel objects (9-28) and every populated communication object's flag bits except
one. This is the first real evidence that the computation (Part 10.1/Part 14) reproduces real
ETS's own Object 3 content correctly for a real device's actual current data, not just synthetic
fixtures.

**Diagnosing the 5 diffs, not just reporting them**: rather than stop at "5 bytes differ", dumped
every parsed `com_objects` row for 1.1.9 and cross-checked against the SAME capture's own
Association table write (frames 210/211, decoded the same way): `00020001000500020005` - count=2,
both entries pointing to communication object 5, zero entries for object 8. This directly proves
object 8 was genuinely unlinked on the device at write time, while the live project currently
declares `ga_address='9/1/5'` for object 8 - explaining the one flag-byte diff (computed `0x4f`
assumes linked=true, matching the CURRENT project; real `0x4b` reflects the device's OLDER,
unlinked state) as real state drift, not a computation bug. Confirmed by direct evidence in the
same capture, not inferred.

**The remaining 4 diffs are a genuine open question, left open rather than guessed at**: bytes at
offsets 1/7/9/11 - the "unused" odd companion byte of each 2-byte slot per the established record
format - hold real nonzero content (`0x30`/`0x09`/`0x09`/`0x0c`) specifically for the app's
lowest-numbered built-in "internal clock" objects (the nonexistent object-0 slot, and objects 3/4/5
- `UhrzeitGO`/`DatumGO`/`DatumUhrzeitGO`, the app's own time/date/datetime output objects). Every
other odd byte in the entire 98-byte buffer, including all 23 Mapper-channel objects, is correctly
zero on both sides - ruling out a systematic offset/alignment bug (which would misalign object 0's
own even byte too, and it doesn't - both sides agree it's `0`). One speculative theory considered
but explicitly NOT asserted as fact (marked 🔴 in the reference doc): these might be
firmware-internal state for the app's own built-in objects, not sourced from the ETS project XML
at all - plausible given these are the app's distinctive non-generic objects, but not tested.
Real, controlled next step if this is investigated further: a real ETS download that deliberately
changes one of objects 0/3/4/5's own flags, watching whether these specific padding bytes move.

**What was NOT done**: no code was changed based on this finding - no guessing/patching without
real evidence. No real device write was attempted - this was explicitly a compute-only dry run,
kept separate from a real write as its own future step.

## Still open, after Part 6's redo

- ~~1.1.10's Full Download 2-of-4 Object 3 pattern needs a systematic, controlled redo~~ -
  **RESOLVED, see Part 6 above and reference doc §10.3**: reproduced and explained by a
  property-27 checksum read that comes back anomalous only after an out-of-band write.
- **Why Object 3 is written on *every* 1.1.9 Full Download tested, unconditionally, remains
  genuinely unreconciled** with 1.1.10's now-resolved conditional behavior - 1.1.9's app doesn't
  even declare property 27 (reference doc's Part 7), so the exact same checksum mechanism can't
  directly apply. Real next step: an out-of-band tamper test on 1.1.9 checking for a different
  anomalous-read signal, and hunting for any genuinely untampered 1.1.9 session that skips
  Object 3 (none found yet, in 5 real captures).
- ~~The general Object 3 record layout~~ - **FULLY RESOLVED AND CLOSED, see Parts 7-11 above**: a
  complete, computable formula (`offset = 2 × com-object number`, confirmed not to reindex when
  objects are disabled - Part 9) and a full bit map, cross-confirmed on three objects, two
  devices/apps, multiple GA links, and mixed send/receive links (Parts 10-11). Bit 2 =
  `Communication flag AND has a real GA link`, corrected in Part 9 after an earlier wrong "zero
  representation" claim, confirmed link-count- and direction-independent in Parts 10-11 (link
  direction itself lives in Association-table entry order, not Object 3 - Part 11). Priority's
  `System` value resolved as a non-issue - per KNX's own documentation, unreachable from ETS at
  all (Part 10). **Only remaining gap: only System B mask family tested throughout this project**
  - flagged as a standing, not-yet-investigable limitation, not silently dropped now that
  everything else is closed.
- Whether the checksum-trigger mechanism (Part 6, reference doc Part 8) generalizes beyond
  1.1.10's app.
- Whether the partial-download GA/Association-table skip logic (Part 11) generalizes beyond this
  one device/app - it's a best-effort extrapolation of the parameter-object pattern, now proven
  correct for 1.1.9 specifically, not proven to generalize.
- ~~Object 3's real write invocation exists in code and is tested, but has no real production
  caller yet~~ - **FULLY RESOLVED, see Part 13 (parser/schema) and Part 14 (the actual wiring)**:
  `bus.ts`'s `buildDeviceProgramming()` now builds a real `GroupObjectFlags[]` from `com_objects`
  and passes a real `groupObjectTable` through to `downloadDevice()`. What remains is purely
  real-hardware validation - see below.
- ~~Object 3's write itself, unlike GA/Association's, has never been independently exercised
  against real hardware through this code path~~ - **FULLY RESOLVED, see Part 18**: a surgical
  Object-3-only real write to 1.1.9 succeeded, first attempt, verified by read-back at exact
  byte-for-byte match (all 98 bytes). The entire Object 3 investigation - decode, wiring, data
  availability, the mystery byte, and now real-hardware write confirmation - is complete.
- ~~4 bytes at otherwise-unused "padding" offsets (1/7/9/11) hold real nonzero content on the
  device, specific to the app's built-in "internal clock" objects (0/3/4/5) - not reproduced by
  `buildGroupObjectTable()`, not yet explained~~ - **FULLY RESOLVED, see Part 17**: these are the
  real KNX standard Group Object Size code (per-object) and a real table-count header (bytes 0-1),
  confirmed by an independent cross-device test (4 for 4 DPT/size matches) and now implemented in
  `buildGroupObjectTable()`, closing this out completely.
- ~~The Part 16 negative result (mystery byte doesn't respond to a Read-On-Init change) left the
  firmware-internal-state theory unconfirmed either way~~ - **RESOLVED, see Part 17**: the real
  answer (KNX standard size code) fully explains why - it's fixed by the object's static DPT, not
  any user-editable flag, so no flag test could ever have moved it.
- Everything else already listed in the reference doc's Part 5.

## Part 16: real controlled test on the mystery padding byte - one clean negative result

Direct continuation, user-directed: "Let's do the ETS download. Please suggest exactly what to
change first." Picked communication object 3 (`UhrzeitGO`, "Time – output") specifically because
it's one of the four objects showing Part 15's unexplained padding byte, and its current real
baseline (`0x4B` at offset 6, unlinked) was already known precisely from the Part 15 capture -
letting the predicted outcome be stated exactly before running the test (Read-On-Init sets bit 5,
so `0x4B | 0x20 = 0x6B`).

**A process gap caught before it mattered**: the capture instructions were described but the
capture itself wasn't actually started first, breaking from the established pattern of starting
tshark before any change is made. Caught immediately when no new capture file appeared after the
download was reported done; confirmed the download had already happened without a capture running
(it had). Since
1.1.9 writes Object 3 unconditionally on every Full Download (Part 8/CLAUDE.md's established
finding) regardless of whether anything actually changed, no revert-and-redo was needed - just one
more real Full Download captured, showing the already-changed state directly.

**Result**: `2026-08-29-ets-full-download-obj3-mystery-byte-test-readoninit-obj3-1.1.9.pcapng`,
`MemExtWrite N=98 X=$00570C` (same base as Part 15's capture). Diffed the full 98-byte payload
against Part 15's capture byte-for-byte: **exactly 1 byte differs**, offset 6 (`0x4B`→`0x6B`,
exactly the predicted Read-On-Init bit) - a clean third confirmation of the record layout (objects
5/6/7 were the only ones directly tested before this). The mystery byte at offset 7 (`0x09`)
stayed **byte-for-byte identical**, along with every other byte in the buffer.

**What this establishes and doesn't**: rules out "the mystery byte is just another com-object flag
we haven't mapped yet" - at least for Read-On-Init, on this object. Does NOT confirm the
firmware-internal-state theory (Part 15) - that would need either (a) testing other flags on the
same object to rule those out too, or (b) some other line of evidence entirely (e.g. checking
whether the byte differs across power cycles/resets, which would be strong evidence either way).
Kept explicitly open - one clean negative result, not a resolved question. **Solved two turns
later - see Part 17.**

## Part 17: mystery byte solved - it's the KNX standard Group Object Size code, plus a real header

User asked two things in sequence, and got there directly: first, "Can you go through all the
previous captures and see if any have changes in one of these companion bytes" - then, before the
scan even finished, "Could it be Data Type?"

**The full-history scan came first, and settled the "does it ever move, at all, under anything"
question completely.** Extracted every full 98-byte Object 3 payload from all 28 real 1.1.9
captures spanning the whole 2026-08-27 to 2026-08-29 investigation (every Full and Partial
Download, every flag/GA/priority/comm edit made to any object throughout) via `tshark`'s
`cemi.data` field, filtered to exactly 196 hex chars. Result: the 4 companion bytes at offsets
1/7/9/11 are **byte-for-byte identical in every single one** - `0x30`/`0x09`/`0x09`/`0x0c`, no
exceptions, across three days of real testing. (Object 8's own flag byte, by contrast, correctly
varied across several of these captures as its GA link was added/removed during earlier tests -
confirming the scan methodology itself was sound, not just quietly finding nothing everywhere.)

**Testing the Data Type hypothesis required real ground-truth DPT data, so pulled it from the app
XML directly rather than reasoning about it in the abstract.** 1.1.9's 3 candidates (objects 3/4/5)
were already known from Part 15. For a genuinely independent cross-device check, needed a second
device with a full real Object 3 capture - 1.1.10's `2026-08-29-ets-full-download-1.1.10-
systematic-3-tampered.pcapng` (the one real comprehensive rewrite from the Part 6/8 investigation)
was the only capture with a full 942-byte write. Reconstructed it from 5 chunked `MemExtWrite`
frames (`tshark -Y "cemi.ax==0x1fb" -V`, grepped for `Memory Address: 0xc2` frames, found via a
`grep -B300 ... | grep "^Frame"` frame-number lookup since Wireshark's `-V` truncates long `Data:`
lines but the raw `cemi.data` field doesn't) - base `0xC2000`, 228-byte chunks, concatenated to the
full 942 bytes. Scanning that reconstructed buffer for nonzero odd offsets found a real repeating
pattern (identical 6-byte group `93 03 93 07 CB 07` at 4 evenly-spaced positions, objects
34-36/54-56/74-76/94-96 - a multi-channel dimmer app's repeating per-channel objects). Pulled the
real `ComObjectRef` definitions for objects 34/35/36 from the app's own XML:

- Object 34: `DatapointType="DPST-3-7"` (4-bit dimming control) - companion byte `0x03`
- Object 35: `DatapointType="DPST-5-1"` (1-byte scaling) - companion byte `0x07`
- Object 36: `DatapointType="DPST-5-1"` (same DPT as 35) - companion byte `0x07` (same as 35)

Combined with 1.1.9's own two data points (DPST-10-1/DPST-11-1, different DPTs, same 3-byte size,
same companion byte `0x09`; DPST-19-1, 8 bytes, different companion `0x0c`), the pattern was
unmistakable: **objects sharing the same real ETS `ObjectSize` share the same companion byte,
regardless of DPT identity** - a size class, not a DPT-specific value. Checked the resulting
numbers (3, 7, 9, 12) against the well-known KNX standard "Group Object Size" 4-bit code table
(0=1 Bit ... 7=8 Bit/1 Byte, 8=2 Byte, 9=3 Byte, 10=4 Byte, 11=6 Byte, 12=8 Byte, 13=10 Byte,
14=14 Byte, 15=variable) - 4 for 4, exact matches, no fudging needed. (Looked for this table in
koolenex's own bundled real KNX Master Data XML first, per this project's standing practice of
checking real sources before trusting memory - not present there, since it's a base cEMI/interface-
object standard concept rather than manufacturer/DPT master data, but the direct real-hardware
match across two independent devices stands on its own regardless.)

**The header finding fell out of the same investigation almost for free.** Bytes 0-1 (previously
read as "object 0's slot", always `0x00 0x30` on 1.1.9) don't fit the size-code table at all -
`0x30` on its own is out of the 0-15 range. Read as one big-endian 16-bit value instead: `0x0030` =
**48**. 1.1.10's own bytes 0-1 (`0x01 0xD6`) as one 16-bit value: **470**. Both exactly match
`maxComObjectNumber` (Part 14) - the same number the table's own overall SIZE is derived from. Not
a per-object slot at all; a genuine 2-byte header giving the app's total declared object count.

**Implementation**: `groupObjectSizeCode()` (new, `server/routes/knx-tables.ts`) maps ETS's real
`ObjectSize` strings (confirmed exact wording against real project XML: `"1 Bit"`, `"4 Bit"`,
`"1 Byte"`, `"3 Bytes"`, `"8 Bytes"`, etc.) to the 4-bit code, defaulting unrecognized/missing
input to `0` rather than throwing. `GroupObjectFlags` gained `objectSize`. `buildGroupObjectTable()`
now writes the real header (`(size - 2) / 2`, derived from the existing `size` parameter - no new
parameter needed since the header count and the table size were always the same underlying number)
and each object's companion byte alongside its flag byte. `bus.ts`'s `buildDeviceProgramming()`
passes `objectSize: co.object_size` through from `com_objects` (already captured by the Part 13
parser work - `object_size` was there all along, just never wired into Object 3's computation).

**Testing**: 11 new cases in `tests/group-object-table.test.ts` - a dedicated `groupObjectSizeCode()`
suite (the 4 confirmed real values, an unrecognized-input default case, and the remaining 11 codes
following the same well-known sequence, explicitly marked as not individually hardware-confirmed);
header tests for both real device sizes; companion-byte assertions woven into the existing
golden-image cases; and a new full-98-byte real-capture reproduction test - the ENTIRE real Object
3 buffer for 1.1.9 (`2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng`), header included,
byte-for-byte, built from a realistic full `GroupObjectFlags[]` (objects 3/4/5/6/7/8 plus all 20
real "Mapper object" channels 9-28). All 1243 tests pass (1232 existing + 11 new). Typechecked
clean. Committed and pushed (koolenex `a4a9864` the implementation, `feb1132` the reference doc).

**Final end-to-end re-verification against real data**: re-ran the exact Part 15 dry-run script
(real project → real DB → `buildDeviceProgramming()`, zero synthetic fixtures) after this fix,
against the same real capture used for the mystery-byte discovery in the first place
(`2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng`). **97 of 98 bytes now match
exactly** (up from 93/98 in Part 15) - the one remaining diff is object 8's already-fully-explained
state-drift case from Part 15 (a project GA link added after the device's last real download),
not a new gap.

**What this closes**: every open question about Object 3's byte-level content format from Parts
10/15/16 is now resolved. The record is 2 bytes per communication object (flag byte + KNX standard
size-code byte) plus a 2-byte leading header (total object count), and koolenex's computation now
reproduces essentially the entire real buffer from real project data alone. The one standing,
explicitly-flagged gap for the whole Object 3 investigation remains what it always was: only
System B mask family has ever been tested, on two devices, one testbed - not resolvable without
different hardware.

## Part 18: Object 3's write CONFIRMED on real hardware, first attempt

Direct continuation, user-directed ("Let's proceed") after the mystery byte was solved. Last
standing gap: Object 3's write, unlike GA/Association's, had never been independently exercised
against real hardware through koolenex's own code path.

**A scope decision made before touching real hardware**: the obvious first move was calling
`/bus/program-device` directly, but `buildDeviceProgramming()` always builds GA table, Association
table, AND Object 3 together for a real device - and Part 15 already identified that the live
project currently declares a GA link for object 8 that the device doesn't have. A full
`program-device` write would therefore silently push that GA-link change to the device too, as a
side effect of testing Object 3 specifically - not wrong exactly (it's just applying what's
already saved in the project), but not a clean, isolated first test. Chose a surgical
Object-3-only alternative over the full write instead, to keep the test isolated.

**Implementation**: `downloadDevice()`'s Object 3 invocation (Part 12) only depends on
`extra.groupObjectTable` and `declaredTableObjIdxs` (computed from `steps`) - completely
independent of `gaTable`/`assocTable`/`paramMem`/`steps` otherwise. Confirmed by re-reading the
function from the top: `DeviceDescriptor_Read` and `Authorize` are unconditional; the per-step
loop simply does nothing with `steps=[]`; the GA/Assoc/Object 3 undeclared-table checks are each
individually gated on their own buffer being non-null; `Restart` fires whenever
`writeUndeclaredTable()` set `anyRelSegmentLoaded = true`, which it always does. So
`downloadDevice('1.1.9', [], null, null, null, onProgress, { groupObjectTable, mode: 'full' })`
writes ONLY Object 3, verified by reading the source before running anything real, not assumed.

**A real, first-time script, closely mirroring the Part 15/17 dry-run scripts but this time doing
a real write**: parsed the live Test Bed `.knxproj` through the real pipeline exactly as before,
computed `groupObjectTable` via the real `_buildDeviceProgramming()`, then - new this time -
connected a real `KnxBusManager` to the real bus (`172.16.3.150:3671`) and called the real
`downloadDevice()`. Captured with tshark throughout, matching this whole session's standing
practice for every real-hardware action.

**Result: clean write, first attempt.** Real protocol sequence completed exactly as expected:
`DeviceDescriptor_Read` (mask `0x07b0`, SystemB) → `Authorize` (level 0) → `Unload`/`StartLoading`/
`LoadData`/`LoadCompleted` for objIdx 3 → `Restart` → `Download complete`. On the wire, koolenex
chunked the 98 bytes into 10-byte `MemExtWrite` frames at base `0x00570C` (its own convention -
real ETS itself doesn't always chunk the same way, per §1.1', both are valid).

**A transient hiccup on the first read-back attempt, correctly not treated as a failure**: the
verification step (immediately after `Restart`, same connection) failed with `Tunneling ACK
timeout`. Recognized this as an expected, benign transient - the device is briefly unresponsive to
new requests right after a Restart while it reloads, a real behavior this project has seen
before (the "Restart race" finding, `docs/follow-ups/2026-08-28-write-path-missing-load-sequence.md`).
Wrote a separate, minimal read-back-only script (deliberately NOT repeating the write - no reason
to write twice for a transient read-side issue) and reconnected fresh a few seconds later.

**Verification result: exact match, all 98 bytes.** Read `PID_TABLE_REFERENCE` (objIdx 3) fresh -
resolved to `0x570c`, matching every prior session's finding for this device - then read the full
98-byte region. Byte-for-byte identical to what was computed and written:
```
0030000000004b094b094f0c530053004f005b005b005b005b005b005b005b005b005b005b005b005b005b005b005b
005b005b005b005b005b0000000000000000000000000000000000000000000000000000000000000000000000000
000000000000000
```
(the exact same value the Part 17 dry run's `groupObjectTable` computed, and 97/98 bytes of which
already matched the earlier real capture from Part 15/17 - this confirms the remaining computation
is correct too, and now confirms the WRITE mechanism itself, not just the computation, works.)

Capture: `docs/data/captures/2026-08-29-koolenex-first-real-object3-write-1.1.9.pcapng`.

**What this closes**: the entire Object 3 investigation - decode (Part 10), write-trigger wiring
(Part 12), data availability (Parts 13-14), the mystery byte (Parts 15-17), and now real-hardware
write confirmation (this part) - is complete. koolenex can now compute AND write a real device's
Object 3 content correctly, proven end to end on real hardware. The one standing, unavoidable gap
remains what it always was: only System B mask family (both real testbed devices) has ever been
tested - not resolvable without different hardware.

## Part 19: `/bus/verify-device` extended to Object 3, and a third LoadImageProp bug found

Direct continuation, user-directed - working through the write-path capability-status memory's
open items in order, skipping the three hardware-generalization items (non-System-B, single
manufacturer, AbsSegment branch, all not investigable without new hardware). This part: "the write
is proven, but `/bus/verify-device` doesn't check Object 3 yet."

**A third copy of a bug already fixed twice before**: while reading `knx-download-plan.ts`'s
`buildGaAssocMem()` (the function `planVerify()` calls, which `/bus/verify-device` uses) to figure
out where to add Object 3, found it still had the exact LoadImageProp bug from Part 12 - counting
a declared `LoadImageProp` step as "already handled" when `LoadImageProp` is confirmed read-only.
Checked why this hadn't been caught by either of the two earlier fixes: no dedicated unit tests
existed for `planVerify()` at all before this (only indirect HTTP-level coverage via
`tests/bus-routes.test.ts`, and none of those tests happened to use a LoadImageProp-declaring
app). Fixed identically to the other two copies.

**Design decision on how Object 3 fits the existing GA/Association mechanism**: `gaAssocMem` (the
`VerifyPlan` field carrying undeclared-table regions) needed a new name once it covers a third
table - renamed to `undeclaredTableMem`, matching the write-side's own `writeUndeclaredTable()`
terminology. Object 3's own comparison logic diverges slightly from GA/Association's: those two
need a dynamic "read the real 2-byte count field first, then compute the real length" probe
because their real size varies with how many GA links exist and can differ from the project's
current assumption (Part 15's whole state-drift finding). Object 3's size doesn't have that
problem - it's `groupObjectTableSize`, a static per-app value, already known before any read
happens - so it gets a simpler, direct fixed-length read instead of the probe.

**Decode approach**: rather than a raw byte-diff, added `decodeGroupObjectEntry()` (the inverse of
`buildGroupObjectTable()`'s own per-object placement) so Object 3 gets the same "one named
comparison row per communication object" treatment the GA rows already have (`co-N-obj3`, section
"Group Object Table") - consistent UX, and immediately shows WHICH object differs rather than an
opaque whole-buffer byte diff.

**Testing, including the explicit "update the fake test devices too" reminder**: added a dedicated
`planVerify()` test suite in `tests/knx-download-plan.test.ts` (none existed before) covering the
new Object 3 inclusion, the LoadImageProp fix directly, a genuine `WriteRelMem` declaration
correctly suppressing the undeclared entry, and `groupObjectTable=null` cleanly omitting Object 3
without affecting GA/Association. Extended `tests/bus-routes.test.ts`'s `MockBus` fake device
(already used for the earlier program-device Object 3 write test) to serve Object 3 reads via its
existing `memImage`/`propImage` mechanism, with a clean-match test and a real mismatch test. All
1249 tests pass (1243 + 6 new). Typechecked clean. Committed and pushed (koolenex `f2ad425`
implementation, `b5d1657` reference doc).

**What this closes**: the write-path capability status memory's "verify-device doesn't check
Object 3" gap is resolved. Combined with Part 18's real-hardware write confirmation, Object 3 now
has both a proven write path AND a proven (if only unit/route-tested, not yet exercised against
real hardware) verify path.

## Part 20: buildParamMem()'s padding-bit fill bug fixed

Direct continuation, next item on the write-path capability status memory's open-items list.
The bug itself was already fully root-caused back on 2026-08-28 (see that day's own follow-up doc)
- real evidence never changed: a real 1-bit boolean at offset 69, real device value `0x80` when on
(bit 7 set, all other 7 bits clear), koolenex computing `0xFF`/`0x7F` instead because the "padding"
bits sharing that byte got the generic `fill` value rather than the real `0`.

**The fix itself was small once decided**: a pre-pass over `paramMemLayout` before the main
per-parameter write loop, zero-filling any byte a sub-byte field declares it occupies. The one real
design question was whether this should apply universally or need a carve-out: checked whether
`relSegHex` (the one app that seeds `buildParamMem()`'s buffer with a real captured default rather
than a plain `fill` byte) could have its own real, correct padding bits accidentally clobbered by
this new pre-pass - it could, so added an explicit skip for any byte already within `relSegHex`'s
coverage range. Verified with a dedicated test using both a sub-byte field AND `relSegHex` seeding
together, confirming the seeded byte survives untouched.

**Testing found the confirming evidence was already sufficient**: no NEW real-hardware capture was
needed - the exact real byte value (`0x80`/`0x00`) was already established during the original
2026-08-28 investigation, so the fix's correctness could be verified directly against that known
value in a synthetic unit test, without re-capturing anything. 6 new tests, all passing first
attempt after fixing one arithmetic slip in the test itself (a multi-field test initially expected
`0x88` instead of the correct `0x90` for bits 7+4 - caught immediately by the test failing, not a
code bug). All 1255 tests pass (1249 + 6 new), zero regressions - no existing test had ever
exercised a sub-byte parameter before this fix existed to matter.

**What this closes**: the write-path capability status memory's `buildParamMem()` padding-bit-fill
item is resolved - a real, standing, previously-unfixed write-correctness bug (independent of the
write-path mechanism itself, which was already proven working) is now closed.
