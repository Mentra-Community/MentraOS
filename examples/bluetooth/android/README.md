# Bare Android Example

This example is a minimal native Android app that calls the Mentra Bluetooth SDK Kotlin API directly.

It is intentionally not a React Native or Expo app. It demonstrates scanning, connecting, receiving hardware events, refreshing device status, capturing microphone frames, routing app audio output, requesting photos, starting/stopping video recording, configuring hardware-button capture behavior, and cleaning up the SDK.

## Configure SDK Version

Set the SDK version in `gradle.properties`:

```properties
mentraSdkVersion=<version supplied by Mentra>
```

If you are testing an unreleased local SDK build, publish the SDK and companion artifacts to Maven local, then keep `mavenLocal()` enabled in `settings.gradle.kts`.

For a partner release, add the Maven repository and credentials supplied by Mentra in `settings.gradle.kts` or your organization's Gradle init script.

## Run

Open this folder in Android Studio, select the `app` configuration, and run on a physical Android device with Bluetooth enabled.

The example asks for Bluetooth/location/microphone permissions, scans for Mentra Live glasses, and connects to the first discovered device or the saved default.

The app is split into native Android tabs:

- **Status** shows connection/data-channel state, battery, Wi-Fi, firmware/version details, and recent hardware events.
- **Audio** exercises microphone input callbacks (`onMicPcm`, `onMicLc3`, and local transcription) and plays a short Android output tone while notifying the SDK that the app is producing audio.
- **Camera** exercises photo requests, gallery status, saved video recording, camera settings, and hardware-button capture behavior. The photo preview flow sends a new SDK photo request with a webhook URL, then polls the local webhook server by `requestId` and displays the uploaded image.
- **Display** keeps display text/settings controls for glasses models that support display output.
- **Logs** keeps SDK debug logs hidden by default; use **Show SDK debug logs** when collecting support details.

Mentra Live does not have a display, so the Status, Audio, and Camera tabs are the main hardware validation surface for that device.

## Local Photo Preview

For a local end-to-end photo upload demo, start the companion webhook server on your computer:

```bash
python3 examples/photo-webhook-server/server.py
```

Paste the printed LAN URL, for example `http://192.168.1.42:8787/upload`, into the Android example's Camera tab. The URL shown in the empty field is only a placeholder; you must enter the URL printed by your local server. Do not use `localhost`; the Mentra Live glasses upload the photo directly to the computer.

When you tap **Take photo + upload to webhook**, the Android app calls `sdk.requestPhoto(...)` with that URL. The glasses capture the photo, upload it to the server, and the Android app polls `GET /uploads/<requestId>.json` until it can load the returned `photoUrl`.

## Files

- `app/src/main/java/com/mentra/examples/android/MainActivity.kt`: native SDK usage
- `app/src/main/AndroidManifest.xml`: app permissions and activity declaration
- `app/build.gradle.kts`: app dependency on `com.mentra:bluetooth-sdk`
- `../photo-webhook-server/server.py`: local webhook receiver for photo upload previews
