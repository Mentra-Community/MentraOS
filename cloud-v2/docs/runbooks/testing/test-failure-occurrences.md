# Queryable routine failures and agent delivery

Core saves a failure occurrence and its pending delivery receipt **in the same `test_runs` document as the accepted result**. Recordings and logs remain in the existing `test_assets` storage. Evidence ingestion works with the AI and agent service offline; the original verdict never changes when delivery succeeds.

This is the recording/query/intake stage of automatic fixing. Case grouping, a Mini executor, assigned-worker grant issuance, PR editing, Codex review and exact-head retesting are separate stages. The existing dev-agent `agent_runs` collection remains the only analysis execution queue.

## Publisher contract

`POST /api/internal/test-runs` retains its existing ingest credential and immutable-payload check. Two fields are optional, so existing publishers remain accepted:

| Field | Meaning |
| --- | --- |
| `source` | Version1 authenticated build/request identity: trigger, source repository/channel/HEAD/branch, and PR head repository/base when applicable. |
| `failures` | Up to30 unique phase/step failures: bounded redacted message/stack, expected behavior, explicitly assigned asset and incident IDs, redaction policy and missing-evidence reasons. |

The exact schemas are `packages/core/src/types/test-failure.types.ts`. `source` must agree with the run's channel, PR number and existing source hashes. Dev/staging branches remain dev/staging. Nightly and Admin triggers retain their actual selected channel; neither implies dev. PR source can describe a staging target or fork, but recording it does not grant permission to edit it or expand routine dispatch admission.

```json
{
  "source": {
    "schemaVersion": 1,
    "trigger": "pr",
    "repository": "Mentra-Community/MentraOS",
    "channel": "pr",
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch": "fix/unpair",
    "pullRequest": {
      "number": 123,
      "headRepository": "Mentra-Community/MentraOS",
      "baseBranch": "dev",
      "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  },
  "failures": [{
    "phase": "test",
    "step": {"id": "unpair:confirm", "label": "Unpair the glasses"},
    "code": "app_crash",
    "message": "The Mentra App closed after confirming Unpair.",
    "expected": "Return to the unpaired Home screen.",
    "assetIds": ["redacted-recording"],
    "incidentIds": [],
    "redactionPolicy": "routine-diagnostics-v1",
    "missingEvidence": [{"kind": "phone-logs", "reason": "Crash log collection did not complete."}]
  }]
}
```

The authenticated publisher must redact messages, stacks and assigned assets before upload. `redactionPolicy` identifies the actual policy applied; it is not a request for Core to redact arbitrary bytes. Raw forensic assets may remain privately stored but must not appear in a failure's `assetIds`. Core never automatically forwards free-form notes, arbitrary provenance, other run assets or storage keys to the agent.

The occurrence ID is `tfo_` plus SHA256 of JSON `[runId, phase, stepId-or-null]`. Retries preserve it and any acknowledged delivery. Different real runs have different occurrence IDs. The first packet revision is1; later upload availability changes do not change its immutable source or failure identity.

A non-passing legacy result gets an `unknown` phase occurrence with explicit missing failure details. Missing `source` is exposed as `null` with a source-required reason. Neither case is sufficient for automatic edits. An old accepted row is reconciled when its exact existing payload is ingested again; this PR does not scan or rewrite historical results automatically.

## Read the evidence

| Audience | Route / scope |
| --- | --- |
| Admin | Existing `GET /api/admin/test-runs/:runId` includes `failureOccurrences`; list accepts `occurrenceId` alongside existing build/routine filters. |
| Assigned analysis reader | `GET /api/agent/test-failures/:occurrenceId` returns that occurrence, original outcome, source, safe build hashes and assigned assets with `uploaded` or `upload-pending` state. |
| Assigned artifact reader | `GET` / `HEAD /api/agent/test-failures/:occurrenceId/assets/:assetId` reuses verified asset streaming, ranges and hashes. Only assets explicitly assigned to that occurrence are available. |
| Assigned incident diagnostics | `GET /api/agent/test-failures/:occurrenceId/incidents/:reportId` and `GET` / `HEAD .../incidents/:reportId/artifacts/:artifactId`, with the same read capability. Registered reruns use `.../reruns/:operationId/failures/:failureId/incidents/...` with the continuation `read-results` grant, after the exact result binding. Only IDs in that occurrence's `failure.incidentIds` are queried. Metadata omits account, contact, context and storage data and reports each log as usable, empty, unreadable, oversized, unsupported, missing or over-limit. Artifact reads return a bounded, redacted JSON log representation whose SHA-256 matches the metadata. Every string is length-checked before redaction: overlong messages and report fields are replaced by `[OMITTED: …]` markers, never truncated. Bounded text is reviewed by single-pass scans without regular expressions, so a projection scans at most `maxEntries` × `maxMessageChars` characters and metadata, GET and HEAD stay bounded for a maximum-size bundle. Credential-like lines are replaced whole and email-like tokens are masked whole. Redaction is best-effort, so screenshots, state snapshots and other formats are not forwarded. An incident never marks the failure evidence complete. |

