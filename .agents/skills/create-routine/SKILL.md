---
name: create-routine
description: Create or extend a Mentra automated testing routine using the shared setup, test and teardown foundation. Use for new coverage, readable step additions, AI-guided discovery and deterministic replay. To request existing coverage on a PR, use select-pr-routines instead.
---

# Add or extend a routine

**Routines must be fast, reliable and easy to make. Keep their English steps and
replay code readable and maintainable. Adding a check should usually mean adding
a named step to a small flow, not another runner.** Author
routines in the private [Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing).
MentraOS Core stores enrolled definitions, requests and recorded results; Admin
shows the passing-example catalog and each routine/platform's nightly preference.

## Find the closest working example

Read the deployed Admin routine catalog, then the closest source definition in
`routines/<id>/routine.ts` in the selected private checkout. The catalog uses
the latest recorded passing run for each routine/platform as an example. Once a
routine/platform has passed on the foundation, later failures or source revisions
do not remove it from the catalog. Extend an existing routine for related
behavior, or use a new ID for independently selectable coverage.
Confirm the example's actual platform and resources: an Android phone-only
walkthrough does not demonstrate physical glasses setup or firmware restoration.
Read its adapter as well as its flow. Record the selected checkout and revision,
and identify the first unsupported operation before expanding shared support.

Reuse a suitable checkout; isolate concurrent source changes when needed. Follow
the task's source revision and PR timing. Develop locally until the requested
qualification boundary; do not require a merge for each iteration. Coordinate
shared app/device/account/network use with its current owner. Source work can
proceed in parallel without competing for the same UI or changing another run.

## Describe the behavior before choosing selectors

Write a brief in the routine's existing definition or task, without adding a
parallel documentation system:

| Declare | Include |
| --- | --- |
| Coverage | Routine ID, independently supported platforms and behavior it proves; explicit exclusions |
| Inputs | Requested PR/dev/staging build, firmware start/return targets if needed |
| Resources | Required account, phone/glasses, browser, network, media or audio |
| Entry | Sign-in page or Home; optional authentication and owned fixture data |
| Steps | Stable ID, plain-English name/action and observable expected result |

Use private runtime account references and existing secret-input/redaction
helpers. Keep credentials out of source, prompts and evidence; use separate
accounts for concurrent sessions when their state could interfere.

## Try a modified miniapp without restarting authoring

