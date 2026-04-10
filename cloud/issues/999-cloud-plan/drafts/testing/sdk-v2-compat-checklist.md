# SDK V2 Compat Shim Test Checklist

Does an existing v2 app still work against the v3 cloud and v3 SDK without code changes?

The v3 SDK includes `_V2*Shim` classes that preserve the old API surface. These shims delegate to the new v3 managers internally. They will be removed in v3.1, but for now every published v2 app depends on them working.

## How to test

Pick a real v2 mini app (captions, dashboard, livestreamer, or any published app). Run it against the v3 cloud without changing any app code. It should work identically to how it worked on v2.

---

## Session Lifecycle

- [ ] `onSession(session, sessionId, userId)` fires with correct arguments
- [ ] `onStop(sessionId, userId, reason)` fires on app stop
- [ ] `session.userId` returns correct user ID
- [ ] `session.sessionId` returns correct session ID
- [ ] `session.logger` works for logging

## Events (session.events)

- [ ] `session.events.onTranscription(handler)` receives transcription data
- [ ] `session.events.onTranslation(handler)` receives translation data
- [ ] `session.events.onButtonPress(handler)` receives button events (Mentra Live)
- [ ] `session.events.onHeadPosition(handler)` receives head position events
- [ ] `session.events.onPhoneNotification(handler)` receives phone notifications
- [ ] `session.events.onNotificationDismissed(handler)` receives dismissals
- [ ] `session.events.onGlassesBatteryUpdate(handler)` receives battery updates
- [ ] `session.events.onGlassesConnectionState(handler)` receives connection state changes
- [ ] `session.events.onVAD(handler)` receives voice activity detection
- [ ] `session.events.onAudioChunk(handler)` receives raw audio chunks

## Display (session.layouts)

- [ ] `session.layouts.showTextWall(text)` displays text on glasses
- [ ] `session.layouts.showDoubleTextWall(left, right)` displays side-by-side text
- [ ] `session.layouts.showReferenceCard(title, body)` displays reference card
- [ ] `session.layouts.showText(text)` displays simple text
- [ ] `session.layouts.showBitmap(data)` displays bitmap
- [ ] `session.layouts.clear()` clears the display

## Audio (session.audio)

- [ ] `session.audio.speak(text, options)` triggers text-to-speech
- [ ] `session.audio.playAudio(url)` plays audio file
- [ ] `session.audio.stopAudio()` stops audio playback
- [ ] Audio output stream creation works (if the v2 app uses it)

## Camera (session.camera)

- [ ] `session.camera.requestPhoto(options)` captures a photo (Mentra Live)
- [ ] `session.camera.startLivestream(rtmpUrl)` starts a livestream (Mentra Live)
- [ ] `session.camera.stopLivestream()` stops a livestream (Mentra Live)
- [ ] `session.camera.startLocalLivestream()` starts local stream (Mentra Live)
- [ ] `session.camera.stopLocalLivestream()` stops local stream (Mentra Live)

## LED (session.led)

- [ ] `session.led.turnOn(color, duration)` turns on LED (Mentra Live)
- [ ] `session.led.turnOff()` turns off LED (Mentra Live)
- [ ] `session.led.blink(color, onTime, offTime, count)` blink pattern (Mentra Live)

## Location (session.location)

- [ ] `session.location.subscribeToStream()` starts location updates
- [ ] `session.location.getLatestLocation()` returns location data

## Dashboard (session.dashboard)

- [ ] Dashboard content updates work via v2 API

## Settings

- [ ] `session.getSettings()` returns current settings
- [ ] `session.getSetting(key)` returns specific setting
- [ ] `session.getConfig()` returns app config
- [ ] `session.getDefaultSettings()` returns defaults
- [ ] Settings changes from the mobile app are received

## Storage (session.simpleStorage)

