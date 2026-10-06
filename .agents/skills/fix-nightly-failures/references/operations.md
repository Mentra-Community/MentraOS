# Nightly operations

These entry points are in MentraOS `dev` and the selected private
Mentra-Automated-Testing revision. Read their current source/help before acting;
the installed worker can differ from the newest branch. Keep credentials in the
provisioned environment/configuration and private diagnostics outside Git.

## Discover access and read evidence

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

For targeted verification, inspect the current inputs of
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
