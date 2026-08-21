# OS-1676: Mentra Live OTA over the glasses hotspot

Status: approved design implemented as a capability-gated Android/iOS vertical slice;
Android hardware verification passed, while iPhone background hardware verification and
a safe full APK + MTK + BES run remain merge gates

## Implementation and verification snapshot (2026-08-20)

The implementation is on `codex/os-1676-hotspot-ota-preserve`. It includes the ASG
capability and restart contract, Android and iOS native staging/server implementations,
the existing coordinator's hotspot transport, and the capability-gated production UI
entry point. Existing Wi-Fi and missing-SID behavior remain separate compatibility paths.

The connected-device Android vertical slice passed on a Samsung Z Fold (Android 16 / API
36) and Mentra Live (`ML396102B`, Android 11):

- glasses Wi-Fi was disabled before the test, and `hotspot_ota_version: 1` admitted the
  existing **Update Now** action without routing to Wi-Fi setup;
- the phone downloaded and verified the 107,692,067-byte ASG artifact with SHA-256
  `12a4e087dc3bf5bd6e6646f7675f848883db064bff67f9a41e4542e27d670c68` before joining
  the hotspot;
- the phone retained internet for staging, then captured scoped hotspot network `105`,
  started one server at `192.168.43.159:8791`, and served the rewritten manifest and
  SHA-addressed artifact to `192.168.43.1`;
- the phone sent exactly one `ota_start` with `ota_transport: hotspot`;
- ASG installed `51687003 / os1676-hw-c` -> `51687004 / os1676-hw-d`, restarted from SID
  `a70ba217` to `71b05852`, and the phone recovered with `ota_query_status` rather than a
  second `ota_start`;
- ASG reported authoritative completion, the phone stopped its local server, released the
  scoped network, disabled the hotspot, and `ap0` returned to `DOWN`;
- Android's first native `/api/health` keepalive returned HTTP 200 without the former
  pooled-connection protocol error; and
- the expected brief loss of the default internet network during hotspot teardown was
  handled by one bounded automatic-chain retry, after which the production screen showed
  **Up to Date** for build `51687004`.

This run was intentionally APK-only. The connected glasses already run MTK
`MentraLive_20260816` and BES `26.8.19.4`, newer than the available staging-manifest
targets, so downgrading them would not be valid verification. Multi-step restart adoption
and continuation are covered by focused ASG and phone tests, but the required live APK +
MTK + BES gate still needs correctly versioned, provenance-checked newer artifacts.

The iOS native implementation compiles in the simulator build. Gate 0 background/lock and
force-quit behavior still requires a supported physical iPhone; it is not inferred from
the simulator build or from the Android result.

## Decision

Hotspot OTA will reuse the existing Wi-Fi OTA pipeline. The transport changes; the OTA
state machine does not.

For a hotspot update, the phone downloads and verifies the selected artifacts, joins the
Mentra Live hotspot once, and serves one rewritten manifest plus those artifacts from a
local HTTP server. If the APK step replaces `asg_client`, the K900 SystemUI-owned hotspot
must remain active. The restarted ASG process adopts that same hotspot and the existing OTA
session continues to MTK and BES using the manifest URL already persisted by
`OtaSessionManager`.

The normal path has:

- one hotspot;
- one phone join;
- one phone HTTP server endpoint;
- one `ota_start`;
- one persisted ASG OTA session; and
- the existing APK -> MTK -> BES sequencing.

There is no post-restart manifest probe, hotspot recreation, phone rejoin, second
`ota_start`, or parallel OTA coordinator.

## Decisions to approve

This draft makes four deliberate choices:

1. Hotspot OTA is gated on an explicit ASG capability; unsupported ASG versions keep
   Wi-Fi OTA but do not receive a two-window hotspot fallback.
2. The existing `ota_start` gains an optional transport field so ASG never infers hotspot
   ownership from a URL.
