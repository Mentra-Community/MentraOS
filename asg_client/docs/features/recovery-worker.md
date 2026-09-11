# Recovery Worker

The recovery worker is a headless companion APK (`com.mentra.recovery`) that keeps ASG alive when the main service crashes or fails to restart after an APK install.

## Responsibilities

- Send periodic ping heartbeats to ASG.
- Detect heartbeat timeout and enter reset mode.
- Attempt `ACTION_RESTART_SERVICE` first.
- If restart fails, reinstall `/storage/emulated/0/asg/asg_client_backup.apk`.
- Emit telemetry events back to ASG for reporting.

## State machine

- `HEALTHY`
- `SUSPECTED_DEAD`
- `RESTARTING`
- `REINSTALLING_BACKUP`
- `COOLDOWN`
- `FAILED_NEEDS_MANUAL`

## Start contract

ASG deploys the worker through the OEM installer, which leaves the package in Android's
"stopped" state until one of its components has run. Stopped packages receive no
broadcasts (the system adds `FLAG_EXCLUDE_STOPPED_PACKAGES` to every broadcast) and no
`BOOT_COMPLETED`, so a freshly deployed worker cannot wake itself. Every ASG-to-worker
intent (start request, install notifications, downgrade handoff) must therefore be built
with `RecoveryWorkerManager.newRecoveryIntent`, which adds `FLAG_INCLUDE_STOPPED_PACKAGES`;
the first delivered intent runs the receiver and clears the stopped state permanently.

## Backup contract

ASG writes:

- `/storage/emulated/0/asg/asg_client_backup.apk`
- `/storage/emulated/0/asg/asg_client_backup.json`

The recovery worker validates that backup APK package name is `com.mentra.asg_client` before reinstall.

## Integration points

- ASG deploy/start manager: `RecoveryWorkerManager`
- ASG ping responder: `ServiceHeartbeatReceiver`
- Telemetry sink: `RecoveryTelemetryReceiver`
- Recovery sidecar service: `com.mentra.recovery.service.RecoveryService`
