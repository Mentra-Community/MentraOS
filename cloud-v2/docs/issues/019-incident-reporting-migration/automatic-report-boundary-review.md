# Automatic Report Boundary Review

**Status:** Implemented

## What We Are Doing

We are separating the public OEM-facing engine API from MentraOS/runtime
automatic diagnostics.

## Grounding: Engine vs Host

The engine is the reusable MentraOS runtime layer that an OEM host app embeds.
It should provide the smartglasses operating-system primitives: device
connection, pairing state, miniapp runtime, gallery/device coordination, cloud
session plumbing, settings sync, diagnostic context collection, log/artifact
collection, and Cloud V2 client calls.

The host is the OEM-branded app shell around that runtime. It should provide
screens, navigation, wording, alerts, visual states, branded support flows,
rating controls, screenshot picker UX, and host-specific telemetry sinks such
as Sentry. A Mentra-branded host may have extra internal screens or test
harnesses, but those are still not part of the public OEM engine contract.

This separation matters because OEMs should not need to understand MentraOS
internal state in order to brand or render the app. If the host pulls runtime
state out of engine, constructs an internal diagnostic payload, then pushes it
back into engine/cloud, the boundary has failed. The clean API should let the
host say "the user submitted this bug report" or "the user submitted this
feedback"; engine should decide how to collect OS context, logs, glasses
state, artifacts, local throttling keys, and Cloud V2 records.

For automatic reports, the case is even clearer: there is no user-authored
form. Automatic reports are created because the runtime observed an OS
condition. That observation, classification, throttling, and submission should
live inside the engine/runtime layer, not in OEM UI code calling a generic
public `kind: "automatic"` report API.

This document records the automatic-report call-site review that drove the
implemented host/engine boundary.

The current branch has a single report model in Cloud V2, which is still the
right backend shape:

- `kind: "bug"` for user bug reports.
- `kind: "feedback"` for feature/general feedback.
- `kind: "automatic"` for runtime-detected failures.

The boundary question is not whether Cloud V2 can store automatic reports. It
is whether OEM/host UI should be able to call a generic
`engine.reports.submit({ kind: "automatic" })`.

Proposed rule:

- Public `engine.reports` should expose only user/OEM-authored submissions:
  manual bug reports and feedback.
- Island/engine internals should own automatic report detection, diagnostic
  context, local throttling, log/screenshot/glasses-log collection, Cloud V2
  submission, and completion.
- Host/OEM code should own UI, copy, navigation, branded alerts, prompts, and
  host-specific telemetry sinks such as Sentry.

The five current automatic-report paths below are the places we need to review
before changing the public engine surface.

## Original Inventory

| Area | Current location | Trigger | What it observes |
| --- | --- | --- | --- |
| MentraJS crashloop | `mobile/src/services/mentraJsBootstrap.ts` | `miniapp_crashloop` / `mentrajs_crashloop_disabled` | Miniapp JS runtime enters crashloop-disabled state. |
| Miniapp start failure | `mobile/src/services/bugReport/miniappStartBugReport.ts` | `miniapp_launch` / `miniapp_start_failed` | A miniapp start request fails with an Axios/HTTP/runtime error. |
| Pairing boot timeout | `mobile/src/app/pairing/loading.tsx` | `pairing_loading` / `glasses_connect_timeout` | Pairing screen waits 35s and glasses never report fully booted. |
| Gallery video playback | `mobile/src/services/bugReport/galleryVideoPlaybackBugReport.ts` | `gallery_video` / `gallery_video_on_error` | Host gallery video player gets a playback error. |
| Captions tester laptop report | `mobile/e2e-tests/scripts/live_word_monitor.py` -> internal Crust receiver -> island engine service | external monitor alert / `captions_tester_incident` | Laptop e2e harness decides a captions test failed and asks the app runtime to file a report. |

## 1. MentraJS Crashloop

Original behavior:

