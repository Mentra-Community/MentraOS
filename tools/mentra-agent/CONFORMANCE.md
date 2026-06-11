# SDK / cloud-runtime conformance run — example miniapp on Mentra Live

Setup: `sdk/example-miniapp` dev-served on :3130, installed in the Android
emulator app, glasses = real Mentra Live (DA08) attached through the
Remote Glasses bridge (RemoteHarness -> harness daemon -> BLE). Cloud =
AWS us-west-2 dev. Driven via CDP (tools/mentra-agent/cdp.ts).

| iface | status | notes |
|---|---|---|
| session.display | testing | Live has no display; checking graceful degradation |
| session.speaker | pending | TTS / play URL — cloud audio service |
| session.mic | pending | Live mic streaming is an open question |
| session.transcription | pending | known-good on G2; checking via Live path |
| session.translation | pending | |
| session.camera | pending | takePhoto on the REAL Live camera |
| session.stream | pending | managed/unmanaged RTMP |
| session.input | pending | touchpad/buttons (needs human tap; user AFK) |
| session.location | pending | emulator GPS |
| session.storage | pending | host-local |
| session.system | pending | |

## Infrastructure findings (count as conformance results too)

- **manager stale-protocol bug (fixed)**: reconnecting a different glasses
  family on the same daemon kept the previous family's protocol
  (`device = device || detected`); a Live was driven as a G2. Fixed: reset on
  every `start()`.
- **RemoteHarness stale-socket bug (fixed)**: after a daemon restart the app's
  reader hung forever and sends failed silently; send-failure now closes the
  socket so the reconnect loop engages.
- **app<->daemon TCP churn (root-caused + fixed)**: the app's glasses-mic
  watchdog (`checkAndReinitGlassesMic`, fires when no glasses audio for 5s —
  always true on a Live, whose mic doesn't stream) calls `setMicEnabled(true)`
  on the MAIN thread; the driver did socket I/O inline there, so Android threw
  `NetworkOnMainThreadException` (message: null) and the failure handler killed
  a healthy socket — reconnect, repeat every ~7s. The G2 masked it because its
  mic streams, keeping the watchdog quiet. Fix: all RemoteHarness socket writes
  go through a dedicated writer thread fed by a queue; callers never touch the
  socket. (Lesson for any SGC driver: SGCManager methods are invoked from the
  main thread; drivers must not do blocking I/O inline.)
- **Live mic silence (open product question)**: with no audio frames, the mic
  watchdog fires every 5s forever — re-sending mic-enable. Harmless once sends
  are queued, but the watchdog churn is itself a finding: a mic-less/mic-silent
  device keeps the reinit loop hot.
