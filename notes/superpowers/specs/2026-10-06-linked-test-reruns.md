---
status: active
owner: Philippe Ferreira de Sousa
---

# Linked test reruns with exact execution versions

Date: October 6, 2026. Current implementation scope approved; framework revision selection and framework/routine separation are follow-up work.

## Purpose and scope

Nightly suites take two to three hours. After a failure is fixed, agents and humans should be able to rerun the affected routine immediately, or select a batch, without repeating unrelated long tests that passed. Every attempt must retain the exact MentraOS CI app artifact and enrolled routine definition used. Tests use the framework installed on the selected machine; this version of the feature neither selects nor deploys framework revisions. Humans should see the repair history from the original suite page.

Provide linked individual reruns and filtered batch reruns through one execution mechanism. Reuse existing request admission, lane/resource ownership, framework results and publication services. Do not add a parallel runner, change nightly catalog preferences, deploy framework source, or rewrite an original verdict. Deployment remains a separate prerequisite service.

## Current foundation

Verified against MentraOS dev at `554529b46b0f72a5442e907dd91787765db3a5a4`:

- `.github/workflows/nightly-device-routines.yml` supports manual dispatch without selection inputs. Scheduled and manual nightlies select the entire enabled passing-example catalog. The workflow reconciles for up to three hours.
- `POST /api/internal/nightly-routines` accepts only occurrence ID, start time and nightly/manual trigger. Repeating the same occurrence reconciles its frozen requests and failed admissions; it does not create new executions of failed tests.
- `POST /api/internal/routine-dispatches` submits one routine/platform with a stable request ID and exact app build source. Retrying cannot change the routine/platform/build; the first admission freezes its enrolled definition and input.
- The internal test-runs suite API creates a declared group, binds requests and completes its receipt. It is a recording/grouping API, not a routine-list dispatcher. Its current schema requires two to 100 members and has no rerun linkage.
- Admin displays suite results and links to runs. No parent/child rerun relationship or inline attempt history exists.

Relevant source: `cloud-v2/packages/core/src/services/{nightly-routine,routine-dispatch,test-suite}.service.ts`, `types/{test-suite,framework-request,test-build}.types.ts`, and `cloud-v2/websites/admin/src/pages/test-suites.tsx`.

## User and agent workflows

1. Open a failed suite. Select an item and choose **Rerun** after its fix is ready.
2. Reuse the original exact MentraOS artifact by default, or optionally choose a different publication. Preview its resolved artifact, enrolled routine definition and lane readiness before submission.
3. Submit once. The attempt appears on the original item as queued, running, terminal or unavailable. Continue fixing other items independently.
4. Expand **Attempt history** to see the original run and subsequent attempts with timestamps, versions, results and evidence links.
5. Alternatively choose **Rerun selected** or **Rerun failed** on the suite. This creates a linked child suite containing only the frozen selected items. Long previously passing members remain untouched.

Reruns may be requested for terminal members while other original members are running. They enter normal queues and cannot displace accepted work. A running attempt cannot be rerun; a deliberate new retry requires a terminal predecessor.

## Identity and immutable provenance

Keep original suite membership and verdict immutable. Introduce a logical test item identified by its original suite/member pair, or original standalone request for a run outside a suite. Routine/platform alone is not a sufficient history identity: another suite can test the same pair independently.

Each rerun stores root item, predecessor attempt, optional parent suite, optional child batch suite, request ID, actor, reason and creation timestamp. The server assigns an ordered attempt number at acceptance, with a uniqueness constraint per root item. Run ID is populated only when execution exists. Rejected or cancelled requests remain visible attempts without fabricated run evidence.

Store requested and resolved execution identities separately from the host's observed execution receipt:

| Component | Immutable fields |
|---|---|
| App | Repository, channel/PR, source commit, build workflow ID, publication attempt, archive digest and build receipt digest; platform executable/JavaScript digests where supplied |
| Framework | Uses the existing installed machine framework. No new selection/attestation contract in this scope; preserve existing result fields when present |
| Routine | Repository, routine ID, platform and definition revision/digest actually loaded |
| Glasses/fixtures | Existing frozen firmware start/return identities and fixture/resource references, without public secrets |
| Execution | Request/input digest, run ID, host/lane, execution start/end, original outcome, cleanup and publication state |

