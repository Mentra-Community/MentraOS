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

Agent routes require a short-lived occurrence/environment-bound read capability, not an Admin session, ingest token or general report token. `signTestFailureReadGrant` defines the controller-side format. It uses the existing action signing secret; the master secret must never reach a coding CLI. A future assigned-worker controller issues a five-minute capability only to the active owner; capabilities are not stored in cases, queue payloads or events. Reads reject expired, cross-environment and cross-occurrence capabilities. There is no agent inventory or mutation endpoint.

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

## Validation

```sh
cd cloud-v2
bun test packages/core/src/services/test-run.service.test.ts
bunx tsc -b packages/core --pretty false
```

Coverage includes AI-offline persistence, metadata-plus-intent atomic insertion, legacy replay reconciliation, unchanged failed verdicts, all trigger branch mappings, invalid provenance, scoped asset reads, dropped acknowledgments and idempotent queue delivery. Physical devices and a running model are not needed.
