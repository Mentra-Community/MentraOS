# Miniapp camera resource lifecycle

## Scope

This change makes the two camera controls currently exposed to Mentra miniapps behave like
session-owned resources:

- camera warm-up
- camera FOV/ROI crop

ANR/gain tuning and the text-mode ML crop are out of scope. Persistent FOV changes made from the
Mentra App remain persistent user settings.

## Product rules

### Canonical FOV default

- The canonical missing/factory default is **102 degrees, centered ROI** on the phone, Bluetooth
  SDK, and ASG client.
- Existing persisted values are preserved. In particular, an existing value of 118 is not migrated
  because it may be an intentional wide setting.
- The `wide` preset remains 118 and the `standard` preset remains 102.

### Miniapp FOV/ROI override

- `camera.setFov()` creates or replaces a temporary override owned by the calling miniapp package.
- The override does not update the Mentra App settings store or ASG persistent preferences.
- The most recently applied live miniapp override wins. Closing a non-active owner only removes its
  saved override. Closing the active owner applies the next-most-recent live override, or restores
  the persistent base setting when none remains.
- The phone serializes override changes because each effective FOV/ROI change restarts the camera
  HAL and has a five-second readiness cooldown.
- The ASG client holds one effective transient override keyed by a lease ID. Releasing a stale lease
  is a no-op, preventing a delayed close from undoing a newer miniapp's override.
- A transient override has a safety TTL. Refreshing the same lease/configuration extends its TTL
  without restarting the HAL. Expiry restores the ASG persistent base setting.
- Miniapp teardown releases the override immediately. A phone/process failure is bounded by the
  safety TTL, and an ASG process restart/reboot restores the persistent base because transient
  state is memory-only.

Wire commands:

```json
{
  "type": "camera_fov_override",
  "request_id": "settings request id",
  "params": {
    "lease_id": "phone-owned lease id",
    "fov": 102,
    "roi_position": 0,
    "ttl_ms": 300000
  }
}
```

```json
{
  "type": "camera_fov_override_release",
  "request_id": "settings request id",
  "params": {"lease_id": "phone-owned lease id"}
}
```

Both commands settle through `settings_ack` with `setting=camera_fov_override`. A successful apply
ack is delayed until the HAL restart cooldown completes. A refresh or stale release can acknowledge
immediately because it does not change hardware.

### Camera warm-up lease

- The phone generates the warm-up request ID before sending the command and records
  `packageName -> requestId` before awaiting `ready`.
- Starting another warm-up for the same package cancels the prior lease first.
- `BluetoothSdk.stopCameraWarmUp(requestId)` sends `camera_warm_up_stop`.
- Miniapp unregister always calls `stopWarmUpForApp(packageName)`, including while the original
  warm-up promise is still waiting for the camera to open.
- ASG tracks ready warm-up leases by request ID. Compatible leases share the configured camera.
  Stopping or expiring one lease closes the camera only when no other compatible lease remains.
- An incompatible warm-up is rejected with `camera_busy` while another ready lease owns a different
  configuration. An overlapping request while the first camera open is still in flight is also
  rejected; callers may retry once the first request reaches `ready`.
- Stopping an opening request emits terminal `camera_status(state=error,
  errorCode=camera_warm_up_cancelled)`, so the original Bluetooth SDK promise rejects immediately.
  Stopping a ready request emits `stopped` for that request.
- Warm-up duration is capped at 60 seconds on both phone and glasses. The default remains 15
  seconds. Each ready lease expires independently.

Wire command:

```json
{"type":"camera_warm_up_stop","requestId":"phone-owned warm-up request id"}
```

## Teardown ordering

Miniapp unregister removes phone ownership immediately, then performs BLE cleanup asynchronously:

1. cancel its warm-up request, if present
2. remove its FOV/ROI override and reconcile the effective override
3. continue existing stream/video/audio/blob/display teardown

Cleanup is idempotent. Missing, expired, or already-replaced lease IDs succeed as no-ops.

## Validation

- Phone unit tests cover request-ID ownership, duration clamping, replacement, opening
  cancellation, expiry bookkeeping, FOV last-writer-wins behavior, stale release, and base restore.
- Bluetooth SDK payload tests cover the explicit warm-up request ID and new stop command surface.
- ASG unit/compile coverage verifies command routing, TTL clamping, cancellation semantics, and
  transient FOV defaults/lease behavior where the existing test harness permits.
- Android compile checks run for both `asg` and `bluetooth-sdk`; focused TypeScript tests run for
  engine and Bluetooth SDK changes.