Agent routes require a short-lived occurrence/environment-bound read capability, not an Admin session, ingest token or general report token. `signTestFailureReadGrant` defines the controller-side format. It uses the existing action signing secret; the master secret must never reach a coding CLI. A future assigned-worker controller issues a five-minute capability only to the active owner; capabilities are not stored in cases, queue payloads or events. Reads reject expired, cross-environment and cross-occurrence capabilities. There is no agent inventory or mutation endpoint.

## Verify a harness fix for a local failure

A local Mac run may use an immutable published dev or staging app without
consuming a CI request. For that case, the publisher can record
`appActionsRunUrl` (the exact MentraOS Actions producer, optionally with
`/attempts/N`), `appExecutableSha256` and `appJavascriptSha256` in the original
run's provenance. The assigned detail exposes only the validated producer ID,
optional attempt and hashes as `build.recordedAppPublication`; this is a lookup
hint, not a claim that publication or execution was verified.

For a private harness candidate, Core still verifies the case branch, tested
harness ancestry, merged PR and exact current private main. It then resolves
only that recorded producer through the existing coordinated-release validator:
repository, workflow, source commit, dev/staging backend, publication attempt,
immutable receipt, both installed app hashes and archive availability must agree.
The same recorded routine is required. No latest-build substitution or fabricated
original CI request is allowed. A result missing this recorded proof remains
unsupported; a provenance correction does not grant this path.

The ordinary continuation request stores the local occurrence/agent/candidate
binding, the selected published artifact and expected merged harness revision.
The new request is a real dev/staging request; the original result, local source,
outcome and ACK remain immutable. Existing idempotency, attempt budget, lease
check and registered-result correlation apply, including refusal of results from
a different worker revision.

`TEST_RUN_DISPATCH_CHANNELS` and `TEST_RUN_DISPATCH_ROUTINES` still control
configured availability and return their existing refusal reasons. Registration
does not prove that a live worker is enrolled: normal runner labels, exact recipe
and worker revision, fixture admission and return checks remain required. A
missing runner can leave an ordinary request queued; this binding does not add
an enrollment API, bypass retained ownership or dispatch a device by itself.

## Deliver references to the existing queue

Delivery is opt-in, with `CLOUD_TEST_FAILURE_DELIVERY_ENABLED=true`. Other settings reuse the existing integration:

- `CLOUD_REPORT_AGENT_URL`: HTTPS controller origin.
- `CLOUD_REPORT_AGENT_SIGNING_SECRET`: existing shared action signing secret, at least32 characters.
- `CLOUD_CORE_ENVIRONMENT`: `dev`, `staging`, `prod` or `production`.

Start delivery only after the private controller's routine intake and cloud-worker exclusion filters are deployed. Missing configuration leaves every occurrence pending. Disabling delivery does not disable recording or query access.

Core's bounded background pass sends at most10 references at a time, independently of ingest, with a five-second per-request limit. Failed attempts remain pending and rotate behind untouched entries. Restart and multiple Core replicas can repeat delivery safely; the receiver must deduplicate by environment/occurrence identity.

```text
POST /internal/routine-failures
Content-Type: application/vnd.mentra.routine-failure+json
x-mentra-action-expires: <Unix seconds, five minutes ahead>
x-mentra-action-signature: <HMAC-SHA256 hex>
```

The body is serialized once with `JSON.stringify`:

```text
{schemaVersion:1, occurrenceId, revision:1, testRunId, source:null|source, environment}
```

Sign the exact UTF-8 bytes of `mentra-routine-failure-v1\n${expires}\n${body}`. No logs, artifact URLs, capabilities or device credentials are delivered. The receiver derives Core's query origin from environment.

Only this matched durable acknowledgment clears pending delivery:

```text
{schemaVersion:1, occurrenceId, revision:1, agentRunId, status:"accepted"}
```

An acknowledgment means the existing agent queue retained the reference. It does **not** mean the Mini accepted execution, a fix exists, a test passed or a case is resolved. A dropped acknowledgment is retried with the same identity and must return the same agentRunId. Conflicting acknowledgments are rejected. No retest or device command is issued by this code.

## Reviewed provenance correction of an existing occurrence

A result published without `source` stays exactly as accepted: its payload bytes, `payloadSha256`, occurrence identity, generic failure and delivery receipt are never rewritten, and Core never infers a source or backfills history. When an admin has reviewed immutable evidence that establishes the missing source, one explicit correction per occurrence can add **only** the missing source and missing diagnostic bindings, stored separately in `provenanceCorrections`.

