# Spike: Audio Playback Infinite Loop on Mentra Live

## Overview

**What this doc covers:** The full end-to-end architecture of `session.audio.playAudio()` and `session.audio.speak()`, and a detailed investigation of why those calls cause audio to loop indefinitely on the Mentra Live until the app is force-stopped.
**Why this doc exists:** Reported 2026-03-23 by Aryan. All mini apps using `playAudio()` or `speak()` are affected. The looping state is unrecoverable without a force-stop — no SDK call, no app disconnect, nothing short of killing the MentraOS process breaks it.
**Who should read this:** Mobile engineers (the bug lives in the native Android audio layer), cloud engineers (understanding where the system goes silent), and anyone building or debugging mini apps that use audio.

---

## Background

The Mentra Live is a Android-based wearable. Its companion mobile app (the MentraOS app, `com.mentra.mentra`) runs on the user's Android phone. Mini apps (TPAs) run as cloud processes — they connect to the MentraOS cloud over WebSocket and send commands. The cloud relays those commands to the mobile app. The mobile app physically plays audio through its own speaker or the phone speaker.

Audio from `playAudio()` and `speak()` plays on the **phone**, not on the glasses hardware. The glasses are not involved in audio playback for these SDK calls.

---

## Full Architecture: How `playAudio()` Works

### Step 1 — Mini app calls the SDK

```typescript
// In the mini app (TPA server process)
await session.audio.playAudio({audioUrl: WELCOME_SOUND_URL})
```

The SDK builds an `AUDIO_PLAY_REQUEST` WebSocket message and sends it to the cloud:

```typescript
// cloud/packages/sdk/src/types/messages/app-to-cloud.ts
export interface AudioPlayRequest extends BaseMessage {
  type: AppToCloudMessageType.AUDIO_PLAY_REQUEST
  packageName: string
  requestId: string // SDK-generated: "audio_req_{timestamp}_{random}"
  audioUrl: string
  volume?: number
  stopOtherAudio?: boolean
  trackId?: number
}
```

The SDK promise is pending — it resolves only when the cloud sends back a completion response.

For `speak()`, the SDK first calls the cloud's `/api/tts` HTTP endpoint (which hits ElevenLabs), gets back an audio URL, then proceeds exactly like `playAudio()` from here.

### Step 2 — Cloud receives and relays

`handleAudioPlayRequest` in `app-message-handler.ts`:

```typescript
// cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts
userSession.audioPlayRequestMapping.set(message.requestId, message.packageName)

const glassesAudioRequest = {
  type: CloudToGlassesMessageType.AUDIO_PLAY_REQUEST,
  sessionId: userSession.sessionId,
  requestId: message.requestId,
  audioUrl: message.audioUrl,
  volume: message.volume,
  stopOtherAudio: message.stopOtherAudio,
  timestamp: new Date(),
}

userSession.websocket.send(JSON.stringify(glassesAudioRequest))
```

Two things happen here:

1. The `requestId → packageName` mapping is stored in `audioPlayRequestMapping` (a `Map<string, string>` on the `UserSession`). This is how the cloud knows which app to notify when the phone reports completion.
2. The message is forwarded verbatim to `userSession.websocket` — the WebSocket connection to the **mobile app**.

The name `CloudToGlassesMessageType` is misleading here. For audio playback, this message goes to the **phone**, not the glasses hardware.

### Step 3 — Mobile receives and plays

`SocketComms.ts` on the mobile handles `audio_play_request`:

```typescript
// mobile/src/services/SocketComms.ts
private handle_audio_play_request(msg: any) {
  const requestId = msg.requestId
  const audioUrl = msg.audioUrl
  const volume = msg.volume ?? 1.0
  const stopOtherAudio = msg.stopOtherAudio ?? true

  audioPlaybackService.play(
    {requestId, audioUrl, appId, volume, stopOtherAudio},
    (respRequestId, success, error, duration) => {
      this.sendAudioPlayResponse(respRequestId, success, error, duration)
    },
  )
}
```

