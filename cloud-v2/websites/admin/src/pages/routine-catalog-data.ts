import type { TestRoutineId } from "../../../../packages/core/src/types/test-dispatch.types";

export interface CatalogRoutine {
  id: TestRoutineId | "ota-roundtrip-android" | "open-close-miniapps";
  request?: { routineId: TestRoutineId };
  name: string;
  platform: "iOS on Mac" | "Android";
  purpose: string;
  requirements: { software: string; firmware: string; account: string; network: string; physical: string; data: string };
  cleanup: string;
  exclusions: string;
  passingRun: {
    id: string;
    recordedOn: string;
    suiteId?: string;
    release: string;
    appVersion: string;
    appBuild: string;
    appSha: string;
    fixture: string;
    device: string;
  };
}

// Curated full runs on the shared foundation, not the broader dispatch registry.
// Add a platform only after checking its result, recording and lifecycle outcomes.
// Maintenance instructions: cloud-v2/docs/runbooks/testing/routine-catalog.md.
const nightlyBuild = {
  recordedOn: "2026-10-01", release: "3.3.0-dev.551", appVersion: "3.3.0",
  appSha: "f48a6c59f06665dd41924670434f47d359be0eb3", suiteId: "nightly-36957839762-1-dev",
};
const macBuild = { ...nightlyBuild, appBuild: "303000125", fixture: "mini-ui-unpaired", device: "Mac" };
const macSoftware = "The selected Mentra App build for iOS on Mac, in English. The worker installs the build and signs in before the test.";
const testAccount = "An existing, dedicated test account for the selected app backend. The worker holds its credentials.";
const noFirmware = "No physical glasses or glasses firmware required or qualified.";
const phonePhysical = "A reserved Mac with microphone permission, declared input and speaker routes, and the worker’s audio tools. Keep the speaker and microphone path unobstructed.";

