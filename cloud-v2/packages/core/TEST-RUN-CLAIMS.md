# Shared device request claims

This API reserves one immutable request across workers. It is not a queue,
hardware authorization, fixture lock or test result. Keep the registered worker's
trust/admission checks, local durable claim and app/fixture ownership. The server
does not authenticate GitHub requests or prove the caller's physical worker ID;
only the trusted fleet controller/launchers receive its capability.

Configure a separate random `TEST_RUN_CLAIM_TOKEN` of at least 32 characters and
send it as `Authorization: Bearer ...`. Missing/short configuration disables the
API (503). This token does not grant result ingestion or admin access. Keep it
out of PR jobs. The worker's private execution token below is a separate secret.

The types in `src/types/test-run-claim.types.ts` define the strict JSON contract.
IDs use the existing bounded test-run ID syntax; hashes/tokens are 64 lowercase
hex characters. Bodies are limited to 4 KiB. Responses are `Cache-Control: no-store`.

## Claim exactly once

Before sending, durably save the request identity, a new execution ID and a
cryptographically random 32-byte execution token on the selected worker. Do not
regenerate these for a retry or move them to another worker. `requestSha256` is
the SHA256 of the authenticated immutable request bytes under the fleet's agreed
canonical encoding; all workers must use the same encoding.

`POST /api/internal/test-run-claims`:

```json
{
  "requestId": "routine-123-1-4136-day1-ota",
  "requestSha256": "64-lowercase-hex-characters",
  "workerId": "lab-mini-1",
  "fixtureId": "fixture-1",
  "executionId": "fresh-durable-execution-id",
  "executionToken": "64-random-lowercase-hex-characters"
}
```

Only **201 plus `executionGranted: true`** grants this invocation its initial
execution. It follows a majority-acknowledged, journaled Mongo insert behind a
unique request ID index. The response contains `claim`: the five identity fields,
`state: "claimed"` and server `claimedAt`. Save the grant before installation or
device actions. No response contains the execution token or its stored digest.

- Exact replay returns 200, `executionGranted: false`, and the original claim.
  This does not authorize resuming or restarting, even for the original owner.
- Reusing the request ID with a changed hash, worker, fixture, execution ID or
  execution token returns 409. Ownership never changes.
- Timeout, disconnect, malformed response or 5xx is ambiguous. Start no device
  work and do not automatically retry the claim. The insert may have committed.
  Unknown server outcomes return 503 with `error: "claim_outcome_unknown"`.
- Other non-201 responses never grant execution. Validation/authentication
  failures (400/401/413, or unconfigured 503) do not enter the claim service.

`GET /api/internal/test-run-claims/:requestId` returns
`{executionGranted:false, claim}` or 404. A missing record is not an execution
grant and cannot prove an earlier in-flight write will never commit. Reading an
existing claim never reconstructs a lost grant. Reconcile an ambiguous invocation
using the saved ownership and local evidence; do not dispatch it to another Mac.

## Record settlement without releasing the request

`PUT /api/internal/test-run-claims/:requestId/state` requires the original private
execution token and one settlement:

```json
{"executionToken":"original-token","settlement":{"state":"terminal","resultRunId":"run-1"}}
```

or `{"executionToken":"original-token","settlement":{"state":"recovery-required","reason":"Claim acknowledgement was lost; no hardware started"}}`.

The first settlement atomically changes `claimed` to the supplied state and adds
server `settledAt`; it returns 200 with `executionGranted:false`. The exact same
settlement can be replayed to reconcile a lost acknowledgement without changing
its timestamp. A different settlement returns 409; a wrong execution token
returns 403. Both terminal states remain permanently reserved. There is no
transition back to claimed, recovery-clear, expiry, delete, reassignment or replay
endpoint. Unsettled claims are also reserved indefinitely. A crashed owner may
leave `claimed`; operationally treat that unresolved state as requiring recovery.

`terminal` means the trusted caller recorded a terminal lifecycle result, not that
the test passed or the fixture is ready. `resultRunId` is a reference, not an
assertion that uploads have completed. Recovery authorization and later result
generations remain in the existing local lifecycle/results systems; they do not
replace this original settlement or permit a fresh execution of the request.

## Close a released recovery-required claim

`PUT /api/internal/test-run-claims/:requestId/closure` lets the original owner
record, after the fact, that a `recovery-required` request is resolved. The body
is the owner's frozen claim request (the five identity fields and its private
`executionToken`) plus one `closure` (`testRunClaimCloseRequestSchema`). Two
closure kinds are supported:

- `android-refused-install-released`: Android completed a refusal of the
  in-place update, and the reviewed release appended
  `setup-abandoned-after-refusal` directly after the original first terminal.
- `preflight-abandoned-released`: preflight failed before setup, with zero
  mutation operations. The original owner's release appended
  `preflight-abandoned` directly after the original first terminal. This kind
  also states `operations: 0`.

Both kinds pin that terminal's sequence and SHA256, the journal prefix, the
release event SHA256, its reviewed revision and implementation SHA256. Both state
`fixture: "uncommissioned"`, and `selectedCandidateInstalled`, `candidateTestRun`
and `recordingStarted` as `false`. A release type must match its kind. Unknown
fields or other values return 400.

The first closure is stored in a separate `closure` field with server `closedAt`.
The claim, its settlement, token digest and progress are unchanged, and the
response is `{executionGranted:false, claim, closure}`. An identical body replays
the stored closure, so a lost acknowledgement is retried with the same body. A
wrong execution token returns 403. Changed identity fields, an unsettled or
`terminal` claim, and a different closure return 409. A closed claim does not
accept newer progress. Claim, GET and settlement responses keep their shape.

A closure is not a result, a recovery generation or a readiness check. Admin
removes the request from active and blocked work. The request stays in fixture
history with its failed result, and that fixture stays unverified until newer
evidence. The dispatch detail reports it as `failed`, not as passed, and its
message and Admin reason describe the closure kind.
The private harness commands that publish these closures are documented in the
Android no-glasses routine guide and the Day1 local worker guide.

## Persistence and validation

Mongo `test_run_claims` is separate from `test_runs`: results intentionally allow
several run IDs per request for recovery. Core startup awaits the unique claim
index before serving. Claim writes use majority+journal acknowledgement; reads
use primary/majority. There is no TTL or automatic cleanup. Backup/restore must
preserve this collection: losing claim history invalidates duplicate prevention.
This API does not replace a fixture lease or serialize different request IDs that
target the same app or glasses.

Run `bun test packages/core/src/services/test-run-claim.service.test.ts` from
`cloud-v2`. Opt-in Mongo tests use `TEST_RUN_CLAIM_MONGO_URI=mongodb://127.0.0.1:PORT`
and `bun test packages/core/src/services/test-run-claim.mongo.test.ts`; they reject
remote/authenticated URLs and create/drop their own uniquely named test database.
No worker registration, queue, deployment or hardware execution is enabled here.