```text
POST /api/admin/test-runs/:runId/failures/:occurrenceId/provenance-correction   (application/json, 16 KiB)
GET  /api/admin/test-runs/:runId/failures/:occurrenceId/provenance-correction   (read-only)
```

The GET returns the exact binding a reviewer must echo — `payloadSha256`, `occurrenceRevision`, the occurrence's `delivery` receipt (its acknowledged `agentRunId`), `publishedSource` — and the stored `correction` or `null`. It never writes.

```json
{
  "schemaVersion": 1, "confirmation": "add-reviewed-provenance", "environment": "dev",
  "runId": "<run>", "payloadSha256": "<accepted digest>", "occurrenceId": "tfo_…", "occurrenceRevision": 1,
  "agentRunId": "<the occurrence's acknowledged controller run>",
  "reason": "What was reviewed and why it establishes the source (20–2000 characters).",
  "source": { "schemaVersion": 1, "trigger": "local", "repository": "Mentra-Community/MentraOS", "channel": "local", "headSha": "<40 hex>", "branch": "dev" },
  "diagnostics": { "assets": [{ "assetId": "<recording>", "sha256": "<declared>", "chapterId": "<non-passing chapter>" }],
    "redaction": { "policy": "<the redaction actually reviewed for these files>", "confirmation": "reviewed-redacted-for-occurrence-access" } },
  "review": { "evidence": [{ "assetId": "<reviewed immutable asset>", "sha256": "<declared>" }] }
}
```

**Authorization.** The route uses the existing `adminAuth` gate (a Mentra console session whose email is on `CLOUD_CORE_ADMIN_EMAILS` / `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`) and records that admin's `developerId` as `reviewedBy`. That proves who reviewed it, not that the source is right; the ingest token, occurrence read grants, continuation grants and the controller signing secret cannot call it, and the Mini never holds an admin session. An approval flag is not part of the schema: any unknown key is rejected.

**What Core checks before storing it** (otherwise 400/404/409, nothing written):

- `environment` is this Core's; `runId`, `payloadSha256`, `occurrenceId`/revision and `agentRunId` are exactly the accepted result and the occurrence's **acknowledged** delivery receipt.
- The accepted payload has no `source` (a recorded source, even an identical one, is never replaced) and the occurrence has no correction. An identical retry returns the stored record (200); any different correction is 409.
- `source` passes `testFailureSourceSchema` and agrees with the immutable result: channel, repository, PR number/base, and the recorded requested head `provenance.headSha`, which must exist and equal `source.headSha` (the same head ingest binds a published source to). `mobileSourceCommit` is an independent compilation identity — a reused app keeps its original compilation commit — so it is retained separately in the packet's build hashes, never compared with the source head, and never accepted in place of a missing requested head. Plus recorded `provenance.branch`/`trigger` when present. A local run therefore stays trigger/channel `local`; it can never be relabeled as CI, Admin or a dev-channel run. The record lists `review.corroborated` fields (matched to immutable records) separately from `review.asserted` fields (for example a local run's branch), which rest on the reviewer's cited evidence.
- Every `review.evidence` asset and every added diagnostic asset is declared by the result with that SHA-256 and uploaded with the declared size and digest. An added asset must be the video or screenshot of the named **non-passing** chapter of this run, so arbitrary assets (raw logs, passing chapters) cannot be assigned. `diagnostics` is optional, but when present it needs at least one asset and an explicit `redaction` attestation for exactly those files; a Core-generated placeholder policy (`core-generated-summary-v1`, `lifecycle-allowlist-v1`) cannot attest them, and the original failure's `redactionPolicy` is kept unchanged for its original bindings. The effective failure must bind at least one diagnostic, and the original plus added bindings must still fit the unchanged failure limits that publishers and the controller's evidence readers enforce (100 asset IDs, 20 incident IDs): an overflow is refused without writing or truncating anything.
- Incident IDs cannot be added. Reports carry no authenticated association with a run or occurrence (a matching time window is not identity), so a correction never exposes an incident through an occurrence capability. Incidents the publisher assigned stay exactly as they were.

**Reads.** Without a correction every response is unchanged. With a pending or acknowledged correction the occurrence-scoped packet returns the reviewed `source`, `sourceStatus: "corrected"`, effective `failure.assetIds` (original first; `incidentIds` and `redactionPolicy` unchanged), a retained `source` missing-evidence item explaining that the publisher never recorded it, and `provenanceCorrection` (ID, digest, reason, original snapshot, additions with their redaction attestation, corroborated/asserted fields, evidence references and delivery state; no reviewer identity). `evidence.complete` stays false: a correction is not a pass or full qualification. The asset route follows the effective asset list; incident routes stay limited to the original incidents. Continuation accepts a `corrected` source under the same acknowledged-anchor check. Admin run detail lists `provenanceCorrections` separately from `failureOccurrences`.

