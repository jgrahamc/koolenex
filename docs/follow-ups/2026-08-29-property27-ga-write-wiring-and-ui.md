# Implementation log: GA/Association table wiring, verify-page UI, and the property-27 (LoadImageProp/WriteProp) bugs

**See also**: `docs/knx-device-write-protocol.md` — the consolidated reference. This log is the
implementation/chronological record; the reference doc's §6.2/§7 hold only the distilled facts.

**Status: RESOLVED**, three related pieces of work:

1. GA table / Association table writes were never wired up at all for apps that don't declare them
   (like 1.1.9's).
2. GA info added to two UI pages (`DeviceParameters.tsx`, `DeviceCompareResults.tsx`), plus two
   real bugs caught testing on real hardware.
3. `LoadImageProp`/`WriteProp` (property 27) got two real bugs found and fixed, re-testing 1.1.10
   against the current write-path code, including a same-day self-correction.

## 1. GA table / Association table writes were never wired up at all

Confirmed by reading 1.1.9's real app model directly: its `loadProcedures` declares only objIdx 4
(parameters) — no `RelSegment`/`WriteRelMem`/`LoadImageProp` step for objIdx 1/2 anywhere in the
app's own XML, even though real ETS writes both objects via the identical RelSegment mechanism.
Not a parsing bug — reflects the real app XML. 1.1.10's app is shaped differently: it declares
`LoadImageProp` for objIdx 1/2/3/4 explicitly (property 27, see part 3).

**Fixed** (commit `2227b40`): `downloadDevice()` now synthesizes the missing
Unload/StartLoading/LoadData/write/LoadCompleted sequence for objIdx 1/2 whenever the model hasn't
already handled them, using the caller-supplied `gaTable`/`assocTable` buffers directly (their own
`.length` supplies the LoadData size).

**A second, more serious bug found in the same real-hardware test** (commit `ca7729d`): the moment
this fix made koolenex write these tables for the first time ever, the real device came back wrong
— `buildGATable()`/`buildAssocTable()` used a 1-byte count field and, for the association table,
1-byte `[CO_num, GA_idx]` entries CO-first, none of which matches the real wire format (`[count:2]
[GA:2]...` / `[count:2][gaIndex:2][coNumber:2]...`). This briefly wrote the wrong format to the
real testbed device (1.1.9), corrupting its GA/Association tables (real data, wrong packing, not
erased). Fixed and immediately re-verified byte-for-byte against the real ETS-written format.

Both bugs covered by `tests/ga-assoc-table-write.test.ts` and updated `tests/protocol.test.ts`.

**Still open**: whether this is universal across every mask family (only two System B devices
tested); whether the fallback generalizes beyond what's been tested here.

## 2. GA info added to two UI pages

First added a cross-reference to the device detail panel's Parameters tab: `ets-app.ts`'s
`evalDynamic()` already computes, at import time, which channel each communication object belongs
to (stored in `com_objects.channel`); `DeviceParameters.tsx` fetches it via the existing endpoint
and renders a "COMMUNICATION OBJECTS" panel matched by channel name. Verified: 1.1.9's "Timer
configuration" section correctly shows all 6 Timer-channel com objects.

**What was actually needed, once clarified**: GA info on the Device vs Project verify/compare page
(`DeviceCompareResults.tsx`), which had no GA comparison because `planVerify()` only built regions
for what the app's model declares.

**Fixed** (commit `c41168e`): `planVerify()` returns a `gaAssocMem` field built the same way as the
write-side fix, resolving the device-resident base for objIdx 1/2 whenever the model doesn't
declare a step, but only for genuinely RelSegment-family apps. `decodeGATable()`/
`decodeAssocTable()` (the inverse of the builders) turn the read-back bytes into one row per
communication object under a new "Group Addresses" section — no frontend changes needed.

**A real bug caught by the test written for this, before hardware**: a communication object with
more than one GA link only kept the *last* decoded link, silently dropping earlier ones. Fixed in
the same commit.

Confirmed on real hardware via the actual UI: the slide-over shows both of 1.1.9's real GA links
(`9/1/1`, `9/1/4`), matching project vs. device.

**Caveat for both UI additions**: channel-name matching (Parameters tab) is not a true per-parameter
link — a section whose channel label doesn't match any com object's `channel` string shows nothing.
Not an issue for the one app tested, but worth remembering.

**A second bug found immediately after, testing the differ badge on real hardware** (commit
`3bd9ca0`): the actual-bytes read for a GA/Association region was sized off the project's currently-
computed `expected` length, not the device's real on-device table size. Removing a GA link project-
side (no re-download) shrinks the project's computed table while the device's stays larger; the
read truncated, and an unrelated, still-correctly-linked com object came back `actualValue: null`.
Fixed with a two-pass read (real 2-byte count field first, then its implied length, capped
defensively at 2000 bytes).

**UI refinement**: the two separate "params matched"/"GAs matched" badges were combined into one
(`All N params / M GAs matched`), composing whichever side has a nonzero count (commit `6f0bff0`).
The Group Addresses section also got a distinct, fixed visual treatment.

## 3. Property 27 (LoadImageProp/WriteProp) — two bugs found and fixed, one self-correction

Closed a standing gap: 1.1.10 (the only app declaring `LoadImageProp`) had never been re-tested
against the six write-path fixes documented in `2026-08-28-write-path-missing-load-sequence.md` —
its earlier "write path proven correct" finding predated all of them. Re-tested with a fresh
3-download session (Full + 2 Partials).

Confirms part 1's universal GA/Association mechanism a second time: 1.1.10 writes both tables via
the identical RelSegment sequence already established for 1.1.9.

### Bug 1: LoadImageProp was writing to a property real ETS only ever reads

Confirmed across all 3 real downloads: every objIdx 1/2/3/4's `LoadImageProp` step is read-only in
real ETS — byte-identical before and after, every time. koolenex's pre-existing handler (never
previously exercised against real hardware, since 1.1.10 is the only app declaring this step) got
it backwards, writing for every declared object.

