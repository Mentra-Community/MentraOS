# Microphone recovery: G2 + Mentra Live test plan

PR: [#4199](https://github.com/Mentra-Community/MentraOS/pull/4199), targeting staging.

Physical testing is **not run yet**. The device matrix is intentionally limited to G2 and Mentra Live. Nimo's Android session reset and iOS audio-activity reporting have automated coverage, not Nimo hardware qualification.

## Setup (once per phone)

- Install the Android / iPhone build for the current PR head. Record app build + commit, phone model/OS, glasses model and firmware. Do not use a Mac run as iPhone evidence.
- Keep a stable internet connection and use the same transcription language/settings throughout.
- Select the glasses microphone explicitly for the recovery checks so phone fallback cannot hide a failure. Record and restore the original preference afterward.
- Start Captions and confirm fresh speech appears in its phone transcript view. For G2, also confirm it appears on the glasses. Mentra Live has no display; use the phone transcript view.
- Keep Captions running through each interruption. Do not restart it to make a failing reconnect pass.
- Close other listening miniapps / disable wake-word listening for the final-consumer stop checks. If another consumer remains active, the microphone staying on is expected; record that instead of calling it a failure.
- Capture a phone screen recording and collect app/SDK logs if a check fails. Say a different phrase after each reconnect, such as “G2 reconnect two, purple bicycle,” so old text cannot count as recovery.

## Four combinations, in this order

| Phone | Glasses | Status |
| --- | --- | --- |
| iPhone | G2 | Not run |
| iPhone | Mentra Live | Not run |
| Android | G2 | Not run |
| Android | Mentra Live | Not run |

Allow roughly 10–15 minutes per combination. Do the first two first because the watchdog repair changes iOS; Android verifies the existing reconnect fix and catches platform differences. No G1, Nex, AR99, or Nimo pairing is required for this plan.

## Checks

| Check | Action | Pass condition |
| --- | --- | --- |
| 1. Start + steady audio | Start Captions, speak for 30 seconds, stay quiet for 30 seconds, then speak again. | Fresh transcripts return after silence. Quiet audio packets do not trigger repeated mic restarts. |
| 2. Full reconnect ×3 | Use the Mentra App's disconnect/connect controls while leaving Captions running. Include one quick reconnect. | Each cycle resumes new speech without restarting Captions. Record time from connection readiness to the first fresh transcript. |
| 3. Bluetooth interruption ×2 | In the phone's **Settings**, turn Bluetooth off for 15 seconds, then on. Leave the Mentra App process alive. On iPhone, do not use Control Center's temporary disconnect as a substitute. | The glasses reconnect and fresh transcripts resume. This exercises a different lifecycle from the app's Disconnect button. |
| 4. Background + locked screen | With Captions running, lock the phone for two minutes and speak periodically. Also repeat one Bluetooth interruption with the Mentra App in the background, then lock after enabling Bluetooth. | G2 continues / resumes visible captions. After unlocking, the phone transcript contains the new phrases for both models. No foregrounding or Captions restart is needed to restore capture. |
| 5a. G2 page/dashboard recovery ×5 | On G2 only, open and close its native dashboard while Captions runs. Speak after every close. Finish with one Bluetooth interruption. | Caption rendering and microphone capture both recover. No repeated page rebuilds or mic off/on loop during a healthy stream. |
| 5b. Live audio playback ×2 | On Live only, trigger an ordinary Mentra App TTS response/audio playback while Captions runs; then speak after playback ends. If Classic audio is already paired, also try normal phone playback to the glasses. | Capture resumes after playback. Where the adapter deliberately suspends its mic, the watchdog does not restart it during suspension. Do not require silence during playback if that configuration supports simultaneous audio. |
| 6. Stop while disconnected | Disconnect, stop Captions and all other audio consumers, then reconnect. Wait 30 seconds. | No new capture starts merely because the glasses reconnected. A stopped miniapp remains stopped. |
| 7. Stop / start + source choice | Start Captions again and verify fresh text. Then select the phone microphone for 30 seconds, and finally return to the glasses microphone. | Starting again works. The watchdog does not force glasses capture while the phone source is selected. Returning to glasses resumes fresh text. |

Use these as investigation limits, not a new product SLA: while continuously speaking, fresh transcripts should appear within **20 seconds of the SDK reporting the glasses ready**. If logs expose packet timing, expect the first audio within **15 seconds**. Healthy reconnects should normally be faster; flag every watchdog-assisted recovery and record its delay even when it meets the limit. Connection/pairing time before readiness is recorded separately.

When a time limit is missed, save evidence before restarting anything. Check whether the failure is no audio packets, no decoded PCM, no transcript, or transcript present but absent from the G2 display. A connected icon or a `micEnabled=true` flag alone does not pass a check.

## Automated checks that complement the device run

- Unchanged LC3 / PCM / transcript / local-STT requests survive three full reconnects, including the Android ready-event debounce case.
- iOS: no first packet triggers a retry after the five-second grace period; retries are rate-limited. The production polling interval remains ten seconds.
- iOS: both the G2/Live LC3 path and the Nimo/AR99 decoded-PCM path keep the watchdog healthy; missing packets later trigger recovery.
- Phone PCM and empty data cannot masquerade as live glasses audio.
- Intentional adapter suspension, Mentra App playback, phone-source selection, stopped consumers, and disconnected sessions do not trigger recovery; a new session gets a fresh deadline.
- Android: the real Nimo audio client stops on session loss and restarts at readiness on the same adapter for every consumer type. Stopping the last consumer while disconnected prevents restart.

The missing-first-packet failure is deterministic in automated tests. Ordinary hardware reconnects may not drop the start command, so a successful device run alone does not prove that watchdog branch executed. Do not create a firmware fault or change firmware solely to force it.

## Evidence and cleanup

For each combination, record build/firmware, checks passed/failed, reconnect-to-first-transcript times, and any recovery log messages. Attach failure timestamps and the incident report ID / logs; do not publish raw recordings or private logs in the public PR.

Suggested result row:

```text
phone / OS | glasses / firmware | PR SHA / build | checks 1–7 | reconnect delays | report/evidence
```

On completion, stop the test miniapp, restore microphone preference / wake-word settings / Bluetooth state, and reconnect the user's intended glasses. A recovery workaround is recorded separately from the original result.

The existing routine catalog has no registered Captions reconnect routine covering this matrix. These steps provide the setup, actions, assertions, cleanup, recovery, and evidence for such a future routine; they are not a new dispatch label. The existing Mentra Call routine can supply supplementary meeting/audio regression coverage on an authorized fixture, but does not qualify physical iPhone reconnects and is not required to perform this G2/Live manual plan.