App override is optional. If omitted, recover each original member’s exact app source from its recorded admission or nightly receipt and verify the resolved commit/archive/receipt. Missing historical provenance requires an explicit override; never silently choose latest. An override supplies exact channel/build workflow/publication attempt and resolves its immutable commit, archive and receipt once during preview. Each new rerun may choose a different artifact; transport retries of the same attempt retain its chosen artifact. Freeze current enrolled routine definition and host input at the same boundary. Do not silently substitute a newer app artifact or re-resolve enrollment on a submission retry. Preserve existing provenance in results; missing historical fields remain unknown.

### Follow-up: framework deployment and routine data

After the automatic framework deployment subsystem is available, design framework revision selection and observed installed-source attestation. Investigate separating executable framework code from routine definitions/data so updating a routine does not necessarily require deploying the entire framework. This feature adds neither that separation nor a requested framework SHA, native-tool version gate, waiting-for-framework state or deployment timeout. Existing host admission checks still apply.

## Proposed API contract

The implemented internal base is `/api/internal/test-reruns`; the Admin base is `/api/admin/test-runs/reruns`. Internal routes use existing ingest capability boundaries; Admin mutation routes use authorized Admin dispatch permissions. Both call the same service and preserve actor/audit context.

### Individual rerun

`POST <base>/individual` creates an individual preview. Then `POST <base>/submit` with its `rerunId` and `previewDigest` admits it.

```json
{
  "requestId": "repair-example-01",
  "parent": {"suiteId": "original-suite", "memberId": "original-member"},
  "predecessorAttemptId": "original-attempt",
  "reason": "Verify the reviewed caption observation fix",
  "source": {"channel": "dev", "buildRunId": 123, "publicationAttempt": 1}
}
```

For a standalone test, parent uses its original request ID instead of suite/member. The server derives routine/platform/root identity from authenticated predecessor records and freezes current enrollment through existing admission checks. Callers cannot attach arbitrary results to another item.

The response returns stable attempt/request/root/predecessor IDs, resolved execution identities, readiness, status and result/history URLs. Repeating the same request and canonical payload returns the same attempt; changing any field returns conflict. Concurrent submissions against the same predecessor admit one new attempt; others receive the accepted attempt identity and a conflict. An explicit subsequent attempt must name that new terminal predecessor.

### Filtered suite rerun

`POST <base>/preview` takes `rerunId`, `parent: {suiteId}`, `reason`, optional `source`, and `selection`. `POST <base>/submit` takes `rerunId` and `previewDigest`.

Provide a stable `rerunId`, reason, execution selection and exactly one selection form:

- `memberIds`: explicit nonempty original member list.
- `filter`: terminal statuses, optionally narrowed with an `excludeMemberIds` list.

Default UI “Rerun failed” selects test, setup and teardown failures. Not-run, rejected, cancelled and incomplete are separate selectable categories, not silently included. Passing members may be explicitly selected for affected regression coverage. Duplicate/unknown member IDs, contradictory selection forms, nonterminal members or an empty resolved selection are rejected with an actionable message. Maximum selection is 100.

Resolve filters once against the original suite's immutable member results, then persist the exact list and exclusion rationale. The child contains only selected members and links to its parent. Each child member also joins the original item's attempt history. A one-member selection is valid and uses the same batch/history model; do not create a fake second member to satisfy today's schema.

Freeze the batch and deterministic per-member request identities before queue admission. A partial admission failure retries only the same pending members, without reselection or duplicate runs. If a selected item already has an active rerun, return a conflict naming it; do not silently mix existing and newly selected attempts. An optional app override applies to every selected member of that batch, resolving platform artifacts independently. Without an override, each member retains its original app artifact.

### Manual trigger

