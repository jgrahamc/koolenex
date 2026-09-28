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
Gira, Weinzierl) — see those sections for the breakdown. §4.1a–§4.1c (chunk sizing, cached APDU length,
the legacy write-encoding fix) are confirmed on HDL in addition to the two Jung devices. §9 (device
addressing) is confirmed on HDL in addition to Jung. §3.4 (Module architecture addressing) is
confirmed against a separate Albrecht Jung module-architecture-based multi-gang pushbutton, mask
`0x07B0` — real byte-for-byte parameter memory content, not merely protocol-level success.

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
| Property *descriptor* (not value) — object 2, property 23 | A `PropDescrRead`, not an ordinary value read — same single read every session, Full or Partial. Real decoded response shape: property index, PDT (type) code, element count, read/write access levels — a real, meaningful descriptor, not a placeholder. |
| A property read on Object Type 17, instance 1, property 51 (`FuncPropExtRead OT=17 OI=1 P=51`) | Addressed by (Object Type, Object Instance) rather than a local object index, same mechanism as §6.2's router-config reads. Object Type 17 has not been identified against a KNX interface-object-type reference. Observed response: `$000000`. |
| Application version marker (object 4) | Read here, written back verbatim later — see §4.3 |
| A handful of other status fields | 🔴 Several of these values' exact meaning was never looked up against a KNX property reference — not required to understand the write path |

None of these early reads are content-dependent — none of them could reveal whether a device's
memory content had been tampered with out-of-band (relevant to §7.3).

### 2.2 Authorize

An authorize request/response exchange, using an access-level key. Sent once, early, with the
well-known default key (`0xFFFFFFFF` — used when a device has no special access restriction
configured); the response carries a 1-byte access level (`0` = full access, observed in every
capture). 🟢 Present in every real capture. 🔴 Whether a device configured with a non-default
access key would behave differently is untested (this testbed's devices are presumed
factory-default) — deliberately left untested rather than setting a non-default key on real
hardware, since that's a security-adjacent device change; open for a future pass, not attempted
here.

### 2.3 KNXnet/IP Tunnelling v2 feature negotiation 🟢

A real, distinct KNXnet/IP service family — separate from the ordinary `TunnelReq`/`TunnelAck`
traffic this document otherwise describes — is sent immediately after every real Tunnel connect,
with no exceptions found across every real session checked so far:

```
Tunnel ConnectReq / ConnectResp
TunnelFeatureGet  BusStatus
TunnelFeatureResp BusStatus $01
TunnelFeatureSet  InfoServiceEnable $01
TunnelFeatureResp InfoServiceEnable $01
```

Real ETS reads a `BusStatus` feature, then explicitly **writes** `InfoServiceEnable` to `$01`
(enabled). Found via a genuinely comprehensive, unfiltered full-session comparison (every TCP and
KNXnet/IP frame, not a display-filtered subset). Implemented: this engine now sends both on every
real Tunnel connect and decodes `TunnelFeatureResponse`/`TunnelingFeatureInfo` replies.

🟢 **Confirmed, not speculative** (Qt KNX's own documentation, cross-checked against a real
third-party KNX integration product surfacing this exact feature in a production error message):
`InfoServiceEnable` is a subscribe toggle — once set, the KNXnet/IP server proactively sends an
unprompted `TunnelingFeatureInfo` frame (service `0x0425`, defined in the spec, not observed in
any capture analyzed so far since nothing changed mid-session) whenever a negotiated feature's
value changes, with no polling needed. `BusStatus` itself maps to a real bus connection-health
indicator (`QKnx::InterfaceFeature::BusConnectionStatus`) — a genuine connected/broken signal, not
a decorative one.

Real byte-level decode, this repo's own capture: `FeatureId 0x03` = `BusStatus` (observed value
`0x01`, healthy/connected, at session start); `FeatureId 0x08` = `InfoServiceEnable` (real ETS sets
it to `0x01`). Structure: `[StructLength(1)] [ChannelId(1)] [SeqCounter(2)] [FeatureId(1)]
[Reserved(1)] [Value...]` — SeqCounter is a two-byte field (confirmed byte-for-byte against a real
capture: a one-byte SeqCounter shifts every following field and is rejected by the gateway with a
TunnelFeatureResp error).

🔴 **Not yet confirmed**: whether this mechanism ever surfaces a real fault relevant to a write
session — no capture analyzed so far shows a non-`0x01` `BusStatus` value or an unprompted
`TunnelingFeatureInfo` push, since none was captured at the moment a real device actually failed.
Watching for one during and after a real write is the natural next real-hardware test.

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
(observed order: 4, then 3, then 1, then 2). This order is not computed per-session or derived
from the application program — it comes from a literal, per-mask template; see §3.2.

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
sequence, even though the exact same write would succeed once batched correctly.
`downloadDevice()` (`server/knx-connection.ts`) avoids this by collecting every object's write into
one job list and running each phase (Unload-all, StartLoading+LoadData-all, resolve-all, write,
LoadCompleted-all) across the whole batch, instead of a per-object sequential loop. Confirmed end
to end: a real Full Download against a genuinely blank, factory-reset device wrote all four
objects cleanly in one run, and a subsequent Verify matched the parameter memory byte-for-byte (0
of 8178 bytes differing).

### 3.2 Object processing order comes from a per-mask template, not the application program 🟢

Every `.knxproj` project file bundles a shared catalog, `knx_master.xml`, alongside the
manufacturer-specific application XML. This catalog defines each real KNX **mask version** (the
underlying chip/BCU generation a device is built on, reported by `DeviceDescriptor_Response`, §2.1)
once, shared across every manufacturer's application built for that chip — distinct from the
application program itself, which only supplies its own parameter/communication-object content and
a handful of small fragments (tagged with a `MergeId`) that get spliced into the mask's own
template at marked points.

For a given mask (e.g. `MV-07B0`, "System B"), the relevant structure is:

```
<MaskVersion Id="MV-07B0" ...>
  <HawkConfigurationData>
    <Procedures>
      <Procedure ProcedureType="Load" ProcedureSubType="all" ...>
        <LdCtrlConnect />
        <LdCtrlMerge MergeId="1" />
        <LdCtrlUnload LsmIdx="5" />
        <LdCtrlUnload LsmIdx="4" />
        ...
        <LdCtrlRestart />
      </Procedure>
      <!-- further <Procedure> variants, see §3.2.1 -->
    </Procedures>
  </HawkConfigurationData>
</MaskVersion>
```

Each `<Procedure>` is a **literal, ordered template** of `LdCtrl*` steps — the exact same step
vocabulary used throughout this document (`LdCtrlUnload`/`LdCtrlLoad`/`LdCtrlWriteRelMem`/
`LdCtrlLoadCompleted`/`LdCtrlRestart`, each naming the interface-object index it targets via
`LsmIdx`/`ObjIdx`) — written out in file order. The object-processing order documented at the top
of §3 is simply this template's own literal step order for the mask in question; it is not
computed at runtime and does not vary by application, only by mask and by which `Procedure`
variant is in effect (§3.2.1).

#### 3.2.1 `ProcedureSubType` selects which template applies 🟢 (template content) / 🟡 (selection rule)

A single mask declares **multiple** `Procedure` variants, distinguished by `ProcedureSubType`.
Confirmed on `MV-07B0`:

| `ProcedureSubType` | Objects touched | Content-aware (compares before writing)? |
|---|---|---|
| `all` | 5, 4, 3, 2, 1 | No — unconditional rewrite of everything |
| `par` (parameters only) | 5, 4 | Yes — `LdCtrlLoadImageProp`+`LdCtrlCompareProp` on both before loading |
| `grp` (group data only) | 3, 2, 1 | No |
| `par,grp` (both) | 5, 4, 3, 2, 1 | Yes, on objects 5/4; unconditional on 3/2/1 |
| `cfg` (property-based config) | none | `LdCtrlConnect` → `LdCtrlDisconnect` only — property-based writes (§4) never use this state machine at all |

🟡 Which `ProcedureSubType` a real session actually uses for a given real download has not been
independently confirmed by matching a specific capture against a specific template line-by-line —
the table above documents the templates themselves (directly read from the catalog file, high
confidence), not yet a proven mapping from "kind of download requested" to "which template runs".
Treat the SubType names as strongly suggestive of their evident purpose, not as an independently
verified selection rule.

🟢 The `all` template's `<Procedure ProcedureType="Load" ProcedureSubType="all">` block includes a
`<LdCtrlLoadCompleted LsmIdx="5" />` step, immediately before the corresponding step for object 4
— confirmed directly against `data/knx_master_1.xml` and, independently, the live Test Bed
project's own `data/knx_master_21.xml`. Object 5 is loaded, written to (`WriteProp` PropId="13"),
and explicitly marked committed by this template, exactly like every other object it declares —
see §3.3.1 below for the separate, still-open question of whether real ETS actually sends these
steps on the wire.

#### 3.2.2 Real code: `knx-mask-procedures.ts` computes this order rather than hand-declaring it 🟢