**Delivery.** The existing delivery pass also sends pending corrections to the same controller origin, with the same secret, as `POST /internal/routine-failure-corrections`, `Content-Type: application/vnd.mentra.routine-failure-correction+json`, signed over `mentra-routine-failure-correction-v1\n${expires}\n${body}`:

```text
{schemaVersion:1, environment, occurrenceId, revision:1, testRunId, payloadSha256, agentRunId, correctionId, correctionSha256, source}
```

Only `{schemaVersion:1, occurrenceId, revision:1, correctionId, agentRunId, status:"accepted"}` naming the same correction and the original `agentRunId` acknowledges it. A controller 409 is recorded as a terminal `refused` state and reads fall back to the original packet; other failures stay pending with the same identity. The controller admits it on the existing row and anchor only while its source-required outcome is untouched; it never creates another occurrence, row, anchor or case.

## Reviewed supplemental evidence for an existing Mini case

When a launched case stops with `needs-input/missing-evidence`, an admin can add
bounded diagnostic JSON beside its immutable result. This differs from a
provenance correction: it changes no source, failure, asset, outcome, evidence
completeness, ownership or execution charge.

```text
GET  /api/admin/test-runs/:runId/failures/:occurrenceId/evidence-supplements
POST /api/admin/test-runs/:runId/failures/:occurrenceId/evidence-supplements
```

POST requires the existing admin gate and `application/json`, with body
`{confirmation:"append-reviewed-diagnostics", manifest, content:[{assetId,json}]}`.
`json` is the exact reviewed UTF-8 JSON text, not a file path or URL. The manifest
binds environment, accepted payload digest, run, occurrence/revision, acknowledged
agent run and `target:{caseId,caseRevision,sessionSha256}`, plus a review reason,
`redactionPolicy:"reviewed-harness-diagnostic-v1"` and `{assetId,sizeBytes,sha256}`
for each file. Use the existing diagnostic redactor and review the representation
before submission; the policy names that review, not an automatic guarantee that
arbitrary logs contain no secrets. Preserve capture windows and source-binding
limitations in the JSON itself.

There are at most 8 uniquely named JSON assets and 262144 bytes in total per
supplement, at most 2 supplements per occurrence, and one per exact stopped
session/revision. The request ceiling is 1 MiB including JSON escaping. The server
validates all content before writing and appends the manifest only after every
object is stored. Identical retry returns the existing supplement; a changed
retry for that stop refuses. The canonical manifest hash names `tes_<sha256>`.
Original files and published metadata are never replaced.

The existing delivery pass sends only the immutable reference, under the separate
`mentra-routine-failure-evidence-supplement-v1` signature purpose, to
`/internal/routine-failure-evidence-supplements`. An exact acknowledgement means
the controller retained it on the existing anchor, not that a model or device ran.
The companion Mini consumer admits it only through its local guardian, with exact
case/session/revision, an accepted released missing-evidence stop and unchanged
budgets. No new task, dispatcher or manual resume command is required. A stale,
held or otherwise ineligible target stays stopped.

The existing occurrence read capability reads the separate manifest at
`/api/agent/test-failures/:occurrenceId/evidence-supplements/:supplementId` and its
assigned bytes at `.../assets/:assetId`. Every turn verifies these again into a
separate supplemental snapshot. The original occurrence packet remains unchanged.
Supplement bytes never enter Mongo events or signed delivery messages. Install
the compatible Mini receiver/consumer before submitting any live supplement;
an older receiver cannot acknowledge it. This grants no new recovery capability.

## Validation

```sh
cd cloud-v2
bun test packages/core/src/services/test-run.service.test.ts packages/core/src/services/test-failure-evidence.service.test.ts
bunx tsc -b packages/core --pretty false
# Optional real Mongo atomicity checks: creates/drops only a unique test database.
TEST_FAILURE_MONGO_URI=mongodb://127.0.0.1:27017 bun test packages/core/src/services/test-failure.mongo.test.ts
```

Coverage includes AI-offline persistence, metadata-plus-intent atomic insertion, legacy replay reconciliation, unchanged failed verdicts, all trigger branch mappings, invalid provenance, scoped asset reads, dropped acknowledgments and idempotent queue delivery, plus reviewed provenance corrections: unchanged originals, idempotent/conflicting submissions, identity/source/evidence/attestation/state refusals, refused incident additions, preserved original incidents, the admin gate, the distinct delivery signature, lost and mismatched correction acknowledgments and terminal refusal. Physical devices and a running model are not needed.

The real Mongo suite checks concurrent metadata ingestion, competing acknowledgments, passing runs with no occurrence, reconciliation after a prior accepted row, and concurrent competing corrections resolving to one conditional append beside the untouched payload and occurrence. It refuses non-loopback URLs and always uses its own database.