3. The current Wi-Fi OTA coordinator and persisted ASG session remain authoritative.
4. If the complete phone-link preservation gate fails, the design is revised instead of
   adding polling, URL replacement, or duplicate-start recovery.

## Why this replaces PR #3614

PR #3614 assumes APK replacement destroys the hotspot and rotates its credentials. That
was true of the earlier app-owned `LocalOnlyHotspotReservation` implementation used when
the original spike was written. Current `dev` instead asks `com.android.systemui` to own
the K900 hotspot through the SmartXY `ap_start` command.

Hardware testing on 2026-08-20 demonstrated the current behavior:

- Device: Mentra Live, Android 11, USB transport 35 (`ML396102B`).
- ASG: `staging.20260819.024834.8d6293f`.
- Reinstalled the exact running APK with `adb install -r`; SHA-256
  `9ac71039827c4b1dea5da618d2dcf18c736991cbfa6ed46969c244b777fcc06a`.
- The ASG PID changed from `4988` to `5492`.
- `ap0` remained continuously up at `192.168.43.1/24` during package replacement.
- The SSID and password hash were identical before and after replacement.
- A SystemUI hotspot started without the ASG inactivity monitor remained up for 141
  seconds, proving the visible 120-second expiry is not an independent SystemUI timer.
- The hotspot was explicitly stopped after both tests and `ap0` returned to `DOWN`.

This proves that the SystemUI AP and its credentials can survive ASG package replacement.
It does not yet prove that an associated phone retains its station association, DHCP
address, scoped Android `Network`, and open HTTP listener. That complete link is the first
acceptance gate below; it must be proven before implementation is merged.

## Existing behavior we preserve

The ASG already owns a durable multi-step OTA session:

1. The phone sends `ota_start` with a manifest URL.
2. ASG downloads, verifies, and installs the APK when required.
3. APK installation replaces the ASG process.
4. `OtaService` loads the persisted session and advances to the next step.
5. The same session continues through MTK and BES.
6. The phone observes progress with existing `ota_status` and `ota_query_status` messages.

The phone already detects modern ASG process replacement through `sid`. On an SID change,
the OTA coordinator queries the ASG-owned session; it deliberately does not start a second
version-check pipeline.

Pre-SID ASG versions must retain the existing Wi-Fi OTA behavior and fallbacks. This work
must not change their routing, timers, messages, or progress UI.

## Scope and compatibility

### Supported hotspot path

Hotspot OTA is offered only when the connected ASG advertises
`hotspot_ota_version: 1` in `version_info_1`. The phone stores that field with the other
ASG version information. Do not infer support from an IP address, Android version, or
incidental build behavior.

`hotspot_ota_version: 1` means all of the following are present:

- the hotspot is owned by K900 SystemUI rather than an app-local reservation;
- APK replacement preserves an OTA-owned hotspot;
- the new ASG process adopts an already-running hotspot;
- the ASG restores the 120-second inactivity policy after adoption; and
- terminal cleanup can reliably stop an adopted hotspot.

The existing `ota_start` command gains one optional field:

```json
{
  "type": "ota_start",
  "ota_version_url": "http://192.168.43.100:8787/version.json",
  "ota_transport": "hotspot"
}
```

`ota_transport` accepts `wifi` or `hotspot`. Missing means `wifi`, preserving every old
phone and Wi-Fi OTA call site. ASG persists the selected transport in `OtaSessionManager`;
it never derives transport ownership from the URL.

The phone may additionally keep a minimum-build constant as a defensive rollout gate, but
`hotspot_ota_version` is authoritative.

### Existing Wi-Fi path

Wi-Fi OTA remains available exactly as it is today:

- SID-capable ASG: restart detection plus `ota_query_status` recovery.
- Pre-SID ASG: existing connection, timeout, and legacy progress fallbacks.
- No hotspot preservation or adoption is required when the update uses the normal remote
  manifest.

### Unsupported combinations

