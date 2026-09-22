---
status: draft
owner: Philippe
---

# Routine orchestrator

Implement the [routine lifecycle](2026-09-21-routine-lifecycle.md) around the
existing `tools/mentra-e2e/` drivers and report format. Start with one sequential
process on the current Mac, in MentraOS. CI later invokes the same interface;
private-repository migration and a distributed scheduler are not prerequisites.

This document specifies planned functionality. Existing `run.ts`, `ota.ts` and
platform-specific Call/OTA commands are usable today; the uniform lifecycle CLI
below is not implemented yet. The [active plan](../plans/2026-09-21-day1-ota-and-ci-routines.md)
tracks delivery.

## Reuse and extension

| Existing component | Extension |
| --- | --- |
| `mac_ci.py`, [Mac CI setup](../../../tools/mentra-e2e/MAC-CI-SETUP.md) | Reuse selected-PR artifact verification/opt-in installation; add publication, permission-readiness and common lifecycle gates. |
| `run.ts doctor`, `SETUP.md` | Preflight for selected artifacts, capacity and recovery availability. |
| `runner/suite.ts` | Execute typed steps inside explicit lifecycle phases. |
| `runner/recorded-action.ts` | Phase-aware command/assertion evidence; explicit hardware-only actions. |
| `runner/report.ts`, recorder, `verify-run.ts` | Separate test/teardown/evidence outcomes and resumed recording segments. |
| `ota.ts`, `runner/ota-hardware.ts` | January protocol compatibility, baseline and return-profile checks. |
| Existing locks and owned-process cleanup | Persistent fixture readiness after crashes and failed restoration. |
| Qualified firmware tooling | Thin setup/recovery adapters with checked postconditions. |

Host provisioning is separate from per-run setup. A routine must not reset TCC
permissions or recreate an app identity when a build is replaced. Unexpected
permission/trust requirements stop preflight before any glasses mutation; see
[Mac installation](2026-09-21-mac-test-host-installation.md).

The importer and pinned host-launcher interface have 20 focused unit tests.
Live PR artifact installation, launch, runtime identity and Bluetooth grant reuse
passed on the provisioned Mac. The `e2e-setup-checks.yml` workflow runs the guard
unit tests on Ubuntu; it performs no hardware execution or nightly scheduling.

## Proposed interface

```text
routine inspect <routine-id> --fixture <file> --build-selection <file>
routine run <routine-id> --fixture <file> --build-selection <file>
routine recover --run <run-directory>
routine verify --run <run-directory>
```

`inspect` checks inputs without device writes. `run` owns the complete lifecycle.
`recover` reconciles and restores an unfinished run without automatically restarting
its test. `verify` distinguishes read-only historical evidence checks from fresh
device checks. These are proposed names, not runnable commands.

Consume a normalized [PR or coordinated-release selection](2026-09-21-ci-routines-and-admin-results.md).
Freeze routine/tool revisions, actual fixture identity, app, effective manifest,
baseline/target/return profiles and artifact digests before setup. Save redacted
inputs. Do not resolve "latest" during a run or change expected targets when a
mutable upstream manifest changes.

MTK setup and restoration default to `full-ota`. The normalized selection may
explicitly request `flash`; record that choice and its prerequisites. Missing full
OTA inputs must not silently select flashing. Both adapters consume immutable
artifacts, retain no-resend ownership, and require independent post-boot firmware
and identity verification. Wi-Fi ADB is an explicitly selected transport with the
same identity checks, not a weaker fallback.

For method comparisons, retain separate timestamps for artifact download, device
staging, dispatch, write completion, reboot and final verification. Report total
dispatch-to-verification alongside write time and disclose observation delays;
only comparable measured runs can establish which method is faster.

## Durable execution and ownership

Acquire exclusive local resource locks before fixture reads/mutations. Identify
glasses by immutable hardware identity plus observed transport aliases; an ADB
serial or transport ID alone is insufficient. Locks cover the app/phone and
dedicated browser profile as well as the glasses.

Persist a fixture record containing `ready`, `busy` or `recovery-required`, owning
run, return-profile digest and last verification reference. An OS lock disappearing
after a crash cannot make the fixture ready. Every new acquisition reconciles
unfinished work before permitting a new test.

Write an append-only journal and atomically replaced state summary. Events include
sequence number, wall-clock/monotonic time, phase, step ID, outcome and evidence
references. Persist mutation intent before dispatch, followed by its observed
outcome and operation identity. A crash between those writes means unknown
outcome, not permission to resend.

Normal errors use `finally` for teardown. Recovery after process or host failure
uses the journal and fresh device observations. If an operation cannot be safely
identified, retain `recovery-required`. Release owned process resources without
clearing the fixture's unavailable state. Clearing it requires fresh proof of the
return profile and idle state.

## Setup, failure and cancellation

Before destructive setup, validate return artifacts/tools and enough storage for
backups, staging, video and restoration. Enforce the existing recorder's space
floor plus the selected preparation adapter's requirements; do not bake one
host's current free-space reading into the contract.

Setup can skip an action only after freshly proving its postcondition, including
required clean-data state. A previous successful run is insufficient. Record all
owned changes so teardown handles partial setup safely.

After a test failure: preserve failure evidence, stop new test actions, settle or
reconcile active writes, end owned sessions, restore if needed, remove temporary
overrides, verify return state and finalize evidence. Recovery tooling must work
even when the app under test fails. Qualify any dependency ordering before use;
do not invent a fallback while firmware is being written.

Use separate bounds for steps, human waits, settling and restoration. Timeouts do
not kill firmware operations. If the operator explicitly stops mutations, defer
restoration visibly and retain fixture unavailability. No automatic whole-routine
retry; each new destructive attempt has its own journal identity and must fit the
configured operation budget.

## Evidence layout

One ignored/private directory per run:

```text
run.json             # frozen redacted inputs and revisions
events.jsonl         # phase, action and assertion journal
state.json           # durable recovery checkpoint
result.json          # test, teardown, evidence and fixture outcomes
profiles/            # baseline/target/return and archived manifests
setup/               # exact commands, artifacts and baseline proof
test/                # MP4 segments, screenshots, AX snapshots, chapters
verification/        # independent expected/actual assertions
teardown/            # restoration and fresh return proof
hardware/            # physical and boot/session timeline
index.html           # phase results and searchable English video chapters
```

Immutable artifacts may live in a hash-addressed cache, but retain their identity
and resolvable references. Never garbage-collect recovery assets/backups while a
run is unfinished. Do not record secrets in argument arrays or command output.

The test recording covers the whole customer flow, including waits. Setup and
teardown footage are separate labeled segments. Map chapters to segment/time;
never conceal interruption gaps. Validate video duration/encoding, image dimensions
and chapter bounds with the existing verifier. Use the localhost HTTP viewer for
playback and seeking; a final acceptance run includes an actual playback check.

Local execution uploads nothing by default. Later CI/result integration retries
upload independently; a failed upload must not repeat a firmware test.

## Acceptance

- Wrong identity, artifact hash, permission readiness or unavailable recovery
  prevents setup before any mutation.
- A simulated crash after dispatch resumes by reconciling the operation rather
  than resending it.
- Partial setup and failed tests retain their original outcome through teardown.
- Failed restoration blocks a subsequent routine despite release of process locks.
- A real day-one upgrade has final manifest proof, usable recordings and a verified
  return state; another routine can then acquire the fixture and pass preflight.
