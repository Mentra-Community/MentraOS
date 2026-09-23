# Request a recorded routine from the admin dashboard

The **Recorded routines → Run routine** controls select an existing published
Mac build. They do not compile an app or send commands to a device. A request
goes through the trusted `request-e2e-routine.yml` workflow on MentraOS `dev`,
then the existing private GitHub queue and worker claims.

The first supported dispatch sources are open same-repository PRs targeting
`dev`, with `no-glasses` or `day1-ota`. A label is not required for an explicit
admin request. Dev and staging build inventory uses the coordinated release
plan and Apple download receipt; dispatch for those channels remains disabled
until the coordinated issuer and private worker source adapter are deployed.

## Deployment configuration

Configure these values on the **Core deployment**, never in the browser bundle:

- `TEST_RUN_DISPATCH_GITHUB_TOKEN`: a GitHub credential with Actions write and
  pull-request/contents read on `Mentra-Community/MentraOS`. Core can dispatch
  only the fixed request workflow on `dev` through this API. Use a dedicated
  fine-grained credential or installation token and manage its rotation.
- `TEST_RUN_PRIVATE_READ_TOKEN`: optional Actions read on
  `Mentra-Community/Mentra-Automated-Testing`. It enables queued/running job
  visibility; it grants no private repository dispatch access.
- `TEST_RUN_DISPATCH_CHANNELS`: comma-separated enabled sources. Default `pr`.
  Set `pr,dev,staging` only after the trusted issuer and private worker support
  coordinated source requests. Merely changing this variable does not add that
  support.

The public callback still uses its existing `E2E_PRIVATE_DISPATCH_TOKEN` GitHub
secret. The worker still uses separate `TEST_RUN_CLAIM_TOKEN` and
`TEST_RUN_INGEST_TOKEN` capabilities. Admin sessions use the existing Mentra
login and `CLOUD_CORE_ADMIN_EMAILS`/domain authorization; worker tokens cannot
browse or dispatch from this UI.

Use one shared Core claim authority across the fleet. This dashboard must point
to that deployment to show the worker's claims and results. The **source build
channel** is independent of the **evidence/claim Core deployment**: selecting a
staging app does not silently migrate results into the staging database. Do not
create independent claim authorities for workers competing for the same fixtures.

## Local commands

From `cloud-v2`, load the normal private Core environment plus the configuration
above, then run `bun --no-env-file packages/core/src/index.ts`. Start the admin
against that Core:

```sh
bun --no-env-file run --cwd websites/admin build
CORE_URL=http://127.0.0.1:3000 HOSTNAME=127.0.0.1 PORT=5174 bun --no-env-file websites/admin/src/index.ts
```

Core startup creates the unique `test_dispatches.dispatchId` index before
serving requests. Do not skip startup migrations. These commands use the normal
database configuration; keep any local Mongo binding on loopback only.

## API and exact selection

All routes are behind `/api/admin` and the existing admin authentication gate:

- `GET /test-routines`: supported routine descriptions.
- `GET /test-builds?channel=pr&pr=4148`: the current PR's recent build runs.
- `GET /test-builds?channel=dev` or `channel=staging`: recent coordinated builds.
- `POST /test-dispatches`: submit the selected immutable publication.
- `GET /test-dispatches`: recent submission receipts.
- `GET /test-dispatches/:dispatchId`: current workflow/claim/result status.

Example POST shape (illustrative IDs and digest):

```json
{
  "source": {"channel": "pr", "prNumber": 4148, "buildRunId": 123, "publicationAttempt": 1},
  "routineId": "no-glasses",
  "archiveSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "idempotencyKey": "ad616c04-c5e5-4dcd-b7c4-d9d4a626166d"
}
```

The API accepts no repository, ref, URL, device command, worker selection or
configuration path. It revalidates the exact build before dispatch. The issuer
and private worker validate the source independently again. Inventory checks
publication identity, receipt metadata, the OTA release identity and archive
size; the issuer performs the complete receipt, notarization and OTA-target
checks. An available inventory entry can therefore still produce `no-artifact`.
For PRs, a stale
head/base, missing artifact, closed PR or incompatible routine remains
unavailable. Published release builds retain their immutable source revision
instead of pretending to be the latest branch tip.

## Status, idempotency and evidence

GitHub is the queue. Mongo `test_dispatches` stores only the requested inputs,
admin identity and the durable send acknowledgement. One acknowledged insert
permits one outbound request; duplicate submissions with the same key read the
existing receipt. Reusing the key for different inputs or another admin fails.
An interrupted or ambiguous send is not automatically retried. Preserve its
submission ID and reconcile the GitHub workflow before requesting a replacement.

“Requesting”, “queued” and “running” are distinct from a device test result.
The final display uses the shared claim's result ID and verifies that the result
belongs to the selected archive. A finished job or terminal claim alone cannot
produce a passing result. Failed tests, recovery requirements and incomplete
uploads remain visible. The existing recorded-result viewer, authenticated
media routes, English chapters and separate teardown/evidence verdicts are reused.

The dashboard downloads only bounded JSON metadata and the issuer's small,
digest-verified request ZIP. The request ZIP may contain only `request.json`.
It never downloads or executes the app archive. GitHub credentials are not
forwarded to signed artifact-download URLs.

## Validation

```sh
bun --no-env-file test packages/core/src/services/test-builds.service.test.ts packages/core/src/services/test-dispatch.service.test.ts packages/core/src/services/test-run.service.test.ts packages/core/src/services/test-run-claim.service.test.ts websites/admin/src/pages/test-dispatches.test.tsx websites/admin/src/pages/test-runs.test.tsx
bun --no-env-file x tsc -b packages/core --pretty false
bun --no-env-file x tsc --noEmit -p websites/admin/tsconfig.json
```

These are offline service and rendered-component checks. Real PR dispatch and
device/video evidence remain separate qualification steps. Do not use an offline
fixture or successful workflow submission as evidence of a completed device run.