Keep scheduled nightly selection unchanged. Add a separate manual GitHub workflow
for linked reruns with `parent_suite_id`, either `member_ids` or `statuses`, optional
`exclude_member_ids`, optional replacement app build workflow/publication coordinates and reason. It calls the same preview/submission service and saves the
frozen selection/acceptance receipt as an artifact. Re-running the GitHub job
reconciles its existing rerun ID; a new dispatch creates a deliberate new attempt.
No catalog preference edits are needed.

Admin and authenticated agents can use the API directly, so verification can
start as each fix is ready without waiting for a batch workflow. A general new
suite from arbitrary routine/platform pairs can later reuse this selection and
admission service, but is outside the first linked-rerun delivery.

### Read and preview

Provide bounded, paginated attempt history per root item, child rerun suites per parent, and a compact progress projection through a compact polling endpoint. A preview resolves selected members, app artifact and enrolled definition and readiness without admitting work. Submission validates the stored preview digest. Preview expires after ten minutes; create a new rerun ID after expiry. A transport retry uses the existing ID and digest.

No pending framework installation state is introduced. If existing host/enrollment admission refuses a routine, preview returns the actual prerequisite; agents continue independent work. Compact progress and bounded paginated history support sparse polling without full logs.

## UI and result semantics

The original suite header always shows its original verdict, build and completion time. Add a separate repair summary: **8 originally failed · 5 passed on rerun · 1 running · 2 unresolved**. This is repair progress across attempts, not a newly passing full suite or proof that earlier passing tests work on newer source.

Rows show **latest attempt status**, app version, enrolled definition revision and attempt time; retain an **original: failed** label and link. While a newer attempt is queued/running, show that current status; prior outcomes remain in expandable history. Use attempt acceptance order, not finish time, to choose latest; late result arrival cannot reorder history.

History expands inline and is paginated. Each entry links to its exact run/request evidence and displays its app artifact and definition identity for comparison. Child suite pages link back to the original; the original lists child suites. Run detail pages link to predecessor, root item and containing batch where applicable.

A later failure makes the latest repair status unresolved again; an older passing rerun cannot conceal it. Publication incomplete is distinct from test execution failure. Every batch verdict summarizes only that batch's selected attempts. Historical original passes are never copied into a new exact-version suite aggregate.

## Acceptance criteria

- From a 28-member original suite with 20 passes, rerun its eight unsuccessful items without submitting any of the 20 passing members. Original results remain byte-for-byte unchanged.
- Individual reruns are dispatchable as fixes become ready and appear on the original row with inline history.
- Exact app artifact and enrolled definition inputs remain frozen on retries; existing host source/capability checks remain enforced.
- No framework revision selector, deployment gate or framework/routine separation is introduced.
- Lost acceptance responses, partial batch admission and repeated requests reconcile existing IDs. Concurrent duplicate submissions do not execute twice.
- One-member batches work; unknown, empty, duplicate and nonterminal selections fail before admission.
- Late completion, rejected admission, cancellation and incomplete publication remain visible and do not corrupt latest-attempt ordering or original verdicts.
- Existing standalone runs and suites remain readable without invented historical provenance.
- API tests cover selection/idempotency/provenance; UI tests cover history controls, artifact identity and repair-vs-original summaries.

## Current defaults

“Rerun failed” includes test/setup/teardown failures and excludes not-run/rejected/cancelled/incomplete unless selected. Explicit passing-item selection is allowed. Latest-attempt rows retain original verdicts. Framework waiting expiry is deferred with framework deployment selection.

No runtime system is deleted. Existing nightly scheduling, catalog preferences, request execution, ownership, restoration and publication remain the foundation. Framework revision selection and framework/routine data separation are explicitly deferred follow-ups.

Implemented reads: `GET <base>/:rerunId`, `/suite/:suiteId/progress`, `/suite/:suiteId/children?before=<id>`, `/suite/:suiteId/members/:memberId/history?before=<attempt-number>&limit=<1..25>`, `/request/:requestId/history`, and `/request/:requestId/lineage`. History uses descending attempt number and preserves the original result separately.
