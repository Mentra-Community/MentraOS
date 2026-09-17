# Mac hotspot diagnostics

These recorded diagnostics isolate the Mac's Wi-Fi association, the iOS app's
local connection and Apple's interface constraints. They do not create or join a
Teams meeting. Passing the health check does not qualify the WHIP listener,
WebRTC, audio/video delivery or disconnect cleanup in Mentra Call.

## English routine

1. Verify the agreed glasses by USB path, ADB transport, serial, eMMC CID,
   firmware, slot and boot ID. Match a fresh `version_info_3` record to the
   Bluetooth identity. Refuse a missing, ambiguous or different fixture.
2. Verify wired internet reaches Teams while Wi-Fi remains enabled. Save the
   current Wi-Fi state and whether the glasses SSID is already a saved network.
3. Confirm the glasses hotspot is initially off. Start it through the existing
   ASG `set_hotspot_state` command, then read its actual gateway and credentials.
   Keep the passphrase out of console output and sanitized transcripts.
4. Join that SSID using macOS network controls. Require a Wi-Fi client address on
   the glasses' subnet, a Wi-Fi route to the gateway and working Ethernet internet.
5. Read `/api/health` on port 8089 through the Mac's Wi-Fi interface. Require HTTP
   success and `status: healthy`; a successful association command alone is not a
   pass.
6. For the iOS comparison, preserve the original signed app and launch the signed
   UIKit probe in the background. Record its source, executable and entitlement
   identities. Reattach the recorder to its actual window title.
7. Request the same health endpoint using the system-selected route. Record the
   connection's actual interface and the iOS result. In the same process, repeat
   with `requiredInterfaceType = .wifi`. Keep the failing comparison as a failed
   run. Test explicit source-IP binding separately under a known Local Network
   permission state.
8. Restore the original Mentra App and verify its executable hash. Stop only the
   hotspot started by this run, verify that the glasses no longer expose its IP,
   remove only a newly added test Wi-Fi preference, and verify Ethernet internet.
   Record Wi-Fi recovery separately: the Mac can briefly retain its old DHCP
   address after the hotspot stops.

Every step records an English description, screenshot, accessibility snapshot and
video chapter. The recorded checks execute without model calls or foreground
activation. A system permission prompt may still require a human setup action;
do not claim that the background runner accepted it.

## Observed results on September 16, 2026 (Pacific)

The fixture was original 03BE (`ML396102B`, Bluetooth `CC:E7:DE:E0:03:BE`),
firmware `MentraLive_20260908.4`, BES `26.9.9.1`. Its ASG app was the custom
`3.2.0-dev.206-camera-failure-dev` build; this is a qualification limitation, not
the latest coordinated ASG release. The Mac used Wi-Fi `en0` and Ethernet `en10`.

All paths below are relative to `.test-results/mentra-e2e/` in the integration
checkout. UTC timestamps cross into September 17.

| Diagnostic | Recording folder | Result |
| --- | --- | --- |
| macOS association and health | `2026-09-17T00-13-35-329Z-macos-hotspot-join-53853a` | Five steps passed; 28.051667-second video. macOS joined the real glasses hotspot and read healthy while Ethernet remained the internet route. |
| iOS requiring Wi-Fi | `2026-09-17T00-16-14-665Z-ios-prejoined-wifi-db2d2a` | Local request timed out; seven recorded steps including successful restoration and cleanup. |
| iOS system-selected route | `2026-09-17T00-19-07-612Z-ios-prejoined-system-route-c5080d` | Seven steps passed; HTTP 200 healthy over `en0`, connection reports Wi-Fi. |
| Same-process comparison | `2026-09-17T00-21-52-777Z-ios-route-comparison-2dc105` | System-selected route passed, then requiring Wi-Fi failed with no network route. Eight recorded steps; the run remains failed. |
| iOS bound to hotspot source IP | `2026-09-17T00-25-28-408Z-ios-bound-route-5f70ca` | Timed out while reporting Local Network denial. Permission acceptance is unresolved, so this does not establish whether IP binding works. Seven recorded steps including restoration and cleanup. |
| Same-process system / source-IP / Wi-Fi comparison | `2026-09-17T00-47-24-457Z-ios-permission-route-a9093c` | System routing and source-IP binding both returned HTTP 200 healthy over Wi-Fi. Requiring the Wi-Fi type then failed. Nine recorded steps / 59.018333 seconds; retains the negative result. |
| Actual iOS WHIP listener from real glasses | `2026-09-17T00-51-04-853Z-ios-whip-listener-8b4637` | Ten steps passed / 42.831667 seconds. The glasses sent GET to the production server bound to the hotspot IP and received its expected 405 / Allow: POST response. No media negotiation was attempted. |

