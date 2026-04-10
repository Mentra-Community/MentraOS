# Spike: SDK v3 alpha.1 Capability Regressions and Documentation Gaps

## Overview

**What this doc covers:** A complete audit of functionality that existed in the v2 SDK but was dropped, simplified, or broken in v3 (3.0.0-alpha.1). Also covers documentation pages that are missing, wrong, or still using v2 API patterns.
**Why this doc exists:** Before shipping v3 to developers, we need to know what regressed so we can make intentional decisions about what to restore vs what to leave out.
**Who should read this:** SDK developers, doc writers, anyone reviewing the v3 API surface.

## Background

The v2 SDK (`@mentra/sdk` 2.x) has a flat API surface: `session.events.onX()`, `session.layouts.showX()`, `session.audio.playTTS()`, etc. The v3 SDK reorganizes everything into 14 typed managers on `MentraSession`. During this reorganization, some capabilities were intentionally simplified, some were accidentally dropped, and one has a real bug where the type signature promises functionality the implementation does not deliver.

This spike was produced by diffing every v2 module against its v3 replacement, checking the wire protocol support, and auditing every documentation page.

## Capability Regressions

### High Priority (broken functionality)

#### 1. PCM16 encoding in audio output streams is broken

- **v2:** `AudioOutputStream.write()` in `audio-output-stream.ts` checks `this.options.format === "pcm16"` and encodes PCM samples to MP3 via `lamejs` before sending binary frames. This supports Gemini Live and OpenAI Realtime which output raw PCM.
- **v3:** `AudioOutputStreamImpl.write()` in `SpeakerManager.ts` passes data straight through to `sendBinaryFrame()` regardless of format. The `StreamOptions` type still accepts `"pcm16"` as a format value, so the type signature promises PCM support.
- **Wire protocol:** The phone expects MP3 bytes. Sending raw PCM produces garbage audio.
- **Impact:** Any app using `speaker.createStream({ format: "pcm16" })` (Gemini Live, OpenAI Realtime integrations) will produce broken audio output.
- **Verdict:** Bug. The type says it works, the implementation does not.

### Medium Priority (missing hardware capabilities)

#### 2. Camera FOV/ROI control (`setFov`) dropped

- **v2:** `camera.ts` L315-345 sends `CAMERA_FOV_SET` with `fov` (82-118 degrees) and `roiPosition` ("center" | "top" | "bottom").
- **v3:** No equivalent on `CameraManager`.
- **Wire protocol:** `AppToCloudMessageType.CAMERA_FOV_SET` is still defined and the cloud handles it.
- **Decision:** Needs a redesign. The original implementation was rushed. Track as a separate issue and design a proper API later. Do not just copy the v2 method over.

#### 3. LED blink/multi-cycle patterns dropped

- **v2:** `turnOn({ color, ontime, offtime, count })` and `blink(color, ontime, offtime, count)` allowed repeated on/off cycles.
- **v3:** `setColor(color, durationMs)` hardcodes `offtime: 0` and `count: 1`. No way to blink.
- **Wire protocol:** `RgbLedControlRequest` still supports `offtime` and `count`.
- **Decision:** Accidental regression. Restore blink capability. The wire protocol supports it, the v3 API just needs to expose `offtime` and `count` parameters.

#### 4. Custom photo webhook URL and auth token dropped

- **v2:** `PhotoRequestOptions` included `customWebhookUrl` and `authToken` to redirect photo uploads to a custom endpoint.
- **v3:** `PhotoOptions` only has `size`, `compression`, `saveToGallery`, `sound`, `timeout`.
- **Wire protocol:** The `PHOTO_REQUEST` message type still supports these fields.
- **Decision:** Intentionally removed for now. May revisit later if there is developer demand.

#### 5. Dashboard mode change events dropped

- **v2:** `events.onDashboardModeChange(handler)` fires when the glasses enter/exit dashboard mode.
- **v3:** `DashboardManager` only has `showText()` and `clear()`. No event subscription.
- **Wire protocol:** Cloud still sends `dashboard_mode_change` messages.
- **Decision:** Intentional removal. The dashboard mode system was never fully built out. Not a regression.

#### 6. Permission error/denied events dropped

- **v2:** `events.onPermissionError(handler)` and `events.onPermissionDenied(handler)` fire when the cloud rejects subscriptions due to missing permissions.
- **v3:** `PermissionsManager` has `onUpdate()` for permission changes but no error/denial events.
- **Wire protocol:** Cloud still sends `permission_error` and `permission_denied` messages.
- **Decision:** Accidental regression. Restore these events on `PermissionsManager`.

#### 7. Phone battery events never sent by any client

- **v2/v3:** Both SDK versions define `PHONE_BATTERY_UPDATE` types and handlers.
- **Cloud:** Zero references to phone battery in the cloud codebase.
- **ASG client:** Zero references to phone battery in the Android client.
- **Mobile app:** Never sends this event.
- **Impact:** `phone.battery` and `phone.onBatteryUpdate()` are typed ghosts. No data ever arrives.
- **Decision:** Remove from the API surface. This was unintentionally included. No client sends it.

### Low Priority (convenience methods, rarely used features)

#### 8. `getLatestLocation()` no longer returns a Promise

- **v2:** Returns `Promise<LocationUpdate>` via correlationId matching. One-shot await.
- **v3:** `requestUpdate()` returns `void`. Result comes via `onUpdate()` callback.
- **Verdict:** Intentional simplification. v3 adds cached `lat`/`lng`/`accuracy` getters as a tradeoff.

#### 9. App-to-app communication entirely dropped

