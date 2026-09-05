# Investigation note: does ETS write the whole relmem segment, or only named parameters?

**Status: settled.** The core question (does ETS's own download model ever
touch memory outside named parameters/GA/Association tables/Application
program) is confirmed independently three ways: two real packet captures
(below), and KNX Association's own published documentation (see
"Resolution", below). What's still open is narrower: the exact GA/
Association table wire format, and whether/how koolenex's write path should
change as a result — see "What this does and doesn't settle."

**Process note, for next time:** a large chunk of this investigation
re-derived, the hard way (real-hardware packet captures), a conclusion
koolenex's *original* author had already written up in
`research/programming-implementation.md` months before any of the code or
docs this note otherwise references existed. That file wasn't found until
pointed at directly — only `docs/` (a different, later, contributor-specific
folder) had been checked. Lesson: **always read every docs-like folder in a
repo before investigating/redesigning anything, not just the first one you
find.**

## Why this came up

`verify-device`'s raw byte-level comparison (`buildParamMem`) reconstructs
the *entire* relmem parameter segment by filling every byte with a default
(either a real manufacturer blob, `relSegData`, or a blind `0xFF` guess when
no blob exists) and then patching in only the bytes tied to named,
project-configurable parameters. Two real devices showed persistent raw-byte
mismatches (1.1.9: 3/8178 bytes; 1.1.10: ~1985/10433 bytes) that did **not**
show up at all in the named-parameter comparison. The question: is that raw
mismatch a real problem, or is it just us holding the device to a byte range
ETS itself never touches?

To answer it directly rather than by inference, we captured two **real ETS
Full Downloads** (not incremental parameter changes) via tshark, one each
against **1.1.9** (Albrecht Jung KNX IP router – additional function, app
`M-0004_A-0025-10-1BA6-O00A6`) and **1.1.10** (Albrecht Jung LED universal
dimming actuator 4-gang, app `M-0004_A-3030-23-F0EA-O000A`), both on the
testbed router. Capture: `full_download_test.pcapng`, 975 frames, TCP
KNXnet/IP tunnel (ETS uses TCP; koolenex's own bus connection uses UDP on
the same router).

## Finding 1: every parameter-segment write matches a named parameter (both devices)

### 1.1.9 — relmem segment: base `0x5F0E`, size 8178 bytes (confirmed via
`POST /bus/verify-device` — `segments[0].offset = 24334 = 0x5F0E`)

Real `MemExtWrite` frames landing inside `[0x5F0E, 0x7EFF]` during the Full
Download, and nothing else:

| Frame | Wire address | Offset from base | Bytes | Matches |
|---|---|---|---|---|
| 863 | `0x005F53` | 69 | 1 (`$80`) | `paramMemLayout` offset 69 — 10 named parameters live at offsets 69–199 in this app (confirmed via `data/apps/M-0004_A-0025-10-1BA6-O00A6.json`) |
| 869 | `0x005FD3` | 197–199 | 3 (`$D06001`) | same parameter range, its tail end |

No other bytes anywhere in the 8178-byte segment were touched. Named
parameters cover only 5 distinct byte offsets out of 8178 total — the other
8173 bytes were left completely alone.

### 1.1.10 — relmem segment: base `0xC3000`, size 10433 bytes (confirmed via
`POST /bus/verify-device` — `segments[0].offset = 798720 = 0xC3000`, end
`0xC58C0`)

| Frame | Wire address | Offset from base | Bytes | Matches |
|---|---|---|---|---|
| 390 | `0x0C30AC` | 172 | 1 (`$00`) | `M-0004_A-3030-23-F0EA-O000A_UP-1555_R-2348` — "Indicating status temporarily" (and `..._UP-1554_R-2342` "Display length seconds", same offset) |
| 399 | `0x0C58C0` | 10432 (last byte of segment) | 1 (`$01`) | `M-0004_A-3030-23-F0EA-O000A_P-1_R-2` — a real `paramMemLayout` entry, just with no text label in the product data |

Same result: only named-parameter bytes were touched, nothing in the
remaining ~10431 bytes of gap/padding.

