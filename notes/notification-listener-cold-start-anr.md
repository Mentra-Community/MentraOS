# Notification listener ANRs by cold-starting React Native (OS-1821)

Reproduced 2026-07-29 on a moto g play 2024 (Android 14, API 34), Mentra 2.12.0.
This is the crash behind the "emergency kill switch" in PR #3562, which disabled
the Android notification listener by default and has blocked OS-1821 since.

Native `.kt` changes are out of scope for me, so this is a spec rather than a
patch.

## The ANR

```
Process:  com.mentra.mentra
Subject:  executing service com.mentra.mentra/
          com.mentra.crust.services.NotificationListenerServiceImpl, InvisibleToUser
Build:    motorola/fogona_g/fogona:14/U1TFS34.100-35-14-1-16
Foreground: No
Process-Runtime: 42057
```

`InvisibleToUser` means a background ANR: no dialog, no app-visible crash, the
system just kills the process. That is why the report in PR #3562 said the
uploaded logs "ended before the failure" — there is nothing for the app to log.

Main thread at the moment of the ANR:

```
MainApplication.onCreate(MainApplication.kt:37)
 └─ ReactNativeApplicationEntryPoint.loadReactNative
     └─ DefaultNewArchitectureEntryPoint.load
         └─ ReactNativeFeatureFlagsCxxInterop.<clinit>
             └─ SoLoader.loadLibrary
                 └─ DirectApkSoSource.loadDependencies → buildLibDepsCache
                     └─ new ZipFile(...) → ZipFile$Source.initCEN   ← stuck here
```

System state in the same record:

```
/proc/pressure/cpu     some avg10=86.53
/proc/pressure/memory  some avg10=26.86   full avg10=5.40
CPU usage: 93% TOTAL
  51% 103/kswapd0: 0% user + 51% kernel
RssKb: 191596   VmSwapKb: 21244
```

`kswapd0` burning 51% of CPU in kernel is the kernel thrashing to reclaim pages.
The device is RAM-starved and swapping.

## What is actually happening

A notification arrives while the Mentra App is **not running**. Android starts
the process specifically to deliver it, and because
`NotificationListenerServiceImpl` lives in the main process, `Application.onCreate`
runs first — which boots the entire React Native runtime, including SoLoader
opening the APK and parsing its zip central directory to build a native-library
dependency cache.

All of that has to finish inside the service-start ANR window. On a fast phone it
does. On a budget device under memory pressure it does not, and the system kills
the process.

The notification listener does not need React Native. It is Kotlin; it reads the
notification and hands it off. RN is being dragged in purely because the service
shares a process with the app.

## Why this explains the original report

| Observation | Explanation |
| --- | --- |
| "Crashes when he gets a lot of notifications" | Each notification arriving at a dead process is another cold start, and another chance to exceed the window. Volume raises the odds; it is not the cause. |
| Logs ended before the failure | Background ANR: silent kill, no stack trace in app logs. |
| The kill switch worked | A disabled component is never bound, so notifications never wake the process, so there is no cold start to time out. |
| Pixel 8 and Z Fold 6 never reproduced | Both are fast flagships on API 36. 250-notification bursts on each survived with no ANR. This is a low-RAM device problem, not an Android-version problem. |
| Only some users | Depends on device class and on whether the app happens to be dead when notifications land. |

## Fix

**Preferred — give the listener its own process.**

```xml
<service
  android:name="com.mentra.crust.services.NotificationListenerServiceImpl"
  android:process=":notif"
  ... />
```

A separate process gets its own `Application.onCreate`, so the listener starts
without booting React Native at all. Cold start becomes cheap and the ANR window
stops being a problem.

The catch: `NotificationListener` currently calls `CrustModule.emitPhoneNotification(...)`
straight into JS, which no longer works across a process boundary. That handoff
needs a real IPC hop — bind back to the main process, or persist and let the main
process drain on next start. Notifications arriving while the app is dead should
probably be queued rather than dropped, which is a product decision worth making
explicitly.

**Smaller alternative — skip RN init when the process was started for the listener.**

In `MainApplication.onCreate`, detect that the process was created for the
notification listener and return before `loadReactNative()`. Less invasive, but it
leaves the two coupled and every future `Application.onCreate` addition can
reintroduce the problem.

## Secondary hardening (independent of the above)

Found while investigating; worth doing regardless, none of them is the cause.

1. **Two unguarded `requestRebind()` calls** in `NotificationListener.kt`
   (~line 78 and ~line 375). `requestRebind` can throw when the component lacks
   notification access, and the `onListenerDisconnected` one fires exactly when
   access is revoked. Neither is wrapped.
2. **`getApplicationInfo` + `getApplicationLabel` run on the main thread per
   notification**, before the handler thread hop, with no cache. Measured ~16ms
   per notification on a Pixel 8. Cache `packageName -> label` and hop threads
   first.
3. **`android:exported="false"`** on the service is non-standard for a
   `NotificationListenerService`; Google's documented sample uses `exported="true"`
   and relies on `BIND_NOTIFICATION_LISTENER_SERVICE` to restrict binding. It
   demonstrably works on API 36, so this is tidiness, not a known break.

## Verifying a fix

1. Budget Android device (the moto g play 2024 reproduces; flagships do not).
2. Force-stop the Mentra App so the process is dead.
3. Post notifications: `adb shell cmd notification post -t T tag body`.
4. Watch for death: `adb shell pidof com.mentra.mentra`.
5. Check for a new record: `adb shell dumpsys dropbox --print data_app_anr | grep -A5 mentra`.

A fix means step 5 stays empty while notifications still arrive.

## Note on telemetry

None of this reached Sentry, and would not have. Every mobile CI workflow runs
`cp .env.example .env`, and that file ships `EXPO_PUBLIC_SENTRY_DSN` empty;
`SentrySetup.tsx` returns early on an empty DSN without logging. So CI builds
have crash reporting silently disabled. Being tracked separately — it is the
reason this took a device-side ANR dump to find.
