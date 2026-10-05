---
name: create-routine
description: Create, edit or port a Mentra automated testing routine with English requirements, saved actions verified during authoring, and deterministic replay through the shared framework. To request existing coverage on a PR, use select-pr-routines instead.
---

# Create, edit or port a routine

Routines should be **fast, reliable and easy to create or edit**. Keep English
instructions, observable expectations and executable actions together in the private
[Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing).
Read its [porting guide](https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/main/docs/ROUTINE-PORTING.md)
when migrating old coverage; it links the deleted source and explains what to reuse.

## Put the behavior in the routine

Inspect the selected harness revision's `routines/`, `framework/` and controller
schemas. Start from the closest routine for the platform and glasses. Preserve
proven product actions and fixtures; replace old executor/ownership wrappers.

| Location | Responsibility |
| --- | --- |
| `routines/<id>/routine.ts` | Export `createRoutine(state)` using `defineRoutine` and `step`; English metadata, product setup/steps/teardown and fixtures |
| `framework/drivers/` | Shared interactions and recorded observations; Mac uses `executeMacStep(action, context)` with the supplied `context.ui` |
| `framework/platforms/`, `framework/glasses/` | Composed platform and glasses lifecycle providers |
| `framework/authoring/`, `orchestration/` | Held sessions, jobs, lane ownership, repair and publication |

Declare platforms, entry (`home` or `sign-in`), account, requirements, fixtures,
stable ordered step IDs, `glasses.models` and required capability IDs in `requires`.
Keep device identities, secrets and tool paths in private lane configuration.
Confirm the installed lane offers those capabilities. Add a reusable provider once
for missing shared functionality; do not hide host setup in product steps.
No routine-name branches in workers, dispatch or catalog, and no hardcoded videos:
source enrollment discovers definitions; published passing runs supply examples.

## Hold one session and verify the saved actions

Use the provisioned `MENTRA_TEST_CLIENT_CONFIG` and the current `mentra-test` CLI:

```sh
bun run mentra-test lane request @reservation.json
bun run mentra-test lane wait @wait.json
bun run mentra-test author start @start.json
bun run mentra-test author command @command.json
bun run mentra-test author inspect @scope.json
bun run mentra-test lane give-back @give-back.json
```

Read harness `orchestration/README.md`, `orchestration/controller.ts` and
`framework/authoring/session.ts` for current schemas and held-session behavior;
`contracts/controller.ts` defines admission. Run the CLI from the harness checkout,
not MentraOS. Do not invent IDs or use an old standalone author CLI.
Reservation request supplies `requestId`, `laneId`, `purpose`, `admissionExpiresAt`.
Wait with `{reservationId, afterGeneration, timeoutMs}` until granted. Start supplies
the granted `reservationId`, `generation`, a stable `operationId`, selected `build`
and canonical editable `sourcePath`. Default start performs setup and starts the
original recorder; optional `setupMode: "manual"` exposes individual lifecycle actions.

Each author command carries `{reservationId, generation, operationId, command}`.
Nested commands use `op`: `steps`, `snapshot`, `step` with `stepId`, `actions` with
`phase: "setup" | "test" | "teardown"`, `action` with setup/teardown `phase` and
`actionId`, or `finish`. Use returned IDs and inspect `{reservationId, generation}`
until each operation settles; a settled operation may contain a failed assertion.
Use a new operation ID for each action; a lost response reuses its original ID to
reconcile that call. Direct driver calls must retain the supplied owned context.
For example, the inner product command is `{ "op": "step", "stepId": "saved-id" }`,
inside `command`, not a separate CLI verb.

