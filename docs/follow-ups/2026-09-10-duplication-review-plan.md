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

### 8. Eliminate `any` — done for shipped code, tests/ outstanding

`server/`, `shared/` and `client/src` are at **zero** explicit `any`, with
`@typescript-eslint/no-explicit-any` erroring on all three (it was already on
for `server/`, where the six remaining uses each carried their own
`eslint-disable-next-line`; those are gone, and `shared/` is now linted at
all, which it was not). `client/src` went from 412 to 0.

What made this tractable rather than a cast-fest: the annotations were mostly
hiding types the code already had. `projectData` is `ProjectFull`, so
`devices.map((d: any) => ...)` was discarding a `Device`. Deleting the
annotation and reading the resulting compiler errors is the method; where a
type was genuinely missing, it was defined once (`DeviceDefaults`,
`SpaceNode`, `FeedTelegram`, `ParamUIItem`, `LabelSheet`, `BusDeviceInfo`,
`FlashSegment`, ...) rather than inline.

Two boundaries needed real work rather than a rename:

- **The XML parser.** `toArr` was `(v: any): any[]`, and everything
  downstream inherited `any` from it. It is `(v: unknown): XmlNode[]` now,
  with `el(v)` for the one thing that genuinely needs asserting - that a
  child node is a node, so a walk can continue into it. 19 call sites.
- **The ETS dynamic tree.** `DynItem`/`DynWhen`/`DynTree` lived in
  `server/routes/knx-tables.ts` while the client's `paramUI.ts` walked the
  same tree as `any`. They live in `shared/ets-dyn.ts` now, and the walk
  turned up a dozen display fields the server's own type never declared.

**Still outstanding: `tests/`.** 322 explicit `any` and 50
`eslint-disable-next-line` directives, and the directory is neither linted
nor type-checked. Turning the rule on there without first bringing `tests/`
into the root tsconfig would be hollow - deleting `: any` in an unchecked
file just yields an implicit `any` nothing looks at. The prerequisite is the
one item 1 deferred: `tests/` currently reports **1097** errors under the
root config (~320 `noUncheckedIndexedAccess` nulls, ~276 implicit any, ~146
`unknown` catch bindings, ~145 argument mismatches). Do that first, then the
lint script gains `tests/` and the ban is repo-wide.

### 9. Two hand-maintained per-project table lists

`projects.ts` reimport wipes 8 tables; delete-project wipes 10. Adding a per-project table
means editing both, with nothing enforcing it. Either one `PROJECT_TABLES` const or lean on
`ON DELETE CASCADE` (foreign keys are already on, `db.ts:58`).

### 10. Import/reimport handler factory — done

`importRoute(mode)` in `projects.ts` builds both upload handlers.
`/projects/import` and `/projects/:id/reimport` differed only in resolving
and checking the project, passing its id into the job, and naming themselves
in the log line; everything else - both 400s, the 409 `IMPORT_BUSY` body, the
job creation, the immediate response and the `setImmediate` hand-off - was
the same forty lines twice.

Check order is preserved exactly, including that a reimport posted with no
file to a project that does not exist answers "No file uploaded" rather than
404. `tests/smoke.test.ts` pins that, since it is the kind of thing a later
refactor of the factory could quietly reorder.

### 11. Catalog insert exists twice — done

