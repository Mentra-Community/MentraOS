/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

import "../../__tests__/reactNativeTestMock"
import type {InstallMiniappOptions, InstallMiniappResult} from "../../installMiniapp"
import type {AssignmentReconcilerDeps, ManagedAssignment, ManagedMiniappPort} from "../assignmentReconciler"

let versions: string[] = []
let activeVersion: string | null = null
const identities = new Map<string, {bundleSha256?: string}>()
let port: ManagedMiniappPort | null = null
const checked: unknown[] = []
const installs: Array<{url: string; options: InstallMiniappOptions}> = []
let installAnswer: () => Promise<InstallMiniappResult>

mock.module("../../../runtime/bootstrap", () => ({
  isInstalledMiniappAllowed: (_pkg: string, _version: string, identity: {source: string}, context: unknown) => {
    checked.push({identity, context})
    return identity.source !== "url"
  },
}))

class FakeInstallMiniappError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}
class FakeRunningError extends Error {}
mock.module("../../installMiniapp", () => ({
  InstallMiniappError: FakeInstallMiniappError,
  installMiniapp: (url: string, options: InstallMiniappOptions) => {
    installs.push({url, options})
    return installAnswer()
  },
}))
mock.module("../../../utils/storeInstallRuntime", () => ({MiniappRunningError: FakeRunningError}))

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
  // The installer's own classification, as far as these tests need it.
  classifyManagedInstallError: (error: unknown) =>
    error instanceof FakeRunningError
      ? {kind: "running", retryable: true}
      : /ENOSPC/.test(String(error))
        ? {kind: "storage_full", retryable: true}
        : {kind: "download_failed", retryable: true},
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

const {classifyAssignmentInstallError, startAssignmentReconciler, stopAssignmentReconciler} = await import(
  "../assignmentReconcilerHost"
)
const {miniappContextRegistry, miniappRunningRegistry} = await import("../../MiniappRunningRegistry")

const pkg = "com.acme.notes"

beforeEach(() => {
  stopAssignmentReconciler()
  port = null
  versions = []
  activeVersion = null
  identities.clear()
  checked.length = 0
  installs.length = 0
  installAnswer = async () => ({status: "installed", packageName: pkg, version: "1.2.0"})
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

  test("asks the deployment's policy about the release the phone would run, as the assignment's", () => {
    const sha = "b".repeat(64)
    const url = "https://Notes.Acme.com/app"
    expect(port!.allowsRelease(pkg, "1.0.0", sha, url)).toBe(false)
    versions = ["1.0.0"]
    identities.set("1.0.0", {source: "deployment_manifest", bundleSha256: sha} as never)
    expect(port!.allowsRelease(pkg, "1.0.0", sha, url)).toBe(true)
    expect(port!.allowsRelease(pkg, "1.0.0", "d".repeat(64), url)).toBe(false)
    const fromUrl = (bundleSha256: string) => ({source: "url", sourceUrl: "https://notes.acme.com/app/", bundleSha256})
    expect(checked).toEqual([
      {identity: fromUrl(sha), context: {assigned: true}},
      {identity: {source: "deployment_manifest", bundleSha256: sha}, context: {assigned: true}},
      {identity: fromUrl("d".repeat(64)), context: {assigned: true}},
    ])
  })

  const resolution = {
    ok: true as const,
    packageName: pkg,
    version: "1.2.0",
    bundleUrl: "https://notes.acme.com/app/notes.zip",
    bundleSha256: "c".repeat(64),
  }
  const assignment: ManagedAssignment = {
    assignmentId: "asg_1",
    assignmentRevision: 2,
    workspaceId: "ws_A",
    coreUrl: "https://core.mentra.glass",
    mentraUserId: "mu_1",
    url: "https://notes.acme.com/app/",
  }

  test("installs an assignment headlessly through installMiniapp, for the package it resolved", async () => {
    const isCancelled = () => false
    const onAsking = () => {}
    expect(await port!.install({resolution, assignment, isCancelled, onAsking})).toEqual({version: "1.2.0"})
    expect(installs).toHaveLength(1)
    expect(installs[0]!.url).toBe(assignment.url)
    expect(installs[0]!.options).toEqual({
      source: "assignment",
      assignment,
      expectedPackageName: pkg,
      isCancelled,
      onAsking,
    })
    // No install sheet.
    expect("confirm" in installs[0]!.options).toBe(false)
  })

  test("an install that waits for a running miniapp, or keeps a newer release, commits nothing", async () => {
    installAnswer = async () => ({status: "deferred", packageName: pkg, version: "1.0.0"})
    const deferred = await port!.install({resolution, assignment, isCancelled: () => false}).catch((error) => error)
    expect(port!.classify(deferred)).toEqual({kind: "running", retryable: true})
    installAnswer = async () => ({status: "opened", packageName: pkg, version: "2.0.0"})
    const opened = await port!.install({resolution, assignment, isCancelled: () => false}).catch((error) => error)
    expect(port!.classify(opened)).toEqual({kind: "newer_version_installed", retryable: false})
  })

  test.each([
    ["archived", "archived", false],
    ["not_a_miniapp", "not_a_miniapp", false],
    ["domain_mismatch", "not_a_miniapp", false],
    ["access_denied", "access_denied", false],
    ["age_restricted", "access_denied", false],
    ["needs_newer_app", "incompatible_host", false],
    ["signature_invalid", "signature_invalid", false],
    ["integrity", "download_failed", true],
    ["network", "download_failed", true],
    ["cancelled", "cancelled", true],
  ])("installMiniapp's %s is the assignment's %s", (code, kind, retryable) => {
    expect(classifyAssignmentInstallError(new FakeInstallMiniappError(code))).toEqual({kind, retryable})
    expect(port!.classify).toBe(classifyAssignmentInstallError)
  })

  test("a full disk behind a network failure is storage_full", () => {
    const error = new FakeInstallMiniappError("network", "com.acme.notes did not install: ENOSPC")
    expect(classifyAssignmentInstallError(error)).toEqual({kind: "storage_full", retryable: true})
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
