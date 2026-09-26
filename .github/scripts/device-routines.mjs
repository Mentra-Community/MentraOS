// Selection guidance, not path-trigger rules or worker authorization. Coverage
// means a routine can exercise this behavior; only a completed run proves it.
const definitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/90a70edfe2fa17fd766dda3d98977555d6608a05/"
const androidDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/58483a6c729018dc9955122dd071ecefbfb8ae92/"
export const DEVICE_ROUTINES = Object.freeze({
  "day1-ota": Object.freeze({
    label: "routine:day1-ota", name: "Day-one OTA", platform: "ios-on-mac",
    coverage: "January lab baseline → customer update → exact selected manifest BES, MTK and active ASG versions; setup and return recovery.",
    relatedPaths: ["asg_client/ota_manifests/firmware_live.json", "asg_client/ota_updater/**", "asg_client/**/ota/**", "mobile/src/services/ota*", "mobile/src/effects/OtaUpdateChecker.tsx", "mobile/modules/bluetooth-sdk/**", ".github/scripts/*ota*"],
    prerequisites: "CI Mac app and immutable OTA manifest; enrolled lab glasses with accepted January/return artifacts and authorized downgrade/recovery. Firmware writes are part of this routine.",
    exclusions: "Not a Call test, Android app UI test, arbitrary firmware stress test or exact factory bootloader qualification. Unrelated Bluetooth changes need a demonstrated OTA path to select this routine.",
    definition: `${definitions}tools/mentra-e2e/DAY1-OTA-ROUTINE.md`,
    implementation: `${definitions}tools/mentra-e2e/runner/day1-routine.ts`,
    worker: `${definitions}worker/prepare-day1.ts`,
  }),
  "no-glasses": Object.freeze({
    label: "routine:no-glasses", name: "No-glasses UI", platform: "ios-on-mac",
    coverage: "Signed-in English unpaired Home, All Apps search/navigation, Settings/account form navigation, local glasses-required guards, logout/login and relaunch restoration.",
    relatedPaths: ["mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/src/i18n/en.ts", "mobile/app.config.ts"],
    prerequisites: "CI Mac app; enrolled unpaired fixture and existing test account. Preserves the declared app/account return state.",
    exclusions: "No actual account creation, recovery email or credential changes; no connected glasses, Phone Mode, camera/media streaming, Android-only behavior or translated-locale qualification. A changed mobile path alone is insufficient.",
    definition: `${definitions}tools/mentra-e2e/COMPILED-ROUTINE.md`,
    implementation: `${definitions}tools/mentra-e2e/flows/no-glasses.ts`,
    worker: `${definitions}worker/no-glasses.ts`,
  }),
  "no-glasses-android": Object.freeze({
    label: "routine:no-glasses-android", name: "Android no-glasses UI", platform: "android",
    coverage: "Signed-in English unpaired Home, All Apps search, Settings and account forms without submitting, miniapp switcher and local glasses-required dialogs; recorded Android steps and verified app return state.",
    relatedPaths: ["mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/app.config.ts", "mobile/modules/**/android/**"],
    prerequisites: "CI signed Android APK and immutable OTA manifest; enrolled Android phone with its own existing test account and no paired glasses.",
    exclusions: "No login/logout, onboarding, permission changes, pairing, connected glasses, OTA, Call, acoustic qualification or physical-iPhone coverage. Mac and Android results are independent; the Android adapter's device qualification is pending.",
    definition: `${androidDefinitions}tools/mentra-e2e/ANDROID-NO-GLASSES-ROUTINE.md`,
    implementation: `${androidDefinitions}tools/mentra-e2e/runner/android-walkthrough.ts`,
    worker: `${androidDefinitions}worker/android-no-glasses.ts`,
  }),
  "mentra-call": Object.freeze({
    label: "routine:mentra-call", name: "Mentra Call", platform: "ios-on-mac",
    coverage: "Real Teams guest admission, advancing glasses video, required two-way audio evidence, mute, background, roster/leave/rejoin and owned meeting/network cleanup.",
    relatedPaths: ["mobile/assets/miniapps/com.mentra.call-*.zip", "mobile/src/constants/miniapps.ts", "mobile/modules/acs-meeting/**", "mobile/modules/bluetooth-sdk/**", "mobile/modules/engine/src/services/AcsMeetingService.ts", "mobile/modules/engine/src/services/asg/localNetworkTransport.ts"],
    prerequisites: "CI Mac app with Call enabled through its supported iOS setting/build flag; manifest-matching paired glasses, Classic audio, hotspot internet gateway, browser peer, cleanup access and remaining authorized Call attempts.",
    exclusions: "No OTA in this routine; no Android or physical-iPhone qualification. Shared Bluetooth/transport edits require evidence they affect Call. Intended audio checks are not a claim of current physical qualification; unavailable evidence must fail.",
    definition: `${definitions}tools/mentra-e2e/MENTRA-CALL-ROUTINE.md`,
    implementation: `${definitions}tools/mentra-e2e/runner/call-routine.ts`,
    worker: `${definitions}worker/CALL-RECIPE.md`,
  }),
})

export function deviceRoutine(id) {
  if (!Object.hasOwn(DEVICE_ROUTINES, id)) throw new Error("Unsupported device routine")
  return DEVICE_ROUTINES[id]
}

export function hasRoutineLabel(pr, id) {
  return pr.labels?.some((label) => (typeof label === "string" ? label : label.name) === deviceRoutine(id).label) ?? false
}
