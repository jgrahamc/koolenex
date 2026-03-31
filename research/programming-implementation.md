# Programming Implementation — Status and Plan

## What "Programming" Means

Programming a KNX device means writing its configuration into its non-volatile memory over the bus. This includes:

1. **Parameter memory** — user-configured values (e.g., dimming curve, timeout, mode)
2. **Address table** — the device's individual address
3. **Group address table** — which group addresses the device listens to
4. **Association table** — which group addresses map to which communication objects
5. **Application program** (sometimes) — the firmware/code segments

ETS6 handles this through a multi-step "load procedure" that writes memory segments and sets load state machine transitions.

## What We Have Today

### Server-side (`/bus/program-device` endpoint)

A working pipeline that:

1. Loads the device record and its app model JSON (extracted during .knxproj import)
2. Builds the GA table from COM object group address links
3. Builds the association table mapping COM objects to GA table indices
4. Builds parameter memory by:
   - Seeding a buffer from the RelativeSegment base image (pre-filled defaults)
   - Evaluating which parameters are conditionally active (choose/when tree)
   - Writing non-default parameter values using bit-packing
   - Processing Assign operations (value propagation between parameters)
5. Converts load procedure steps from hex to buffers
6. Executes the download via `bus.downloadDevice()` with WebSocket progress

### Client-side (`ProgrammingView`)

- Summary cards showing programmed/modified/unassigned device counts
- Device table with program/re-program buttons
- Fake progress bar (interval-based, not driven by real WebSocket progress events)
- Log panel showing operation results

### Bit-packing (`writeBits`)

Matches the ETS6 convention:
- MSB-first (bitOffset=0 is bit 7 of the first byte)
- Handles values spanning two bytes via recursive split
- Big-endian byte order for multi-byte values

### KNX float16 (`writeKnxFloat16`)

Encodes DPT 9.x two-byte floats (mantissa + exponent format).

## The 5-Layer ETS6 Pipeline (What We're Replicating)

Understanding this pipeline is critical — it's what ETS6 does internally:

1. **Dynamic XML to UI State Tree** — Parse the Dynamic section of the application program XML into a tree of channels, parameter blocks, choose/when conditionals, assigns, and repeats. This determines what's visible and active.

2. **Activity Calculation** — Reference-count which parameters are "active" based on which choose/when branches are selected. When a parameter goes inactive, its value resets to default.

3. **Assign Execution** — When a parameter activates, run any Assign operations that copy values between parameters or set static values.

4. **Non-Default Cache** — Build the set of parameters that need to be written: those that are both active AND have a value different from their default. This is the key insight: only non-default active parameters are downloaded.

5. **Memory Image Assembly** — For each parameter in the non-default cache, compute its byte/bit offset, convert the value to bytes, and bit-pack it into the memory image buffer. The buffer starts as a copy of the RelativeSegment base image.

## What Works

- Basic parameter memory assembly for simple devices (no modules, no repeats)
- Conditional parameter evaluation (choose/when based on parameter values)
- Assign operations (literal value and source-to-target parameter copies)
- Bit-packing matching ETS6 convention
- KNX 2-byte float encoding
- GA table and association table construction
- Load procedure step execution
- Bus communication (KNX/IP tunneling and USB)

## What We Know But Haven't Fully Implemented

### Coefficient Scaling

ETS6 applies `Round(value / Coefficient)` when writing and `raw * Coefficient` when reading. Some parameter types define a Coefficient in their format. We parse this but don't apply it during memory assembly.

### Mask Tracking

ETS6 tracks which bytes in the memory image were explicitly written (via a parallel Mask buffer). During download, only written bytes are sent — this enables "partial download" where unchanged bytes are skipped. We currently send the entire segment.

### DownloadBehavior Flags

Each parameter has a DownloadBehavior: `Background` (normal write), `DefaultValue` (write even if at default), `None` (skip). We partially handle this but don't fully respect all three modes.

