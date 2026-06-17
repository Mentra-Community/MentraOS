# Audio E2E fault harness

The audio fault harness makes the phone-driven Local Captions QA loop
repeatable. It does not replace integration tests; it captures the faults that
only show up with the real mobile app, real mic/fallback path, and real miniapp
UI history.

## Command

From `cloud-v2`:

```bash
bun run fault:e2e preflight --target local --host <mac-lan-ip>
bun run fault:e2e cloud-down-up --target local --host <mac-lan-ip>
```

Artifacts are written to `/tmp/mentra-audio-faults/<timestamp>-<scenario>-<target>`
unless `--artifacts` is supplied. Each run contains:

- `run.md`: phases, commands, screenshots, and pass criteria.
- `logcat.log`: full Android logcat from the run.
- `*.png`: screenshots after each phase.
- `managed-cloud.*.log`: cloud logs if the harness restarted the local stack.

## Local target

The normal local run expects:

- Pixel connected and authorized with ADB.
- Metro running on `8081` for the dev build.
- Local Captions dev server running on `3100`/`3101`.
- `mobile/.env` pointing the app at the Mac LAN host for core/runtime.
- Cloud-v2 already up for `cloud-down-up`, or intentionally down for
  `cloud-starts-late`.

The harness sets ADB reverse for `8081`, `3100`, `3101`, core, and runtime by
default. Disable with `--adb-reverse=false`.

For `cloud-down-up`, the default local fault injection kills the process
listening on the runtime HTTP port. The default recovery command starts
`scripts/dev-stack.ts` under Doppler with Soniox enabled:

```bash
doppler run -- env \
  MONGO_URL=mongodb://127.0.0.1:27017/cloud-v2-phone-e2e \
  REDIS_URL=redis://127.0.0.1:6379/7 \
  AUDIO_PROVIDER=soniox \
  DEV_CORE_PORT=3000 \
  DEV_RUNTIME_HTTP_PORT=3001 \
  DEV_RUNTIME_UDP_PORT=8000 \
  DEV_TEST_OEM_PORT=3102 \
  DEV_UDP_ADVERTISE_HOST=<mac-lan-ip> \
  bun scripts/dev-stack.ts
```

Override this with `--local-start-command` or `MENTRA_FAULT_LOCAL_START_CMD`
when testing a different local stack shape.

## Porter target

Porter runs are black-box by default: the harness can preflight public health
URLs, capture phone logs/screenshots, speak markers, and run caller-provided
fault hooks.

```bash
bun run fault:e2e cloud-down-up --target porter \
  --core-url https://<core-dev-host> \
  --runtime-url https://<runtime-dev-host> \
  --miniapp-url http://<mac-lan-ip>:3100 \
  --down-command '<porter-or-kubectl-command-that-stops-runtime>' \
  --up-command '<porter-or-kubectl-command-that-restores-runtime>'
```

Keep Porter hooks narrow. Prefer restarting only the runtime/audio service when
testing transcription recovery; use a broader core/runtime outage only for
auth/session fault coverage.

## Scenarios

### `preflight`

Checks ADB, the app package, core health, runtime health, and Local Captions
dev-server reachability. Use this before burning time on a phone run.

### `cloud-down-up`

1. Speak online marker A.
2. Inject cloud/runtime down.
3. Speak offline marker B.
4. Restore cloud/runtime.
5. Speak online marker C.

Pass criteria:

- A, B, and C are visible as separate final entries.
- B appears exactly once.
- C appends after B and does not replace A or B.
- Logs show cloud down/up state transitions and subscription recovery.

### `cloud-starts-late`

1. Inject or confirm cloud/runtime down.
2. Speak offline marker B.
3. Restore cloud/runtime.
4. Speak online marker C.

Pass criteria:

- Offline fallback works even though the first cloud connect failed.
- The client reconnects after cloud appears without app restart.
- Online recovery does not duplicate or rewrite the offline final.

### Planned UDP liveness scenarios

These are required by the dedicated cloud-client UDP liveness issue:
[`004-cloud-client/udp-liveness-fallback`](../../004-cloud-client/udp-liveness-fallback/).
They should become first-class harness scenarios, not one-off manual checks.

- `udp-blocked-ws-fallback`: keep runtime WebSocket healthy, block UDP ingress,
  verify cloud audio switches to WS and captions continue.
- `udp-restored-switchback`: restore UDP while WS fallback is active, verify the
  first UDP ack switches audio back to UDP without duplicate captions.
- `ws-down-udp-down`: block both WS and UDP, verify cloud audio transport is not
  falsely reported as usable and local/offline fallback can take over.
- `session-reconnect-resets-probes`: restart runtime/audio while captions are
  active, verify new session probes and transport state replace old state.

## Coverage boundary

This harness deliberately captures evidence instead of pretending it can fully
assert UI history today. The next upgrade should add one of:

- app-side test telemetry from Local Captions with transcript IDs/source/order;
- OCR over screenshots;
- a miniapp test mode that exports transcript history over the dev sidecar.

Until then, keep the marker phrases distinct and review the screenshot plus
`logcat.log` for every run.
