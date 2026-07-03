# Cloud V1 Remnant Audit (WP 9)

Date: 2026-07-02
Scope: `mobile/src/services/{MantleManager,SocketComms,WebSocketManager}.ts`,
`mobile/modules/island/src/services/RestComms.ts` — every remaining call path,
classified per the work-package-9 dispositions: **delete-now**,
**keep-until-named-V2-port**, **move-into-toolkit**, or **host-owned-fine**.

## Headline conclusions

- **No device-state mirror remains.** Nothing calls
  `/api/client/device/state`; `updateGlassesState`,
  `sendGlassesConnectionState`, and V1 `glasses_battery_update` forwarding are
  gone. WP 10 is genuinely complete.
- **Island does not depend on Cloud V1.** The V1 stack is host-side only
  (plus island `RestComms`, which is the V1 REST client itself). Nothing in
  island consumes the V1 WebSocket or its message types.
- What remains is a coherent **Cloud-SDK-app bridge**: V1-hosted third-party
  apps still need device event relay, media commands, catalog/settings, and
  webview auth. It shrinks feature-by-feature as Cloud V2 ports land; none of
  it should gain new callers.
- The provably dead paths found by this audit were **deleted on the
  integration branch** (see "Deleted" below).

## Deleted (was delete-now; done on `integration/toolkit-boundary`)

| Path | Why it was safe |
| --- | --- |
| `SocketComms.handle_app_state_change` | log-and-ignore no-op |
| `SocketComms.handle_app_started` / `handle_app_stopped` | log-and-ignore no-ops (dispatch cases folded into the ignored-legacy group) |
| `SocketComms.sendLocalTranscription` | deprecated no-op; transcripts flow to local miniapps via LocalMiniappRuntime |
| `SocketComms.sendVideoStreamResponse` | no call sites |
| `SocketComms.sendMessage` | generic raw send; no call sites after the runtime `socketComms` hook was removed |

Note: `RestComms.sendLocationData` looked dead from the host side but is
**live** — island `PhoneLocationService.ts:35` calls it. Keep-until-V2-port.

## WebSocketManager (host)

Pure V1 transport: connect/reconnect, ping/pong liveness, backend-URL watch,
`NO_ACTIVE_SESSION` recovery, message dispatch to SocketComms. No business
logic, no device state. **Disposition: keep-until-V2-port as a unit.** When
Cloud V2 replaces the app-session channel, this file and SocketComms retire
together.

## SocketComms (host) — V1 message bridge

| Path | Direction | Disposition | Notes |
| --- | --- | --- | --- |
| `connectWebsocket` / `setAuthCreds` (core_token) | — | keep-until-V2-port | V1 session bootstrap; V2 auth is island-owned |
| `display_event` | cloud→device | keep-until-V2-port | Cloud-SDK app display path (glasses + mirror store) |
| `photo_request` → BluetoothSdk.requestPhoto | cloud→device | keep-until-V2-port | V1-app photo pipeline; local miniapps use the island coordinator instead |
| `start_stream` / `stop_stream` / `keep_stream_alive` | cloud→device | keep-until-V2-port | externally-managed streams |
| `start_video_recording` / `stop_video_recording` | cloud→device | keep-until-V2-port | cloud-supplied webhook/auth |
| `rgb_led_control` (+ response send) | cloud→device | keep-until-V2-port | |
| `camera_fov_set` | cloud→setting | keep-until-V2-port | writes `SETTINGS.camera_fov` |
| `show_wifi_setup` | cloud→UI | keep-until-V2-port | host navigation is the right owner of the alert |
| `set_location_tier` / `request_single_location` | cloud→island/host | keep-until-V2-port | delegates to island phoneLocationService / Mantle |
| sends: `touch_event`, `button_press`, `swipe_volume_status`, `switch_status`, `head_position`, `sendText` (ws_text), `stream_status`, `keep_alive_ack`, `sendLocationUpdate` | device→cloud | keep-until-V2-port | event relay for Cloud-SDK apps; **not** state mirroring |
| `data_stream` | cloud→(blocked) | keep comment | deliberately not forwarded to local miniapps |

## MantleManager (host) — bootstrap + relay seam

| Area | Disposition | Notes |
| --- | --- | --- |
| `init()` order: toolkit.configure/start, catalog init, settings load, reconnect kick | host-owned-fine | this is the host bootstrap seam the design allows |
| Legacy settings field scrub (core_token/device_*/controller_*) | delete-later | remove once no installed client rewrites them |
| `syncTimezone`, `sendCalendarEvents` (+ BLE push), notification forwarding | keep-until-V2-port | REST targets are V1; BLE half is island-adjacent and fine |
| BluetoothSdk event subscriptions that only relay to SocketComms (button/touch/swipe/switch/rgb/ws_text/stream-status/keep-alive) | keep-until-V2-port | thin relays; island DeviceEventRouter owns everything else |
| `requestSingleLocation` | move-into-toolkit later | pairs with a future V2 location API |
| `cleanup()` (+ `restComms.goodbye()`) | host-owned-fine | courtesy call |

