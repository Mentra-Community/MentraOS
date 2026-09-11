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
