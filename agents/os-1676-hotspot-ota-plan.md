# OS-1676: Mentra Live OTA via hotspot — implementation plan

Ticket: [OS-1676](https://linear.app/mentralabs/issue/OS-1676) — enterprise users in the
field have no WiFi and refuse phone hotspots, so glasses can't update. Plan: when the
user starts the update, the phone downloads the OTA artifacts, joins the **glasses'**
local-only hotspot, and serves the manifest + artifacts to the glasses over the hotspot
link via an HTTP server on the phone.

Constraints from the ticket + comments (+ decisions since):

- The glasses-WiFi download path stays primary; hotspot transfer is the fallback.
- "First fix the MTK hotspot so it doesn't steal your phone's internet." (Android is
  already fixed; the glasses-AP DHCP fix was flagged to the MTK team 2026-07-28 but does
  **not** gate this work.)
- **No background pre-download** (decision 2026-07-28, supersedes the ticket's
  background-download wording): the user doesn't consent to a ~200 MB download just by
  having an update available. Artifacts are downloaded **when the user taps update**,
  over whatever network the phone is on — same consent model as the glasses' own
  download in the current WiFi path. Flow: "update available" prompt → user starts
  update → phone downloads artifacts → OS join dialog → transfer over hotspot →
  normal OTA flow.

## Why this is mostly plumbing, not protocol work

Three facts from the current codebase make this feature far smaller than it looks:

1. **OTA is already phone-driven and URL-parameterized.** The phone sends BLE
   `ota_start` with a mandatory `ota_version_url`; the glasses accept **any http(s) URL
   with a host** (`OtaCommandHandler.getValidatedOtaVersionUrl`,
   `asg_client/.../service/core/handlers/OtaCommandHandler.java:123` — plain `http`
   explicitly allowed, so IP-literal URLs work and SSL/clock-skew issues vanish). Pointing
   the glasses at `http://<phone-ip>:<port>/version.json` requires **zero new BLE
   messages**.
2. **The hotspot dance already exists and is already fixed on Android.** Gallery sync
   drives `set_hotspot_state` → `hotspot_status_update {ssid, password, gateway_ip}` →
   phone joins. On Android 10+ the join goes through `MentraLocalNetworkModule.kt`
   (`WifiNetworkSpecifier` + `removeCapability(NET_CAPABILITY_INTERNET)`, no
   `bindProcessToNetwork`), so cellular stays the default network — the "steals your
   internet" fix the ticket asks for is **already shipped for Android** (OS-1709, commit
   `f94026dcb5`). Glasses-side, `K900NetworkManager` uses `startLocalOnlyHotspot()`.
   iOS still loses internet while joined (no scoped-routing equivalent) — see Risks.
3. **The phone already has an embedded HTTP server on both platforms.**
   `LocalPhotoUploadServer` (Kotlin `ServerSocket`, 622 lines; Swift `NWListener`, 754
   lines) in the Bluetooth SDK, port ladder 8787–8790, with `bestLocalIpv4Address()` IP
   discovery. It only handles `POST /upload` + `GET /health` today; it needs a static-file
   `GET` handler.

So the work is: (a) a phone-side artifact cache, (b) a static-file server, (c) an
orchestration layer that runs the hotspot dance around the existing
`OtaInstallCoordinator`, and (d) a small set of glasses-side hardening changes.

## The hard constraints discovered in the code

These drive the design and must not be glossed over:

- **The APK install kills the hotspot.** The `LocalOnlyHotspotReservation` is owned by the
  asg_client process; the APK install kills that process (`installApk` fires the SystemUI
  intent and dies). The hotspot drops mid-session and **credentials rotate on every
  start** (`INetworkManager.startHotspot()` takes no args; SSID/password are
  Android-generated). Downloads are **per-step** (`processAppsSequentially`: APK
  download+install → restart → MTK download+install → BES download+install), so a
  full apk+mtk+bes update needs **two hotspot windows**: one for the APK, one (after the
  restart) for MTK+BES.
- **The hotspot auto-stops after 120 s without inbound HTTP.**
  `BaseNetworkManager`'s idle monitor is fed only by the glasses' NanoHTTPD server
  (`AsgServer.recordHttpActivity`). During phone-served OTA the glasses are the HTTP
  *client*, so nothing refreshes the timer and the hotspot dies mid-download.
  **Workaround that needs no glasses change:** the phone polls the glasses'
  `http://192.168.43.1:8089/api/health` every ~30 s for the duration of the OTA — that
  registers as HTTP activity and holds the hotspot open even on existing field builds.
