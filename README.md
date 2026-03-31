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
- **Device Programming** — download application programs, parameters, group address tables, and association tables to devices (work in progress)
- **Device Comparison** — compare two devices side by side, or select multiple devices of the same type for multi-device parameter diff
- **Floor Plan** — upload floor plan images for each floor and drag devices onto them to visualize your installation layout
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

- Node.js 18+

No native compilation needed — all dependencies are pure JavaScript.

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

- **KNXnet/IP** — enter your gateway IP address and port in the Project panel
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

```
server/
  index.js            — Express server, WebSocket setup
  routes.js           — REST API endpoints (~45 routes)
  db.js               — SQLite database layer with audit logging
  ets-parser.js       — .knxproj and .knxprod file parser
  knx-bus.js          — KNX bus connection manager (IP + USB facade)
  knx-connection.js   — KNX/IP protocol, device management, memory services
  knx-protocol.js     — KNXnet/IP UDP tunnelling implementation
  knx-usb.js          — KNX USB HID interface

client/src/
  App.jsx             — main app shell, sidebar, routing, undo system
  api.js              — REST API client + WebSocket
  state.js            — app state management (useReducer)
  theme.js            — dark/light themes, color constants
  contexts.js         — React contexts (DPT, pin, theme)
  dpt.js              — DPT info, formatting, and i18n
  search.jsx          — global search component
  primitives.jsx      — shared UI components (Btn, Spinner, Toast, etc.)
  columns.jsx         — table column definitions and CSV export
  diagram.jsx         — SVG connection diagrams
  icons.jsx           — SVG icon library
  rtf.jsx             — RTF-to-HTML rendering and editable fields
  hex.jsx             — hex display utilities
  AddDeviceModal.jsx  — add device modal (used from multiple views)

  views/
    ProjectsView.jsx        — project list, import, delete
    ProjectInfoView.jsx     — bus connection, project metadata, audit log
    LocationsView.jsx       — building structure tree with device tables
    FloorPlanView.jsx       — floor plan image with draggable devices
    TopologyView.jsx        — bus topology diagram (areas/lines/devices)
    DevicesView.jsx         — searchable/sortable device table
    GroupAddressesView.jsx  — GA tree and flat views with inline editing
    ComObjectsView.jsx      — communication objects table
    ManufacturersView.jsx   — devices grouped by manufacturer/model
    CatalogView.jsx         — product catalog browser with .knxprod import
    BusMonitorView.jsx      — live telegram feed with timeline
    BusScanView.jsx         — bus device discovery
    ProgrammingView.jsx     — device programming (work in progress)
    SettingsView.jsx        — theme, DPT format, language

  detail/
    PinDetailView.jsx       — pin type router and multi-compare panel
    DevicePinPanel.jsx      — device detail (metadata, COs, linked GAs)
    DeviceParameters.jsx    — parameter tree editor
    DeviceProductTab.jsx    — product info and similar devices
    GAPinPanel.jsx          — group address detail with linked devices
    ComparePanel.jsx        — two-device comparison
    PinTelegramFeed.jsx     — per-device/GA telegram feed

data/
  apps/                 — cached application program models (JSON)
  floorplans/           — uploaded floor plan images
  knx_master_*.xml      — per-project KNX master data

research/               — implementation research and planning documents
scripts/                — utility scripts (anonymize, demo)
```