export const ROUTINE_CATALOG: readonly CatalogRoutine[] = [
  {
    id: "ota-roundtrip-android", name: "Glasses software downgrade / upgrade loop on hotspot", platform: "Android",
    purpose: "Downgrade the glasses' ASG software to the configured published baseline through the Mentra App over the glasses hotspot, then upgrade back to the exact requested build and verify stable paired Home.",
    requirements: {
      software: "The frozen requested Android APK and its matching OTA manifest, in English. Shared setup installs the app, signs in, pairs the assigned glasses and establishes the requested firmware before recording.",
      firmware: "An enrolled physical Mentra Live pair with independently verified hardware identity. Pin the requested ASG APK and configured older baseline manifest and APK. Newer BES and MTK firmware intentionally remain installed and are checked throughout.",
      account: testAccount,
      network: "Internet access to the selected app backend, sign-in services and both immutable OTA download URLs. The phone connects to the glasses hotspot to transfer each update; keep both devices connected during both updates.",
      physical: "One reserved USB-connected Android phone and one reserved Mentra Live pair with authorized ADB diagnostics, Bluetooth pairing and screen recording. The passing example uses the Mac Mini's Samsung Galaxy A54 lane.",
      data: "The existing glasses gallery is hashed before the run and must remain unchanged at every checkpoint. Start and return use the same requested ASG version and APK hash; no rolling latest manifest is selected.",
    },
    cleanup: "Finalize the recording, remove owned app data and overrides, stop the app and release owned resources once firmware writers are idle. Cleanup never starts an update or waits for a version reply. A firmware mismatch remains a failed result; the next setup establishes its requested software.",
    exclusions: "Updates over an external Wi-Fi network (a separate future routine), BES or MTK downgrade, injected network failures, the persistent no-internet Retry scenario, physical iPhone behavior, and qualification of other builds.",
    passingRun: {
      ...nightlyBuild, id: "routine-36957913879-1-dev-ota-roundtrip-android", appBuild: "310000349",
      fixture: "mini-060b", device: "Samsung Galaxy A54",
    },
  },
  {
    id: "no-glasses", request: { routineId: "no-glasses" }, name: "App navigation without glasses", platform: "iOS on Mac",
    purpose: "Check Home, All Apps search, Settings and account forms, glasses-required messages, sign-out, sign-in and relaunch.",
    requirements: {
      software: macSoftware, firmware: noFirmware, account: testAccount,
      network: "Internet access to the selected app backend, sign-in and miniapp services.",
      physical: "A reserved Mac with UI automation and screen-recording permission. No glasses paired; the worker establishes unpaired Home.",
      data: "Fixed search text and the existing test account. Account forms are opened without changing credentials or submitting feedback.",
    },
    cleanup: "Finish the recording, stop the Mentra App and verify that the app and recorder have stopped.",
    exclusions: "Connected glasses, firmware updates, Phone mode, media streaming, Android and physical iPhone behavior.",
    passingRun: { ...macBuild, id: "routine-36957913744-1-dev-no-glasses" },
  },
  {
    id: "no-glasses-android", request: { routineId: "no-glasses-android" }, name: "App navigation without glasses", platform: "Android",
    purpose: "Check Home, All Apps search, Settings, account forms, Feedback navigation, the miniapp switcher and glasses-required messages.",
    requirements: {
      software: "The selected signed Android APK, in English, on an enrolled Android 13 or later test phone. The worker installs it and establishes signed-in Home.",
      firmware: noFirmware,
      account: testAccount,
      network: "Internet access to the selected app backend, sign-in and miniapp services.",
      physical: "A dedicated USB-connected phone with authorized ADB access, available screen recording and no paired glasses. The run clears this test app’s data.",
      data: "Fixed search text and the existing test account. Account and feedback forms are inspected without submitting changes.",
    },
    cleanup: "Finish the recording, clear the owned test app’s data and force-stop it; verify that both the app and recorder have stopped.",
    exclusions: "Sign-out and authentication walkthrough assertions, permission changes, pairing, firmware updates, audio and physical iPhone behavior.",
    passingRun: { ...macBuild, id: "routine-36957913815-1-dev-no-glasses-android", appBuild: "310000349",
      fixture: "mini-samsung-a54", device: "Samsung Galaxy A54" },
  },
  {
    id: "captions-phone", request: { routineId: "captions-phone" }, name: "Captions with simulated glasses", platform: "iOS on Mac",
    purpose: "Play a controlled speech sample and verify that both expected sentences appear in the actual Captions transcript.",
    requirements: {
      software: `${macSoftware} Captions must be available; setup selects simulated glasses and the Phone microphone.`,
      firmware: noFirmware,
      account: testAccount,
      network: "Internet access to sign-in, miniapp and transcription services for the selected backend.",
      physical: phonePhysical,
      data: "The worker’s pinned speech recording and its two expected sentences. No live speaker is required.",
    },
    cleanup: "Close the owned miniapp, restore Automatic microphone selection and the original host audio routes, volume and mute state; stop the managed app.",
    exclusions: "Physical glasses, Android, physical iPhone behavior and measured acoustic quality.",
    passingRun: { ...macBuild, id: "routine-36957913823-1-dev-captions-phone" },
  },
  {
    id: "connected-glasses", name: "Connected glasses", platform: "Android",
    purpose: "Pair, disconnect, unpair and reconnect Mentra Live; check battery, Bluetooth, Wi-Fi and camera settings; capture and sync a photo and video; verify media playback routing and pause.",
    requirements: {
      software: "The selected signed Android APK, in English. Shared setup installs the app and signs in before the recorded flow starts from unpaired Home.",
      firmware: "One enrolled Mentra Live pair with its requested starting software and independently verified identity. This routine does not perform a firmware update.",
      account: testAccount,
      network: "Internet for sign-in and the pinned reference video, plus a declared Wi-Fi network the glasses can join. Gallery transfer uses the glasses hotspot.",
      physical: "A reserved USB-connected Android phone and Mentra Live pair with authorized ADB access, Bluetooth and screen recording. No operator button presses are required.",
      data: "Pinned reference video, declared camera settings and fresh capture request IDs. Record existing gallery files and settings before changing them; verify delivered photo and video bytes match the glasses originals and decode.",
    },
    cleanup: "Stop owned playback and recording, remove this run’s captures and downloaded media, restore changed settings, stop the managed app and release the phone and glasses. Publish evidence before disposing of local run files.",
    exclusions: "Measured speaker or microphone audio, visual scene recognition, physical action-button behavior, firmware updates, other glasses models and CI/nightly qualification. The recording briefly pauses while entering the private Wi-Fi password.",
    passingRun: {
      id: "local-android-a061de4c-2407-4a28-985d-bd9482c11569", recordedOn: "2026-10-02",
      release: "3.3.0-dev.559", appVersion: "3.3.0", appBuild: "310000352",
      appSha: "f85d8361b59a7592775bb44582d64b8d82dc8689", fixture: "mini-03be", device: "Samsung Galaxy A54",
    },
  },
  {
    id: "notes-phone", request: { routineId: "notes-phone" }, name: "Notes with simulated glasses", platform: "iOS on Mac",
    purpose: "Transcribe a controlled discussion, find its automatically generated note, edit the title and body, then verify persistence and search.",
    requirements: {
      software: `${macSoftware} Notes must be available; setup selects simulated glasses and the Phone microphone.`,
      firmware: noFirmware,
      account: "A dedicated test account with Notes access and permission to clean up only this run’s transcript, conversation and note. Existing notes and conversations are preserved.",
      network: "Internet access to sign-in, transcription, Notes and note-generation services for the selected backend.",
      physical: phonePhysical,
      data: "An explicitly allocated, initially empty Today transcript and the worker’s discussion fixture, with a fresh phrase and known facts. Existing note and conversation identities are recorded before speech.",
    },
    cleanup: "Stop transcription, remove the owned day, conversation and new note, and verify existing data is unchanged. Restore microphone and host audio settings; stop the managed app.",
    exclusions: "Manual note generation as a substitute for automatic creation, physical glasses, Android, physical iPhone behavior and measured acoustic quality.",
    passingRun: {
      id: "local-ios-on-mac-d5891059-4483-44c2-aac5-77b34441e95b", recordedOn: "2026-10-02",
      release: "3.3.0-dev.559", appVersion: "3.3.0", appBuild: "303000128",
      appSha: "f85d8361b59a7592775bb44582d64b8d82dc8689", fixture: "mini-ui-unpaired", device: "Mac",
    },
  },
  {
    id: "open-close-miniapps", name: "Open, resume and close Gallery", platform: "Android",
    purpose: "Open Gallery, minimize it, confirm it remains running, resume it, close it and verify it is stopped from Home.",
    requirements: {
      software: "The selected signed Android APK, in English, with Gallery available. Shared setup installs the app, signs in and establishes paired Home.",
      firmware: "An enrolled Mentra Live pair with verified identity and the requested starting software. This routine does not update firmware.",
      account: testAccount,
      network: "Internet access to the selected backend, sign-in and miniapp services.",
      physical: "A reserved USB-connected Android phone and Mentra Live pair, with authorized ADB access and screen recording. No operator input is required.",
      data: "Existing gallery contents are preserved. No new photo, video or seeded media is required for these lifecycle checks.",
    },
    cleanup: "Close the owned miniapp, restore changed settings, stop the managed app and recorder, and release owned resources. Publish evidence before disposing of local run files.",
    exclusions: "Photo or video capture, media synchronization, scene verification, other miniapps, other platforms and registered dispatch qualification.",
    passingRun: {
      id: "local-android-5fe92a2e-2807-4f15-8d9e-5f4faf7b3cdc", recordedOn: "2026-10-02",
      release: "3.3.0-dev.559", appVersion: "3.3.0", appBuild: "310000352",
      appSha: "f85d8361b59a7592775bb44582d64b8d82dc8689", fixture: "mini-03be", device: "Samsung Galaxy A54",
    },
  },
];

export const CATALOG_ROUTINE_IDS = ROUTINE_CATALOG.map(routine => routine.id);
export const CATALOG_REQUEST_ROUTINE_IDS = ROUTINE_CATALOG.flatMap(routine => routine.request ? [routine.request.routineId] : []);

/** Examples are stored in dev Core even when this catalog is viewed in another environment. */
export function catalogPassingRunHref(run: CatalogRoutine["passingRun"]): string {
  return `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(run.id)}`;
}