## RestComms (island) — V1 REST client

| Endpoint group | Disposition | Notes |
| --- | --- | --- |
| `/auth/exchange-token`, core_token storage | keep-until-V2-port | V1 session auth; V2 tokens live in island CloudClientService |
| `/api/client/min-version` | keep-until-V2-port | app-launch gate (`toolkit.dev.minimumClientVersion`) |
| `/api/client/user/settings` GET/POST | keep-until-V2-port | settings sync; portable payload, endpoint will move |
| `/api/client/calendar`, `/api/client/notifications(+dismissed)` | keep-until-V2-port | event forwarding for cloud-SDK app awareness |
| `/api/client/photo/response` | keep-until-V2-port | V1 photo pipeline completion |
| `/api/client/location` (`sendLocationData`) | keep-until-V2-port | live caller: island PhoneLocationService |
| App catalog/lifecycle: `/api/client/apps`, start/stop, uninstall, `/appsettings/*`, health check | keep-until-V2-port | powers the remaining cloud-SDK app UI (`applet/*` routes) |
| Webview auth: generate-webview-token(+signed), hash-with-api-key | keep-until-V2-port | security boundary for cloud-SDK webviews |
| `/api/client/livekit/token` | keep-until-V2-port | media infra |
| Account deletion request/confirm | keep-until-V2-port | already fronted by `toolkit.session.account` |
| `/api/client/goodbye` | keep-until-V2-port | courtesy |

## Reachability analysis (2026-07-02): what "keep-until-V2-port" actually protects

Traced from every phone-side entry point (routes, deeplinks, store flows, app
store/registry):

- **No phone UI can reach a Cloud V1 app anymore.** The island apps store
  rejects cloud-v1 entries (`stores/apps.ts:290`), `getInstalledMiniapps()`
  returns only local/offline apps, and every `/applet/*` navigation requires
  the app to exist in that store. Deeplinks included. A V1 app object cannot
  exist at runtime.
- **Every remaining SocketComms handler is server-push-only** — reachable only
  if the V1 cloud pushes into the still-open websocket. Local miniapps do NOT
  ride this path (they get events via `localMiniappRuntime.forwardEvent`), so
  deleting the bridge breaks only V1 server-side apps.
- `stream_status` / `keep_alive_ack` relays already filter to non-phone-owned
  streams — pure V1 leftovers once no V1 app can start a stream.
- **Dead code found:** `mobile/src/services/Livekit.ts` is imported by nothing;
  `RestComms.getLivekitUrlAndToken` and the `livekit=true` WS param serve only
  it.
- **Correction to keep in mind:** `/api/client/min-version` is NOT part of the
  V1-app bridge — it gates app launch (3 live call sites) and stays.
- The applet-webview cluster (webview tokens, `/appsettings/*`, uninstall,
  health check) is unreachable for V1 apps; before deleting, confirm no
  planned flow re-introduces server-hosted apps through `/applet/webview`.

### Ordered delete list once "no Cloud V1 apps exist" is declared

**Executed 2026-07-02** (V1 apps declared EOL): tiers 1-4 below are DELETED on
this branch (commits 5e15ca5f58, d6a415462f, ef5c8859d2, e0b96b0811; the
Livekit.ts deletion itself rode along in e4d8207ec6). `applet/settings.tsx`
was kept and reworked island-only (live for local miniapps); the
`/apps/:packageName` deeplink now points at it. Tier 5 (SocketComms +
WebSocketManager + core_token retirement) remains gated on V2
settings/calendar/notifications endpoints.

1. Now, no product decision needed (dead code): `services/Livekit.ts`,
   `RestComms.getLivekitUrlAndToken`, `livekit=true` WS param.
2. Push-only V1 stream plumbing: `handle_stop_stream`,
   `handle_keep_stream_alive`, `sendStreamStatus`, `sendKeepAliveAck`, and the
   phone-owned-stream filters in MantleManager.
3. Remaining push handlers (`display_event`, `photo_request`, video recording,
   `rgb_led_control`, `camera_fov_set`, `show_wifi_setup`, location commands)
   + the device→cloud relays (touch/button/swipe/switch/head/ws_text/
   location_update) + `sendPhotoResponse`.
4. The applet-webview cluster and V1 app catalog endpoints (after the
   product confirmation above).
5. Last, as one retirement: `SocketComms` + `WebSocketManager` + core_token
   exchange, once settings/calendar/notifications have V2 endpoints
   (`RestComms` shrinks to those until then).

## Rules going forward

1. No new callers of SocketComms/WebSocketManager/RestComms — new features use
   island + Cloud V2 (`cloud-v2/packages/cloud-client`).
2. No Cloud V2 device-state mirror, ever; feature-specific typed payloads only
   (design README, "Cloud V1 Status Sync").
3. When a Cloud V2 port lands (settings, notifications, calendar, media,
   catalog), delete the corresponding rows here rather than aliasing them.
