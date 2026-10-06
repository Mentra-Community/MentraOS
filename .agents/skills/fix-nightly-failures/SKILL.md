---
name: fix-nightly-failures
description: Diagnose and fix Mentra nightly test-suite failures while independent members continue, choose targeted manual runs or held authoring for verification, and deliver the next full-catalog suite result. Use for recurring nightly failures or a red nightly suite; individual assigned failure cases use fix-routine-failure.
---

# Fix nightly failures

**Keep tests independent and make each iteration informative.** Own the suite,
failure diagnoses, reviewed fixes and final result. A green source check, repaired
lane or passing individual routine is progress; none is an all-passing nightly.

Use the existing `fix-routine-failure`, `create-routine` and `codex-pr-review`
skills for their respective work. Read [operations](references/operations.md)
when fetching evidence, dispatching or submitting authoring work; use the
current checked-out APIs rather than old temporary scripts or invented flags.

## Let the current suite finish

Record the occurrence, stable suite URL, complete selected member list, frozen
harness/definition revisions and exact app/firmware publication. Check actual
member results and executor/repair receipts. GitHub accepting a dispatch, an
active chat or successful teardown does not prove a test ran or passed.

An ordinary setup, test or teardown failure must not cancel the other members.
Let the controller clean the failed run, check the lane and invoke its state
repair agent if necessary. Verify real invocation, the repair conclusion and
accepted resume or out-of-service decision, then the next independent run.
Keep the original verdict. State repair does not fix app/harness source.

Keep installed harness source and shared configuration unchanged while accepted
work depends on them. Do not take resources from another owner or displace
accepted suite work. Healthy lanes continue independently of a lane in repair.
If a global framework fault prevents useful execution, diagnose that specific
fault and coordinate a safe interruption through normal controller operations;
do not cancel a whole suite merely because it is red. Respect the current
cancellation authority and never force-release hardware or edit its database.

## Diagnose failures as they arrive

Keep one small durable failure ledger in the task's existing coordination state:
routine/run, failing phase/step, original error, evidence links, exact provenance,
classification, causal group and supporting evidence, named owner,
PR/head/review, next action and verification result.
Mark an unavailable observation unknown; do not copy an old success forward.

Fetch the original logs, screenshots, recording and setup/teardown diagnostics.
Separate the original failure from subsequent cleanup and publication errors.
Classify app, harness, machine/fixture state or unknown on evidence. Compare the
failing source with current source before deciding it needs another fix.

Group failures when evidence demonstrates the same cause in a shared provider
or action at the recorded source/build, with compatible triggering conditions.
Matching error text alone is insufficient. A suspected shared cause may use one
owner to collect the missing observation, but keep the grouping provisional and
split it when evidence differs. Keep every member's immutable original outcome,
provenance and evidence; grouping never makes an unverified member pass.

Use one diagnosis owner and coherent fix for a demonstrated causal group. Check
existing PRs, merged fixes and authoring jobs before opening another; link them
from the same ledger and reuse work that covers the cause and target. Avoid one
fix or authoring job per failed routine when the same work resolves the group.

If the saved error omits the information needed to diagnose it, fix that
diagnostic gap first. Preserve the original cause, phase and action; add bounded,
redacted context sufficient to explain the refusal or failure. A diagnostic PR
does not establish the original cause or make its routine fixed. Do not spend
hours repeating complete runs to rediscover an error that can be made visible.

Develop source-only fixes and meaningful regression checks in parallel while
the suite runs. Give each owner an isolated workspace and clear file/subsystem
scope. Keep routine behavior in `routines/`, shared mechanics in framework
providers, and ownership/repair in orchestration. Reuse proven actions and the
porting guide; avoid new compatibility paths, runners or arbitrary sleeps.

Fix the owning repository, retain the failure's source/channel provenance and
use `bug:app` or `bug:harness` plus relevant routine labels. Every PR creation or
push needs the independent `codex-pr-review` skill verdict on its exact head;
address real findings and required checks before merging under the task's merge
authority. Source tests and review remain separate from device verification.

## Choose the shortest useful verification

Verify at the relevant lane's normal ownership boundary without displacing
accepted suite work; unrelated members may continue. Harness activation through
the existing path additionally requires every accepted request, executor and
reservation depending on the replaced source/shared configuration to settle;
an idle lane alone does not permit replacing live installed source. Publication
custody and admission budgets remain enforced. Use reviewed merged harness code
and the selected PR/channel artifact for app fixes. Do not silently substitute
today's newest build for the failed build.

Choose the smallest useful verification for each causal group, using judgment:

| Evidence and remaining work | Next action |
| --- | --- |
| Focused fix with strong causal evidence and a high likelihood of passing | Manually dispatch the smallest set of affected routines that exercises the shared cause through ordinary orchestration; no authoring session needed |
| Available logs/source are insufficient and device inspection or action iteration is needed | Reuse a compatible built-in `routine-work` create/edit job, or submit one for a representative affected routine with the group's diagnosis and exact source/build |
| Insufficient logs, missing artifact/capability or genuine access gap | Fix the observation/prerequisite or ask for the specific missing input; do not invent a pass or repeatedly retry |

Keep separate device jobs when distinct unresolved device work or incompatible
routine/platform/source/build targeting requires them. A grouped diagnosis does
not change the job API: each job names one routine and target. Record which
members a verification actually covers and what remains for the full catalog.

The built-in job supervisor owns the workspace, machine agent, reservation and
held session. Follow the harness [job guide](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/docs/ROUTINE-WORK.md)
and [assigned-agent skill](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/.agents/skills/prepare-routine-work/SKILL.md).
The assigned agent inspects or executes the failing saved action from its safe
prerequisite state, keeping the owner, recorder and proven prefix. Retry with a
concrete reason instead of reinstalling and repeating the whole flow. Raw author
commands are inner job operations, not an alternative coordinator runner. Use
the same saved action replay will use. Finish and return through the job normally;
authoring sections are not full-run results. A new failure returns to diagnosis,
not an automatic full-suite retry loop.

## Close with the whole catalog

Consume every targeted run's exact-source result, cleanup and published evidence.
When the fixes are ready, manually trigger a new dev nightly through the normal
nightly path; do not wait for its scheduled time. Use all enabled catalog entries
and frozen build selection. Do not exclude failures, weaken assertions or accept
missing/not-run members to manufacture green.

Verify the terminal suite lists every selected member, their actual outcomes
and required published evidence. The coordinator checks the hosted Admin page
and useful recordings, and verifies the real final `#dev-builds` Slack send
receipt. A notification failure retries notification delivery after reconciling
its original send; it must not rerun tests or duplicate an uncertain message.

Deliver the stable suite link, tested build, member counts and Slack result.
Report an incomplete/failed suite and remaining owners honestly. Preserve small
receipts and necessary failure context, then let normal cleanup dispose of owned
run payloads and remove retired review/fixer worktrees. Do not delete native
Codex/Claude history or retain a parallel archive of old run downloads.
