# Investigation: does a real ETS Full Download depend on device history, and what's actually in the "1984-byte gap"?

**See also**: `docs/knx-device-write-protocol.md` §7 — the distilled protocol facts this
investigation settled. This log is the full narrative (dead ends, corrected mistakes, exact order
of discovery, including a self-corrected "99.2%" framing that turned out to be the whole 100%).

**Status: RESOLVED**, two separate questions, both closed with real-hardware evidence against 1.1.10:

1. Does ETS's Full Download depend on remembered history (its own or the device's), such that a
   device carrying stale content from elsewhere could silently keep it forever? **No** - confirmed
   empirically: ETS detects an out-of-band change and falls back to a comprehensive, near-total
   segment rewrite, not a naive skip.
2. What is the "1984-byte gap" between koolenex's computed parameter image and the real device
   (flagged as unexplained in `relmem-real-device-fixtures.test.ts` and `koolenex_reference` memory)?
   **Not device-internal/opaque state** (an earlier, wrong guess from this same investigation), and
   **fully resolved, not just mostly**: 24 manufacturer-declared "curve type" parameters (4
   channels x 6 conditional alternates), each a `TypeRawData`-typed parameter whose real wire
   format is a 4-byte big-endian length prefix + payload - a type koolenex's parser never handled
   at all, silently defaulting every such parameter to 1 byte. Confirmed directly against the real
   `.knxproj` XML (`<TypeRawData MaxSize="516" />`), not just inferred from behavior.

**Plus Finding 4** (Object 3): its true size for 1.1.10 (942 bytes, not a correction of 1.1.9's
separately-real 98 bytes), base address, and correlation with Full Downloads following a
reconnect/uncertain state (never Partial Downloads or routine same-session Full Downloads) are
all real, checked facts. Its *identity* is now also resolved, not speculative: **object 3 is the
standard KNX "Group Object Table"** (type `9`, confirmed against koolenex's own bundled real KNX
Master Data - see below). An earlier, explicitly-flagged-speculative theory tying it to
application-version management was recorded, then retracted once the real identity was found -
correctly parked as speculation at the time, so retracting it cost nothing. What's genuinely still
open is narrower: why ETS only rewrites this object on some Full Downloads and not others.

## Why this came up

Closing out the property-27/`WriteRelMem` work (see `2026-08-29-property27-ga-write-wiring-and-ui.md`),
a sharp objection surfaced against the "ETS only writes what differs from the manufacturer's
static default" theory: reuse a device across two different projects (or a factory reset in
between) and a value that happens to already match the *new* project's default would never get
corrected, even if it's genuinely stale. Rather than debate this from file data alone, a decisive
real-hardware test was the better path.

## The test (methodology)

Reused `UP-1554`/`UP-1555` at offset 172 (the same conditionally-active parameter pair from the
earlier `WriteRelMem`/property-27 investigation) - safe (no physical side effects previously
observed at that offset alone) and already well-understood.

1. Confirm baseline via direct device read (`POST /bus/read-memory`), not just the file's assumed
   default.
2. Set the project's "Indicating status temporarily" checkbox to non-default (`true`), real Full
   Download, confirm the write via capture + direct read.
3. Set it back to default (`false`), real Full Download, confirm ETS writes it back (it did - real,
   positive evidence for the file-derived-target theory, on its own).
4. **The actual test**: inject a value ETS has *never itself written* directly into device memory
   (bypassing ETS entirely, via koolenex's own `POST /bus/write-memory` debug route), leave the
   project unchanged (still at default), and do another real Full Download. If ETS detects and
   corrects it, that's real evidence against a naive "diff against own memory" mechanism. If it
   silently leaves the device stuck, that confirms a real gap.

## Two self-caught mistakes before the real result (documented deliberately - see below)

**Mistake 1 - wrong address, twice.** The first two "confirmation reads" after each real ETS write
both came back `0x00` instead of the expected written value, which looked like a real "write
succeeds on the wire but silently doesn't persist" bug (a known failure class in this project -
six such bugs were found and fixed earlier). Chased it through several dead ends (stale
connection, wrong memory service, a suspected read-path bug for short reads, even briefly worried
the debug write had wiped the whole segment) before finding the real, embarrassing cause: a
manual hex-to-decimal conversion error, reading `0x0C38AC` (an unrelated address, coincidentally
also `0x00`) instead of the intended `0x0C30AC`. Re-verified with the correct address and both
"failures" evaporated immediately. **Lesson**: a single
data point (one read matching a hypothesis) is not proof; the actual finding was that both
"confirmations" were internally consistent with each other by coincidence, not independently
verified against ground truth.

