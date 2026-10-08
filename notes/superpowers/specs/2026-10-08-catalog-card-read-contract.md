---
status: active
owner: philippe
---

## Catalog display and dispatch

The catalog card list uses `GET /api/admin/routine-catalog/overview`. Each card
contains its routine/platform identity, current definition revision and digest,
title, purpose, glasses models, latest attempt, latest eligible passing recording
and nightly preference. These are the fields used by card search and links.
Steps, fixtures, executable policy and bundle references belong to routine detail.

The overview reads the same immutable published collection and definition rows as
the full catalog. It selects one collection receipt, then checks that every card
belongs to that receipt's routine/platform and definition digest. It validates the
display fields, but does not claim to verify the full definition bytes from a
partial projection.

`RoutineCatalogService.list()` remains the full catalog used by nightly selection.
`RoutineDefinitionService.current()` continues validating every complete
definition and the collection manifest digest. Routine detail keeps the full
steps and exact source references. No catalog store, cache, publication or
dispatch path is added.

Both card and full catalog use the same existing run selectors. A recorded example
must be an ordinary passing run with successful setup, teardown and published
recording; its recorded build and summary digest must match. A later failed run or
new definition revision does not erase an earlier passing example. Nightly
preferences remain keyed by routine/platform.

## Measured reason for the split

On 2026-10-08, reading 33 full definitions transferred 160.6 KB and took 2.62 s.
97 KB was step descriptions. Reading card fields from those same definition rows
transferred 15.7 KB and took 273 ms, after a 103 ms publication-receipt read.
Replacing 66 passing/latest queries with two grouped queries did not improve
latency (1.02 s versus 1.22 s), so that speculative change was not adopted.

These are authenticated read-only service/database measurements against dev,
not a claim that the changed endpoint has already been deployed.