The initial iOS probe has a **10-second network deadline**. The replay then waits up to
**15 seconds for the accessible “Glasses health: PASS” result**. Thus a harness
message saying it could not find PASS is the assertion deadline following a
network failure. It is not a Teams join timeout. The latest bound-IP probe showed
`waiting reason 3` (`local_network_denied`); the matched required-Wi-Fi comparison
showed reason 0 and no network route. Preserve these distinct diagnoses.

The later same-process comparison allows 60 seconds for its first two requests,
including time for a possible Local Network prompt, then 10 seconds for the Wi-Fi
constraint check. The system-route request passed after a brief reason-3 wait;
source-IP binding passed immediately afterward. That functional result establishes
IP binding without assuming which permission the user accepted. The explicit
Wi-Fi type constraint still failed in the same process.

SSID reads remained unavailable. Location was off. Apple's allowance for reading
an app-configured current network without Location does not establish SSID access
after macOS itself joins a network. A candidate reuse path still requires an exact
SSID match and a valid client address on the advertised subnet; it must not treat
an arbitrary private address as identity proof.

The Mac-specific product change is committed in #4078. The actual WHIP listener
test compiles and hashes `WhipIngestServer`, `WhipRequest` and `LocalMediaPolicy`
from that source; it does not substitute a fake HTTP server. Full product reuse,
SDP/ICE and Teams media remain unqualified. The existing app was restored after
every probe, and no Teams meetings were created in these tests.

The updated full app subsequently passed the existing 13-step paired UI routine:
`2026-09-17T00-56-20-518Z-mentra-call-ui-d728a4`, 11.753333 seconds, zero model
calls, all screenshot/AX/video/chapter/liveness checks passed. That candidate is
now running. Its build manifest records the source diff and actual executable/JS
hashes; this navigation pass does not establish a successful call.

## Reproduce on this Mac or prepare another Mac

The complete observed replay is cached in each setup folder's `run.ts`. The
signed iOS variants additionally contain `main.m`, `build.py` and
`probe-manifest.json`:

| Setup folder | Purpose |
| --- | --- |
| `2026-09-17T00-11-41Z-macos-hotspot-join` | Mac association and health |
| `2026-09-17T00-14-42Z-ios-wifi-probe` | Required-Wi-Fi iOS request |
| `2026-09-17T00-18-36Z-ios-route-probe` | System-selected iOS route |
| `2026-09-17T00-20-58Z-ios-route-comparison` | Both requests in the same process |
| `2026-09-17T00-25-07Z-ios-bound-route` | Explicit local-IP binding |
| `2026-09-17T00-47-16Z-ios-permission-route` | System, source-IP and required-Wi-Fi requests in the same process |
| `2026-09-17T00-50-49Z-ios-whip-listener` | Actual production WHIP listener and glasses-origin request |

These are retained local experiment scripts, not a portable qualified suite. Do
not rerun them in place: they write setup evidence and pin the original boot ID,
USB path, interfaces, signing inputs, app path and hashes. Preserve the original
folder, prepare a new timestamped setup folder and replace those pins only after
verifying the new fixture. Never remove identity checks to accommodate a mismatch.
Run the prepared controller with `bun <new-setup-folder>/run.ts` from the
integration repository root. Verify its output with
`bun tools/mentra-e2e/verify-run.ts <recording-folder>`.

For a new Mac, complete [the harness setup](SETUP.md) first, including Xcode
signing, Accessibility, Screen Recording and USB authorization. Discover actual
interfaces with `networksetup -listallhardwareports`; do not copy `en10` blindly.
Recheck `route -n get default` and use an interface-bound HTTPS request to verify
wired internet before moving Wi-Fi. The cached controller uses argv-based
`networksetup -setairportnetwork`, `ipconfig getifaddr`, `route -n get`, and
interface-bound `curl` calls with bounded deadlines. It uses the existing
exported ASG command receiver, not gallery sync or firmware installation.

Obtain a known Local Network permission state for the exact signed probe before
interpreting a permission-denied network result. Keep Location/SSID access and
Local Network access as separate gates. Do not reset the permission database,
reuse another app's permission, or circumvent a denied system-dialog tool.

Keep private glasses logs and credentials out of Git; hotspot logs can contain
the passphrase. Portable probe packaging and a repeated successful product call
remain outstanding work.
