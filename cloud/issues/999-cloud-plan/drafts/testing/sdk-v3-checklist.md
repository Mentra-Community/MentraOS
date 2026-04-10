# SDK v3 Test Checklist

Complete test checklist for `@mentra/sdk@3.0.0-alpha`. Covers every manager, lifecycle edge case, webview/auth, and known regressions. Use this manually now, automate later via the test mini app.

## How to use this

- Test each item. Mark as pass, fail, or N/A.
- Most items can be tested on any glasses. Items that need specific hardware are marked.
- Known regressions from issue 092 are called out with a warning icon.
- Known bugs from implementation-status.md are called out with a bug icon.

## Glasses quick reference

| Glasses           | Display                  | Camera                 | Mic       | Speaker | LED               | Buttons | WiFi |
| ----------------- | ------------------------ | ---------------------- | --------- | ------- | ----------------- | ------- | ---- |
| Mentra Live       | No                       | Yes (1080p, streaming) | Yes (VAD) | Yes     | Yes (RGB + white) | Yes     | Yes  |
| Even Realities G1 | Yes (green mono 640x200) | No                     | Yes       | No      | No                | No      | No   |
| Mentra Mach1      | Yes (narrow)             | No                     | Yes       | No      | No                | No      | No   |
| Vuzix Z100        | Yes (narrow)             | No                     | No        | No      | No                | No      | No   |

---

## 1. Server + Session Lifecycle

### MiniAppServer

