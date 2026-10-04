---
name: create-routine
description: Create or extend a Mentra automated testing routine with readable English steps, saved actions verified during authoring, and deterministic replay through the shared framework. To request existing coverage on a PR, use select-pr-routines instead.
---

# Create or extend a routine

Routines must be **fast, reliable and easy to make**. Keep English instructions,
observable expectations and executable actions together. Work in the private
[Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing).

## Find the working source

Inspect the selected revision's `routines/`, `framework/` and README. Choose the
closest routine for the required platform and glasses. A published video from a
previous framework is useful evidence, not proof that its adapter still exists.
Reuse proven steps and drivers; replace old orchestration wrappers rather than
copying their leases, backups or retry systems.

| Location | Responsibility |
| --- | --- |
| `routines/<id>/routine.ts` | `createRoutine(state)` factory, English metadata, product setup/steps/teardown |
| `framework/index.ts` | Routine-facing `defineRoutine`, `step` and types |
| `framework/drivers/` | Shared platform actions and observations |
| `framework/platforms/` | Platform app installation, entry, recording and lane adapter |
| `framework/glasses/` | Shared glasses-model software and hardware lifecycle |
| `framework/authoring/` | Held setup, editable saved steps and teardown |
| `orchestration/` | Job submission, reservation, ownership, repair and publication |

Adding a routine must not require routine-name branches elsewhere, worker edits,
manual catalog entries or hardcoded videos. Enrollment discovers current definitions;
the catalog uses acknowledged passing runs with recordings. Its nightly toggle
controls future suite membership.

Declare ID, title, purpose, platforms, entry (`home` or `sign-in`), account,
English requirements, fixtures and named steps. Declare acceptable glasses models
with `glasses.models` and required capability IDs with `requires`. Physical device
IDs, account secrets and tool paths belong to private lane configuration. Verify
that the installed adapter supports those declarations before touching hardware.
Do not advertise an injected/mock provider as a physical capability.

## Use the controller for live iteration

Use the provisioned `MENTRA_TEST_CLIENT_CONFIG`. The CLI calls the same controller
API as its MCP tools:

```sh
bun run mentra-test lane request @reservation.json
bun run mentra-test lane wait @reservation-wait.json
bun run mentra-test author start @author-start.json
bun run mentra-test author inspect @author-inspect.json
bun run mentra-test author command @author-command.json
bun run mentra-test lane give-back @reservation-return.json
```

Read `contracts/controller.ts` and `orchestration/controller.ts` for request schemas. Reservation
request contains `requestId`, `laneId`, `purpose` and `admissionExpiresAt`. Wait for
`granted`; keep its `reservationId` and `generation`. Author start contains those
two fields plus a unique `operationId`, exact selected `build` and canonical `sourcePath`.
Default start runs framework and routine setup, verifies entry and starts the original
recorder. The merged framework supports held Mac and Android authoring and optional
`setupMode: "manual"` for individual original lifecycle actions. Confirm the
installed controller revision and strict schemas before using those inputs.
Inspect operation receipts; ready in manual mode is not completed setup.

Example author-start and command envelopes are:

```json
{"reservationId":"...","generation":1,"operationId":"...","build":{},"sourcePath":"/absolute/routines/example/routine.ts"}
{"reservationId":"...","generation":1,"operationId":"...","command":{"op":"step","stepId":"STEP-ID"}}
```

Use the selected build object, not the empty placeholder above. The nested
`command` is one of:

```json
{"op":"steps"}
{"op":"actions","phase":"setup"}
{"op":"action","phase":"setup","actionId":"ACTION-ID"}
{"op":"snapshot"}
{"op":"step","stepId":"STEP-ID"}
{"op":"step","stepId":"STEP-ID","retryReason":"Corrected the saved action after observing its prerequisite"}
{"op":"finish"}
```

`author inspect` takes `{reservationId, generation}` and returns `operations`
with the original operation IDs, states and receipts. `lane inspect` and `lane cancel`
take `{id: reservationId}`. `lane wait` takes
`{reservationId, afterGeneration, timeoutMs}`; `lane give-back` takes
`{reservationId, generation, requestId}`. Use the schemas above for bounds.

Inspect each operation's receipt for its outcome. A settled receipt may contain
a failed assertion. `finish` performs routine and shared teardown; give the lane
back afterward for ordinary boundary cleanup. Reuse the same operation ID only
to inspect/reconcile the same call, not to repeat a mutation. These APIs retain
one owner and recorder; do not launch a competing setup or cleanup process.

The generic held interface is not proof every platform adapter implements it.
Check the installed lane adapter's authoring support and exact revision. If an
operation is missing, implement it once through this interface, not through a
routine-specific shell runner. Direct subsystem calls still require the current
grant and durable controller callbacks.
When the installed granular API is available, `actions` accepts `setup`, `test` and
`teardown`, returning the original inventory, outcomes and current eligibility.
`action` accepts `setup` or `teardown` and an `actionId`; it executes an eligible original lifecycle action. Use the returned
IDs rather than inventing them. Setup permits the next unmet action; product steps
require completed setup. Completed actions cannot be repeated; a failed retry
requires the existing settled authorization and may include `retryReason`.
`finish` executes the remaining original teardown once, respecting recorder and
resource dependencies. Mac/Android lifecycle snapshots can run before recording
or after recorder cleanup when the actual UI is available. Check the installed
Mini revision before relying on these source APIs.

