# Local resource observations

Hosts can report what the read-only lane status saw on their local guards: the shared
Mac app guard and each phone-only Android guard. Core keeps the latest report for each
host resource. Admin shows one card per reported lane at the top of **Live activity →
Test lanes**, and the full guard wording under **Technical details**. It sits beside CI
jobs, claims and immutable results and is kept apart from them.

This is attributed reporting only. It is not a CI claim or execution grant, and it is not
a lease, a readiness verdict or proof of hardware control. There is no API to clear, reclaim,
cancel or recover anything. Claims, results and their CI return semantics are unchanged.

## Worker API

Both routes use the existing `TEST_RUN_INGEST_TOKEN` (`Authorization: Bearer ...`). No
new account, grant or configuration is involved. Responses are `Cache-Control: no-store`.

- `GET /api/internal/test-resource-observations/:hostId/:resourceKey` returns the current
  record, or `{revision: 0, observation: null, receivedAt: null, progress: null}`.
- `PUT` on the same path takes a strict version-one body of at most 16 KiB:
  `{schemaVersion: 1, hostId, resourceKey, expectedRevision, observation, progress?}`.

`hostId` is an explicitly configured ID (1–80 of `A-Za-z0-9_-`). It is never derived
from a fixture alias. `resourceKey` is `shared`, `android-<12 lowercase hex>` (the
existing redacted serial digest), or `glasses-<12 lowercase hex>`: one physical glasses
pair's lease, keyed by the first 12 hex of its existing lease key (sha256 of its eMMC CID).
A pair lease names its run, never a phone. Body identity must equal the path.

### Schema

The exact schema is in `src/types/test-resource-observation.types.ts`, and the reviewed
example payloads are in `src/types/test-resource-observation.examples.ts`. Use both as
cross-contract fixtures for the producer.

`observation` projects `readLaneStatus` exactly:

- `state` and `reason`, where every reason is allowlisted and bound to its only state
- `guard` lock and reclaim-marker status
- owner validity, PID, liveness, `retainOnExit`, reservation `{runID, fixtureID}` and
  `retainedReason`
- for the `shared` guard only, the valid owner's optional `glassesScope`: `none` (a verified
  no-physical claim), `identified` (the owner holds its own pair lease) or `unknown` (every
  glasses pair is excluded). `none` and `identified` require the owner's reservation. Older
  producers omit it; Core stores their observation unchanged and Admin shows it as unknown,
  never as `none`. A retained `none` owner still holds Mac UI, audio and recorder custody
  and may still require recovery; the scope admits and releases nothing
- for the `shared` guard only, optional `glassesLeases`: the per-glasses leases that host's
  shared app acquisition refuses on, read with the same reader at this observation —
  `none`, `held` (`pairs`: up to 16 sorted unique 12-hex lease digests, `others`: the count
  of further held entries) or `unreadable`. It is exclusion only and names no owner, run or
  phone. Older producers omit it, which means not reported
- last checkpoint run ID, mode, phase, pending operation and pending reconciliation
- recorded fixture `checked`, `record`, `status`, `fixtureID` and `lastRunID`

Unavailable, malformed, unreadable and unknown forms are kept. The schema also rejects
contradictions that `readLaneStatus` cannot produce, such as an owner without a guard or
a reason that doesn't fit its liveness or fixture record.

Deploy a Core that accepts `glassesScope` before any producer sends it: the earlier
strict schema rejects the unknown key, so a newer producer's PUT to an older Core is
refused (400) and stored nowhere. Older producers keep working against the newer Core.
The same order applies to `glasses-*` resource keys and `glassesLeases`: deploy this Core
and Admin first, then the producer that reports them.

These are rejected: `scopeCovers`, checkpoint `note`, `caveats`, any extra key, paths,
tokens, environment, raw logs, errors, free text and device timestamps. Admin supplies fixed
wording for every observation field. The only labels anywhere in the body are the existing
bounded, control-character-free step and action labels in optional `progress`.

`progress` is optional. It is the existing claim progress projection plus `runId`, which
must equal the observed owner's reservation run ID.

### Ordering

1. GET the current revision.
2. Take a fresh `readLaneStatus` observation.
3. PUT that observation with `expectedRevision`.

A 409 means the snapshot is stale. Discard it, because only a later fresh observation may
be sent. Core increments the revision and sets `receivedAt` itself. If the exact same
request is retried after it succeeded, Core returns the stored record with
`applied: false`. `receivedAt` does not change. Any different body at a stale revision
conflicts. Device clocks are never used for ordering.

Within one run, the committed journal `sequence` orders progress:

- A higher sequence replaces the stored checkpoint.
- A lower sequence keeps the newer stored checkpoint.
- The same sequence with different content is rejected (409).
- A refresh without progress keeps the same run's checkpoint.
- A different owner run, or no owner, never inherits the previous checkpoint.

Writes use majority, journaled write concern. Mongo `test_resource_observations` has one
row per `{hostId, resourceKey}`, and startup creates its unique index before serving.

## Admin display

### Test lanes

