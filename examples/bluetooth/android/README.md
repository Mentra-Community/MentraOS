# Bare Android Example

This example is a minimal native Android app that calls the Mentra Bluetooth SDK Kotlin API directly.

It is intentionally not a React Native or Expo app. It demonstrates scanning, connecting, receiving events, displaying text, applying a simple setting, and cleaning up the SDK.

## Configure SDK Version

Set the SDK version in `gradle.properties`:

```properties
mentraSdkVersion=<version supplied by Mentra>
```

If you are testing an unreleased local SDK build, publish the SDK and companion artifacts to Maven local, then keep `mavenLocal()` enabled in `settings.gradle.kts`.

For a partner release, add the Maven repository and credentials supplied by Mentra in `settings.gradle.kts` or your organization's Gradle init script.

## Run

Open this folder in Android Studio, select the `app` configuration, and run on a physical Android device with Bluetooth enabled.

The example asks for Bluetooth/location/microphone permissions, scans for Mentra Live glasses, connects to the first discovered device or the saved default, displays text, applies brightness/dashboard settings, and disconnects.

## Files

- `app/src/main/java/com/mentra/examples/android/MainActivity.kt`: native SDK usage
- `app/src/main/AndroidManifest.xml`: app permissions and activity declaration
- `app/build.gradle.kts`: app dependency on `com.mentra:bluetooth-sdk`
