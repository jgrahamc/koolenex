# Implementation log: GA/Association table wiring, verify-page UI, and the property-27 (LoadImageProp/WriteProp) bugs

**See also**: `docs/knx-device-write-protocol.md` — the consolidated, evidence-tagged reference.
This log is the implementation/chronological record (koolenex code changes, commit hashes, UI
work, the exact order things were found and fixed); the reference doc's Parts 6 and 7 hold only
the distilled protocol facts this work established, with pointers back to this file for "how did
we get here" and "what code actually changed".

**Status: RESOLVED**, three separate but related pieces of work, all 2026-08-29:

1. GA table / Association table writes were never wired up at all for apps that don't declare
   them (like 1.1.9's).
2. GA info added to two UI pages (client/src/detail/DeviceParameters.tsx, client/src/views/
   DeviceCompareResults.tsx), plus two real bugs caught while testing that on real hardware.
3. `LoadImageProp`/`WriteProp` (property 27) got two real bugs found and fixed, re-testing 1.1.10
   against the current write-path code - including a same-day self-correction.

## 1. GA table / Association table writes were never wired up at all

Asked directly: *"Did we factor for GA writes anywhere?"* Answer at the time: **no** - confirmed
by reading 1.1.9's real app model (`data/apps/M-0004_A-0025-10-1BA6-O00A6.json`) directly: its
`loadProcedures` declares only objIdx 4 (parameters). No `RelSegment`/`WriteRelMem`/
`LoadImageProp` step exists for objIdx 1 (GA table) or objIdx 2 (Association table) anywhere in
the app's own `Static/LoadProcedures` XML, even though the reference doc's Part 1.1 Stage 3 table
shows real ETS writes both objects, via the identical RelSegment mechanism used for parameters.
koolenex's model-extraction code (`server/ets-app.ts`) parses `LoadProcedures` faithfully - no
synthesis - so this reflects the real app XML, not a parsing bug. 1.1.10's app is shaped
differently: it declares `LoadImageProp` for objIdx 1/2/3/4 explicitly (a different mechanism,
property 27 - see part 3 below).

**Fixed** (koolenex commit `2227b40`): `downloadDevice()` (`server/knx-connection.ts`) now
synthesizes the missing Unload/StartLoading/LoadData/write/LoadCompleted sequence for objIdx 1/2
whenever the model hasn't already handled them some other way, using the caller-supplied
`gaTable`/`assocTable` buffers directly as the write payload (their own `.length` supplies the
`LoadData` size - no extra metadata needed, confirmed to match exactly: 6 bytes for a 2-GA table,
10 bytes for a 2-entry association table).

**A second, more serious bug found in the same real-hardware test** (koolenex commit `ca7729d`):
the moment this fix made koolenex actually write these tables for the first time ever, the real
device came back with the wrong bytes - `buildGATable()`/`buildAssocTable()`
(`server/routes/knx-tables.ts`) used a 1-byte count field and, for the association table, 1-byte
`[CO_num, GA_idx]` entries with CO first - none of which matches the real wire format (`[count:2]
[GA:2]...` and `[count:2][gaIndex:2][coNumber:2]...` respectively, both 2-byte BE fields, GA
index before CO number). **This had never been exercised against real hardware before**, since
koolenex never wrote these tables at all until the fix above landed. Real consequence: this
briefly wrote the wrong format to the real testbed device (1.1.9), corrupting its on-device
GA/Association tables (real data, wrong packing - not erased). Fixed and immediately
re-verified: re-ran `program-device`, read back both tables, confirmed byte-for-byte identical to
the real ETS-written format (`000249014904` / `00020001000500020008`).

Both bugs covered by dedicated tests (`tests/ga-assoc-table-write.test.ts`, updated
`tests/protocol.test.ts`).

**Still open**: whether real ETS's GA/Association loading is *truly* universal across every mask
family (only tested on two System B devices), and whether the "no declared step" fallback
correctly generalizes to apps with more than 2 GAs or association entries beyond what's been
tested here.

## 2. GA info added to two UI pages

A user request to "add GA info" was initially misread as being about the device detail panel's
Parameters tab. That page showed zero GA/communication-object information, even though the
panel's own separate GROUP ADDRESSES/GROUP OBJECTS tabs have always covered this at the
whole-device level - so a cross-reference was added there first (still real, still kept).
`server/ets-app.ts`'s `evalDynamic()` already computes, at import time, which channel each
communication object belongs to (the same `<Channel>` grouping that structures the Parameters
view itself), stored in each `com_objects` row's `channel` column. The client
(`client/src/detail/DeviceParameters.tsx`) fetches this via the existing `GET /projects/:id/
comobjects` endpoint and renders a "COMMUNICATION OBJECTS" panel under whichever section is
currently active, matched by channel name. Verified live: 1.1.9's "Timer configuration" section
correctly shows all 6 Timer-channel com objects, including both real GA links.

**What was actually asked for, once clarified with a screenshot**: GA info on the *Device vs
Project verify/compare page* (`Programming` → `Verify`, `client/src/views/
DeviceCompareResults.tsx`) - the page that reads the device over the bus and diffs it against the
project's computed image. That page had no GA comparison at all, for the same underlying reason
as part 1 above: the verify plan (`planVerify()`) only ever built regions for what the app's
model declares, and 1.1.9's app declares nothing for objIdx 1/2.

**Fixed** (koolenex commit `c41168e`): `planVerify()` now returns a `gaAssocMem` field built the
same way as the write-side fix in part 1 - resolves the real device-resident base for objIdx 1/2
(extending `resolveRelmemBases()` to accept extra objIdx targets) whenever the model doesn't
already declare a step for them, but only for genuinely RelSegment-family apps (at least one real
`WriteRelMem` step) - AbsSegment/prop-only devices have no confirmed equivalent mechanism. The
verify-device route decodes the read-back bytes (new `decodeGATable()`/`decodeAssocTable()` in
`knx-tables.ts`, the inverse of the existing builders) into one comparison row per communication
object, folded into the same `decoded` array the frontend already renders, under a new "Group
Addresses" section - no frontend code changes needed, since that page already generically renders
whatever sections come back.

**A real bug caught by the test written for this, before it ever reached hardware**: a
communication object with more than one GA link only kept the *last* decoded link, silently
dropping earlier ones - fixed as part of the same commit.

**Confirmed on real hardware, via the actual UI page** (not just curl): the slide-over now shows
a "GROUP ADDRESSES" section with both of 1.1.9's real GA links (`9/1/1`, `9/1/4`), both correctly
matching project vs. device.

**Caveat, don't overclaim** (applies to both UI additions): channel-name matching (Parameters
tab) is not a true per-parameter link - KNX has no such concept. A section whose channel label
doesn't exactly match any com object's `channel` string shows nothing, even if conceptually
related. Not an issue for the one real app tested here, but worth remembering if a future app's
channel naming is less consistent.