Every `{hostId, resourceKey}` that has reported is one card. The stored rows are the lane
inventory: hosts are never hardcoded, and a host that has not reported (for example a
development MacBook without `MENTRA_E2E_REPORT_HOST_ID`) is not shown. Admin derives each
card from the overview response Core already returns; the API is unchanged.

| Card state | When |
| --- | --- |
| Recovery required | A retained guard (any age: a dead PID, a completed checkpoint or a newer report never clears it; only the owner's verified recovery releases it), or a current report whose fixture record is `recovery-required` or `busy` without an owner. |
| Running | A live owner in a report from the last 2 minutes, and either its run's latest step is unfinished and was received within 2 minutes, or its exact reserved request is a GitHub job in progress and the latest step has not completed. The latest step is the highest journal sequence from host or CI claim progress, never the latest arrival; a repeated sequence keeps its first receipt time. |
| Reserved, idle | A current report of a live owner without recent step progress. |
| Blocked | A current Mac lane report with no shared owner whose `glassesLeases` are held: the shared acquisition refuses until those pair leases are released. |
| Available | A current report with no owner and a fixture recorded ready, or a glasses pair with no lease (its readiness is separate). Admission still runs its normal checks. |
| Not ready | A current report with no owner whose fixture record is uncommissioned, missing, malformed, unreadable or not checked. |
| Offline or unknown | Any other state (including unreadable `glassesLeases`), and every report older than 2 minutes that is not a retained guard. Fresh CI progress never refreshes a stale host report; it is shown as separate CI activity. |

Glasses pair cards follow the same rules for their own lease. A phone and a pair on the
same host are shown together only when both current reports show live owners with the
identical reservation run and fixture, as one lifecycle holds both. Otherwise a phone card
says a held pair on its host is not reported as used with it, and a held pair says no phone
is reported with it. A phone's own lock is taken per command, so between commands the phone
card is truthfully free while the pair and Mac lane cards show the hold.

The card itself stays short: host and lane, state, the work holding the lane (routine and
build, taken only from the CI job or claim with the owner's exact reserved request ID, else
parsed from that ID with "build details not reported"; other run IDs are local sessions),
the current step only while its own progress is recent and unfinished, the last report age,
a plain blocker, who is responsible, the next action, and the queue. Its closed **Lane
details** hold the resource key, run ID, worker and GitHub run link, owner PID and
liveness, glasses scope, the last reported step with its own receipt age, the last
lifecycle checkpoint (labelled historical; a newer report never makes it current), the
fixed guard wording and the host heartbeat command.

The holder is named only as reported: a CI run when the owner's reservation is a CI request ID,
a local session for any other reserved run ID, and "a live process that reported no run"
(host operator) when the owner has no reservation. A recovery card's next action names the
recorded pending lifecycle step (`pendingReconciliation`, else `pendingOperation`) when the
observation carries one. The observation carries no other recovery detail, so a manual
action outside the lifecycle (for example a host permission check) is not shown.

The queue counts queued or waiting CI requests of the lane's platform (`shared`: iOS on
Mac, `android-*`: Android) on lanes whose own guard or fixture record names a CI request.
GitHub assigns runners, so the card does not claim the lane will take them. Requests
without a platform are counted separately. A completed CI job, a GitHub job without the
guard owner's exact request, an open app or a missing GitHub job never makes a lane
running or available.

An idle lane stays current only if its host keeps reporting. The private
`lane-status.ts --publish --interval-seconds N` (10-60 s) repeats the normal report as a
heartbeat. Without it, an idle lane shows as offline or unknown two minutes after its
last report.

### Technical details

- Each row shows host, scope (shared Mac UI/audio/all glasses, or one independent Android
  phone), observed owner and run, liveness as observed, pending lifecycle step and
  progress, Core receipt age, and fixed reason, responsibility and next action.
- An observation is current for 2 minutes after Core received it. A stale live owner is
  **unconfirmed**, not a running job. A stale no-owner row is **not current**.
- A fresh snapshot without a guard owner is **No owner observed**. It is never "ready" and
  never evidence of the current build or firmware. Recorded fixture state is context and
  does not admit a routine.
- A retained hold stays visible until the host reports a newer observation. Age, a dead
  PID or a `complete` checkpoint never clears it. The overview reads owner-held rows
  separately, so newer idle reports cannot displace them.
- A run ID is linked only when Core has a published result with that exact ID. Other run
  IDs are shown as text. Results are never matched to hosts by fixture alias.
- A missing, failed or empty feed is shown explicitly. The existing fixture table is
  renamed **Latest CI return evidence after resolved follow-up**. It is still historical
  CI evidence, and its outcomes are unchanged.

## Validation

From `cloud-v2`:

```bash
bun test packages/core/src/services/test-resource-observation.service.test.ts \
  packages/core/src/services/test-run-overview.service.test.ts
(cd websites/admin && bun test src/pages/test-run-overview.test.tsx src/pages/test-lanes.test.tsx)
```

To run the real compare-and-set suite, point it at a plain loopback Mongo:

```bash
TEST_RESOURCE_OBSERVATION_MONGO_URI=mongodb://127.0.0.1:27017 \
  bun test packages/core/src/services/test-resource-observation.mongo.test.ts
```

The suite creates and drops its own database.