- **Glasses-outbound HTTP over the AP interface is unproven.** Everything today is
  inbound (phone → glasses NanoHTTPD). The OTA downloader is plain
  `HttpURLConnection`; with `wlan0` unassociated there may be no default network, and
  Android per-network routing may not route an unbound socket to the `ap0` subnet.
  This is the **Phase 0 spike** — if old builds can't do it, the compatibility floor moves
  (see Rollout).
- **Session resume uses a persisted manifest URL.** `OtaSessionManager.createSession`
  stores `lastVersionJsonUrl`; after the APK restart the glasses may auto-resume from a
  URL whose IP/port belong to the *previous* hotspot window. The phone re-sends
  `ota_start` with a fresh URL on reconnect (coordinator already does the
  post-APK `ota_start` after `POST_APK_OTA_START_DELAY_MS`), but the glasses-side
  stale-URL resume must fail fast and not wedge the session.

## Architecture

```
Phone (Mentra App)                       Glasses (asg_client)
──────────────────                       ────────────────────
OtaUpdateChecker ──┐
                   ▼
OtaArtifactDownloader (new) ← downloads apk/mtk/bes on update start + verifies sha256
                   │
LocalOtaServer    (new)  ← serves /version.json (rewritten) + /artifacts/*
                   │
HotspotOtaTransport (new orchestration in engine)
  1. download artifacts (any network; must finish BEFORE joining the hotspot)
  2. setHotspotState(true)  ──BLE──►  K900NetworkManager.startLocalOnlyHotspot()
  3. ◄──BLE── hotspot_status_update {ssid, password, gateway_ip}
  4. join via localNetworkTransport (Android scoped / iOS NEHotspotConfiguration)
  5. resolve own IPv4 on hotspot subnet; start LocalOtaServer
  6. sendOtaStart("http://<phone-ip>:<port>/version.json")  ──BLE──►  OtaCommandHandler
  7. keep-alive: GET http://192.168.43.1:8089/api/health every 30 s
  8. ◄──BLE── ota_status (unchanged protocol; OtaInstallCoordinator unchanged watchdogs)
  9. on APK restart: hotspot died → redo steps 2–6 (fresh creds/URL), coordinator
     re-arbitration sends fresh ota_start
 10. teardown: stop server, disconnect scoped network, setHotspotState(false)
```

The manifest the phone serves is the **same manifest it already fetched** for the
update check (`OtaUpdateCheckService.fetchVersionInfoDetailed` keeps `manifestBody`),
with only the URL fields rewritten (`apps[*].apkUrl`, `mtk_patches[*].url`,
`bes_firmware.url` → `http://<phone-ip>:<port>/artifacts/<sha256>`). Version codes and
`sha256` fields are untouched, so the glasses' existing verification
(`verifyApkFile`/`verifyFirmwareFile`) works unchanged.

## Phases

### Phase 0 — Bench spike: glasses-outbound HTTP over the hotspot (no code shipped)

