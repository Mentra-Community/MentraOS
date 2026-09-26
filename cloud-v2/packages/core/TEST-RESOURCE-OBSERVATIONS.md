# Local resource observations

Hosts can report what the read-only lane status saw on their local guards: the shared
Mac app guard and each phone-only Android guard. Core keeps the latest report for each
host resource and Admin shows it in **Live activity → Local resource observations**. It
sits beside CI jobs, claims and immutable results and is kept apart from them.

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
from a fixture alias. `resourceKey` is `shared` or `android-<12 lowercase hex>`, using the
existing redacted serial digest. Body identity must equal the path.

### Schema

The exact schema is in `src/types/test-resource-observation.types.ts`, and the reviewed
example payloads are in `src/types/test-resource-observation.examples.ts`. Use both as
cross-contract fixtures for the producer.

`observation` projects `readLaneStatus` exactly:

- `state` and `reason`, where every reason is allowlisted and bound to its only state
- `guard` lock and reclaim-marker status
- owner validity, PID, liveness, `retainOnExit`, reservation `{runID, fixtureID}` and
  `retainedReason`
- last checkpoint run ID, mode, phase, pending operation and pending reconciliation
- recorded fixture `checked`, `record`, `status`, `fixtureID` and `lastRunID`

Unavailable, malformed, unreadable and unknown forms are kept. The schema also rejects
contradictions that `readLaneStatus` cannot produce, such as an owner without a guard or
a reason that doesn't fit its liveness or fixture record.

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
(cd websites/admin && bun test src/pages/test-run-overview.test.tsx)
```

To run the real compare-and-set suite, point it at a plain loopback Mongo:

```bash
TEST_RESOURCE_OBSERVATION_MONGO_URI=mongodb://127.0.0.1:27017 \
  bun test packages/core/src/services/test-resource-observation.mongo.test.ts
```

The suite creates and drops its own database.
