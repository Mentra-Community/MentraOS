---
status: active
owner: Philippe
---

# OTA ownership when paired glasses change

A phone retained the approved release range and downgrade permission after an APK
handoff failed. After forgetting that pair and pairing older glasses, a fresh check
correctly offered an upgrade, but the flow displayed the previous pair's source
version. The install watchdog bounds the attempt; it does not retire the separate
process-local auto-chain approval kept for retry.

## Ownership boundary

The current native default device owns the phone's OTA state. Use the public SDK
`getDefaultDevice` and `default_device_changed` event so full Engine and
Bluetooth-only hosts behave alike. Deduplicate by model and platform address (or
the SDK's stable opaque device ID). Ignore link state, RSSI, ASG version and ASG
process session changes: the same pair must survive APK/MTK/BES restarts.

A changed or forgotten default advances an internal revision. Forgetting and
selecting the same pair also requires new approval. Invalidate the release range,
downgrade approval, selected check, progress, pending start ownership, watchdogs,
and MTK filtering. Stop coordinator reactions before clearing the OTA store.
Refresh the mounted flow for the new glasses. Fence asynchronous checks and
hotspot preparation before publishing state or sending another BLE command.
Join cancelled hotspot preparation before releasing its phone network/server and
artifacts; cleanup must never disable the replacement glasses' hotspot.

Public OTA controller, state, screen and options types remain unchanged. Ownership
is internal; hosts continue using the existing flow-level API.

## Recovery failure in the supplied archive

Both attempts downloaded and verified the complete APK, entered installation, then
reported `downgrade_handoff_failed` after 180 seconds. The old source client remained
installed. This establishes a missing recovery handoff verdict, not a download or
MTK failure. The glasses-side log no longer contains the failing interval, so it
does not establish whether the worker was stopped, unavailable, or failed delivery.

Staging already includes #4355: recovery v11 readiness/status queries, specific
availability errors, durable handoff ownership, restart reconciliation and reuse
of a verified unclaimed APK. #4356 preserves terminal failure across disconnect
and restart. Do not duplicate those changes or claim this phone-only patch repairs
an old source client. That pair needs a signed source bridge with v11, or an
explicitly authorized signed-worker repair. Installing fixes only in a lower OTA
target cannot repair the source that must first hand off that installation.

## Validation and remaining qualification

Unit tests cover failed A -> B pairing, forget -> same pair, duplicate identity,
same-pair reboot, hydration races, deferred manifest/version responses, pending
start rejection, and cancelled download/network staging. Existing legacy chaining
coverage must continue to pass, including withholding Update Complete until the
selected release has been checked after rescue.

The pinned `routine:day1-ota` definition and implementation at harness revision
`90a70edfe2fa17fd766dda3d98977555d6608a05` cover a single-pair iOS-on-Mac customer
sequence and restoration. They do not cover a two-pair Android switch. Defer its
label until the separate firmware fixture authorization and finite attempt budget
are known. Add reviewed coverage that approves a failed attempt on pair A, forgets
A, pairs B, verifies B's fresh release labels and explicit approval requirement,
then verifies same-pair reboot continuity. Setup records both identities and
versions; teardown restores pairing and settles any active updater; recovery must
never start a replacement attempt while a device-side writer is unresolved.

The captured hardware establishes the incident, not qualification of this patch.
No CEO device software was changed. Raw logs, identities and screenshots remain
outside the public repository.