Declare the complete flow before starting. Use computer use to discover controls,
save each action and assertion, then execute that saved action through the same
driver/helper replay will use. Traverse the **whole English flow** this way: a manual
click does not prove a different script written afterward. Prefer the simplest
supported interaction that works; verify outcomes rather than successful clicks.
On a settled step failure, inspect the actual error, edit that existing action and
retry with a concrete `retryReason` from its current safe prerequisite state. Keep
the same owner, recorder and passing prefix; do not reinstall or restart setup for
an ordinary authoring mistake. Do not repeat an uncertain submission/firmware write.
If returning to a prerequisite needs an already passed product action, inspect
`{op: "actions", phase: "test"}` for eligibility and repeat that same saved action
with an explicit `retryReason` describing the observed prerequisite. The controller
must confirm its previous input settled; a source reload alone permits no repeat.
The held loader preserves `createRoutine(state)` state and original lifecycle while
reloading existing product steps. Changing step IDs/order, lifecycle callbacks or
metadata requires finishing the session first. Shared helper/native changes require
the updated installed revision and a fresh session. Fix a broken app control rather
than accumulating alternate input or focus algorithms.
For UI transitions, verify the departing overlay disappears as well as the
new page appears. Home controls can remain visible behind a miniapp. Use bounded
postcondition observation; an acknowledged click is not a completed transition.
Static headings may appear twice on a platform: require readable content, and use
exact IDs/counts for the actionable controls that must be unique.
On Android, use the supplied `ui.scroll(anchor, direction)` for a bounded gesture
inside the observed scroll view, then resnapshot. Check `checked` for toggles rather
than assuming a click changed them; public text replacement uses `clearText` before
`type`. Use `hideKeyboard` for the actual IME. The optional `systemUi` retains the
same ownership and permits only the enrolled system-dialog namespaces; normal `ui`
remains scoped to the Mentra App.
Flag actual bugs and impossible/human-only requirements with the exact failed step.
Routine code does not repair the harness. Finish runs the original teardown; then
give back with `{reservationId, generation, requestId}` for ordinary boundary cleanup.

## Shared lifecycle and modified miniapps

Shared providers install the selected Mentra App, establish requested account/entry,
prepare applicable glasses/fixtures, record, settle resources and uninstall the owned
app. Routine setup/teardown own only product-specific effects. Backend fixtures need
their own exact owned-ID cleanup; uninstall does not delete cloud data. Cleanup must
not wait for a product effect that failed to be created.
Use the supplied account context (`account` on Mac, `credentials()` on Android)
and optional `audio` or `fixtures` when the installed platform supports them.
Routine fixture content stays in `routines/<id>/`; reusable
capture/connection/audio and platform delivery belong to shared providers. Do not
copy another lane's serial, account, audio route or firmware setup into the routine.
To try a modified miniapp, build/pack it in its source repo, then from MentraOS run
`bun scripts/load-authoring-miniapp.mjs <packed.zip> --mac` (set `MENTRA_MAC_APP`)
or `--android <phone-serial>`. The installed app needs existing Super Mode and miniapp
permissions. Keep the temporary server until loading completes, verify the changed
saved step, then stop it. See the [miniapp CLI guide](../../../sdk/miniapp-cli/README.md#try-a-packed-miniapp-during-routine-authoring).

## Replay and publish

After the full saved flow works, commit/enroll its exact source and replay the **same
actions** through normal setup/test/teardown:

```sh
bun run mentra-test source enroll @source-enrollment.json
bun run mentra-test run submit @run-request.json
bun run mentra-test run dispatch-once '{"id":"ACCEPTED_LOCAL_REQUEST_ID"}'
bun run mentra-test run inspect '{"id":"ACCEPTED_LOCAL_REQUEST_ID"}'
```

Use `enrollRoutine`/platform enrollment and `localAdmissionId` helpers for source
provenance and local admission. Activate a changed shared framework/native revision
only after affected held sessions and runs have finished; do not replace their pinned
source under active owners. Ordinary replay stops at its first failed product
step, preserves remaining steps as `not-run` and still tears down; other runs stay
independent. Preserve the original error if cleanup/publication also fails.
Completion needs passing assertions, teardown, acknowledged evidence and working
recording/step seeking. The coordinator owns deployed Admin/playback verification.
Report exact source/build/platform, result URL, recording and timings. Do not add
repeated qualification runs without changed code or unresolved failures.
`run retry-publication` retries delivery without hardware replay. Dispose owned local
payloads after acknowledgement; preserve shared tools and native Codex/Claude history.
Use focused checks and [codex-pr-review](../codex-pr-review/SKILL.md) for the PR;
[select-pr-routines](../select-pr-routines/SKILL.md) selects relevant coverage labels.
