# Connected Mentra Call replay — experimental

This checked-in controller replaces the machine-specific discovery script. It
coordinates the real Mentra App, original USB-identified glasses, Ethernet,
glasses hotspot, and the dedicated Teams browser companion. It records English
steps, screenshots, accessibility snapshots and continuous native/browser video
under one run directory without calling a model.

The current automated scope is admission, incoming glasses video, roster and
cleanup. The full call goal additionally requires laptop microphone/camera,
return audio, rejoin and physical iPhone qualification. Those checks are still
unqualified and must not be inferred from this controller's result. The portable controller completed its first live qualification on September 17
with the original 03BE glasses. Run
`2026-09-17T05-41-53-618Z-call-incoming-video-f716b0` passed 27 native steps
in 113.802 seconds and the browser companion in 17.752 seconds, with zero
model calls. Recordings, screenshots, chapters, frame liveness and exact
meeting retirement (DELETE 204 / GET 404) verified. This is an observed pass,
not proof that macOS Local Network permission will persist across installs.
A second consecutive replay, `2026-09-17T05-44-11-613Z-call-incoming-video-978d08`,
passed 27 native steps in 119.787 seconds and recorded 17.16 seconds of browser
video. Both runs verified owned meeting retirement and preserved audio UIDs.

## Prepare a machine-specific fixture

Follow [SETUP.md](SETUP.md) and [TEAMS-BROWSER-ROUTINE.md](TEAMS-BROWSER-ROUTINE.md).
Required local commands are Bun, Xcode's `xcrun`, ADB, `blueutil`,
`SwitchAudioSource`, FFmpeg/ffprobe, Google Chrome and authenticated Porter.
The glasses build must support root ADB and its existing hotspot command.

Copy `call-fixture.example.json` to a private location outside Git and replace
every placeholder using the actual machine and authorized glasses. Supply the
USB serial and topology, eMMC CID, exact MTK version, slot, Bluetooth address,
Wi-Fi/Ethernet interfaces and the authorized Call backend's Porter coordinates.
Never copy an ADB transport number: it changes. The runner resolves it from the
unique serial/topology, verifies the CID/version/slot, then pins the current boot
for the duration of each run. A reboot or replacement fails the run.

The fixture contains no passwords or tokens. The current signed test build must
already be installed and open at Mentra home with no miniapp open. Supply its
`installed-build.json`; the runner verifies the installed Apple signature and checks native and JavaScript hashes before
changing hardware or launching anything. It never installs a different build.
The build must explicitly contain the Mac host-verified test adapter. Native
iPhone hotspot association is not covered by that adapter.

Read the procedure or validate configuration without contacting a device:

```sh
bun tools/mentra-e2e/connected-call.ts describe
bun tools/mentra-e2e/connected-call.ts validate \
  --fixture /absolute/private/call-fixture.json \
  --build-manifest "$HOME/Applications/Mentra E2E/installed-build.json"
```

Validation checks the file shapes only. It does not claim current hardware,
signing, quota, permissions or network readiness. When live testing is authorized,
run the exact checkout whose source is being qualified:

```sh
bun tools/mentra-e2e/connected-call.ts run \
  --fixture /absolute/private/call-fixture.json \
  --build-manifest "$HOME/Applications/Mentra E2E/installed-build.json"
```

The default command is `describe`, so an omitted subcommand cannot start a call.
Do not run while live testing is paused. The controller never changes quota
configuration, clears privacy grants, accepts system dialogs or selects audio
devices. Ensure the test account has quota and complete normal permissions first.

## English routine

1. Verify the running signed-build manifest and Mentra home. Acquire the test
   lock and start the native recording.
2. Match the exact USB serial/topology, eMMC CID, installed MTK version and boot
   slot. Pin the current boot ID, and require a device log linking that serial
   to the expected Bluetooth address.
3. Verify Ethernet is the default internet route and can reach Teams. Record
   Wi-Fi state. Refuse to take over an already active glasses hotspot.