**Fixed** (commit `563dbe3`): `LoadImageProp` made read-only for objIdx 1/2/3.

### Self-correction, same day

The fix above initially also special-cased objIdx4, assuming `LoadImageProp` was responsible for 2
real writes seen there in the capture, and built a "read the array, zero trailing bytes, write back"
reconstruction to reproduce them. Checking 1.1.10's own declared `LoadProcedures` order directly
(rather than reasoning from the wire capture alone) showed the two real writes line up with two
separate, pre-existing `WriteProp` steps earlier in the same list — using literal fixed data baked
into the project file — not with `LoadImageProp` at all.

**Fixed** (commit `2945e61`, same day): removed the objIdx4 special case — `LoadImageProp` is
read-only for all four objects, full stop.

**Lesson**: when a wire capture alone seems to explain a step's behavior, cross-check it against
the actual declared step list before building special-case logic around it.

### Bug 2: WriteProp's declared data for property 27 is 2 bytes longer than what ETS actually sends

Found during the self-correction, comparing the app's declared `WriteProp` data against the wire
capture byte-for-byte:

```
Project file (declared, 10 bytes):  00 00 28 c0 00 33 00 00 | 00 00
Real wire (actually sent, 8 bytes): 00 00 28 c0 00 33 00 00
```

The first 8 bytes match; the declared value always carries 2 extra trailing zero bytes real ETS
never transmits. Checked every app in `data/apps/*.json` declaring `WriteProp` for objIdx4/propId27
across several manufacturer IDs — every single one is 10 bytes with the same 2-byte pad, scoped
specifically to property 27.

koolenex's pre-existing `WriteProp` case sent the raw declared value unmodified, 2 bytes long.
Untested whether a real device would reject/truncate/mishandle the extra bytes; fixed defensively.

**Fixed** (commit `2945e61`): `WriteProp` trims data to its first 8 bytes specifically when
`propId === 27`; every other property's data passes through unmodified.

Both bugs and the self-correction covered by new/updated tests in `tests/knx-connection.test.ts`;
all 77 tests in that file pass as of commit `2945e61`.

**Still open**: only one app/device (1.1.10, mask `07b0`) has ever declared either of these steps at
all — the shape of both fixes is backed by many manufacturers' declared data, but live wire
confirmation is from this one real device. Object 3's identity remains unresolved (see the
2026-08-28 blob-params follow-up for its later resolution).
