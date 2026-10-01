# Maintain the Admin routine catalog

Open **Routine catalog** in Admin, or use `/?routineCatalog=1`. It lists only
full routines remade on the shared setup/test/teardown foundation with a
published passing example. The broader issuer and dispatch registries also
contain older and unfinished routines; membership there is not sufficient.

The small, typed content list is
[`routine-catalog-data.ts`](../../../websites/admin/src/pages/routine-catalog-data.ts).
The page derives its cards from that list and its manual-dispatch filter from
entries with an explicit request binding. Local-only routines have no request
label and do not enter the dispatch selector. It reuses
the existing dispatch controls and authenticated result/video viewer; there is
no new backend catalog or playback path. Server-side build compatibility,
channel configuration, worker enrollment and admission still decide whether a
request can run. See [manual dispatch](admin-routine-dispatch.md).

## Update an entry

1. Read the current private authored flow and shared setup/cleanup composition.
   Keep purpose, software, account, network, physical setup, test data, cleanup
   and exclusions in plain English. Do not copy credentials or host paths.
2. Check the exact published result through the existing authenticated
   `GET /api/admin/test-runs/:runId` API. Confirm its routine and platform,
   complete authored flow, passing test and teardown, ready fixture, complete
   evidence and uploaded video. Inspect the video in the result viewer.
3. Record the result ID, date, app version/build, release, app SHA and recorded
   device/fixture identity. Preserve its original environment in the result
   link. The viewer retains full source and artifact hashes.
4. Check the result's qualification scope. A development working-tree pass must
   remain labelled **Development pass**. It does not prove a CI candidate,
   another platform, runner enrollment or nightly scheduling. Do not replace
   an example with a smoke run, failed result or unrecorded assertion.
5. Update the entry when behavior or prerequisites change. Add a new platform
   as a separate entry only when its full passing evidence exists. Update the
   scoped render test when the supported set intentionally changes.

The initial four examples were verified on 2026-09-30 against dev Core. Each
reported `qualificationScope: local-development`, `ciQualified: false`, a
passing test and teardown, `fixture: ready`, and `evidence: complete`; each
recording responded to a byte-range request. Their app source is
`d6c74c857015fac95fbc6195dbf009acfab65eeb` (`3.3.0-dev.468`). They preserve distinct
harness working-tree identities in the result viewer and are not exact-head
qualification of a private harness PR.

Relevant private source paths are `tools/mentra-e2e/flows/no-glasses.ts`,
`tools/mentra-e2e/runner/android-walkthrough.ts`,
`tools/mentra-e2e/flows/captions-phone.ts`,
`tools/mentra-e2e/flows/notes-phone.ts`, and the shared compositions in
`worker/local-mac.ts` and `worker/local-android.ts`. These paths are maintenance
pointers, not substitutes for recorded passing evidence.

The Android ASG roundtrip example is
`local-android-bda5a7fd-f862-458d-8cd6-3a239a06e999`, started September 30, 2026
at 23:00:32 PDT. Its clean merged harness source is
`453378be4cd3593484a3f5703dc25d2e536bb932`; requested app source is
`6c51cd313686151a95a6a7810444926d39d6c97d` (PR 4356, app 3.2.1 / 302014623).
All six authored steps, final assertions, teardown, independent return
verification and evidence passed. The 15m26s recording, six screenshots,
chapters, lifecycle summary and six firmware/gallery checkpoints were uploaded
to dev Core; the original payload was disposed after acknowledged publication.
All 21 gallery files were preserved, and the `mini-060b` fixture was released
ready. This is local-development coverage, not CI qualification. The Mac
coordinator verified the authenticated hosted result and playback, including
changing video frames and step seeks at downgrade 5:08, requested upgrade 12:18
and return 14:14, recorded in PR 4369 comment 5926175951. The result displayed
all six passed steps, passing test/teardown, ready fixture and complete evidence.
The recording covers the authored test; setup and teardown have separate
lifecycle evidence rather than being part of that video.

Its private maintenance paths are `tools/mentra-e2e/flows/ota-roundtrip.ts` and
`worker/local-ota-android.ts`. A nightly request requires an executable enrolled
adapter and the exact routine ID wired through request validation and dispatch;
do not add a label or advertise automatic execution based only on this example.

## Check the UI

From `cloud-v2`:

```sh
bun --no-env-file test websites/admin/src/pages/routine-catalog.test.tsx websites/admin/src/pages/test-dispatches.test.tsx websites/admin/src/pages/test-runs.test.tsx
bun --no-env-file x tsc --noEmit -p websites/admin/tsconfig.json
bun --no-env-file run --cwd websites/admin build
```

Open the catalog at desktop and narrow widths, expand the requirements, and
check that manual controls list only the catalog entries. Do not send a real
device request just to verify the catalog UI.