- Do not run hotspot OTA against an ASG without `hotspot_ota_version: 1`.
- Do not implement the old two-hotspot-window flow as a fallback.
- Do not guess that a local HTTP URL implies hotspot ownership.
- Do not change the Wi-Fi OTA flow to make unsupported hotspot clients appear compatible.

An older ASG must first receive a normal Wi-Fi, factory, or explicitly supported service
update that introduces `hotspot_ota_version: 1`.

The Mentra App Android implementation targets Android 13 / API 33 and newer. No Android
9-12 joining path is part of this design.

The hotspot path is also intended to support the Mentra App on iOS. On iOS, the app joins
the glasses access point as the phone's active Wi-Fi network and serves artifacts with a
Network.framework listener on the iPhone's hotspot-side IPv4 address. The repo already has
this basic inbound-network shape in `LocalPhotoUploadServer`: an `NWListener` accepts
connections from the glasses and `MentraPhotoReceiverModule` publishes an IP-literal HTTP
URL. Hotspot OTA must use a purpose-specific, read-only artifact server rather than add OTA
routes to the photo upload server.

iOS support is conditional on Local Network permission. The Mentra App already declares
the `bluetooth-central` background mode, and the connected Mentra Live peripheral produces
regular BLE activity that wakes the app in the background. Hotspot OTA must continue after
the user backgrounds the app or locks the iPhone; foreground-only OTA is not acceptable.

The iOS implementation must not depend on React Native timers, a mounted progress screen,
or a keep-awake assertion for transfer correctness. Native code owns the artifact download,
immutable manifest/artifact map, listener, open HTTP connections, and server teardown. BLE
events and OTA status may update persisted state while the JavaScript runtime is suspended;
the UI reconciles from that state when it resumes.

The existing Mentra Live Bluetooth behavior keeping the iOS app active in the background
is an established platform capability for this design, not an open feasibility question.
A deliberate force quit or app crash is still a terminal transport loss: the ASG inactivity
policy performs fail-closed cleanup and the user starts a new attempt after reopening the
app. This design does not add endpoint replacement or a second `ota_start` for that case.

Artifacts are downloaded before joining the internet-less hotspot on both phone platforms.
On iOS, staging must use a background-capable native `URLSession` so a user who backgrounds
the app after approving the update does not interrupt the internet download.

## End-to-end flow

### Before `ota_start`

1. The phone performs the normal update check against the configured remote manifest.
2. The user starts the update.
3. The phone downloads every selected APK, MTK, and BES artifact before joining the
   internet-less glasses hotspot.
4. The phone verifies each artifact against the remote manifest and stores it by SHA-256.
5. The phone requests the glasses hotspot through the existing command.
6. The phone joins the hotspot once. Android retains its scoped `Network`; iOS remains on
   the joined system Wi-Fi network while its native BLE and OTA components support
   foreground, background, and screen-locked operation.
7. The phone starts one HTTP server bound to its hotspot-side address.
8. The phone serves a rewritten copy of the already-selected manifest. Only artifact URLs
   change; target versions, sizes, and hashes do not.
9. The phone sends the existing `ota_start` once with that local manifest URL and
   `ota_transport: hotspot`.

### APK replacement

1. Before dispatching APK installation, ASG durably marks the active OTA session as owning
   the current hotspot across one package replacement.
2. ASG performs its existing verified APK installation.
3. Cleanup releases process-local callbacks, listeners, and handlers but does not send
   `ap_start(false)` while the valid OTA preservation marker is active.
4. SystemUI keeps the same AP, SSID, password, and gateway alive.
5. The phone remains joined and keeps the same HTTP server running.
6. The new ASG process starts and detects the already-active K900 AP.
7. ASG validates the durable marker against the persisted OTA session, reads the current
   SystemUI SSID/password and `ap0` gateway, then adopts the AP without sending
   `ap_start(true)` again.
8. Adoption restores in-memory hotspot state, status reporting, and the existing
   inactivity monitor.