> **RESULT (2026-07-28, bench: Mentra Live dev build off `dev` + Galaxy Fold via adb):**
> **The critical case works with zero glasses changes.** With `wlan0` fully
> unassociated (network forgotten, radio on) and the phone joined to the glasses'
> LocalOnlyHotspot, the stock OTA path (`DEBUG_APK_OTA` → `OtaHelper` →
> `HttpURLConnection`) fetched the manifest from `http://192.168.43.100:8080/` and
> downloaded + sha256-verified the full 111 MB APK in ~4 s, then installed it and the
> app restarted (hotspot died with the process, as the two-window design assumes). The
> socket auto-bound to the AP address (`from /192.168.43.1`) — **no `Network` binding
> needed**, so the compatibility floor stays at existing field builds (≥ 39 for
> `ota_start` URL + hotspot support), not a new build.
>
> Second finding: with a **normal** WiFi join (`cmd wifi connect-network`, equivalent
> to the Android 9 legacy / react-native-wifi-reborn path), the Samsung phone silently
> abandoned the internet-less hotspot after ~1 min and rejoined its saved home WiFi
> mid-flow (first OTA attempt died in `SocketTimeoutException` because the peer left;
> `network_avoid_bad_wifi=0` did not prevent it — Samsung's own switcher). The
> production Android 10+ scoped join (`WifiNetworkSpecifier`) pins the connection and
> is not subject to this, but this kills any temptation to ship the legacy join path
> for hotspot OTA on Android: **scoped join is a hard requirement**, and iOS behavior
> under its "no internet, use anyway?" prompt needs explicit bench verification in
> Phase 3.
>
> Added in this spike (ships with PR1): `DebugHotspotReceiver`
> (`com.mentra.DEBUG_HOTSPOT --ez enabled true|false`) — drives the real
> `NetworkManagerFactory`/`K900NetworkManager` LocalOnlyHotspot path via adb with a
> keep-alive thread defeating the 120 s idle stop. Also observed: hotspot credentials
> are OEM-weak (`AndroidShare_6105` / `00001111`) — flagged under Security.

Join the glasses hotspot from a laptop, run `python3 -m http.server` serving a copy of a
manifest + APK with rewritten URLs, and fire the existing debug receiver
(`adb shell am broadcast -a com.mentra.DEBUG_APK_OTA --es url http://192.168.43.x:8080/version.json`).
Test with glasses `wlan0` (a) associated and (b) unassociated.

Outcomes:
- **Works on current field builds** → best case: the whole feature is phone-side except
  optional hardening; compatibility floor = build 39 (`ota_start` URL support) + whatever
  build shipped `set_hotspot_state`.
- **Needs socket/Network binding** → add it to `OtaHelper` downloads (bind to the
  LocalOnlyHotspot `Network`, or an interface-bound socket factory when the target is in
  the AP subnet); compatibility floor = the new ASG build, and field units need one last
  WiFi-based (or factory) update to gain the capability. Surface this to the team early —
  it changes the enterprise story.

Also verify in this spike: hotspot stays up past 120 s when the laptop polls
`/api/health`; download throughput over the hotspot (sets user expectations for the
progress UI — artifacts are ~100 MB APK + up to 100 MB MTK + 2 MB BES).

### Phase 1 — Phone artifact download (`mobile/modules/engine`)

New `OtaArtifactDownloader` alongside `OtaUpdateCheckService`, invoked **only when the
user starts the update** (no background pre-download — the user's tap is the consent,
and the phone uses whatever network it's on, same as the glasses do in the current WiFi
path):

- Input: the `checkForOtaUpdate` result (`updates`, `manifestBody`, per-artifact URLs +
  sha256).
- Downloads to `${DocumentDirectory}/ota_artifacts/<sha256>` via `RNFS.downloadFile`
  (pattern: `STTModelManager.ts:213`), `.part` staging + rename (pattern:
  `BlobStore.ts`), sha256 verify after download, re-verify before serving.
- Files are keyed by sha256 so a retry after a failed attempt (or the post-APK second
  hotspot window) reuses what's already verified on disk instead of re-downloading.
  Delete everything on OTA completion or when the manifest no longer references it.
  Mark excluded-from-backup.
- Progress feeds the update screen: `downloading{percent} | ready | failed{reason}`.
- Must complete **before** the hotspot join — mandatory for iOS (joining drops
  internet), harmless everywhere else.
- No Range-resume in v1 (nothing in the repo resumes today); restart-from-zero with
  retry is acceptable for phone-side downloads on real internet. Add resume later if
  field data says otherwise.

### Phase 2 — Phone local HTTP server (`mobile/modules/bluetooth-sdk` native)

Generalize `LocalPhotoUploadServer` (both platforms) or add a sibling `LocalOtaServer`:

- `GET /version.json` → rewritten manifest (content handed to native from JS at start).
- `GET /artifacts/<sha256>` → streamed file with `Content-Length`; support `Range`
  (cheap and future-proofs glasses-side resume) — the 25 MB upload cap doesn't apply to
  reads.
- `GET /health` (already exists).
- Reuse the 8787–8790 port ladder and `bestLocalIpv4Address()` (it already prefers
  `wlan*`); on Android prefer deriving the IPv4 from the scoped `Network`'s
  `LinkProperties` (the `MentraLocalNetworkModule` retains the `Network` object) —
  more robust than interface-name heuristics.
- Expo module surface: `start(manifestJson, artifactPaths) → {host, port}` / `stop()`.
- Lifetime strictly scoped to an active hotspot OTA session (see Security).

### Phase 3 — Orchestration (`mobile/modules/engine`)

New `HotspotOtaTransport` (engine service) used by `OtaInstallCoordinator`:

- **Path selection**: if glasses report WiFi connected → existing cloud-URL path,
  untouched (primary, per ticket comment). Else → hotspot path: download artifacts
  (Phase 1), then bring up the hotspot session. The current hard gate that pushes users
  to `/wifi/scan` when glasses lack WiFi (`OtaUpdateChecker.tsx:210`,
  `check-for-updates.tsx:209`) is replaced by this branch.
- **Session bring-up** (steps 2–6 above): reuse `gallerySyncService`'s hotspot
  choreography (`setHotspotState`, `HOTSPOT_CONNECT_DELAY_MS`, `connectToHotspotWifi`,
  iOS SSID-poll + health-probe verification) — extract the shared parts rather than
  duplicating; gallery sync keeps working.
- **Keep-alive**: poll glasses `/api/health` every 30 s while the hotspot session is
  active (works on existing builds; replaced by an explicit hold on new builds, Phase 5).
- **APK-restart window**: on `glasses_session_changed` / reconnect after the APK step,
  the coordinator already re-arbitrates. Hook the hotspot path in: re-run bring-up with
  fresh credentials, then let the existing post-APK `ota_start` fire with the **new**
  URL. Budget the extra time into `POST_APK_OTA_START_DELAY_MS`-adjacent watchdogs
  (hotspot re-join adds ~10–30 s; today's `PROGRESS_TIMEOUT_MS` 120 s should absorb it,
  verify on bench).
- **MTK-only reboot**: device reboots after MTK (`scheduleMtkRebootToApplyUpdate`);
  downloads are done by then, so just tear down and let the normal reconnect flow
  confirm completion via `ota_query_status`.
- **Mutual exclusion with gallery sync**: single hotspot-session arbiter (both consume
  `setHotspotState` + `localNetworkTransport`); OTA takes priority, gallery sync defers.
- **Teardown on every terminal state** (complete/failed/timeout): stop server,
  `localNetworkTransport.disconnect()`, `setHotspotState(false)` — mirror
  `gallerySyncService.closeHotspot()` including its error-path hardening.
- **Phone stays awake**: progress screen already keeps the app foregrounded; add
  keep-awake on the OTA progress route (iOS suspension would kill the `NWListener`
  server; Android can additionally lean on the existing `Foreground.kt` service).

### Phase 4 — UI/UX (`mobile/src`)

- **Prompt**: the existing "update available" alert (`OtaUpdateChecker` /
  `/ota/check-for-updates`) stays the entry point for both paths; `handleUpdateNow`
  branches on glasses-WiFi state. On the hotspot path, warn about the download size
  when the phone is on cellular, and mention the OS join dialog the user is about to
  see (Android device picker / iOS NEHotspotConfiguration prompt).
- **Progress**: `/ota/progress` gains pre-`ota_status` phases:
  `downloading-to-phone` (from `OtaArtifactDownloader` progress),
  `connecting-hotspot`, then the existing `starting|updating|restarting|complete|failed`
  driven by `ota_status`. During the APK-restart hotspot re-join, show "reconnecting"
  (the `restarting` state already exists).
- **Errors**: new mappings in `otaErrorMapping.ts`: phone download failed,
  hotspot-start failed (`hotspot_error`), join declined/timeout, phone-server
  unreachable; i18n under `ota:`.
- **Settings**: super-mode override to force the hotspot path even when glasses have
  WiFi (for testing).

### Phase 5 — Glasses-side hardening (`asg_client`) — IMPLEMENTED (PR1), scope cut by spike

Spike outcomes rewrote this phase:

1. ~~Hold the hotspot during OTA~~ **Dropped.** The camera web server (port 8089)
   starts unconditionally at service init (Step 7, `AsgClientServiceManager:147`), so
   the phone's `/api/health` keep-alive polling feeds the idle monitor on **all**
   builds — a glasses-side hold would only save the polling and needs a singleton
   `INetworkManager` refactor (`NetworkManagerFactory` returns a new instance per
   call) that isn't worth it.
2. ~~Outbound binding fix~~ **Dropped** — spike proved stock `HttpURLConnection`
   routes out `ap0` unmodified.
3. **Stale resume URL — implemented.** `OtaService.resumeFromSession` now waits for
   the session's manifest URL to answer (HEAD probe, 3 s timeout, every 5 s, 60 s
   window — constants in `AsgConstants`) before running the resume check, standing
   down if a fresh phone `ota_start` supersedes it (check-lock or session movement).
   Without this, every hotspot-path full update would burn ~15 s in a guaranteed
   connect timeout and race a terminal-looking failure against the phone's rejoin
   (worse: with stale `currentUpdateType`, `updateSessionFromProgress` can skip
   `setFailed`, wedging the session `in_progress` until the 30-min expiry). After the
   window the check runs anyway — today's exact failure semantics.
   New accessor: `OtaHelper.isVersionCheckInProgress()`.