**A second, real bug found immediately after, testing the differ badge on real hardware**
(koolenex commit `3bd9ca0`): the actual-bytes read for a GA/Association table region was sized
off the *project's* currently-computed `expected` buffer length, not the *device's* own real
on-device table size. Those normally agree, but not always - removing a GA link in the project
(without a re-download) shrinks the project's computed table while the device's real one stays
the same, larger size; the read then truncated to the smaller size, and the decoders correctly
stopped at that truncation point per their own bounds checks, silently reporting real entries past
it as missing (`actualValue: null`) rather than as a genuine byte-level mismatch. Confirmed on
real hardware: reproduced by temporarily removing one com object's GA link project-side only (no
device write) - a completely unrelated, still-correctly-linked com object came back
`actualValue: null` even though its real device value was untouched and correct. Fixed with a
two-pass read (real 2-byte count field first, then the real full length it implies, capped
defensively at 2000 bytes) rather than trusting the project's assumed size. Reconfirmed correct on
real hardware after the fix, same reproduction steps.

**UI refinement**: the two separate "params matched"/"GAs matched" badges were
combined into one (`All N params / M GAs matched`, or composing whichever side has a nonzero count
when something differs) - the page shows both scopes together
with no real filtering distinction between them, so two badges was pure redundancy once neither
had anything to report. Commit `6f0bff0`. The Group Addresses table section also got a
deliberately stronger, fixed visual treatment (thicker border, left accent bar, bold title)
instead of the usual per-section name-hash tint, so it reads as a different kind of thing from a
params section on sight.

## 3. Property 27 (`LoadImageProp`/`WriteProp`) - two bugs found and fixed, one self-correction

Closed item 7 of the reference doc's open-questions list: 1.1.10 (the only app in this project
declaring `LoadImageProp`, per part 1 above) had never been re-tested against the six write-path
fixes documented in `2026-08-28-write-path-missing-load-sequence.md` - its earlier "write path
proven correct" finding predated all of them. Closed with a fresh 3-download real-hardware
session (Full + 2 Partials, one flipping a boolean status-indicator flag, one reverting it)
against 1.1.10 specifically - captures saved to `docs/data/captures/2026-08-29-ets-0/1/2/3-...-
1.1.10.pcapng` in the knx-ets-manager repo.