9. `OtaService` resumes the persisted session using its original manifest URL and proceeds
   to MTK and BES.
10. The changed SID tells the phone that ASG restarted. The phone re-runs readiness and
    sends `ota_query_status`; it does not resend `ota_start`.

### Completion and teardown

1. Existing OTA status drives the phone to a terminal complete or failed state.
2. The phone stops its HTTP server and releases the scoped hotspot network.
3. The phone sends the existing hotspot-disable command.
4. Because the new ASG process adopted the AP, `isHotspotEnabled()` reflects reality and
   the disable command reaches SystemUI.
5. ASG clears the OTA hotspot-preservation marker.
6. Phone artifact files referenced only by this update are deleted.

Teardown operations must be idempotent and safe in any order.

## ASG hotspot ownership contract

The preservation state is a small durable lease associated with the OTA session, not a
global “never stop hotspot” flag.

Required fields:

- OTA session identifier;
- owner = hotspot OTA;
- state = preserving for APK replacement;
- creation time based on `elapsedRealtime()`; and
- the expected current OTA step.

Rules:

- Create the lease immediately before the existing APK restart guard is committed.
- Preserve only when the session is active, the current step is APK, the next step exists,
  and the persisted `ota_transport` is `hotspot`.
- A normal service shutdown, gallery session, Wi-Fi OTA, crash outside that narrow window,
  or terminal OTA must not preserve the hotspot.
- Adoption requires both a valid lease and an actually active K900 AP.
- If the lease exists but the AP is absent, clear the lease and fail with
  `hotspot_lost_during_apk_restart`; do not silently create a new hotspot.
- K900 startup always reconciles in-memory state with the actual SystemUI AP. If an AP is
  active without a valid lease, adopt it for truthful status, idle expiry, and safe cleanup,
  but do not resume an OTA from it.
- Clear the lease after successful adoption, terminal failure, terminal completion, or
  expiry.

The lease covers one process replacement. It must not survive a full device reboot or be
reused by another OTA session.

## Inactivity and recovery

The current 120-second expiry is an ASG `Handler` driven by inbound HTTP activity on the
glasses server. It disappears when the ASG process is replaced. The SystemUI AP did not
expire independently in the 141-second hardware test.

Therefore:

- the phone polls the existing glasses `/api/health` endpoint every 30 seconds while
  hotspot OTA is active; on iOS this polling is owned by native OTA code and does not
  depend on a JavaScript timer;
- the short APK replacement gap is tolerated while the glasses HTTP server is restarting;
- AP adoption starts a fresh 120-second ASG inactivity window; and
- the independent recovery worker must stop the vendor AP if ASG does not return within
  its existing APK recovery/supervision deadline.

The recovery worker cleanup is a failsafe, not a second hotspot owner. It may only send the
vendor disable command after it has proved the OTA-started ASG replacement failed to
recover.

## Failure behavior

Failures are explicit and terminal for the active attempt:

| Failure | Required behavior |
| --- | --- |
| Phone artifact download or verification fails | Do not start the hotspot; delete partial files. |
| Hotspot start or phone join fails | Stop any partial local resources; do not send `ota_start`. |
| ASG cannot reach the initial local manifest | Fail before APK installation; tear down normally. |
| AP disappears during APK replacement | Report `hotspot_lost_during_apk_restart`; do not create a second OTA session. |
| New ASG cannot validate/adopt the lease | Fail closed and let the phone tear down; do not guess ownership. |
| Original manifest URL is unreachable after adoption | Report a transport failure; do not probe alternate URLs or resend `ota_start`. |
| ASG never returns | Recovery worker performs its existing recovery and eventually disables the AP. |
| Phone app is backgrounded or screen locks | Continue the same OTA attempt and endpoint; do not tear down the hotspot or server. |
| Phone app is force-quit or crashes | ASG inactivity policy disables the adopted AP after genuine inactivity; require a new attempt after the app relaunches. |