- [ ] `session.simpleStorage.get(key)` retrieves value
- [ ] `session.simpleStorage.set(key, value)` stores value
- [ ] `session.simpleStorage.hasKey(key)` checks existence
- [ ] `session.simpleStorage.delete(key)` removes key
- [ ] `session.simpleStorage.clear()` removes all data
- [ ] `session.simpleStorage.keys()` lists keys
- [ ] `session.simpleStorage.size()` returns count
- [ ] `session.simpleStorage.getAllData()` returns all pairs
- [ ] `session.simpleStorage.setMultiple(data)` batch set
- [ ] Data persists across sessions

## Subscriptions

- [ ] `session.subscribe(stream)` subscribes to a data stream
- [ ] `session.unsubscribe(stream)` unsubscribes from a data stream
- [ ] Subscribing to transcription via the old API works
- [ ] Subscribing to audio chunks via the old API works

## Device / Connection

- [ ] `session.capabilities` returns correct capabilities object
- [ ] `session.getWifiStatus()` returns WiFi state
- [ ] `session.isWifiConnected()` returns boolean
- [ ] `session.requestWifiSetup(reason)` triggers WiFi prompt
- [ ] `session.onGlassesConnectionState(handler)` fires on connection changes
- [ ] `session.subscribeToGestures(gestures)` subscribes to gestures

## Low-Level

- [ ] `session.sendMessage(msg)` sends raw message
- [ ] `session.sendBinary(data)` sends binary data
- [ ] `session.on(event, handler)` generic event handler works

## Custom Routes

- [ ] Custom Express-style routes added to the old `AppServer` still work
- [ ] Webhook endpoint receives and processes correctly

---

## Known Missing V2 Compat Methods

These methods exist on the old `AppSession` but are NOT yet on the v2 shim. If any real v2 app uses them, it will break. Check during testing whether any of these are called.

Reference: `cloud/issues/048-sdk-v3/implementation-status.md`, Missing V2 Compat Methods section.

| Method                              | Status      | Notes                                  |
| ----------------------------------- | ----------- | -------------------------------------- |
| `subscribe(stream)`                 | Not shimmed | Needs `_SubscriptionManager.add()`     |
| `unsubscribe(stream)`               | Not shimmed | Needs `_SubscriptionManager.remove()`  |
| `on(event, handler)`                | Not shimmed | Route through `_V2EventManagerShim`    |
| `getSettings()`                     | Not shimmed | Trivial: return `session.settingsData` |
| `getSetting(key)`                   | Not shimmed | Trivial: delegate to settings shim     |
| `setSubscriptionSettings(opts)`     | Not shimmed | Medium effort                          |
| `getConfig()`                       | Not shimmed | Trivial: return `session.appConfig`    |
| `loadConfigFromJson(json)`          | Not shimmed | Low effort                             |
| `getServerUrl()`                    | Not shimmed | Trivial                                |
| `getHttpsServerUrl()`               | Not shimmed | Low effort: convert WS URL to HTTPS    |
| `getDefaultSettings()`              | Not shimmed | Low effort                             |
| `getSettingSchema(key)`             | Not shimmed | Low effort                             |
| `getWifiStatus()`                   | Not shimmed | Trivial: read observable               |
| `isWifiConnected()`                 | Not shimmed | Trivial: read observable               |
| `requestWifiSetup(reason)`          | Not shimmed | Trivial                                |
| `onGlassesConnectionState(handler)` | Not shimmed | Low effort                             |
| `subscribeToGestures(gestures)`     | Not shimmed | Trivial                                |
| `sendMessage(msg)`                  | Not shimmed | Trivial                                |
| `sendBinary(data)`                  | Not shimmed | Trivial                                |
| `capabilities` (property)           | Not shimmed | Trivial                                |

## Test Apps to Use

Pick from real published v2 apps. These are the ones that matter because they're in production:

- **Captions** - uses transcription, display, settings
- **Dashboard** - uses dashboard, device state, phone notifications, calendar
- **Livestreamer** - uses camera streaming, LED, device state
- **Translation** - uses transcription, translation, display
- **Calendar Reminder** - uses phone calendar, display, time

If any of these break, the shim has a gap that needs fixing before v3 goes stable.