## Build the replay while traversing the whole flow

Use computer use to discover the next control. Save the action with its assertion,
then execute that saved step through the same driver/helper replay will call.
Continue through the **entire English flow** in the held session. A manual click
that worked does not qualify a different action written afterward.

When a step fails, inspect the actual error, fix that action and retry it from the
smallest safe prerequisite state. Do not reinstall, redo setup or replay the
completed prefix for an ordinary authoring mistake. Do not blindly repeat an
uncertain submission or firmware write. Keep source edits compatible with the
held routine identity, inputs and lifecycle. Existing product-step implementations
in the owned `routine.ts` can reload under the granular source loader with the
original step IDs/order while the original setup/teardown callbacks, metadata and
private inputs remain in use.
Changed lifecycle action IDs/text/callback text, requirements, fixtures, platforms,
entry/account or glasses declarations are refused; finish before changing them or
the step inventory. Source bytes must remain stable across loading. Shared helpers,
platform drivers and native tools remain loaded or pinned, so changing them needs
a fresh session and the corresponding installed source/tool revision. The older
published hook-bearing loader freezes the complete source file; if that version is
installed, finish and update the source rather than pretending the new boundary exists.

Use the simplest supported interaction that works. Prefer stable selectors where
useful, but do not replace verified working actions merely to adopt a different
selector technique. Assert outcomes, not successful clicks. If the app control is
broken, fix the app rather than accumulating input workarounds.

File actual bugs through the existing incident path and continue independent
remaining checks. Keep failed expectations failed. Flag genuinely impossible or
human-only requirements to the user with the exact step and proposed alternative.
An authoring action failure does not warrant framework state repair unless its
actual machine/resource state is unusable. After terminal cleanup, the old app UI
cannot resume: separately authorized reproduction reserves fresh ownership, runs
setup once and executes the saved prerequisites needed for the failed action.
Within a valid held session, keep the original grant/recorder and completed prefix.

## Shared lifecycle and modified miniapps

The framework installs the exact selected Mentra App, signs in if requested and
establishes entry. Installed providers own applicable glasses software and declared
fixtures; check actual support, since generic fixture loading and physical glasses
integration may still be unavailable. Recording begins after shared preparations
and routine setup. Routine setup/teardown own only
product fixtures and behavior. Shared teardown settles recording, restores declared
changed glasses state, uninstalls/stops the owned app and cleans acquired resources.
Routine code must not repair the harness or depend on the previous routine's state.

To try a modified external miniapp in the held app, build/pack it in its source repo,
then use `bun scripts/load-authoring-miniapp.mjs <packed.zip> --mac` (set
`MENTRA_MAC_APP` to the installed app) or `--android <phone-serial>` from MentraOS.
This needs the existing Super Mode, install-and-open handler and granted miniapp
permissions. Keep the temporary server alive until loading completes, verify the
changed saved step in the current session, then stop it. See the
[CLI guide](../../../sdk/miniapp-cli/README.md#try-a-packed-miniapp-during-routine-authoring).

## Submit the completed routine and publish its result

After the whole saved flow has worked during authoring, replay that **same flow**
without AI through ordinary setup/test/teardown:

```sh
bun run mentra-test source enroll @source-enrollment.json
bun run mentra-test run submit @run-request.json
bun run mentra-test run dispatch-once @accepted-local-request.json
bun run mentra-test run inspect @accepted-local-request.json
```

Source enrollment uses the exact committed definition/revision and digest. Local
submission needs a fresh admission identity; inspect the installed schemas/helpers
rather than inventing request IDs or flags. One-shot dispatch starts an accepted
local job while automatic dispatch stays paused. Admin/CI uses the same orchestration.
For `dispatch-once` and `inspect`, the file contains `{"id":"accepted-local-id"}`;
do not pass the complete acceptance receipt.

Verify the actual assertions, teardown and recording. Root coordinator owns hosted
Admin/playback checks when Mini authoring agents lack the signed-in browser. Report
exact source/build/platform, run URL, recording, timings and cleanup/publication.
Source tests and partial sections are not a physical passing run. Do not prescribe
repeated qualifications: replay again only for changed code or an unresolved failure.

The controller uploads frozen evidence/diagnostics through the existing result and
incident attachment paths and disposes owned payloads after acknowledgement.
Publication retries do not rerun hardware. Preserve native Codex/Claude histories
and shared tools; remove disposable authoring/fixer checkouts when no task needs them.
Run focused checks for meaningful changed behavior. Apply the user's PR timing and
[codex-pr-review](../codex-pr-review/SKILL.md); use
[select-pr-routines](../select-pr-routines/SKILL.md) for relevant PR coverage labels.