Retry starts a new user-visible attempt after both sides have reached terminal cleanup. It
does not resume an ambiguous or partially owned hotspot session.

## Security and integrity invariants

- Download artifacts before joining the internet-less hotspot.
- Verify hashes after phone download and immediately before serving.
- Keep manifest target versions and hashes unchanged when rewriting URLs.
- Bind the phone server only to the hotspot-side address.
- Serve only the selected manifest and SHA-addressed artifacts using `GET` and `HEAD`.
- Reject traversal, arbitrary paths, uploads, and files not selected for the active OTA.
- Do not log hotspot passwords, manifest bodies, or user data.
- Keep the server and preservation lease scoped to one active OTA attempt.
- ASG retains its existing artifact verification before every install.

## Implementation slices

These are code-area slices, not a proposed sequence of independently merged PRs. In
particular, the phone trigger must not land after the preservation code in a way that
makes the first PR impossible to exercise end to end.

1. **ASG preservation and adoption**
   - advertise `hotspot_ota_version: 1`, accept `ota_transport`, and persist it;
   - add the durable one-restart lease;
   - make K900 cleanup lease-aware;
   - adopt an active vendor AP during startup;
   - restore inactivity monitoring and reliable terminal stop;
   - add recovery-worker orphan cleanup; and
   - add unit tests and hardware evidence.
2. **Phone local server**
   - serve the rewritten manifest and verified artifacts on Android and iOS;
   - bind to the hotspot interface and expose an idempotent start/stop API;
   - use an Android listener bound to the scoped hotspot network;
   - use an iOS `NWListener` bound to the iPhone hotspot-side address;
   - make iOS request parsing and file streaming fully native, with no per-request
     JavaScript callback;
   - update the iOS Local Network permission copy to cover serving update artifacts to the
     glasses.
3. **Phone artifact staging**
   - download on user action, verify, cache by SHA-256, and clean partial/terminal files;
   - use a background-capable native `URLSession` on iOS and reconcile its persisted task
     state after app wake or relaunch.
4. **Hotspot transport integration**
   - reuse the current `OtaInstallCoordinator`;
   - perform one hotspot start and one phone join;
   - retain the phone network/server across SID change;
   - keep `/api/health` active from platform-native code; and
   - perform idempotent terminal teardown.
5. **UI and rollout**
   - add phone-download and hotspot-connection progress;
   - map the explicit failure codes;
   - gate on `hotspot_ota_version: 1`; and
   - roll out from internal hardware testing to the intended enterprise cohort.

No implementation slice may reintroduce a second OTA state machine or duplicate Wi-Fi OTA
sequencing.

## PR delivery and testability

The first PR is a capability-gated vertical slice, not an ASG-only foundation PR. It must
contain enough of every implementation slice above to run a real hotspot OTA:

- ASG advertises `hotspot_ota_version: 1` and implements preservation/adoption;
- Android and iOS can stage artifacts and serve the rewritten manifest;
- the existing `OtaInstallCoordinator` selects and runs the hotspot transport;
- when no glasses Wi-Fi is connected, the existing **Update Now** action selects hotspot
  OTA instead of routing the user to Wi-Fi setup, but only when the connected ASG
  advertises the capability;
- super mode can explicitly force hotspot transport while glasses Wi-Fi is connected so
  the same production path can be exercised repeatedly on the bench; and
- the existing progress screen exposes the minimum download, hotspot connection,
  updating, completion, and failure states needed to operate the test safely.

The force option is transport selection at the existing OTA entry point. It must not add
an exported Android receiver, a second OTA command, a debug-only coordinator, or a bypass
around artifact and capability validation.

Before the first PR is considered ready, use that entry point to pass both Gate 0 phone
runs and at least one complete APK + MTK + BES update. Later PRs may improve copy,
telemetry, visual polish, and rollout controls, but they must not be required to trigger or
complete the first PR's OTA flow.

For iOS, the first PR is not complete merely because the flow passes while the progress
screen remains visible. The same production path must pass after backgrounding and screen
lock, without relying on JavaScript timers to keep it alive.