`AudioPlaybackService` is a singleton that owns a single `AudioPlayer` (expo-audio, which wraps ExoPlayer on Android):

```typescript
// mobile/src/services/AudioPlaybackService.ts
public async play(request, onComplete) {
  // Stop any current audio if stopOtherAudio is true
  if (stopOtherAudio && this.currentPlayback && !this.currentPlayback.completed) {
    this.interruptCurrentPlayback()
  }

  const player = this.ensurePlayer()  // creates once, reuses forever
  player.volume = volume
  this.currentPlayback = { requestId, appId, startTime: Date.now(), completed: false, onComplete }

  // Replace source on the existing ExoPlayer instance and play
  player.replace({ uri: audioUrl })
  player.play()

  // Tell native layer we're playing audio (suspends LC3 mic to avoid MCU overload)
  CoreModule.setOwnAppAudioPlaying(true)
}
```

The player's `playbackStatusUpdate` listener fires on every status change. Completion is detected via `didJustFinish`:

```typescript
private onPlaybackStatusUpdate(status: AudioStatus): void {
  const playback = this.currentPlayback
  if (!playback || playback.completed) return  // guard against double-fire

  if (status.didJustFinish) {
    playback.completed = true
    playback.onComplete(playback.requestId, true, null, durationMs)
    this.currentPlayback = null
    this.notifyAudioStopDebounced()  // tells native to re-enable mic after 500ms
  }
}
```

`didJustFinish` is expo-audio's surface of ExoPlayer's `Player.STATE_ENDED`. When this fires, `onComplete` → `sendAudioPlayResponse()` → cloud WebSocket.

### Step 4 — Mobile sends completion back to cloud

```typescript
// mobile/src/services/SocketComms.ts
public sendAudioPlayResponse(requestId, success, error, duration) {
  const msg = { type: "audio_play_response", requestId, success, error, duration }
  ws.sendText(JSON.stringify(msg))
}
```

### Step 5 — Cloud routes completion to mini app

`UserSession.relayAudioPlayResponseToApp()`:

```typescript
// cloud/packages/cloud/src/services/session/UserSession.ts
const packageName = this.audioPlayRequestMapping.get(requestId)
// ... find the app's WebSocket ...
appWebSocket.send(JSON.stringify({ type: CloudToAppMessageType.AUDIO_PLAY_RESPONSE, ... }))
this.audioPlayRequestMapping.delete(requestId)
```

The mini app's SDK promise resolves. The full round-trip is complete.

### Full data flow (normal case)

```
Mini App SDK
  │  AUDIO_PLAY_REQUEST (WebSocket)
  ▼
Cloud (app-message-handler.ts)
  │  stores requestId → packageName in audioPlayRequestMapping
  │  AUDIO_PLAY_REQUEST (glasses WebSocket, which is actually the phone)
  ▼
Mobile SocketComms.ts
  │  audioPlaybackService.play(url, onComplete)
  ▼
AudioPlaybackService (expo-audio / ExoPlayer)
  │  player.replace({uri}) → player.play()
  │  CoreModule.setOwnAppAudioPlaying(true)
  │  ... audio plays on phone speaker ...
  │  didJustFinish → onComplete()
  ▼
Mobile SocketComms.ts
  │  audio_play_response (cloud WebSocket)
  ▼
Cloud (UserSession.relayAudioPlayResponseToApp)
  │  AUDIO_PLAY_RESPONSE (app WebSocket)
  ▼
Mini App SDK
  promise resolves ✅
```

---

## The Bug

### Symptom

Audio plays once, then loops indefinitely on the phone speaker. No SDK call stops it. Force-stopping the MentraOS app is the only fix. The mini app's `playAudio()` promise never resolves.

### What the logs confirm