`insertCatalog(run, projectId, sections, items)` lives in `routes/shared.ts`
and both writers use it: `insertParsedData` (a full .knxproj import) and
`POST /projects/:id/catalog/import` (a .knxprod catalogue). The .knxprod
handler's param-model write is `saveModelsAndMasterXml(paramModels, null,
pid)` now rather than its own copy of that loop.

Noted while doing it: `CatalogSection`/`CatalogItem` exist twice under the
same names - the parsed shapes in `server/ets-hardware.ts` and the stored
rows in `shared/types.ts`, which add `project_id`. The insert takes the
parsed ones. Worth collapsing, but they are genuinely different shapes, so
it is not a rename.

### 12. Three copies of the enriched-project queries — done

`db.ts` now exports `getDevices()`, `getComObjects()` and
`getEnrichedGAs()`, and `getProjectFull()` is built from them, as are
`GET /projects/:id/devices`, `/comobjects` and `/gas`. `getEnrichedGAs`
takes an optional com-object list so `getProjectFull` reuses the rows it has
already loaded, and on its own still reads only the three columns the
device<->GA map needs rather than the full joined rows - neither call site
does more work than before.

The drift this closes is documented in `getProjectFull`'s own comment: its
hand-maintained device column list had fallen five columns behind the
`Device` interface, so a live verify result was persisted and then vanished
on the next page refresh. `tests/api.test.ts` now asserts the list routes and
`getProjectFull` return the same rows, so a re-inlined query fails the suite
(checked by re-inlining one).

### 13. `shared/address.ts` — done

`parseIA`/`parseGA`/`formatIA`/`formatGA`/`isValidIA`/`isValidGA`/`compareAddr`,
with the ranges taken from the wire format (4/4/8 for an individual address,
5/3/8 for a group address) rather than from whoever wrote each call site.

The inconsistency the review flagged turned out to have teeth.
`POST /projects/:id/gas` accepted `99/99/999`, and `encodeGroup()` did not
reject it either - it masked it into `3/3/231`, a real address, and the
telegram went there. Both refuse it now: the encoders throw rather than
write somewhere else, and the create route validates the range the
group-name PATCH had always enforced.

**Open question, deliberately not answered here.** Two-level group addresses
(`'1/2'`) are stored and displayed but have never been resolved on the wire:
`encodeGroup` pads them to `1/2/0`, while KNX means main + an 11-bit sub, so
`1/2` should be `1/0/2`. `decodeGroup` only ever produces three levels, so
the two spellings have never been reconciled. Changing the encoding changes
which device receives the telegram, so it is preserved as-is and documented
at `encodeGroup`.

### 14. `normalizeDpt` — done

`shared/dpt-key.ts` holds `normalizeDptKey()`, and both sides use it. The
review's "hoist it and delete the test" was not quite right: the two copies
agreed on the transform but differed deliberately at the edges, and still
do. The server wants `null` for "no usable key" so the decoder skips; the
client wants the input back, because `dptInfo()` resolves a bare main number
to its family's `.001` entry. Those are now thin adapters over one core
rather than two implementations.

The old consistency test passed unchanged against the refactor, which is the
evidence that nothing moved. It is kept - retargeted at the two adapters,
which is what still needs pinning - rather than deleted.

One behaviour change: the shared version trims. The server's copy did not,
so `' 9.1'` normalised to `' 9.001'` and matched nothing.

### 15. REST coverage — partly done

**Done.** The four routes that no test reached now have some:
`POST /bus/replay-frames`, `/bus/restart-device`, `/bus/read-address-by-serial`
and `/bus/read-serials-in-programming-mode` - happy path, argument
pass-through, their validation edges, and all four added to the table-driven
not-connected test. `MockBus` gained `replayFrames`, `restartDevice` and
`readIndividualAddressBySerial`, whose absence is most of why they had been
skipped.

`tests/param-validation.test.ts` covers every `:id`-style parameter, and
writing it found a real bug: the eight `router.param` validators in
`routes/index.ts` never ran, because Express scopes param callbacks to the
router that declares them and every route with an id lives in a mounted
sub-router. A non-numeric id reached the handler and `paramId()` threw a
plain Error, so the API answered **500**; and `paramId` accepted anything
`Number()` could parse, so `-1`, `1.5`, `1e3` and `' '` all passed - the
last two silently addressing project 1000 and project 0. `paramId` now
enforces digits and throws `ValidationError` (400), and the dead validators
are gone.

**Also done.** `tests/not-found.test.ts` covers every mutating route with an
id that does not exist, plus the "No fields to update" 400s. That found one
more of the same shape as item 2's: `PUT /projects/:id` ran its UPDATE
against nothing, wrote an audit row against a project that does not exist,
and answered 200 with a null body. It 404s now. The existing test had
recorded that as "silently succeeds for nonexistent ID (no 404 check)" -
a characterisation of a known gap, not a contract.

The same table shows DELETE is not uniform: devices, GAs, floor plans and
projects answer an idempotent 200, while spaces and topology 404. Both
behaviours are defensible; having both is the odd part. Pinned as-is rather
than changed, since picking one is an API decision.

Two of the four never-asserted error codes now have tests: `no_ldctrl` (a
model with no load procedures) and `ambiguous_programming_mode` (two devices
holding their buttons at once).

**Done.** `address_write_unconfirmed` and `segment_unallocated` too, which
closes item 15 and the numbered list with it. Both sit behind real-hardware
behaviour, so they are driven through the mock rather than over HTTP: the
first needs a device that never answers after its address is written, which
production waits 35 seconds for, so `runProgramDevice` takes an optional
`confirmDeadlineMs` (the seam item 6's extraction made cheap); the second
needs PID 7 reading zero, and asserts the asymmetry - a verify refuses,
while a first-ever download proceeds, because the download's own
Unload/StartLoading cycle is what allocates the segment.

## Everything on this list is done

Items 1-15 have all landed. What remains is recorded above as follow-on
rather than as part of the original review:

- `tests/` is still outside the typecheck and the `any` ban (item 8's next
  step, 1097 errors under the root tsconfig).
- Two-level group addresses on the wire (item 13).
- DELETE is idempotent-200 for some resources and 404 for others (item 15).
- `CatalogSection`/`CatalogItem` exist twice under the same names, parsed vs
  stored (item 11).
- The master-data caches are cleared on reimport, but a `.knxprod` catalogue
  import still does not save its own master XML (noted at item 11).

## A note on the line-count claims

The original review projected ~350 lines removed for item 5 and ~140 for its master-data
half. Actual: `bus.ts` net -31 against a 65-line wrapper, and settings/shared a net +14.
Item 6 was +97. The duplication is genuinely gone in each case, but the files did not
shrink - the boilerplate moved into one place rather than disappearing. Judge these by
whether there is one definition, not by the diffstat.