**Mistake 2 - narrow search missed a real write.** After the koolenex-injected value, the next real
Full Download's write pattern was searched for using an exact-address string match
(`grep "0C30AC"`), found nothing, and was reported as "ETS did not detect/correct the injected
value" - the opposite of the true result. The device readback (correctly showing the value *had*
changed) immediately contradicted that conclusion, prompting a broader search: ETS had written a
wider, multi-byte range (`MemExtWrite N=5 X=$0C30A8`) that included the target byte but wasn't
found by an exact-address search. Corrected finding: **ETS did detect and correct the out-of-band
value.**

## Finding 1: ETS falls back to a comprehensive rewrite when device state looks unexpected

Once the search was corrected, the real Full Download after the koolenex-injected byte wrote far
more than the single targeted byte: a contiguous run of writes from offset ~12 through ~1650 of
the 10433-byte parameter segment, a completely separate block covering objIdx3's region
(`0x0C2000` onward - the still-unidentified 98-byte object), the offset-10432 marker byte, and
both the GA and Association tables - essentially the whole segment, not a delta.

Hypothesis at the time: the koolenex debug write's `relSegment` declaration was *incomplete*
(only `mode:'full'`, missing the `mode:'par'` variant real ETS always declares alongside it) -
maybe that left the device's load-state bookkeeping in a shape ETS detected as inconsistent.

**Tested directly**: repeated the same injection, this time with the debug route's `combined:true`
option (declaring both `full` and `par` RelSegment steps, matching the real app's own declared
shape exactly). The next real Full Download did the **same comprehensive rewrite again** -
identical write pattern (`N=151 X=$0C300C`, `N=5 X=$0C30A8`, etc.). This disproves the
"incomplete RelSegment" hypothesis: it isn't about protocol correctness of the intervening write.
The simpler, still-unconfirmed-in-detail explanation left standing: **any** write to the device
from something other than ETS's own last session appears to trigger the comprehensive fallback,
regardless of that write's own correctness. The exact detection mechanism remains unknown (no
live memory read occurs in any capture, ruling out the obvious explanation) - flagged as still
open, not resolved.

**Also checked, and this matters**: the comprehensive rewrite's content was verified byte-for-byte
against real, previously-captured device values at several offsets (e.g. offset 3105's real value
of `2` was written back as `2`, not reset to a static default) - it's a *correct*, informed
rewrite, not a blind wipe to factory defaults. This directly motivated Finding 2.

## Finding 2: the "1984-byte gap" is a parser bug, not device-internal state

A byte-for-byte match between the comprehensive rewrite's content and known real device values
prompted re-examining the standing (and insufficiently justified) theory that
this region held device-internal operational/calibration state ETS never touches. A follow-on guess
("maybe ETS computes a dimming curve dynamically") was rejected as needlessly complex in favor of
checking simpler explanations first.

**Checked directly**: `paramMemLayout` (koolenex's own extracted parameter data) *does* declare
parameters at these exact offsets - labeled "Characteristic curve value domain" - but declares
each as 1 byte (`bitSize: 8`) while their real `defaultValue` is a base64-encoded blob that
decodes to **512 bytes**. These are ordinary manufacturer-declared parameters (a set of 6
conditional alternates per channel, presumably a "curve type" selector picks one), not anything
ETS computes - `buildParamMem()` simply has no code path to apply a multi-hundred-byte blob
default, only scalar/text/float values, so this whole region silently fell through to the
segment's fill/default.

**Verified at project scale, not just the one example**: swept every `paramMemLayout` entry for a
base64-looking `defaultValue` decoding to more bytes than its declared `bitSize` implies. Found
**24 such entries**, in 4 groups of 6, at offsets 532 bytes apart (3103, 3635, 4167, 4699) -
matching the device's 4 dimming channels exactly. Cross-checked against the real 1984-byte diff
list: **1968 of 1984 diffs (99.2%) fall inside these four 512-byte blob ranges.**

## Finding 3: the fix was still 4 bytes off - and the real `.knxproj` XML settles it completely

Implementing the "write the blob at its declared offset" fix (see Part 9 of the reference doc for
the settled description; this section is the narrative of getting there) only closed 824 of the
gap's bytes, not the expected ~1968. All four channels showed exactly the same 286/512 diff
count - a strong signal of one systematic error, not four independent ones, but none of the 6
declared alternates per channel was a byte-perfect match for the real device even after picking
the closest one.

**That comparison doesn't hold up either**: comparing against a fixture file frozen days earlier
conflated the fix's real effect with unrelated project-config drift (the project has had many
config changes across this whole multi-day investigation). Isolated properly (old code vs. new
code, same live DB state) - the fix's own effect was real and cleanly scoped to the blob region,
just incomplete.