- **v2:** `discoverAppUsers()`, `broadcastToAppUsers()`, `sendDirectMessage()`, `joinAppRoom()`, `leaveAppRoom()`, `onAppMessage()`, `onAppUserJoined()`, `onAppUserLeft()`, `onAppRoomUpdated()`.
- **v3:** No equivalent. The entire subsystem is gone.
- **Wire protocol:** Cloud still handles these message types.
- **Decision:** Intentionally removed. This feature never worked properly and was never used by any published app. Not coming back.

#### 10. `onSettingChange(key, handler)` granular setting monitoring dropped

- **v2:** Per-key setting change handler with previous/new value tracking.
- **v3:** Only `onSettings(handler)` which fires the entire settings array.
- **Verdict:** Intentional simplification. Developers can filter in their handler.

#### 11. `getActiveOutputStream()` dropped

- **v2:** Returns the currently active audio output stream reference.
- **v3:** Tracked privately in `SpeakerManager` but not exposed.
- **Verdict:** Minor oversight.

#### 12. `use_speaker_boost` TTS voice setting dropped

- **v2:** `SpeakOptions.voice_settings` included `use_speaker_boost`.
- **v3:** `SpeakOptions.voiceSettings` omits it.
- **Verdict:** Minor. ElevenLabs has been de-emphasizing this parameter.

#### 13. `disableLanguageIdentification` transcription option dropped

- **v2:** `onTranscriptionForLanguage()` accepted this option.
- **v3:** `transcription.forLanguage()` does not. `configure()` has `languageHints` but no disable flag.
- **Verdict:** Partial regression. Niche use case.

#### 14. Generic `on(streamType, handler)` escape hatch dropped

- **v2:** `events.on()` allowed subscribing to any arbitrary stream type, including future/custom ones.
- **v3:** Every data stream must go through a specific manager. No escape hatch.
- **Verdict:** Intentional design decision. v3 is more structured but less flexible.

## Documentation Gaps

### Missing pages (no documentation at all)

| Manager | Accessor | What needs documenting |
|---------|----------|----------------------|
| DeviceManager | `session.device` | Button presses, head position, touch/gestures, battery, WiFi, 13 observable state properties, capabilities |
| PhoneManager | `session.phone` | Notifications, calendar, phone battery (with caveat that battery is not yet implemented) |
| TimeUtils | `session.time` | Timezone, now(), format(), toLocal(), setTimezone() |

### Pages with wrong API patterns (actively misleading)

| Page | Problem |
|------|---------|
| `display/dashboard.mdx` | Uses v2 `content.writeToMain()`, `writeToExpanded()`, `onModeChange()` throughout |
| `camera/README.mdx` | All v2 method names: `requestPhoto()`, `startLivestream()`, `startLocalLivestream()` |
| `camera/photo-capture.mdx` | Uses v2 `requestPhoto()` everywhere instead of v3 `takePhoto()` |
| `led/overview.mdx` | Documents 4 non-existent methods: `blink()`, `solid()`, `turnOn()`, `turnOff()` |
| `hw/camera-glasses.mdx` | v2 camera + LED APIs, broken syntax, `this` in callbacks |

### Pages with partial issues (need targeted fixes)

| Page | Problem |
|------|---------|
| `app-lifecycle-overview.mdx` | "Next Steps" links point to v2 pages |
| `microphone/audio-chunks.mdx` | Missing `stop()` method |
| `speakers/playing-audio-files.mdx` | Missing `stop(trackId?)` method |
| `camera/streaming.mdx` | Missing `checkExistingStream()` documentation |
| `permissions.mdx` | v2 code in LOCATION/CAMERA examples, CALENDAR has syntax error |
| `storage.mdx` | 5 of 9 methods undocumented: `clear()`, `keys()`, `has()`, `setMultiple()`, `flush()` |
| `location.mdx` | Missing `stop()` method |
| `hw/overview.mdx` | v2 class inheritance pattern |
| `hw/display-glasses.mdx` | Broken syntax, mixed v2/v3 API signatures |
| `hw/device-capabilities.mdx` | Mostly v2 class pattern |

### Orphan page

- `ai-tool-calls.mdx` exists on disk but is not in the `docs.json` sidebar.

## Conclusions

| Category | Count |
|----------|-------|
| High priority regression (bug) | 1 (PCM16 encoding) |
| Medium priority regressions | 5 (FOV, blink, photo webhook, dashboard events, permission events) |
| Low priority / intentional | 8 |
| Never-worked ghost API | 1 (phone battery) |
| Missing doc pages | 3 |
| Actively wrong doc pages | 5 |
| Doc pages needing fixes | 10 |

## Decisions

| Item | Decision |
|------|----------|
| PCM16 encoding bug | Fix (high priority) |
| Camera FOV/ROI | Separate issue, redesign later |
| LED blink | Accidental regression, restore |
| Custom photo webhook | Intentionally removed for now |
| Dashboard mode events | Intentional removal (never fully built) |
| Permission error/denied events | Accidental regression, restore |
| Phone battery | Remove from API surface (never worked, unintentional inclusion) |
| App-to-app communication | Intentionally removed (never worked, never used) |

## Next Steps

1. Fix the PCM16 encoding bug (high priority, broken audio for Gemini/OpenAI integrations)
2. Restore LED blink capability (add `offtime`/`count` params to `setColor` or add `blink()` method)
3. Restore permission error/denied events on `PermissionsManager`
4. Remove phone battery from the API surface (comment out or remove `phone.battery` and `phone.onBatteryUpdate()`)
5. Create separate issue for camera FOV/ROI redesign
6. Create the 3 missing doc pages (device, phone, time)
7. Rewrite the 5 wrong doc pages
8. Apply targeted fixes to the 10 partial-issue pages