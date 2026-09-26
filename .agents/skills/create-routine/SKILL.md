---
name: create-routine
description: Create or extend a Mentra automated testing routine, from English steps and assertions through local development, shared lifecycle integration, registration and CI qualification. Use when adding test coverage or authoring routines in parallel. To request an existing routine on a PR, use select-pr-routines instead.
---

# Add a testing routine

**Author the routine in the private [Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing). Register its `routine:<id>` label in MentraOS so people and agents can request it on a PR.**

This skill is the entry point from MentraOS. Keep harness implementation, device
configuration and recordings in the private testing system.

| Stage | Deliverable |
| --- | --- |
| Define | User behavior, required state, steps and observable checks |
| Implement | A flow using the existing lifecycle, driver and evidence helpers |
| Develop | Recorded local run tied to the exact harness source and app build |
| Register | Reviewed worker support and matching MentraOS catalog entry |
| Qualify | CI result with playback, assertions and verified return state |

## 1. Find the closest routine

Read the [routine catalog](../../../.github/scripts/device-routines.mjs). Follow
its revision-pinned definition and implementation links to understand existing
coverage. Extend an existing routine when the new behavior belongs in its flow;
create an ID when the behavior needs independent selection, resources or setup.

Work in a separate private-repository worktree. Use current `main` for new work
unless the task specifies another base; record that source revision. Catalog
links describe the published definition and may precede the current source.
If private access is missing, prepare the brief below and report that dependency;
do not recreate the private harness in MentraOS.

In the selected private revision, use `docs/ROUTINE-AUTHORING.md` and
`templates/routine-brief.md` when present. Read the closest working flow and
platform adapter before choosing commands. Authoring and development tools can
arrive separately from their documentation: verify the checkout's supported
entry point and help rather than assuming a command is implemented.

## 2. Define what a pass means

Write a short brief before selectors. Resolve choices from the request and
existing routines; ask only for missing product expectations that matter.

| Decision | Record |
| --- | --- |
| Identity | Routine ID, platform and user behavior it proves |
| Inputs | Exact selected PR/dev/staging build and its artifacts; OTA manifest when applicable |
| Resources | App, account, phone/glasses, browser, network or audio devices actually required |
| Starting state | Required app/account/pairing state and, for glasses routines, software versions |
| Return state | Usable state to leave behind, verified against this run's selected build |
| Steps | Stable ID, English action, expected result and observable assertion for each step |
| Evidence | Recording, screenshots, logs or device checks needed to substantiate the result |
| Limits | Prerequisites and behavior this routine does not exercise |

The next job establishes its own starting state. Teardown need not predict that
job's versions: reuse the selected build's return target, check the actual state,
and restore only what differs. A successful test may already satisfy it.

Declare the account needed, then use the platform's runtime account loader and
the worker recipe's account reference. Reuse its secret-input and report-redaction
helpers. Keep passwords out of routine definitions, prompts, request JSON and
evidence. Provision separate accounts for concurrent authenticated sessions.
Account files belong to host configuration, outside Git; credential rotation
must also refresh any pinned copy/reference used by that worker.

## 3. Reuse the lifecycle

Compose **setup → test → final checks → cleanup → return verification** using
the existing platform lifecycle. Mac flows use the `Step` contract in
`tools/mentra-e2e/runner/suite.ts`; use the corresponding Android adapter for
Android execution. Reuse artifact preparation, fixture ownership, progress,
recording, incident submission and result publication.

- Put an observable outcome after each meaningful action. A click succeeding
  does not establish navigation, media delivery or a firmware update.
- Prefer existing stable selectors and state-based waits. Add a shared driver
  capability only when the routine cannot express its behavior with current ones.
- Preserve the original failed assertion when cleanup succeeds. Capture the
  failure and submit its incident through the shared path before cleanup loses
  useful app state. Route product defects to
  [fix-routine-failure](../fix-routine-failure/SKILL.md).
