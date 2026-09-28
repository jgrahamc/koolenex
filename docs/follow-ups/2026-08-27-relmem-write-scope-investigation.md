# Investigation note: does ETS write the whole relmem segment, or only named parameters?

**Status: settled.** ETS's download model never touches memory outside named
parameters/GA/Association tables/Application program — confirmed three ways: two real packet
captures (below) and KNX Association's own published documentation. Still open: the exact GA/
Association table wire format, and whether/how koolenex's write path should change as a result.

**Process note**: this investigation re-derived (via real-hardware packet captures) a conclusion
already written up in koolenex's own `research/programming-implementation.md`, months earlier —
not found until pointed at directly, since only `docs/` had been checked. Lesson: read every
docs-like folder in a repo before investigating/redesigning anything.

## Why this came up

`verify-device`'s raw byte-level comparison (`buildParamMem`) reconstructs the entire relmem
parameter segment by filling every byte with a default and patching in only named-parameter bytes.
Two real devices showed persistent raw-byte mismatches (1.1.9: 3/8178 bytes; 1.1.10: ~1985/10433
bytes) invisible to the named-parameter comparison. Question: is that raw mismatch real, or just
holding the device to a byte range ETS never touches?

Captured two real ETS Full Downloads via tshark, against 1.1.9 (Albrecht Jung KNX IP router, app
`M-0004_A-0025-10-1BA6-O00A6`) and 1.1.10 (Albrecht Jung LED dimming actuator, app
`M-0004_A-3030-23-F0EA-O000A`), both on the testbed router.

## Finding 1: every parameter-segment write matches a named parameter (both devices)

**1.1.9** — relmem base `0x5F0E`, size 8178 bytes. Real `MemExtWrite` frames landed only at
offsets 69 (1 byte, `$80`) and 197–199 (3 bytes, `$D06001`) — both match named-parameter ranges
per `paramMemLayout`. No other bytes anywhere in the 8178-byte segment were touched.

**1.1.10** — relmem base `0xC3000`, size 10433 bytes. Writes at offset 172 (1 byte, matches two
named parameters at that offset) and offset 10432 (last byte, matches a `paramMemLayout` entry
with no text label). Same result: only named-parameter bytes touched.

**Conclusion**: across both real downloads, 100% of written relmem bytes map to a known parameter
entry. Zero bytes landed in the unmapped gap region on either device.

## Finding 2: other interface objects get their own independently-resolved writes

Both devices also wrote outside the relmem segment, each preceded by a live `PropValueRead OX=<N>
P=7` (`PID_TABLE_REFERENCE`) — the same mechanism koolenex's `resolveRelmemBases()` already uses
for the parameter object. Confirmed via `POST /bus/read-property`:

**1.1.10**: objIdx 2 → `0x0C0000` (Association Table); objIdx 1 → `0x0F0000` (Address/GA Table).

**1.1.9**: objIdx 1 → `0x004000` (Address/GA Table); objIdx 2 → `0x00470A` (Association Table);
objIdx 3 → `0x00570C`, 98 bytes (unidentified at the time — later resolved as the Group Object
Table, see `2026-08-28-full-download-history-and-blob-params.md`).

Every byte either device wrote is accounted for: named parameters, or one of these table objects.

## Finding 3: GA/Association table wire format

`buildGATable()`/`buildAssocTable()` (`server/routes/knx-tables.ts`) were written for a different
delivery path (`LoadImageProp`), not the `MemExtWrite`-to-resolved-address mechanism these devices
use. Comparing computed output against 1.1.9's real captured bytes (2 GA links, degenerate:
main=0, middle=0 for both) showed the GA table matches only coincidentally; the association table
differs unambiguously — 2-byte fields not 1-byte, `[GA-index, CO-number]` order not `[CO-number,
GA-index]`, and 1-based GA indexing not 0-based. Flagged as unconfirmed pending a non-degenerate
test.

### Update: confirmed on real, non-degenerate GAs

Renumbered GAs to genuinely non-zero groups (`1/2/1`, `1/2/2`; `9/1/1`–`9/1/4`), repeated real ETS
Full Downloads to both devices, recaptured:

