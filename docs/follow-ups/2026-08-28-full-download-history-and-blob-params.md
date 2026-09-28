# Investigation: does a real ETS Full Download depend on device history, and what's actually in the "1984-byte gap"?

**See also**: `docs/knx-device-write-protocol.md` §7 for the distilled protocol facts. This is the
narrative log.

**Status: RESOLVED**, two questions, both closed with real-hardware evidence against 1.1.10:

1. Does ETS's Full Download depend on remembered history, such that stale content could persist
   forever? **No** — ETS detects an out-of-band change and falls back to a comprehensive rewrite.
2. What is the "1984-byte gap" between koolenex's computed parameter image and the real device?
   **Not device-internal state** — 24 manufacturer-declared "curve type" parameters (4 channels × 6
   conditional alternates), each `TypeRawData`-typed with a real wire format of a 4-byte
   big-endian length prefix + payload, a type koolenex's parser never handled at all.

**Plus Finding 4** (Object 3): its size (942 bytes for 1.1.10), base address, and its identity —
the standard KNX "Group Object Table" (type `9`, confirmed against koolenex's bundled KNX Master
Data) — are resolved. Open: why ETS only rewrites it on some Full Downloads.

## The test

Reused offset-172 parameter (`UP-1554`/`UP-1555`, "Indicating status temporarily") on 1.1.10:

1. Confirm baseline via direct read.
2. Set project value non-default, Full Download, confirm write.
3. Revert to default, Full Download, confirm ETS writes it back (positive evidence for
   file-derived-target theory on its own).
4. **The actual test**: inject a value ETS never wrote (via `POST /bus/write-memory`, bypassing
   ETS), leave the project unchanged, Full Download. Does ETS detect and correct it?

## Two self-caught mistakes before the real result

**Mistake 1**: two "confirmation reads" came back `0x00` unexpectedly — chased several dead ends
before finding the cause: a manual hex-to-decimal error, reading `0x0C38AC` instead of the intended
`0x0C30AC`. Re-verified at the correct address, both "failures" evaporated. Lesson: one matching
read is not proof of anything; verify against ground truth.

**Mistake 2**: an exact-address grep found no write at the tampered byte and was reported as "ETS
did not correct it" — the opposite of the truth. The device readback (showing the value had
changed) contradicted that; ETS had written a wider multi-byte range (`MemExtWrite N=5
X=$0C30A8`) that included the target byte but wasn't found by an exact-address search.

## Finding 1: ETS falls back to a comprehensive rewrite when device state looks unexpected

After the koolenex-injected byte, the next real Full Download wrote far more than the single
targeted byte: offsets ~12–1650 of the 10433-byte segment, objIdx3's whole region, the marker byte
at offset 10432, and both GA and Association tables — essentially the whole segment.

Tested whether an incomplete `RelSegment` declaration in the injecting write was the cause: repeated
with a `combined:true` declaration matching the real app's shape exactly — same comprehensive
rewrite. Disproves that hypothesis. Remaining explanation: any write from something other than
ETS's own last session triggers the fallback, regardless of correctness — detection mechanism
unknown at this point (no live memory read occurs in any capture).

The rewrite's content is correct (byte-for-byte matches real previously-captured values at several
offsets), not a blind wipe — motivating Finding 2.

## Finding 2: the "1984-byte gap" is a parser bug, not device-internal state