- `bootstrapMentraJS()` calls `ensureMiniappEngine()`.
- It attaches `router.onCrashloop` and `router.onRestartToast`.
- On crashloop it snapshots recent miniapp logs, sends a Sentry event, files an
  automatic report, and shows a user alert.

Original ownership:

- Island already owns the MentraJS engine, crash controller, JS router, UI
  router, Crust binding, and log ring.
- The host shim owns Sentry tags/breadcrumbs and alert copy.
- The automatic report was filed from host code through the public
  engine reporting surface.

Judgment:

- Automatic crashloop report filing belongs in island, next to
  `MiniappEngine` / `MentraJSRouter`.
- Host-specific Sentry reporting and branded/user-facing alert copy can remain
  host-owned.
- The router should support island internal reporting and host callbacks without
  forcing host code to be the automatic-report caller. A small event/listener
  shape is cleaner than one host-owned `onCrashloop` callback doing everything.

Implemented move:

- Add an island-internal automatic report service.
- Have `MentraJSRouter` or `MiniappEngine` file the automatic report when the
  crash controller surfaces crashloop-disabled.
- Keep or replace the host callback so the Mentra app can still send Sentry
  events and show an alert.
- Remove `submitAutomaticBugReport` from `mentraJsBootstrap.ts`.

## 2. Miniapp Start Failure

Original behavior:

- `submitMiniappStartFailedBugReport()` serialized Axios errors and built a
  `miniapp_start_failed` automatic report payload for the old online miniapp
  start path.
- It records phase, package name, app name, HTTP status/code, response data, and
  whether the error was `NO_ACTIVE_SESSION`.
- On `dev`, this helper is called by `MiniappCatalog` when
  `restComms.startApp()` fails for online/cloud miniapps:
  - `retryStart()` reports `phase: "retry_start"`.
  - `beforeStart()` reports `phase: "initial_start"`.
- On `aisraelov/island-namespace-wifi`, a grep found only the helper
  definition and no callers, which matches the removal of the Cloud V1 miniapp
  start path.
- The problem this helper reported does not exist for miniapps v2.

Original ownership:

- The `dev` callers belonged to host `MiniappCatalog`, which owned the legacy
  RestComms/cloud miniapp start glue.
- The helper used Axios-specific error serialization because the failing path was
  a REST start request.
- The island-namespace branch removed the caller path as miniapp lifecycle moved
  to the v2/island runtime.

Judgment:

- For `dev`, this is a real legacy Cloud V1/RestComms online-miniapp start
  diagnostic, not dead code.
- For the island-namespace / miniapps v2 target, the Cloud V1 online miniapp
  start path is gone and the underlying problem no longer exists.
- The helper should be deleted rather than moved.
- We should not preserve this as a public engine use case.

Implemented move:

- Delete `mobile/src/services/bugReport/miniappStartBugReport.ts`.
- Do not add a replacement automatic report for miniapps v2 unless a new,
  island-owned failure mode is identified later.

## 3. Pairing Boot Timeout

Original behavior:

- The pairing loading screen calls `waitForGlassesReady()` with a 35 second
  timeout.
- If it times out, the screen files an automatic report with device model/name,
  route, elapsed time, and whether the booting state was shown.
- The same screen owns navigation to success/failure and troubleshooting UI.

Original ownership:

- Island owns the readiness predicate and wait primitive.
- The host screen owns navigation, UI state, copy, and troubleshooting.
- The automatic timeout report was in host UI code.

Judgment:

- The timeout detection/reporting is OS pairing lifecycle logic and should move
  into island.
- The screen should remain responsible for rendering "booting", failure, and
  troubleshooting UI.
- The host may need to pass UI route/display metadata if island cannot derive
  it, but it should not build or submit the automatic report.

Implemented move:

- Move the pairing boot timeout watch into an island pairing coordinator or
  pairing service.
- Have island file the automatic report when a pairing session exceeds its boot
  budget.
- Expose host-facing pairing state/events for UI transitions, not a generic
  automatic report call.

## 4. Gallery Video Integrity Failure

Original behavior:

- The host gallery viewer's video component handles `onError`.
- It updates UI error state, serializes the React Native video error, computes a
  repeat-suppression key, and files an automatic report.
- The existing island gallery validators catch pre-playback integrity failures:
  missing files, zero-byte files, expected-size mismatches, and invalid first
  bytes/container signatures.
- They did not prove that the entire video could be parsed and decoded by the
  platform player. The original `gallery_video_on_error` report was therefore a
  player-observed failure, not a general pre-playback corruption detector.

Original ownership:

- Host owns the concrete gallery screen and video player UI.
- Island already owns much of the gallery sync/storage/media pipeline.
- Download/storage integrity validation belongs in island and already runs before
  persisted gallery metadata is exposed.
- Decode/playback failure was detected in UI because the
  `react-native-video` component is host-rendered.

Judgment:

- The current playback-error report is a workaround, not the target design.
- Host UI should keep player error UI: stop playback, show the error message,
  and decide how the screen looks.
- Host UI should not call a engine reporting entry point for gallery playback
  failures.
- Island/engine should own video health validation and any automatic report
  submission for gallery media integrity failures.
- To catch decoder-level corruption before the user opens playback, island needs
  a native media-probe capability; the current sync validators cannot answer
  that question.

Implemented move:

- Keep only lightweight transfer-safety checks in the blocking sync path:
  existence, non-zero size, expected byte count/checksum when available, and a
  cheap container signature.
- Replace the host playback-error automatic report with an island-owned,
  non-blocking gallery media health probe that runs after download/processing.
- Have island file an internal automatic report when that background probe marks
  a video invalid.
- Delete the host `submitGalleryVideoPlaybackBugReport` path rather than
  replacing it with any engine reporting API.
- Keep visual error handling in the gallery screen.
- Separately decide whether island should add a native video probe
  (`MediaMetadataRetriever` / `AVAsset`-style) during gallery sync. That would
  make pre-playback decode validation possible, but it should run outside the
  user-visible sync critical path because it has battery and codec-compatibility
  tradeoffs.

Research note:

- "Valid media" has several layers: expected bytes, parseable container,
  playable tracks/codecs on this device, and full-stream decodability.
- The current size/header checks cover only the first two layers lightly.
- Android's native stack gives us progressively stronger checks:
  `MediaExtractor` can demux the file and expose tracks/formats,
  `MediaMetadataRetriever` can extract metadata/frames, and `MediaCodec` can
  actually decode samples.
- iOS gives the same shape through AVFoundation: async `AVAsset` inspection for
  playability/tracks/duration, `AVAssetImageGenerator` for frame extraction, and
  `AVAssetReader` for sample-level reads.
- Recommended product shape: island should run a native video probe from a
  low-priority background queue after download/processing. Start with container
  plus metadata plus first/near-end frame extraction. Store media health as
  `unknown` / `valid` / `invalid`; newly synced videos can appear immediately as
  `unknown`, and the probe can later mark/report invalid files without delaying
  the sync completion UI. UI playback `onError` should remain UI-local; escaped
  failures can be captured by manual bug reports through normal log collection.

## 5. Captions Tester Laptop Report

Original behavior:

- `MantleManager` listens for Crust `captions_tester_incident` events.
- It extracts failure/test metadata, files an automatic report, and logs a
  `CAPTIONS_TESTER_INCIDENT_RESULT` JSON line for the test harness.
- The Android internal Crust module registers a
  `com.mentra.CAPTIONS_TESTER_INCIDENT` broadcast receiver. The e2e live-word
  monitor sends that broadcast when its own alert thresholds trip.
- That means the laptop test harness owns the failure decision, but the current
  implementation routes report submission through host `MantleManager`.
- The monitor also tails `adb logcat` for React Native `E2E_METRIC` lines; today
  it primarily consumes `display_store_update` metrics, not raw Cloud V2
  transcript events.
