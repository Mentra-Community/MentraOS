# Android NIMO resource lifecycle diagnostics

This debug-only fixed control surface is intended for the existing owned harness
provider command path. It does not reserve hardware. The caller must already own
the exact NIMO resource (or both dependent lanes during commissioning), original
app process and deadline. No receiver or commands are exposed in release builds.

The action `com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE` requires Android's
`android.permission.DUMP` sender permission. Supported extras are only:

- `mode`: `status` or `release`.
- `nonce`: lowercase canonical UUID, unique per request.
- `expectedAddress`: uppercase Bluetooth MAC, used only to validate an already
  observed original NIMO peer; it is never passed to a connect or discovery API.
- `instanceId`: original NIMO instance UUID. Required for release; optional for
  first passive status inspection.
- `sessionGeneration`: original instance's native GATT connection generation
  (long). Required with instanceId and required for release.

Evidence is written only under the app's private
`files/nimo-lifecycle/<nonce>.json`. Caller paths, arbitrary bytes, commands,
firmware addresses, reset, bond and radio inputs are rejected. A repeated nonce
cannot repeat an operation or overwrite its original evidence. A missing receipt
is unknown, never success. The harness must bind exact original app build/process,
request nonce, pair, instance and session generation to its existing operation
receipt, collect the exact evidence bytes and apply its ordinary custody rules.

The version 1 receipt contains request echo, process-instance UUID/PID, current
manager type/instance identity and an exact original session snapshot. Status does
not scan, ping, reconnect, query firmware or stop a global scanner. Bounded old
session tombstones remain queryable after replacement; their original observation
time is retained and `sessionObservationCurrent` is false after the live instance
is gone. A fresh envelope/current-manager read does not renew a tombstone's facts.

Session snapshots expose queued GATT writes/descriptors, posted writes, pending
canvas commands/encodes, audio workers/packets, pending ACKs, initialization and
reconnect state. Fresh TWS and successful correlated set-time ACK times are bound
to the original native generation; set-time includes a local command UUID and
actual GATT write-start time. The protocol itself has no wire request UUID.
Callbacks from an older GATT bearer cannot update current session readiness.

Release refuses a missing, replaced or generation-mismatched instance and never
calls a generic disconnect on the current manager. It stops only the admitted
NIMO producers, cancels its initialization/reconnect timers, invalidates encodes,
requests the fixed mic stop command and serializes Dynamic Exit behind existing
canvas work. It waits for actual queue/worker settlement and the existing mic
TYPE_STOP marker when a mic characteristic exists. If canvas ownership was active
or in flight it also waits for its complete correlated Dynamic Exit ACK.

The parser's complete `[0x52,0x00,0x00,0x00]` uplink packet is recorded separately
from stop-write start/completion. It is the documented stop marker, not proof of
physical silence. Canvas Exit ACK is command acceptance, not visible-panel proof.
The exact GATT disconnect/close call, exceptions and separately observed callback
are recorded. Native Classic ACL state, physical mic silence, visible panel and
physical bond state remain unknown and require separately qualified per-peer
readback. No Android ANCS transport is managed by this adapter.

A 15-second drain timeout or transport abort leaves a sticky unknown-effects flag,
even if counters later fall to zero. Such a release cannot manufacture a passing
idle check. Closing the original GATT does not call unpair, factory reset or radio
controls. The telemetry distinguishes whether this instance ever requested an
explicit product unpair/reset; it does not infer unchanged physical bond state.

The current DeviceManager supports one SGC and one shared glasses state. It
explicitly cleans up a prior G2 communicator when changing to NIMO, so concurrent
G2 and NIMO sessions in the same Android app are unsupported. Resource release can
preserve G2 on a separate controller/app, and refuses to touch a replacement G2 in
this process. This change does not implement multi-device product routing.

Native compile/Robolectric and normal CI must pass before publishing a candidate
app for hardware commissioning. Source seam tests do not establish firmware
behavior, compatible cross-host reuse, physical idle or installed app provenance.

Reconnect and duplicate release requests remain fenced through the short native
callback observation window and completion callback. The original generation's
receipt is captured as a detached value before delivery, so a later connection
cannot be relabeled as evidence for the earlier request nonce.

Pre-connect capture source follow-up (not hardware qualification): fixed `arm-capture`,
`capture-status`, and `cancel-capture` requests add only comparison-bound `expectedName`
and `captureNonce` to the existing DUMP receiver. One capture exists per app process;
arm acknowledgement and generation-zero admission are separate immutable files. Admission
pins the actual current NIMO instance before discovery/connect effects. The native capture
allows only the existing exact bonded peer and one transport start; it never creates a
bond. Cancellation fences late NIMO admission before draining the original instance, and
can cancel an admitted generation-zero attempt. G2/replacement managers refuse targeted
cancellation and NIMO manager selection is refused before the existing global disconnect.
No-admission cancellation is a process-lifetime fence, rather than a claim that a future
queued connect cannot occur. Expected pair is separate from observed pair; gen-zero has
no observed peer. Off-main diagnostic admission fails closed. Release builds keep no-op
hooks and expose no receiver. A stopped reconnect runnable cannot repost itself.

The harness preflight remains disabled until this capture protocol and its owned transport
are reviewed and tested together. Native unit CI and actual compiled diagnostic APK proof
remain required before any candidate admission. No device action or firmware query was
performed for this source change.

Captured debug SDK connect/default/startScan and their DeviceManager/NIMO entry points
now serialize the entire entry on the main queue, including calls initiated before arm.
This guards SDK-level cancel/default/pending writes before lower manager mutation. A
cancelled or replaced target returns before those writes. Release hooks remain no-op.
The queued SDK-connect/cancel/G2 regression verifies that the replacement and saved
identity stay untouched. This supersedes the earlier off-main diagnostic refusal note.

Only the `nimoDiagnostic` SDK variant now requires a fixed arm before any NIMO SDK,
manager, discovery/connection admission, or peer/transport action. G2 and ordinary
debug/release policy are unchanged. Arm requires a null current manager; an existing
quiescent NIMO is deliberately not adopted. Fresh capture receipts expose
`captureRequiredBeforeArm` so the owned parser refuses an ordinary debug SDK or old
candidate. The compiled capture admission proof must attest this diagnostic policy,
not infer it from a generic receiver marker. JVM tests cover policy inputs and existing
manager refusal; actual diagnostic DEX proof remains a separate required build gate.

Formal review corrections retain the original captured scan instance through both
SDK cancel-existing and manager scan-to-connect transitions. Repeated connect
requests cannot discard the admitted instance. A permission-safe peer observation
precedes capture guards; ordinary permission revocation also settles a failed
GATT open without an uncaught exception. An explicitly rejected initial Canvas
Launch removes only its never-entered Exit obligation; status 2 remains unknown
and no Exit ACK or visible-panel claim is fabricated. New transport generations
clear old mic/display release obligations, while mutation evidence survives the
current connection attempt and resets only before a subsequent explicit attempt.
Regression source covers the actual SDK scan-to-manager connect path and original
cancellation, permission revocation, launch rejection/ambiguity and generation
reset. Exact Android CI is required before qualifying this source.
