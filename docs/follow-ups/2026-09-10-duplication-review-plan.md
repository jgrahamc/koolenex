# 2026-09-10: duplication / maintainability / REST-coverage plan

**Status: working plan and running record.** Started from a read of the whole codebase on
2026-09-09 answering "suggest improvements that would reduce duplication, improve
maintainability and increase rest coverage". This file is the plan itself plus what has
actually landed against it - the items are numbered as they were in the original review, so
the numbers in commit messages ("item 5, part 1") point back here.

## Done

| # | What | Commit |
|---|------|--------|
| 1 | Root `tsconfig.json` over `server/` + `shared/`, `make typecheck`, CI step. Caught its first bug immediately: `ets-app.ts` set `verify:` on an `LpWriteRelMem` that had no such field, so the parsed value was dropped. | `1be98b6` |
| 2 | Three routes taking both a `:pid` and an entity id looked the entity up by id alone - another project's row was really deleted/updated, with the audit entry written against the wrong project. | `1be98b6` |
| 3 | `shared/ets-dyn.ts` (the ETS `when test` predicate, which had four near-identical copies) and `client/src/detail/paramUI.ts` (the parameter-UI walk, which five test files each re-implemented and then asserted against their own copy). | `1585dba` |
| 4 | `server/app.ts`'s `createApp()` - the Express app was built three times, each with its own error middleware, so the largest test file asserted the copy's status codes rather than the server's. Also fixed `isLocalOrigin` never matching IPv6 loopback (`URL.hostname` keeps the brackets). | `9733840` |
| 5a | `cachedMasterData()` + `masterDataRoute()` - five master-data lookups shared a six-line preamble and five byte-identical route handlers. | `d48239d` |
| 5b | `busRoute()` - `requireBus` + validation + error mapping, 18 of 27 bus routes. A disconnected bus had **four** different status answers across the file; it is 409 everywhere now. | `c8a1c05` |
| - | Master-data caches were never invalidated: a reimport into an existing project id rewrites `knx_master_<id>.xml`, and all five endpoints served the previous import's data for the life of the process. Found while doing 5a. | `0719ed2` |
| 6 | `loadProgrammableDevice()`, `runProgramDevice()`, and `runVerifyDevice()` returning `{status, body}` instead of writing to `res`. The two programming routes also looked devices up by id without scoping to the project - the same hole as item 2, in the two routes that write to real hardware. | `4ad7f7b` |
| 7 | `client/src/deviceColumns.ts`, and dropping the `any` annotations from the five biggest views. That turned up four real defects, including LocationsView collapsing on numeric ids against a set that persists string ones. | `2531b70` |

## Remaining

### 8. Eliminate `any`

Item 7 took the five biggest views from 130 explicit `any` to zero, and every one of those
annotations was hiding a type the code already had - `projectData` is `ProjectFull`, so
`devices.map((d: any) => ...)` throws away a `Device` TypeScript had all along. Four real
defects fell out of five files. The rest of the codebase deserves the same pass.

Where it stands:

- **`client/src/`: 347.** Concentrated in `detail/PinDetailView.tsx` (48),
  `detail/DevicePinPanel.tsx` (40), `detail/DeviceParameters.tsx` (28),
  `views/FloorPlanView.tsx` (25), `diagram.tsx` (24), `views/PrintLabelsView.tsx` (20),
  `detail/paramUI.ts` (17). The detail panels are the priority - they are where device and
  com-object shapes get read field by field.
- **`server/` + `shared/`: 8.** Small enough to finish in one pass.
- **`tests/`: 322**, which is also why `tests/` is still outside the root tsconfig (item 1
  scoped it out at ~766 errors, nearly all `any` params and `noUncheckedIndexedAccess`
  indexing in test bodies).

The end state, in order:

1. Work file by file in descending count, deleting the annotation rather than replacing it
   with a hand-written type - the contextual type is usually already correct, and what
   fails to compile afterwards is the interesting part. Where a real type is genuinely
   missing, define it once (as `DeviceDefaults` and `SpaceNode` were) rather than inline.
2. Prefer a helper over an annotation for the recurring cases: catch bindings are `unknown`
   (`errMessage`/`errCode` in `api.ts`), and column-id lookups are genuinely dynamic
   (`field()` in `columns.tsx`).
3. Once `client/src` is clean, turn `@typescript-eslint/no-explicit-any` on in
   `client/eslint.config.js` (it is `off` today), so the count cannot grow back.
4. Then bring `tests/` into the root tsconfig and CI's `tsc --noEmit`, which is what item 1
   deferred.

Expect this to find bugs rather than merely satisfy the compiler; budget for the fixes.

### 9. Two hand-maintained per-project table lists

`projects.ts` reimport wipes 8 tables; delete-project wipes 10. Adding a per-project table
means editing both, with nothing enforcing it. Either one `PROJECT_TABLES` const or lean on
`ON DELETE CASCADE` (foreign keys are already on, `db.ts:58`).

### 10. Import/reimport handler factory

`projects.ts` - the two handlers are ~95% identical: file check, project lookup,
`importBodySchema`, IMPORT_BUSY check, `createJob`, log, respond, `setImmediate`.

### 11. Catalog insert exists twice

`catalog.ts` duplicates the `catalog_sections`/`catalog_items` insert loops in
`projects.ts`, and the paramModels-write loop duplicates `shared.ts`'s
`saveModelsAndMasterXml`. `projects.ts` already exports `insertParsedData` for exactly this
reason.

### 12. Three copies of the enriched-project queries

`db.ts:getProjectFull` re-implements the GA enrichment from `gas.ts`, the com-objects join
from `gas.ts`, and the device ordering from `devices.ts`. The comment at `db.ts:634`
documents a live bug caused by exactly this drift; the fix applied there (`SELECT *`) did
not remove the duplication.

### 13. `shared/address.ts`

Individual/group address parsing and formatting is scattered across 15+ places in client and
server with ad-hoc `Number()` and `.split()`. Would also settle the inconsistency that
`POST /projects/:id/gas` accepts `99/99/999` while `PATCH .../gas/group-name` enforces
0-31/0-7.

### 14. `normalizeDpt`

Deliberately duplicated (client `dpt.ts` vs server `bus.ts`), with
`tests/normalize-consistency.test.ts` existing purely to keep the two equal. **Check before
moving**: the two have since diverged in name and signature (`normalizeDpt` vs
`normalizeDptKey`), so this is no longer the simple hoist the original review described.

### 15. REST coverage

Still-untested routes: `POST /bus/replay-frames`, `/bus/restart-device`,
`/bus/read-address-by-serial`, `/bus/read-serials-in-programming-mode`. (`/rtf-to-html`,
catalog import and the floor-plan POST have gained tests since the review.) `MockBus` in
`bus-routes.test.ts` has no `writeMemory`, `replayFrames` or `restartDevice`, which is what
keeps three of those out of the table-driven not-connected test.

Then, in order of value: a table-driven test for `router.param`'s 400 on non-numeric
`:id`/`:pid`/`:did`/... (eight identical handlers, none asserted, and the test would let
them collapse into a loop); 404/400 pairs for every CRUD `PUT`/`DELETE`/`PATCH`; and the
never-asserted error codes (`address_write_unconfirmed`, `ambiguous_programming_mode`,
`no_ldctrl`, `segment_unallocated`, ...).

## A note on the line-count claims

The original review projected ~350 lines removed for item 5 and ~140 for its master-data
half. Actual: `bus.ts` net -31 against a 65-line wrapper, and settings/shared a net +14.
Item 6 was +97. The duplication is genuinely gone in each case, but the files did not
shrink - the boilerplate moved into one place rather than disappearing. Judge these by
whether there is one definition, not by the diffstat.
