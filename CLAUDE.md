# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Koolenex

Koolenex is a KNX building-automation project management and visualization tool. It imports ETS6 `.knxproj` files (including password-protected ones), parses the project structure, and provides a web UI for managing devices, group addresses, bus monitoring, device programming, and floor plan visualization.

## Commands

```bash
make start          # Start both backend (:4000) and frontend (:5173)
make stop           # Stop both
make server         # Backend only
make client         # Frontend only (Vite dev server, proxies /api to :4000)
make test           # Run all tests
make lint           # ESLint for server/ and client/
make format         # Prettier for server/, tests/, client/

# Run a single test file
node --test tests/api.test.ts
```

**Pre-commit workflow:** Always run `make format lint test` before committing.

## Architecture

Three packages sharing a monorepo (no workspaces — separate `npm ci` for root and `client/`):

### Server (`server/`)
Node.js + Express backend (TypeScript, ESM). Key modules:
- **`index.ts`** — Express server, WebSocket setup, serves built client from `client/dist`
- **`db.ts`** — Pure-JS SQLite via sql.js (in-memory, persisted to `koolenex.db`). Helpers: `get()`, `all()`, `run()`, `transaction()`
- **`ets-parser.ts`** — Parses `.knxproj` ZIP files (handles AES-256-CBC encryption). Extracts devices, group addresses, parameters, topology, spaces
- **`ets-app.ts`** — Application program parsing; **`ets-hardware.ts`** — product info
- **`knx-bus.ts`** — Facade over KNXnet/IP (UDP) and USB (HID) transports; broadcasts telegrams to WebSocket clients
- **`knx-connection.ts`** — Base protocol logic (CEMI, APDU); **`knx-protocol.ts`** — KNXnet/IP tunnelling; **`knx-usb.ts`** — USB HID
- **`knx-cemi.ts`** / **`knx-dpt.ts`** — Low-level CEMI encoding/decoding, DPT buffer operations
- **`routes/`** — Modular REST routes (projects, devices, gas, bus, catalog, settings, knx-tables). All validated with Zod via `validateBody()`/`validateQuery()`
- **`log.ts`** — Structured JSON logging with tags; respects `LOG_LEVEL` env var

### Client (`client/`)
React + Vite frontend (TypeScript, JSX):
- **`App.tsx`** — Main shell, React Router v7, undo/redo system
- **`state.ts`** — `useReducer`-based state management (projects, devices, GAs, telegrams, bus state)
- **`api.ts`** — REST client (`req<T>()` helper) + WebSocket client for live telegrams
- **`views/`** — View components (locations, topology, devices, group addresses, bus monitor, programming, etc.)
- **`detail/`** — Detail panels (device info, parameters, comparison)
- **`dpt.ts`** — DPT info, formatting, i18n
- **`theme.ts`** — Dark/light theme contexts

### Shared (`shared/`)
- **`types.ts`** — Core entity types used by both server and client
- **`ga-maps.ts`** — Device↔group-address lookup maps built from com_objects

## Key Patterns

- **Validation:** Zod schemas inline in route files; `ValidationError` caught by Express error middleware
- **Logging:** `logger.info(tag, msg, data)` — tag identifies subsystem (e.g., "api", "db", "parser")
- **Database:** Foreign keys enabled; audit logging via triggers; SQLite bools as 0|1 (`SqliteBool`)
- **Routes lazy-loaded** after DB init to guarantee db availability
- **WebSocket:** Real-time telegram broadcast; demo mode can remap device addresses
- **Tests:** Node's built-in `node:test` runner with `assert/strict`. Test helper `createTestServer()` spins up Express with in-memory SQLite

## TypeScript & Lint Config

- `tsconfig.base.json`: ES2022, `nodenext` module resolution, strict mode, `noUncheckedIndexedAccess`
- Server ESLint: `eslint.config.cjs` — unused vars with `argsIgnorePattern: '^_'`
- Client ESLint: `client/eslint.config.js` — React + hooks plugin, `no-explicit-any: off`
- Prettier: single quotes, trailing commas: all

## CI

GitHub Actions runs on push/PR to main: `npm ci` (root + client), Prettier check, ESLint, `tsc --noEmit` (client only), tests.
