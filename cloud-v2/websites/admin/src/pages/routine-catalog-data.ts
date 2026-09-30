import type { TestRoutineId } from "../../../../packages/core/src/types/test-dispatch.types";

export interface CatalogRoutine {
  id: TestRoutineId;
  name: string;
  platform: "iOS on Mac" | "Android";
  purpose: string;
  requirements: { software: string; account: string; network: string; physical: string; data: string };
  cleanup: string;
  exclusions: string;
  passingRun: {
    id: string;
    recordedOn: string;
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
const macBuild = {
  recordedOn: "2026-09-30", release: "3.3.0-dev.468", appVersion: "3.3.0", appBuild: "303000084",
  appSha: "d6c74c857015fac95fbc6195dbf009acfab65eeb", fixture: "mini-ui-unpaired", device: "Mac",
};
const macSoftware = "The selected Mentra App build for iOS on Mac, in English. The worker installs the build and signs in before the test.";
const testAccount = "An existing, dedicated test account for the selected app backend. The worker holds its credentials.";
const phonePhysical = "A reserved Mac with microphone permission, declared input and speaker routes, and the worker’s audio tools. Keep the speaker and microphone path unobstructed.";

export const ROUTINE_CATALOG: readonly CatalogRoutine[] = [
  {
    id: "no-glasses", name: "App navigation without glasses", platform: "iOS on Mac",
    purpose: "Check Home, All Apps search, Settings and account forms, glasses-required messages, sign-out, sign-in and relaunch.",
    requirements: {
      software: macSoftware, account: testAccount,
      network: "Internet access to the selected app backend, sign-in and miniapp services.",
      physical: "A reserved Mac with UI automation and screen-recording permission. No glasses paired; the worker establishes unpaired Home.",
      data: "Fixed search text and the existing test account. Account forms are opened without changing credentials or submitting feedback.",
    },
    cleanup: "Finish the recording, stop the Mentra App and verify that the app and recorder have stopped.",
    exclusions: "Connected glasses, firmware updates, Phone mode, media streaming, Android and physical iPhone behavior.",
    passingRun: { ...macBuild, id: "local-ios-on-mac-a16fdb2f-4188-4415-827f-188b8c7019bb" },
  },
  {
    id: "no-glasses-android", name: "App navigation without glasses", platform: "Android",
    purpose: "Check Home, All Apps search, Settings, account forms, Feedback navigation, the miniapp switcher and glasses-required messages.",
    requirements: {
      software: "The selected signed Android APK, in English, on an enrolled Android 13 or later test phone. The worker installs it and establishes signed-in Home.",
      account: testAccount,
      network: "Internet access to the selected app backend, sign-in and miniapp services.",
      physical: "A dedicated USB-connected phone with authorized ADB access, available screen recording and no paired glasses. The run clears this test app’s data.",
      data: "Fixed search text and the existing test account. Account and feedback forms are inspected without submitting changes.",
    },
    cleanup: "Finish the recording, clear the owned test app’s data and force-stop it; verify that both the app and recorder have stopped.",
    exclusions: "Sign-out and authentication walkthrough assertions, permission changes, pairing, firmware updates, audio and physical iPhone behavior.",
    passingRun: { ...macBuild, id: "local-android-c0d4c2a6-b415-4939-982e-1ae02b387bbe", appBuild: "310000290",
      fixture: "mini-samsung-a54", device: "Samsung Galaxy A54" },
  },
  {
    id: "captions-phone", name: "Captions with simulated glasses", platform: "iOS on Mac",
    purpose: "Play a controlled speech sample and verify that both expected sentences appear in the actual Captions transcript.",
    requirements: {
      software: `${macSoftware} Captions must be available; setup selects simulated glasses and the Phone microphone.`,
      account: testAccount,
      network: "Internet access to sign-in, miniapp and transcription services for the selected backend.",
      physical: phonePhysical,
      data: "The worker’s pinned speech recording and its two expected sentences. No live speaker is required.",
    },
    cleanup: "Close the owned miniapp, restore Automatic microphone selection and the original host audio routes, volume and mute state; stop the managed app.",
    exclusions: "Physical glasses, Android, physical iPhone behavior and measured acoustic quality.",
    passingRun: { ...macBuild, id: "local-ios-on-mac-a28e899b-2632-419c-b221-2df38870438a" },
  },
  {
    id: "notes-phone", name: "Notes with simulated glasses", platform: "iOS on Mac",
    purpose: "Transcribe a controlled discussion, find its automatically generated note, edit the title and body, then verify persistence and search.",
    requirements: {
      software: `${macSoftware} Notes must be available; setup selects simulated glasses and the Phone microphone.`,
      account: "A dedicated test account with Notes access and permission to clean up only this run’s transcript, conversation and note. Existing notes and conversations are preserved.",
      network: "Internet access to sign-in, transcription, Notes and note-generation services for the selected backend.",
      physical: phonePhysical,
      data: "An explicitly allocated, initially empty Today transcript and the worker’s discussion fixture, with a fresh phrase and known facts. Existing note and conversation identities are recorded before speech.",
    },
    cleanup: "Stop transcription, remove the owned day, conversation and new note, and verify existing data is unchanged. Restore microphone and host audio settings; stop the managed app.",
    exclusions: "Manual note generation as a substitute for automatic creation, physical glasses, Android, physical iPhone behavior and measured acoustic quality.",
    passingRun: { ...macBuild, id: "local-ios-on-mac-77e10ae9-ecca-4fbc-b2e9-d6fe1529f7cb" },
  },
];

export const CATALOG_ROUTINE_IDS = ROUTINE_CATALOG.map(routine => routine.id);

/** Examples are stored in dev Core even when this catalog is viewed in another environment. */
export function catalogPassingRunHref(run: CatalogRoutine["passingRun"]): string {
  return `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(run.id)}`;
}
