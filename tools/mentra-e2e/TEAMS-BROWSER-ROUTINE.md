# Teams browser companion

This experimental companion replays the browser half of a Mentra Call test. It
uses Playwright Core 1.63.0 with the installed Google Chrome and a dedicated
persistent profile. The native host must create the meeting and admit the named
guest. The connected controller and this companion passed two consecutive incoming-video routines on September 17. Duplex audio and laptop-camera transmission remain unqualified.

Playwright provides semantic locators, bounded waits and continuous recording.
Using installed Chrome gives Teams its supported browser engine without a
handwritten CDP client. Headless execution avoids taking the user's focus. A
separate profile avoids controlling personal tabs or recording personal sessions.
No model is called by the script.

## Setup on another Mac

1. Follow [SETUP.md](SETUP.md) for Bun, the signed Mentra App, the native driver,
   fixture identity and recording permissions.
2. Install Google Chrome from Google's official distribution and FFmpeg,
   including `ffprobe`. Install this directory's locked dependencies with
   `bun install --frozen-lockfile`.
3. Install Playwright's recording encoder from its official distribution:
   `bunx playwright-core install ffmpeg`. No separate Chromium download is
   needed: the companion selects the installed `chrome` channel.
4. Provision an authorized test account with sufficient Call quota before a
   repeated live qualification. The production default is 10 calls per account
   per UTC day. Quota exhaustion is a failed prerequisite; replay must not reset
   counters, change accounts to evade it or alter the production configuration.
   The backend's existing `CALL_QUOTA_UNLIMITED` test-account allowlist requires
   a separate authorized configuration change.
5. Store the newly created meeting's exact HTTPS link in a private local text
   file. Do not reuse an ended or retired meeting. Keep links, profiles, tokens
   and raw evidence out of Git.

The browser profile is `~/.cache/mentra-e2e/teams-chrome`, with user-only access.
Anonymous guests worked with explicit host admission and required no email
code. Use normal sign-in only if the meeting policy requires it:

Check the generated meeting link, not the Teams homepage. The homepage can show
sign-in even when the meeting accepts anonymous guests; that is not evidence
that a Microsoft account is required. A September 17 Android-owned meeting
reached guest prejoin and passed laptop device selection without account
creation. Do not close a human's active verification window unexpectedly.

```sh
bun tools/mentra-e2e/teams-browser.ts setup --meeting-url-file /absolute/private/meeting-url.txt
```

Setup opens Chrome for the human to complete authentication and press Enter in
the terminal. Setup does not record authentication video. The profile can retain
the session, but Microsoft can require verification again. A run that reaches
sign-in stops; the runner never requests or enters verification codes.

## Camera and microphone readiness without joining

Use Teams' device menus as the authority. The earlier Chrome-defaults preflight
has been removed: a real call showed Teams selecting 03BE despite that browser
check passing. Its historical evidence remains unchanged.

On another Mac, open Teams prejoin during the human setup above, keep microphone
and camera off, and inspect the **Microphone**, **Speaker** and **Camera** menus.
Copy the exact laptop device labels into the private fixture described in
[CONNECTED-CALL-REPLAY.md](CONNECTED-CALL-REPLAY.md). Choose named laptop devices,
not glasses or **Default** aliases. The camera label can differ between Macs.
Close prejoin without joining, then rehearse those same selections:

```sh
bun tools/mentra-e2e/teams-device-setup.ts \
  --meeting-url-file /absolute/private/meeting-url.txt \
  --devices-file /absolute/private/laptop-teams-devices.json \
  --output /absolute/private/new-setup-directory
```

The rehearsal saves screenshots and accessibility snapshots, selects all three
devices through Teams, verifies the actual camera preview track, turns capture
off and closes. It never joins or starts a glasses stream. Microphone capture
may wait until admission, so its selected label alone is not transmission proof.
Browser-origin permission is temporary; ordinary macOS permission gates still
apply. A setup pass does not prove return audio or audible glasses playback.
Run it separately from the observer because both own the dedicated Chrome profile.

## English steps

1. Open the exact fresh meeting link in the dedicated browser profile.
2. If Teams offers its browser launcher, choose **Join meeting from this
   browser**. If prompted for media access, choose **Continue without audio or
   video** for this incoming-video observer.