## Acceptance gates

### Gate 0: complete preservation spikes

Run this gate separately with (a) a real Android 13+ phone and (b) a supported iPhone. On
current K900 hardware with the phone joined and serving a file:

- record AP SSID, password hash, gateway, phone DHCP address, and server port;
- continuously fetch a large file from ASG through the phone server;
- replace the ASG APK during the same session;
- prove `ap0` never drops;
- prove the phone remains associated;
- prove its DHCP address remains valid;
- on Android, prove the scoped `Network` remains valid;
- on iOS, prove Local Network permission is granted and the selected hotspot-side address
  is the iPhone Wi-Fi address;
- on iOS, background and lock the phone before APK download completes, then prove the
  original `NWListener` serves the remaining APK bytes and the post-restart MTK/BES
  requests without changing address or port;
- on iOS, correlate listener state, accepted connections, and byte progress across
  backgrounding so the OTA-specific server behavior is measured rather than inferred;
- prove the original manifest URL works from the new ASG process; and
- prove explicit teardown stops the AP.

If any identity or endpoint changes, stop and revise this design. Do not add polling,
credential rotation, or duplicate-start workarounds to force the gate to pass.

Separately test a deliberate iOS force quit. It is a terminal transport loss, not the same
as backgrounding: the glasses must expire the hotspot, and reopening the app must present
a clean retry rather than silently send a second `ota_start`.

### Gate 1: ASG tests

- lease is created only for a hotspot OTA APK step with a remaining step;
- Wi-Fi OTA and gallery cleanup still stop normally;
- valid AP plus valid lease adopts without an `ap_start(true)` command;
- missing AP, wrong session, expired lease, and wrong step fail closed;
- adopted AP restarts inactivity monitoring and can be stopped;
- `OtaService` resumes exactly once and does not advance unrelated sessions; and
- recovery worker disables an orphaned AP after failed ASG recovery.

Run the focused unit tests plus `./scripts/check-android-compile.sh asg`.

### Gate 2: phone tests

- manifest rewrite preserves versions, sizes, and hashes;
- server rejects unselected paths and traversal;
- artifact staging is atomic and hash-verified;
- coordinator sends exactly one `ota_start` across an SID change;
- Wi-Fi OTA behavior is unchanged for SID and pre-SID builds;
- hotspot teardown is idempotent after every terminal/error path; and
- Android 13 scoped routing keeps cellular internet available while local OTA traffic uses
  the glasses hotspot;
- iOS chooses the hotspot-side Wi-Fi address rather than a cellular, VPN, AWDL, or stale
  interface address; and
- iOS rejects OTA start until Local Network access and listener reachability are proven;
- iOS artifact download continues through background-capable `URLSession` staging;
- iOS native HTTP serving continues without JavaScript callbacks while backgrounded or
  screen locked; and
- returning to the foreground reconstructs accurate progress from persisted native and
  ASG session state.

### Gate 3: end-to-end matrix

- APK-only, MTK-only, BES-only, and APK + MTK + BES;
- Android 13+ and supported iOS;
- phone background/foreground and screen lock;
- ASG APK restart, ASG recovery-worker restart, and phone app termination;
- gallery requested before/during/after OTA; and
- existing Wi-Fi OTA from both SID and pre-SID ASG versions.

The feature remains disabled outside internal testing until the full APK + MTK + BES run
passes with synchronized phone and glasses logs and exact build/artifact provenance.

## Explicit non-goals

- Replacing the existing OTA session manager or update ordering.
- Adding a new OTA command or a second `ota_start`.
- Supporting hotspot OTA on ASG versions without `hotspot_ota_version: 1`.
- Supporting Android phones below Android 13.
- Front-loading all artifacts onto ASG storage before APK installation.
- Changing the existing Wi-Fi OTA compatibility path.
- Shipping an exported debug receiver or linked-worktree build workaround.
