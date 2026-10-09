# Nightly operations

These entry points are in MentraOS `dev` and the selected private
Mentra-Automated-Testing revision. Read their current source/help before acting;
the installed worker can differ from the newest branch. Keep credentials in the
provisioned environment/configuration and private diagnostics outside Git.

## Discover access and read evidence

For a single Admin run URL or run/request ID, use
[investigate-routine-failure](../../investigate-routine-failure/SKILL.md). Its
read-only helper reuses the incident-report admin token and verifies artifacts;
no Admin browser login or new host credential is needed.

Discover the current repository guidance, installed harness CLI/help, available
connectors and provisioned Core/operator configuration before constructing calls.
Use existing credentials privately; inspect only safe endpoint/path fields and
never print tokens. A suite URL identifies its environment; do not assume prod
or today's installed source. Missing provisioned access is a specific dependency,
not a reason to require an Admin browser login or a running coordinator.

GitHub shows request/notification delivery; Core and the host controller show
device execution. Start with the suite result URL and the source workflow:

```sh
gh run view RUN_ID --repo Mentra-Community/MentraOS --json status,conclusion,headSha,jobs
```

The existing Admin API, when an admin credential is provisioned, exposes:

- `GET /api/admin/test-runs/suites/{suiteId}`: selected members and suite results.
- `GET /api/admin/test-runs/{runId}`: immutable result, definition, asset manifest
  and publication status; a queued request is not a completed run.
- `GET /api/admin/test-runs/{runId}/assets/{encodedAssetId}`: original evidence.
- `GET /api/admin/test-runs/restoration/list`: published restoration history.

Use the result's declared asset IDs, not guessed filenames. Fetch only useful
diagnostics, impose a size limit and verify declared size/digest. Read the first
failure's framework result and relevant setup/teardown journal before expanding
to a recording or command log. Prefer the available API credential over making
a Mini agent sign in to Admin. The host-authenticated `GET /api/internal/framework-results/:requestId` returns
the full run, definition, outcome and `uploadsComplete` for its authorized request.
Use the actual request ID from suite/controller receipts, not a guessed mapping
from run ID. The provisioned Core host credential can read this evidence without
Admin browser access. Read current API source/schema if a response differs.
Controller mutations use its public API/CLI within task authority.

## Targeted verification

Deployment and a new full suite are outside this skill's default scope. Reuse
accepted equivalent runs; an uncertain acknowledgement is not a reason to
redispatch. Record the actual request, exact source/build and result.

Prefer the linked API when available in the suite's environment. Check deployment
with an authenticated progress read; a merged PR or route 404 does not prove it is
ready. Internal calls require the test-run ingest capability, which differs from
the host result-reader capability. Keep both credentials in provisioned storage.

- `GET /api/internal/test-reruns/suite/{suiteId}/progress`: latest attempts and repair state.
- `POST /api/internal/test-reruns/preview`: `{rerunId,parent:{suiteId},selection:{memberIds:[...]},reason}`; alternatively selection is `{filter:{statuses:[...],excludeMemberIds:[...]}}`.
- Optional `source:{channel,buildRunId,publicationAttempt,prNumber?}` chooses a different app publication. Omit it to reuse each original exact artifact.
- `POST /api/internal/test-reruns/submit`: `{rerunId,previewDigest}` from the preview. Inspect `GET /api/internal/test-reruns/{rerunId}` after uncertainty or partial admission before retrying the same submission.
- Member history: `GET /api/internal/test-reruns/suite/{suiteId}/members/{memberId}/history`; use returned cursors for older attempts.

The manual `rerun-device-routines.yml` workflow accepts `parent_suite_id`, either
comma-separated `member_ids` or `statuses`, optional `exclude_member_ids`, `reason`,
and optional `build_run_id` with its channel/publication/PR coordinates. Blank
`build_run_id` means original artifacts. Read its current workflow inputs before
invocation. Retry the same workflow run to reconcile accepted or uncertain
admission. If the preview is conclusively unaccepted and expired, a new workflow
invocation or API rerun ID is needed for a fresh preview. Never replace an
accepted identity to bypass reconciliation. A new invocation creates a new attempt. It returns a progress link without
waiting for the full catalog. Individual API previews use the current schema in
`cloud-v2/packages/core/src/types/test-rerun.types.ts`.

Dispatch only items whose fix/prerequisite is ready. One representative can probe
a shared failure; its pass does not mark other members passed. Publication repair
retries the existing result delivery, not hardware execution. Track terminal outcome
and complete evidence separately. Use compact changed-state reads during execution;
load detailed assets only for a new failure.

If linked reruns are not deployed, keep the exact pending dispatch in the ledger
and continue source repairs. Ordinary targeted dispatch is a fallback when useful;
do not lose root lineage silently or create an equivalent duplicate when the API
becomes available.

For ordinary targeted verification, inspect the current inputs of
`.github/workflows/request-e2e-routine.yml`. The current request is:

```sh
gh workflow run request-e2e-routine.yml --repo Mentra-Community/MentraOS --ref dev \
  -f routine=ROUTINE_ID -f platform=PLATFORM -f channel=CHANNEL \
  -f source_build_run_id=BUILD_RUN_ID -f source_publication_attempt=PUBLICATION_ATTEMPT
```

`platform` is `android` or `ios-on-mac`; `channel` is `dev`, `staging` or `pr`.
For `pr`, also supply `-f pr=PR_NUMBER`. Substitute the enrolled routine and
verified publication coordinates. Adopt an existing equivalent request rather
than duplicating it. A private harness fix runs only after trusted merged-worker
activation; a label does not authorize unmerged worker code.

## Built-in authoring

When interactive verification is needed, use the built-in machine authoring job
without displacing accepted work. Prepare its diagnosis brief while members run. Read the
private harness [job guide](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/docs/ROUTINE-WORK.md),
[assigned-agent skill](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/.agents/skills/prepare-routine-work/SKILL.md)
and selected revision's `contracts/routine-work.ts`. Use the provisioned operator
connection in the harness checkout:

```sh
bun run mentra-test routine-work submit @work.json
bun run mentra-test routine-work inspect @work-id.json
```

`work.json` supplies `schemaVersion: 1`, stable `workId`, `kind: "create" | "edit"`,
`routineId`, English `brief` (`goal`, `stepsOrChanges`, `expected`), exact harness
`source`, published `build`, enrolled `target` and `requirements`. Local submissions
omit `origin`; inspect with `{workId}`. Use `edit` for an existing routine and
`create` for a new one; there is no diagnosis job type. For a causal group, name
one representative routine and include the affected original runs, evidence for
the shared cause, needed observation and any capability gap in its brief. Reuse
an existing compatible job before submitting another. Grouping does not add a
multi-routine target or authorize actions outside that job's source/build,
target and reservation; separate jobs only when distinct unresolved device work
or incompatible targeting requires them. Do not invent a patch.

The supervisor creates the workspace and machine agent, supplies its scoped
connection, and binds the job's reservation and held session. The assigned agent
uses `create-routine` and its inner `lane`/`author` commands; the coordinator does
not start a parallel reservation or session. Normal author start performs setup
once; the job agent may use `setupMode: "manual"` and returned lifecycle action IDs
when diagnosing setup. Provider subactions may still be monolithic. Report a
demonstrated adapter gap through the job and assign its shared fix; do not create
another runner or manufacture a cleanup/resume receipt. Ordinary targeted runs
remain separate and need no authoring job when the evidence supports that choice.

If the selected source is not installed, record the exact source and deployment
owner as a device-verification prerequisite. Do not mutate live candidate/release
files, controller SQLite or installation state. Source preparation, PR review
and merge continue independently. `source.enroll` and candidate installation are
not generic framework deployment operations.

## Review and merge

Read the owning repository's `codex-pr-review` skill and invoke its existing
`scripts/codex-review/codex-pr-review.sh <repo-dir> <pr-number> [extra-prompt-file]`
launcher. Follow its lifecycle, watchdog and receipt checks; never launch a bare
`codex exec` reviewer. Preserve the PR/head and canonical review receipt. A
successful process alone is insufficient: inspect whether the verdict approves
or requests changes and that it applies to the current head.

Read PR comments, review threads and required CI checks. After addressing relevant
findings, push the corrected head and run the canonical review again. Before
merge, re-read the current head, verify exact-head approval and passing required
checks, and use the normal GitHub merge operation with an expected head SHA where
supported. An uncertain merge requires reading the PR's state and merge commit
before any retry. Record approved merged PR links and merge commits in the ledger.

## Wait without losing the task

Save phase, stable IDs, next action and prerequisite in existing task state before
an asynchronous wait. Adopt accepted work on resume rather than duplicating it.
Prefer controller completion events or a durable task/thread wakeup that can
resume this owner. Verify registration with its receipt, trigger and completion
or cancellation condition. Notification-only timers, agents elsewhere and queued
outbound messages do not prove this chat will resume.

Use small terminal counts, changed failures, ownership/publication state and PR
review/check status. Expand evidence only for a changed cause or prerequisite.
For a three-hour suite, sparse five-to-fifteen-minute status checks are a reasonable
fallback when events are unavailable; adjust to actual duration and actionable
boundaries. Use supported asynchronous waits, not a multi-hour shell sleep or a
new controller runner. Keep useful independent source work moving and stay quiet
on unchanged observations. Deduplicate wakeups by stable action identity and
remove temporary monitors when the task completes or is cancelled.

If an actual external prerequisite remains, name its owner and required receipt;
track acknowledgement separately from completion. Ask only for that prerequisite
and continue unrelated diagnoses. If no verified wakeup is available, report the
capability gap with the saved resume instruction; do not claim unattended
continuation is installed or that the requested fixes are complete.