Build and pack it in its source repo, then use the MentraOS command
`bun scripts/load-authoring-miniapp.mjs <packed.zip> --mac` or
`--android <phone-serial>`. For Mac, set `MENTRA_MAC_APP` to the exact installed
`.app` path; for Android variants, set `MENTRA_HOST_PACKAGE` to their application
ID. This uses the running Mentra App's install-and-open
handler instead of computer use through Developer Settings. It needs a host build
containing that handler, the existing Super Mode enabled, and already granted miniapp permissions. Keep the server
running until the miniapp opens, then stop it. Verify the changed saved action in
the existing session; don't redo setup or replay the completed prefix.
See [the CLI guide](../../../sdk/miniapp-cli/README.md#try-a-packed-miniapp-during-routine-authoring).

## Use the shared foundation

These paths are relative to the private repository; inspect the selected revision
before using its APIs or commands:

| Entry point | Purpose |
| --- | --- |
| `routines/<id>/routine.ts` | English requirements and executable saved steps |
| `framework/routines.ts` | Discover definitions from the filesystem and load their factories |
| `framework/run.ts` | Shared setup, held authoring, replay and teardown |
| `framework/drivers/` | Actions and assertions used during authoring and replay |
| `framework/authoring/` | Held command/session adapters that reload edited steps |
| `orchestration/entrypoints/cli.ts` | Controller client commands and lane reservation |
| `framework/platforms/` | Installation, entry, recording and resource providers |

Export `createRoutine(state: Record<string, unknown>)` from
`routines/<id>/routine.ts` and return `defineRoutine(...)`. The definition's ID
must match its directory. Declare `title`, `purpose`, `platforms`, `entry`,
`account`, `requires`, English `requirements`, `fixtures`, and executable `steps`.
Use `step(id, instruction, expected, run)` for readable actions. Optional `setup`
and `teardown` arrays contain routine-owned actions through the same interface;
their lifecycle context can differ from the product-step context. Step IDs must
be unique across all three arrays and must not collide with shared lifecycle IDs.
Keep mutable traversal state in the supplied factory state so edited actions use
the state retained by held authoring.

`discoverRoutines()` reads `routines/`; the installed platform providers load,
validate and enroll supported definitions. Adding a routine does not require
another registry, per-ID controller branch or hardcoded caller list. Requests
select an enrolled routine/platform and exact source revision. Controller
admission verifies that definition and its resources/policy before ownership is
granted; an HTTP acceptance is not execution or a passing result.

Declare `ios-on-mac` and `android` only when each has executable actions and
installed providers for its requirements. The current Mac providers support app
and recorder resources; Android supports a dedicated phone, app and recorder.
Neither currently supports declared fixture providers or extra `requires`
capabilities. Missing support must fail explicitly. A Mac pass does not prove
Android behavior, glasses connectivity, firmware setup or another capability.
Extend a shared provider for demonstrated needs and qualify each platform
independently. Keep machine-specific host/lane bindings in configuration, never
inside a routine or caller's ID dispatch.

The contract for every routine is:

1. **Setup:** install the requested Mentra App build; establish requested glasses
   software when applicable; reset/seed owned data; launch; optionally sign in;
   verify Home or the sign-in page; run any routine-owned setup actions, then
   start recording. Preflight checks
   host/input readiness; it must not require the app already running or signed in.
2. **Test:** perform named actions and check their observable results. The test
   may finish on any page. A successful click alone does not prove the outcome.
3. **Teardown:** settle recording, run routine-owned teardown actions through the
   shared framework, clean owned data and resources, and leave the app stopped.
   Cleanup works from any ending page or a stopped app. Do not start a
   firmware installation or require a firmware version reply to release resources;
   protect an installation that is still writing. Report software mismatches as
   test results. The next setup establishes its requested software and inputs;
   do not carry forward app backups or arbitrary prior state.
4. **Publish and dispose:** use existing result/incident attachment paths to upload
   diagnostics and evidence, then dispose of owned run payloads, downloads and
   temporary copies. Preserve the failed verdict even when cleanup succeeds.
   Report any pending upload or unsettled resource that prevents disposal.

Plan fields do not prove adapter support. If seeding, firmware or another needed
capability is missing, extend the shared adapter/helper once and demonstrate it;
never silently skip it or add a separate lifecycle/recovery fork for the routine.
Keep shared tools, credentials and native agent histories outside run cleanup.

For Android, exercise driver startup through the same subprocess environment as
the adapter before installing or resetting the app. A working interactive shell
does not prove the runner forwards its Java/Android tool configuration. Use the
selected revision's pinned tools and a minimal semantic observation to check the
assigned device; keep account entry and firmware operations in setup.

## Author the executable flow while traversing it

**Complete one AI-guided traversal of the entire English scenario before full
replay qualification. Build its executable steps as you go.** Computer use helps
find controls and understand behavior. Once the next action is understood, save
it with its observable assertion and execute that saved step from its prerequisite
state through the same driver/helper that replay will call. If a manual action
already advanced the UI, restore only the smallest safe prerequisite state before
testing the saved step. Do not repeat a submission or destructive action blindly;
use an owned fixture or report the verification gap until it can be tested. Continue
forward in the held session; do not leave a successful manual click to be
translated into a different, untested action later.

Authoring produces a readable executable flow plus its recording and step
observations. The recording/action journal alone is not a replay script. Keep
step IDs and English expectations alongside the executable actions. A step only
tried through computer use is still exploratory until its saved implementation
has also worked. If changing an interaction method, verify the replacement on
that step before proceeding.

When a step fails during authoring, fix it and retry that step or the smallest
dependent section from the current usable state, then continue forward. Restore
only prerequisites that changed. **An ordinary step failure must not restart
setup, reinstall/reset the app, repeat the completed prefix, or trigger teardown
and a separate recovery workflow.** Finish the whole traversal before normal
teardown; a partial section is not the first completed traversal.

File genuine bugs through the existing incident path, retaining the incident ID
or submission failure. Keep the affected check failed and continue independent
remaining steps; do not require every check to pass before finishing exploration.
If a real blocker prevents reaching the end, report the exact obstacle and next
action rather than inventing a pass or starting over. Do not make calibration or
measurement probes prerequisites to basic exploration; keep unsupported
measurements explicitly unverified.

Use the selected revision's controller-owned authoring interface under a granted
lane reservation. Read its help/API before invoking commands. A reservation alone
does not start authoring: the installed controller must expose a held session
adapter for that platform. Mac currently provides held authoring; Android replay
support does not imply an Android held adapter.
If it is missing, report that framework gap and extend the shared adapter rather
than starting a separate local runner or opening controller SQLite directly.

The held interface provides `steps`, `snapshot`, a saved `step` by ID, and
`finish`. It runs setup once, keeps the app and recorder owned, loads the edited
saved action before executing it, and records each settled attempt. Edited
actions use the same routine factory and held state as the saved replay flow.
The current interface supports existing step IDs; changing the inventory needs a
shared interface extension. Setup, resource and identity edits cannot be adopted
mid-session. If the installed loader also refuses product-step edits in a
routine with owned lifecycle actions, report that authoring capability gap;
do not restart setup after ordinary product failures to hide it. Never claim a manually
executed action or stale startup-loaded action proved its edited implementation.

The controller CLI takes one JSON file per operation. Set
`MENTRA_TEST_CLIENT_CONFIG` to the provisioned private client file; use the
installed harness checkout and keep payload files private. Request and wait for
`lane.request` / `lane.inspect` (or `lane.wait`) until state is `granted`, then use
its reservation ID and generation in every authoring operation:

```sh
bun orchestration/entrypoints/cli.ts author start @/absolute/author-start.json
bun orchestration/entrypoints/cli.ts author inspect @/absolute/author-inspect.json
bun orchestration/entrypoints/cli.ts author command @/absolute/author-command.json
```

`author-start.json` contains `{reservationId, generation, operationId, build,
sourcePath}`. Use the requested published build selection and the canonical
editable `routines/<id>/routine.ts` file. `author-command.json` contains `{reservationId,
generation, operationId, command}` where command is `{op:"steps"}`,
`{op:"snapshot"}`, `{op:"step",stepId:"open-settings"}` (optional `retryReason`),
or `{op:"finish"}`. `author-inspect.json` contains `{reservationId,generation}`.
Each start/command has a new stable operation ID. They return admission, not
completion. `author inspect` returns `operations`; find your `operationId`.
For start, wait for `receipt.phase:"ready"` (its session remains `state:"active"`).
For a command, wait for `state:"settled"` and read its receipt's result/error;
`receipt.phase:"complete"` or `"failed"` describes the command outcome.
A result larger than 8 KB is `{path,bytes,summary}`: read the private local file
for the full snapshot/result. Finish settles the session with phase `"finished"`;
then call `lane give-back` with the reservation ID, generation and a stable
request ID. Do not give the lane back while an action or finish is running.
After a lost response, inspect that operation; never submit a different ID to
blindly repeat input. An `"unknown"` operation or `"interrupted"` receipt requires
controller inspection, not replay of uncertain input. Only use these commands
when present in the selected installed revision; an uninstalled adapter is a
framework gap.

After a failed saved step, observe the current prerequisite state, edit that
step, and retry within the same session. The controller verifies that prior
input/writers settled and records the attempt; ordinary product failures do not
require human permission or another setup. Finish performs shared teardown before
returning the reservation. Authoring evidence remains exploration evidence and
must not be published as a passing full routine run.

After reaching the end, run the **same saved flow** without AI through complete
shared setup/test/teardown. Remove exploration-only actions and order the proven
steps; do not rewrite working interactions merely to adopt another selector or
input technique. Prefer stable selectors where they work, use the simplest
supported alternative where they do not, and assert the actual outcome.


Keep flow files small and readable. Reuse shared mechanics for setup,
authentication, recording, publication and cleanup.

Use the maintained driver path that fits the platform. Existing Mac flows use
TypeScript `Step` definitions with Swift/native helpers; Android uses shared
semantic actions/UIAutomator with Maestro for some input/keyboard operations.
Maestro is neither mandatory for every step nor excluded from further use. Add a
shared driver capability only for a demonstrated gap, not a new driver per routine.

## Qualify and make the coverage usable

- Run a functional replay through full setup/test/teardown and inspect the video,
  assertions and cleanup. Successful sections, a source review or one platform's
  result do not establish a full pass elsewhere. Interleave with another working
  routine to expose leaked state or disk growth when validating shared changes.
- Add focused tests for meaningful failure modes or shared logic; avoid a fixed
  test count, implementation-mirroring tests and redundant suites. Run the relevant
  typecheck and checks for the files changed.
- Publish a complete passing foundation run and recording before claiming catalog
  membership. Core enrollment describes executable source; the passing-example
  catalog describes recorded qualification. Trace generic definition enrollment,
  request admission, controller execution, result publication and result links
  when enabling a caller. Preserve refusal for absent routine/platform/revision
  enrollment and unsupported capabilities.
- Admin's **Run in nightly** switch is stored per routine/platform and defaults
  enabled. Disabling it excludes only future nightly occurrences; it does not
  delete catalog membership or change an already frozen occurrence. Nightly and
  **Run nightly now** snapshot the whole passing-example catalog minus disabled
  entries, using current enrolled definitions and resolved dev builds. Missing
  artifacts or host capabilities remain expected members with a waiting/reason
  outcome; they must not disappear and produce a partial pass.
- Use [select-pr-routines](../select-pr-routines/SKILL.md) to label relevant PRs.
  Apply the user's PR/review timing; when preparing a PR, include the evidence and
  follow [codex-pr-review](../codex-pr-review/SKILL.md). Request labels and scheduled
  dispatches are requests, not hardware authorization or passing evidence.

Deliver the routine ID/label, covered behavior, exact harness source and tested
build/platform, and links to the result and passing recording. Include run start,
setup/test/teardown durations and cleanup/publication outcome. Report remaining
gaps explicitly. Public PRs link approved result pages; private diagnostics stay
in the incident/result system. Remove disposable authoring/fixer workspaces when
no active task depends on them, using the existing workspace cleanup mechanism.