**Conclusion so far**: across both real downloads, 100% of the bytes ETS
wrote inside a relmem segment map to a real, known parameter entry. Zero
bytes landed in the unmapped gap region, on either device.

## Finding 2: other interface objects get their own independently-resolved writes

Both devices also wrote to memory outside the relmem parameter segment
entirely — each preceded in the capture by a live `PropValueRead OX=<N>
P=7` (`PID_TABLE_REFERENCE`, the same mechanism koolenex's own
`resolveRelmemBases()` already uses for the parameter object). Confirmed by
directly reading PID 7 for those object indices after the fact via
`POST /bus/read-property` (`server/routes/bus.ts`, read-only, not on the
program/verify path):

### 1.1.10

| objIdx | Wire write | Confirmed via `read-property` |
|---|---|---|
| 2 | `0x0C0000`, 10 bytes (`$00020001001F00020020`) | `{"objIdx":2,"propId":7,"hex":"000c0000"}` → `0x0C0000` exact match — **Association Table** |
| 1 | `0x0F0000`, 6 bytes (`$000208000801`) | `{"objIdx":1,"propId":7,"hex":"000f0000"}` → `0x0F0000` exact match — **Address/GA Table** |

### 1.1.9

| objIdx | Wire write | Confirmed via `read-property` |
|---|---|---|
| 1 | `0x004000`, 6 bytes (`$000200010004`) | `{"objIdx":1,"propId":7,"hex":"00004000"}` → exact match — **Address/GA Table** |
| 2 | `0x00470A`, 10 bytes (`$00020001000500020008`) | `{"objIdx":2,"propId":7,"hex":"0000470a"}` → exact match — **Association Table** |
| 3 | `0x00570C`, 98 bytes (`$0030000000004B094B094F0C530053004F005B...`) | `{"objIdx":3,"propId":7,"hex":"0000570c"}` → exact match — object unidentified, **guess only**: possibly the per-channel mapper config (this app exposes 10 "Channel 1…10 Mapper" objects; 98 bytes loosely fits a per-channel structure), not verified |

**Every byte either device wrote during its Full Download is now
accounted for** — named parameters, or one of these three table objects,
resolved the same way parameters are. Nothing unexplained remains in
either capture.

## Finding 3 (originally speculative, now confirmed on real non-degenerate data — see update below): GA/Association table wire format

Koolenex already has `buildGATable()`/`buildAssocTable()`
(`server/routes/knx-tables.ts`), but they were written for a *different*
delivery path (`LoadImageProp` → `PropertyValue_Write`), not the
`MemExtWrite`-to-resolved-address mechanism these two devices actually use.
Comparing their computed output against 1.1.9's real captured bytes (2 GA
links: `0/0/1`, `0/0/4`; 2 association entries: CO#5→`0/0/1`, CO#8→`0/0/4`):

```
GA table:
  computed:      02 00 01 00 04
  real (wire):   00 02 00 01 00 04

Association table:
  computed:      02 05 00 08 01
  real (wire):   00 02 00 01 00 05 00 02 00 08
```

The GA table entries happen to match byte-for-byte, but only because both
real test GAs have `main=0, middle=0` — a degenerate case. The genuine,
confirmed difference: the leading `count` field is **2 bytes** wide on the
wire (`00 02`), not the 1 byte `buildGATable()` assumes.

The association table is unambiguously a different layout, not just a
width difference:
- **field width**: 2 bytes per value, not 1
- **field order**: wire is `[GA-index, CO-number]`; `buildAssocTable()`
  produces `[CO-number, GA-index]`
- **GA indexing base**: wire GA-index is 1-based (`1`→`0/0/1`, `2`→`0/0/4`);
  `buildAssocTable()` is 0-based

**This is a guess extrapolated from a single tiny example (2 GAs, 2
associations, all with main/middle group = 0) — not a confirmed format.**
It should not be treated as ground truth without at least one more real
capture from a device with non-zero main/middle group numbers and more
than 2 association entries, to separate "real format" from "coincidence
that only showed up because the test data was simple."

### Update 2026-08-28: confirmed on real, non-degenerate GAs

