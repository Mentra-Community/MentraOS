// Selection guidance, not path-trigger rules or worker authorization. Coverage
// means a routine can exercise this behavior; only a completed run proves it.
const definitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/90a70edfe2fa17fd766dda3d98977555d6608a05/"
const androidDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/58483a6c729018dc9955122dd071ecefbfb8ae92/"
const pendingDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/754d527a3d6aac8ac971c600998aece203015394/"
const phoneDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/69ffd29cba268d9ef2a67ee5d1b33edb2c547b90/"
const connectedDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/e075ae89b99e2497a72338563851381e93769ff0/"
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
  // Planned nightly targets (account-miniapps, livestreamer). Their names, labels, platforms and result rows are wired
  // end to end, but each is `pending`: it has no registered automatic worker, so every request, dispatch and nightly path
  // refuses it with this exact reason. Remove `pending` only in the reviewed change that registers its worker, and add its
  // label to request-e2e-routine.yml's pull_request trigger and explicit REQUEST_ROUTINE chain in that same change.
  "account-miniapps": Object.freeze({
    label: "routine:account-miniapps", name: "Account and miniapps", platform: "ios-on-mac",
    coverage: "One combined paired-account routine: email login/logout, data export, Google SSO, exact feedback report, paired miniapps and visual incompatible tiles, with account and pairing restoration.",
    relatedPaths: ["mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/src/services/**", "mobile/assets/miniapps/**"],
    prerequisites: "CI Mac app; enrolled paired glasses fixture, the original consumer account and the Google account, with the Safari provider recording.",
    exclusions: "Sections are one routine and are never requested separately. No Android, OTA or Call coverage.",
    definition: `${pendingDefinitions}docs/ACCOUNT-MINIAPPS-ROUTINE.md`,
    implementation: `${pendingDefinitions}tools/mentra-e2e/runner/account-miniapps-routine.ts`,
    worker: `${pendingDefinitions}worker/account-miniapps.ts`,
    pending: "No automatic worker: the existing host's admitAccountMiniappsRun refuses (safari-google-provider), and no exported automatic preparation binds the request's selected Mac build and claim-bound recording evidence (the host installs its static build and records development evidence only)",
  }),
  // Registered Android nightly target: its automatic worker (worker/connected-glasses.ts, configuration kind
  // automatic-connected-glasses-worker) authenticates the request, verifies its exact selected APK and OTA manifest and
  // runs the full definition in one claimed lifecycle with claim-bound segmented recording, export and settlement.
  // Registration permits an honest attempted run; it is not qualification.
  "connected-glasses": Object.freeze({
    label: "routine:connected-glasses", name: "Connected glasses (Android)", platform: "android",
    coverage: "One combined Android routine with paired glasses on the request's selected APK: disconnect/unpair/reconnect, Bluetooth, battery report, camera settings, Wi-Fi scan and connect (C14, the observed path with the protected entry omitted between owned recording segments), gallery delivery (C9) and YouTube audio (C8), returning the original account and pairing.",
    relatedPaths: ["mobile/modules/bluetooth-sdk/**", "mobile/modules/**/android/**", "mobile/src/app/**", "mobile/src/services/**"],
    prerequisites: "CI signed Android APK and immutable OTA manifest verified against the claimed request; an enrolled Android phone with its paired glasses and existing account, and the private worker's own fixture, tool and ownership prerequisites.",
    exclusions: "Never relabelled as the Android no-glasses walkthrough; no Mac, OTA or Call coverage. C8 and C9 have no controllers yet: their steps fail by name before any input, and later unvisited steps stay not-run. C3's physical report evidence, C8 route/reference/audio and C9 capture/sync remain unverified. Registered in source; not qualified.",
    definition: `${connectedDefinitions}docs/routines/connected-glasses-brief.md`,
    implementation: `${connectedDefinitions}tools/mentra-e2e/runner/connected-glasses-routine.ts`,
    worker: `${connectedDefinitions}worker/connected-glasses.ts`,
  }),
  livestreamer: Object.freeze({
    label: "routine:livestreamer", name: "Livestreamer", platform: "ios-on-mac",
    coverage: "Stream here (WebRTC) and local RTMP start/stop from the Mentra app, observed by an owned receiver, with receiver and network cleanup.",
    relatedPaths: ["mobile/assets/miniapps/**", "mobile/src/services/**"],
    prerequisites: "CI Mac app; enrolled paired glasses and an owned local receiver.",
    exclusions: "Receiver observations alone do not qualify the routine.",
    definition: `${pendingDefinitions}docs/LIVESTREAMER-ROUTINE-BRIEF.md`,
    implementation: `${pendingDefinitions}tools/mentra-e2e/runner/livestreamer-receiver.ts`,
    worker: null,
    pending: "No automatic worker: no editable Livestreamer flow, lifecycle routine or host exists yet (only media and receiver helpers)",
  }),
  // Registered Mac Phone mode routines: one shared automatic worker (worker/phone-mode.ts) authenticates the request,
  // installs its selected Mac build and runs the complete flow with claim-bound CI evidence. Their live qualification is
  // still pending; they are not in the nightly targets, successful-build requests or any per-build default.
  "captions-phone": Object.freeze({
    label: "routine:captions-phone", name: "Captions with simulated glasses", platform: "ios-on-mac",
    coverage: "Recorded setup from Log In or Welcome (Set up without glasses → Simulated Glasses → Continue) to Phone mode (simulated glasses) Home, pinned-account Profile check, Phone microphone selection, Captions transcribing one controlled speech fixture played through the Mac, and restoration of Automatic, Home and the original host audio.",
    relatedPaths: ["mobile/assets/miniapps/com.mentra.captions-*.zip", "mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/modules/engine/src/services/**"],
    prerequisites: "CI Mac app; an enrolled Mac fixture commissioned at Phone mode Home, Welcome, the start screen or Log In for the pinned account, with pinned speech, player and audio switch tools. The selected build is installed and Phone mode is established within the claimed run.",
    exclusions: "No physical glasses, physical iPhone, Android or quantitative acoustic qualification. Entry from signed-in unpaired Home (its Setup without glasses card) is not yet observed and is refused. Registered in source; live CI qualification is still pending.",
    definition: `${phoneDefinitions}docs/routines/captions-phone.md`,
    implementation: `${phoneDefinitions}tools/mentra-e2e/flows/captions-phone.ts`,
    worker: `${phoneDefinitions}worker/phone-mode.ts`,
  }),
  "notes-phone": Object.freeze({
    label: "routine:notes-phone", name: "Notes with simulated glasses", platform: "ios-on-mac",
    coverage: "The same recorded Phone mode setup, then transcription of a controlled discussion generated with a fresh phrase for each request; exactly one new generated note found by list identity; exact title and body edits; persistence after reopening; and Search returning that note and the exact-phrase transcript.",
    relatedPaths: ["mobile/assets/miniapps/com.mentra.notes-*.zip", "mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/modules/engine/src/services/**"],
    prerequisites: "CI Mac app; an enrolled Mac fixture commissioned at Phone mode Home, Welcome, the start screen or Log In, a pinned speech synthesizer (each request's phrase, facts and audio are generated and bound before speech), and the pinned audio tools.",
    exclusions: "Preserves all transcript and note history; no deletion, physical glasses, physical iPhone or Android. Entry from signed-in unpaired Home is not yet observed and is refused. Registered in source; live CI qualification is still pending.",
    definition: `${phoneDefinitions}docs/routines/notes-phone.md`,
    implementation: `${phoneDefinitions}tools/mentra-e2e/flows/notes-phone.ts`,
    worker: `${phoneDefinitions}worker/phone-mode.ts`,
  }),
})

export function deviceRoutine(id) {
  if (!Object.hasOwn(DEVICE_ROUTINES, id)) throw new Error("Unsupported device routine")
  return DEVICE_ROUTINES[id]
}

/** Execution paths (request, dispatch and nightly) accept only a routine with a registered automatic worker. A planned
 * routine refuses with its exact pending reason. Tests may pass a catalog that models a completed registration. */
export function registeredRoutine(id, catalog = DEVICE_ROUTINES) {
  if (!Object.hasOwn(catalog, id)) throw new Error("Unsupported device routine")
  const routine = catalog[id]
  if (routine.pending) throw new Error(`Routine ${id} is planned but not registered for automatic execution: ${routine.pending}`)
  return routine
}
export const isRegisteredRoutine = (id, catalog = DEVICE_ROUTINES) => Object.hasOwn(catalog, id) && !catalog[id].pending

export function hasRoutineLabel(pr, id) {
  return pr.labels?.some((label) => (typeof label === "string" ? label : label.name) === deviceRoutine(id).label) ?? false
}
