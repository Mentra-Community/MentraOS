---
status: active
owner: Philippe
---

# Dedicated Mac device workers using GitHub Actions

Preferred design: reuse GitHub Actions routing and its queue for device routines.
Keep the existing [registered day-one worker](../../../tools/mentra-e2e/DAY1-LOCAL-WORKER.md),
lifecycle, recording and admin results. This note proposes the missing dispatch
connection; it does not establish an implemented or qualified unattended worker.

The intended first test station is a third office Mac mini. The existing SSH alias
`mentras-mac-mini` resolves over Tailscale and logs in as `mentraconference`.
Read-only inspection found macOS 26.4.1 on ARM64, that user's graphical session,
86 GiB available, Command Line Tools, and no active Actions runner. Physical
fixture enrollment is still required. The user approved the private repository
and migration on September 22: **Mentra-Community/Mentra-Automated-Testing**.

## Existing configuration and evidence

Read-only discovery on 2026-09-22 verified live `dev` at
`09b74eac29a0f25515856bc31ca48fee514537e5`. At 20:14 UTC, repository runner/job APIs
reported:

| Runner | Group | Labels | Snapshot |
| --- | --- | --- | --- |
| `big-bob` | `Default` (1) | `self-hosted`, `macOS`, `ARM64` | Online, busy |
| `big-bob-2` | `Default` (1) | Same | Online, idle |
| `big-bob-3` | `Default` (1) | Same | Online, busy |

No Small Bob registration appeared in this repository's runner listing. This is
runner-process availability, not proof of physical host or fixture readiness.
The request workflow and registered day-one entry are branch implementation;
neither existed in the inspected `dev` snapshot.

- The [iOS build workflow](https://github.com/Mentra-Community/MentraOS/blob/09b74eac29a0f25515856bc31ca48fee514537e5/.github/workflows/mentra-app-ios-build.yml#L34)
  targets `[self-hosted, macOS, ARM64]`; GitHub selects a matching available runner.
  Per-ref concurrency cancels superseded builds. Its comments document several
  runner processes sharing one Mac, with one job per process.
- [Run 35777634528](https://github.com/Mentra-Community/MentraOS/actions/runs/35777634528/job/106915031617)
  used `big-bob`; [35777059080](https://github.com/Mentra-Community/MentraOS/actions/runs/35777059080/job/106914684475)
  used `big-bob-3`. [Successful run 35773859751](https://github.com/Mentra-Community/MentraOS/actions/runs/35773859751)
  built on `big-bob-2`, then published and notified on `ubuntu-latest`.
- The [runner bootstrap](../../../mobile/scripts/setup-runner.sh) creates separate
  workspaces and launchd services. It always adds default labels; copying it
  unchanged would also admit generic build jobs. Quality/recovery workflows use
  bare `self-hosted`; Android builds use Blacksmith. Maestro is disabled.

## Dedicated routing and trusted execution

Use one device runner per logged-in graphical Mac session, with one GUI/app/fixture
execution slot. Several build runner processes do not imply several independent
device slots. Preserve the existing app lease shared with installers.

Upstream [runner configuration](https://github.com/actions/runner/blob/cab9d1c3901e45c7705889c4f88284fdd93f4ae5/src/Runner.Listener/Runner.cs#L1144)
supports `--no-default-labels --labels mentra-device-worker,day1-ota`; custom labels
are required. This excludes current generic build selectors. A dedicated setup
mode must actually omit defaults, not merely append another label.

Labels control routing, not workflow trust. Public PR workflows can request a
known custom label. A hardware host must run only a reviewed control workflow and
a pinned installed launcher; incoming request JSON never supplies executable
scripts, modules or shell commands. Use a dedicated test account without personal
sessions or release-signing credentials.

Selected-workflow runner-group restrictions are unavailable on the reported `free`
plan; GitHub [documents them for Enterprise Cloud/Server](https://github.com/github/docs/blob/c574b799f29918d8c61f1e93ee16a6adb6742b40/data/reusables/actions/runner-group-assign-policy-workflow.md).
Group list/get returned 403, so the observed `Default` policy was not inspectable.

The selected private repository owns the harness, English routines, device
adapters, recording, lifecycle and dispatch workflow. MentraOS retains company
app installers/build publication, request production, Core result/claim APIs and
the admin UI. A tracked-source-only import preserves original license and per-file
provenance; it excludes firmware, local evidence, credentials and active claims.
This supersedes the earlier migration deferral. Existing attempts and recovery
remain bound to their original checkout until settled.

The private job uses only `[mentra-device-worker, day1-ota]`, with no default
runner labels and no workflow-wide concurrency group that could drop pending
requests. One registered runner supplies one execution slot. Workflow dispatch
accepts only a source repository and immutable request run/attempt identifiers;
it never accepts a shell command, source checkout, executable path or fixture
override from the public request.

## Request ordering and shared claims

The [request workflow](../../../.github/workflows/request-e2e-routine.yml) may run
before publication and produce `no-artifact`. The new trusted default-branch
[dispatch workflow](../../../.github/workflows/dispatch-device-routine.yml) reacts
to successful iOS producer completion. It verifies the current same-repository PR
and `routine:day1-ota` label, then invokes the request workflow on `dev`. After
that workflow completes, a second callback reads its exact request artifact and
dispatches only a still-current `ready` selection to the private workflow on
`main`. The private worker independently authenticates the request before claiming
it. Bootstrap PR request workflows are excluded from automatic dispatch.

The public callback needs `E2E_PRIVATE_DISPATCH_TOKEN`, restricted to Actions write
on the private repository. It is read only by the trusted callback; no PR source
is checked out with it. App build posts remain independent and may link to an
empty results page while the device job is pending. These callbacks do not run
until merged to the default branch and configured; workflow dispatch acceptance
is not evidence that a device ran or passed.

The Core/Mongo claim API uses a unique immutable request ID, request
hash, worker/fixture owner, execution token and
terminal state. A duplicate or another Mac observing existing ownership performs
no device work. Crashes and ambiguous responses retain the claim: no automatic
expiry, reassignment or replay. Reconciliation first establishes the original
worker and fixture state.

The existing `consumeRoutineRequest` claim lives under a local `stateDirectory`;
another Mac cannot see it. Retain it and the lifecycle/app lease beneath the shared
claim. Existing result records are not a shared claim: `runId` is unique, while
`requestId` is only indexed and intentionally admits recovery result generations.
See [the claim API contract](../../../cloud-v2/packages/core/TEST-RUN-CLAIMS.md).
The shared claim is deduplication, not another scheduler. Do not copy build
`cancel-in-progress: true` into an active firmware routine.

## Remaining implementation and qualification

Dispatch still needs trusted per-request preparation: authenticate the request,
verify/import the exact Mac archive, bind host inputs and admission to the enrolled
fixture, install under ownership, then invoke the registered local worker. The
current local entry requires prepared pinned configuration and does not install
the CI app. It exports results but does not publish them; automated publication to
dev Core also remains necessary, preserving immutable metadata and upload retries.

Confirm the third Mac's attached fixture, deploy/configure shared claims and
the dispatch/preparation/publication connection, then qualify the actual
fixture and recovery behavior. Neither online runners, a queued request, admission
nor source tests constitute a completed day-one OTA run.