4. Verify the expected Bluetooth device is connected. Record available audio
   devices and the user's selected input/output/system UIDs without changing
   them. A Bluetooth connection alone does not qualify Classic speaker audio.
5. Start the glasses hotspot through its existing command. Read its credentials
   locally, redact the password, and join with the configured Mac Wi-Fi adapter.
6. Verify the Mac's subnet and Wi-Fi route, read the glasses health endpoint and
   match its gateway MAC to the exact USB-identified device. Recheck Ethernet.
7. Start a bounded packet capture on the glasses, scoped to this Mac's address.
   Retain the process identity so cleanup cannot stop a different capture.
8. Launch the unchanged test app with the freshly verified, short-lived Mac
   network lease. Keep it in the background and verify its executable hash.
9. Open Mentra Call. Acknowledge only its known **Glasses audio disconnected**
   warning with **Ignore** for this declared video/roster test. Do not handle
   operating-system dialogs.
10. Inspect Call settings: **Name in calls** is **Mentra Live**, **Direct link**
    is enabled and **Chat TTS** is disabled. Return and open **New Call**.
11. Choose **Create & Join** once. Require an active call for 15 seconds within
    the bounded join deadline. A backend-connection, call-limit or camera-start error fails
    immediately, with no automatic retry.
12. Open the meeting QR dialog, capture its unique Teams link privately, then
    close it. Open Participants and require zero other participants.
13. Start the dedicated browser companion with that exact link. When it reports
    the lobby, admit only **Mentra E2E Observer** through the native named button.
    Require one admitted participant with no waiting label.
14. Require the browser to verify a decoded first frame, advancing glasses video,
    calibrated continuous recording and successful departure. Keep laptop camera
    and microphone capture off in this observer routine.
15. Verify the native participant sheet returns to **0 participants** and
    **Nobody else is in the call yet.** Close the sheet and leave the call.
16. Close only the miniapp this run opened. Relaunch the unchanged app without
    the temporary network lease, then stop the owned hotspot and remove only a
    Wi-Fi preference created by this run.
17. Check audio defaults for unexpected changes without restoring or overriding
    the user's selections. Stop owned loggers/capture, copy and hash-check the
    PCAP, remove only that copied remote file, and restore ADB to shell.
18. Independently retire the owned Graph meeting using the captured join link,
    exact ID, subject and creation interval. Require DELETE 204 followed by
    GET 404. Finalize recordings and run status, then release the lock and
    scoped keep-awake assertion.

Ctrl-C requests cleanup rather than starting another attempt. Cleanup actions
still run if app screenshots are unavailable, while missing evidence fails the
run. Owned child processes receive a bounded graceful shutdown; a forced stop
is a failure and does not qualify browser departure or recording finalization.
The controller also bounds the browser companion to four minutes. A failed command,
recording, permission check or cleanup produces failure; a successful command
cannot override a stale screenshot. Every performed step retains its actual
English description and observed result in the report.

## Ownership and evidence

Each run is under `.test-results/mentra-e2e/<timestamp>-call-incoming-video-*`.
Native `routine.mp4`, chapters and screenshots are at the run root; continuous
browser evidence is in `browser/`; private setup logs, fixture, helper/source
hashes, packet capture and cleanup proofs are in `setup/`. Run from the recorded
repository revision; copied source files in evidence document provenance and
are not an independent installed package.

Meeting retirement is an administrative test cleanup, separate from the app's
Leave action. It reads authorized Porter configuration only into memory and
does not log credentials. It rejects ambiguous logs and requires the Graph
meeting to match the exact captured join link. If creation fails before the link is captured, cleanup instead requires exactly
one creation event from the verified signed host PID and exact Call miniapp
log scope, inside the recorded attempt window with its captured timezone. Its
ID must match the server creation log and Graph record, including subject and
time. Missing, foreign or ambiguous proof still requires operator review; a
nearby timestamp alone never authorizes deletion. This remains administrative
cleanup, not app-owned meeting retirement qualification.