**Direct byte comparison found the actual pattern**: the real device's content matched the
declared blob's template exactly once shifted forward by 4 bytes - 0 diffs across all 4 channels,
full 512 bytes each, once correctly aligned. The 4 bytes *before* that shifted position were an
undeclared, identical constant in every channel (`00 00 02 00`) - and this turned out to be the
exact same 4 bytes as the earlier "16 remaining unexplained bytes" (right after each naively-
placed 512-byte window) - not a second, separate gap at all, just the table's own real tail,
misplaced by the same 4-byte error.

**User asked directly whether the real project file was available** to check this at the source
instead of continuing to infer it. It was - not the live project's own file (koolenex doesn't
retain uploaded `.knxproj`s after parsing), but an older export of the *same* project found in a
local email cache, which bundles the identical app/product XML (`.knxprod`-equivalent data is
identical across exports of the same app version, independent of project-specific configuration).
Extracting and reading `M-0004/M-0004_A-3030-23-F0EA-O000A.xml` directly settled it completely:

```xml
<ParameterType Id="..._PT-_DA_Kennlinie_Raw Data" Name="_DA_Kennlinie_Raw Data">
  <TypeRawData MaxSize="516" />
</ParameterType>
```

516 = 4 + 512. Decoding the real device's 4 "unexplained" header bytes as a big-endian `uint32`:
`0x00000200` = 512 - exactly the payload length. **The real wire format is a 4-byte big-endian
length prefix followed by the payload**, not a bare table. koolenex's parser never handled
`TypeRawData` at all - every branch in its `ParameterType` loop checks for a specific child
element (`TypeNumber`/`TypeFloat`/`TypeTime`/`TypeText`) before falling through to a generic
`TypeRestriction`-based branch that only reads *TypeRestriction's own* `SizeInBit`, absent for
`TypeRawData` - hence the silent `bitSize=8` fallback that started this whole investigation.

**Fixed properly at both layers**: `ets-app.ts` now reads `TypeRawData`'s `MaxSize` (in bytes)
into `bitSize`; `buildParamMem()` (`server/routes/knx-tables.ts`) now emits the real
`[4-byte BE length][payload]` framing when a blob's declared size matches that shape, falling
back to a raw (unframed) write otherwise - a deliberate safety net for a stale pre-fix cache or a
genuinely different blob shape not yet seen, rather than assuming this framing is universal.
**Result, verified against a fresh re-parse of the real XML**: 0 diffs across all four 516-byte
regions. The gap is fully closed, not just 99.2% of it - the earlier "16 remaining bytes, still
open" framing in Part 9's first draft was itself premature; corrected the same day.

## Finding 4: Object 3, revisited - identity resolved (Group Object Table), write-trigger behavior still open

Since Object 3 got written during the comprehensive rewrite (Finding 1), and the original
"skip-unmapped-bytes" task this whole investigation grew out of was about to resume, it was worth
a closer look before treating it as fully out of scope.

**Corrected a real, longstanding wrong assumption along the way**: this project's docs have
carried "Object 3, 98 bytes, unidentified" since 2026-08-27 (`2026-08-27-relmem-write-scope-
investigation.md`). Checking the real `LoadData` declaration for 1.1.10 directly
(`PropValueWrite OX=3 P=5 $030B000003AE...`) decodes to size `0x03AE` = **942 bytes** - a real,
confirmed figure for *this* device. Checked carefully before treating this as a "correction": the
98-byte figure is from 1.1.9, a different device/app entirely - both numbers are likely correct,
for their respective devices, since object 3's presence is universal/mask-defined but its content
is evidently per-app.

**Read `PID_OBJECT_TYPE` (property 1) live from the real device** - a standard KNX property every
interface object reports, giving a direct, unambiguous identifier rather than inferring one from
behavior: object 3 reports type `9`, distinct from objIdx 1/2/4's `1`/`2`/`3` (which correctly
match Address table / Association table / Application Program - confirming the read itself is
trustworthy). Type `9`'s real standard name wasn't confirmed at the time - no reliable local KNX
standard reference had been checked yet, and recollection of the standard object-type
table wasn't trusted enough to assert a name outright.

**A real ETS screenshot surfaced a plausible connection, then needed correcting
once, then partly reinstated**: the "Change Application Program" dropdown initially looked like it
might tie to a device-side "application management" object (supporting an application-version
guess for object 3). Further clarification established this was just an ETS-side local-file picker
(weakening that link), then corrected further: it genuinely supports loading a *different*
application version onto already-commissioned hardware (a real device-level capability, not just
a project-editing convenience) - which does plausibly need device-side infrastructure to support,
partially reinstating the connection at the time.

**Checked whether Object 3 activity correlates with Full vs. Partial Download** (a much simpler,
already-established distinction) - genuinely tested, not assumed: swept every saved capture in
the project for `OX=3 P=5` activity. Every Partial Download capture: zero. But *not* every Full
Download either - among that day's own captures, only the two comprehensive-rewrite downloads
touched it, not the two routine flag-toggle Full Downloads earlier the same day. Every *other*
capture showing Object 3 activity (2026-08-27, two from 2026-08-28) is a first-download-of-a-
session or post-reconnect/post-failed-attempt capture - consistent with, not proof of, "written
when ETS has reason to be uncertain about device state."

