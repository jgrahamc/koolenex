# KNX device write protocol — reference

**⚠️ Not an official or KNX-Association-endorsed document.** Everything below is this project's
own best-effort interpretation of observed device behavior, reverse-engineered from real network
traffic — not a reproduction of, or a substitute for, the official KNX specification. Where a
finding isn't independently confirmed against real hardware, it's tagged as such (see "How to
read this document" below); treat unconfirmed items as working hypotheses, not documented fact.

This document describes how a KNX configuration tool (ETS, the standard KNX Engineering Tool
Software) writes project data onto a physical KNX device over KNXnet/IP — the sequence of
messages sent, what each one means, and the byte layouts involved.

**Methodology**: every fact here was derived from real ETS 6.3 download sessions against
physical devices, with the actual network traffic captured and decoded byte-by-byte — not taken
from the KNX specification or ETS's own documentation directly. Where a byte's meaning is stated
without a spec citation, treat it as an empirically observed pattern (tagged accordingly, see
below), not a documented guarantee. For narrative/history behind these findings (how each one was
discovered), see the dated files under `docs/follow-ups/*.md`.

## How to read this document

Every factual claim is tagged:

- 🟢 **CONFIRMED** — directly observed on real captured traffic or real hardware (see
  [Sources](#sources)). Trust this.
- 🟡 **INFERRED** — a reasonable conclusion from confirmed evidence, not independently verified
  in isolation.
- 🔴 **SPECULATIVE** — a guess or open question. Not a fact.

**Sample size varies by section.** §1–§3, §4.2–§4.3, §5, §6.1–§6.3, object 3's record layout
(§6.4), and §7 are confirmed only against the two Albrecht Jung devices in this project's own
testbed (1.1.9, 1.1.10), both mask `0x07B0` (System B, a device classification explained in §1) —
nothing there has been confirmed against a different manufacturer or mask version, unless noted.
§4.1 (memory-write service selection) and §4.1d (Verify Mode) have a much broader real sample: all
eight devices in the Test hardware table above, across four manufacturers (Albrecht Jung, HDL,
Gira, Weinzierl) as of 2026-09-01 — see those sections for the breakdown. §4.1a–§4.1c (chunk sizing, cached APDU length,
the legacy write-encoding fix) are confirmed on HDL in addition to the two Jung devices. §9 (device
addressing) is confirmed on HDL in addition to Jung.

## Some KNX terms used throughout

A device's application logic exposes **communication objects** — application-level "channels"
(e.g. "switch output 1", "dimming value"). Each communication object can be linked to one or more
**group addresses (GAs)** — the "topic" addresses devices actually exchange values over on the
bus. A communication object's value has a **Datapoint Type (DPT)**, KNX's standard classification
of a value's format and size (e.g. "1 bit", "1 byte unsigned", "4 byte float").

Internally, a device organizes its own configuration data into **interface objects** — logical
sub-components addressed by a small integer, the **object index**. This document is mostly about
four of them: object 1 (the table of group addresses in use), object 2 (which communication
object is linked to which group address), object 3 (each communication object's own flags — see
§6.4), and object 4 (the device's actual application settings — every parameter a user configures
in the tool). Within an interface object, individual named attributes are called **properties**,
each addressed by a **property ID**.

Every device also reports a 2-byte **mask version** — a KNX-standardized code identifying which
"generation"/family of device management model it implements (e.g. `0x07B0` = "System B"). This
matters because it changes which lower-level services the device actually supports (§4.1).

## Test hardware

Real hardware used across this document, spanning two sites: this project's own testbed, and a
second, unrelated production site. The **Write service** column exists because §4.1 (which
memory-write service a device requires) and §4.1d (Verify Mode) are confirmed or cross-checked
against every device below; everywhere else in this document (§1–§3, §5–§7) is derived from the
three testbed devices only.

| Device | Manufacturer | Individual address | Mask version | Site | Write service | Role |
|---|---|---|---|---|---|---|
| KNX IP router (additional function) | Albrecht Jung | 1.1.9 | `07B0` (System B) 🟢 | Testbed | Extended | koolenex writes |
| 4-gang dimmer actuator | Albrecht Jung | 1.1.10 | `07B0` (System B) 🟢 | Testbed | Extended | koolenex writes — real memory addresses above `0xFFFF`, and the only testbed device whose configuration declares the checksum step (§7) |
| `M/AG40B.1` actuator | HDL | 1.1.20 / 1.1.21 (readdressed across sessions) | `07B0` (System B) 🟢 | Testbed | Legacy | koolenex writes — added to diversify the testbed by manufacturer; used extensively, across §4.1a–§4.1d and §9 |
| 5292 1ST pushbutton | Albrecht Jung | 1.1.240 | — | Production | Extended | ETS download only |
| Presence detector Universal | Albrecht Jung | 1.1.42 | — | Production | Legacy | ETS download only — same manufacturer as the extended-service devices above, isolating app generation from manufacturer (§4.1) |
| TSM pushbutton | Albrecht Jung | 1.1.200 | `MV-0705` | Production | Legacy | ETS download only — older app generation (`LoadProcedureStyle="ProductProcedure"`, §4.1d) |
| Smoke alarm, part 234300 | Gira | 1.1.24 | — | Production | Legacy | ETS download only — no `LdCtrlWriteRelMem`/`Verify` attribute at all (§4.1d) |
| `KNX IO 534 CV (4D)` RGBW controller | Weinzierl | 1.1.11 | — | Production | Legacy | ETS download only — falsified the `PID_MCB_TABLE` byte-5 candidate rule (§4.1) |

Mask versions confirmed via a live device-descriptor read against real hardware (§2.1) where
noted, cross-checked against the KNX standard's own published mask-version table, which classifies
`07B0` (and its variants `17B0`/`27B0`/`57B0`, for different physical media) as management model
"System B" — a real KNX-standardized device-family classification, not manufacturer-specific.

## 1. Session overview

Every real device-configuration session follows the same shape:

1. **Bootstrap**: connect, read device identity, authorize (§2).
2. **Per-object write cycle**, for each interface object that needs a change: mark it unloaded →
   start loading → declare the data that's coming → the real memory/property write(s) →
   mark it loaded again (§3–§4).
3. **Finalize**: write a version marker back, then restart the device (§5).

A **Full Download** runs this cycle for every relevant interface object, regardless of whether
its content actually changed — though the underlying memory write itself only ever writes the
bytes that actually differ (§6.1), never the whole object unconditionally. A **Partial Download**
is a stricter version of the same sequence: only the interface objects whose content genuinely
changed go through the cycle at all — everything else is skipped outright, with no "mark
unloaded" step and no write. The two are otherwise frame-for-frame identical, distinguished by
one single signal in the data (§4.2). A Partial Download's write to the parameter object (§6.1)
is not limited to the edited byte(s) alone — it also always includes that object's own final
byte, regardless of what was actually edited.

## 2. Session bootstrap

### 2.1 Connection and identity

A **device-descriptor read** is sent as the very first message of every real session 🟢 — the
device's response carries its mask version (§ above). 🟡 **INFERRED**: the tool almost certainly
uses this to decide device-family-specific behavior later (which memory-write service to use,
§4.1) — not confirmed from any spec text, but consistent with it being the literal first thing
done every time, and with the real mask-gated finding in §4.1.

Before the real work starts, several short-lived connections are opened and closed, doing
identity reads and a broadcast lookup of the device's serial number by address, sometimes
including a defensive restart request 🟢 — then the connection that does the actual work begins.
🟡 **INFERRED**: pre-flight identity/health checks; not everything here is necessarily required
for a correct download.

Identity/status values read early in every session (all simple property reads on object 0 unless
noted):

| Property purpose | Notes |
|---|---|
| Serial number | Readback, matches the device's real serial |
| Association-table capability descriptor (a property read on object 2) | Same single read every session, Full or Partial |
| Application version marker (object 4) | Read here, written back verbatim later — see §4.3 |
| A handful of other status fields | 🔴 Several of these values' exact meaning was never looked up against a KNX property reference — not required to understand the write path |

None of these early reads are content-dependent — none of them could reveal whether a device's
memory content had been tampered with out-of-band (relevant to §7.3).

### 2.2 Authorize

An authorize request/response exchange, using an access-level key. Sent once, early, with the
well-known default key (`0xFFFFFFFF` — used when a device has no special access restriction
configured); the response carries a 1-byte access level (`0` = full access, observed in every
capture). 🟢 Present in every real capture. 🔴 whether a device configured with a non-default
access key would behave differently is untested (this testbed's devices are presumed
factory-default).

## 3. The load state machine

Each interface object tracks its own state — **Unloaded**, **Loading**, or **Loaded** — via a
dedicated "load state control" property. Writing a specific event value to that property drives
the object through the state machine 🟢, confirmed identically across every real session
observed:

| Event written | Meaning | Resulting state |
|---|---|---|
| Unload | Mark the object as no longer valid, about to be replaced | Unloaded |
| StartLoading | Begin a new load | Loading |
| LoadData (+ 9 extra bytes, §4.2) | Declare what's about to be written — size, mode, fill value | Stays Loading |
| LoadCompleted | Commit the load | Loaded |

Objects that need writing are unloaded first, in reverse index order (e.g. 4 then 3 then 2 then
1), then loaded in a fixed order that is **not** simple ascending or descending index order
(observed order: 4, then 3, then 1, then 2) 🟡 — likely dependency ordering between objects
specific to the application, not verified against other configurations.

### 3.1 Phases are batched across objects, not run one object at a time

🟢 **Real ETS runs each load-state phase across every object that needs writing before moving to
the next phase**, rather than completing one object's entire Unload → StartLoading → LoadData →
resolve-address → write → LoadCompleted cycle before starting the next object's. Confirmed by
frame-by-frame decode of a real ETS capture: every object's Unload is sent first, then every
object's StartLoading+LoadData, then every object's memory address is resolved (the
`PID_TABLE_REFERENCE` read, §6), and only then does each object's write/LoadCompleted proceed.

This matters concretely for a genuinely blank (factory-reset) device, where an object's real
memory segment has never been allocated: `PID_TABLE_REFERENCE` reads back `0x00000000`
("unallocated") until the device itself allocates it as a side effect of processing the batch of
StartLoading/LoadData declarations across *all* objects together. An implementation that resolves
one object's address immediately after its own StartLoading/LoadData — before the other objects'
declarations have been sent — can read back an unallocated address for objects later in the
sequence, even though the exact same write would succeed once batched correctly. This was found
and fixed 2026-08-30 in `downloadDevice()` (`server/knx-connection.ts`) by collecting every
object's write into one job list and running each phase (Unload-all, StartLoading+LoadData-all,
resolve-all, write, LoadCompleted-all) across the whole batch, instead of a per-object sequential
loop. Confirmed end to end afterward: a real Full Download against a genuinely blank, factory-reset
device wrote all four objects cleanly in one run, and a subsequent Verify matched the parameter
memory byte-for-byte (0 of 8178 bytes differing).

## 4. Wire format reference

### 4.1 Memory write services

Two different lower-level services exist for writing raw memory content into a device: a
**legacy** form (16-bit address) and an **extended** form (24-bit address, needed for memory
locations above `0xFFFF`). **Real ETS used the extended form exclusively for every write
observed on this testbed** — including for addresses that fit easily in 16 bits, not just the
ones that structurally require the 24-bit form. 🟢, confirmed across every Full and Partial
Download captured, both devices.

The response to each such write carries a 1-byte status field (observed value `0x01` on every
successful write — 🔴 **SPECULATIVE**: given every one of these writes demonstrably succeeded,
this is unlikely to mean "an error occurred"; more likely a status/return code whose exact
meaning per the KNX spec isn't confirmed here) plus a 2-byte trailing value that looks like a
checksum of the written data 🔴 (pattern observed, not verified against a specific algorithm).

**Mask-version gating — 🔴 DISPROVEN as a sole/reliable rule, 2026-08-31, see the
`IsSecureEnabled` hypothesis below for the current candidate replacement**:

- 🟢 Both real Jung devices tested (1.1.9, 1.1.10) report mask `0x07B0` ("System B") and both
  used the extended write service exclusively — reconfirmed with a fresh live capture 2026-08-31,
  same result.
- 🟢 A verbatim byte-for-byte replay of a real captured ETS write against real hardware
  persisted correctly. An identical write attempted using the legacy service instead (chosen
  because the target address happened to fit in 16 bits) failed to persist — reproducibly, with
  no error returned at any protocol layer. (This was originally believed to be an address-size
  wraparound bug — koolenex genuinely was using the 16-bit legacy service unconditionally at the
  time — but the controlled replay specifically isolated a SEPARATE effect: even a legacy write
  built for an address that itself fits within 16 bits still failed to persist, meaning the fix
  needed is not just "switch to extended once the address exceeds 0xFFFF".)
- 🔴 **The generalization "mask `0x07B0` ⇒ requires the extended service" is now known FALSE**: a
  third mask-`0x07B0` device (HDL `M/AG40B.1`, this project's own testbed, added 2026-08-31) used
  **legacy** `A_Memory_Write` for its own real Full Download — confirmed via a live capture, at an
  address (`0x170E`) that also fits comfortably in 16 bits. koolenex forcing extended for this
  device (inherited from the mask-based rule) produced a real, reproducible silent write failure —
  the device link-layer ACKed every chunk but never sent the real
  `MemoryExtended_Write_Response`, and a direct read-back afterward confirmed the content never
  persisted. Mask alone cannot be trusted as the discriminant; do not reintroduce a mask-only rule
  without new evidence.
- 🔴 Whether legacy (pre-System-B) mask families genuinely *require* the legacy service, or would
  also tolerate the extended one, is still untested — no such device has ever been available to
  test.

**Candidate rule #1 (`IsSecureEnabled`) — 🔴 SPECULATIVE, NOT YET CONFIRMED, real request
2026-08-31**: comparing the real `<ApplicationProgram>` XML of all four apps in this project's own
testbed `.knxproj`, the one clean, binary signal consistent with every known real data point is
the app's own `IsSecureEnabled` attribute — `true` on all three Jung apps (including both
confirmed-extended devices, 1.1.9/1.1.10), completely **absent** (not `false` — never written at
all) from the HDL app (confirmed-legacy). Implemented in `server/ets-app.ts`
(`ParamModel.isSecureEnabled`/`AppIndex.isSecureEnabled`) and threaded through
`DownloadExtra.isSecureEnabled` into `downloadDevice()`'s write-service decision
(`server/knx-connection.ts`) — now the second fallback layer, since candidate rule #2 below
(a live, per-device signal) takes priority when available; the real mask read remains the third
fallback, and the plain address-size heuristic (`addr > 0xFFFF`) stays underneath all three as a
hard floor that can never be suppressed by any of them.

A segment-SIZE-based theory (HDL's segment is 152 bytes; the two Jung devices' segments are 8178
and 10433 bytes) was considered too, and is also consistent with the same data — rejected as the
implemented rule specifically because it would require guessing a numeric threshold across a wide,
completely unconfirmed gap (anywhere from ~200 to ~4000 bytes would fit the three known points
equally well), whereas `IsSecureEnabled` is a real declared boolean requiring no threshold at all.

**A fourth real device reinforces the same pattern**: Jung 5292 1ST (a 2-gang
pushbutton panel, product `M-0004_H-4.20.2F.2F.2052921ST-0-O000A_P-52921ST`, app
`M-0004_A-D142-21-8848-O000A`) — a genuine **live production device** at a second, unrelated real
site, downloaded to directly via real ETS (not a koolenex write).
`IsSecureEnabled="true"`, segment `Size="6152"`, real capture confirms
`MemExtWrite` used throughout, including at least one chunk (`X=$00F000`) whose address fits
comfortably in 16 bits — the same decisive shape as the original 1.1.9 evidence. 4 for 4 now
(`IsSecureEnabled=true` → extended on all three Jung/production apps; absent → legacy on the one
HDL app), and the segment-size gap the size-based theory would need to resolve narrows
considerably too (152↔6152, down from 152↔8178).

**This is still only a hypothesis, not an independently confirmed rule**, and every one of the
confirming data points so far is a real ETS write, not a koolenex one (koolenex's own
extended-service write to a device with `IsSecureEnabled` absent has been tested exactly once —
HDL, and it correctly used legacy per this rule, matching real ETS — but that's the only case
where koolenex's OWN write, gated on this rule, has been confirmed against real hardware
end-to-end; the rest of the evidence is entirely from watching what real ETS does, not from
koolenex writing to those devices). What would actually settle it as a rule, not just a pattern: a
real device/app with `IsSecureEnabled=false` (or absent) and a LARGE parameter segment, or one
with `IsSecureEnabled=true` and a SMALL segment — neither combination has ever been tested.
Re-test against a new device/app before trusting this in any context where a silent write failure
would matter. Tracked in the `knx-ets-manager` repo's `CLAUDE.md` ("Track B write-path status"
section, standing-gaps list) too — update both if this gets confirmed or disproven.

**Update 2026-09-01 — sample considerably broadened, including a same-manufacturer control test,
still an inference not a confirmed rule.** Real captures now cover all eight devices in the Test
hardware table above, across four manufacturers: `IsSecureEnabled="true"` and extended service —
three Jung devices (1.1.9, 1.1.10, and the production 5292 1ST pushbutton). `IsSecureEnabled`
absent and legacy service — HDL (`M/AG40B.1`), a Gira smoke-alarm device, Weinzierl's `KNX IO 534
CV (4D)`, and two further Jung devices: a "Presence detector Universal" and the TSM pushbutton
(`MaskVersion="MV-0705"`, `LoadProcedureStyle="ProductProcedure"` — a materially different load
mechanism from the `MergedProcedure`/`RelSegment`-style apps used everywhere else in this
document). The latter two are notable because they are the same manufacturer as the three
`IsSecureEnabled=true` devices above, isolating app generation from manufacturer as the candidate
explanatory variable — eight for eight, no counter-example found so far. Still an inference, not a
proof: the underlying mechanism connecting `IsSecureEnabled` to write-service selection is not
independently confirmed from any primary KNX source, and the falsifying test described in the
paragraph above (a large-segment app with `IsSecureEnabled` absent, or a small-segment app with it
present) has still never been run.

**Candidate rule #2 / real mechanism (`PID_MCB_TABLE`, property 27) — 🟢 CONFIRMED for apps that
declare it.** Property 27 is `PID_MCB_TABLE` ("Memory Control Table" — confirmed against
calimero-core's `properties.xml`, `<usage>subsegmentation of memory space and checksum</usage>`,
`pdt="24"`). Its value is a sequence of 8-byte elements (size prefix, a status byte, and a
checksum); an app can declare more than one element per object via `Count` on its
`LdCtrlLoadImageProp` step.

The write-service decision is determined by **byte 5 of this property's value for object index 4**,
and the mechanism differs by how the app declares it:

- **Apps that declare `LdCtrlWriteProp` for `ObjIdx="4" PropId="27"`** (e.g. the Jung apps in this
  project's testbed and at a second, unrelated production site): the value ETS writes is literal
  `InlineData` baked into the app XML at compile time, not computed or read from the device. Byte 5
  of that literal data is ground truth for the write service, available statically from the project
  file — no bus round-trip required. Example (production-site pushbutton,
  `M-0004_A-D142-21-8848-O000A`):

  ```xml
  <LdCtrlWriteProp ObjIdx="4" PropId="27" Verify="false" InlineData="00001804003300000000" />
  <LdCtrlWriteProp ObjIdx="4" PropId="27" StartElement="2" Verify="false" InlineData="00000004013300000000" />
  ```

  Byte 5 here is `0x33` → extended memory writes, matching the app's own known-correct behavior.
  These apps also declare the separate, read-only `LdCtrlLoadImageProp` step for all four objects
  (a verification pass, confirmed by real capture to run after every write and never change the
  value) — reading it back simply returns what `LdCtrlWriteProp` already wrote.

- **Apps with no `LdCtrlWriteProp` for `PropId="27"`** (e.g. HDL's `M-0073_A-20A9-10-EAA5`): there
  is no static value to read. `PID_MCB_TABLE` is only ever read via `LdCtrlLoadImageProp`, and real
  capture evidence shows this read happening as a trailing verification pass, after every write for
  the session has already gone out — too late to have informed anything. For these apps, byte 5 of
  a *live* read is used as a fallback correlate (`0xFF` = legacy, confirmed across 5 real HDL
  captures), but the real decision mechanism ETS itself uses for this app family is not confirmed.

**Implementation** (`server/knx-connection.ts`): `downloadDevice()` scans its `steps` for a
`WriteProp` step with `propId === 27` before resolving `useExtendedMemory`; when found, byte 5 of
its `data` is used directly and nothing else (`IsSecureEnabled`, the mask read, or the live
`LoadImageProp` read) is allowed to override it. `MEM_CHUNK` is recomputed to match whenever the
resolution changes.

**Confirmed against real captures on two independent apps** — a re-run of testbed device 1.1.10,
and a real production pushbutton at the second, unrelated site (device 1.1.240) — both writing
`PID_MCB_TABLE` for object 4 early in the session, well before any data write, matching their
apps' own `LdCtrlWriteProp` `InlineData` exactly. HDL's app was checked directly and confirmed to
have no such declaration.

🔴 **Open**: the exact KNX-spec meaning of byte 5 is not confirmed by any primary source checked
(calimero's `properties.xml`, Wireshark's dissector, KNX Association's support forum). For apps
without a declared `LdCtrlWriteProp`, the real write-service decision mechanism remains unknown —
only that reading `PID_MCB_TABLE` isn't it. What would settle the open question: a device/app
without `LdCtrlWriteProp` for property 27 whose live byte-5 read doesn't match its actual required
service — not yet seen.

**Update 2026-09-01 — this candidate rule is now DIRECTLY FALSIFIED, not merely "confirmed for
apps that declare it"; downgrade accordingly.** The counter-example the "open" paragraph above
flagged as never having been seen has now been found: the Weinzierl `KNX IO 534 CV (4D)` app
declares `LdCtrlWriteProp` for `PropId="27"` on object 4 (`InlineData="00000014003200000000"`,
byte 5 = `0x32`), and a real capture confirms this matches the live device exactly (`PropValueResp
OX=4 P=27 ... $0000001400327908...`) — objects 1/2/3's own `PID_MCB_TABLE` values are likewise
non-`0xFF` (byte 5 = `0x33` on each) — **yet this device confirmedly uses the LEGACY write
service** (`A_Memory_Write`, not `A_MemoryExtended_Write`, throughout a real Full Download). The
rule as stated predicts non-`0xFF` ⇒ extended; this is non-`0xFF` and legacy. Byte 5's real value
is being read correctly here; it simply does not discriminate legacy from extended for this
device. **Demoted — byte 5 of `PID_MCB_TABLE` is not a reliable write-service signal.** See the
updated `IsSecureEnabled` discussion above (candidate rule #1), which has since absorbed the
leading-signal role this rule briefly held.

### 4.1a Real per-device memory-chunk size ceiling (`PID_MAX_APDULENGTH`) 🟢

**A device's own declared max APDU length — not a fixed protocol-theoretical constant — is the
real, deterministic basis for safe chunk sizing**, confirmed 2026-08-31 after a real Full Download
to the HDL device stalled silently: koolenex sent a single 152-byte `MemoryExtended_Write` chunk
(well under the previously-assumed-universal 228-byte "safe" ceiling, itself only ever confirmed
against 1.1.10) and got no response at all — not a NAK, total silence — leaving the device
backlogged and unable to answer the next few objects' `PID_TABLE_REFERENCE` reads (confirmed via
direct capture comparison against real ETS: those reads came back genuinely NAK'd on koolenex's
own attempt, not merely unanswered).

Real ETS reads `PID_MAX_APDULENGTH` (property 56, object index 0 — the Device Object; confirmed
against this project's own bundled KNX Master Data, `PID-0-56`, "Max. APDU-Length") once per
session and computes the exact safe chunk size from it — this is *why* "ETS sends larger chunks to
other devices": a device with a larger declared value gets a larger real chunk, deterministically,
no trial-and-error involved. Verified by decoding a real ETS-written frame's raw wire bytes against
the HDL device: `PID_MAX_APDULENGTH` read back `55`; the real wire NPDU Length byte on ETS's own
52-byte `MemWrite` to the same device was `0x37`=`55` too — the classic KNX convention that the
wire Length field equals (real octet count − 1), so real capacity = `55+1` = `56` octets.
Subtracting the real per-service header size — read directly off the APDU-builder functions'
own byte layout (`knx-cemi.ts`), not a separate guess — gives the exact formula:

```
maxUsableChunk = (declared PID_MAX_APDULENGTH value + 1) − headerBytes
  legacy:   headerBytes = 4  (2 TPCI+APCI+count, packed together, + 2-byte address)
  extended: headerBytes = 6  (2 TPCI+APCI_EXT + 1-byte count + 3-byte address)
```

For the HDL device this gives `(55+1)−4 = 52` — exactly the number found by direct empirical
bisection of real legacy reads against the same device earlier the same session (52 succeeds, 53
fails, every time, independent of starting address). Implemented in
`KnxConnection._resolveMaxApduLength()`/`maxChunkFromApduLength()` (`server/knx-connection.ts`),
used by both the read path (`readMemory()`/`readMemoryMany()`) and the write path
(`downloadDevice()`'s `MEM_CHUNK`), replacing the fixed 63/255 (reads) and 228 (writes) constants
with this per-device real value, falling back to those same constants only when the property read
fails. Confirmed end-to-end on real hardware the same day: a fresh Full Download to the HDL device,
correctly chunked at ~50 bytes (safely under the real 52-byte ceiling), completed with zero NAKs
and all four interface objects (parameter memory, GA table, Association table, Object 3) genuinely
persisting — independently verified via direct read-back after the download.

🟢 **The extended-service header formula (6 bytes) is now independently cross-checked too**, not
just derived from code — the project file itself caches a real device's own `PID_MAX_APDULENGTH`
(see §4.1b below): 1.1.10's cached value is `233`, and `(233+1)−6 = 228` — exactly the real
228-byte extended chunk ceiling already established from a separate 2026-08-30 capture analysis, a
genuine independent confirmation, not a coincidence of re-deriving the same number.

### 4.1b The project file caches this value — no live read needed for a previously-downloaded device 🟢

**Real ETS stores its own resolved `PID_MAX_APDULENGTH` directly on each `<DeviceInstance>`
element in the `.knxproj`** — `LastUsedAPDULength` and `ReadMaxAPDULength`, confirmed present on
every real device instance checked across two separate real projects (this project's own testbed,
and a second, unrelated production site, via Jung 5292 1ST).

Confirmed exact match against a live read for one real device: HDL's cached
`LastUsedAPDULength`/`ReadMaxAPDULength` are both `55`, identical to the live `PID_MAX_APDULENGTH`
property-56 read decoded earlier (§4.1a). For 1.1.9 the two cached fields
*differ* — `LastUsedAPDULength=239`, `ReadMaxAPDULength=248` — 🟡 **INFERRED, not independently
confirmed**: `ReadMaxAPDULength` looks like the device's raw declared capability (what a live
property-56 read would itself return), while `LastUsedAPDULength` is what ETS actually chose to
use for its last real write — slightly less, plausibly a safety margin or a router/tunnel-imposed
cap layered on top of the device's own raw maximum. This distinction has not been tested directly
(e.g. by doing a live property-56 read against 1.1.9 and comparing it to both cached values) - said
here as the most likely reading of the two field names, not a confirmed fact.

**Implemented 2026-08-31**: `ets-parser.ts` already parsed `LastUsedAPDULength` per device
(`apdu_length` on the parsed device record) but silently dropped it before it ever reached the
database — never persisted, never used anywhere. Fixed: `devices.apdu_length` is now a real
persisted column (`server/db.ts` migration, `server/routes/projects.ts`'s insert), threaded
through `buildDeviceProgramming()` → `DownloadExtra.cachedMaxApduLength` /
`KnxConnection.readMemory()`/`readMemoryMany()`'s new optional parameter, and preferred over the
live `_resolveMaxApduLength()` read whenever present — a real device that's already been
downloaded to from this project needs zero extra bus round-trips to get its correct chunk size.
The live read remains the fallback for a device that's never been downloaded to from this project
(no cached value yet, e.g. right after import, before any real session).

🔴 The cached-path branch itself has not yet been exercised end-to-end on real hardware — the HDL
Full Download that confirmed the 52-byte ceiling (§4.1a) predates this caching code and used the
live property-56 read instead. Typechecked and covered by the existing `PID_MAX_APDULENGTH` test
suite (which exercises the underlying `maxChunkFromApduLength()` formula, not the cached-value
plumbing specifically), but a real download that actually takes the cached-value branch (not the
live-read fallback) has not been independently confirmed.

**Gotcha**: at least one common packet-capture tool's own protocol dissector has repeatedly
mis-displayed this write's target address in its one-line summary view (observed showing one
address when the real decoded address, from the raw bytes, was a different one). Never trust a
capture tool's own summary/quick-view for a memory-write address — always manually decode the
raw bytes.

**Real per-chunk flow control is required, not a fixed pace** 🟢: sending write chunks as a fast,
fire-and-forget burst (no wait for each chunk's own response) measurably outruns a device's own
processing rate — the device falls behind, and any read issued to it while backlogged (e.g. the
next object's `PID_TABLE_REFERENCE` resolve, §3.1) goes unanswered, indistinguishable from an
unallocated address. Real ETS avoids this by waiting for each chunk's own write response before
sending the next one — confirmed directly from a real capture: per-chunk response time varies
observably (56ms–279ms), never a fixed pace. A per-chunk `await` on the matching
`Memory_Response`/`MemoryExtended_Write_Response` (generous timeout, tolerant catch-and-continue —
occasionally missing one response should not abort the whole download) matches this behavior.
Implemented in `downloadDevice()`'s memory-write loop (`server/knx-connection.ts`).

**Real per-chunk size: up to 228 bytes** 🟢. Decoded every `MemoryExtended_Write` chunk size
directly from a real ETS Full Download capture
(`docs/data/captures/2026-08-30_ets_full_download_serial_addressing.pcapng`): the real values seen
are 1, 2, 3, 4, 5, 6, 7, 10, 15, 30, 61, 62, 97, and 228 bytes — ETS writes as much as fits in one
chunk, capped at 228, using smaller values only for a segment's tail remainder or genuinely small
segments. `MEM_CHUNK` is set to `228` accordingly. Confirmed live on real hardware: a Full Download
to 1.1.10 (10,433 bytes of parameter memory) that previously took 9+ minutes to reach 54% completed
cleanly in ~38 seconds at this chunk size.

**228 is also safe for reads** 🟢 (`readMemory()`/`readMemoryMany()`, used by `/bus/verify-device`).
`readRegionInSession()`'s own `Math.min(chunkSize, length - off)` already clamps correctly down to
a small region's real length regardless of chunk size, so 228 is safe for both the large
parameter-memory region (where it matters for speed) and small undeclared tables (where it's a
no-op). **Gotcha worth keeping in mind when diagnosing a read failure**: an over-length read
request (e.g. built from a stale/mismatched table-size computation) can come back as a genuine
device-reported error (`rc=252`) that looks like a chunk-size problem but is actually a
request-size problem — check the requested length against the table's real allocated size before
suspecting the chunk size itself.

**A read bug, independent of chunk size**: a real device answered a large single read request (98
bytes, Object 3's whole table) with a genuinely SHORT response (~34 real bytes) — the request was
well-formed and the device ACKed it (`returnCode=0`), it simply didn't return everything asked for
in one response. `readRegionInSession()`'s loop used to advance its read offset by the REQUESTED
amount regardless of how much data actually came back, permanently losing the shortfall — every
later byte silently stayed at the output buffer's zero default, indistinguishable from genuine
on-device content (this produced a symptom identical to real device-side data loss: a whole block
of communication-object flags reading back as blank/default, consistently, across multiple real
downloads from both koolenex and real ETS). Fixed: the read loop now advances by what was ACTUALLY
received, retrying for the genuine remainder, rather than assuming a fixed chunk size always
arrives in full. **General lesson**: a symptom that looks identical whether produced by "the device
didn't persist this" or "the read didn't retrieve this" cannot be told apart by re-reading with the
same buggy read path, no matter how many times — only a deliberately differently-shaped read (a
smaller, separate chunk) revealed which one it actually was.

**A third, separate read bug**: the legacy (non-extended) `Memory_Read` service packs its requested byte
count into a 6-bit field of the APCI byte, giving a real maximum of 63, not 255 (the extended
service's limit). A request for exactly 64 bytes silently wrapped to a 0-byte count field
(`64 & 0x3f = 0`), producing a well-formed but meaningless request; the device correctly rejected
it with a genuine `Memory_Response returned zero bytes` failure. Fixed by capping the per-request
count to the real limit of whichever service is in use (63 legacy / 255 extended) before building
the request, rather than only after receiving a response.

### 4.1c Legacy `A_Memory_Write` wire-encoding bug, fixed 2026-09-01 🟢

Every legacy `A_Memory_Write` frame koolenex ever sent was malformed on the wire, in every code
path that used it (the main `WriteRelMem` chunk loop, the raw `memWrite` download-step handler, and
`identify()`'s single-byte blink write). The bug had gone uncaught because every previously
real-hardware-confirmed write (both Jung testbed devices, 1.1.9/1.1.10) resolves to the *extended*
write service (§4.1) — this legacy path was never actually exercised against real hardware until
HDL (the first tested device requiring legacy writes) was added to the testbed.

**Root cause**: `A_Memory_Write`'s byte count is a short-APCI field — it belongs in the low 6 bits
of the 2-byte TPCI/APCI header word itself (the same encoding `apduMemoryRead()` already used
correctly for the read side). The frame builder every write call site used, `apduConnected()`, has
no parameter for this at all — it always leaves those 6 bits at zero. Every caller worked around
this by prepending a literal count byte onto the data buffer passed as `extraBuf`, which is not
where a real device looks for it: the receiving device parses the two bytes immediately after the
header as the 16-bit memory address, so that leading "count" byte was read as the *address's own
high byte*, shifting the intended address and every data byte after it by one position.

**Confirmed from a real capture**, not inferred: a real Full Download to 1.1.20 (HDL) sent a 52-byte
chunk intended for object 4's real relmem base (`0x1766`) that landed on the wire as address
`0x3417` with an encoded count of 0 (`0x34` = 52 decimal, the stray count byte, read as the
address's high byte; `0x17` = the real address's own high byte, read as the low byte) —
`captures/hdl-full-download-1120-2026-09-01.pcapng`, frame 702, manually decoded byte-for-byte
against the KNX standard's own short-APCI bit layout (not read from a capture tool's summary
column — see §8's dissector caveat). Two further chunks in the same session repeat the pattern at
addresses `0x3417` and `0x3017`, matching the same off-by-one-byte shift for different chunk
contents. The device's response confirmations stopped arriving for every write after this point,
and the next three objects' `PID_TABLE_REFERENCE` reads (object indices 1, 2, 3) got no response at
all — the malformed frame is the direct explanation for that session's cascading "4 unconfirmed
writes" and completely-skipped Object 3 write, not general device flakiness.

**Fix**: added `apduMemoryWrite()` (`server/knx-cemi.ts`), mirroring `apduMemoryRead()`'s existing,
correct pattern — count folded into the header word's low 6 bits via `apduConnectedFull()`, address
and data following as a plain buffer with no leading count byte. All three call sites in
`server/knx-connection.ts` now use it instead of hand-building the frame through `apduConnected()`.

**A second, related bug surfaced once the encoding was fixed and count was actually reaching the
wire**: `MEM_CHUNK` (sized up to 228 bytes, correct for the extended service's full 1-byte count
field) was being used unconditionally for legacy chunks too, whose 6-bit count field caps out at 63
— exactly the same shape as the already-documented legacy `Memory_Read` count-wraparound bug above,
just never triggered on the write side because no real count was ever reaching the wire before this
fix. The address-size fallback heuristic (no known mask version) can resolve a *different* service
per chunk within the same write when the resolved base straddles `0xFFFF`, so this could not be
fixed by capping `MEM_CHUNK` once for the whole loop — the `WriteRelMem` chunk loop now computes
each chunk's own step size from that chunk's own resolved service (`Math.min(MEM_CHUNK, 63)` for
legacy, `MEM_CHUNK` for extended), decided before slicing rather than after.

Regression-tested against the real captured frame's own bytes
(`tests/memory-read.test.ts`, `describe('apduMemoryWrite')`) and against the mixed-service chunking
behavior (`tests/relmem-write-protocol.test.ts`). 🟢 **Confirmed on real hardware, 2026-09-01**: a
real Full Download to 1.1.20 sent legacy `MemWrite` frames at the correct addresses
(`X=$1766`→`$179A`→`$17CE` for the parameter object, `X=$1002` for the GA table — all matching the
dry run below exactly), captured via tshark — no more `$3417`/`$3017` garbage. A subsequent real
`/bus/verify-device` read-back confirmed the actual device content: parameter memory 152/152 bytes
matching (0 differing), and all four Object 3 (Group Object Table) flag rows reading back correctly
set (`Update=Yes Write=Yes` as expected) — this is the exact "flags reading back as unset" symptom
from the prior (buggy) session, now resolved. 164 of 164 decoded comparison points matched, 0
mismatches.

**Confirmed hardware-free via a dry run, 2026-09-01**: `downloadDevice()` (real, unmodified code)
run against real 1.1.20 project data (`buildDeviceProgramming()`, same pipeline the real route
uses) through a fake in-process bus device seeded with the real base addresses and MCB values
already captured from ETS — no hardware touched. Three of the four real interface-object writes
matched real ETS byte-for-byte: GA table (`N=2 X=$1002 0000`), Association table
(`N=2 X=$125C 0000`), and both chunks of the Group Object Table (`N=52 X=$170E
002B930093...`/`N=36 X=$1742 0000...`), including Object 3's nontrivial real content. The
parameter object (obj 4) had no real-ETS reference in this particular capture to diff against, but
its chunk addressing (`$1766`→`$179A`→`$17CE`, 52/52/48 bytes) is internally consistent with the
fixed encoding.

🔴 **Open, unrelated to this fix, found by the same dry run — do not let this quietly drop**: real
ETS also sends a single-byte `MemWrite X=$17FD $01`, immediately after a `PropValueWrite OX=0 P=14`
(an object-0 load-state property), that koolenex's current step derivation does not produce at all.
`0x17FD` doesn't fall inside any of the four objects' own relmem tables (object 3 ends at
`0x170E+0x58=0x1766`, object 4 starts there) — looks like a separate step this app declares that
koolenex doesn't yet parse/model. Needs identifying: check what `OX=0 P=14` and the real app's own
`LoadProcedures` XML declare around this point in the sequence.

### 4.1d `PID_DEVICE_CONTROL` (property 14, object 0) — Verify Mode and write confirmation 🟢/🔴

The `PropValueWrite OX=0 P=14` step flagged as open above is `PID_DEVICE_CONTROL` (confirmed
against the KNX Master Data, `data/knx_master_*.xml`: `Number="14" Name="PID_DEVICE_CONTROL"
PDT="PDT-51"`, a 1-byte bitfield on the Device Object). Bit layout, per the KNX Association's
open-source reference device stack (`knx.readthedocs.io`, `src/knx/device_object.cpp`): bit 0
`USER_STOPPED`, bit 1 `OWN_ADDR_DUPL`, bit 2 `VERIFY_MODE` (`0x04` — the value observed being
written), bit 3 `SAFE_STATE`.

**🟢 Confirmed mechanism**: for the legacy `A_Memory_Write` service, the same reference stack's
`BauSystemB::memoryWriteIndication()` writes memory unconditionally but only sends a
`Memory_Response` back **if Verify Mode is set**; the extended-service handler,
`memoryExtWriteIndication()`, responds unconditionally with no such gate. This precisely explains
a full-session real-hardware symptom: writes that persist correctly but never generate a device
reply on the legacy service, resolved by writing `PID_DEVICE_CONTROL=$04` (read the current value
first — commonly `$00`; on at least one real device it carries other bits already set, e.g. `$01`,
in which case the write ORs in bit 2 rather than replacing the byte) once per session, before the
memory writes that need a confirmed reply. Confirmed via a controlled real-hardware isolation
test: an identical write positioned before this property write got no reply; the same write moved
to after it got a normal reply — same bytes, same device, only position changed.

**🟢 Real per-device evidence, extended-service devices never touch this property at all** — every
Jung app/device captured (real ETS sessions, not koolenex writes) uses the extended write service
throughout and never reads or writes `PID_DEVICE_CONTROL`, consistent with the reference stack's
extended-write handler having no Verify Mode dependency to begin with.

**🔴 What was NOT the trigger, ruled out directly**: an earlier hypothesis held that a literal
`Verify="true"` attribute on an app's own `LdCtrlWriteRelMem` declaration was the real per-project
signal driving this. That hypothesis does not survive a broader check across app files: the
attribute is present, identically, on every `RelSegment`/`MergedProcedure`-style app examined so
far — including three Jung apps whose real captures never touch `PID_DEVICE_CONTROL` at all. It
appears to be closer to a fixed default for this load-procedure style than a live, per-device
signal, and should not be relied on to predict this behavior.

**🟡 What does correlate, across every device/app checked so far, with no exception found**: which
memory-write service the device uses. Every device confirmed to require the legacy service has
also been confirmed to require this property write; every device confirmed to use the extended
service has never been observed to touch it. Since the same `IsSecureEnabled`-based inference
already used for write-service selection (§4.1, candidate rule #1) is itself only a hypothesis,
this is presented as an inference built on an inference, not an independently established fact —
the two open questions ("which write service does this device need" and "does it need Verify
Mode") currently appear to have the same answer, but neither has a confirmed root cause from a
primary KNX source.

**A structurally different app family exists, using neither `RelSegment`/`WriteRelMem` nor a
`Verify` attribute of any kind**: some apps (observed on a Gira smoke-alarm app and on
older-generation Jung apps sharing the same `MaskVersion="MV-0705"`/`LoadProcedureStyle=
"ProductProcedure"` shape) use `LdCtrlAbsSegment`/`LdCtrlTaskSegment` instead, with no
`LdCtrlWriteRelMem` step at all. Real captures confirm these devices also require the legacy
write service and also receive the `PID_DEVICE_CONTROL=$04` write — consistent with the
write-service correlation above, but reached by a mechanism this document has no visibility into
from the project file alone (no `Verify` attribute exists anywhere in these apps to point to).

🔴 **Separately open, not resolved by the above**: a single-byte content anomaly at the offset the
original `MemWrite X=$17FD` targets (the last byte of the parameter object's relative segment on
one tested device) has been observed reverting to a default/fill value when that object's
`LoadData` declaration is sent without an explicit follow-up write to that byte, and requiring a
targeted one-byte patch to correct. This is a distinct question from the Verify Mode mechanism
above — it concerns device-side content persistence, not reply behavior — and remains unexplained.
Nothing in the relevant `Parameter`/`ParameterType`/`RelativeSegment` declarations in the project
file distinguishes this byte from any neighboring one.

### 4.2 The 9-byte "LoadData" declaration

Before writing the real content, the tool declares what's about to come, as 9 extra bytes on the
LoadData event (§3). Confirmed byte-for-byte identical layout across every real example
observed 🟢:

```
byte:    0     1-2      3-4         5      6      7-8
         flag  reserved size (BE)   mode   fill    reserved
```

- **flag** — always observed as one specific fixed value. 🔴 exact spec meaning not looked up;
  doesn't appear to vary.
- **size** — matches the object's real total write-segment size exactly, every time (e.g. 8178,
  98, 10, or 6 bytes, depending on the object). 🟢
- **mode** — **one value means a Full Download, a different value means a Partial Download**,
  confirmed for the parameter-memory object across one real Full and two real Partial Downloads
  on the same device. 🟢 for that object; 🔴 not independently confirmed for the other objects
  (no real Partial-Download example of this declaration exists for them, since those objects
  were only ever loaded at all during a Full Download in every real capture available).
- **fill** — the byte value the tool declares for filling any part of the segment it doesn't
  explicitly write (observed as one value for the parameter object, a different value for the
  others, both consistent with what's actually found on real device memory for genuinely
  untouched "gap" bytes). 🟢 for the value pattern; 🔴 for *why* the parameter object specifically
  differs from the others — not investigated, may be configuration-specific rather than a general
  rule.

### 4.3 Version-marker read-back-and-write-back

The tool reads a version-identifier property on the parameter object early in the session, then
writes the *identical* value back verbatim right before the final "mark loaded" step, in every
real capture (Full and Partial). 🟢 the pattern. 🔴 **SPECULATIVE** *why*: plausibly
"re-registering the freshly-loaded segment as belonging to a known application version, without
which the final commit might not durably take effect" — consistent with the fact that omitting
this step (in an early, buggy write-path implementation) correlated with writes not persisting,
but no controlled test isolates this one step's necessity on its own.

## 5. Session finalization

A restart request is sent once, at the very end, and gets a real response acknowledging it. 🟢
the pattern; 🔴 the response's trailing bytes' exact meaning (possibly a "how many seconds this
will take" field) is not spec-confirmed.

**Timing** (this testbed only, not necessarily representative elsewhere) 🟢: round-trip
acknowledgement typically 5–15ms per message; most load-state transitions ~10–60ms, except
"start loading → declare data" and the final "mark loaded" step, which can take 300–600ms — worth
knowing if a write-path implementation has a timeout waiting for the device to restart and
respond again afterward. Full Download total wall time ~6s; Partial Download ~2.7s. 🔴 whether
these scale with parameter memory size or network conditions is untested.

## 6. Per-object write mechanics

### 6.1 Object 4 — application parameter memory

The largest object, holding every user-configured setting. 🟢 **A Full Download only writes bytes
that actually differ from what's already on the device** — confirmed directly (a real "clean"
Full Download, with zero actual configuration changes, wrote a single differing byte, not the
whole multi-thousand-byte segment) and confirmed history-independent: a device carrying stale or
out-of-band content is detected and corrected (§7.3), not silently trusted just because it
happens to match.

**Sub-byte-packed parameters and padding bits**: when a parameter occupies only part of a byte
(e.g. a single-bit setting sharing a byte with other unrelated bits), the byte's other,
unrelated bits — not covered by any parameter — should be zero-filled, not left at whatever
generic "unwritten gap" fill value the rest of the segment uses. 🟢 confirmed against real
device content: a real single-bit setting's real on/off values are `0x80`/`0x00` (only the one
bit varying), not `0xFF`/`0x7F` as a naive "fill the rest with the generic gap value" approach
would produce. Bytes genuinely untouched by any parameter still use the generic fill value.

**Large "blob" parameters**: some parameters use a multi-hundred-byte raw-data type rather than a
simple scalar/text/numeric value (their declared maximum size, in bytes, is stated directly in
the project data). 🟢 confirmed against real project data and real device content: **the wire
format for one of these is a 4-byte length value (big-endian) followed by the actual payload**,
not the raw payload alone. 🔴 whether this framing (a length prefix before the payload)
generalizes to every blob-typed parameter, or is specific to the one case it was confirmed
against, is unconfirmed.

**Partial Download always writes the object's own final byte, alongside whatever was actually
edited.** 🟢 confirmed byte-for-byte against a real ETS Partial Download that changed a single
parameter value: the wire traffic carried two separate single-byte writes, not one — the edited
byte itself, and a second write to the object's last byte (`base + size − 1`), whose value did
not correspond to anything the user changed. This holds even when the edited parameter is nowhere
near the end of the object. The mechanism behind it (a device-side commit/trailer marker for the
segment, vs. an ETS-side convention) is not confirmed — only that it happens unconditionally
alongside any other write to this object. A Partial Download write that omits this byte leaves it
at its previous value, which reads back as a real mismatch on the next verify.

### 6.2 Object 1 — group address table

Wire format: a 2-byte count, followed by one 2-byte group address per entry, in the standard raw
16-bit main/middle/sub-group encoding, no reordering. 🟢, small sample (2 devices, one
manufacturer).

### 6.3 Object 2 — association table

Wire format: one entry per link, each a pair of 2-byte numbers — which group-address-table
position it refers to, and which communication object it's linked to — 1-based, referring to
table *position*, not a value match. 🟢, same sample caveat.

**Entry order encodes which link is the "send" link.** For a communication object with multiple
links, the first entry in table order (not necessarily the lowest position number) is the one it
actively transmits on; the rest are receive-only. 🟢 confirmed directly: swapping which of two
group addresses a communication object sends on swaps the order of the two matching entries here,
with no other change anywhere (the object-3 flags described below, and the group address table
itself, are both unaffected). Link direction is **not** represented anywhere else — this entry
order is the only encoding of it.

**A real bug, found 2026-08-30**: koolenex's own table builder sorted entries by group-address
index/communication-object number before writing them, discarding this real declared order. The
communication objects are already supplied to the builder in the project's own declared order;
the sort was unnecessary and actively wrong. Fixed by removing it. Confirmed byte-for-byte against
a real ETS capture once removed.

### 6.4 Object 3 — per-communication-object flags table

🟢 This is the standard KNX "Group Object Table" — confirmed via a live object-type property read
on a real device, cross-referenced against the KNX standard's own published interface-object-type
list. Distinct from the group address table (object 1, holds the addresses themselves) and the
association table (object 2, maps links to communication objects) — a table specifically about
each communication object's own settings (its flags, priority, and expected data size).

**Size and location**: per-device/configuration — 98 bytes at one address on one device, 942
bytes at a different address on the other (readable via a standard "give me this object's real
memory location" property, stable across sessions). The size is computable directly:
`size = 2 × (highest communication-object number the configuration statically declares) + 2` —
deliberately the configuration's total possible range, not a given device's currently-linked
subset (space is pre-allocated for every communication object the configuration could ever
expose). Confirmed exact against both real testbed devices.

**Record layout** — a 2-byte header followed by 2 bytes per communication object:

```
bytes 0-1:   header — total declared communication-object count, big-endian

byte offset within the table (for communication object number N, N ≥ 0) = 2 × N

  flag byte:
  bit:  7      6         5           4      3     2                       1  0
        Update Transmit  Read-On-Init Write  Read  Comm-flag AND has-link  Priority

  companion byte: standard KNX "Group Object Size" code (see table below)
```

The offset formula does not shift when an object is disabled or unlinked 🟢 — confirmed directly
(disabling a lower-numbered object's communication left every higher-numbered object's byte
position unmoved). Safe to use unconditionally, without needing to know which objects are
currently active.

**Flag bits**, confirmed by systematic one-flag-at-a-time real hardware testing (each change
made individually, its exact effect on this table observed, then reverted), cross-confirmed on a
second communication object on the same device, a third object with a different data type/size,
and blind on a second device entirely (the expected byte was predicted purely from the
configuration data before capturing the real device, and matched exactly):

- **Update, Transmit, Read-On-Init, Write, Read** — plain per-object on/off settings, each
  independently confirmed. (Read-On-Init means: read this object's current value from the bus
  automatically when the device starts up.)
- **Bit 2 = "Communication enabled AND has at least one real link" — both required, a combined
  state, not the Communication setting alone.** 🟢 Confirmed via three independent real tests:
  removing a linked object's only group-address link flips this bit to off even with
  Communication still enabled; disabling Communication on a linked object also flips it to off
  even with the link left fully intact; an object with two links shows the same bit as one link
  (a plain "has at least one link" boolean, not sensitive to how many). Link *direction* is not
  represented here at all (§6.3).
- **Priority** (the last 2 bits) — one of four levels a communication object can be sent/received
  at on the bus:

  | Priority | Bits |
  |---|---|
  | Low | `11` |
  | Alarm | `10` |
  | High | `01` |
  | System | `00` 🟡 inferred by pattern — this level isn't reachable from ETS's own user interface at all (per KNX's own documentation), so no real configuration can exercise this value directly to confirm it |

**A real parser bug, found 2026-08-30**: a project's XML declares each communication object twice
— once at the application level (the object's default `Read-On-Init`/`Priority`), and once per
device instance, which can override either. koolenex's parser only read the application-level
declaration; a device-instance override was silently dropped. Fixed by also reading the
instance-level attributes, when present, and preferring them. Confirmed against a real ETS
capture: the affected byte (Read-On-Init) now matches exactly once the override is applied.

**Group Object Size code** (the companion byte) — the standard KNX 4-bit code for a
communication object's expected data size, confirmed 4-for-4 against real declared sizes on both
test devices (1.1.9, 1.1.10 — same manufacturer, not independently confirmed on another):

| Code | Size | Code | Size |
|---|---|---|---|
| 0 | 1 Bit | 8 | 2 Byte |
| 1 | 2 Bit | 9 | 3 Byte |
| 2 | 3 Bit | 10 | 4 Byte |
| 3 | 4 Bit | 11 | 6 Byte |
| 4 | 5 Bit | 12 | 8 Byte |
| 5 | 6 Bit | 13 | 10 Byte |
| 6 | 7 Bit | 14 | 14 Byte |
| 7 | 8 Bit / 1 Byte | 15 | variable length |

🔴 Whether this record layout holds for a device outside the "System B" mask family (§ above) is
untested — only System B has ever been available.

**Write triggers** (§7.2/§7.3 describe the general mechanism this table shares with objects 1/2;
specifics for this table):

- **Partial Download**: written together with objects 1/2 exactly when any communication
  object's state genuinely changes — a group-address link, a flag, or Priority — confirmed
  across many real downloads, both directions (written when something changed, correctly skipped
  when nothing did).
- **Full Download**: on the device whose configuration declares the checksum step (§7), written
  exactly when that checksum comes back looking wrong (§7.3) — not for any kind of genuine
  configuration change on its own. On the device whose configuration never declares that step at
  all (so has no way to detect tampering), it's written on every Full Download tested,
  unconditionally. 🟡 A coherent, well-supported explanation — a device with no verification
  signal defaults to always rewriting this table just to be safe — but not a controlled test that
  isolates the cause.

## 7. The content-status ("checksum") property and the safety-net rewrite

### 7.1 What it is, precisely

**Property ID 27**, read/written on interface objects 1 (group address table), 2 (association
table), 3 (per-communication-object flags table), and 4 (parameter memory) — the same property
number, repeated across four different objects, one content-status value per object. It's
effectively a checksum the device itself computes over that specific object's own content, so
the configuration tool can ask "does what's on you still match what I last wrote?" without
reading the raw memory bytes back and comparing them directly. A real example of a valid value
read from object 4's property 27 on the test device that uses it: `000028C0003365E4000000010133DCBD`
(16 bytes) — this exact value recurs identically across every genuine session with no tampering.

Whether a device's configuration even makes use of property 27 at all comes from the
configuration data itself, not a decision the tool makes dynamically: every device's own
configuration carries a "what to do on download" recipe (a list of load-procedure steps) —
authored by the device's manufacturer as part of the product data, not computed at download time.
Only configurations whose recipe includes a property-27 step touch it at all; one of this
project's two test devices' recipes never mentions property 27, so it is completely absent from
every session with that device — no read, no write, in any form, at any stage.

The device that does declare it has, in its recipe, two separate "write this literal fixed byte
value into object 4's property 27" steps, positioned before the step that writes the real
parameter content, followed by a "read (not write) object N's property 27" step for each of
objects 1, 2, 3, and 4, positioned at the very end of the session.

Two real wire facts about this mechanism, confirmed on real hardware across multiple independent
downloads, on the one device whose configuration declares it:

- 🟢 **The end-of-session read step really is read-only, for all four objects it's used on** —
  the value read back is byte-identical to what was there before the session started. Despite
  being labeled as a "load" step in the configuration data, it never writes anything; the only
  actual write to property 27 anywhere in the whole session comes from the two "write this
  literal value" steps against object 4 specifically, near the start.
- 🟢 **The literal byte value declared in the configuration data for those two write steps is
  always exactly 2 bytes longer than what's actually sent over the wire** — the tool drops the
  last 2 declared bytes before transmitting.

🔴 Only one device configuration has ever declared property 27 at all — the *shape* of both
facts above is backed by many different manufacturers' declared configuration data (the same
two-step pattern, just with different embedded byte values, recurs across several unrelated
manufacturer IDs), but live wire confirmation is from this one real device only.

### 7.2 The group-address/association/flags tables are written by a mechanism outside any one configuration's control

🟢 Real ETS writes the group address table and association table during a Full Download via the
identical unload/start-loading/declare-data/write/mark-loaded mechanism used for parameters —
regardless of whether the device's own configuration recipe (§7.1) declares a step for them at
all. One test device's configuration declares no step whatsoever for these two tables, and ETS
writes both anyway; the other device's configuration declares the read-only checksum-verification
step instead (§7.1), and ETS still writes both via this same separate mechanism. 🟡
**INFERRED**: this table-writing procedure is apparently universal, tied to the device's mask
version rather than something each configuration must ask for — not confirmed from spec text,
only from the absence of a declaration combined with real wire evidence. Confirmed independently
on both test devices. 🔴 whether this holds for every mask family, or for configurations with
many more group-address/association entries, is untested.

### 7.3 The safety-net rewrite, and what triggers it

Does a device carrying stale content — from a different, discarded configuration, or a factory
reset — keep that content forever, if it happens to already match what the *current*
configuration's target computation predicts needs no write?

🟢 **No.** A value written directly into device memory bypassing the configuration tool entirely
is detected on the very next real Full Download — not via a minimal targeted correction, but a
**comprehensive rewrite**: nearly the entire parameter segment, the per-communication-object
flags table, and both the group-address and association tables. Reproduced on both test devices.
The rewrite's content is correct, not a blind reset to factory defaults — real, previously
in-place values are written back correctly where they should stay unchanged.

🟢 **The detection mechanism, confirmed across 5 independent real Full Downloads on the device
whose configuration declares property 27 (§7.1)**: early in every session, before any load/write
decision, the tool reads object 4's property 27. In every genuine session — two clean baselines,
a real group-address-link change, a real parameter change — this read returns the same valid
16-byte value, e.g. `000028C0003365E4000000010133DCBD`. In the one session preceded by an
out-of-band write (a value written directly into device memory, bypassing the tool entirely), the
identical read instead returns **empty — zero bytes, not a different-but-valid value** — the
device's own checksum computation broke down as a direct, observable consequence of the
tampering. This is not a raw memory read (no memory-read message of any kind appears in any of
these captures) — it's a property-level read whose *result* differs based on device state, and it
happens well before the unload/reload cycle begins for any object.

A decisive control test isolated the real variable: writing the *exact same byte* via the
configuration tool (instead of bypassing it) produces a valid checksum and no comprehensive
rewrite — the origin of the write (genuine tool-driven session vs. out-of-band) is what matters,
not the byte or parameter itself. Neither "any configuration change to a parameter" nor "any
configuration change to a group-address link" triggers the comprehensive rewrite on its own.

🔴 Whether this generalizes beyond the one device configuration checked (the only one that
declares the checksum mechanism at all) is untested, as is the precise decision rule once an
anomaly is detected (whether it's graded, or always the same universal rewrite).

## 8. Known tooling/methodology gotchas

- **At least one common packet-capture tool's own protocol dissector mis-displays memory-write
  addresses in its summary/quick-view column** (§4.1). Always manually decode the raw bytes;
  never trust a summary column for a memory-write's address.
- **This router's KNXnet/IP tunneling connection uses TCP, not UDP** — a UDP-only capture filter
  catches nothing from real sessions against it. Worth checking which transport a given device
  actually uses before assuming the KNXnet/IP default.
- **Windows path handling across tools**: a process spawned as a native Windows executable does
  not reliably translate Unix-style paths (`/tmp/...`, `/c/...`), whether passed as arguments or
  used in direct file-system calls from within a cross-platform runtime. Use explicit
  `C:/Users/...`-style forward-slash paths for direct file I/O on Windows, and prefer writing
  intermediate results to files rather than piping between processes when mixing a Unix-style
  shell with native Windows tools.

## 9. Device addressing — a separate protocol family

Everything above (§1–§8) assumes the target device already has a known individual address on the
bus. **Assigning that address in the first place is a different KNX service family — "network
management".** This section is deliberately kept separate from the rest of the document; it's
about addressing, not configuration content.

Three such services are implemented in `server/knx-connection.ts`:

- `checkProgrammingMode()` — `A_IndividualAddress_Read`, the standard button-press discovery
  broadcast real ETS uses for its normal "press the button on the device you want to commission"
  flow.
- `readSerialNumbersInProgrammingMode()` — `A_SystemNetworkParameter_Read`/`_Response` for
  `PID_SERIAL_NUMBER` (object type 0 = Device): `NM_Read_SerialNumber_By_ProgrammingMode`, reading
  the serial number of whichever device(s) are in programming mode, no address needed at all.
  Collects every reply within the timeout window rather than stopping at the first, since multiple
  simultaneous devices reply cleanly with no collision (🟢 confirmed) — the real way to
  disambiguate multiple *blank* devices, whose addresses would otherwise be identical (shared
  factory default).
- `writeIndividualAddressBySerial()`/`readIndividualAddressBySerial()` — `A_
  IndividualAddressSerialNumber_Write`/`_Read` (spec 3/5/2 §2.5/§2.4), a no-button-press
  alternative that addresses a device by its 6-byte KNX serial number instead.

### 9.1 Real wire format, confirmed byte-for-byte against a real ETS capture 🟢

Settled by capturing real ETS traffic (tshark) during a factory-reset + full-download
commissioning cycle (button press, address assignment, serial-number verify) against this
project's own testbed router:

- **All four services above are sent as GROUP-type cEMI frames to address `0/0/0`** (KNX's
  "default broadcast" address) — not an individual-type frame to `0.0.0`, and not KNX's separate
  "system broadcast" ctrl1 bit.
- **All four use ctrl1 `0xB0`** — the *ordinary* broadcast bit (bit4=1) at **System priority**
  (bits3-2=`00`) — not the plain `0xBC` (Low priority) every other frame in this codebase uses.
- `A_IndividualAddressSerialNumber_Response`'s payload is `[serial(6)][4 reserved zero bytes]` —
  no address field; the device's address is carried by *which device replies* (cEMI `src`), the
  same convention `A_IndividualAddress_Response` uses.
- `A_SystemNetworkParameter_Response`'s payload echoes the request's operand byte before the
  actual value: `[objectType(2)][pid<<4 (2)][echoedOperand(1)][...value]`.
- Response APCI `0x3DD` (`A_IndividualAddressSerialNumber_Response`) is confirmed real.

All four services are sent over the **normal Tunneling connection** — Routing/multicast is not
required for any of this. A Routing/multicast connector and TCP Tunneling support both exist in
this codebase as real, independently useful capabilities (`knx-protocol-routing.ts`,
`knx-protocol.ts`) - TCP Tunneling in particular matches what real ETS itself uses against this
router, where this codebase previously spoke UDP only - but neither is a prerequisite for the
services documented in this section.

### 9.2 Confirmed working end-to-end on real hardware 🟢

`checkProgrammingMode()` correctly returns a pressed device's real current address; the new
`readSerialNumbersInProgrammingMode()` correctly returns that same device's real serial number
(independently cross-checked against the value decoded from the ETS capture itself) with the
correct current address. `writeIndividualAddressBySerial()`'s write was independently confirmed to
take effect on real hardware (a device moved from its factory-default address to a real target
address) even before this correction; the correction fixes its own read-verify step, which had
been silently failing due to the wrong response-payload decode above.

**The write's own verification read needs a retry, not a single attempt** 🟢 confirmed
byte-for-byte against a real factory-reset device: `assignIndividualAddressBySerial()` broadcasts
the write, then a verification read - a device that hasn't fully woken up yet after the write can
miss that first read's timeout window entirely, even though the write itself already landed. A
real capture shows the write at t=9.19s, a first verification read at t=9.21s going unanswered
(timing out ~3s later), then a second verification read exactly 2s after that timeout, which the
device (now answering with its own address as cEMI source, not just a router echo) answers
correctly. Fixed by retrying the read over a real deadline instead of a single attempt - the same
shape as real ETS's own behavior captured independently in §9.3 below (its factory-reset
verification read is also retried once after a ~3s timeout), not a workaround unique to this
codebase.

### 9.3 Real ETS Factory Reset procedure, confirmed byte-for-byte 🟢

Not yet implemented in koolenex — captured as reference for a future factory-reset feature.
Sourced from a real tshark capture of ETS performing "Factory Reset" against an HDL actuator
(`M/AG40B.1`, app `M-0073_A-20A9-10-EAA5`) on this project's own testbed, real-hardware button
press required (ETS did not know the device's serial number beforehand). Full sequence, in order:

1. **Discovery**: broadcast `A_IndividualAddress_Read` (`PhysicalAddress_Read`, APCI `0x0004`)
   every ~3s until the device (button held) answers with `A_IndividualAddress_Response`
   (`0x0005`), carrying its *current* address as the reply's cEMI source.
2. **Identify**: point-to-point `T_Connect` to that address, `A_DeviceDescriptor_Read` (confirms
   mask version), `A_PropertyValue_Read` on `PID_LOAD_STATE_CONTROL`-family property 56.
3. **Authorize**: `A_Authorize_Request` (APCI `0x03D1`) with key `FFFFFFFF` — the standard
   default/no-security key — unlocks write access. Response `A_Authorize_Response` (`0x03D2`).
4. **Per-channel reset sweep**: `A_PropertyValue_Write` (APCI `0x03D7`), same property ID (5),
   same 10-byte payload `04 00 00 00 00 00 00 00 00 00`, **repeated once per functional channel
   with Object Index incrementing 1→2→3→4→5** (this device has 5 channel-family interface
   objects) — each acknowledged individually. Reads `PID_ORDER_INFO`-family property 11
   afterward (unchanged, identity confirmation only).
5. **Exit programming mode, explicitly**: `A_PropertyValue_Write` on **Object Index 0, PID 54
   (`PID_PROGMODE`) = `0x00`** — a real, separate command, not an implicit side effect of the
   later Restart/address-write. This is the mechanism a future koolenex factory-reset (or
   address-write) implementation should call to make the device visibly leave programming mode,
   matching real ETS.
6. **Disconnect** the point-to-point session.
7. **Address reset via serial**: broadcast `A_IndividualAddressSerialNumber_Write` (`0x03DE`) —
   `[serial(6)][newAddr(2)][4 reserved zero bytes]`, using the serial ETS just learned from step 4
   (`00733c005b42` in this capture) — **newAddr = `15.15.255`**, the standard KNX
   factory/unassigned individual address. This step, not the button-press mechanism, is what
   actually resets the *address* — steps 1–6 handle programming-mode discovery and application/
   parameter content, not addressing.
8. **Verify**: `A_IndividualAddressSerialNumber_Read` (`0x03DC`) by the same serial, retried once
   after a ~3s timeout with no answer; the eventual `A_IndividualAddressSerialNumber_Response`
   (`0x03DD`) carries cEMI source `15.15.255`, confirming the reset took effect.

Two real findings worth carrying into a future implementation:

- **Real ETS Factory Reset is three distinct things** (per-channel parameter reset, explicit
  programming-mode exit, address reset to `15.15.255`), not just an address change — a koolenex
  "factory reset" feature that only reset the address would leave real device-side application
  state behind.
- **A device can retain its individual address indefinitely if never explicitly addressed back to
  `15.15.255`** — confirmed directly: this same device answered a later, unrelated discovery
  broadcast still claiming a stale address (`1.1.11`) left over from an *earlier, unrelated*
  koolenex test days before, with no koolenex-side record of it (`has_address: 0` in the
  project DB) - the device's own real state and koolenex's DB view of it had silently diverged.
  koolenex has no equivalent "reset the address back to default" capability yet - `writeIndividualAddressBySerial()`/`programIA()` can only assign a new specific address, not restore
  the KNX factory default.

Capture files: `docs/data/captures/2026-08-31_ets_address_write_hdl_reference.pcapng` (the
preceding, address-check-only session showing no write occurred — the address already matched)
and `docs/data/captures/2026-08-31_ets_factory_reset_hdl.pcapng` (the full reset sequence above).

### 9.4 Real ETS "Download Individual Address" write, confirmed byte-for-byte 🟢

A second, genuine capture (the §9.3 device's factory-reset state made this possible - the earlier
§9.1/9.2 findings were sourced from a device that already matched its target, so no write ever
actually occurred there) - `docs/data/captures/2026-08-31_ets_address_write_hdl_real.pcapng`.
Sequence:

1. ETS probes its **target** address directly first (`Connect` + `DeviceDescriptor_Read`) — no
   answer, confirming the address is genuinely free before attempting to claim it.
2. Broadcast `A_IndividualAddress_Read` polling (button press required) until the device answers
   from `15.15.255` (the factory-default address from the §9.3 reset).
3. **`A_IndividualAddress_Write`** (`PhysicalAddress_Write`, APCI `0x0003`) broadcast to `0/0/0` -
   the actual write. Payload is the raw 2-byte encoded address only (no serial, no reserved
   bytes) - the button-press service, distinct from the serial-based
   `IndividualAddressSerialNumber_Write` (§9.1).
4. Broadcast `A_IndividualAddress_Read` verification poll - device answers from its **new**
   address, confirming the write took effect immediately.
5. Connect P2P to the new address, `DeviceDescriptor_Read`, and reads of properties 56/11 (same
   identity-confirmation pattern as every other session in this document).
6. **`A_Restart`** — sent, then a **real ~3.0s wait** (80.60s → 83.60s in the capture, exact),
   *then* `T_Disconnect`. Confirms `restartDevice()`'s own `postRestartDelayMs` (added
   2026-08-31, default 3000ms) against a real capture, not a guess - see that method's own doc
   comment.
7. A separate KNXnet/IP Tunnel-level `DisconnectReq`/`Resp` a couple seconds later - the whole IP
   session closing, not device-specific.

**No `PID_PROGMODE=0` write appears anywhere in this capture** - unlike §9.3's Factory Reset, a
plain address write relies on the Restart alone to end programming mode. Confirms that finding
was specific to Factory Reset, not a general property of every address-related ETS operation.

This capture directly validates koolenex's own `assignIndividualAddressBySerial()`/`programIA()`
restart-after-write sequence (write → verify → Restart → wait → disconnect), added the same day
this capture was taken, in the same order real ETS uses.

### 9.5 koolenex's own detect-before-write UI flow, live-tested end-to-end on a second manufacturer 🟢

Real, live-hardware testing against the §9.3/9.4 device (HDL `M/AG40B.1`, mask `07b0`) via
koolenex's own UI (`AddressDeviceModal.tsx`'s "Write Address" button), not a direct protocol
capture of ETS. Three real bugs found and fixed, plus one real, resolved behavioral question:

- **`readSerialNumbersInProgrammingMode()` alone got zero replies from this device, even with the
  physical button genuinely held** - cross-checked directly against §9.4's own real ETS capture
  against the same physical unit, which shows ETS itself using `checkProgrammingMode()`'s
  mechanism (`A_IndividualAddress_Read`) instead, not the `A_SystemNetworkParameter_Read`-based
  one. **This is a real per-manufacturer/mask gap, not a bug in either service** - both remain
  independently real-hardware confirmed (§9.2 for `readSerialNumbersInProgrammingMode()` on the
  Albrecht Jung devices tested there; this section for `checkProgrammingMode()` on HDL). Fixed at
  the call site (`AddressDeviceModal.tsx`'s `writeAddressDirect()`), not in either service itself:
  both are now run concurrently and their results merged by responding address, covering either
  manufacturer without slowing down the one that answers the faster/richer service.
- **A one-shot broadcast only catches a device already in programming mode at the exact instant
  it's sent** - a telegram can't retroactively be seen by a device that enters programming mode
  moments later. Real ETS itself (§9.3/9.4 captures) re-sends its own equivalent broadcast roughly
  every 3s for its *entire* wait window, not once. Both `checkProgrammingMode()` and
  `readSerialNumbersInProgrammingMode()` (`server/knx-connection.ts`) previously sent their
  broadcast exactly once at call time; both now re-send every 3s for the full `timeoutMs`,
  matching ETS's own cadence, via a `setInterval` alongside the existing timeout/listener.
- **Combining the two services with `Promise.all` on two full-length (30s) calls made every write
  take the full 30 seconds even when the device answered within a few seconds** -
  `readSerialNumbersInProgrammingMode()` deliberately never resolves early (by design, so it can
  collect replies from more than one simultaneous device - see §9.1); `Promise.all` doesn't resolve
  until *both* promises settle, so it stayed blocked on that one regardless of how fast
  `checkProgrammingMode()`'s own early-resolve-on-match fired. Fixed client-side:
  `writeAddressDirect()` now polls in short (3s) rounds instead of one long call, breaking out of
  the loop the instant either service reports a device - same overall ~30s budget for someone to
  physically reach the device, but a real response within a few seconds of an actual press,
  matching ETS.
- **No visible physical reboot (screen/IP display) on the HDL device is real device-specific
  behavior, not a koolenex bug.** Isolated via a diagnostic-only endpoint (`POST
  /bus/restart-device`, `server/routes/bus.ts` + `KnxBusManager.restartDevice()`,
  `server/knx-bus.ts`) that sends nothing but a real `A_Restart` to an already-addressed device,
  with no write/detect/read-back around it. Two back-to-back real tests, same code path: against
  the HDL device (`1.1.21`, this section's `M/AG40B.1`), sent twice, confirmed no visible
  screen/IP change either time; against `1.1.10` (the Albrecht Jung LED actuator from §1-§8, a
  different manufacturer/product) with its status light left on beforehand, the same `A_Restart`
  call turned the light off, confirmed by direct observation. Identical trigger, identical code,
  two real devices, opposite outcomes - `A_Restart` is being sent and accepted correctly in both
  cases; this specific HDL device/firmware genuinely does not perform a visible reboot in response
  to it, while the Albrecht Jung device does.

Net result: the full detect → validate-exactly-one-device → write → restart → read-back-confirm →
serial-capture flow is now confirmed working end-to-end, live, on a **second** manufacturer (HDL,
in addition to Albrecht Jung) - the "only one manufacturer tested" gap noted elsewhere in this
document is resolved for the addressing path specifically (mask/System-B-family coverage is
unchanged - both real testbed devices remain System B).

## Sources

Real capture files backing every 🟢-tagged claim above live in this project's `docs/data/
captures/` directory, organized by date and topic — session bootstrap and the overall Full/
Partial Download walkthrough (§1–§5), memory-service/mask-version gating (§4.1), group-address
and association table formats (§6.2–§6.3), the per-communication-object flags table's full
bit-mapping (§6.4), the content-status/checksum mechanism and its safety-net rewrite trigger
(§7), and the tshark address-mis-display gotcha (§8). §9's 🟢 claims are sourced from live tests
against real hardware via this app's own routes, plus a real tshark capture of ETS's own
commissioning traffic (factory reset + full download) that settled the exact wire format. §9.3's
factory-reset procedure and §9.4's real address-write sequence are each sourced from a separate,
dedicated capture against an HDL device (2026-08-31) - see those subsections' own capture-file
references. The
dated files under `docs/follow-ups/*.md` consolidate the full investigation narrative,
including dead ends and exact chronology, for anyone who wants the "how this was found" story
rather than just the current facts above.
