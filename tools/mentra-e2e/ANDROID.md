# Android comparison fixture

This is an Android discovery lane for comparing Mentra Call with the iOS app on Mac. A complete Android meeting routine is not yet qualified. Preserve each failed attempt; do not treat successful UI taps as a successful call.

## Set up another Mac

Install Android platform tools (`adb`), Maestro and scrcpy from their official distributions, plus Java as required by Maestro. The initial recorder uses scrcpy 4.0. Record `adb version`, `maestro --version`, `scrcpy --version` and `java -version` with the run. Enable developer options and USB debugging on the test phone, connect USB, and accept its authorization prompt. `adb devices -l` must show the intended phone as `device`.

Always select the phone by explicit ADB serial, including Maestro and scrcpy. The initial Fold is `RFCX71TH0CR`, model SM-F956U1, Android 16. USB-connected glasses may be another ADB target. Recheck the serial on a new test station; never select the first device in the list.

Keep the phone unlocked and the Mentra App open in English. Record the current account without changing it. Connect the agreed pair of glasses through the ordinary product UI and confirm its unique Bluetooth suffix. A generic “Mentra Live” home card is insufficient. Do not reset app storage or Bluetooth bonds as routine preparation.

## Refuse the wrong glasses before operating the phone

The read-only preflight checks Samsung Android 16's `BluetoothRemoteDevices` table. It requires exactly one active Mentra Live pair, the requested name matching the Bluetooth address suffix, and both BLE and Bluetooth Classic connected. Missing/unsupported output, saved bonds alone, partial connections and multiple active pairs fail closed with exit code 2. This proves the observed Bluetooth connections, not the active audio route, physical serial, firmware version or media readiness.

Run the check immediately before every hardware flow and chain the flow with `&&` so a failed fixture check prevents its execution:

```sh
MENTRA_ANDROID_RUN=".test-results/mentra-e2e/$(date -u +%Y%m%dT%H%M%SZ)-android-call"
mkdir -p "$MENTRA_ANDROID_RUN"
bun tools/mentra-e2e/android-preflight.ts \
  --serial RFCX71TH0CR --glasses Mentra_Live_03BE \
  --output "$MENTRA_ANDROID_RUN/fixture.json" &&
maestro --device RFCX71TH0CR test \
  --test-output-dir "$MENTRA_ANDROID_RUN" \
  --debug-output "$MENTRA_ANDROID_RUN/maestro-debug" \
  path/to/reviewed-flow.yaml
```

Replace the serial, agreed glasses name and flow path with the actual test fixture. `path/to/reviewed-flow.yaml` is a placeholder, not a shipped meeting suite. The output JSON must be new; an existing evidence file is never overwritten. The gate is a snapshot, so stop if someone changes pairing during the flow and check again before continuing. Other Android versions need parser qualification against their real output before use.

Use Maestro's observed semantic text/resource IDs and explicit destination assertions. Never add literal coordinate taps, OCR selectors, `launchApp` with clear-state behavior, or AI analysis to the compiled routine. The discovery flows successfully opened settings, edited the meeting title via resource ID `subject`, and attempted Create & Join. Radio/switch accessibility state was unreliable; use independently observed status copy and runtime evidence until the app semantics are fixed.

## Record without disturbing the Mac desktop

After fixture validation, a separate terminal can record the phone without a Mac window, mouse control or audio routing:

```sh
scrcpy --serial RFCX71TH0CR --no-window --no-control --no-audio \
  --record "$MENTRA_ANDROID_RUN/routine.mp4" --time-limit=1800
```

Stop it with Control-C/SIGINT so the MP4 finalizes. Record its start time and each English step's timestamps for chapters. Place Maestro `takeScreenshot` actions at each step. Save accessibility snapshots between flows; a concurrent `uiautomator dump` can conflict with Maestro. Do not claim the Mac harness's chapter/liveness verification automatically covers these Android discovery recordings.

For independent screenshots, select the physical panel using `adb -s RFCX71TH0CR shell dumpsys SurfaceFlinger --display-id`, then `adb -s RFCX71TH0CR exec-out screencap -p -d <physical-display-id>`. The Fold has two physical panels, and scrcpy can add a virtual display. Without `-d`, screencap emitted a display warning before the PNG bytes in this session. Verify the PNG signature; do not accept that raw stdout as an image. Recheck the display ID after folding/unfolding or on another phone.