### Module Arguments (%ArgName% Substitution)

Modules use `%ArgName%` tokens in parameter initial values that get replaced with per-instance computed values (BaseValue + InstanceIndex * Step). We parse argDefs and modArgs from the catalog but don't yet substitute tokens in parameter values during assembly.

### Repeat Elements

The Repeat element creates multiple instances of parameter blocks, each with offset memory locations. The firmware accesses these via `base_address + channel_index * block_size`. A test project has 0 Repeat and 0 Module elements, so this hasn't been tested.

### Byte Order (Motorola)

Some parameters use Motorola (big-endian) byte ordering within multi-byte fields. ETS6 checks a `byteOrderMotorola` flag. We don't check this flag.

### Special Value Encodings

We handle Number and KNX float16. Missing:
- IEEE 754 single-precision float (DPT 14.x)
- IEEE 754 double (DPT 29.x)
- Text/String (null-padded to field size)
- Date, Time
- Color RGB/RGBW
- IP Address
- RawData

### Load Procedure Types

Three types exist:
- **DefaultProcedure** — uses only the mask's built-in procedure
- **ProductProcedure** — self-contained in the application program
- **MergedProcedure** — combines mask base procedure with product-specific inserts at MergeId points

Most ABB devices use MergedProcedure. We need to handle all three correctly.

### ParameterCalculation (VBScript/JavaScript)

Some parameters use bidirectional VBScript or JavaScript transforms defined in the schema. These are rare but exist. Not implemented.

## What We Don't Know

### Exact Merge Procedure Semantics

For MergedProcedure, we know the concept (insert product load steps at MergeId anchor points in the mask's base procedure) but haven't verified our implementation against a wide range of devices. The interaction between mask-defined steps and product-defined steps needs more testing.

### Multi-AP (ApplicationProgram2)

Some devices have a dual application program architecture where AP2 is the "parameter" program and AP1 is the "application code." We don't handle this case.

### Memory Verification

ETS6 can verify the downloaded memory matches what was written. We don't implement verification reads after download.

### Partial Download

ETS6 supports downloading only the changed parameters (using the mask tracking). This requires knowing what was previously downloaded (the "loaded image" stored in the .knxproj). We don't track this — we always do a full download.

### Extended Memory Services

Some devices support extended memory services for larger address spaces. The `SupportsExtendedMemoryServices` flag exists in the schema but we don't use it.

### Load State Machine Edge Cases

The load state machine has specific transition rules. We set load state bytes but haven't verified all edge cases (e.g., what happens if a previous download was interrupted).

### Real-World Device Coverage

Our testing has been limited:
- **49 devices** in a test project were checked for parameter memory accuracy
- 1 device matched perfectly, 6 had only 2 "stale" diffs (previous download artifacts)
- ~25 ABB devices had a 0x03 prepend issue (since resolved)
- 10 DIM devices had 35 diffs each (likely an unconditional vs. conditional param evaluation issue)
- 3 had size mismatches

The DIM device diffs and size mismatches are unresolved and likely point to gaps in our conditional evaluation or memory layout calculation.

### Firmware Version Checking

Load procedures can include `LdCtrlCompareProp` steps that check firmware version before downloading. We parse these but may not handle all comparison modes.

### Connection Management During Programming

Long downloads require stable bus connections. We don't have robust retry/resume logic if the connection drops mid-programming.

## Recommended Next Steps (Priority Order)

1. **Fix DIM device diffs** — these 35-diff devices likely reveal a systematic bug in conditional parameter evaluation or segment layout
2. **Coefficient scaling** — straightforward to add, affects accuracy of many parameter types
3. **Mask tracking + partial download** — reduces bus traffic and programming time significantly
4. **Real WebSocket progress** — replace the fake progress bar with actual download progress from the server
5. **Module argument substitution** — needed for projects with module-based devices
6. **Memory verification** — read-back after write to confirm programming succeeded
7. **Broader device testing** — test against more .knxproj files with diverse device types
