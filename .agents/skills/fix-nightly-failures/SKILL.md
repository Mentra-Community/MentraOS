---
name: fix-nightly-failures
description: Diagnose an ongoing or finished Mentra nightly suite, group demonstrated shared failures, implement fixes, and carry PRs through independent Codex review and merge. Use when a chat is pointed at a nightly suite; deployment and a new full suite are separate work.
---

# Fix nightly failures

Own the source repair loop: evidence → diagnosis → fix → PR → independent review
→ required checks → merge → final report. A standalone chat can start from an
ongoing or finished suite. Do not require a continuously running coordinator.
This skill ends at approved merged fixes and diagnostic conclusions; harness
deployment, a new full-catalog suite and Slack delivery are separate tasks unless
the user explicitly adds them. A merged fix does not make the original suite pass.

## Start from the suite

Accept a suite URL, suite ID or occurrence/workflow ID, plus any branch, repository,
verification or merge constraints. Resolve these to the canonical occurrence and
stable result URL; ask only for an identifier or access genuinely needed to read
it. Discover provisioned tools, APIs and authentication using
[operations](references/operations.md#discover-access-and-read-evidence).
Do not require this chat's history, a particular host, coordinator or source SHA.

Example launch:

> $fix-nightly-failures <suite URL> — Diagnose failures while remaining
> members run, fix their owning repositories, open PRs, run codex-pr-review,
> address findings and merge after approval and required checks. Report conclusions
> and verification. Do not deploy or start another full suite.

Record the complete selected member list, status, frozen harness/definition
revisions and exact app/firmware publication. GitHub accepting a dispatch, an
active chat or successful teardown does not prove device execution or a pass.
Keep unavailable observations unknown; do not substitute today's build or copy
an old success forward.

## Preserve independent execution

Diagnose failures as they arrive and let other suite members continue. Ordinary
setup, test or teardown failures do not justify cancelling the suite. Let the
controller clean the failed run and repair its lane through normal operations;
verify the actual repair invocation, conclusion and accepted resume or
out-of-service decision. Healthy lanes continue independently.

Separate the original test outcome from later machine repair, cleanup and
publication errors. Repairing machine state does not repair source or change the
original verdict. If a global framework fault prevents useful execution,
diagnose it and use normal operations within the current cancellation authority.
Never force-release hardware, edit controller SQLite, change catalog toggles or
weaken assertions to manufacture green. Keep live source/configuration unchanged
while accepted work depends on them; this skill does not perform deployment.

## Diagnose and group on evidence

Keep one small durable ledger in existing task state: routine/run, failing
phase/step, original error and evidence links, exact provenance, classification,
causal group and supporting evidence, existing fix/job, PR/head/review, next action
and verification result. Fetch the first useful framework result and setup/teardown
journal before expanding into screenshots, recordings or command logs.

Classify app, harness, machine/fixture state or unknown on evidence. Compare the
failing source with current source before fixing it. Reuse the relevant diagnosis
mechanics in `fix-routine-failure`; this suite's completion boundary takes
precedence over that skill's deployment/rerun loop.

Group failures when evidence demonstrates the same cause in a shared provider or
action at compatible source/build and triggering conditions. Matching wording
alone is insufficient. A suspected shared cause can have one diagnosis owner,
but keep it provisional and split when evidence differs. Preserve every member's
original outcome; grouping never makes an unverified member pass.

Use one coherent fix for a demonstrated cause. Inspect existing PRs, merged fixes
and compatible authoring jobs before creating more. Do not mechanically create
one fix or job per failed routine. If the error lacks diagnostic information,
fix the bounded, redacted observation gap first. Such a PR does not prove the
original cause; do not spend hours repeating complete runs to rediscover it.

## Implement and finish the PR lifecycle

Source-only investigation and fixes need no lane or activation receipt. Work in
a clean isolated worktree from the current destination branch, retaining the
failure's channel provenance: dev → dev, staging → staging, an open PR → its
recorded repository/branch and base. Reuse existing relevant work. Keep routine
behavior in `routines/`, shared mechanics in framework providers, and ownership
or repair in orchestration. Follow repository guidance and proven actions;
avoid new compatibility paths, runners or arbitrary sleeps.

Run meaningful source checks, open a focused PR with diagnosis and validation,
and use `select-pr-routines` for applicable coverage (`bug:app`/`bug:harness` and
relevant routine labels). Documentation-only changes need no device coverage.
Use the canonical independent `codex-pr-review` skill and its existing launcher
on every opened or updated PR. Read its verdict and all relevant requested
changes; address real findings, explain evidence-backed disagreements, and rerun
review after changing the head. Do not substitute self-review or a bare reviewer
agent. See [review and merge](references/operations.md#review-and-merge).

Merge only with an approving canonical review on the exact current head and
passing required checks, under the task's merge authority. Reconcile uncertain
push/PR/review/merge outcomes before retrying. Continue this lifecycle without
asking for authorization already supplied by the task. Keep credentials, private
logs and recordings out of public PRs/comments.

## Choose useful verification

Use the smallest verification that can distinguish the cause. Strong causal
source evidence may need focused regression checks and ordinary targeted replay;
source-only fixes do not need an authoring session. When device inspection or
action iteration is genuinely necessary, reuse a compatible built-in
`routine-work` create/edit job or submit one for a representative routine with
the group's evidence and needed observation. Follow
[authoring operations](references/operations.md#built-in-authoring).

Each job names one routine and target. Distinct unresolved device work or
incompatible platform/source/build targeting can require separate jobs. The
supervisor owns its workspace, agent, scoped connection, reservation and held
session; raw author commands are inner job operations. Keep the proven prefix,
safe prerequisite state and saved action. Finish and return through the job
normally. An authoring section is not an ordinary passing run.

If verification needs merged source not yet installed, record the exact pending
deployment prerequisite and its actual owner. Continue independent diagnoses,
source fixes and PR work. Do not take over deployment or make a general
coordinator handoff a stopping gate. Required merge checks still apply; distinguish
optional deferred device evidence from a check that actually blocks merging.
A new failure returns to diagnosis, not an automatic full-suite retry loop.

## Continue efficiently through long waits

Keep a compact continuation record beside the ledger: phase, stable suite/job/PR
identities, next action, prerequisite, owner, last receipt and resume trigger.
When a prerequisite settles, perform the next authorized action in the same turn.
“Ready,” idle lanes and queued handoffs are milestones, not completion.

Do useful source work during a long suite or review, then use a supported long
poll or genuinely verified durable wakeup. Read the
[wait procedure](references/operations.md#wait-without-losing-the-task).
Consume changed-state projections; avoid repeatedly loading complete results,
logs or transcripts. Report useful changes: new diagnosis, fixed cause, review
finding, merged PR or a specific blocker and next action. Stay quiet while nothing
changes. Never claim a queued message or notification-only timer will resume this
chat. If no resume mechanism exists, report that execution gap and the saved
continuation instead of claiming autonomous completion is arranged. Use available
bounded waiting while preserving work; do not introduce a queue/timer framework.

## Report merged fixes and honest limits

Finish when each observed failure is reconciled to an approved merged fix,
already merged equivalent, evidence-backed machine/fixture conclusion, or a
specific unresolved dependency with next action and owner. Do not hide an
unresolved failure to claim completion. If members are still running, report the
observed coverage and continue via the verified resume path to consume remaining
results. Preserve concise receipts and evidence links; clean disposable owned
worktrees through normal operations. Flag any removed system without an improved
replacement for a follow-up spec. Do not delete native chat history or keep a
parallel archive of run downloads.

Final report example:

> Suite <stable link>: 28/28 members terminal; original verdict failed. Shared
> download cause: fixed in <merged PR>, approved at <head>; focused tests passed.
> Pairing: <conclusion and merged PR or unresolved dependency>. Device replay was
> not performed because <exact source> awaits deployment by <owner>. No new suite
> was started and no passing-suite claim is made. Remaining work: <specific item>.