3. Enter **Mentra E2E Observer** when a name field is present. Verify camera and
   microphone capture are off, including Teams' explicitly disabled/unavailable
   controls. Leave the selected physical audio devices unchanged.
4. Choose **Join now**. Classify **Someone will let you in shortly** as a lobby,
   independently of any participant count or preview.
5. The native host admits only **Mentra E2E Observer** through its named Admit
   control, when Teams grants the host that capability. No meeting or tenant
   policy changes are part of the routine.
6. Require the browser's connected **Leave** control and the **Mentra Live**
   participant tile. Require the native participant sheet to show one admitted
   guest; the connected controller owns this native assertion.
7. Wait up to 20 seconds for a decoded glasses frame. Then compare two playback
   samples five seconds apart. Require decoded, unpaused playback with advancing
   time. Resolution adaptation is allowed; an absent or frozen baseline fails.
8. Choose **Leave**, require **Rejoin**, and close only the test browser context.
   The connected controller verifies the native roster returns to zero and
   cleans up its owned meeting, camera stream, hotspot and scoped capture.

```sh
bun tools/mentra-e2e/teams-browser.ts run \
  --meeting-url-file /absolute/private/meeting-url.txt \
  --output /absolute/private/new-run/browser
```

The output directory must be new. The default is headless; `--headful` is an
explicit opt-in. `--admission-seconds` accepts 1–300 seconds and defaults to 90.
The native controller consumes `MENTRA_BROWSER_EVENT` JSON lines to perform
admission at the observed lobby checkpoint. The companion can run independently
with a human host, but that does not count as an unattended complete routine.

## Evidence and qualification

Every recorded checkpoint includes its English instruction, screenshot and
accessibility snapshot. The output contains `steps.json`, `result.json`, decoded
video samples, the original continuous WebM, `routine.mp4`, `chapters.json` and
`index.html`. These recordings are silent; they do not prove microphone or return
audio. The default observer keeps laptop capture off. The optional capture extension
records hardware tracks and outgoing packet counters separately; those do not
prove audible return audio or native reception.

A green frame before Teams navigation calibrates the browser recording's clock
against step times. Calibration uncertainty above 200 ms, missing calibration,
wrong recording dimensions or a chapter outside the actual MP4 duration fails
the artifact check. The HTML buttons seek to calibrated English checkpoints.
Browser interaction with that local viewer remains unqualified because the
browser tool rejected its local-file URL; no alternate URL or browser was used
to work around that restriction.

The portable connected controller passed two consecutive complete incoming-video
runs on September 17: 27 native steps each, 113.802 and 119.787 seconds. Both
verify named anonymous admission, native roster arrival/departure, advancing
glasses video and exact owned cleanup without model calls or email codes.
These are incoming-video passes; full duplex remains unqualified. Earlier
failed runs are retained unchanged.

The user authorized ten further stream attempts and the test account's quota
exemption. That private ledger now records nine attempts,
including failures. One remains. This cap is separate from the backend quota.

The connected controller can also request `--rejoin` through its own
`--browser-rejoin` flag. This mode requires the native controller's departure
acknowledgement on stdin; do not run the standalone flag without that controller.
The browser records both admissions and separate first-frame/progression
samples. See [CONNECTED-CALL-REPLAY.md](CONNECTED-CALL-REPLAY.md).

The optional laptop capture and separate no-join device setup commands are in
[CONNECTED-CALL-REPLAY.md](CONNECTED-CALL-REPLAY.md). Teams' own device menus
must be checked; Chrome defaults alone are insufficient. Capture setup passed,
but attempt 9's combined sending check failed because outgoing video remained
zero. Actual laptop capture and outgoing audio packets were observed. The
current native host has no incoming-video renderer. Neither audible return
audio nor laptop-video reception is qualified.

Attempt 8 reproduced the rejoin issue with stronger evidence: Teams People
listed only the browser guest and WebRTC had no incoming RTP, while native
still listed the admitted guest. Its fresh-link comparison stopped at the
browser launcher, which the shared helper now handles. This recovery has not
yet been qualified live. See the full evidence ledger in
[MENTRA-CALL-ROUTINE.md](MENTRA-CALL-ROUTINE.md).