```
1.1.9 GA table   (X=$004000): 00 02 49 01 49 04  -> count=2, 9/1/1, 9/1/4
1.1.10 GA table  (X=$0F0000): 00 02 0A 01 0A 02  -> count=2, 1/2/1, 1/2/2
1.1.9 assoc table   (X=$00470A): 00 02 00 01 00 05 00 02 00 08  -> [gaIndex=1,co=5],[gaIndex=2,co=8]
1.1.10 assoc table  (X=$0C0000): 00 02 00 01 00 1F 00 02 00 20  -> [gaIndex=1,co=31],[gaIndex=2,co=32]
```

Both GA tables decode to exactly the real, renumbered GAs — confirms `[count:2][GA:2]…`, standard
16-bit main(5)/middle(3)/sub(8) encoding, no reordering. Both association tables are byte-identical
to the earlier degenerate capture (same device, same slots, just renumbered) — confirming, not a
null result, since it's exactly what a position-referencing `[gaIndex:2][coNumber:2]` format
predicts.

**Caveat**: small sample — two devices, one manufacturer, one testbed, one day. Strong working
assumption elsewhere, not gospel, until confirmed on a different manufacturer.

## Resolution: this isn't an ETS optimization being missed — it's ETS's actual scope

Findings 1–2 were originally framed as "ETS chooses to write sparsely, skipping unchanged bytes for
efficiency." Wrong, corrected two ways:

**1. koolenex's original author's `research/programming-implementation.md`** (predates this
investigation by months) already documented ETS's real mechanism: a "Non-Default Cache" of only
active parameters differing from default, plus a separate "Mask Tracking"/"Partial Download"
optimization for repeat downloads that koolenex never implemented (always does a full download).

**2. KNX Association's own docs** ([Download functions](https://support.knx.org/hc/en-us/articles/360007474340-Download-functions))
settle it more simply: ETS's download model has exactly four categories — Individual Address,
Application Program, Group Addresses/tables, Parameters. No download variant has a concept of
"everything else." Relmem gap bytes were never in scope for any download, first-time or repeat —
this is a category boundary fixed by the app's own parameter/GA/association definitions, not an
optimization over history.

**This simplifies what a fix needs**: not ETS-style mask/history tracking, not a live
read-modify-write pre-read — just never write outside the byte ranges you can actually name
(`paramMemLayout` offsets, plus the GA/Association table's own ranges resolved via PID 7).

## Relationship to koolenex's golden-image-catalog follow-up

A structurally similar problem was independently documented in
`docs/follow-ups/2026-07-17-golden-image-catalog.md` (an ABB device where computed image diverges
from real ETS by 2 bytes due to functional-module suppression logic invisible to koolenex). Their
proposed fix — a golden image (read a device's resolved memory back once after a real ETS
commission, or replay a captured download byte-exact) rather than recomputing — is a complementary,
more fundamental direction for cases where recomputing from parameters alone has a real ceiling.

## What this does and doesn't settle

**Settled**: ETS's four-category download model, independent of manufacturer; relmem gap bytes
never in scope for any download; a correct fix needs no history/mask tracking or live pre-read,
just restriction to known byte ranges; PID_TABLE_REFERENCE resolution generalizes to Address/
Association tables; GA/Association table wire formats (two devices, one manufacturer).

**Still open**: whether these offsets/formats generalize beyond these two apps/one manufacturer;
what 1.1.9's objIdx 3 write actually is; implementing the write-path restriction itself (design
resolved, code not yet written/tested to the same rigor as the 16-bit address fix).

## Artifacts

- Captures: `2026-08-27-full-download-1.1.9-1.1.10.pcapng` (Findings 1/2, Finding 3's first pass),
  `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` (Finding 3's non-degenerate confirmation).
- `research/programming-implementation.md` — koolenex's original author's status/plan doc, source
  for the "Non-Default Cache"/"Mask Tracking" findings above.
- KNX Association, ["Download functions"](https://support.knx.org/hc/en-us/articles/360007474340-Download-functions).
- `POST /bus/read-property` (`server/routes/bus.ts`) — read-only debug endpoint used to confirm
  objIdx 1/2/3's PID 7 bases.
- `/bus/read-memory`'s address cap widened from 16-bit to 24-bit in the same change.
- Real-device relmem fixtures: `tests/fixtures/relmem-real-devices/`,
  `tests/relmem-real-device-fixtures.test.ts`.
- GA/Association wire-format fixtures: `ga-assoc-wire-format-1.1.9.json`/`-1.1.10.json`, same test
  file.
