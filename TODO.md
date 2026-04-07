## Architecture

- [ ] **Client-side router** — App.tsx manages views via `state.view` string and a custom `navHistory` stack. URLs never change, so no bookmarks, no shareable links, no native browser back/forward. Replace with react-router or TanStack Router to get real URLs like `/projects/3/devices/1.1.2`.

- [ ] **API service layer** — Components import `api` directly and call fetch. No way to mock for tests, no caching, no request deduplication. Add a context-based service layer or TanStack Query.

- [ ] **Split App.tsx** (~1600 lines) — Currently manages theme, DPT mode, i18n, undo/redo, all CRUD handlers, sidebar, keyboard shortcuts, WebSocket, and renders the entire shell. Break into providers (ThemeProvider, I18nProvider, UndoProvider), shell (Sidebar, TitleBar), and route-level components.

- [ ] **Split ets-parser.ts** (~2800 lines) — ZIP handling, XML parsing, hardware extraction, application program parsing, GA parsing, and translation handling should be separate modules.

- [ ] **Split knx-connection.ts** (~1150 lines) — CEMI framing, APDU builders, and management session protocol should be separate modules.

## Client

- [ ] **No memoization** — Every `PATCH_DEVICE`/`PATCH_GA` creates a new `projectData` object, causing full re-renders. `buildGAMaps` runs O(n) over all com objects on every `PATCH_COMOBJECT`. Use `useMemo`/selectors.

- [ ] **All inline styles** — No CSS modules, Tailwind, or styled-components. Every re-render creates new style objects. Browser dev tools can't inspect classes.

- [ ] **No accessibility** — No `aria-*` attributes, no keyboard navigation beyond Alt+arrows, no focus management.

- [ ] **No loading states** on most views — The `loading` flag exists in state but is only used during initial project load.

- [ ] **`zoom: 1.45`** on root div — Hacky UI scaling that causes sub-pixel rendering artifacts.

- [ ] **No optimistic update rollback** — If an API call fails after dispatch, the UI is out of sync with the server.

- [ ] **No request deduplication** — Two components calling `api.getProject()` simultaneously fire two identical requests.

## Server

- [ ] **`cors({ origin: '*' })`** — Overly permissive, especially for a tool that can write to KNX bus devices.

- [ ] **No rate limiting** on any endpoint.

- [ ] **No management session timeout** — A non-responsive KNX device will hang the management session indefinitely.

- [ ] **bus_telegrams has no cleanup strategy** — Table grows unbounded. Needs max row count or TTL-based pruning.

## Database

- [ ] **Migration version table** — Current approach uses `ALTER TABLE` with try/catch. A proper version table would track which migrations have run and fail explicitly on errors.

- [ ] **JSON columns have no validation** — `parameters`, `param_values`, `model_translations` are TEXT with no schema enforcement at the DB level.

## Infrastructure

- [ ] **No CI/CD** — No GitHub Actions workflow.

- [ ] **No `.env` support** — PORT is the only env-configurable value.

- [ ] **No logging framework** — Just `console.log`/`console.error`.

## Parameter memory image gaps

- [ ] **Module instance `%Arg%` substitution** — ETS's `S4vcapiLPUB` replaces `%Arg1%`-style tokens in `<ParameterRef InitialValue="...">` with actual module argument values before comparing against defaults. We don't do this substitution, so module-instance parameters (repeated channel templates) may be incorrectly classified as default/non-default. Most likely cause of the 10 DIM devices' 35 diffs at 0x1f9/0x1fb/0x200.

- [ ] **Ref-counted activity calculation** — ETS uses reference counting (`NormalRef` + `ValueAssignReference` counters) to determine parameter activity. A parameter is only inactive when ALL references deactivate. We do a single boolean reachability walk of the dynamic tree instead. This gives wrong results when a parameter appears in multiple `<When>` branches — one branch deactivating shouldn't deactivate the parameter if another branch still references it.

- [ ] **`DownloadBehavior` per device** — The `ApplicationProgram` element can have `DownloadBehavior="DefaultValue"` (send inactive params with defaults), `"None"` (skip inactive params), or `"Background"` (normal). We don't check this attribute and always skip inactive params. Some devices may expect their inactive params to be explicitly set to defaults.

- [x] **0x0000001c RelSeg format** — RESOLVED. Not a header — `0x0000001c` is literal parameter data. Blob is zero-padded to declared Size, no 0x03 prepend, paramShift=0. Previous WzEn-style 0x03 prepend was wrong for these devices.

- [ ] **AbsoluteSegment devices** — Devices using `LoadProcedureStyle="ProductProcedure"` with `AbsoluteSegment` (e.g., Zennio KLIC-DI, mask MV-0701) have parameters at fixed memory addresses, not relative segments. `buildParamMem` only handles the RelativeSegment path. These devices show "No writable parameter memory" despite having 60+ parameters with valid offsets. Need to support `LdCtrlAbsSegment` + `A_Memory_Write` to absolute addresses.
