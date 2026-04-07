# Codebase Critique

## Architecture & Structure

**Strengths:**

- Clean separation between server, client, and shared code
- Well-designed monorepo with `shared/types.ts` ensuring type safety across the boundary
- Good use of Express router composition with modular route files
- sql.js is a clever choice for a desktop-adjacent tool — avoids native compilation

**Weaknesses:**

- **No client-side router** — the entire app is a single `App.tsx` with manual view state management and a custom nav history stack (`navHistory`/`navIndex`). This reinvents react-router poorly and will become harder to maintain as the app grows
- **`App.tsx` is ~1600+ lines** — a God component that manages theme, DPT mode, i18n, undo/redo, all CRUD handlers, sidebar resizing, keyboard shortcuts, WebSocket lifecycle, and renders the entire shell. This should be broken into at least 3-4 components
- **No dependency injection or service layer** on the client — `api` is a singleton object imported directly, making testing difficult

---

## Database Layer (`db.ts`)

**Strengths:**

- Good query helpers (`all`, `get`, `run`) with generics
- Transaction wrapper with automatic save scheduling
- `getProjectFull` is a well-designed aggregate query

**Weaknesses:**

- **Migration strategy is fragile** — `ALTER TABLE` with try/catch swallowing errors, plus a manual `migrate()` helper that checks `PRAGMA table_info`. This will break silently if a migration fails. Use a proper migration version table
- **No indexes** beyond the audit log — queries like `WHERE project_id=?` on devices, group_addresses, com_objects will degrade badly with large projects
- **`save()` writes the entire DB to disk on every mutation** — even with debouncing, this is O(file_size) per write. For a 50MB+ `.knxproj` import, this is a bottleneck
- **JSON stored as TEXT** (`parameters`, `param_values`, `model_translations`) — no validation, no indexing, no type safety at the DB level

---

## State Management (`state.ts`)

**Strengths:**

- Clean discriminated union for actions
- Good use of immutability patterns
- Window persistence per project is a nice touch

**Weaknesses:**

- **No memoization** — every `PATCH_DEVICE`/`PATCH_GA` creates a new `projectData` object, causing full re-renders of any component consuming it. With 500+ devices, this will feel sluggish
- **`buildGAMaps` is called on every `PATCH_COMOBJECT`** — this is O(n) over all com objects for a single change
- **No optimistic update rollback** — if the API call fails after the dispatch, the UI is out of sync with the server

---

## API Layer (`api.ts`)

**Strengths:**

- Clean, consistent interface
- Good error handling with custom `ApiError` class
- WebSocket with auto-reconnect

**Weaknesses:**

- **Hardcoded dev port detection** (`location.port === '5173'`) — fragile magic number that breaks if Vite runs on a different port
- **No request deduplication** — if two components call `api.getProject()` simultaneously, two identical requests fire
- **`any` types throughout** — `getDptInfo`, `getSpaceUsages`, `getParamModel` all return `any`

---

## Validation (`validate.ts`)

**Strengths:**

- Clean Zod integration
- Reusable `zIntString`/`zIntStringNonNeg` coercions

**Weaknesses:**

- **Only validates body and query, not params** — `paramId` just does `Number(req.params[name])` with no validation, returning `NaN` for invalid input
- **Returns `null` on validation failure** — this forces every route to do `const data = validateBody(...); if (!data) return;` which is easy to forget. A middleware that throws would be safer

---

## Server Entry (`index.ts`)

**Strengths:**

- Clean async startup with lazy route loading after DB init
- Good separation of concerns

**Weaknesses:**

- **`cors({ origin: '*' })`** — overly permissive, especially for a tool that can write to KNX devices
- **No rate limiting** on any endpoint
- **No error handling middleware** — if a route throws, Express will send a default 500 with no structured error response

---

## KNX Protocol (`knx-connection.ts`, `knx-protocol.ts`, `knx-usb.ts`)

**Strengths:**

- Impressive custom KNXnet/IP implementation
- Good abstraction with `KnxConnection` base class
- Clean APCI/TPCI encoding

**Weaknesses:**

- **1150-line file** for `knx-connection.ts` — should be split into CEMI, APDU, and management protocol modules
- **`'use strict'`** at the top of a `.ts` file with ES modules is redundant
- **No timeout handling** on management sessions — a non-responsive device will hang indefinitely

---

## Client Components

**Strengths:**

- `primitives.tsx` provides a nice shared UI component library
- Good use of CSS-in-JS via template strings with theme context
- Pin/window system for multi-panel detail views is well thought out

**Weaknesses:**

- **All inline styles** — no CSS modules, no Tailwind, no styled-components. This makes it impossible to use browser dev tools effectively, and every re-render creates new style objects
- **`zoom: 1.45`** on the root div — this is a hacky way to scale the UI and will cause sub-pixel rendering artifacts
- **No accessibility** — no `aria-*` attributes, no keyboard navigation beyond Alt+arrows, no focus management
- **No loading states** on most views — the `loading` flag exists in state but is only used during initial project load

---

## ETS Parser (`ets-parser.ts`)

**Strengths:**

- Handles password-protected projects with proper PBKDF2 key derivation
- Comprehensive extraction of hardware, application programs, group addresses

**Weaknesses:**

- **2855 lines in a single file** — this is the most complex part of the codebase and should be split into: ZIP handling, XML parsing, hardware extraction, application program parsing, GA parsing, and language/translation handling
- **`XmlNode`/`OrdXmlNode` are both just `Record<string, unknown>`** — the distinction is semantic only and provides no type safety
- **TODO.md confirms known bugs** in module instance `%Arg%` substitution and ref-counted activity calculation

---

## Testing

**Strengths:**

- Good test coverage across multiple domains (DPT, DB, ETS parser, protocol, API)
- Parameter UI tests for multiple device types

**Weaknesses:**

- **No CI/CD** — `.github/` exists but no workflow files visible
- **Tests require real `.knxproj` files** — the smoke test includes a real project file, making the test suite heavy and non-deterministic
- **No mock server** for client-side tests

---

## Miscellaneous

- **`package.json` says `"main": "server/index.js"` but the file is `.ts`** — misleading
- **`node_modules` and `koolenex.db` are in the repo root** — `.gitignore` should catch these but the presence of `.gitignore~` suggests gitignore issues
- **No `.env` support** — PORT is the only configurable via env var
- **No logging framework** — just `console.log` and `console.error`
- **`bus_telegrams` table has no foreign key to projects** and no cleanup strategy — it will grow unbounded
- **`ga_device_links` is marked as legacy but still created** — dead code that should be removed
