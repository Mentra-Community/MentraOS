# Mobile local runtime liveness

**Status:** Implemented mitigation in mobile host runtime.

## Problem

Local miniapps have two layers:

- a background JSContext that owns the `MiniappSession`, stream subscriptions,
  and cloud/local transcription fan-out;
- a foreground WebView that renders UI and hydrates from background snapshots.

The WebView can open successfully while the reused background JSContext is
stale. In that state the UI may show "cloud offline" or no captions, but the
root cause is not necessarily cloud connectivity. The background context is no
longer responding to runtime pings, so it cannot keep subscriptions alive or
fan transcripts into the UI.

## Evidence

Pixel 8 E2E on 2026-06-14 reproduced this sequence:

1. User closed Local Merge and opened Local Captions.
2. Local Captions WebView reached `connected=true`.
3. The app showed cloud offline / no transcription for about 30 seconds.
4. Logs showed repeated `QuickJSJni: Cannot get jni env because the vm is not cached`.
5. `LOCAL_MINIAPP: com.mentra.local-captions missed 6 pings, unregistering`.
6. Crash recovery killed and respawned the JSContext.
7. Local Captions reconnected, resubscribed to `transcription:auto`, restarted
   phone PCM, and cloud captions resumed.

The observed delay matched the background watchdog configuration:

- ping interval: `5_000 ms`;
- missed-ping threshold: `6`;
- worst-case recovery delay: about 30 seconds before respawn begins.

## Design Decision

Keep the normal watchdog generous. Background miniapps can be busy processing
interim transcription/translation traffic, and lowering the global threshold
would risk killing healthy contexts.

Add a separate foreground-open probe:

- when a local miniapp WebView binds or the app returns active, send an immediate
  runtime `PING` to the background JSContext;
- if no inbound message from that package arrives within a short timeout, treat
  it as the same liveness failure as the normal watchdog;
- unregister the app and route the package through `MentraJSRouter` crash
  recovery so it respawns with cached JS source, permissions, and manifest;
- re-open UI hydration through the existing `UI_OPEN` / `session.ui.onOpen`
  snapshot path.

This makes an actively viewed miniapp recover quickly while preserving the
safe background watchdog for non-foreground contexts.

## Implementation

- `LocalMiniappRuntime.probeForegroundLiveness(...)` sends the immediate ping and
  owns the timeout.
- `MentraJSRouter.probeForegroundLiveness(...)` gates probes to registered
  packages and keeps UI code away from runtime internals.
- `LocalMiniappView` calls the probe after WebView bind and when the app returns
  active. Its existing UI bridge refresh still re-announces `UI_OPEN` so
  background snapshots hydrate the WebView after recovery.

## Regression Coverage

Manual Pixel 8 E2E:

1. Start Local Captions and verify `Cloud captions` / `UDP audio`.
2. Force or reproduce a stale background JSContext.
3. Open the Local Captions WebView.
4. Expected: foreground liveness probe logs and either a quick PONG or a
   respawn within the probe timeout, not the older 30-second watchdog delay.
5. Speak a unique marker with laptop TTS.
6. Expected: marker appears in Local Captions; `PCM` and `Cloud V2: UDP` stay
   healthy after recovery.

Automated coverage should add a host-runtime unit test around
`probeForegroundLiveness` with fake timers:

- responsive app replies before timeout and is not unregistered;
- stale app times out and calls `onLivenessTimeout`;
- registering or unregistering the package clears any pending foreground probe.