**Documented as checked facts (size, base, object
type, universal/undeclared nature, the Full/Partial correlation) with the causal story
(application-identity tracking) explicitly marked as speculation requiring further investigation,
not settled** - which turned out to matter: whether the ETS SDK's
help file might help was worth checking, prompting a look at `ETS 6.4 SDK/ETS6 SDK.chm` (extractable with 7-Zip
like an archive) - its `MasterData.InterfaceObjectType` class docs described the *shape* of a
number→name lookup but not the actual values (loaded at runtime from KNX Master Data, not baked
into the help file). That pointed to a better source already available: koolenex's own bundled
real KNX Master Data (`data/knx_master_1.xml`, used earlier in this project for the System B
mask-family finding). Its `<InterfaceObjectType>` table gives the authoritative answer directly:

```xml
<InterfaceObjectType Id="OT-9" Number="9" Name="OT_GROUP_OBJECT_TABLE" Text="Group Object Table Object" />
```

Cross-checked against objIdx 1/2/4 too (types `1`/`2`/`3` = Address Table/Association Table/
Application Program, all correctly matching what was already independently established) -
validating the method, not just trusting one lucky lookup. **Object 3 is the standard KNX "Group
Object Table"**: an ordinary, well-understood object holding per-communication-object flags
(communication/read/write/transmit-enable, priority) and possibly cached values, indexed by
communication object number - unrelated to application-version management. The earlier
speculative theory is retracted; correctly parking it as speculation rather than asserting it
meant the retraction cost nothing downstream.

**What's still genuinely open, narrower now**: not "what is this object" (resolved) but "why does
ETS only rewrite the Group Object Table on some Full Downloads and not others." Not investigated
further today - a reasonable starting point for later: check whether the two routine
(non-rewriting) sessions still wrote GA/Association tables unconditionally, which would suggest
objIdx 3 has a genuinely different write-triggering policy than objIdx 1/2, not just "part of the
same uncertain-state response."

## What's still genuinely open

- The exact mechanism by which ETS detects "this device's state doesn't match what I expect" and
  triggers the comprehensive rewrite (Findings 1-2) - confirmed to exist and to be triggered by
  *any* intervening non-ETS write (tested with both an incomplete and a complete RelSegment
  declaration), but the underlying signal is unknown. No live memory read occurs in any capture,
  so it isn't a read-then-diff mechanism at the byte level.
- Whether the `TypeRawData`/length-prefix framing generalizes beyond this one app's
  "Characteristic curve value domain" parameters - confirmed for this one shape only;
  `buildParamMem()`'s fallback path is a deliberate unknown-shape safety net, not assumed correct
  for other manufacturers/parameter types.
- Object 3's *identity* is resolved (Finding 4: the standard Group Object Table, type `9`) - what
  remains open is why ETS only rewrites it on some Full Downloads and not others.

## Sources

- `docs/data/captures/2026-08-28-ets-full-download-history-and-blob-params-1.1.10.pcapng`
  (knx-ets-manager repo) - the full real-hardware session: baseline reads, the two ETS-driven
  writes (flag true/false), the two koolenex-injected out-of-band writes (incomplete then complete
  RelSegment), and both subsequent real ETS Full Downloads (the first showing the comprehensive
  rewrite, the second confirming it wasn't a one-off).
- `ETS 6.4 SDK/ETS6 SDK.chm` (knx-ets-manager repo, extracted with 7-Zip) - checked for a
  standard object-type reference table; only describes the API shape, not the values, but pointed
  toward `data/knx_master_1.xml` (koolenex repo) as the real source - its `<InterfaceObjectType>`
  entries are the direct source for Finding 4's Group Object Table identification.
- `tests/fixtures/relmem-real-devices/1.1.10-actual.hex` /
  `1.1.10-expected-computed.hex` - source for the blob-range/diff-offset cross-check.
- `data/apps/M-0004_A-3030-23-F0EA-O000A.json` - source for the 24 blob-typed `paramMemLayout`
  entries and their real decoded lengths, before the `TypeRawData` fix (this project's own cache
  hasn't been regenerated from source yet - a later re-parse will pick up the fix automatically).
- An older `.knxproj` export of the same project (found locally in an email cache, not part of
  this repo) - source for the raw `M-0004_A-3030-23-F0EA-O000A.xml` confirming `TypeRawData
  MaxSize="516"` directly. Not saved into this repo's own capture/fixture set (not this project's
  own export, and large/user-identifying) - if this needs re-verifying later, the same
  `<TypeRawData MaxSize="...">` declaration will be present in any export of this exact app
  version.