Both download executors (the RelSegment/System-B inline path and the AbsSegment/`planDownload()`
path) previously derived Unload/Load/content-write ordering from hand-written, per-observation
rules — each individually correct against the capture it was built from, but not derived from a
single source, and not universal: this project's own real capture corpus shows a genuinely
different, ASCENDING order for mask `0x0705` (Gira), the opposite of `0x07B0`'s own descending
convention — see a real ETS capture of a Gira smoke-alarm device (mask `0x0705`).
This project's own real master data has no `Load` Procedure declared for that mask at all (only
`Unload:all`) — confirming ordering genuinely is per-mask, not a hardcodable universal rule, and
that a mask lacking a `Load` template is a real, expected case, not a parse failure.

`server/knx-mask-procedures.ts` reads a mask's real `<Procedures>` template (§3.2 above) from
this project's own saved `knx_master_<projectId>.xml` and splices an application program's own
declared `<LoadProcedure MergeId="N">` steps in at the template's `LdCtrlMerge` points
(`getMaskProcedure()`/`spliceAppSteps()`), giving a single, real-data-driven ordering source both
executors draw from (`orderByMergedOps()`) in place of their own independent hand-picked sorts.
Both executors keep their pre-existing hand-written ordering as a fallback — used whenever no
project id is available, a device's mask is unknown, or (the Gira case above) the mask genuinely
has no matching Procedure declared — so a device this module cannot resolve behaves exactly as
before. `getMaskProcedure()`/`spliceAppSteps()` are unit-tested directly against this project's
own real `knx_master_1.xml` for both mask `0x07B0` (confirms the descending Unload order 5,4,3,2,1
straight from the real template) and mask `0x0705` (confirms no `Load` Procedure exists at all, for
any subtype) — see `tests/knx-mask-procedures.test.ts`.

### 3.3 Interface object 5 — the PEI Program 🟢 (existence/structure) / 🔴 (deeper semantics)

Some masks declare a distinct interface object at index 5 for the **PEI Program** — "Physical
External Interface" — the small piece of firmware managing an optional external
interface/programming connector on the device baseboard, logically separate from the device's own
application program (object 4). Whether a mask has this distinct object is a real, catalog-level
fact, confirmed directly from `knx_master.xml`'s own `<Features>` block for each mask:

- **`MV-07B0` ("System B")**: `<Feature Name="FirstAppObjectIdx" Value="6" />` — PEI Program is its
  own object at index 5, separate from the application program at index 4. Confirmed by the
  `Resources` block declaring a distinct set of `Peiprog*`-named resources (`PeiprogId`,
  `PeiprogLoadControl`, `PeiprogRunControl`, `PeiprogDataPtr`, `PeiprogStamp`) mapped to that index.
- **`MV-0705`**: `<Feature Name="FirstAppObjectIdx" Value="5" />` — the PEI Program and application
  program share the same object, at index 4. No object 5 exists on this mask at all.

This is corroborated by real capture behavior: devices on `MV-07B0` show an `Unload` targeting
object 5 as the very first step of a session; a device confirmed on `MV-0705` (a smoke-alarm
device, part 234300) shows no object-5 activity of any kind, consistent with the catalog data
above.

The object's own real standard identity (its interface object *type* number, as opposed to its
table *index*) has not been independently confirmed from a primary source; it does respond
correctly to ordinary load-state property reads/writes exactly like any other real interface
object (not a decoy or a signal-only response), but nothing in the captures gathered so far reads
back its actual type.

**External corroboration** — checked against the KNX Association's own support content and
independent third-party KNX/EIB technical sources, specifically to test whether "PEI = Physical
External Interface, a mask-standard legacy object shared by every device on a mask regardless of
the loaded application" could be a misreading of the catalog data above. It isn't — every external
source found corroborates, none contradicts:

- **KNX Association's own definition**: *"The PEI program controls the PEI (Physical External
  Interface) between the BCU and the application module and is a separate program laying down the
  actual functionality of the device."* — [support.knx.org, "Definition of PEI
  program"](https://support.knx.org/hc/en-us/articles/4708906616338-Definition-of-PEI-program)
- **The BCU/PEI hardware architecture**, independently: *"A BCU is a KNX bus coupling unit. It has
  a KNX bus connector on one side and a 10 pole connector on the other side called PEI
  interface... With the new version of BCU called BCU2, a new protocol (FT1.2) has been defined on
  the PEI interface."* — [linknx wiki, "Accessing the KNX
  Bus"](https://github.com/linknx/linknx-wiki/blob/main/Accessing-the-KNX-Bus.md)
- **A direct match to the catalog-data finding above** — a KNX/EIB software-development source
  states there are five general interface objects present on a device independent of any specific
  application: device, address table, association table, application program, and PEI program —
  the exact same fixed, mask-standard set this document's own `knx_master.xml` reading shows
  (objects 0-5 mask-standard, `FirstAppObjectIdx="6"`).

No external source found describes the PEI program as anything other than a standard, general
interface object present on every BCU-family device regardless of the loaded application —
consistent with, not contradicting, this section's own mask-XML-sourced conclusion.

This does **not** resolve *why* the KNX Association's own mask designers chose to make Object 5's
Unload unconditional in the mask's own procedure template in the first place — the catalog data
shows THAT it's fixed, not the original design rationale — nor whether a real device on this mask
family has an actual physically populated PEI connector, as opposed to purely vestigial firmware
structure carried for backward compatibility.

#### 3.3.1 Open question: the `all` template's `Load`+`WriteProp` steps for object 5 🔴

The mask catalog's `all` template (§3.2.1) declares more for object 5 than has ever been observed
on the wire. In full, as written:

```xml
<LdCtrlLoad LsmIdx="5" />
<!-- ...intervening steps for other objects... -->
<LdCtrlWriteProp ObjIdx="5" PropId="13" Verify="true" InlineData="0000000000" />
<!-- ...intervening steps for other objects... -->
<LdCtrlLoadCompleted LsmIdx="5" />
```

🟢 Confirmed directly against `data/knx_master_1.xml` and, independently, the live Test Bed
project's own `data/knx_master_21.xml`: the `LdCtrlLoadCompleted LsmIdx="5"` step is real,
positioned right before the `LoadCompleted` for object 4. As written, the template does mark
object 5 loaded, matching the same shape as every other object it declares.

Property 13 is `PID_PROGRAM_VERSION` — the same property already documented in §4.3 for object 4,
where real ETS reads the current value early in a session and writes that *identical* value back
before marking the object loaded (a version/identity re-stamp, not new functional content). If the
object-5 step is the same mechanism, it would be a version stamp on the PEI Program object, not
real configuration data — but this has never been confirmed, because:

- Every real capture examined so far — including genuine real-ETS sessions, not just this engine's
  own — shows object 5 receiving **only** the initial `Unload`. No capture has ever shown a
  subsequent `Load`, `WriteProp`, or `LoadCompleted` targeting object 5, even though the template
  itself declares all three.
- An earlier controlled test (real hardware, a legacy-mask device unrelated to this mask family)
  found that removing *just* the `Unload OX=5` step from an otherwise-verbatim real ETS replay made
  no difference to whether the rest of the session's writes succeeded and confirmed correctly —
  evidence against the `Unload` being load-bearing for that narrow question, but that test never
  covered the `Load`/`WriteProp` steps at all, since ETS itself never sent them in the session being
  replayed.

**Net position**: it is not known whether real ETS ever actually executes the `Load`+`WriteProp`
portion of this template in practice (as opposed to it being dead/conditional template content
that never fires, e.g. suppressed by the same content-status/checksum mechanism documented in §7),
or whether it simply has never been captured occurring. This engine deliberately does **not**
implement these steps — only the `Unload`, which is the one part directly evidenced across every
real capture available. Sending unproven additional writes to a real device is a bigger risk than
omitting them without stronger evidence either way. **Further investigation is needed** — most
directly, a real ETS capture of a session against a device where object 5's own content is known
to differ from what's expected, to see whether ETS ever actually writes to it, and if so, under
what condition.

#### 3.3.2 Open question: is the Unload itself always unconditional? 🔴