Renumbered the real project's GAs to genuinely non-zero main/middle groups
(`1/2/1`, `1/2/2` under a new "Lighting" function; `9/1/1`–`9/1/4` under a
new "Astro" function) specifically to settle this, then repeated a real ETS
Full Download to both 1.1.9 and 1.1.10 and re-captured via tshark (1.1.10's
first attempt that day aborted right after `IndAddrSerNumRead`/
`DevDescrRead`, before any memory writes — the analysis below is from its
successful second attempt only). Fixtures:
`tests/fixtures/relmem-real-devices/ga-assoc-wire-format-1.1.9.json` and
`-1.1.10.json`, with an executable decode spec in
`tests/relmem-real-device-fixtures.test.ts`.

```
1.1.9 GA table   (X=$004000): 00 02 49 01 49 04
  -> count=2, GA1=0x4901=9/1/1, GA2=0x4904=9/1/4  (real: "9/1/1", "9/1/4" under 9/1 Astro)

1.1.10 GA table  (X=$0F0000): 00 02 0A 01 0A 02
  -> count=2, GA1=0x0A01=1/2/1, GA2=0x0A02=1/2/2  (real: "1/2/1 Ch1-SW", "1/2/2 Ch1-FB")

1.1.9 assoc table   (X=$00470A): 00 02 00 01 00 05 00 02 00 08
  -> count=2, [gaIndex=1,co=5], [gaIndex=2,co=8]

1.1.10 assoc table  (X=$0C0000): 00 02 00 01 00 1F 00 02 00 20
  -> count=2, [gaIndex=1,co=31], [gaIndex=2,co=32]
```

Both GA tables decode to exactly the real, renumbered project GAs — direct,
unambiguous confirmation of `[count:2][GA:2]…`, the standard raw 16-bit
main(5)/middle(3)/sub(8) encoding, no reordering. Both association tables
are **byte-identical to the earlier degenerate-GA capture** (same device,
same two GA-table slots, just renumbered) — which is itself confirming
evidence, not a null result: it's exactly what `[gaIndex:2][coNumber:2]`
per entry, 1-based, POSITION-referencing (not value-referencing) predicts,
since the same two table slots are still filled either way.

**Caveat — read before treating this as settled elsewhere:** this is still
a small sample. Two devices, both from the same manufacturer (Albrecht
Jung), both on the same testbed router, captured on the same day. It
confirms the format for *these* devices/apps with real confidence, but
it's real evidence from a narrow slice, not a guarantee every
manufacturer's app uses the same table layout — treat as a strong working
assumption elsewhere, not gospel, until/unless it's seen holding on a
different supplier's device too.

## Resolution: this isn't an ETS optimization being missed — it's ETS's actual scope

Findings 1 and 2 above (packet-capture evidence) were originally framed as
"ETS *chooses* to write sparsely, skipping unchanged/unmapped bytes" — as
if the gap bytes were in scope but skipped for efficiency (mask-tracking,
partial-download). That framing turned out to be wrong, corrected two ways:

**1. `research/programming-implementation.md`** (koolenex's ORIGINAL
author, John Graham-Cumming, 2026-03-31 — four months before any of the
System B/relmem work or the golden-image follow-up existed; found only
after being explicitly pointed at, see the process note above) already
documented the real ETS mechanism and named the exact gap in koolenex:

> "**Non-Default Cache** — Build the set of parameters that need to be
> written: those that are both active AND have a value different from
> their default. This is the key insight: only non-default active
> parameters are downloaded."

> "**Mask Tracking** — ETS6 tracks which bytes in the memory image were
> explicitly written (via a parallel Mask buffer). During download, only
> written bytes are sent — this enables 'partial download' where unchanged
> bytes are skipped. We currently send the entire segment."

> "**Partial Download** — ETS6 supports downloading only the changed
> parameters (using the mask tracking). This requires knowing what was
> previously downloaded (the 'loaded image' stored in the .knxproj). We
> don't track this — we always do a full download."

