/// <reference types="bun-types" />

import {mock} from "bun:test"

/**
 * One CloudClientService stub for the whole bun process. Same reason as
 * `bluetoothSdkTestMock`: replacing the factory deletes methods other suites
 * installed on a different object.
 */
export const cloudClientService: Record<string, unknown> = {
  hasAudioSubscriptions: () => true,
  isConnected: () => true,
  sendAudioFrame: mock(() => {}),
  startManagedPhoto: mock(async () => ({})),
  awaitManagedPhotoReady: mock(async () => ({})),
  core: {supportProfile: {update: mock(async () => ({status: "accepted"}))}},
}

mock.module("../CloudClientService", () => ({
  cloudClientService,
}))