4. Also in PR1: `DebugHotspotReceiver` (bench tooling), and a build fix so Spotless's
   ratchet is skipped in linked git worktrees (nearest `.git` entry is a file).
5. (Stretch / follow-up) **Front-load downloads**: download apk+mtk+bes *before* the
   first install so a full update needs only **one** hotspot window and the
   restart-rejoin complexity disappears. This also de-risks the existing WiFi path
   (network can drop mid-sequence today). Bigger change to
   `processAppsSequentially`/`OtaSessionManager` — separate PR, not v1.

### Phase 6 — Testing & rollout

- **Bench (hardware)**: full apk+mtk+bes update over hotspot on real glasses; APK-only;
  MTK-only (reboot path); BES-only (`sr_adota` over BLE is transport-independent —
  verify anyway); kill-tests: phone walks away mid-download, user declines the join
  dialog, hotspot start fails (`hotspot_error`), app backgrounded on iOS mid-transfer.
- **Compat matrix**: current field build (floor per Phase 0) × Android 10+/iOS phone;
  Android 9 phone uses the legacy `react-native-wifi-reborn` join (process-bound —
  acceptable, transfer window only, internet loss on Android 9 is a known tradeoff).
- **Regression**: gallery sync before/after (shared hotspot arbiter), normal WiFi OTA
  path untouched, `./scripts/check-android-compile.sh` both targets, engine/mobile Jest
  suites, coordinator unit tests for the new path-selection + rejoin edges.