Any observed Local Network denial excludes unattended qualification. Human
interventions must also be recorded; absence of a denial alone does not prove
permission persistence. A successful report covers only its declared scope.
The earlier manually assisted and failed diagnostics remain unchanged.


## Browser rejoin extension

Add `--browser-rejoin` to `connected-call.ts run` to leave and rejoin the browser
within the same owned meeting. The glasses stream continues, so this remains
one stream attempt. After the first video check, the browser leaves and waits
for an acknowledgement over its owned stdin pipe. The native controller must
verify zero participants before issuing that acknowledgement. The browser
then uses **Rejoin**, completes prejoin if shown, waits for admission, verifies
camera/microphone capture remain off, and checks a new decoded video baseline
and advancing playback. The native roster must return to one participant.

The extension still performs normal final browser/native departure and exact
meeting retirement. It does not qualify restarting the native glasses stream,
return audio or laptop capture. `rejoinQualified` requires actual second video
reception, not merely a connected UI. A missing acknowledgement times out and
retains failure instead of guessing that the native roster recovered.

Each browser chapter also saves observed WebRTC connection states, sender and
receiver track labels, and allowlisted RTP counters. The observer does not
change media constraints, selected devices, SDP or frame contents. ICE
credentials, network addresses and raw media are excluded from these statistics.
An optional Chrome loopback test validates this observer without opening any
hardware capture or meeting:

```sh
MENTRA_E2E_BROWSER_TEST=1 bun test tools/mentra-e2e/runner/browser-media-diagnostics.test.ts
```

If the second video check fails, the extension preserves that failure and
inspects Teams' People list. It then leaves, waits for native zero participants,
and opens the original meeting link in a fresh page load. Admission and video
are checked again without restarting the glasses stream. This diagnostic
comparison is reported separately as `freshLinkRecovery`; recovery never
changes the original failed Rejoin result into a pass.

## Laptop capture extension

Teams has its own device selection: Chrome's default microphone setting does
not guarantee which microphone Teams uses. Create a private device fixture
using exact labels from Teams' device menus (no Default or Communications
aliases):

```json
{
  "schemaVersion": 1,
  "microphone": "MacBook Pro Microphone (Built-in)",
  "camera": "MacBook Pro Camera (0000:0001)",
  "speaker": "MacBook Pro Speakers (Built-in)"
}
```

First rehearse the controls without joining. The URL file can contain a previous
test meeting link that still opens Teams prejoin; this tool never presses Join.

```sh
bun tools/mentra-e2e/teams-device-setup.ts \
  --meeting-url-file /absolute/private/meeting-url.txt \
  --devices-file /absolute/private/laptop-teams-devices.json \
  --output /absolute/private/new-setup-directory
```

The setup selects the laptop microphone, speaker and camera through Teams'
normal controls, verifies the actual camera preview track, then turns the
camera and microphone off. Teams may defer opening the microphone track until
joining; a selected prejoin microphone alone is not capture or transmission
proof. Browser-origin permission is temporary; macOS media permissions still
apply. This neither changes macOS audio defaults nor starts a glasses stream.

For a recorded call, add
`--browser-capture-devices /absolute/private/laptop-teams-devices.json` to
`connected-call.ts run`. It performs these additional English steps:

1. Select and verify the declared laptop devices before joining the browser.
2. Join with browser camera/microphone off and verify incoming glasses video.
3. Turn on the browser microphone and camera through the call controls.
4. Verify live capture tracks match the declared laptop devices and outgoing
   audio packets, video frames and video bytes keep advancing for five seconds.
5. Leave the browser and perform the existing native/network/meeting cleanup.

`browserSendingVerified` covers actual browser capture and outgoing RTP. It does
not prove return audio is audible through the glasses or that the native app
renders the laptop video. `duplexQualified` remains false. Capture and rejoin
extensions are currently separate runs. Each consumes one authorized stream
attempt; setup alone consumes none.