Read at face value, this suggested mask-tracking is an ETS-internal
*optimization over history* (skip what didn't change since the last
download) — which would imply koolenex's gap-byte problem is really about
missing that history-tracking machinery (project-file bookkeeping of
"what was last written"), a nontrivial piece of infrastructure to
replicate.

**2. KNX Association's own published documentation resolves this more
simply.** [Download functions](https://support.knx.org/hc/en-us/articles/360007474340-Download-functions)
(support.knx.org):

> "ETS distinguishes between the following download parts of a KNX
> device: **Individual address**, **Application program(s)**, **Group
> addresses** (more precisely, group addresses and the links between
> group objects, the tables), **Parameters**."
>
> "**Download All** — All project data in ETS will be downloaded into the
> corresponding device(s)... Involved flags: Adr, Prg, Par, Grp."
>
> "**Download Partial** — ETS will download only the parts that were
> changed in ETS and have not been downloaded before. ETS distinguishes
> between two parts: Parameters/Addresses (group addresses and group
> objects); Application programs. Involved flags: Par, Grp."

This is the authoritative answer, and it's simpler than either the
"skipped for efficiency" framing or the mask-tracking-as-history framing
above: **ETS's download model has exactly four categories, full stop.**
There is no fifth "general/raw memory" category anywhere in it. "Download
All" (Full Download) already means "all of exactly these four things" —
not "everything ETS could theoretically write." The relmem gap bytes were
never in scope for *any* download variant, first-time or repeat, because
parameter memory outside named parameters isn't a category ETS's own
model has a concept of at all. "Partial download" (the `Par`/`Grp`
history-skipping the research doc's mask-tracking describes) is a
*further* narrowing within the already-narrow four-category scope — an
optimization for *repeat* downloads specifically, not what defines the
category boundary itself. The boundary is fixed by the app's own
parameter/GA/association definitions, every download, not by comparison
against history.

**This simplifies what a fix would need**, versus earlier framings in this
document and in conversation:
- **Not** ETS-style mask/history tracking (no need to know "what did we
  write last time" — that solves a different problem, bus-traffic
  efficiency on repeat downloads, unrelated to the gap-byte question)
- **Not** a live read-modify-write pre-read either (an earlier idea, floated
  before this resolution: read the device's current state first, preserve
  what you don't understand) — that only matters if you're trying to
  preserve bytes you don't understand; if those bytes are simply never in
  scope, there's nothing to preserve *from* a read at all
- **Just**: never write outside the byte ranges you can actually name —
  the same `paramMemLayout` offsets `decodeParamMem` already uses, plus
  the GA/Association table's own byte ranges (once their wire format is
  confirmed — see Finding 3), resolved via PID 7 the same way it's already
  done today for the parameter object

## Relationship to koolenex's own golden-image-catalog follow-up

koolenex's maintainers independently documented a structurally similar
problem in `docs/follow-ups/2026-07-17-golden-image-catalog.md` (merged in
`bdf6f39`, `feat/read-memory`): an ABB device (1.1.13) where koolenex's
computed image diverges from real ETS output by 2 bytes (RGB status-
lighting colour thresholds), because ETS applies "layer-3"/functional-
module suppression logic ("Orientierungsbeleuchtung mode") that isn't
expressed in the parameter dynamic structure koolenex has access to. Their
proposed fix is **not** "write/compare only named-parameter bytes" — it's
more fundamental: stop recomputing the expected image at all, in favor of
a **golden image**, either (A) reading a device's resolved memory back
over the bus once after a genuine real ETS commission and caching it per
app+config, or (B) parsing a real ETS download packet capture into an
address→bytes recipe and replaying it byte-exact.

This investigation's findings are consistent with, and a smaller-scope
complement to, that same underlying problem — this note is about *whether
byte range X is in ETS's write scope at all*, not about correctly deriving
what value belongs in a byte range ETS *does* touch when that value
depends on manufacturer functional-layer logic invisible to koolenex (the
1.1.13 case). Both point toward the same conclusion: recomputing from
parameters alone has a real, evidenced ceiling, and capturing/replaying
real ETS behavior is the more robust direction long-term.

## What this does and doesn't settle

**Settled** (packet-capture evidence on two devices + KNX Association's
own published documentation, three independent confirmations, not just
inference):
- ETS's download model has exactly four categories — Individual Address,
  Application Program, Group Addresses/tables, Parameters — full stop. No
  download variant (Full or Partial) has a concept of "everything else."
- Relmem gap bytes were never in scope for any ETS download, first-time or
  repeat — this isn't an optimization ETS applies over history, it's a
  category boundary that's the same on every download.
- Restricting `verify-device`'s raw byte-level comparison to exclude
  unmapped/gap bytes is justified by direct evidence now, not just theory.
- The `PID_TABLE_REFERENCE` (PID 7) resolution pattern generalizes cleanly
  to other interface objects (Address Table, Association Table, and a
  third unidentified object on 1.1.9), not just the parameter object.
- A correct write-path fix doesn't need history/mask tracking (ETS's own
  "Partial download" mechanism) or a live pre-read of the device (an
  earlier idea from this conversation) — just never writing outside the
  four known categories' byte ranges, every download, unconditionally.
- The GA table and Association table wire formats (Finding 3) — confirmed
  2026-08-28 on real, non-degenerate GAs (two devices, both Albrecht Jung —
  see the caveat right after Finding 3's update: real confidence for these
  devices/apps, not proof it generalizes to every manufacturer).

**Still open / not confirmed**:
- Whether the *specific offsets found so far* (both the named-parameter
  offsets and the now-confirmed GA/Association table format) generalize
  beyond these two apps/devices, both from one manufacturer, to the wider
  device population this project targets (the four-category *boundary*
  itself is settled from KNX Association's own docs, independent of
  manufacturer; per-app/per-manufacturer specifics still need checking as
  they come up, same as always).
- What 1.1.9's objIdx 3 (98-byte write) actually is.
- Implementing the write-path change (`buildParamMem` /
  `downloadDevice`'s `WriteRelMem` step, and any future GA/Assoc table
  writer, restricted to named-parameter/known-table byte ranges only) —
  the *design* question is now resolved, but it's still the one code path
  that's destructive on real hardware, and deserves the same test-coverage
  rigor as the 16-bit address fix before being trusted, not a quick change
  off the back of this investigation alone.

## Artifacts

- Capture files (filtered to `cemi and tcp`, dropping unrelated multi-interface
  UDP noise): `2026-08-27-full-download-1.1.9-1.1.10.pcapng` (Findings 1/2 and
  Finding 3's first, degenerate-GA pass) and
  `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` (Finding 3's confirmation on
  real non-degenerate GAs) — kept in the knx-ets-manager repo, not here (they
  back this repo's own strategy record rather than being koolenex's own
  concern): `../knx-ets-manager/docs/data/captures/`, see that folder's own
  README for what each contains.
- `research/programming-implementation.md` — koolenex's original author's
  own status/plan doc, 2026-03-31, predates everything else referenced
  here by months. Source for the "Non-Default Cache" / "Mask Tracking" /
  "we always do a full download" findings above.
- KNX Association, ["Download functions"](https://support.knx.org/hc/en-us/articles/360007474340-Download-functions)
  — authoritative source for ETS's four-category download model.
- `POST /bus/read-property` (`server/routes/bus.ts`) — read-only debug
  endpoint added to confirm objIdx 1/2/3's own PID 7 bases after the fact;
  not used by the download/verify pipeline itself.
- `/bus/read-memory`'s address cap widened from 16-bit to 24-bit in the
  same change, since the underlying `readMemory()` already supports
  extended addressing (see the 16-bit truncation fix) and the route's own
  validation was needlessly rejecting valid high addresses.
- Real-device relmem fixtures for 1.1.9/1.1.10 (and 1.1.0's prop-verify
  data) captured from this investigation's findings:
  `tests/fixtures/relmem-real-devices/` and
  `tests/relmem-real-device-fixtures.test.ts`.
- GA/Association table wire-format fixtures (Finding 3's 2026-08-28
  confirmation): `tests/fixtures/relmem-real-devices/ga-assoc-wire-format-1.1.9.json`
  and `-1.1.10.json`, with an executable decode spec in the same test file
  above.
