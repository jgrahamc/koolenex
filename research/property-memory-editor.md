# KNX Property Editor and Memory Editor

## The Interface Object Server (IOS)

Every KNX device organizes its internal data into an Interface Object Server (IOS). Rather than exposing a flat blob of memory, the IOS structures data into **interface objects**, each containing a set of **properties** identified by numeric Property IDs (PIDs).

This provides two distinct ways to access device data:
- **Property access** (indirect, structured): read/write typed values by object index + property ID
- **Memory access** (direct, raw): read/write bytes at absolute memory addresses

Device programming uses both: property reads to discover memory layout, then memory writes to store parameter data.

## Standard Interface Object Types

From the KNX spec (`03_05_01 Resources`):

| Object Type | Code | Purpose |
|---|---|---|
| Device Object | 0 | Device identity, firmware, serial number, manufacturer ID, programming mode |
| Address Table | 1 | Individual + group address mappings |
| Association Table | 2 | Links group addresses to communication objects |
| Application Program | 3 | Application code/parameters, load state, PID_TABLE_REFERENCE |
| Interface Program | 4 | Interface program (coupler-specific) |
| Router | 6 | Routing/filtering config for line/area couplers |
| cEMI Server | 8 | cEMI communication mode, medium type |
| Group Object Table | 9 | Group object configuration |
| KNXnet/IP Parameter | 11 | IP address, subnet, gateway, MAC, friendly name, tunneling config |
| Security | 17 | Security mode, keys, sequence numbers |
| RF Multi | 19 | RF wireless parameters |

Every device has at least a Device Object (type 0). More capable devices have many interface objects.

## Key Properties

**Common properties** (shared by all object types):
- PID 1: Object Type
- PID 2: Object Name
- PID 5: Load State Control (0x00=Unloaded, 0x01=Loaded, 0x02=Loading, 0x03=Error, 0x04=Unloading)
- PID 25 (0x19): PID_TABLE_REFERENCE — base memory address for a segment

**Device Object (type 0):**
- PID 9: Firmware Revision
- PID 11: Serial Number (6 bytes)
- PID 12: Manufacturer ID (2 bytes)
- PID 13: Program Version
- PID 15: Order Info
- PID 21: Description
- PID 54 (0x36): Programming Mode
- PID 56 (0x38): Max APDU Length
- PID 78: Hardware Type

**KNXnet/IP Parameter (type 11):**
- PID 51: Current IP Address
- PID 52: Subnet Mask
- PID 53: Default Gateway
- PID 54: DHCP/BootP Enable
- PID 55: MAC Address
- PID 57: Friendly Name

Each property has a Property Data Type (PDT) defining its encoding, and properties can be arrays (addressed by startIndex + count).

## Protocol Messages

### Property Services

Transmitted in connected-mode point-to-point (requires T_CONNECT):

| Service | APCI | Payload |
|---|---|---|
| A_PropertyValue_Read | 0x03D5 | objectIndex(1) + propertyId(1) + count:startIndex(2) |
| A_PropertyValue_Response | 0x03D6 | objectIndex(1) + propertyId(1) + count:startIndex(2) + data(N) |
| A_PropertyValue_Write | 0x03D7 | objectIndex(1) + propertyId(1) + count:startIndex(2) + data(N) |
| A_PropertyDescription_Read | 0x03D8 | objectIndex(1) + propertyId(1) + propertyIndex(1) |
| A_PropertyDescription_Response | 0x03D9 | objectIndex(1) + propertyId(1) + propertyIndex(1) + type(1) + maxElements(2) + readWriteLevel(1) |

The count/startIndex field is packed as: `(count << 12) | (startIndex & 0xFFF)` in 2 bytes.

`A_PropertyDescription_Read` is how you discover which properties exist on an object — iterate propertyIndex from 0 upward until the response returns propertyId=0 (end of list). The response tells you the property's data type, max array size, and read/write access level.

### Memory Services

| Service | APCI | Payload |
|---|---|---|
| A_Memory_Read | 0x0200 | count(6 bits in APCI) + address(2 bytes) |
| A_Memory_Response | 0x0240 | count(6 bits) + address(2 bytes) + data(N) |
| A_Memory_Write | 0x0280 | count(6 bits) + address(2 bytes) + data(N) |

Count is encoded in the low 6 bits of the APCI byte (max 63 bytes per frame, but practical limit is constrained by MAX_APDU length — typically 10-15 bytes per frame for TP devices).

All services require a transport-layer connection (T_CONNECT/T_DISCONNECT) with sequence numbering and ACKs.

## What a Property Editor Does

A property editor is a diagnostic tool that lets you:

1. **Enumerate interface objects** — read object type properties at each index until you get no response
2. **Discover properties** — use A_PropertyDescription_Read to list all properties on each object with their types and access levels
3. **Read property values** — display current values with proper type formatting
4. **Write writable properties** — modify device configuration at the property level
5. **Common tasks**:
   - Read device identity (serial, manufacturer, firmware)
   - Read/write IP configuration on KNXnet/IP devices
   - Read/write load state (signal loading/loaded/unloaded to devices)
   - Toggle programming mode
   - Read PID_TABLE_REFERENCE to find memory segment base addresses

## What a Memory Editor Does

A memory editor provides raw byte-level access to device memory:

1. **Read memory** — specify address and byte count, display as hex dump
2. **Write memory** — edit bytes and write back
3. **Useful for**:
   - Inspecting parameter values at their actual memory addresses
   - Examining address tables, association tables, group object tables
   - Debugging programming issues (comparing expected vs actual memory contents)
   - Manual patching when the structured programming path doesn't work

## What Koolenex Already Has

The protocol layer is implemented in `knx-connection.js`:

- `A_PropertyValue_Read` and `A_PropertyValue_Write` — used during device info reads and programming
- `A_Memory_Write` — used during device programming to write parameter memory
- Transport connection management (T_CONNECT/T_DISCONNECT, sequence numbering, ACK handling)
- Management session wrapper with timeout and retry

**Not yet implemented:**
- `A_PropertyDescription_Read/Response` — needed to discover available properties
- `A_Memory_Read` — request builder exists in APCI constants but no helper function
- Response parsing for memory reads

## Implementation Plan

### Phase 1: Property Browser

1. Add `A_PropertyDescription_Read` to the protocol layer
2. Add `A_Memory_Read` with response parsing
3. Add server endpoints:
   - `POST /bus/property-read` — read a property value
   - `POST /bus/property-write` — write a property value
   - `POST /bus/property-scan` — enumerate objects and properties on a device
   - `POST /bus/memory-read` — read memory at an address
4. Build a PID-to-name mapping from the KNX spec (Device Object PIDs, KNXnet/IP PIDs, etc.)

### Phase 2: UI

5. Add a Property/Memory tab to the device pin view (or a new dedicated view)
6. Property browser: tree of interface objects, each expandable to show properties with current values
7. Editable fields for writable properties
8. Memory viewer: hex dump display with address input, read button, and optional write capability
9. Integration with known segment layout — highlight parameter regions, address table regions, etc.

### Effort Estimate

Moderate. The hard protocol work (tunneling, CEMI framing, transport connections) is done. The main work is:
- A few new APDU builders/parsers (PropertyDescription, MemoryRead)
- PID name/type mapping data
- UI components for browsing and editing
