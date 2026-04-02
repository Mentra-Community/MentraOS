# Bug Reports — March 25, 2026

7 incidents filed today during internal testing (SF office). All on dev branch, app v2.8.0.

---

## Critical (Severity 5/5)

### 1. G1 Audio: Phone not receiving PCM data from glasses mic for 20+ minutes

**Incidents:** `e8e10728`, `f41b82b2`

G1 glasses connected and captions running, but the mantle (React Native native layer) stopped receiving PCM audio data. The phone logs show `MIC_UNAVAILABLE: UNKNOWN audio_route_changed` and `MIC_UNAVAILABLE: TRUE external_app_recording` — the native audio system thinks an external app is using the mic, blocking MentraOS from recording. Audio never recovered until the user manually switched from glasses mic to phone mic, at which point captions started working again. Lasted 20+ minutes with no auto-recovery.

**Root cause hypothesis:** Android audio route detection on Pixel 8 / Android 14 is misidentifying the G1 BLE mic state as "external app recording", causing `systemMicUnavailable` to stay true. Switching to phone mic bypasses this because it uses the phone's built-in mic instead of the BLE audio path.

**Owned by:** Mobile (Android native mic manager)

---

### 2. Apps not starting / UI not reflecting running state

**Incident:** `2b8ab1d8` (4 screenshots attached)

User reports captions are visibly running on the glasses (text appearing in FOV), but the mobile app UI shows no running apps and won't let them start any new apps. `runningApps` in the incident snapshot only shows `["com.mentra.feedback"]` — no captions listed despite them being visible on the glasses. The phone thinks nothing is running; the cloud thinks captions is running.

**Root cause hypothesis:** State desync between the cloud's app state and the mobile client's applet store. The cloud has apps running (captions visible on glasses), but the `app_state_change` messages from the cloud either aren't arriving or aren't being processed by the mobile client.

**Owned by:** Mobile (applet state sync) / Cloud (app state broadcasting)

---

### 3. Mentra AI "disconnected" banner — app unrecoverable after reconnect

**Incident:** `ddf28de9` (external user, iOS, Mentra Live)

User was running Mentra AI. The app showed a "disconnected" banner. The banner eventually went away (connection restored) but Mentra AI never recovered — it stayed non-functional. Phone logs show `WSM: Starting reconnect interval` confirming a WebSocket disconnect and reconnect occurred. At report time `internetReachable: false` despite WiFi connected — network was degraded.

**Root cause hypothesis:** The mini app's WebSocket connection to cloud dropped and reconnected, but the app session wasn't properly restored on the cloud side. This is the same reconnect-path issue from issue 051 — the fast-path `updateWebSocket` doesn't force app session re-evaluation. The "banner went away" = WebSocket reconnected, but the app's subscription/session state was stale.

**Owned by:** Cloud (app session reconnect lifecycle)

---

### 4. 401 errors when starting captions

**Incident:** `5797e32a`

Both `com.mentra.captions` and `com.mentra.captions.debug` fail to start with HTTP 401. Phone logs: `Failed to start applet com.mentra.captions: AxiosError: Request failed with status code 401`. Cloud logs confirm: `HTTP 401 POST /apps/com.mentra.captions/start`. G1 battery at 3% — possible the session expired or the auth token rotated during extended use.

**Root cause hypothesis:** Either the core token (JWT) expired and wasn't refreshed, or the app start endpoint is rejecting a stale session credential. Needs investigation into token refresh lifecycle during long sessions.

**Owned by:** Cloud (auth) / Mobile (token refresh)

---

## Low / Moderate

### 5. Settings button doesn't work on Simulated Glasses

**Incident:** `763125a6` (Severity 3/5, 1 screenshot)

Pressing the settings button in simulated glasses mode does nothing. Simulated Glasses connected, captions and recorder running. Likely a missing button handler in the simulated glasses SGC implementation.

**Owned by:** Mobile (Simulated Glasses SGC)

---

### 6. Screenshots appear zoomed in

**Incident:** `b6328d74` (Severity 1/5, 1 screenshot)

Minor UI issue — screenshots in the incident viewer or feedback flow appear zoomed in. Low priority.

**Owned by:** Mobile (UI)

---

## Common Patterns

- **5 of 7 incidents are from the same user/device** (Pixel 8, Android 36, dev branch) — some may be related or cascading from the same root issue (audio route problems → no captions → can't start apps → 401)
- **`MIC_UNAVAILABLE: UNKNOWN audio_route_changed`** appears in both audio incidents — this is the Android native layer losing track of the audio route
- **`connectionState: "disconnected"` while `connected: true`** appears in multiple incidents — the phone state is internally contradictory, suggesting the connection state tracking has a race or stale-state bug
- **All on dev branch build `1e414ee13` (March 24)** — a recent dev build, not staging or prod
