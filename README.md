<p align="center">
  <img src="images/koolenex.svg" width="120" alt="koolenex">
</p>

# koolenex

Open-source KNX project tool. Import `.knxproj` files from ETS6,
manage your installation, and interact with a live KNX bus.

DISCLAIMER: THIS IS HIGHLY EXPERIMENTAL. PROBABLY FULL OF
BUGS. PROBABLY FAILS HORRIBLY ON YOUR KNXPROJ FILE. PROCEED WITH
CAUTION. DON'T USE FOR ANY REAL KNX PROJECT. CONNECTIONS WITH BUS
MONITOR ARE NOT GUARANTEED TO WORK CORRECTLY. ANYTHING COULD HAPPEN.

PROCEED AT YOUR OWN RISK.

## Features

- **Project import** — parse ETS6 `.knxproj` files including password-protected projects
- **Locations** — browse your building structure (floors, rooms, distribution boards) with in-place name editing
- **Topology** — view areas, lines, and devices in their physical layout
- **Devices** — search, filter, sort, and edit devices; view parameters, group objects, and linked group addresses
- **Group Addresses** — tree and flat views with DPT display, linked device counts, inline creation, and in-place name editing at all three levels
- **Group Objects** — browse communication objects across all devices
- **Manufacturers** — devices grouped by manufacturer and model with catalog links
- **Product Catalog** — browse products from imported `.knxproj` files organized by manufacturer and category; import standalone `.knxprod` files to add new device types; add devices to projects directly from the catalog
- **Bus Monitor** — live telegram feed with decoded values, flow diagrams, and CSV export
- **Bus Scan** — discover devices on the KNX bus
- **Bus Connection** — connect via KNXnet/IP tunnelling or USB interface
- **Device Programming** — download application programs, parameters, group address tables, and association tables to devices; verify a device against the project's expected image; assign individual addresses to newly-connected devices (alpha — writes to real hardware)
- **Device Comparison** — compare two devices side by side, or select multiple devices of the same type for multi-device parameter diff
- **Floor Plan** — upload floor plan images for each floor and drag devices onto them to visualize your installation layout
- **Label Printing** — print device address labels on Avery label sheets (L4730, L4731, L4732, L6008, L7636, L7651, L7656) or a full-page legend sheet for distribution board doors; configurable fields, device selection, and print preview
- **Audit Log** — per-project log of all changes with before/after detail, viewable in the UI and downloadable as CSV
- **Settings** — theme (dark/light), DPT display format (numeric/formal/friendly), language
- **Editable fields** — click-to-edit names, descriptions, comments, and installation hints with RTF rendering
- **CSV export** — export devices, group addresses, group objects, topology, locations, and manufacturers
- **Undo/redo** — Ctrl+Z to undo edits with a browsable undo history dropdown
- **Global search** — find devices, group addresses, manufacturers, and models

## Screenshots

### Locations

The building view shows your KNX installation organized by floors and
rooms, matching the structure defined in ETS6. Expand any floor to see
the devices assigned to each space.

![Locations view](images/buildings.png)

### Topology

Devices displayed in their physical bus topology — areas, lines, and
individual addresses. Shows manufacturer, model, serial number,
location, and programming status at a glance.

![Topology view](images/topology.png)

### Device Detail

Click any device to open its detail panel. The overview tab shows
device metadata, editable description/comment/installation hints
fields, and lists all other devices of the same type for quick
comparison.

![Device detail](images/device.png)

### Device Parameters

View and edit device parameters organized by channel, exactly as they
appear in ETS6. The parameter tree on the left mirrors the ETS
parameter page structure.

![Parameters](images/parameters.png)

### Device Comparison

Select two devices of the same type and compare their parameters side
by side. Differences are highlighted, making it easy to spot
configuration mismatches. The comparison also covers group objects and
linked group addresses.

![Compare devices — parameters](images/compare%20two%20devices%20(first%20part).png)

![Compare devices — group objects and addresses](images/compare%20two%20devices.png)

### Connection Diagram

A visual map showing how a device connects to the rest of the
installation through its group addresses. Each group address fans out
to the other devices that share it, revealing the communication
topology.

![Connection diagram — thermostat](images/connection%20diagram.png)

![Connection diagram — actuator](images/connection%20diagram%202.png)

### Live Connection Diagram

Watch telegrams flow through the connection diagram in real time. As
devices communicate, animated dots trace the path from sender through
the group address to all receivers, with speech bubbles showing the
decoded value.