## Backend and transport are separate choices

- **Direct link for Teams on:** glasses hotspot → phone → Teams. The phone uses Wi-Fi for the glasses link and cellular data for internet. The current Android implementation requires validated cellular connectivity before joining the hotspot. This bypasses Cloudflare video ingest, but meeting creation/authentication still use the Call backend.
- **Direct link off (cloud relay):** glasses on internet Wi-Fi → Cloudflare Stream → phone → Teams. The phone can stay on ordinary internet Wi-Fi without a SIM. Cloudflare Stream provisioning must succeed before this video path can work.

Call's backend creates Teams meetings and provides calling credentials. The Mentra App's Cloud V2 runtime provisions cloud video streams. A production Call backend does not select the host's production runtime. Record both endpoints, the transport setting, account, app/APK hash, Call ZIP hash and firmware before comparing platforms.

The external Call repository's `main` branch and its production deployment are also distinct from ZIP packaging: `bun run pack` embeds the development Call URL; `bun run pack:prod` embeds production. Read the actual `BACKEND_URL` assignment in `background/index.js` inside the APK's Call ZIP. Searching for any dev URL is insufficient because the production bundle can retain a dev fallback constant. Packaged archives alone do not prove which subsequently updated or extracted miniapp is active.

## Evidence from 2026-09-16

The Fold's installed APK was hashed directly on the device and matched GitHub's **dev.263** release digest. The exact linked **dev.262** APK was also downloaded and independently hashed. Both contain the identical Call 2.1.13 ZIP at `res/lq.zip`, with `BACKEND_URL = resolvePublicBackendUrl("https://mentra-call-miniapp-dev.mentraglass.com")`.

| Artifact | SHA-256 |
| --- | --- |
| dev.262 APK | `34f80f98ac7cf38bdd3180ff07c9d3ba9274f69c3a50c6bcecbc519a3453c96b` |
| dev.263 APK / installed Fold APK | `f58f5a4eb6a64a0f2f1c4973060076d59db9065e799635f790981a80c615a173` |
| Call 2.1.13 ZIP, identical in both APKs | `9ade8cca63ddc31a63e337d03ba5026793be049d9e515860a187894aeaeb7987` |

Call's remote `main` was `6ab859d499321e7bc394f3113db8e024649e7faa`; its [production deployment](https://github.com/Mentra-Community/Mentra-Call/actions/runs/35111294549) succeeded. That does not change the URL already embedded in these APKs. The local Mac Call 2.1.14 ZIP was built with `pack:prod` and uses the production Call backend. Both observed host apps used the development Cloud V2 runtime. These are not yet equivalent platform fixtures.

The first Android attempt created a meeting through the development Call backend, then failed with `SOFTAP_NO_CELLULAR_INTERNET`. Android reported `ABSENT,NOT_READY` for SIM state and no validated cellular data. Native teardown reported the hotspot closed and default Wi-Fi restored. No ACS join, publishing or browser participant was verified.

That attempt is also **invalid as a 03BE platform comparison**: identity was checked too late and showed 023B connected instead of the expected 03BE. Phone control was stopped. After the user's manual re-pairing, 023B had both BLE and Classic connected and 03BE remained disconnected; the intended replacement fixture still needs confirmation. This failure motivated the preflight above. No cloud retry was executed on the Fold.

The earlier Mac cloud attempt created a meeting through the production Call backend but failed in the development Cloud V2 runtime while provisioning Cloudflare Stream: the API returned authentication error / HTTP 403. This is a separate failure from the Fold's missing cellular data. Neither attempt establishes that iOS alone is broken.

Local evidence is under `.test-results/mentra-e2e/2026-09-16T22-23-47Z-android-call-discovery/`, including the paused video, screenshots, semantic flow YAML, app logs, fixture status, extracted ZIP and `release-comparison/comparison.json`. The Android discovery video is not a qualified end-to-end recording. Keep raw logs and private meeting identifiers out of Git. Cleanup of the failed Android meeting object remains to be verified; do not assume closing the UI deletes it.