- Keep one owner for a shared harness defect. Other authors can continue their
  independent flows instead of adding per-routine workarounds.

## 4. Develop with recorded evidence

**Before the first complete pass, iterate from usable live state rather than
restarting the routine after every fix.** Preserve the failed observation and
retry the failed step or smallest dependent section. Do not repeat downloads,
installation, OTA preparation or an already-passed prefix merely because a later
step changed. Re-establish only prerequisites that changed or are no longer
proven. Keep the existing ownership and command-completion rules: an unanswered
writer needs reconciliation, and owned recorders still need confirmed cleanup.

Run focused checks for the changed flow/helper and the relevant typecheck. Use
the supported development entry in the selected private revision for hardware
iteration. Preserve the exact harness snapshot, selected app artifacts, steps,
assertions, recording and cleanup outcome with the result. Inspect playback and
the failure evidence, not just the process exit code.

Label section runs **development evidence**, recording their starting state,
executed steps and ending state. Do not combine successful sections into a full
pass. Once the flow works, perform one clean recorded end-to-end qualification
against the exact source and build. Normal CI and nightly runs retain their full
setup, assertions, teardown and verified return state.

Check the selected revision's actual commands. The development CLI introduced in
private [PR #105](https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/105)
still wraps `run` in setup and Home cleanup; `recover` reconciles the original
execution, not a failed-step retry. Neither provides live-state continuation.
Until a reviewed continuation entry exists, state that tooling gap and continue
source work; do not invent step/range flags or repeatedly use the full lifecycle
as a substitute.

Separate worktrees allow parallel authoring; execution still uses shared resource
ownership. Independent Mac and Android fixtures can run together. Routines using
the same app, glasses, account or network/audio configuration must coordinate.
Use the existing worker's admission and cleanup; do not clear another run's lock,
change global enrollment or invoke a legacy runner to bypass an unavailable
development entry. Continue source work while that dependency is resolved.

Local development proves the tested snapshot. It is not a CI qualification of a
different revision or platform.

## 5. Register, review and qualify

1. Open the private routine PR with the brief, focused validation and recorded
   development result. Run the [Codex PR review skill](../codex-pr-review/SKILL.md)
   for PRs created or updated and address its findings.
2. Trace the closest routine through the private worker's supported IDs/dispatch
   and MentraOS request/Admin selection. Add the new ID wherever required. In
   [device-routines.mjs](../../../.github/scripts/device-routines.mjs), provide
   coverage, platform, prerequisites, exclusions and links pinned to the reviewed
   private implementation. Coordinate the private worker rollout before public
   requests can reach the new ID; a label alone cannot make it executable.
3. Ensure the exact `routine:<id>` label exists in MentraOS. Catalog registration
   does not create it. Check with `gh label list --repo Mentra-Community/MentraOS
   --search 'routine:gallery'`; inspect the exact name. Only if absent, create it:

   ```bash
   gh label create routine:gallery --repo Mentra-Community/MentraOS \
     --color 0E8A16 --description 'Request the registered gallery routine'
   ```

   Substitute the actual registered ID. Preserve existing labels and their
   settings; do not use `--force` to overwrite them.
4. Once registered and admitted by the worker, request the routine against an
   exact existing build. Use [select-pr-routines](../select-pr-routines/SKILL.md)
   to append its label to a relevant PR, or use Admin for a selected PR/dev/staging
   artifact. For example, after `gallery` is registered:

   ```bash
   gh pr edit PR --repo Mentra-Community/MentraOS --add-label routine:gallery
   ```

5. Check the resulting run: tested build and harness revision, assertions,
   recordings, duration, failure/incident details and verified return state.
   Report pending or failed qualification explicitly. Registration does not
   automatically opt the routine into dev/staging defaults or nightly schedules;
   change those only when included in the task and after qualification.

Finish with the routine ID/label, covered behavior, implementation PRs and exact
qualification result or remaining gap. Public PRs should link approved result
pages; keep credentials, private logs and raw recordings out of their bodies.