Confirms part 1's universal GA/Association mechanism a second time: 1.1.10 writes both tables via
the identical RelSegment sequence already established for 1.1.9 - independent real-hardware
confirmation, still only two devices/one manufacturer.

### Bug 1: `LoadImageProp` was writing to a property real ETS only ever reads

Confirmed across all 3 real downloads: every one of objIdx 1/2/3/4's `LoadImageProp` step is
read-only in real ETS - byte-identical value before and after the load cycle, every time,
including objIdx4. It's a read-back/verify step, not a write, despite the step name.

koolenex's pre-existing `LoadImageProp` handler (in place before this finding, never previously
exercised against real hardware since 1.1.10 is the only app that declares this step at all) got
this backwards - it blindly wrote for *every* declared object: GA-table bytes to objIdx1,
Association-table bytes to objIdx2, a stray single `0x04` byte to objIdx3, none of which real ETS
ever does.

**Fixed** (koolenex, `test/relmem-real-device-fixtures` branch, commit `563dbe3`): `LoadImageProp`
made read-only for objIdx 1/2/3.

### Self-correction, same day

The commit `563dbe3` fix above initially *also* special-cased objIdx4: since the wire capture
showed 2 real writes to objIdx4/property27 during the download, it was assumed `LoadImageProp`
was responsible and a "read the current 2-element array, zero the trailing 2 bytes of each
element, write both back" reconstruction was built to reproduce them.

A direct user question - *"Is there anything in the ETS project file that hints or suggests the
need for this property 27... how does ETS know when to use this and when not to? Also... what are
the 4 slots?"* - prompted checking 1.1.10's own declared `LoadProcedures` order directly (already
sitting in `data/apps/M-0004_A-3030-23-F0EA-O000A.json`, not previously cross-checked against the
capture) rather than reasoning from the wire capture in isolation. That showed the two real writes
line up exactly with two separate, pre-existing `WriteProp` steps *earlier* in the same procedure
list - using literal fixed data baked into the project file - not with `LoadImageProp` at all.
`LoadImageProp` for objIdx4 contributes nothing but a read, same as objIdx 1/2/3.

**Fixed** (koolenex commit `2945e61`, same day): removed the objIdx4 special case entirely -
`LoadImageProp` is now read-only for all four objects, full stop.

**Lesson**: when a wire capture alone seems to explain a step's behavior, cross-check it against
the actual declared step list before building special-case logic around it - the project file is
a more reliable source than inferring intent from timing.

### Bug 2: `WriteProp`'s declared data for property 27 is 2 bytes longer than what ETS actually sends

Found during the self-correction above, while comparing the app's declared `WriteProp` data
against the real wire capture byte-for-byte:

```
Project file (declared, 10 bytes):  00 00 28 c0 00 33 00 00 | 00 00
Real wire (actually sent, 8 bytes): 00 00 28 c0 00 33 00 00
```

The first 8 bytes match exactly; the file's declared value always carries 2 extra trailing zero
bytes real ETS never transmits. Checked against every app in `data/apps/*.json` that declares a
`WriteProp` for objIdx4/propId27 - several different manufacturer IDs (`0004`, `0048`, `00C5`,
`0233`) - every single one is exactly 10 bytes, always ending in the same 2-byte pad beyond a real
8-byte element. Not observed for any other property in that same data, so this is scoped
specifically to property 27's declared format.

koolenex's pre-existing `WriteProp` case (also untouched before this finding, also never
exercised against real hardware for this specific property) sent the raw declared value
unmodified - 2 bytes longer than what real ETS puts on the wire. Untested whether a real device
would reject, truncate, or otherwise mishandle the extra bytes; fixed defensively rather than
finding out live.

**Fixed** (koolenex commit `2945e61`): `WriteProp` now trims data to its first 8 bytes
specifically when `propId === 27`, before sending. Every other property's `WriteProp` data passes
through unmodified.

Both bug fixes (and the self-correction) covered by new/updated regression tests in
`tests/knx-connection.test.ts`; all 77 tests in that file pass as of commit `2945e61`.

**Still open**: only one app/device has ever declared either of these steps at all (1.1.10, mask
`07b0`), so while the *shape* of both fixes is now backed by many different manufacturers'
declared data in `data/apps/*.json`, the actual live wire confirmation is still one real device.
Object 3's identity remains unresolved.