- Cloud V2 transcript delivery is already inside island/engine:
  `@mentra/cloud-client` receives `stream.transcript`, `CloudClientService`
  re-emits it via `onTranscript`, and `LocalMiniappRuntime` forwards it to
  subscribed local miniapps as `transcription:<lang>`.
- Legacy Cloud V1 transcript/data-stream delivery is intentionally not used for
  local miniapps: `SocketComms` drops v1 `data_stream`, and
  `sendLocalTranscription()` is a no-op compatibility stub.

Original ownership:

- The laptop e2e monitor owns captions-test failure detection and report-filing
  policy/triggering.
- Island/engine owns app-runtime report submission once the Android Intent has
  entered the app process.
- Raw Cloud V2 transcript events belong to island's Cloud V2 runtime path.
- Transcript test logging is an internal/e2e diagnostic concern, not OEM host UI.
- The existing Crust broadcast path is an Android/internal test harness bridge,
  not the source of transcript truth and not a reason for `MantleManager` to own
  report submission.

Judgment:

- This is not an OEM-facing engine report API use case.
- It is still an app-runtime automatic-report use case once the Android Intent is
  received: the trigger is external/test-only, but the runtime owns collecting
  diagnostic context, phone logs, glasses notification, and the Cloud V2 call.
- The useful mobile surface is a stable logcat marker for Cloud V2 transcript
  events, emitted inside island from `CloudClientService.onTranscript`.
- Gate the log behind the existing e2e/dev logging switch, or a more specific
  transcript-test switch, so normal builds do not log user speech.
- The test harness can keep its own alert bookkeeping by reading the existing
  `CAPTIONS_TESTER_INCIDENT_RESULT` log line emitted after engine submission.

Implemented move:

- Delete the host `captions_tester_incident` automatic-report listener from
  `MantleManager`.
- Keep the internal Crust broadcast/Android Intent as the test-harness trigger.
- Add an island-internal `captions_tester_incident` listener started by
  `engine.start()`.
- Have that listener submit an automatic Cloud V2 report through the island
  reports service and emit the existing `CAPTIONS_TESTER_INCIDENT_RESULT` logcat
  marker for the laptop monitor.
- Add an island-internal Cloud V2 transcript diagnostic logger next to
  `CloudClientService` / `LocalMiniappRuntime`, using the typed
  `TranscriptionData` payload.
- Emit a JSON logcat line such as
  `E2E_METRIC {"event":"cloud_v2_transcript", ...}` with fields needed by the
  monitor: text, final/interim state, resolved language, utterance id, timing,
  provider, and timestamp.
- Update the e2e live-word monitor to consume that marker if it needs raw
  transcript timing in addition to existing display-store metrics.

## Proposed Public Boundary

Public `engine.reports`:

- `submit({ kind: "bug", trigger, report, screenshots? })`
- `submit({ kind: "feedback", feedback })`

Not public:

- `submit({ kind: "automatic", ... })`
- raw `addLogs`
- raw `addScreenshots`
- raw `complete`
- raw diagnostic context collection
- glasses log notification

Internal island reporting service:

- `submitAutomaticReport(...)`
- local automatic throttling
- diagnostic context collection
- recent phone logs
- screenshot/artifact upload when relevant
- glasses notification and completion

Cloud V2/core:

- Keep `kind: "automatic"` in the REST/client model because automatic reports
  are real backend records.
- Treat automatic report submission as a device runtime/internal client use, not
  an OEM UI facade.

## Suggested Review Order

1. MentraJS crashloop: clearest island-owned runtime diagnostic with host-owned
   Sentry/alert side effects.
2. Miniapp start failure: likely delete or move into island miniapp lifecycle.
3. Pairing boot timeout: move reporting into island pairing lifecycle while
   leaving UI/navigation host-owned.
4. Gallery media integrity: keep UI playback errors local; move media health
   validation/reporting into island.
5. Captions tester laptop report: remove MantleManager report submission, keep
   the Android Intent trigger, have island/engine file the report, and add the
   Cloud V2 transcript log marker the monitor needs.