- **Rollout**: super-mode-only toggle first → enterprise cohort → general. The ASG
  build N must reach devices via the *existing* WiFi path (or factory image) before the
  hotspot path is load-bearing for units that need Phase 5 fixes.

## Suggested PR split

| # | Repo area | Content |
|---|-----------|---------|
| 1 | `asg_client` | Phase 5 items 1–3 (hotspot hold, outbound binding if needed, stale-resume handling) — ship first so build N propagates |
| 2 | `mobile/modules/bluetooth-sdk` | `LocalOtaServer` native module (Android + iOS) + tests |
| 3 | `mobile/modules/engine` | `OtaArtifactDownloader` + manifest rewrite + tests |
| 4 | `mobile/modules/engine` | `HotspotOtaTransport` + coordinator integration + hotspot arbiter + tests |
| 5 | `mobile/src` | UI: prompt, progress phases, errors, settings, i18n |
| 6 | `asg_client` (later) | Phase 5 item 4: front-loaded downloads |

## Risks & open questions

- **iOS loses internet while joined to the hotspot.** No scoped-network equivalent
  exists on iOS (`notes/wifi-aware-feasibility.md:17-19`). Mitigation: the artifact
  download completes before joining, so the join window is transfer-only (minutes); the
  cloud websocket drops and recovers after teardown. The ticket's "fix the hotspot
  first" is satisfied for Android (already shipped via OS-1709); for iOS the answer is
  "time-boxed loss during transfer". The glasses-AP DHCP/route fix was raised with the
  MTK team (2026-07-28) as an independent firmware track
  (`agents/gallery-sync-reliability-compatibility-plan.md:365` Phase 4) — it does not
  gate this work. Android 9 phones have the same tradeoff (legacy join path).
- **Phase 0 outcome decides the compatibility floor.** If outbound-over-`ap0` needs a
  glasses fix, existing field units can't use hotspot OTA until they've taken one more
  WiFi update — exactly the population this ticket targets. Get the spike done first;
  if the floor moves, tell the enterprise team immediately.
- **Security**: the phone server is unauthenticated HTTP, but it only serves public OTA
  artifacts, only binds while an OTA session is active, and the hotspot is WPA2 with
  per-session credentials known only to phone+glasses. Optionally bind the listener to
  the hotspot-subnet address instead of `0.0.0.0`. Low risk; document and move on.
- **Watchdog fit**: hotspot bring-up (esp. the post-APK rejoin) adds latency inside
  windows tuned for the WiFi path (`otaInstallPolicy.ts`). Bench-measure and pad only
  what needs padding.
- **Old-build hotspot keep-alive** relies on `/api/health` polling refreshing
  `recordHttpActivity` — verify in Phase 0 that health hits actually feed the idle
  monitor on the current field build.
