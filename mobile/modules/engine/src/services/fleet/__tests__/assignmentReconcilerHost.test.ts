/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import "../../__tests__/reactNativeTestMock"
import type {AssignmentReconcilerDeps, ManagedMiniappPort} from "../assignmentReconciler"

let versions: string[] = []
let activeVersion: string | null = null
const identities = new Map<string, {bundleSha256?: string}>()
let port: ManagedMiniappPort | null = null

mock.module("@react-native-community/netinfo", () => ({default: {addEventListener: () => () => {}}}))
mock.module("../../../utils/timers", () => ({BgTimer: {setTimeout: () => 0, clearTimeout: () => {}}}))
mock.module("../../AppRegistry", () => ({
  default: {
    getInstalledVersions: () => versions,
    getActiveReleaseVersion: () => activeVersion,
    getReleaseIdentity: (_pkg: string, version: string) => identities.get(version) ?? null,
  },
}))
mock.module("../../CloudClientService", () => ({
  cloudClientService: {
    getCoreSession: () => ({coreUrl: "https://core.mentra.glass", mentraUserId: "mu_1"}),
    hasCore: () => true,
    onCoreSessionChanged: () => () => {},
  },
}))
mock.module("../../miniappDataPartition", () => ({setFleetWorkspace: () => {}}))
mock.module("../../MiniappLauncher", () => ({miniappLauncher: {isRunning: () => false}}))
mock.module("../../miniappReleaseInstall", () => ({
  classifyManagedInstallError: () => ({kind: "download_failed", retryable: true}),
  installManagedMiniapp: async () => {},
  stopMiniappForRevocation: async () => {},
  uninstallManagedMiniapp: async () => {},
}))
mock.module("../../miniappUrlResolution", () => ({resolveMiniappUrl: async () => ({ok: false})}))
mock.module("../../runningUpdatePrompt", () => ({
  dismissRunningUpdatePrompt: () => {},
  onRunningUpdatePromptDue: () => () => {},
}))
mock.module("../assignmentReconciler", () => ({
  createAssignmentReconciler: (deps: AssignmentReconcilerDeps) => {
    port = deps.miniapps
    return {trigger: () => {}, sessionChanged: () => {}, stop: () => {}}
  },
}))
mock.module("../fleetRevisionSignal", () => ({emitAssignmentOutcome: () => {}, onFleetRevision: () => () => {}}))
mock.module("../fleetManagementState", () => ({setFleetManagementState: () => {}}))
mock.module("../fleetStorage", () => ({getFleetStore: () => ({})}))

const {startAssignmentReconciler, stopAssignmentReconciler} = await import("../assignmentReconcilerHost")
const {miniappContextRegistry, miniappRunningRegistry} = await import("../../MiniappRunningRegistry")

const pkg = "com.acme.notes"

beforeEach(() => {
  stopAssignmentReconciler()
  port = null
  versions = []
  activeVersion = null
  identities.clear()
  startAssignmentReconciler({fetch: async () => ({}) as never})
})

describe("the Fleet host's miniapp port", () => {
  test("compares an assignment with the active installed release, not the newest one on disk", async () => {
    versions = ["1.0.0", "1.2.0"]
    activeVersion = "1.0.0"
    identities.set("1.0.0", {bundleSha256: "a".repeat(64)})
    expect(await port!.installedRelease(pkg)).toEqual({version: "1.0.0", bundleSha256: "a".repeat(64)})
    activeVersion = null
    expect(await port!.installedRelease(pkg)).toBeNull()
  })

  test("hears the stop of every context, a hidden one too", () => {
    const stopped: string[] = []
    const unsubscribe = port!.onStopped((packageName) => stopped.push(packageName))
    miniappContextRegistry.add(pkg)
    miniappContextRegistry.remove(pkg)
    miniappContextRegistry.add("com.acme.shown")
    miniappRunningRegistry.add("com.acme.shown")
    miniappRunningRegistry.remove("com.acme.shown")
    miniappContextRegistry.remove("com.acme.shown")
    unsubscribe()
    miniappContextRegistry.add(pkg)
    miniappContextRegistry.remove(pkg)
    expect(stopped).toEqual([pkg, "com.acme.shown"])
  })
})
