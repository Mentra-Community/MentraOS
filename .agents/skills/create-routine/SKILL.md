---
name: create-routine
description: Create or extend a Mentra automated testing routine using the shared setup, test and teardown foundation. Use for new coverage, readable step additions, AI-guided discovery and deterministic replay. To request existing coverage on a PR, use select-pr-routines instead.
---

# Add or extend a routine

**Routines must be fast, reliable and easy to make. Keep their English steps and
replay code readable and maintainable. Adding a check should usually mean adding
a named step to a small flow, not another runner.** Author
routines in the private [Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing).
MentraOS contains their public catalog and `routine:<id>` request labels.

## Find the closest working example

Read the [routine catalog](../../../.github/scripts/device-routines.mjs), then the
closest flow and platform adapter in the selected private checkout. Extend an
existing routine when the behavior belongs in it; create an ID for independently
selectable coverage. Published catalog links may precede the working source.

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
| Coverage | Routine ID, platform and behavior it proves; explicit exclusions |
| Inputs | Requested PR/dev/staging build, firmware start/return targets if needed |
| Resources | Required account, phone/glasses, browser, network, media or audio |
| Entry | Sign-in page or Home; optional authentication and owned fixture data |
| Steps | Stable ID, plain-English name/action and observable expected result |

Use private runtime account references and existing secret-input/redaction
helpers. Keep credentials out of source, prompts and evidence; use separate
accounts for concurrent sessions when their state could interfere.

## Use the shared foundation

These paths are relative to the private repository; inspect the selected revision
before using its APIs or commands:

| Entry point | Purpose |
| --- | --- |
| `tools/mentra-e2e/runner/routine-plan.ts` | Build, platform, entry, account, fixtures and resources |
| `tools/mentra-e2e/runner/standard-routine.ts` | Common setup/test/teardown composition |
| `worker/local.ts` | Local run, authoring, cleanup and publication commands; inspect `--help` |
| `worker/local-mac.ts`, `worker/local-android.ts` | Platform implementation of that contract |
| `tools/mentra-e2e/flows/` | Small flow definitions, including walkthrough, Captions and Notes |

The contract for every routine is:

1. **Setup:** install the requested Mentra App build; establish requested glasses
   software when applicable; reset/seed owned data; launch; optionally sign in;
   verify Home or the sign-in page. Start the recording there. Preflight checks
   host/input readiness; it must not require the app already running or signed in.
2. **Test:** perform named actions and check their observable results. The test
   may finish on any page. A successful click alone does not prove the outcome.
3. **Teardown:** settle recording, clean owned data and resources, leave the app
   stopped, and restore the requested firmware target if the routine changed it.
   Verify cleanup from any ending page, including failure. The next run establishes
   its own inputs; do not carry forward app backups or arbitrary prior state.
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
find controls and understand behavior. As each interaction works, save it with
its observable assertion in the routine's flow and execute that saved step from
the current state through the same driver/helper that replay will call. Continue
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

On revisions containing [the shared authoring interface](https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/248),
use `bun --no-env-file worker/local.ts author --config /absolute/private-config.json`.
It runs shared setup and holds its owner/recorder for `steps`, `snapshot`,
`step <ID>`, `section <ID> <ID>`, semantic `press`, and, on Android,
`maestro /absolute/section.yaml`. Check the selected checkout's help and
`docs/DEVELOPMENT-ENTRY.md` for supported adapters and commands. Keep retries
inside that session; edit and rerun supported sections from the current state.
End the complete traversal with `teardown`. If the authoring process exits,
the existing `cleanup` command requires the original `--config` and
`--run-directory`; after teardown, a new session establishes its own prerequisites.

On older revisions, use or extend the selected checkout's shared authoring/section
entry point and owner for input, recording and local retries. Do not invent CLI
flags, create a second runner or replay an uncertain firmware write. Authoring
section evidence documents progress; it cannot publish a full routine result or
replace the complete traversal.

After reaching the end, run the **same saved flow** without AI through complete
shared setup/test/teardown. Remove exploration-only actions and order the proven
steps; do not rewrite working interactions merely to adopt another selector or
input technique. Prefer stable selectors where they work, use the simplest
supported alternative where they do not, and assert the actual outcome.

The current authoring CLI holds the session and records attempts; it is not an
automatic script generator. Inspect its actual loading behavior. Android Maestro
files can be edited and rerun in the held session; TypeScript flows may be loaded
only at startup. If that prevents testing a changed saved step in place, extend
the shared authoring entry point to execute updated flow sections under the same
owner and recorder. Do not work around that gap by repeatedly rebuilding setup
or by claiming manual exploration proved an unexecuted replay implementation.

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
- For local development coverage, publish a complete passing run and recording
  before listing it as a Development pass in Admin. Report CI enrollment
  separately. When enabling PR/CI requests, trace the exact ID through catalog,
  request validation, worker dispatch, Admin, result publication and PR result
  links, and create its `routine:<id>` label. Do not enable a request label for a
  local-only adapter; preserve unknown-ID refusal on unsupported routes.
- Use [select-pr-routines](../select-pr-routines/SKILL.md) to label relevant PRs.
  Apply the user's PR/review timing; when preparing a PR, include the evidence and
  follow [codex-pr-review](../codex-pr-review/SKILL.md). Enable requested triggers
  only with an executable worker path and report any unqualified coverage honestly.

Deliver the routine ID/label, covered behavior, exact harness source and tested
build/platform, and links to the result and passing recording. Include run start,
setup/test/teardown durations and cleanup/publication outcome. Report remaining
gaps explicitly. Public PRs link approved result pages; private diagnostics stay
in the incident/result system. Remove disposable authoring/fixer workspaces when
no active task depends on them, using the existing workspace cleanup mechanism.
