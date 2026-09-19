# Android OTA update routine

This routine owns firmware installation. Run it before Call when the candidate's mandatory ASG, MTK or BES targets differ from the glasses. A Call run must never silently install firmware or skip a required update.

See [Android setup](ANDROID.md) for the USB, account, pairing and recording prerequisites. Keep setup evidence separately: first-time sign-in, pairing and permission prompts are not firmware checks.

## English steps

| Step         | Action                                                                                                                                                                                | Required result                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTA-01       | Start a new recording. Verify the phone APK, the glasses' USB serial, eMMC identity and Bluetooth address, and the phone's BLE and Classic connections. Load the pinned OTA manifest. | Exactly the intended pair is connected and the installed phone APK matches the candidate. Record initial ASG, MTK and fresh BES versions.                                                                                                             |
| OTA-02       | If any mandatory target is missing, open the normal update offer in the Mentra App and press **Update Now** once.                                                                     | Installation starts through the product UI. An already-current device skips installation and records that fact.                                                                                                                                       |
| OTA-PROGRESS | Observe the download, transfer, installation and any restart/reconnection. Save each changed stage.                                                                                   | No update error. Do not force-stop the app, flash over ADB or retry an uncertain installation. If another component requires a separate confirmation, preserve the recording and report the unhandled stage until that transition has been qualified. |
| OTA-03       | After the app reports completion, read the installed ASG version and APK hash, MTK version and a fresh BES version response tied to the current boot. Recheck device identity.        | All three targets match the reviewed manifest. A success message alone cannot pass this step.                                                                                                                                                         |
| OTA-04       | Press **Done** on the verified completion screen and confirm paired home. Finalize the recording and report.                                                                          | Mentra Live and Settings are visible. No call or stream has been created.                                                                                                                                                                             |

## Replay

Run from the repository root. The output directory must not already exist.

```sh
bun tools/mentra-e2e/android-ota.ts \
  --fixture /absolute/path/android-rig.json \
  --output /absolute/path/runs/ota-001 \
  --install
```

`--install` allows the offered mandatory update. Without it, an outdated device fails before pressing Update Now. An already-current device passes by independently checking the targets. The runner currently expects the normal update offer to be visible when installation is needed; it does not change the app's OTA configuration.

The run folder contains `index.html`, `routine.mp4`, `chapters.json`, `result.json`, screenshots, accessibility XML, executed Maestro YAML and hardware readbacks. Chapter alignment is approximate, based on recorder file creation and host timestamps; links start 0.5 seconds early. The report does not claim the Mac recorder's frame-calibration qualification.

## Qualification recorded September 17, 2026

On the Motorola Razr Plus 2024 (`ZY22JWCN97`) and Mentra Live 03BE (`ML396102B`), the normal Android update installed ASG **302016752**, replacing **302000015**. Installed ASG SHA-256 was `a48fdce1801501eb54b5ff4ac2a441c6bc7230403933f3b5af2115fe453484dc`. MTK **MentraLive_20260915.0** and BES **26.9.17.0** already matched the mandatory targets. Device identity was unchanged; the final BES proof was 13.487 seconds old and matched the current boot.

The installation was recorded during interactive discovery with the actual executed semantic commands saved. A subsequent standalone **already-current replay passed with zero model calls**. A future full installation, including any additional component confirmation screens, still needs qualification under the compiled runner. Do not present the already-current pass as a second installation.

Local evidence is in `.test-results/pr-4078-android-qualification-01f22fc/`: `preflight-razr/` preserves the original setup and installation, `android-ota-installation-01/` contains its OTA-only review clip, and `android-ota-current-02/` is the separate compiled verification run.