Checked `paramMemLayout`: these offsets are declared parameters ("Characteristic curve value
domain"), each 1 byte per the declared `bitSize`, but their real `defaultValue` decodes to 512
bytes — `buildParamMem()` has no code path for a multi-hundred-byte blob default, so the whole
region fell through to fill.

Swept every `paramMemLayout` entry for a base64 `defaultValue` decoding to more bytes than its
declared `bitSize`: 24 entries, 4 groups of 6, at offsets 532 bytes apart (matching 4 dimming
channels). 1968 of 1984 real diffs (99.2%) fall inside these four 512-byte ranges.

## Finding 3: the fix was still 4 bytes off — the real .knxproj XML settles it

Writing the blob at its declared offset closed only 824 of the gap's bytes, not ~1968; all four
channels showed the same 286/512 diff count — one systematic error. Direct byte comparison found
the device's content matched the declared blob shifted forward by 4 bytes — 0 diffs once aligned.
The 4 bytes before that position were an undeclared constant (`00 00 02 00`) in every channel —
the table's own real tail, not a second gap.

Extracted the real app XML (`M-0004_A-3030-23-F0EA-O000A.xml`) from an older `.knxproj` export
found locally (not this repo's own export):

```xml
<ParameterType Id="..._PT-_DA_Kennlinie_Raw Data" Name="_DA_Kennlinie_Raw Data">
  <TypeRawData MaxSize="516" />
</ParameterType>
```

516 = 4 + 512. Decoding the 4 header bytes as big-endian uint32: `0x00000200` = 512, exactly the
payload length. Real wire format: 4-byte BE length prefix + payload. koolenex's parser never
handled `TypeRawData` at all — every `ParameterType` branch checks a specific child element before
falling through to a generic branch that reads only `TypeRestriction`'s `SizeInBit`, absent for
`TypeRawData`, hence the silent `bitSize=8` fallback.

**Fixed**: `ets-app.ts` reads `TypeRawData`'s `MaxSize` into `bitSize`; `buildParamMem()` emits the
real `[4-byte BE length][payload]` framing when a blob's declared size matches that shape, falling
back to unframed otherwise. Result: 0 diffs across all four 516-byte regions.

## Finding 4: Object 3, revisited — identity resolved, write-trigger still open

Docs had carried "Object 3, 98 bytes, unidentified" since 2026-08-27. Checking 1.1.10's real
`LoadData` declaration (`PropValueWrite OX=3 P=5 $030B000003AE...`) decodes size `0x03AE` = 942
bytes for this device (1.1.9's separate 98-byte figure is correct for its own, different device).

Read `PID_OBJECT_TYPE` (property 1) live: object 3 reports type `9`, distinct from objIdx 1/2/4's
`1`/`2`/`3` (Address table/Association table/Application Program — confirming the read is
trustworthy).

An ETS "Change Application Program" dropdown initially looked tied to object 3 (application-version
management) — corrected: it's an ETS-side file picker, though it does support loading a different
application version onto commissioned hardware, a real device-level capability.

Swept every saved capture for `OX=3 P=5` activity: every Partial Download shows zero; among Full
Downloads, only the two comprehensive-rewrite sessions touched it that day, not two routine
flag-toggle Full Downloads. Every other capture showing Object 3 activity is a first-download-of-
session or post-reconnect capture — consistent with, not proof of, "written when ETS has reason to
be uncertain."

Checked `ETS 6.4 SDK/ETS6 SDK.chm` for an object-type reference — only describes the API shape, not
values (loaded at runtime). Pointed to koolenex's own bundled `data/knx_master_1.xml`:

```xml
<InterfaceObjectType Id="OT-9" Number="9" Name="OT_GROUP_OBJECT_TABLE" Text="Group Object Table Object" />
```

Cross-checked against objIdx 1/2/4 too (types `1`/`2`/`3`, all matching). **Object 3 is the
standard KNX "Group Object Table"** — per-communication-object flags/priority, indexed by
communication object number, unrelated to application-version management.

**Still open**: why ETS only rewrites the Group Object Table on some Full Downloads and not others.

## Sources

- `2026-08-28-ets-full-download-history-and-blob-params-1.1.10.pcapng` — the full session: baseline
  reads, both ETS-driven writes, both koolenex-injected out-of-band writes, and both subsequent
  real ETS Full Downloads.
- `ETS6 SDK.chm` — checked for an object-type reference table; pointed to `data/knx_master_1.xml`
  as the real source for Finding 4.
- `tests/fixtures/relmem-real-devices/1.1.10-actual.hex`/`1.1.10-expected-computed.hex`.
- `data/apps/M-0004_A-3030-23-F0EA-O000A.json` — 24 blob-typed `paramMemLayout` entries, pre-fix.
- An older `.knxproj` export of the same project (found in a local email cache, not in this repo)
  — source for the raw XML confirming `TypeRawData MaxSize="516"`.
