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

## Verified dev nightly examples

The five examples from dev nightly `nightly-36957839762-1-dev` passed on
October 1, 2026 using dev.551, app source
`f48a6c59f06665dd41924670434f47d359be0eb3`. The suite finished in 35m7s;
all members passed test, teardown and return checks, published their evidence,
and disposed of their run payloads. The coordinator verified hosted playback
and chapter navigation for every recording. The green `#dev-builds` summary
received a Slack acknowledgement.

[Open the completed suite](https://admin.dev.mentraglass.com/?testSuite=nightly-36957839762-1-dev).

| Routine | Published result | App build |
| --- | --- | --- |
| Mac walkthrough | `routine-36957913744-1-dev-no-glasses` | 303000125 |
| Android walkthrough | `routine-36957913815-1-dev-no-glasses-android` | 310000349 |
| Captions phone mode | `routine-36957913823-1-dev-captions-phone` | 303000125 |
| Notes phone mode | `routine-36957914136-1-dev-notes-phone` | 303000125 |
| Android downgrade / upgrade on hotspot | `routine-36957913879-1-dev-ota-roundtrip-android` | 310000349 |

These are actual nightly results, not proof that another build or trigger will
pass. The hotspot routine is enrolled for dev nightly; its manual and PR
requests remain disabled. Request bindings and nightly enrollment are separate.

Private maintenance paths include `tools/mentra-e2e/flows/`,
`worker/local-mac.ts`, `worker/local-android.ts` and
`worker/local-ota-android.ts`. The recording covers the authored test;
setup and teardown have separate lifecycle evidence. Updates over external
Wi-Fi need a separate routine. The OTA example preserves the `mini-060b` gallery
and returns to the requested software.

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

## Connected-glasses software coverage

The Android example `local-android-59a30e48-e849-4416-983c-83e222f25cdc`
passed all 58 saved software actions on October 1, 2026, with passing teardown,
return checks and complete evidence. Its 62 uploaded assets include two recording
segments; the coordinator verified playback and seeking in both. The brief gap
protects Wi-Fi password entry. Local payloads were disposed after publication.

This is a development pass for pairing, reconnection, settings, software capture,
gallery delivery and playback routing. It does not prove acoustic delivery or
scene recognition. The card has no request binding until shared dispatch is
verified; its nightly enrollment needs its own full dispatched qualification.
Private maintenance paths are `worker/local-connected-android.ts` and
`tools/mentra-e2e/flows/connected-glasses-program.ts`.
