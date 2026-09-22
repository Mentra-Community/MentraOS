---
status: draft
owner: Philippe
---

# Dedicated Mac device workers using GitHub Actions

Preferred design: reuse GitHub Actions routing and its queue for device routines.
Keep the existing [registered day-one worker](../../../tools/mentra-e2e/DAY1-LOCAL-WORKER.md),
lifecycle, recording and admin results. This note proposes the missing dispatch
connection; it does not establish an implemented or qualified unattended worker.

The intended first test station is a third office Mac mini. The Tailscale entry
**“Mentra’s Mac mini”** is a candidate awaiting confirmation of hostname and login
user. Its identity, graphical session and attached fixture are not established by
the runner discovery below. The control-repository decision also remains open.

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

Two control options require a decision:

- **Private control repository (recommended):** contain only the trusted dispatch
  workflow, keeping the harness in MentraOS at reviewed revisions. This reuses
  GitHub Actions routing, runner availability and the job queue.
- **Keep everything in MentraOS:** expose a typed request endpoint over Tailscale
  that accepts authenticated data only and invokes the pinned local launcher.
  This needs custom dispatch, worker availability and pending-request handling.

Neither option authorizes repository creation or harness migration. The existing
[implementation plan](../plans/2026-09-21-day1-ota-and-ci-routines.md) explicitly
defers private-repository migration until the simpler CI hookup works.

## Request ordering and shared claims

The [current request workflow](../../../.github/workflows/request-e2e-routine.yml)
can run before app publication and produce `no-artifact`. Automatic dispatch must
resolve the request after successful publication, pinning the exact current PR
head/base, producer/publication attempts, Mac archive and OTA manifest. A successful
request workflow alone is insufficient; only its authenticated `ready` selection
is eligible. Keep build-post timing independent of this device path.

Both options require a shared atomic claim before app installation or any device
action. Proposed dev Core/Mongo state has a unique immutable request ID, request
hash, worker/fixture owner, execution token and
terminal state. A duplicate or another Mac observing existing ownership performs
no device work. Crashes and ambiguous responses retain the claim: no automatic
expiry, reassignment or replay. Reconciliation first establishes the original
worker and fixture state.

The existing `consumeRoutineRequest` claim lives under a local `stateDirectory`;
another Mac cannot see it. Retain it and the lifecycle/app lease beneath the shared
claim. Existing result records are not a shared claim: `runId` is unique, while
`requestId` is only indexed and intentionally admits recovery result generations.
The shared claim is deduplication, not another scheduler. Do not copy build
`cancel-in-progress: true` into an active firmware routine.

## Remaining implementation and qualification

Dispatch still needs trusted per-request preparation: authenticate the request,
verify/import the exact Mac archive, bind host inputs and admission to the enrolled
fixture, install under ownership, then invoke the registered local worker. The
current local entry requires prepared pinned configuration and does not install
the CI app. It exports results but does not publish them; automated publication to
dev Core also remains necessary, preserving immutable metadata and upload retries.

Confirm the third Mac, choose the control boundary, implement shared claims and
the thin dispatch/preparation/publication connection, then qualify the actual
fixture and recovery behavior. Neither online runners, a queued request, admission
nor source tests constitute a completed day-one OTA run.
