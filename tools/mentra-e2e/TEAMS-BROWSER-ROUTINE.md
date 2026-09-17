# Teams browser companion

This experimental companion replays the browser half of a Mentra Call test. It
uses Playwright Core 1.63.0 with the installed Google Chrome and a dedicated
persistent profile. The native host must create the meeting and admit the named
guest. This companion does not yet qualify the complete connected-call routine.

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

```sh
bun tools/mentra-e2e/teams-browser.ts setup --meeting-url-file /absolute/private/meeting-url.txt
```

Setup opens Chrome for the human to complete authentication and press Enter in
the terminal. Setup does not record authentication video. The profile can retain
the session, but Microsoft can require verification again. A run that reaches
sign-in stops; the runner never requests or enters verification codes.

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
audio. The current observer does not transmit laptop camera video either. Those
directions remain required, separate qualification work for the complete goal.

A green frame before Teams navigation calibrates the browser recording's clock
against step times. Calibration uncertainty above 200 ms, missing calibration,
wrong recording dimensions or a chapter outside the actual MP4 duration fails
the artifact check. The HTML buttons seek to calibrated English checkpoints.
Browser interaction with that local viewer remains unqualified because the
browser tool rejected its local-file URL; no alternate URL or browser was used
to work around that restriction.

The September 17 native/Chrome controller admitted a real guest without a model
call, but the browser's first sample preceded its first video frame. Its failed
report is retained; the readiness correction is unit-tested and awaits another
live run. The next attempt hit the daily quota before ACS joined. No successful
full standalone replay is claimed. Offline reprocessing of the saved recording
verified a 16.72-second MP4 with eight chapters and 49 ms calibration uncertainty;
this does not change the original call result.

The user stopped live streaming for the day. Neither quota configuration changes
nor additional live qualification were performed afterward. See
[MENTRA-CALL-ROUTINE.md](MENTRA-CALL-ROUTINE.md) for the exact runs and remaining
permission, audio and hardware gates.