![Live connections](images/live%20connections.gif)

### Bus Monitor

Live telegram feed from the KNX bus with DPT-aware decoding,
source/destination resolution, and device location display. The
timeline at the bottom shows telegram flow between devices. Supports
filtering, read/write operations, and CSV export.

![Bus monitor](images/bus%20monitor.png)

### Per-Device Monitor

Each device detail panel has its own monitor tab showing only the
telegrams relevant to that device, filtered from the live bus feed.

![Device monitor](images/bus%20monitor%20on%20device%20page.png)

### Per-Group Address Monitor

Group addresses also have a dedicated monitor tab, showing every
telegram sent to that address with decoded values and source device
information.

![Group address monitor](images/bus%20monitor%20on%20group%20address%20page.png)

### Floor Plan

Upload a floor plan image for each floor and drag devices from the
sidebar onto their physical locations. Device positions are saved and
persist across sessions. Tabs at the top switch between floors.

![Floor plan](images/floorplan.png)

### Manufacturers

Devices grouped by manufacturer and model. Expand any model to see all
instances in the installation with their addresses, locations, and
status.

![Manufacturers](images/manufacturer.png)

### Universal Search

Search across devices, group addresses, manufacturers, and models from
anywhere in the app. Results are grouped by type and clicking any
result navigates directly to it.

![Universal search](images/universal%20search.png)

## Requirements

