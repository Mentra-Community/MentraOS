// Selection guidance, not path-trigger rules or worker authorization. Coverage
// means a routine can exercise this behavior; only a completed run proves it.
const definitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/90a70edfe2fa17fd766dda3d98977555d6608a05/"
const foundationDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/bcc58134351705f0b6e0b87ed7bfaeb2672ba058/"
const livestreamerDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/29d46391aaee46648d5871a5b9666de26414aad0/"
const connectedDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/6215c390f081d2ba8e93a3bb3b149813a5d81d80/"
const accountDefinitions = "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/11b98bed9efb2b414ad912074888c58aeea2e6df/"
export const DEVICE_ROUTINES = Object.freeze({
  "ota-roundtrip-android": Object.freeze({
    label: "routine:ota-roundtrip-android", name: "Android OTA roundtrip", platform: "android",
    coverage: "Shared foundation establishes the requested dev app and glasses firmware, downgrades ASG through normal app controls to immutable production, and returns to exact requested ASG while preserving gallery and independently verifying firmware return.",
    relatedPaths: ["asg_client/**", "mobile/modules/bluetooth-sdk/**", "mobile/modules/engine/**", "mobile/src/services/ota*"],
    prerequisites: "An enrolled Android phone and physical Mentra Live pair, reserved account, immutable production firmware, and matching requested dev app/firmware. Authenticated dev independent nightly only; local staging qualification is not a nightly pass.",
    exclusions: "No BES/MTK downgrade, injected transport failure, physical iPhone, staging nightly or PR/build automatic enrollment.",
    definition: "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/ab3523e3631e1b89d625314686f48c608f294cca/docs/routines/ota-roundtrip-android.md",
    implementation: "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/ab3523e3631e1b89d625314686f48c608f294cca/tools/mentra-e2e/flows/ota-roundtrip-android.ts",
    worker: "https://github.com/Mentra-Community/Mentra-Automated-Testing/blob/ab3523e3631e1b89d625314686f48c608f294cca/worker/foundation-worker.ts",
  }),
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
    prerequisites: "CI Mac app; enrolled unpaired fixture and existing test account. Shared setup establishes its entry; teardown verifies the app and recorder are stopped.",
    exclusions: "No actual account creation, recovery email or credential changes; no connected glasses, Phone Mode, camera/media streaming, Android-only behavior or translated-locale qualification. A changed mobile path alone is insufficient.",
    definition: `${foundationDefinitions}tools/mentra-e2e/COMPILED-ROUTINE.md`,
    implementation: `${foundationDefinitions}tools/mentra-e2e/flows/no-glasses.ts`,
    worker: `${foundationDefinitions}worker/foundation-worker.ts`,
  }),
  "no-glasses-android": Object.freeze({
    label: "routine:no-glasses-android", name: "Android no-glasses UI", platform: "android",
    coverage: "Signed-in English unpaired Home, All Apps search, Settings and account forms without submitting, miniapp switcher and local glasses-required dialogs; recorded Android steps and verified app return state.",
    relatedPaths: ["mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/app.config.ts", "mobile/modules/**/android/**"],
    prerequisites: "CI signed Android APK and immutable OTA manifest; enrolled Android phone with its own existing test account and no paired glasses.",
    exclusions: "No login/logout, onboarding, permission changes, pairing, connected glasses, OTA, Call, acoustic qualification or physical-iPhone coverage. Mac and Android results are independent; local development passes do not qualify a new CI request.",
    definition: `${foundationDefinitions}tools/mentra-e2e/ANDROID-NO-GLASSES-ROUTINE.md`,
    implementation: `${foundationDefinitions}tools/mentra-e2e/runner/android-walkthrough.ts`,
    worker: `${foundationDefinitions}worker/foundation-worker.ts`,
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
  // Registered Mac nightly target: its automatic worker (worker/account-miniapps.ts, configuration kind
  // automatic-account-miniapps-worker) authenticates the request, verifies its exact selected Mac build and OTA manifest,
  // binds the reviewed host of the selected app backend (dev or staging) and runs the full definition in one claimed
  // lifecycle with claim-bound recording, export and settlement. Registration permits an honest attempted run; it is
  // not qualification.
  "account-miniapps": Object.freeze({
    label: "routine:account-miniapps", name: "Account and miniapps", platform: "ios-on-mac",
    coverage: "One combined paired-account routine on the request's selected Mac build: email login/logout, data export, Google SSO, exact feedback report, paired miniapps and visual incompatible tiles, with account and pairing restoration.",
    relatedPaths: ["mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/src/services/**", "mobile/assets/miniapps/**"],
    prerequisites: "CI Mac app and immutable OTA manifest verified against the claimed request, on a dev or staging backend with its own reviewed worker host; the private lifecycle's recorded original account and paired glasses fixture, the Google account and the Safari provider recording, and the private worker's own fixture, credential and ownership prerequisites.",
    exclusions: "Sections are one routine and are never requested separately. No Android, OTA or Call coverage. The owned Safari Google provider completion, its Mentra callback and the selected provider window's close are unqualified, and no real eligible customer completion has been observed: those cases report failed or blocked results when unobserved. Registered in source; not qualified.",
    definition: `${accountDefinitions}docs/ACCOUNT-MINIAPPS-ROUTINE.md`,
    implementation: `${accountDefinitions}tools/mentra-e2e/runner/account-miniapps-routine.ts`,
    worker: `${accountDefinitions}worker/account-miniapps.ts`,
  }),
  // The shared foundation runs the same saved Android software flow used in authoring.
  // Its local passing example does not qualify a new dispatched build or acoustic measurements.
  "connected-glasses": Object.freeze({
    label: "routine:connected-glasses", name: "Connected glasses (Android)", platform: "android",
    coverage: "Pair, disconnect, unpair and reconnect Mentra Live; check battery, Bluetooth, Wi-Fi and camera settings; capture and sync a photo and bounded video; verify delivered bytes decode and media playback routing and pause.",
    relatedPaths: ["mobile/modules/bluetooth-sdk/**", "mobile/modules/**/android/**", "mobile/src/app/**", "mobile/src/services/**"],
    prerequisites: "The request's signed Android APK and matching immutable firmware manifest; an enrolled Android phone and Mentra Live pair with verified identity, dedicated test account, declared Wi-Fi network and pinned reference video. Shared setup installs the requested build and establishes its entry.",
    exclusions: "Measured speaker or microphone audio, visual scene recognition, physical action-button behavior, firmware updates, Mac and physical iPhone behavior. No operator button presses are required. Local software qualification does not qualify a new CI request.",
    definition: `${connectedDefinitions}docs/routines/connected-glasses-brief.md`,
    implementation: `${connectedDefinitions}tools/mentra-e2e/flows/connected-glasses.ts`,
    worker: `${connectedDefinitions}worker/foundation-worker.ts`,
  }),
  // Registered nightly target: its automatic worker (worker/livestreamer.ts, configuration kind
  // automatic-livestreamer-worker) authenticates the request, binds its selected Mac build and runs the one claimed
  // lifecycle with claim-bound CI evidence. Preparation still refuses before any claim while its physical
  // observations are missing; live qualification is pending.
  livestreamer: Object.freeze({
    label: "routine:livestreamer", name: "Livestreamer", platform: "ios-on-mac",
    coverage: "One routine on the request's selected Mac build with paired glasses: managed Stream Here (WebRTC) started and stopped once, observed by an owned viewer of the run's own Share URL (decoded progression, live to offline), and a local Custom RTMP stream to an owned local receiver over the glasses hotspot, each stopped through its normal control with recordings verified; then network, receiver and UI restored and the selected app, original account and paired Home verified.",
    relatedPaths: ["mobile/assets/miniapps/**", "mobile/src/services/**"],
    prerequisites: "CI Mac app installed from the claimed request's selected build; an enrolled paired-glasses Mac fixture with its pinned ADB, firmware and account; the host's pinned native snapshots of every observed Livestreamer state and an observed owned Stream Here Share URL (managed watch binding) on that build; the pinned local receiver and glasses-hotspot network; normal return custody of the app, glasses, receiver and network. Preparation refuses before any claim while an observation is missing.",
    exclusions: "No Android, physical iPhone, OTA or Call coverage. Receiver or viewer observations alone do not qualify it. Registered in source; the managed-viewer and state observations and live qualification are still pending.",
    definition: `${livestreamerDefinitions}docs/LIVESTREAMER-FULL-ROUTINE.md`,
    implementation: `${livestreamerDefinitions}tools/mentra-e2e/flows/livestreamer.ts`,
    worker: `${livestreamerDefinitions}worker/livestreamer.ts`,
  }),
  // Registered Mac Phone mode routines: one shared automatic worker (worker/phone-mode.ts) authenticates the request,
  // installs its selected Mac build and runs the complete flow with claim-bound CI evidence. Their live qualification is
  // still requires real claim-bound runs; trigger registration does not prove qualification.
  "captions-phone": Object.freeze({
    label: "routine:captions-phone", name: "Captions with simulated glasses", platform: "ios-on-mac",
    coverage: "Selected build and pinned-account setup establish Phone mode and Phone microphone input; Captions transcribes controlled speech. Shared teardown restores owned audio resources and verifies the app is stopped.",
    relatedPaths: ["mobile/assets/miniapps/com.mentra.captions-*.zip", "mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/modules/engine/src/services/**"],
    prerequisites: "CI Mac app; an available enrolled Mac lane, pinned test account, speech, player, audio switch tools and exact input/output/system audio UIDs. Claimed setup establishes its own entry rather than requiring precommissioned Phone Home.",
    exclusions: "No physical glasses, physical iPhone, Android or quantitative acoustic qualification. Trigger registration and development examples do not qualify a new CI request.",
    definition: `${foundationDefinitions}docs/routines/captions-phone.md`,
    implementation: `${foundationDefinitions}tools/mentra-e2e/flows/captions-phone.ts`,
    worker: `${foundationDefinitions}worker/foundation-worker.ts`,
  }),
  "notes-phone": Object.freeze({
    label: "routine:notes-phone", name: "Notes with simulated glasses", platform: "ios-on-mac",
    coverage: "The same recorded Phone mode setup, then transcription of a controlled discussion generated with a fresh phrase for each request; exactly one new generated note found by list identity; exact title and body edits; persistence after reopening; and Search returning that note and the exact-phrase transcript.",
    relatedPaths: ["mobile/assets/miniapps/com.mentra.notes-*.zip", "mobile/src/app/**", "mobile/src/components/**", "mobile/src/stores/**", "mobile/modules/engine/src/services/**"],
    prerequisites: "CI Mac app; an available enrolled Mac lane, pinned test account, speech synthesizer, exact audio endpoint UIDs and an exclusively allocated empty transcript day. Shared setup and teardown own this run's data and audio resources.",
    exclusions: "No deletion of unrelated account history, physical glasses, physical iPhone or Android. Run-owned Notes and transcripts are cleaned; teardown verifies the app is stopped rather than requiring Phone Home. Development examples do not qualify a new CI request.",
    definition: `${foundationDefinitions}docs/routines/notes-phone.md`,
    implementation: `${foundationDefinitions}tools/mentra-e2e/flows/notes-phone.ts`,
    worker: `${foundationDefinitions}worker/foundation-worker.ts`,
  }),
})

export function deviceRoutine(id) {
  if (!Object.hasOwn(DEVICE_ROUTINES, id)) throw new Error("Unsupported device routine")
  return DEVICE_ROUTINES[id]
}

export const AUTOMATIC_BUILD_ROUTINES = Object.freeze(["no-glasses", "no-glasses-android", "captions-phone", "notes-phone"])

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
