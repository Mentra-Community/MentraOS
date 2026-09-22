---
status: draft
owner: Philippe
---

# Routine definition and lifecycle

A routine owns its setup, English test steps, executable actions, assertions,
evidence and verified return state. A failed firmware test must not silently leave
the shared glasses unsuitable for the next routine.

Implement this contract in `tools/mentra-e2e/` in MentraOS, starting on the current
Mac. Migration to a private testing repository is deferred. Credentials, fixture
identities, firmware backups and raw run evidence remain outside Git.

This is a proposed extension to the existing runner. Existing semantic replay,
screenshots, chaptered video, command evidence and OTA version checks remain the
foundation; uniform firmware setup, restoration and durable fixture readiness are
not yet implemented. The [PR Mac importer](../../../tools/mentra-e2e/MAC-CI-SETUP.md)
now verifies a selected artifact and can install it with explicit opt-in; it does
not implement this lifecycle or certify all app permissions. Its live PR build
installation, launch and reuse of the existing Bluetooth grant passed on the
provisioned Mac. See the
[orchestrator](2026-09-21-routine-orchestrator.md),
[CI integration](2026-09-21-ci-routines-and-admin-results.md) and
[day-one OTA routine](../../../tools/mentra-e2e/DAY1-OTA-ROUTINE.md).

## Build and state contract

The selected Mentra App and its **effective OTA manifest** determine the target
BES, MTK and ASG artifacts. The normal return state is that same selected app,
those firmware versions and an idle, connected fixture. Do not independently
select another "latest firmware" or return to an arbitrary entry snapshot.

Setup may establish a different starting state. For the day-one test, that is the
qualified January baseline. Teardown restores the selected manifest's versions
after success, failure or cancellation. A separately selected known-good recovery
build is an explicit exception: it may recover the fixture but cannot qualify the
candidate or satisfy another routine targeting that candidate.

Resolve and archive the start, target and return profiles before mutation. The
return profile must have verified installable artifacts and a qualified recovery
procedure. A version string or device backup alone is not a recovery plan.

## Routine definition

| Part | Required contents |
| --- | --- |
| Identity | Stable routine ID, definition version/hash and source revision. |
| Coverage | User behavior tested and exact pass conditions. |
| Resources | Exclusive glasses, app/phone, host and browser/service sessions. |
| Inputs | Build selection, private fixture references, credentials by reference and operation/time budgets. |
| Preflight | Physical identity, host permissions, power, storage, tools, network and recovery availability. |
| Start profile | Independently verifiable state that setup must establish. |
| Setup | Ordered actions, assertions and safe partial-failure recovery. |
| Test | Stable step IDs, English instructions, executable actions and expected outcomes. |
| Final assertions | Independent proof of the tested behavior before restoration. |
| Return profile | Manifest-derived firmware/app state plus fixture readiness. |
| Teardown | Owned-resource cleanup, necessary restoration and fresh return checks. |
| Evidence | Required screenshots, video, command records, artifact identities and redaction rules. |

Use versioned TypeScript definitions and the existing Bun, Swift and Python
adapters. JSON supplies fixture and resolved artifact data. Do not introduce a
new workflow language. Once implemented, generate the English steps from the
same definitions so replay and documentation cannot drift.

## Execution and assertions

The lifecycle is preflight → setup → test → final assertions → teardown → return
verification. Freeze the test result before teardown changes the device. Partial
setup also requires teardown of whatever actually changed; cleanup must not assume
setup completed.

Each assertion records expected and actual values, observation time, result and
evidence source. Hardware assertions retain physical and boot/session identity
where available. Missing, stale or malformed evidence is not a pass. Human
audibility checks remain pending until answered; elapsed time is not confirmation.

Use semantic controls and stable accessibility identifiers. Improve the app when
a required control is inaccessible. Command actions save argument arrays, helper
revisions, exit status and redacted outputs. Successful command exit does not
replace an independent device postcondition.

Read-only assertions may poll within a bound. Mutating actions declare whether
they can repeat and how to recognize an already-running/completed operation.
Firmware installation defaults to no automatic resend. Resume reconciles actual
state instead of replaying previous actions blindly.

## Firmware safety and teardown

A test timeout or cancellation stops new test actions; it does not authorize
interrupting a firmware write. Observe or reconcile the existing operation until
safe recovery is established. Do not reboot, kill a writer or start another flash
as a timeout retry. If the outcome cannot be established, preserve evidence and
mark the fixture `recovery-required`.

Teardown removes owned sessions and temporary overrides, then restores the
declared return profile only when current state fails its checks. Verify physical
identity, BES, MTK, active ASG version/APK hash, boot completion, idle update state
and app connectivity. A successful final test should normally avoid another
firmware write because its target and return state already match.

Restoring "code" means installed firmware, ASG, app and routine-owned settings.
It does not reset unrelated Git worktrees, account state, media or host settings.
Respect an operator request to stop mutations: record deferred recovery and keep
the fixture unavailable rather than forcing restoration.

## Evidence and verdicts

Record setup, test, final verification and teardown as distinct phases. The
customer-flow recording includes permission waits and reconnects. Every observed
UI step gets a screenshot and English chapter; hardware-only actions explicitly
mark UI capture not applicable. Retain gaps and resumed segments honestly.

| Test | Return verification | Report | Fixture |
| --- | --- | --- | --- |
| Passed | Passed | Passed, if required evidence is complete | Ready |
| Failed | Passed | Failed; restored | Ready |
| Passed or failed | Failed/unknown | Failed; recovery required | Unavailable |
| Not run | Passed after setup failure | Setup failed | Ready |
| Cancelled | Passed | Cancelled; restored | Ready |

Restoration never turns a failed test into a pass. Recording/upload failure may
leave verified hardware ready while the run remains incomplete. The next routine
always checks its own prerequisites; shared firmware readiness does not establish
Call admission, Bluetooth audio pairing or two-way audibility.

Acceptance requires a complete recorded day-one upgrade, independent manifest
checks, verified return state, and a controlled lifecycle failure exercise. Test
crash/recovery logic with simulated operations; never interrupt a real firmware
write merely to exercise teardown.