- Node.js 23.6+ (the server is written in TypeScript and run directly via Node's built-in type stripping — no build step)

No native compilation needed — all dependencies are pure JavaScript. The USB transport optionally uses `node-hid` (installed on demand).

## Setup

```bash
# Install server dependencies
npm install

# Install frontend dependencies
cd client && npm install && cd ..
```

## Running (development)

Open two terminals:

```bash
# Terminal 1 — backend API on :4000
npm start

# Terminal 2 — frontend dev server on :5173
cd client && npx vite
```

Then open **http://localhost:5173**

## Running (production)

```bash
cd client && npm run build && cd ..
npm start
# Open http://localhost:4000
```

## KNX Bus Connection

Two connection methods are supported:

- **KNXnet/IP** — UDP tunnelling, TCP tunnelling, or multicast routing; enter the gateway IP/port (and protocol) in the Project panel
- **USB** — plug in a KNX USB interface and scan for devices in the Project panel (requires the optional `node-hid` package: `npm install node-hid`)

koolenex uses its own KNX protocol implementation with no external KNX dependencies.

## Disclaimer

koolenex is an experimental tool for exploring and monitoring KNX
installations. It is very much under active development and has only
been tested against a small number of real-world `.knxproj` files —
there are almost certainly incompatibilities with other projects,
device types, and ETS configurations.

## Stack

| | |
|---|---|
| Frontend | React 18 + Vite |
| Backend | Node.js + Express |
| Database | SQLite via sql.js (in-memory, persisted to `koolenex.db`) |
| Real-time | WebSocket |
| Protocol | KNXnet/IP (UDP tunnelling), KNX USB (HID) |

## Project Structure

Source is TypeScript throughout (`.ts` / `.tsx`). The server is run directly by Node with no build step; the client is built by Vite.

```
server/
  index.ts               — Express server, WebSocket, CORS, graceful shutdown
  db.ts                  — SQLite (sql.js) database with audit-log triggers
  validate.ts            — Zod validation helpers for routes
  log.ts                 — Structured JSON logging (tagged)
  ets-parser.ts          — .knxproj / .knxprod ZIP parser (handles AES-256-CBC)
  ets-app.ts             — Application program parsing (params, group objects, channels)
  ets-hardware.ts        — Product / hardware metadata parsing
  ets-capture.ts         — Persisted ETS-import capture used by cross-check tests
  ets-zip.ts             — Encrypted-ZIP handling
  coverage-report.ts     — Verify-coverage classification shared with the UI
  knx-bus.ts             — KnxBusManager: facade over IP + USB transports
  knx-connection.ts      — Base KNX management (CEMI, APDU, memory services, scan)
  knx-protocol.ts        — KNXnet/IP UDP + TCP tunnelling
  knx-protocol-routing.ts — KNXnet/IP multicast routing
  knx-ip-common.ts       — Frame builders/parsers shared by the IP transports
  knx-usb.ts             — KNX USB HID transport
  knx-cemi.ts            — CEMI encoding/decoding
  knx-dpt.ts             — DPT buffer encode/decode
  knx-download-plan.ts   — Verify/download plan builder (mem + property flavors)
  knx-segment-base.ts    — PID 7 (LoadStateMachine) base address resolution

  routes/
    index.ts             — Router registration; shared bus reference
    projects.ts          — Import, delete, project metadata, audit log
    devices.ts           — Device CRUD, parameters, comparison
    gas.ts               — Group addresses (CRUD, tree/flat, inline edits)
    catalog.ts           — Product catalog browsing + .knxprod import
    bus.ts               — Bus connect/monitor/scan/program/verify/address
    knx-tables.ts        — GA / association / group-object table builders
    settings.ts          — Settings, telegrams, CSV export
    import-jobs.ts       — Async import job registry
    shared.ts            — Route helpers (bus + db bridge)

shared/
  types.ts               — Core entity types used by server and client
  ga-maps.ts             — Device ↔ GA lookup maps built from group objects

client/src/
  main.tsx               — App entry (renders <App/>)
  App.tsx                — Providers, undo store, WebSocket wiring
  AppShell.tsx           — Nav sidebar, top bar, alpha-warning modals
  BusConnectionPanel.tsx — Shared bus connection UI (also used from the top bar)
  AddDeviceModal.tsx     — Add-device modal (Catalog / device pages)
  AddressDeviceModal.tsx — Assign individual addresses to unaddressed devices
  api.ts                 — REST client + WebSocket
  state.ts               — useReducer store (projects, devices, GAs, telegrams, ...)
  contexts.ts            — Data/actions/live/verify contexts
  routes.ts              — URL helpers (viewFromPath, pinUrl, ...)
  theme.ts               — Dark/light theme contexts + mask-version registry
  dpt.ts                 — DPT info, formatting, i18n
  columns.tsx            — Table column definitions and CSV export
  diagram.tsx            — SVG connection diagrams
  icons.tsx              — SVG icon library
  primitives.tsx         — Shared UI (Btn, Spinner, Toast, ConfirmModal, …)
  rtf.tsx                — RTF-to-HTML rendering + editable fields
  hex.tsx                — Hex display helpers
  search.tsx             — Global search

  views/
    ProjectsView.tsx        — Project list, import, delete
    ProjectInfoView.tsx     — Bus connection, project metadata, audit log
    LocationsView.tsx       — Building structure tree with device tables
    FloorPlanView.tsx       — Floor plan image with draggable devices
    TopologyView.tsx        — Bus topology diagram (areas/lines/devices)
    DevicesView.tsx         — Searchable/sortable device table
    GroupAddressesView.tsx  — GA tree and flat views with inline editing
    ComObjectsView.tsx      — Group objects table
    ManufacturersView.tsx   — Devices grouped by manufacturer/model
    CatalogView.tsx         — Product catalog browser (+ .knxprod import)
    BusMonitorView.tsx      — Live telegram feed with timeline
    BusScanView.tsx         — Bus device discovery
    ProgrammingView.tsx     — Device programming + verify (alpha)
    DeviceCompareResults.tsx — Verify-result comparison panel
    PrintLabelsView.tsx     — Avery label sheets + legend printer
    SettingsView.tsx        — Theme, DPT format, language

  detail/
    PinDetailView.tsx       — Pin type router
    DevicePinPanel.tsx      — Device detail (metadata, group objects, linked GAs)
    DeviceParameters.tsx    — Parameter tree editor with related group objects
    DeviceProductTab.tsx    — Product info and similar devices
    GAPinPanel.tsx          — Group address detail with linked devices
    ComparePanel.tsx        — Two-device comparison
    PinTelegramFeed.tsx     — Per-device / per-GA telegram feed

  hooks/
    useProjectHandlers.ts   — Project-level action handlers (import, undo)
    useBusHandlers.ts       — Bus connect / write / clear handlers
    usePersistedState.ts    — useState-with-localStorage helper
    spaces.ts               — Space-tree helpers

tests/                     — Node built-in test runner (`node --test`), with real
                             .knxproj / .knxprod fixtures for cross-check tests

data/
  apps/                    — Cached application program models (JSON)
  floorplans/              — Uploaded floor plan images
  knx_master_*.xml         — Per-project KNX master data

docs/                      — Developer documentation (e.g. write-protocol notes)
research/                  — Implementation research and planning documents
```