**Mini app layer:** `playAudio()` is called exactly once. The log line appears once and then nothing — no re-trigger at the app layer.

**Cloud layer (BetterStack, 2026-03-23):** Each `requestId` is forwarded exactly once to the phone. Example from the session:

```
21:01:57  🔊 Forwarded audio request audio_req_1774299717498_3xsxwp8
21:02:00  🔊 Successfully sent audio play response audio_req_1774299717498_3xsxwp8. Remaining: 0
```

No repeated forwards. No extra completion messages. The cloud sees clean 1-request-1-response cycles for working audio. For the looped audio: it sees the forward, then nothing. No response ever arrives.

**BetterStack "Remaining: 1" leak:** When the loop is active, the `audioPlayRequestMapping` entry is never cleaned up. This appears in the logs as `Remaining: 1` on a subsequent (unrelated) request completion — the leaked entry stays in the Map for the rest of the session.

**Mobile native layer:** The MediaCodec/AudioTrack logs show the loop pattern clearly:

```
15:33:39.221  AudioTrack  stop(1437): prior state:STATE_ACTIVE    ← track ends
15:33:39.984  MediaCodec  setState: FLUSHING
15:33:39.985  MediaCodec  setState: FLUSHED
15:33:39.986  MediaCodec  setState: STARTED                        ← immediately restarts
15:33:40.324  MediaCodec  queueInputBuffer: pts=1000000000000      ← back to beginning
15:33:40.335  AudioTrack  start(1438): prior state:STATE_STOPPED   ← new track, same session
```

`pts=1000000000000` is ExoPlayer's sentinel value for "start of stream." Seeing it after `FLUSHED` means ExoPlayer seeked to position 0 and restarted — not entered `STATE_ENDED`.

**MediaCodec stats make it worse:**

```
Qinput: 126, DQinput: 0 success out of 0 tries
Render: 0,   Drop: 128,  DQoutput: 0 success out of 0 tries
```

Every decoded frame is dropped, not rendered. The codec is running, the CPU is burning, but no audio frames reach the AudioTrack successfully before the loop restarts.

**No JS trigger between loops:** There is zero JS activity between the `AudioTrack stop` and the next `queueInputBuffer`. No `SOCKET: play_audio`. No `SOCKET: audio_play_request`. The loop is entirely within the native audio layer — expo-audio's `didJustFinish` never fires.

### Root cause

ExoPlayer (via expo-audio) never enters `Player.STATE_ENDED`. Instead, when the audio track is interrupted, ExoPlayer's internal completion handler seeks to position 0 and restarts the source rather than stopping. Because `didJustFinish` never fires:

- `onPlaybackStatusUpdate` never sees it
- `playback.completed` stays `false`
- `onComplete()` is never called
- `sendAudioPlayResponse()` is never called
- The cloud's `audioPlayRequestMapping` entry leaks
- The mini app's SDK promise hangs forever

### What triggers the restart vs. completion?

The mobile logs show a `mic_state_change` event arriving ~200ms before each `AudioTrack stop(STATE_ACTIVE)`:

```
15:33:41.382  ReactNativeJS  SOCKET: mic_state_change: requiredData=[pcm], bypassVad=true
15:33:41.589  AudioTrack     stop(1438): prior state:STATE_ACTIVE     ← 207ms later
```

When the cloud sends `mic_state_change` (because a subscribed app needs transcription), the mobile processes it through `CoreModule`. On the Mentra Live (K900 hardware), enabling the microphone appears to interfere with the active AudioTrack at the native HAL level. The AudioTrack is stopped externally — not by ExoPlayer completing naturally — and ExoPlayer interprets this loss of the audio output as a reason to seek-and-restart rather than conclude.

This interaction only manifests on the K900 (Mentra Live). Simulated glasses and other hardware don't show it because they don't share the same MCU-coordinated audio I/O path.

### Why force-stop fixes it