This engine currently sends `Unload(5)` unconditionally, once per Full Download, whenever the mask
family is known to have the object (§3.3's `hasPeiProgramObject` gate). Every real capture examined
supports this as a safe baseline — no capture has ever shown ETS skipping the Unload once a session
against a System-B-family device begins.

A real, open question this document does not attempt to answer: does real ETS ever skip the Unload
conditionally, based on some content- or history-aware check (analogous to the content-status/
checksum-gated skip §7 documents for objects 1-3), rather than sending it unconditionally on every
session? A property-level check exists in principle — the object's own `PID_LOAD_STATE_CONTROL`
(property 5) could in theory be read before deciding whether to Unload, the same shape as §7's own
checksum-gated skip for other objects — but no real capture available to this project has ever
shown ETS performing such a read against object 5 specifically, and no controlled real-hardware
test has been run to distinguish "ETS genuinely always Unloads it" from "ETS conditionally Unloads
it and every capture gathered so far happened to hit the same branch".

**Deliberately not implemented**: any conditional/history-aware variant of the Unload decision.
Given the real, demonstrated risk profile here — an incorrect Object-5 Unload decision was the
prime suspect in a real device becoming permanently unresponsive early in this class of
investigation, before the unconditional-Unload baseline was adopted — a change to this behavior
needs its own dedicated real-hardware investigation (multiple independent sessions, serial-number-
verified device identity, a deliberate before/after comparison against genuine ETS captures) before
being implemented here, not a design lifted from a differently-scoped read of the mask template.
Treat the current unconditional behavior as the considered, conservative default until such an
investigation happens.

### 3.4 Module architecture: parameter and communication-object addressing 🟢

Some application programs are built from reusable, parameterized building blocks rather than one
flat, monolithic parameter/communication-object list. The project data declares each reusable
block once as a `<ModuleDef>` (under `<Static><ModuleDefs>`, a sibling of the application's own
top-level `<Static>`), and then *instantiates* it — potentially more than once, for genuinely
independent real channels/positions — via `<Module Id="..." RefId="...MD-n">` elements in the
application's `<Dynamic>` tree. A real instantiation carries the specific numeric arguments that
distinguish it from any other instance of the same `ModuleDef`:

```xml
<Module Id="{app}_MD-13_M-44" RefId="{app}_MD-13" Name="Rocker 1 — Switching">
  <NumericArg RefId="{app}_MD-13_A-1" Value="340" />
  <NumericArg RefId="{app}_MD-13_A-2" Value="65" />
</Module>
```

`<Module>` elements are not necessarily direct children of `<Dynamic>` — they are commonly nested
inside `<Channel>`, `<ChannelIndependentBlock>`, or `<choose>`/`<when>` blocks, at any depth. A
`ModuleDef`'s own `<Dynamic>` section (nested inside the `<ModuleDef>` itself, a sibling of its own
`<Static>`) can independently declare further conditional structure — including its own
`<choose>` blocks — governing which of that module's own parameters/communication-objects are
active, evaluated using that specific instance's own parameter values.

**Addressing.** A `ModuleDef`'s own `<Parameter>` and `<ComObject>` declarations use small,
block-relative placement values — real, but only meaningful relative to one instance's own base.
The real, absolute placement for a given instance is that block-relative value plus the resolved
value of a numeric argument, referenced by name:

- A memory-mapped `<Parameter>`'s `<Memory>` child carries `Offset`/`BitOffset` (block-relative)
  **and** `BaseOffset` — the Id of an `<Argument>` (declared on the enclosing `<ModuleDef>`) whose
  real value for a given instance comes from that instance's own `<NumericArg>`. The parameter's
  real absolute byte offset is `Offset + <resolved BaseOffset argument value>`.
- A `<ComObject>` carries `Number` (block-relative) and `BaseNumber` — the same mechanism, for the
  communication object's real absolute number.
- A `<Union>`'s own member `<Parameter>` elements conventionally declare a direct `Offset="0"`
  attribute rather than their own `<Memory>` child; in that case `BaseOffset` (and the union's own
  block-relative `Offset`) are declared on the **enclosing `<Union>`'s** `<Memory>` element instead,
  and apply to every member.

This means the same `ModuleDef` instantiated twice (e.g. two independently-wired physical channels
using the same reusable function) resolves to two genuinely different, non-overlapping address
ranges — provided each instantiation's own `BaseOffset`/`BaseNumber` argument is resolved
correctly. Resolving only the block-relative `Offset`/`Number` value, without the argument
addition, collapses every instance of a given `ModuleDef` onto the same address — including
distinct, unrelated `ModuleDef`s that happen to declare the same small block-relative value.

**Real per-instance identity.** A device's own project data (device-instance-level, not the
application program itself) references a specific instantiated communication object or parameter
using its real, fully-qualified id: `{ModuleDef}_{Module instance}_MI-{n}_{object/parameter}`,
e.g. `MD-13_M-44_MI-1_UP-59_R-68`. The `MI-` (module instance) component distinguishes genuinely
repeated real-world content within a single `<Module>` instantiation; in observed real project
data it is consistently `1`.

**Determining which instances are genuinely active on a given device.** A `<Module>`
instantiation's own activation, and any further conditional selection nested inside that
`ModuleDef`'s own `<Dynamic>` section (e.g. a per-instance choice among several possible
sub-behaviors for one channel), is decided the same way as any other conditional content in this
project format: by evaluating the enclosing `<choose>` against the real, current value of its
selector parameter — falling back to that parameter's own declared default when the project data
carries no explicit override for it. Because each real instantiation can carry its own,
independent selector value, this evaluation must be performed per instance, not once for the whole
device — two real instances of the same `ModuleDef` can legitimately resolve to different active
alternatives. A communication object's mere presence in the device's own object-reference list is
not by itself sufficient to determine which parameter-level alternative is active for that
instance, since a module can be genuinely active with every one of its own parameters left at
their declared defaults.

**`ParameterRef` vs `Parameter` default value.** A `<Parameter>` declares its own factory
`Value=`; separately, a `<ParameterRef Id="..." RefId="...">` — the element the application's
`<Dynamic>` tree actually references — can independently declare its own `Value=`, which need not
match the `Parameter` it points to. (Multiple distinct `ParameterRef`s commonly point at the same
underlying `Parameter`, each with its own `Value=`, gated by different `<choose>` branches or
reachable unconditionally — this is the mechanism behind several internal, non-user-facing
"application instance" bookkeeping parameters.) When no explicit per-device override exists for a
given `ParameterRef`, the value actually written to the device is:

- the `ParameterRef`'s own `Value=`, whenever that specific ref is genuinely reachable through the
  application's `<Dynamic>` tree — whether unconditionally, or through a matched `<choose>` branch;
- otherwise (an `Offset`-based, non-`<Memory>`-child parameter never reached by the `<Dynamic>` tree
  walk at all) the underlying `Parameter`'s own factory `Value=`.

**`BaseValue` — a Parameter's value resolved from a module argument.** A `<Parameter>` inside a
`<ModuleDef>` can carry a `BaseValue="..."` attribute referencing one of that `ModuleDef`'s own
`<Argument>`s, instead of (or as well as) its own literal `Value=`. When present, that Parameter's
real value for a given real instantiation comes from the instantiation's own `<NumericArg>` for
that Argument — never from a `ParameterInstanceRef` override. This is the same per-instance
resolution mechanism `BaseOffset` uses for addressing (§3.4), applied to a parameter's value rather
than its memory offset — commonly used to drive a `<choose>` selecting between two otherwise-
identical alternatives (e.g. two different valid ranges for the same logical setting) without
requiring an explicit per-device override for every instance.

**Float parameter encoding.** A `<ParameterType>`'s `<TypeFloat>` element declares its own
`Encoding=` attribute, and this determines the real wire size — it is not always the 2-byte KNX
DPT 9 format. `Encoding="DPT 9"` is the standard 2-byte floating-point format; `Encoding="IEEE-754
Single"` is a full 4-byte IEEE-754 single-precision float, written and read as a plain 32-bit
float with no DPT 9 mantissa/exponent packing at all. A `SizeInBit=` attribute, when present,
always takes precedence over the size implied by the encoding.

**A Union member's own reachability, when it is itself a `<choose>` selector.** A `<Union>`
member `<Parameter>` can independently serve as the selector for its own `<choose>`, declared as a
separate, syntactically unconnected part of the application's `<Dynamic>` tree — nothing in the
static structure ties a losing Union member's own choose to the fact that it lost the Union
selection. Evaluating "is this Ref reachable" therefore requires knowing which Union member has
genuinely won its own selection first: a losing member's own choose must be excluded entirely
(neither its matched branch nor its default branch contributes to reachability for anything),
since real ETS never evaluates it. Determining Union winners and correcting reachability for this
case are sequential, not simultaneous — winner determination needs the uncorrected reachability
first.

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

**Mask-version gating — 🔴 DISPROVEN as a sole/reliable rule, see the
`IsSecureEnabled` hypothesis below for the current candidate replacement**:

- 🟢 Both real Jung devices tested (1.1.9, 1.1.10) report mask `0x07B0` ("System B") and both
  used the extended write service exclusively — confirmed across multiple independent live
  captures, same result each time.
- 🟢 A verbatim byte-for-byte replay of a real captured ETS write against real hardware
  persisted correctly. An identical write attempted using the legacy service instead (chosen
  because the target address happened to fit in 16 bits) failed to persist — reproducibly, with
  no error returned at any protocol layer. (This was originally believed to be an address-size
  wraparound bug — koolenex genuinely was using the 16-bit legacy service unconditionally at the
  time — but the controlled replay specifically isolated a SEPARATE effect: even a legacy write
  built for an address that itself fits within 16 bits still failed to persist, meaning the fix
  needed is not just "switch to extended once the address exceeds 0xFFFF".)