- [ ] `new MiniAppServer({ packageName, apiKey, port })` starts and listens
- [ ] `app.onSession(callback)` fires when a user starts the app
- [ ] `app.onStop(callback)` fires when a session ends (receives session + reason)
- [ ] `app.onToolCall(callback)` registers (AI tool calls are temporarily unavailable, just verify it doesn't crash)
- [ ] Custom Hono routes work (`app.app.get("/my-route", handler)`)
- [ ] Multiple concurrent users each get their own `MentraSession`
- [ ] Server shuts down cleanly on SIGINT / SIGTERM

### MentraSession Properties

- [ ] `session.userId` is a non-empty string
- [ ] `session.sessionId` is a non-empty string, unique per session
- [ ] `session.logger` works (`session.logger.info("test")`)
- [ ] `session.settingsData` returns app settings (or empty/default)
- [ ] `session.mentraosSettings` returns system settings
- [ ] `session.appConfig` returns app config from developer console (or null)
- [ ] `session.capabilities` returns connected glasses capabilities (or null)
- [ ] `session.isConnected` returns boolean reflecting current connection state
- [ ] `session.isParked` returns boolean (true when transport is down but session preserved)
- [ ] `session.getServerUrl()` returns the cloud server URL or null
- [ ] `session.sendMessage(msg)` sends a raw JSON message
- [ ] `session.sendBinary(data)` sends binary data (ArrayBuffer or Uint8Array)

### Session Lifecycle

- [ ] Session starts in connected state when `onSession` fires
- [ ] Session transitions to running (subscriptions deliver data)
- [ ] `session.onReconnected(callback)` fires after transport is restored
- [ ] `session.onStopped(callback)` fires when session ends, includes reason string
- [ ] Stopping the app from the phone triggers `onStopped`
- [ ] Disconnecting glasses does not kill the session (transport down state)
- [ ] Session survives a brief network blip (WiFi toggle, cellular handoff)
- [ ] Subscriptions are preserved across reconnect (no re-registration needed)
- [ ] Handlers are preserved across reconnect
- [ ] Session eventually stops if transport stays down past the grace period

### Session Events

- [ ] `session.onConnected(handler)` fires on connection with settings data
- [ ] `session.onDisconnected(handler)` fires on disconnect with `{ code, reason, permanent }`
- [ ] `session.onError(handler)` fires on session errors
- [ ] `session.onSettings(handler)` fires when settings change
- [ ] All session event handlers return cleanup functions

---

## 2. Transcription (`session.transcription`)

_Requires: microphone permission, any glasses with mic (G1, Mach1, Mentra Live), or phone mic_

- [ ] `session.transcription.on(handler)` receives transcription events
- [ ] Event has `text` (string), `isFinal` (boolean), `language` (string)
- [ ] Event has `speakerId` when diarization is enabled
- [ ] Event has `utteranceId`
- [ ] `isFinal: false` events arrive as partial/interim results
- [ ] `isFinal: true` events arrive as completed sentences
- [ ] `session.transcription.forLanguage("en", handler)` only receives English transcriptions
- [ ] `session.transcription.forLanguage("es", handler)` only receives Spanish transcriptions (if speaking Spanish)
- [ ] `session.transcription.configure({ languageHints: ["en", "es"] })` works
- [ ] `session.transcription.configure({ diarization: true })` enables speaker IDs
- [ ] `session.transcription.stop()` stops all transcription streams
- [ ] Cleanup function from `.on()` unsubscribes correctly
- [ ] Cleanup function from `.forLanguage()` unsubscribes correctly
- [ ] Multiple simultaneous subscriptions (`.on()` + `.forLanguage()`) both receive data
- [ ] Transcription resumes after reconnect without re-subscribing
- [ ] `session.transcription.active` returns boolean reflecting whether transcription is active
- [ ] `session.transcription.config` returns current TranscriptionConfig or null

---

## 3. Translation (`session.translation`)

_Requires: microphone permission, any glasses with mic_

- [ ] `session.translation.on(handler)` receives translation events
- [ ] Event has `text`, `originalText`, `isFinal`
- [ ] `session.translation.to("es", handler)` receives only Spanish translations
- [ ] `session.translation.fromTo("en", "es", handler)` receives English-to-Spanish only
- [ ] `session.translation.stop()` stops all translation streams
- [ ] Cleanup function from `.on()` unsubscribes
- [ ] Cleanup function from `.to()` unsubscribes
- [ ] Cleanup function from `.fromTo()` unsubscribes
- [ ] Translation resumes after reconnect
- [ ] `session.translation.active` returns boolean reflecting whether translation is active

---

## 4. Microphone (`session.mic`)

_Requires: microphone permission, any glasses with mic (G1, Mach1, Mentra Live)_

- [ ] `session.mic.onChunk(handler)` receives audio chunks
- [ ] Chunk has `arrayBuffer` (raw PCM data)
- [ ] Chunk has `sampleRate` (expect 16000)
- [ ] `session.mic.onVoiceActivity(handler)` receives boolean `isSpeaking` events
- [ ] `session.mic.isSpeaking` reflects current speaking state
- [ ] `session.mic.isActive` is true while mic is streaming
- [ ] `session.mic.stop()` stops mic and all callbacks
- [ ] `session.mic.hasPermission` returns correct boolean
- [ ] Cleanup function from `.onChunk()` unsubscribes
- [ ] Cleanup function from `.onVoiceActivity()` unsubscribes
- [ ] Subscribing to mic does NOT automatically subscribe to transcription (independent streams)
- [ ] Mic resumes after reconnect

---

## 5. Camera (`session.camera`)

_Requires: camera permission, Mentra Live only_

### Photo Capture

- [ ] `session.camera.takePhoto()` returns a Promise that resolves to PhotoData
- [ ] PhotoData has `url`, `width`, `height`, `timestamp`
- [ ] `takePhoto({ size: "small" })` works
- [ ] `takePhoto({ size: "medium" })` works
- [ ] `takePhoto({ size: "large" })` works
- [ ] `takePhoto({ size: "full" })` works
- [ ] `takePhoto({ saveToGallery: true })` saves and `savedToGallery` is true in response
- [ ] `takePhoto({ sound: false })` suppresses shutter sound
- [ ] `takePhoto({ timeout: 3000 })` times out correctly if glasses don't respond
- [ ] `takePhoto()` fails fast with a clear error if glasses are not connected
- [ ] `takePhoto()` fails fast with a clear error if camera permission is missing
- [ ] `session.camera.hasPermission` returns correct boolean
- [ ] Multiple rapid `takePhoto()` calls don't corrupt each other (bug: requestId correlation race)

### Video Streaming

- [ ] `session.camera.startStream()` starts managed relay, returns stream URLs
- [ ] Response includes `webrtcUrl`, `hlsUrl`, `dashUrl`, `previewUrl`, `thumbnailUrl`, `streamId`
- [ ] `session.camera.startStream({ destinations: ["rtmp://..."] })` starts restream
- [ ] `session.camera.startStream({ direct: "srt://..." })` starts direct stream
- [ ] Stream quality options work: `quality`, `video: { width, height, fps, bitrate }`, `audio: { sampleRate, bitrate }`
- [ ] `session.camera.stopStream()` stops the active stream
- [ ] `session.camera.onStreamStatus(handler)` receives status events
- [ ] Status events include: `"initializing"`, `"active"`, `"stopped"`, `"error"`
- [ ] `session.camera.isCurrentlyStreaming()` returns correct boolean
- [ ] `session.camera.checkExistingStream()` detects orphaned streams from previous session
- [ ] Cleanup function from `.onStreamStatus()` unsubscribes
- [ ] Stream survives brief transport blip (reconnect, stream stays live)
- [ ] `startStream()` fails fast if glasses not connected (not 30s timeout)
- [ ] `startStream()` fails fast if camera permission missing
- [ ] `session.camera.getCurrentStreamUrl()` returns current stream URL or undefined
- [ ] `session.camera.getStreamStatus()` returns current StreamStatus or undefined
- [ ] `session.camera.getStreamUrls()` returns all stream URLs or undefined

### Camera on display-only glasses (G1, Mach1)

- [ ] `session.camera.takePhoto()` fails with a clear error (no camera)
- [ ] `session.camera.hasPermission` returns false or N/A
- [ ] `session.capabilities.hasCamera` is false

### Deprecated Camera Methods (v2 compat)

- [ ] `session.camera.startDirectStream(options)` still works (deprecated, use startStream({ direct }))
- [ ] `session.camera.startManagedStream(options?)` still works (deprecated, use startStream())
- [ ] `session.camera.stopManagedStream()` still works (deprecated, use stopStream())
- [ ] `session.camera.onManagedStreamStatus(handler)` still works (deprecated, use onStreamStatus())
- [ ] `session.camera.isManagedStreamActive()` still works (deprecated, use isCurrentlyStreaming())
- [ ] `session.camera.getManagedStreamUrls()` still works (deprecated, use getStreamUrls())

---

## 6. Display (`session.display`)

_Requires: display glasses (G1, Mach1, Vuzix Z100). Mentra Live has no display._

- [ ] `session.display.showTextWall("hello")` shows text on glasses
- [ ] `session.display.showTextWall("hello", { durationMs: 3000 })` auto-clears after duration
- [ ] `session.display.showDoubleTextWall("left", "right")` shows two columns
- [ ] `session.display.showText("hello")` shows simple text
- [ ] `session.display.showText(["line 1", "line 2"])` shows multi-line
- [ ] `session.display.showReferenceCard("Title", "Body text")` shows card layout
- [ ] `session.display.showDashboardCard("Title", "Body")` shows compact card
- [ ] `session.display.showBitmap(bitmapData)` renders bitmap
- [ ] `session.display.clear()` removes all content
- [ ] Rapid display updates don't crash (throttling works)
- [ ] Display works on G1 (green mono 640x200)
- [ ] Display works on Mach1 (narrow, stacked layout)
- [ ] Display handles long text (wrapping/truncation)

### Display on Mentra Live (no display)

- [ ] Display calls don't crash, they just do nothing (or fail gracefully)
- [ ] `session.capabilities.hasDisplay` is false

---

## 7. Dashboard (`session.dashboard`)

_Requires: display glasses_

- [ ] `session.dashboard.showText("hello")` shows text on dashboard overlay
- [ ] `session.dashboard.showText(["line 1", "line 2"])` shows multi-line
- [ ] `session.dashboard.clear()` removes this app's content from dashboard
- [ ] Dashboard updates are throttled (~300ms)
- [ ] Multiple apps can write to dashboard without conflicting

---

## 8. Speaker (`session.speaker`)

_Requires: Mentra Live (only glasses with speaker)_

### Text-to-Speech

- [ ] `session.speaker.speak("hello")` plays TTS audio
- [ ] `speak()` returns a Promise that resolves to PlayResult
- [ ] `speak("hello", { voiceId: "..." })` uses specified voice
- [ ] `speak("hello", { volume: 0.5 })` adjusts volume
- [ ] `speak("hello", { trackId: "my-track" })` assigns track ID
- [ ] `speak("hello", { stopOtherAudio: true })` stops other audio first

### Audio Playback

- [ ] `session.speaker.play({ url: "https://..." })` plays audio file
- [ ] `play()` returns a Promise that resolves to PlayResult
- [ ] `play({ url, volume: 0.5 })` adjusts volume
- [ ] `play({ url, trackId: "bg-music" })` assigns track ID
- [ ] `session.speaker.stop()` stops all audio
- [ ] `session.speaker.stop("bg-music")` stops specific track

### Audio Output Stream

- [ ] `session.speaker.createStream()` returns a Promise resolving to AudioOutputStream
- [ ] `stream.write(chunk)` sends audio data
- [ ] `stream.end()` gracefully ends the stream
- [ ] `stream.flush()` interrupts and discards buffer
- [ ] `stream.state` reflects current state (`"created"`, `"streaming"`, `"ending"`, `"ended"`, `"error"`)
- [ ] `stream.onStateChange(handler)` fires on transitions
- [ ] `stream.id` is a UUID string
- [ ] `createStream({ format: "mp3" })` works
- [ ] ⚠️ `createStream({ format: "pcm16" })` works -- **KNOWN REGRESSION: PCM16 encoding is broken (ship-blocking). Passes raw PCM without MP3 encoding. Breaks Gemini Live / OpenAI Realtime integrations.**
- [ ] `createStream({ sampleRate: 24000 })` works
- [ ] `createStream({ volume: 0.5 })` works

### Speaker Permission

- [ ] `session.speaker.hasPermission` returns correct boolean

### Speaker on glasses without speaker (G1, Mach1)

- [ ] Speaker calls fail gracefully with a clear error
- [ ] `session.capabilities.hasSpeaker` is false

---

## 9. LED (`session.led`)

_Requires: Mentra Live (only glasses with LED)_

- [ ] `session.led.setColor("red")` turns on LED red (default 1000ms)
- [ ] `session.led.setColor("green")` works
- [ ] `session.led.setColor("blue")` works
- [ ] `session.led.setColor("orange")` works
- [ ] `session.led.setColor("white")` works
- [ ] `session.led.setColor("red", 3000)` turns on for 3 seconds
- [ ] ⚠️ `session.led.setColor("red", { onTime: 500, offTime: 500, count: 3 })` blinks 3 times -- **KNOWN REGRESSION: LED blink patterns were dropped. Wire protocol supports it, v3 doesn't expose it yet.**
- [ ] `session.led.off()` turns off immediately

### LED on glasses without LED (G1, Mach1)

- [ ] LED calls fail gracefully
- [ ] `session.capabilities.hasLight` is false

---

## 10. Device (`session.device`)

_Works on all glasses, but available state varies by hardware_

### Reactive State (Observables)

Each observable should have `.value` and `.onChange(callback) => cleanup`.

- [ ] `session.device.state.connected.value` returns boolean
- [ ] `session.device.state.connected.onChange(cb)` fires when glasses connect/disconnect
- [ ] `session.device.state.modelName.value` returns correct model string (or null)
- [ ] `session.device.state.batteryLevel.value` returns number 0-100 (or null)
- [ ] `session.device.state.charging.value` returns boolean (or null)
- [ ] `session.device.state.caseBatteryLevel.value` returns number (or null)
- [ ] `session.device.state.caseCharging.value` returns boolean (or null)
- [ ] `session.device.state.caseOpen.value` returns boolean (or null)
- [ ] `session.device.state.caseRemoved.value` returns boolean (or null)
- [ ] `session.device.state.wifiConnected.value` returns boolean
- [ ] `session.device.state.wifiSsid.value` returns string (or null)
- [ ] `session.device.state.wifiLocalIp.value` returns string (or null)
- [ ] `session.device.state.hotspotEnabled.value` returns boolean (or null)
- [ ] `session.device.state.hotspotSsid.value` returns string (or null)

_WiFi state is only relevant for Mentra Live (has WiFi). G1/Mach1 should return null/false._

### Events

- [ ] `session.device.onButtonPress(handler)` receives events with `buttonId` and `pressType` ("short" / "long") -- _Mentra Live only_
- [ ] `session.device.onHeadPosition(handler)` receives events with `position` ("up" / "down")
- [ ] `session.device.onTouchEvent(handler)` receives all touch/gesture events
- [ ] `session.device.onTouchEvent("tap", handler)` receives only tap events
- [ ] `session.device.subscribeToGestures(["tap", "swipe_forward"])` returns single cleanup
- [ ] `session.device.onBatteryUpdate(handler)` receives `{ level, charging }`
- [ ] `session.device.onVpsCoordinates(handler)` receives VPS data (if available)
- [ ] `session.device.onCapabilitiesChange(handler)` fires when capabilities change (e.g. glasses disconnect/reconnect)
- [ ] All event handlers return cleanup functions that work

### Actions

- [ ] `session.device.requestWifiSetup()` prompts WiFi setup -- _Mentra Live only_
- [ ] `session.device.requestWifiSetup("Need WiFi for streaming")` includes reason

### Capabilities

- [ ] `session.device.capabilities` returns a `Capabilities` object (or null if no glasses)
- [ ] Capabilities has correct boolean flags: `hasDisplay`, `hasCamera`, `hasMicrophone`, `hasSpeaker`, `hasButton`, `hasLight`, `hasIMU`, `hasWifi`
- [ ] Detail objects are present where applicable: `.display`, `.camera`, `.microphone`, `.speaker`, `.button`, `.light`, `.imu`
- [ ] `session.capabilities` is the same as `session.device.capabilities` (alias)

---

## 11. Phone (`session.phone`)

_Works without glasses (phone-only features)_

### Notifications

- [ ] `session.phone.notifications.on(handler)` receives incoming notifications
- [ ] Notification has `app`, `title`, `content`
- [ ] `session.phone.notifications.onDismissed(handler)` receives dismissed events
- [ ] `session.phone.notifications.hasPermission` returns correct boolean (requires READ_NOTIFICATIONS)
- [ ] Cleanup functions work

### Calendar

- [ ] `session.phone.calendar.on(handler)` receives calendar events
- [ ] Calendar event has `title`, `dtStart`, and other fields
- [ ] `session.phone.calendar.hasPermission` returns correct boolean (requires CALENDAR)
- [ ] Cleanup functions work

### Phone Battery

- [ ] ⚠️ **KNOWN ISSUE: Phone battery events were never sent by any client. This is a ghost API. Should be removed or documented as non-functional.**

---

## 12. Permissions (`session.permissions`)

- [ ] `session.permissions.has("MICROPHONE")` returns boolean
- [ ] `session.permissions.has("CAMERA")` returns boolean
- [ ] `session.permissions.has("LOCATION")` returns boolean
- [ ] `session.permissions.has("CALENDAR")` returns boolean
- [ ] `session.permissions.has("READ_NOTIFICATIONS")` returns boolean
- [ ] `session.permissions.has("POST_NOTIFICATIONS")` returns boolean
- [ ] `session.permissions.has("BACKGROUND_LOCATION")` returns boolean
- [ ] `session.permissions.getAll()` returns all permissions
- [ ] `session.permissions.onUpdate(handler)` fires when permissions change
- [ ] ⚠️ **KNOWN REGRESSION: Permission error/denied events were dropped. Need to verify these are restored.**
- [ ] Cleanup function from `.onUpdate()` works
- [ ] `session.permissions.onPermissionError(handler)` fires on permission errors with `{ message, deniedPermissions? }`
- [ ] `session.permissions.onPermissionDenied(handler)` fires when specific permission denied with `{ message, permission?, streamType? }`

---

## 13. Location (`session.location`)

- [ ] `session.location.lat` returns number or null
- [ ] `session.location.lng` returns number or null
- [ ] `session.location.accuracy` returns number or null
- [ ] `session.location.timestamp` returns number or null
- [ ] `session.location.onUpdate(handler)` receives continuous location updates
- [ ] `session.location.requestUpdate()` requests a fresh fix
- [ ] `session.location.requestUpdate("high")` requests high accuracy
- [ ] `session.location.stop()` stops all location tracking
- [ ] `session.location.hasPermission` returns correct boolean
- [ ] Cleanup function from `.onUpdate()` works
- [ ] `session.location.configure({ accuracy: "high" })` configures location settings
- [ ] `session.location.requestUpdate()` returns Promise<LocationData> (not just void)
- [ ] 🐛 **KNOWN BUG: `onUpdate()` has a memory leak -- `updateCleanup` not stored. Verify if this is fixed.**

---

## 14. Storage (`session.storage`)

_Works without glasses (server-side persistent storage)_

- [ ] `session.storage.set("key", "value")` stores a value
- [ ] `session.storage.get("key")` retrieves the value
- [ ] `session.storage.get("nonexistent")` returns null
- [ ] `session.storage.delete("key")` removes the key
- [ ] `session.storage.has("key")` returns true/false
- [ ] `session.storage.keys()` returns all keys
- [ ] `session.storage.getAll()` returns all key-value pairs
- [ ] `session.storage.clear()` removes everything
- [ ] `session.storage.setMultiple({ a: "1", b: "2" })` batch sets
- [ ] `session.storage.flush()` forces write to server
- [ ] Data persists across sessions (stop app, restart, data is still there)
- [ ] Data is per-user (user A can't see user B's data)
- [ ] Data is per-app (app A can't see app B's data)

---

## 15. Time (`session.time`)

_Works without glasses_

- [ ] `session.time.zone` returns IANA timezone string (e.g. "America/Los_Angeles")
- [ ] `session.time.now()` returns a Date object
- [ ] `session.time.toLocal(new Date())` converts UTC to user's local time
- [ ] `session.time.format(new Date())` formats date in user's timezone
- [ ] `session.time.format(new Date(), { hour: "numeric", minute: "numeric" })` respects format options
- [ ] `session.time.setTimezone("Europe/London")` overrides timezone
- [ ] `session.time.setTimezone("Invalid/Zone")` throws RangeError

---

## 16. Webview and Authentication

### Server-side Auth

- [ ] `getMentraAuth(c)` returns `{ userId }` on any Hono route
- [ ] `userId` matches the session's user
- [ ] Auth middleware is applied automatically (no manual setup needed)
- [ ] Unauthenticated request returns appropriate error
- [ ] Built-in `/mentra-auth` route works for browser OAuth flow

### Client-side Auth (`@mentra/react`)

- [ ] `<MentraAuthProvider>` wraps the app without errors
- [ ] `useMentraAuth()` returns `{ userId, frontendToken, isLoading, error, isAuthenticated, logout }`
- [ ] `isLoading` is true initially, then false
- [ ] `isAuthenticated` is true after successful auth
- [ ] `userId` matches the server-side userId
- [ ] `logout()` clears the session

### Bridge API (`@mentra/react`)

- [ ] `isInMentraOS()` returns true when running inside MentraOS app
- [ ] `isInMentraOS()` returns false when running in a regular browser
- [ ] `getMentraOSPlatform()` returns `"ios"` or `"android"` (or null outside MentraOS)
- [ ] `hasCapability("share")` returns boolean
- [ ] `hasCapability("open_url")` returns boolean
- [ ] `hasCapability("copy_clipboard")` returns boolean
- [ ] `hasCapability("download")` returns boolean
- [ ] `share({ title, text, url })` works
- [ ] `openUrl("https://example.com")` opens URL
- [ ] `copyToClipboard("text")` copies to clipboard
- [ ] `download({ url, filename })` triggers download
- [ ] `useCapsuleMenu()` returns `{ rect, safeAreaTop }`
- [ ] `useMentraBridge()` returns all bridge functions

### Bun Fullstack Webview

- [ ] Single Bun process serves both webhook/API and webview HTML
- [ ] Webview loads correctly inside MentraOS app
- [ ] Hot reload works in development

---

## 17. Subscriptions and Routing

_These test the internal subscription and message routing system, not any single manager_

- [ ] 🐛 **KNOWN BUG: `_SubscriptionManager` sends SUBSCRIPTION_UPDATE per add/remove. If `onSession` registers 5 subscriptions synchronously, that should be 1 WebSocket message, not 5. Verify if batching is fixed.**
- [ ] Registering a handler automatically subscribes (no manual subscribe call)
- [ ] Calling the cleanup function automatically unsubscribes
- [ ] Multiple handlers for the same stream all receive data
- [ ] Removing one handler doesn't break the others
- [ ] Removing the last handler for a stream unsubscribes from the cloud
- [ ] Subscriptions survive reconnect (transport down -> reconnected)
- [ ] No duplicate events after reconnect

---

## 18. Error Handling and Edge Cases

- [ ] Handler errors don't crash the session (isolated)
- [ ] Handler errors don't crash the transport
- [ ] Handler errors don't break other managers
- [ ] Calling methods on a stopped session fails gracefully (not an unhandled exception)
- [ ] Calling methods before session is fully connected fails gracefully
- [ ] Network timeout produces a clear error, not a silent hang
- [ ] Invalid API key produces a clear error on startup
- [ ] Invalid package name produces a clear error on startup
- [ ] Port conflict produces a clear error on startup

---

## 19. AI Tool Calls

_Feature is temporarily unavailable. Just verify the registration path doesn't break._

- [ ] `app.onToolCall(async (session, toolName, args) => { ... })` registers without error
- [ ] If a tool call somehow arrives, the handler is invoked
- [ ] Returning a string works (context for Mentra AI)
- [ ] Returning `GIVE_APP_CONTROL_OF_TOOL_RESPONSE` works
- [ ] Returning `undefined` works (tool not handled)

---

## 20. Glasses-Specific Test Matrix

For features that vary by hardware, test on each available glasses:

### Mentra Live (camera, mic, speaker, LED, buttons, WiFi, no display)

- [ ] Camera: photo capture works
- [ ] Camera: video streaming works (managed, restream, direct)
- [ ] Speaker: TTS works
- [ ] Speaker: audio file playback works
- [ ] Speaker: audio output stream works (MP3)
- [ ] Speaker: audio output stream works (PCM16) -- see regression above
- [ ] LED: all colors work
- [ ] LED: blink pattern works -- see regression above
- [ ] Buttons: press events received
- [ ] WiFi: state observables reflect reality
- [ ] WiFi: requestWifiSetup prompts user
- [ ] Mic: audio chunks received
- [ ] Mic: VAD works
- [ ] Display: calls don't crash (no display on Mentra Live)
- [ ] Head position events work

### Even Realities G1 (display, mic, no camera/speaker/LED/buttons/WiFi)

- [ ] Display: all layout types render correctly
- [ ] Display: text wall wraps and truncates properly
- [ ] Display: bitmap renders
- [ ] Dashboard: text shows on dashboard overlay
- [ ] Transcription: works via mic
- [ ] Camera: takePhoto fails with clear error
- [ ] Speaker: calls fail gracefully
- [ ] LED: calls fail gracefully
- [ ] Head position events work
- [ ] Touch/gesture events work

### Mentra Mach1 (narrow display, mic, no camera/speaker/LED/buttons/WiFi)

- [ ] Display: stacked layout for narrow display works
- [ ] Display: text wall on narrow screen
- [ ] All same checks as G1 above

### Phone Only (no glasses connected)

- [ ] Storage works
- [ ] Time works
- [ ] Permissions returns correct state
- [ ] Phone notifications work
- [ ] Phone calendar works
- [ ] Session starts without glasses connected
- [ ] `session.capabilities` is null
- [ ] Display/camera/speaker/LED calls fail gracefully

---

## 21. Error Classes

The SDK exports typed error classes. Verify they are thrown in the right situations.

- [ ] `MentraAuthError` thrown on authentication failures (invalid API key, expired token)
- [ ] `MentraConnectionError` thrown on connection failures
- [ ] `MentraTimeoutError` thrown when operations exceed deadline
- [ ] `MentraValidationError` thrown on invalid input
- [ ] `MentraPermissionError` thrown on permission violations, includes `stream` and `requiredPermission` fields
- [ ] All error classes extend `MentraError` with a `code` field

---

## 22. Utility Exports

- [ ] `BitmapUtils` is exported and usable (for creating bitmap display content)
- [ ] `AnimationUtils` is exported and usable
- [ ] `createLogger(config?)` creates a pino logger with MentraOS defaults
- [ ] `Observable` class is exported (used by DeviceManager state)

---

## 23. Known Regressions Summary (from issue 092)

| #   | Regression                                                       | Severity      | Status                                  |
| --- | ---------------------------------------------------------------- | ------------- | --------------------------------------- |
| 1   | PCM16 audio encoding broken in `SpeakerManager`                  | Ship-blocking | Open                                    |
| 2   | LED blink patterns dropped from `LedManager`                     | Medium        | Open                                    |
| 3   | Permission error/denied events dropped from `PermissionsManager` | Medium        | Open                                    |
| 4   | Phone battery events never sent (ghost API)                      | Low           | Remove or document                      |
| 5   | Camera FOV/ROI control (`setFov`) dropped                        | Low           | Separate issue, redesign later          |
| 6   | `onPhotoTaken` removed                                           | Low           | Intentional (takePhoto returns Promise) |

## 24. Known Bugs Summary (from implementation-status.md)

| #   | Bug                                                           | Location                  | Severity   |
| --- | ------------------------------------------------------------- | ------------------------- | ---------- |
| 1   | `onUpdate()` memory leak, cleanup not stored                  | `LocationManager.ts`      | Must fix   |
| 2   | Sends SUBSCRIPTION_UPDATE per add/remove, should batch        | `_SubscriptionManager.ts` | Must fix   |
| 3   | `requestId` correlation race in concurrent stream checks      | `CameraManager.ts`        | Should fix |
| 4   | `speak()` builds relative URL, implicit cloud dependency      | `SpeakerManager.ts`       | Should fix |
| 5   | `deriveSubscriptions()` exported but never called (dead code) | `DataStreamRouter.ts`     | Should fix |
