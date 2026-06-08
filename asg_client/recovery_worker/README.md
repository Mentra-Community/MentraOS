# Mentra Recovery Worker

`recovery_worker` is a headless Android sidecar (recovery worker APK) that keeps `com.mentra.asg_client` alive.

## Responsibilities

- Sends heartbeat pings to ASG.
- Detects sustained heartbeat loss and enters recovery state.
- Attempts service restart first.
- Falls back to reinstalling `/storage/emulated/0/asg/asg_client_backup.apk`.

## Package identity

- App id: `com.mentra.recovery`
- Service: `com.mentra.recovery.service.RecoveryService`

## Build and bundle

```bash
cd asg_client/recovery_worker
./build_and_deploy.sh
```

This builds `app-release.apk` and copies it to:

- `asg_client/app/src/main/assets/recovery_worker.apk`

The ASG app deploys this asset through `RecoveryWorkerManager`.

## Validation checklist

1. Verify package is installed:

```bash
adb shell pm list packages | rg "com.mentra.recovery|com.augmentos.otaupdater"
```

2. Verify service running:

```bash
adb shell dumpsys activity services | rg "com.mentra.recovery"
```

3. Verify backup file exists:

```bash
adb shell ls -lh /storage/emulated/0/asg/asg_client_backup.apk
```

4. Trigger recovery by killing ASG and inspect logs:

```bash
adb shell am force-stop com.mentra.asg_client
adb logcat | rg "MentraRecovery|RecoveryWorker|RecoveryService"
```