- 🔴 **The generalization "mask `0x07B0` ⇒ requires the extended service" is now known FALSE**: a
  third mask-`0x07B0` device (HDL `M/AG40B.1`, this project's own testbed) used
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

**Candidate rule #1 (`IsSecureEnabled`) — 🔴 SPECULATIVE, NOT YET CONFIRMED**: comparing the real
`<ApplicationProgram>` XML of all four apps in this project's own testbed `.knxproj`, the one
clean, binary signal consistent with every known real data point is the app's own
`IsSecureEnabled` attribute — `true` on all three Jung apps (including both confirmed-extended
devices, 1.1.9/1.1.10), completely **absent** (not `false` — never written at all) from the HDL
app (confirmed-legacy). Implemented in `server/ets-app.ts`
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
would matter.

**The sample has been considerably broadened, including a same-manufacturer control test — still
an inference, not a confirmed rule.** Real captures cover all eight devices in the Test
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

**This candidate rule is DIRECTLY FALSIFIED, not merely "confirmed for apps that declare it".**
The counter-example the "open" paragraph above flagged as never having been seen has been found:
the Weinzierl `KNX IO 534 CV (4D)` app
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

**`PID_MCB_TABLE` byte 5 is restored as a write-service signal, tightened to `==0x33`, with a
further signal (`SupportsExtendedMemoryServices`) checked ahead of it.**

`IsSecureEnabled` (candidate rule #1) has its own counter-example: an application program
(Zennio KLIC-DI v2) declares `IsSecureEnabled=false` but requires the extended service — confirmed
against real captures: a Full Download to this device uses `MemExtWrite` throughout, reproduced
across repeated downloads to a factory-reset, re-addressed instance of the same device.

Re-examining this device's `PID_MCB_TABLE` byte 5 found `0x33` — matching every other confirmed
"extended" device checked (two Albrecht Jung application programs, both declaring literal byte 5
= `0x33`), while the Weinzierl falsifying case above is `0x32` — close to, but not equal to,
`0x33`. Tightening the rule from "byte 5 != 0xFF" to "byte 5 == 0x33 exactly" resolves every real
case checked so far, including both devices that broke the two previous single-signal rules:

| device                      | mask (System version) | byte 5 | `==0x33`? | actual service |
|---|---|---|---|---|
| Albrecht Jung (×2)          | `07B0` (System B) | `0x33` | yes | Extended |
| HDL (live-read value)       | `07B0` (System B) | `0xFF` | no  | Legacy |
| Weinzierl                   | `07B0` (System B) | `0x32` | no  | Legacy — the falsifier above |
| Zennio KLIC-DI v2            | `07B0` (System B) | `0x33` | yes | Extended — the `IsSecureEnabled` falsifier |

Still a small number of data points, drawn from three distinct byte-5 values observed
(`0x33`/`0x32`/`0xFF`) — 🔴 not confirmed from any primary KNX source, and untested against a
fourth distinct value. `IsSecureEnabled` is kept as the next-priority signal underneath this,
ahead of the live mask read as a last-resort fallback.

A related gap exists for the Zennio application program: it declares no `LdCtrlWriteProp` for
property 27 at all — only the read-only `LdCtrlLoadImageProp`, the same shape as HDL's application
program. The static-declaration-only form of this rule would silently skip such application
programs entirely and fall through to `IsSecureEnabled`. This is closed by a live
`PropertyValue_Read` fallback, issued deliberately early, before any data write, when no static
declaration exists — the "live read used as a fallback correlate" this document already
anticipates for application programs like HDL's (§4.1's "Apps with no `LdCtrlWriteProp`" bullet
above), now wired into the write-service decision itself, not just the trailing
verification-pass reads already described there.

**New signal, checked before `PID_MCB_TABLE` above: `SupportsExtendedMemoryServices` 🟡
well-supported, not yet fully confirmed.** A literal boolean on the app's own `<Static><Options>`
element (`<Static>...<Options SupportsExtendedMemoryServices="true" .../></Static>`), identified by
a systematic review of element/attribute pairs across a sample of real application-program XML
files (over 280 distinct pairs, 8-9 application programs across 4-5 manufacturers).

Result: present and `"true"` on every confirmed-extended application program in the sample,
completely absent from every confirmed-legacy one — a clean separator with no exceptions in the
sample, resolving both known falsifiers of the two previous signals (Zennio's counter-example to
`IsSecureEnabled`; Weinzierl's counter-example to the `!=0xFF` MCB rule). Unlike either of those,
this is a literal, KNX-Association-documented property, not an inferred correlate: the ETS6 SDK's
own documentation defines `Knx.Ets.Sdk.Product.ApplicationOptions.SupportsExtendedMemoryServices`
as "Gets a value indicating whether extended memory services are supported". Always statically
declared when present, so — unlike `PID_MCB_TABLE` — it requires no live bus read for any device
seen so far.

**Caveat**: still a small sample (8-9 application programs, 3-4 confirmed-extended) and no device
has been found where this signal disagrees with the `PID_MCB_TABLE` rule underneath it — kept as
an additional check ahead of that rule rather than a replacement for it, so an incorrect
resolution here cannot regress a device that already resolves correctly via the fallback chain.
Treat as well-supported (a primary-source definition, a clean fit against the sample checked) but
not fully proven until tested against devices outside this sample — consistent with this whole
section's history, where each prior signal was eventually found to disagree with exactly one new
device.

**Implementation** (`server/ets-app.ts`, `server/ets-parser.ts`, `server/knx-connection.ts`):
`AppIndex.supportsExtendedMemoryServices`/`ParamModel.supportsExtendedMemoryServices` parsed from
`attr(ap.Static?.Options, 'SupportsExtendedMemoryServices')`, threaded through
`DownloadExtra.supportsExtendedMemoryServices` into `downloadDevice()`'s resolution chain — checked
first; if undefined, falls through unchanged to the `PID_MCB_TABLE`/`IsSecureEnabled`/mask chain
above. Test coverage: `tests/knx-connection-write-service.test.ts` (protocol-level fake-device
harness, one case per resolution-chain branch, plus a golden-capture replay against the real
57,076-byte Zennio image — see `tests/fixtures/1140-zennio-real-blank-device-write-README.md`).

### 4.1a Real per-device memory-chunk size ceiling (`PID_MAX_APDULENGTH`) 🟢

**A device's own declared max APDU length — not a fixed protocol-theoretical constant — is the
real, deterministic basis for safe chunk sizing**, confirmed after a real Full Download
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
bisection of real legacy reads against the same device (52 succeeds, 53 fails, every time,
independent of starting address). Implemented in
`KnxConnection._resolveMaxApduLength()`/`maxChunkFromApduLength()` (`server/knx-connection.ts`),
used by both the read path (`readMemory()`/`readMemoryMany()`) and the write path
(`downloadDevice()`'s `MEM_CHUNK`), replacing the fixed 63/255 (reads) and 228 (writes) constants
with this per-device real value, falling back to those same constants only when the property read
fails. Confirmed end-to-end on real hardware: a fresh Full Download to the HDL device,
correctly chunked at ~50 bytes (safely under the real 52-byte ceiling), completed with zero NAKs
and all four interface objects (parameter memory, GA table, Association table, Object 3) genuinely
persisting — independently verified via direct read-back after the download.

🟢 **The extended-service header formula (6 bytes) is independently cross-checked too**, not
just derived from code — the project file itself caches a real device's own `PID_MAX_APDULENGTH`
(see §4.1b below): 1.1.10's cached value is `233`, and `(233+1)−6 = 228` — exactly the real
228-byte extended chunk ceiling already established from a separate capture analysis, a genuine
independent confirmation, not a coincidence of re-deriving the same number.

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

`ets-parser.ts` parses `LastUsedAPDULength` per device (`apdu_length` on the parsed device
record); `devices.apdu_length` is a real persisted column (`server/db.ts` migration,
`server/routes/projects.ts`'s insert), threaded through `buildDeviceProgramming()` →
`DownloadExtra.cachedMaxApduLength`.

**This value is consumed differently by the read path and the write path — a real, deliberate
divergence, not an inconsistency to fix**:

- 🟢 **Read path** (`KnxConnection.readMemory()`/`readMemoryMany()`): the cached value is preferred
  over a live `_resolveMaxApduLength()` read whenever present — a device that's already been
  downloaded to from this project needs zero extra bus round-trips to get its correct chunk size on
  a subsequent read. The live read remains the fallback for a device with no cached value yet (e.g.
  right after import, before any real session).
- 🟢 **Write path** (`downloadDevice()`'s own `MEM_CHUNK` sizing): the live read is always attempted
  FIRST regardless of any cached value present, on the reasoning that a cached value can go stale
  after a firmware or unit change — the cached value is used only as a fallback when the live read
  gets no response at all, and a mismatch between the two is logged rather than silently resolved.
  **Confirmed on real hardware**: a real Partial Download to 1.1.10, which had a cached
  `apdu_length` of `233` at the time, still issued a live `PropValueRead OX=0 P=56` and used its
  result — exactly the designed behavior, not a gap. This means a real download exercising the
  write path's own cached-value FALLBACK specifically requires a device that gives no response at
  all to that read while still accepting the rest of the session — a narrower, harder-to-hit
  condition than "hasn't been tried yet", and 🔴 remains genuinely untested; every real download in
  this project's corpus has had a device that answers property reads normally.

**Gotcha**: at least one common packet-capture tool's own protocol dissector has repeatedly
mis-displayed this write's target address in its one-line summary view (observed showing one
address when the real decoded address, from the raw bytes, was a different one). Never trust a
capture tool's own summary/quick-view for a memory-write address — always manually decode the
raw bytes.

**Real per-chunk flow control is required, not a fixed pace** 🟢: a fast, fire-and-forget burst
(no wait for each chunk's response) outruns a device's processing rate — the device falls behind,
and any read issued while backlogged (e.g. the next object's `PID_TABLE_REFERENCE` resolve, §3.1)
goes unanswered, indistinguishable from an unallocated address. Real ETS waits for each chunk's
write response before sending the next; per-chunk response time varies observably (56ms–279ms),
never a fixed pace. Implemented as a per-chunk `await` on the matching
`Memory_Response`/`MemoryExtended_Write_Response` (generous timeout, tolerant catch-and-continue)
in `downloadDevice()`'s memory-write loop (`server/knx-connection.ts`).

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

### 4.1c Legacy `A_Memory_Write` wire-encoding bug 🟢

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
behavior (`tests/relmem-write-protocol.test.ts`). 🟢 **Confirmed on real hardware**: a
real Full Download to 1.1.20 sent legacy `MemWrite` frames at the correct addresses
(`X=$1766`→`$179A`→`$17CE` for the parameter object, `X=$1002` for the GA table — all matching the
dry run below exactly), captured via tshark — no more `$3417`/`$3017` garbage. A subsequent real
`/bus/verify-device` read-back confirmed the actual device content: parameter memory 152/152 bytes
matching (0 differing), and all four Object 3 (Group Object Table) flag rows reading back correctly
set (`Update=Yes Write=Yes` as expected) — this is the exact "flags reading back as unset" symptom
from the prior (buggy) session, now resolved. 164 of 164 decoded comparison points matched, 0
mismatches.

**Confirmed hardware-free via a dry run**: `downloadDevice()` (real, unmodified code)
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

🔴 **Separately open: WHEN in the session this write happens, as opposed to whether it happens at
all.** `downloadDevice()` currently sends `PropertyValue_Write OX=0 P=14` immediately after
`A_Authorize_Request`, before Unload/StartLoading begins. Two independent real ETS captures of the
same legacy-service device checked directly against this code path both show the write happening
considerably later instead — right after the parameter object's own `PropertyValue_Read OX=4 P=7`
(table-reference resolution), immediately before the very first memory write, well after
Unload/StartLoading has already run. The exact written value also differs between the two captures
(`$04` in one, `$05` in the other) — a second, smaller discrepancy noticed in passing, not
investigated further. Left unfixed: no second legacy-service device exists in this project's
capture corpus to check whether the late-timing pattern generalizes beyond this one app, or is
itself just an artifact of this one device's own particular session.

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
  on the same device. 🟢 for that object. 🟢 **This field is object-4/5-specific, not merely
  under-sampled for the others**: scanning every `RelSegment` step across all 49 real app models
  cached in this project's own `data/apps/` found `lsmIdx` values of only 4 or 5 — never 1, 2, or
  3, in any app, from any manufacturer. Objects 1/2/3's own tables are written entirely through the
  separate mechanism §7.2 describes (outside any app-declared `RelSegment`/`LoadData` step at all),
  which is consistent with a Full-vs-Partial `mode` distinction never applying to them in the first
  place, rather than merely never having been captured doing so.
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
respond again afterward. Full Download total wall time ~6s; Partial Download ~2.7s.

🟢 **The declared RelSegment size is a poor proxy for wall time — the REAL bytes actually
transmitted is what correlates.** A device's own `RelSegment` size (§6.1a) declares the whole
allocated segment, but most of that segment can be unused padding that a Full Download never
sends an explicit chunk for — the two are not the same number. Checked directly across four real
Full Download captures, using each session's own real `MemExtWrite`/`MemWrite` chunks (not the
declared segment size):

| Device | Declared segment size | Real bytes actually written | Real chunk count | Session wall time |
|---|---|---|---|---|
| HDL M/AG40B.1 | 152 bytes | 93 bytes (5 chunks, max 52B) | 5 | 7.21s |
| Weinzierl IO534CV | 6,465 bytes | 83 bytes (4 chunks, max 52B) | 4 | 6.67s |
| Jung 1.1.9 | 8,178 bytes | 124 bytes (5 chunks, max 98B) | 5 | 5.77s |
| Jung 1.1.10 | 10,433 bytes | 3,316 bytes (60 chunks, max 228B) | 60 | 21.39s |

Once the real transmitted bytes/chunk count are used instead of the declared segment size, the
result is far less surprising: three devices with similar real bytes-written (83–124 bytes) and
similar chunk counts (4–5) also have similar wall times (5.77–7.21s), while 1.1.10's dramatically
higher real chunk count (60, versus 4–5 for the others) tracks its dramatically longer wall time
(21.39s). The declared segment size (152 vs. 6,465 vs. 8,178 vs. 10,433 bytes) shows no such
pattern at all — using it as a timing predictor would have been actively misleading here. Real
chunk size also varies by device (52B legacy for HDL/Weinzierl vs. 98–228B extended for the two
Jung devices, per §4.1a) and is a further real confound on top of raw byte count. 🔴 Network
conditions specifically (as opposed to memory size) remain untested — every capture here was taken
on the same local network.

## 6. Per-object write mechanics

### 6.1 Object 4 — application parameter memory

The largest object, holding every user-configured setting. For an application built from
`ModuleDef`s rather than a flat parameter list, see §3.4 for how a parameter's real absolute
offset within this object is computed. 🟢 **A Full Download only writes bytes
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

### 6.1a Multi-byte numeric parameter byte order 🟢

Byte order for a byte-aligned multi-byte parameter is a real, per-app ETS declaration —
`<Static><Options ParameterByteOrder="LittleEndian"/"BigEndian">`, a direct attribute on the app's
own `<Options>` element, not a fixed convention. `writeBits`/`readBits` resolve it from there,
falling back to big-endian when the attribute is absent.

Checked across every `.knxproj` project file available to this project (305 real app
declarations, several manufacturers): every app that declares this attribute is internally
consistent with every other app from the same manufacturer, and no manufacturer contradicts
itself. Albrecht Jung and GIRA apps declare (or, where the attribute is absent, real-hardware
Full Download captures confirm) `BigEndian`. Zennio (KLIC-DI v2) and a product in the same
manufacturer family as the one this default was originally based on both declare `LittleEndian`
explicitly.

🔴 Where the attribute is absent, defaulting to big-endian matches every real-hardware case
checked so far — that is an observation, not a confirmed ETS-defined default. No case has been
found where an app both omits the attribute and turns out little-endian on real hardware, but the
absence of a counter-example isn't proof one doesn't exist.

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

The table builder does not sort entries by group-address index/communication-object number before
writing them — the communication objects are already supplied to the builder in the project's own
declared order, and any such sort would discard this real declared order and actively corrupt link
direction. Confirmed byte-for-byte against a real ETS capture.

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
expose). Confirmed exact against both real testbed devices. For a `ModuleDef`-based communication
object, "number" here means the real, fully-resolved value (block-relative `Number` plus the
resolved `BaseNumber` argument — see §3.4), not the block-relative placeholder alone.

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

A project's XML declares each communication object twice — once at the application level (the
object's default `Read-On-Init`/`Priority`), and once per device instance, which can override
either. The parser reads the instance-level attributes, when present, and prefers them over the
application-level declaration (an earlier version read only the application-level declaration,
silently dropping any device-instance override). Confirmed against a real ETS capture: the
affected byte (Read-On-Init) matches exactly once the override is applied.

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

🟢 **Property 27 usage is common across real app declarations, not a one-off**: of the 49 real app
models cached in this project's own `data/apps/`, 33 declare property 27 in some form (16 declare
none at all, matching the shape of 1.1.9's own app). Of those 33, 18 (spanning multiple unrelated
manufacturer IDs, not just Jung) declare the specific "write this literal fixed value" `WriteProp`
two-step pattern described above; the remaining 15 declare only the read-only `LoadImageProp`
variant, with no write step at all. 🔴 **Live wire confirmation, however, is still from the one
real device this project has physical access to (1.1.10)** — the other 32 apps' behavior is known
only from their own static declarations, never independently confirmed against real hardware.

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

### 7.3.1 What determines whether ETS performs the early check at all — address-scoped, not serial- or record-scoped

§7.3 above establishes that the early property-27 read (§7.1) is the detection mechanism for the
comprehensive-rewrite safety net once it runs — the separate, earlier question is what makes real
ETS decide to run that check in the first place for a given session, as opposed to skipping it and
rewriting the interface objects unconditionally.

🟢 **The check is keyed on the individual address itself** — real ETS's own project/session
tracking of "has this address had a successful download before" — **not** on the device's serial
number, and **not** on the underlying device object's own project-record identity. Testing, using a
sequence of real ETS downloads captured specifically to answer this
question (renaming a device in place, deleting its recorded serial number, and re-addressing it to
a fresh individual address, each isolated as its own session), found two results that together
disambiguate address from every other candidate identity:

- Renaming a device in place — same project record, same full download history, only the
  individual address changes — loses the early check entirely on the next download.
- Downloading again to that *same new* address immediately afterward — even with the serial number
  deleted from the project in between — gets the check back.

Both results only make sense if the signal ETS is tracking lives on the address, not on the
project's own record for that device or on anything read from the device itself (no serial-number
read of any kind precedes the decision in any of these sessions).

🟡 **A related finding from the same test sequence, worth keeping visible so the two are not
conflated**: a separate device-history-aware decision this project's app-model parser has
independently found evidence for elsewhere (whether real ETS conditionally skips its Unload of the
PEI Program interface object, based on the device's own prior-download state) is tracked by a
**different** signal than this early property-27 check. In several of the sessions, that other
decision behaved as if history existed for the address (a live read, then a skip) while, in the
very same session, objects 1/2/3's early property-27 check behaved as if there were no history at
all (no early read, unconditional rewrite). These are two independently-tracked signals inside real
ETS, not one shared "does this address have history" bit — a fix or investigation touching one
should not assume it moves the other.

🔴 Not independently re-confirmed against this project's own capture corpus — the specific
scenario sequence needed (rename in place, re-address with serial deleted, repeated on the same
address) requires deliberate, multi-session real-hardware setup this project's own testbed has not
yet been used for. Flagged as an evidence gap, not treated as unconfirmed speculation — the
underlying mechanism (§7.1's early read; §3.3's separate object-5 signal) is otherwise consistent
with what this project's own corpus already shows.

### 7.3.2 Object 4's own separate early property-27 read — no trigger pattern found

Distinct from §7.3.1 above: `downloadDevice()`'s `LoadImageProp` step handler issues a live
`PropertyValue_Read OX=4 P=27` unconditionally whenever an app declares `LdCtrlLoadImageProp` for
objIdx 4 (needed for write-service byte-5 detection, §4.1) — a separate code path from objects
1/2/3's own checksum-gate mechanism above.

🔴 **No trigger condition found, across an exhaustive real-capture survey.** Every real-ETS-labelled
Full Download capture available (~15 sessions, several device/app families) was checked for whether
real ETS performs this same early read for objIdx 4. Only 3 of the ~15 sessions show it at all, and
none of the following explain the split:

- **Not blank vs. already-programmed**: one genuinely blank/first-touch device shows the early read
  on both of two independent sessions; a different genuinely blank/fresh device never shows it.
- **Not first-download vs. repeat-download**: one device's repeat download *gains* early reads its
  own first download didn't have; a different device's repeat download is byte-identical to its own
  first run in this respect.
- **Not manufacturer-specific** on its own either, since the one device family that shows it
  consistently (both of its own sessions agree) and the one that shows it inconsistently (one of two
  sessions) are different manufacturers, while several other manufacturers checked never show it at
  all across every session on file.

The read is harmless regardless (its own result is explicitly discarded, not used for any decision)
— this is a real, low-stakes protocol-fidelity gap, not a write-safety concern. Resolving it
properly would need the same deliberately-controlled, purpose-built real-session methodology §7.3.1
used above (rename/re-address/repeat sequences against one specific device), rather than surveying
whatever captures already exist for other reasons.

### 7.4 The content-status value's exact byte structure and checksum algorithm

🟢 **Byte structure confirmed, real capture data cross-checked against the real project source**:
for objects 1 (group address table), 2 (association table), and 3 (per-communication-object flags
table), the 8-byte property-27 value decodes as:

```
[reserved:2][object's own table size, bytes, BE:2][reserved:1][write-service signal byte:1][checksum:2]
```

The size field matches the object's own real table length exactly in every case checked. The
write-service signal byte is the same byte already documented in §4.1's `PID_MCB_TABLE` byte-5
candidate rule above — unrelated to the checksum itself, just co-located in the same property
value.

🟢 **The checksum algorithm is confirmed exactly**: CRC-16/CCITT, polynomial `0x1021`, initial
value `0x1D0F`, no input/output reflection, no final XOR — computed directly over the object's own
raw table bytes, no address prefix, no header, no padding. Verified against three independent real
TestBed devices (one manufacturer/app family), all three of group-address table, association
table, and the flags table each — 9 of 9 exact matches, zero exceptions, computed fresh from the
real project source and compared byte-for-byte against the real captured value. The `0x1D0F`
initial value is real and device/firmware-specific — not one of the well-known named CRC-16
presets (CCITT-FALSE, XMODEM, KERMIT, etc., all tried and ruled out first).

🟡 **This refines, rather than confirms, one part of §7.3's own mechanism** — comparing an
object's own early-session read against its own end-of-session read directly, across three real
sessions, shows the flags table's (object 3's) skip/rewrite decision tracking **its own** value:
identical early-to-final when the object was genuinely skipped that session, different when it was
genuinely rewritten (independently confirmed via a separate byte-comparison against the real
capture). §7.3 above documents the original finding using object 4's own value as the gating
signal for object 3's rewrite decision on a different device configuration - not necessarily in
conflict (a real per-device/per-configuration difference is plausible), but not reconciled either;
flagged here rather than silently overwritten.

🟢 **Object 4's own property-27 value is N concatenated copies of the same 8-byte structure
documented above, where N is declared by the app's own real XML** as N separate
`WriteProp(ObjIdx=4, PropId=27, StartElement=1..N)` steps (or, symmetrically, read back via a
single `PropValueRead ... N=<count>`) — not a hardcoded constant. Each element covers its own byte
range of the object's own raw content, `[0 : n]`/`[size − m : size]`/etc., with `n`/`m`-style
per-element boundaries each a static per-app constant read directly off that element's own
declared step data, not computed from device content at download time. Each 8-byte element
independently follows this section's own `[reserved:2][size:2][reserved:1][signal
byte:1][checksum:2]` layout with its own independent CRC.

Confirmed on two real devices with different N: a Jung app declares N=2 (elements `StartElement="1"`
implicit and `StartElement="2"`), matching this project's own real 16-byte example quoted at the
top of §7.1/§7.3 (`000028C0003365E4000000010133DCBD`, splitting into `0000 28C0 00 33 65E4`
(size=10432) and `0000 0001 01 33 DCBD` (size=1)). A real ETS Full Download capture of a Weinzierl
IO534CV device (1.1.11) declares N=4 and returns a 32-byte response:

```
195  PropValueRead  OX=4 P=27 N=4
201  PropValueResp  OX=4 P=27 N=4  $00000014003279080000153C0032FB58000003F00032ED74000000010132DCBD
```

```
elem1  0000 0014 00 32 7908   size=20
elem2  0000 153C 00 32 FB58   size=5436
elem3  0000 03F0 00 32 ED74   size=1008
elem4  0000 0001 01 32 DCBD   size=1  (reserved byte here is 0x01, not 0x00 - unexplained, minor)
```

6 elements checked across two real devices in total — the per-element structure is confirmed;
the element count itself is per-app, not fixed.

### 7.5 The checksum-gated skip, wired into `downloadDevice()`'s partial mode

🟢 `downloadDevice()`'s `mode: 'partial'` path (`server/knx-connection.ts`)
gates GA table/Association table/Object 3 (objIdx 1/2/3 only — object 4/parameter memory keeps
using the pre-existing `pendingWriteRanges` heuristic unconditionally, since its own N-element
property-27 shape, §7.4, isn't wired into this comparison yet) on a live `PropertyValue_Read` of
P=27, compared against a fresh `crc16Knx()` (exported, same file) computed from the session's own
target table content:

- **Checksum matches** → the object's entire load cycle is skipped (no Unload/StartLoading/
  LoadData/write/LoadCompleted at all), matching real ETS's own behavior (§7.3).
- **Checksum mismatches** → the object's FULL content is written, superseding whatever narrower
  `pendingWriteRanges` may have tracked for it — a checksum is whole-object-scoped evidence, not a
  byte-range diff, per §7.3's own finding.
- **Read fails/no response** → falls back to the pre-existing `pendingWriteRanges` heuristic
  unchanged, and the failure itself is recorded three ways: an events-log line (`log()`, not
  `logDebug()` — visible without enabling Debug), a structured `logger.warn('knx', ...)` line, and
  `DownloadResult.verificationIssues` (a new `string[]`, always present, empty when clean) — the
  same "don't let a real problem hide in debug-only output" motivation as §7.3's own detection
  mechanism.

`crc16Knx()` was independently re-validated against this project's **own** real fixtures before being wired in, per this project's standing rule
to validate protocol claims against real captured ETS downloads:
`tests/fixtures/relmem-real-devices/ga-assoc-wire-format-1.1.10.json`'s real GA table
(`00020A010A02`) and Association table (`00020001001F00020020`) both produce the exact checksums a
real ETS Full Download captured for this same device
(a real ETS Partial Download capture of 1.1.10: `$...0033E5AF`
/ `$...0033D15E`) — 2 of 2 exact matches, computed fresh from this project's own content, confirming
§7.4's algorithm independently of the doc's own prior (also 🟢) evidence.

🟢 **The checksum algorithm is now independently confirmed against Object 3's own real content
too, closing this section's prior open question.** A real Object 3 byte fixture for 1.1.10 was
reconstructed directly from the actual `MemExtWrite` chunks in a real Partial Download capture (5
chunks, `0xC2000`–`0xC2390`, 942 bytes total, reassembled in address order): `crc16Knx()` over
those exact bytes produces `0x3B56` — matching, byte-for-byte, the value the device itself
reported via a `PropertyValue_Read P=27` immediately after that same write. This is a different,
later content state than the one an earlier real ETS Partial Download capture (referenced above,
checksum `C327`) recorded — that specific historical content was never separately saved as a byte
fixture and, since Object 3's content has since changed on the real device, can no longer be
reconstructed after the fact — but the algorithm itself is now proven against real Object 3
content in general, not just inferred from the GA/Association tables above.

🔴 **The checksum-gated skip's END-TO-END behavior does not reproduce ETS's own skip decision on
every app.** A real koolenex Partial Download to 1.1.10, compared byte-for-byte against a real ETS
Partial Download to the same device in the same state (via `compare-capture-sessions.ts`), found
ETS wrote almost nothing — 2 single-byte memory writes, everything else a read-only checksum check
that came back "unchanged, skip" — while koolenex's own download wrote the entire GA table,
Association table, Object 3, and parameter memory: a Full-Download-sized payload sent under
`mode: 'partial'`. The checksum ALGORITHM itself is unaffected (§7.5's own 2-of-2 match still
holds); this is specifically the skip DECISION failing to trigger for this app. Confirmed on 1.1.10
only — whether this is specific to that app/device or a more general gap in the skip-gating logic
is not yet root-caused.

### 7.6 Real ETS's own final pre-Restart PID_MCB_TABLE verification read

🟢 Immediately after the last LoadCompleted and immediately
before Restart, real ETS reads `PropertyValue_Read P=27` on every interface object it considered
this session, in ascending objIdx order — a pure verification/confirmation read; nothing in the
captured protocol suggests real ETS branches on the result, so this doesn't interpret or act on it
either. Wired into `downloadDevice()` right before the existing Restart delay, reading from
`relmemJobs` (not `activeJobs`), so it correctly covers objects the checksum-gated skip (§7.5) or
`pendingWriteRanges` filtered out of this session's active writes — matching real ETS's own
"read every object regardless of whether it needed writing" behavior.

🟢 **Retry-hardened, and a real MISMATCH check, not just a logged read** —
`propReadFinal()` retries a lost frame up to two
extra times (300ms apart) before concluding "no response" — a read has no side effects, so retrying
costs nothing beyond a little time, and a device that still won't answer after retrying is a
materially stronger signal than one lost frame. For objIdx 1/2/3 (GA table/Association table/Group
Object Table — the three objects whose single 8-byte `PID_MCB_TABLE` element shape is confirmed, see
§7.4), the read result is compared against a fresh `crc16Knx()` of this session's own target content
(the same value the checksum-gated skip in §7.5 already computes) — a genuine, persistent mismatch
is a real problem, not just a log line. Object 4 (parameter memory)'s own P=27 shape is a variable
N-element structure (§7.4) not yet wired into this comparison, so it still only gets the
retry-hardened presence/response check, matching the same boundary §7.5's own checksum-gated skip
already draws for object 4.

🟢 **Gated on `appUsesP27`**: real ETS does **not** perform this read at
all for an app that never declares
`WriteProp`/`LoadImageProp` for property 27 anywhere in its own load procedure — confirmed via
a genuine live capture showing zero P=27 traffic for such an app, contrasted against an app that
does declare it, whose capture shows exactly this mechanism on every object. This is confirmed
directly against both of this project's own testbed apps' real declared load procedures, not just
by inference: 1.1.9's app declares no `WriteProp`/`LoadImageProp` step for property 27 anywhere at
all, while 1.1.10's app declares both — two `WriteProp` steps (`ObjIdx=4`) and four
`LoadImageProp` steps (`ObjIdx=1,2,3,4`) — matching each device's own real capture behavior exactly.
`appUsesP27` is tracked as a single whole-session flag (not per-object — real apps only ever declare
P=27 on objIdx 4, never 1/2/3, so gating each object on its own declaration would wrongly skip 1/2/3
for every app that uses P=27 at all) incrementally as steps are processed, set by either a
`WriteProp` or `LoadImageProp` step with `propId === 27`.

### 7.7 Write-process safety guards, ObjIdx=0 and RelSegment/WriteRelMem size

🟢 **Two further safety guards** —
both hard, synchronous, before-any-bus-I/O checks in `downloadDevice()`:

- **ObjIdx=0 (Device Object) write guard**, in `propWrite()`: refuses any `PropertyValue_Write` to
  objIdx 0 except the one deliberate `PID_DEVICE_CONTROL` (P=14, Verify Mode) write this engine
  already makes internally — every other object index must be 1 or above. Protects against a real,
  known gap: a load-procedure step whose `ObjIdx` attribute is missing could parse to objIdx=0 via
  a silent fallback upstream, and nothing structural stopped that from reaching the wire before this.
- **`LdCtrlRelSegment`/`LdCtrlWriteRelMem` declared-size cross-check**, in the `WriteRelMem` step
  handler: refuses to write when the two independently-parsed XML attributes disagree for the same
  object — an understated `LoadData` size relative to what's actually streamed is a textbook
  overflow past the device's allocated segment; an overstated one leaves part of a "loaded" segment
  genuinely uninitialized while the device trusts the whole thing once `LoadCompleted` arrives.
  Every real app examined so far declares these identically; nothing enforced that before this
  check.

Both are covered by protocol-level tests (`tests/partial-download-mode.test.ts`, "write-process
safety guards" describe block) — not yet exercised against real hardware, since neither is expected
to ever fire against a well-formed real app (they exist to fail loudly on a malformed/mis-parsed one).

🟢 **`propReadFinal()`'s retry-hardening, live CRC-mismatch detection, and the Restart-withhold
policy.** See
§7.6 above for the retry/mismatch mechanism itself. `DownloadResult` gained `restartWithheld`/
`restartWithheldReasons`: a confirmed content mismatch or a persistent (retried) no-response on the
final pre-Restart read withholds Restart entirely rather than sending it regardless. The reasoning:
a device not yet restarted is, by the Load State Machine's own
staged-write design, still running its OLD, untouched application — safe to leave un-rebooted while
an operator retries or investigates, with nothing lost by not restarting. koolenex has no DB
persistence layer for this outcome (see `DownloadResult.restartWithheld`'s own doc comment). Covered by protocol-level tests in
`tests/partial-download-mode.test.ts` (a lost-frame-then-recovered case, a persistent checksum
mismatch, and a persistent no-response) — not yet exercised against real hardware.

### 7.8 Extending the same mechanism to the AbsSegment (MDT-style) fork

🟢 `downloadDevice()` has two forks (§ architecture notes elsewhere in this repo) —
legacy RelSegment (§7.5–7.7 above) and AbsSegment/MDT, planned via the pure `planDownload()`
function (`knx-download-plan.ts`). The AbsSegment fork has its own live-verification
mechanism, described below.

This fork has no confirmed `PID_MCB_TABLE` (P=27) usage anywhere — `planDownload()` never declares a
property write for it, and no real capture in this project's corpus shows an AbsSegment-family app
declaring `LdCtrlWriteProp`/`LdCtrlLoadImageProp` for property 27 either. Porting §7.6's mechanism
onto this fork literally (forcing a P=27 read it was never shown to use) would be speculative in the
same way the earlier mask-based memory-write-service rule turned out to be (§4.1) — a rule that fit
every sample checked until a genuine counter-example turned up.

Instead, this fork reuses the verification mechanism this device family already has independently
proven: `planVerify()`'s own `'absmem'` family (§ read-back verification, above) reads back exactly
what `planDownload()` streamed and byte-compares it against what was intended. `downloadDevice()`
now runs this same check inline, retry-hardened the same way `propReadFinal()` is (two extra
attempts, 300ms apart), immediately before sending Restart: every `memWrite` region this session
actually wrote gets re-read via `MemoryExtended_Read` and compared byte-for-byte. A genuine mismatch
or a persistent no-response withholds Restart — same `restartWithheld`/`restartWithheldReasons`
policy as the RelSegment fork, same reasoning (the device is still running its old application until
a real Restart happens).

Alongside this, the AbsSegment fork's `propWrite`/`memWrite` execution now waits for a real device
response before continuing (previously fire-and-forget, tracked in `unconfirmedWrites`/
`unconfirmedDetails` the same way the RelSegment fork already does), and gained the same ObjIdx=0
(Device Object) write guard as the RelSegment fork's `propWrite()` closure.

🔴 Protocol-level tested only (`tests/knx-connection.test.ts`, a fake in-process device with a real
backing memory buffer) — not yet exercised against a real AbsSegment/MDT device. No real
AbsSegment-family device write has ever been confirmed on real hardware in this project at all (see
the architecture notes' own caveat), so this is a real gap independent of this specific port.

### 7.9 Two real bugs in the checksum-gated skip's own supporting machinery

🟢 **The generic `LoadImageProp` step handler only issues a live P=27 read for objIdx 4, not for
every declared `LdCtrlLoadImageProp` step regardless of objIdx.** This project's own real capture
corpus (real ETS Full Downloads to 1.1.9/1.1.10) never shows an early
`OX=1`/`OX=2 P=27` read anywhere before the closing Restart — only as part of the post-write final
verification pass (§7.6). The one case where real ETS genuinely DOES read objIdx 1/2/3 early is a
different mechanism this codebase already has: a real ETS Partial Download capture of 1.1.10
shows it reading `OX=1,2,3,4 P=27` early,
in ascending order — that is the checksum-gated skip decision (§7.5), which already issues its own
dedicated read for objIdx 1/2/3. An unscoped generic read here would mean a real double read for
every one of objIdx 1/2/3 in partial mode (this generic, result-discarded read, plus the
checksum-gate's own read moments later), and a wasted, ETS-incorrect early read for objIdx 1/2/3
in full mode (where the checksum-gate never runs at all). Only objIdx 4 keeps a live read at this
step (genuinely needed early, for the memory-write-service byte5 detection, §4.1) — objIdx 1/2/3
rely entirely on the checksum-gate's own read (partial mode) and/or the final verification pass,
never this generic step. Regression tests: `tests/partial-download-mode.test.ts`, "LoadImageProp no
longer reads OX=1/2/3 P=27 early".

🟢 **The final pre-Restart verification read (§7.6) follows each app's own real declared
`LoadImageProp` order, not a hardcoded ascending objIdx order.** Every app this project's own
capture corpus has seen that declares `LdCtrlLoadImageProp` at all happens to declare it
ascending, so a fixed ascending rule would never visibly diverge — but the order is still derived
from the app's own declaration, unlike Unload/write order (which a separate mask-procedure module
derives from the declaration; that module is not present on this branch, and this section is
scoped to the final-verification read order only). The final verification loop records each app's
own real declared `LoadImageProp` order as it's encountered, and follows it directly; any objIdx
the app never declares an order for falls back to the ascending sort. A discriminating regression
test uses a deliberately non-ascending declared order (3, 1, 4, 2) — an ascending fixture could
never tell "follows the declaration" apart from "always sorts ascending regardless" — and confirms
the live engine follows it exactly. Test: `tests/partial-download-mode.test.ts`, "final
verification read order follows the app's own declared LoadImageProp order".

🟢 **Separately, `restartDevice()` (the standalone identity-confirm-and-restart step reused by the
address-write paths, §9) branches between the plain/Basic and Extended `A_Restart` variant by the
device's own live mask** — unlike the RelSegment fork's own end-of-download Restart (§7.6), which
has no Basic/Extended distinction of its own on this branch. This project's own real capture
corpus settles which variant real ETS actually sends at this step: real ETS captures of 1.1.9 and
1.1.10 — both real System B devices (mask low byte 0xB0) — show real ETS sending `RestartReq
$0100` and waiting for a real `RestartResp` (`$000008`/`$000000`) at exactly this
identity-confirm-and-restart step (a `PropertyValue_Read` on P=11 immediately beforehand, matching
this method's own shape); a real ETS capture of a non-System-B device (1.1.60) confirms the plain
variant with no response for the other family. `restartDevice()` reads the device's own live mask
from its existing `DeviceDescriptor_Read` and branches the same way `useExtendedMemory` already
does elsewhere in this file (`(mask & 0xff) === 0xb0`). APCI entries `Restart_Extended`/
`Restart_Extended_Response` (`knx-cemi.ts`) and an `apduRestartExtended()` builder mirror the
existing `MemoryExtended_*` pattern for services sharing a 4-bit base APCI. Tests:
`tests/restart-variant.test.ts`.

### 7.10 Real ETS drains a `Verify="false"` write's response before its next request

🟢 Real ETS capture, Partial Download, same device/app:

```
23.649  → PropValueWrite OX=4 P=27          (element 1 sent)
23.791  ← PropValueResp  OX=4 P=27          (element 1's response)
23.821  → PropValueWrite OX=4 P=27 X=2      (element 2 - sent only after element 1's response)
23.964  ← PropValueResp  OX=4 P=27 X=2      (element 2's response)
23.991  → PropValueRead  OX=4 P=7           (sent only after element 2's response)
24.120  ← PropValueResp  OX=4 P=7 $000C3000
```

Even though `Verify="false"` doesn't require ETS to check the confirmation, it still waits for and
consumes each write's own response before sending the next request - it never has two exchanges
outstanding on the same channel at once. `propWrite()`/`propRead()` here now do the same: a
`Verify="false"` write holds a short (200ms) listener scoped to its own echoed `objIdx`/`propId` until
it resolves or times out (discarding the result either way), and `propRead()` requires a response's
echoed `objIdx`/`propId` to match the request before accepting it - the same `accept`-predicate pattern
`MemoryExtended_Read`/`Memory_Read` already used elsewhere in this file, now applied to property
reads/writes too. Verified via full regression (1860 tests, including a dedicated
`tests/modarch-loopback.test.ts` case) rather than a live repro - a single-threaded, always-in-order
loopback can't reproduce two overlapping exchanges in the first place.

### 7.11 ETS downloads are deltas whenever it has, or thinks it has, history for a device

🟢 Real ETS always performs a delta (non-destructive) download when it has, or believes it has,
history for a device. It first reads `PID_PROGRAM_VERSION` (`OX=4 P=13`); for a device that already
holds the same application it loads objIdx 4 in mode `00` and writes only what it needs — on a
repeat download to an already-matching unit, as little as a single byte of parameter memory (the
object's own last byte), with the parameter writes starting at offset 12 and skipping the segment
header. GA/Association/Object 3 (objIdx 1/2/3) are still written in full. Only for a device it
treats as new (for example after an explicit Unload) does ETS load objIdx 4 in mode `01` and write
the whole image, header first.

koolenex reproduces the delta behaviour with Partial Download. Full Download does not
try to: it writes everything as if the device were new (mode `01`, whole image, header included).

🔴 Do not narrow a Full download's content while keeping mode `01`. On a real Jung dimmer that
combination left the first five bytes of the parameter segment (`49 6E 73 30 06`, not a named
parameter) zeroed, and the device misbehaved until a full download after an Unload restored them.

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
- **🟢 `planVerify()`'s prop-family branch (`server/knx-download-plan.ts`) must not conflate a
  `CompareProp` step's manufacturer-identity PRECONDITION-check constant with a `WriteProp` step's
  real post-download config value for the same `(objIdx, propId)`** — doing so guarantees a
  spurious mismatch whenever those two constants genuinely differ (they check different things: a
  CompareProp is what real ETS verifies *before* attempting a download at all, a WriteProp is the
  real config written and what a post-download Verify should compare against). `propSteps` filters
  to `WriteProp` only; `downloadDevice()`'s own `CompareProp` case (a deliberate no-op) is
  unaffected. Regression coverage:
  `planVerify() - prop family` in `tests/knx-download-plan.test.ts` (including a direct reproduction
  of the conflation — a `CompareProp` and `WriteProp` for the same PID with genuinely different
  values), plus `tests/knx-verify-plan.test.ts`'s and `tests/bus-routes.test.ts`'s existing
  property-configured-device tests updated to reflect the corrected behavior.

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
   *then* `T_Disconnect`. Confirms `restartDevice()`'s own `postRestartDelayMs` (default 3000ms)
   against a real capture, not a guess - see that method's own doc comment.
7. A separate KNXnet/IP Tunnel-level `DisconnectReq`/`Resp` a couple seconds later - the whole IP
   session closing, not device-specific.

**No `PID_PROGMODE=0` write appears anywhere in this capture** - unlike §9.3's Factory Reset, a
plain address write relies on the Restart alone to end programming mode. Confirms that finding
was specific to Factory Reset, not a general property of every address-related ETS operation.

This capture directly validates koolenex's own `assignIndividualAddressBySerial()`/`programIA()`
restart-after-write sequence (write → verify → Restart → wait → disconnect), which follows the
same order real ETS uses.

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
bit-mapping (§6.4), the content-status/checksum mechanism and its safety-net rewrite trigger (§7),
and the tshark address-mis-display gotcha (§8). §9's 🟢 claims are sourced from live tests against
real hardware via this app's own routes, plus a real tshark capture of ETS's own commissioning
traffic (factory reset + full download) that settled the exact wire format; §9.3/§9.4 each have
their own dedicated HDL capture (see those subsections' references). The dated files under
`docs/follow-ups/*.md` hold the full investigation narrative for anyone who wants "how this was
found" rather than just the current facts above.