Force-stopping terminates the MentraOS process, which destroys the ExoPlayer instance, releases all AudioTrack handles, and clears all native audio state. Nothing short of this breaks the loop because `AudioPlaybackService` is a singleton that holds the `AudioPlayer` for the entire app lifetime, and once ExoPlayer is in the restart loop it never hands control back to JS.

---

## Findings

### 1. The bug is in the mobile native audio layer, not cloud or SDK

The cloud is a clean relay. BetterStack confirms one forward per request. The SDK fires once. The loop is ExoPlayer's response to having its AudioTrack interrupted by a concurrent mic state change on K900.

### 2. `didJustFinish` never fires during the loop

expo-audio's completion path is `STATE_ENDED → didJustFinish → onComplete callback → cloud response`. The loop bypasses `STATE_ENDED` entirely — ExoPlayer seeks to 0 instead. The callback chain is never entered.

### 3. The `audioPlayRequestMapping` leaks when the loop is active

The cloud's `requestId → packageName` map entry is never cleaned up. It persists for the session duration. This is a symptom, not a cause, but it means the cloud has an unbounded memory leak for any session with a looped audio request.

### 4. The `mic_state_change` / audio HAL interaction is the trigger

On K900, enabling the mic while audio is playing stops the AudioTrack externally. ExoPlayer restarts instead of completing. This is a hardware-specific interaction with the K900's audio HAL.

### 5. `AudioPlaybackService` has no timeout or stuck-playback detection

If `didJustFinish` never fires, `currentPlayback` stays non-null and `completed` stays `false` indefinitely. There is no watchdog. A single looped request permanently blocks any subsequent audio from other apps (because `stopOtherAudio=true` will interrupt it, but only by calling `interruptCurrentPlayback()` — which calls `player.pause()` on the same stuck ExoPlayer instance, which may or may not work).

### 6. `audioPlayRequestMapping` has no TTL or cleanup

If a response is never received (loop bug, BLE drop, anything), the entry stays in the map until session disposal. Multiple stuck requests pile up. `Remaining: N` in BetterStack is the observable symptom.

---

## Conclusions

| Finding                                                         | Severity               | Owned by                        |
| --------------------------------------------------------------- | ---------------------- | ------------------------------- |
| ExoPlayer loops on AudioTrack interruption (K900 HAL)           | Critical — user-facing | Mobile/native                   |
| `didJustFinish` never fires during loop → callback chain broken | Critical               | Mobile (expo-audio interaction) |
| `audioPlayRequestMapping` leaks entries on no-completion        | High                   | Cloud                           |
| No stuck-playback watchdog in `AudioPlaybackService`            | High                   | Mobile                          |
| No TTL on `audioPlayRequestMapping` entries                     | Medium                 | Cloud                           |

The fix has two independent parts:

**Mobile (primary fix):** Detect when ExoPlayer is in a restart loop (e.g. by tracking time-since-last-progress or watching for repeated `pts=1000000000000` events from the native layer) and force-complete or release the player. Alternatively, investigate whether setting ExoPlayer's `repeatMode` to `REPEAT_MODE_OFF` explicitly prevents the K900 restart behavior, or whether the mic-state-change path needs to call `player.pause()` before enabling the mic to prevent the AudioTrack from being taken away.

**Cloud (defensive fix):** Add a TTL to `audioPlayRequestMapping` entries (e.g. 60s). If no response arrives within the TTL, delete the entry and send an error response to the mini app so its promise doesn't hang indefinitely.

## Next Steps

1. Mobile team: reproduce the loop in isolation by triggering `mic_state_change` while audio is playing on a K900 device.
2. Check whether `player.pause()` before mic enable prevents the AudioTrack interruption.
3. Check ExoPlayer repeat mode setting in the expo-audio native module.
4. Cloud: add TTL / timeout to `audioPlayRequestMapping` — tracked separately from the native fix.
5. Write `spec.md` once the mobile root cause is confirmed.
