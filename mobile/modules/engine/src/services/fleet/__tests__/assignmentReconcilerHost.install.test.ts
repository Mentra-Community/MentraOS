/// <reference types="bun-types" />
/**
 * Fleet's reconciler installs each assigned miniapp headlessly through `installMiniapp`. This runs the real
 * reconciler, its host port, `installMiniapp`, `resolveMiniappUrl` and `miniappFetch` against a fake miniapp server,
 * with Core, the registry's storage and the shared installer faked.
 */
import {beforeEach, describe, expect, mock, test} from "bun:test"
import type {
  FleetAssignmentOutcomePayload,
  FleetDesiredState,
  FleetDesiredStateWithPins,
  RegistryRegisterRequest,
  RegistryRegisterResponse,
} from "@mentra/cloud-protocol"

import "../../__tests__/reactNativeTestMock"
import {cloudClientService} from "../../__tests__/cloudClientServiceTestMock"
import {configure, resetForTests} from "../../../runtime/bootstrap"
import {MiniappRunningError} from "../../../utils/storeInstallRuntime"
import type {MiniappAssignment, MiniappReleaseIdentity} from "../../AppRegistry"
import type {ReleaseInstallOptions} from "../../miniappReleaseInstall"
import {TRIGGER_JITTER_MS} from "../assignmentReconciler"
import {MemoryFleetStore} from "./memoryFleetStore"

// ---- the miniapp server -----------------------------------------------------------------------------------------

const CORE = "https://core.mentra.glass"
const notes = "com.acme.notes"
const notesUrl = "https://notes.acme.com/app/"
const tools = "com.acme.tools"
const toolsUrl = "https://tools.acme.com/"

interface Site {
  packageName: string
  /** The versions `miniapp.json` serves, one per request; the last one stays. */
  versions: string[]
  /** Answer `401` with a sign-in challenge for this package until a token comes. */
  challengeFor?: string
  /** Asks for sign-in for the ZIP only. */
  zipOnly?: boolean
  /** The tokens the server admits. */
  admits?: (authorization: string) => boolean
  zip: Uint8Array
  sha256: string
  /** `miniapp.json`'s `versions`, and the ZIP each names by file name. */
  listed?: Array<{version: string; url: string; sha256: string; zip: Uint8Array}>
}

interface Sent {
  url: string
  authorization?: string
  redirect: string
  credentials: string
}

let sites: Map<string, Site>
let sent: Sent[]

async function site(packageName: string, versions: string[], extra: Partial<Site> = {}): Promise<Site> {
  const zip = new TextEncoder().encode(`${packageName} zip`)
  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex")
  return {packageName, versions, zip, sha256, ...extra}
}

function respond(target: string, status: number, body: BodyInit | null, headers: Record<string, string> = {}) {
  const response = new Response(body, {status, headers})
  Object.defineProperty(response, "url", {value: target})
  return response
}

async function serve(target: string, init: {headers: Record<string, string>; redirect: string; credentials: string}) {
  const authorization = init.headers.Authorization
  sent.push({
    url: target,
    ...(authorization ? {authorization} : {}),
    redirect: init.redirect,
    credentials: init.credentials,
  })
  const base = [...sites.keys()].find((url) => target.startsWith(url))
  const found = base ? sites.get(base) : undefined
  if (!base || !found) return respond(target, 404, null)
  const isZip = target.endsWith(".zip")
  const asks = found.challengeFor !== undefined && (isZip || !found.zipOnly)
  if (asks && !authorization) {
    return respond(target, 401, null, {"WWW-Authenticate": `Bearer realm="mentra", package="${found.challengeFor}"`})
  }
  if (asks && !(found.admits ?? (() => true))(authorization!)) return respond(target, 403, null)
  if (isZip) {
    const listed = found.listed?.find((entry) => target.endsWith(`/${entry.url}`))
    return respond(target, 200, listed ? listed.zip : found.zip)
  }
  const version = found.versions.length > 1 ? found.versions.shift()! : found.versions[0]!
  const manifest = {
    packageName: found.packageName,
    version,
    name: found.packageName.split(".").at(-1),
    minHostVersion: "3.3.0",
    bundle: {url: `${found.packageName}-${version}.zip`, sha256: found.sha256},
    ...(found.listed ? {versions: found.listed.map(({version, url, sha256}) => ({version, url, sha256}))} : {}),
  }
  return respond(target, 200, JSON.stringify(manifest))
}
mock.module("expo/fetch", () => ({fetch: serve}))

// ---- Core ---------------------------------------------------------------------------------------------------------

let tokens: string[]
let registrations: RegistryRegisterRequest[]
let registryAnswer: (request: RegistryRegisterRequest) => RegistryRegisterResponse
let desired: FleetDesiredState
cloudClientService.getCoreSession = () => ({coreUrl: CORE, mentraUserId: "mu_1"})
cloudClientService.hasCore = () => true
cloudClientService.getMiniappAuthToken = async (packageName: string) => {
  tokens.push(packageName)
  return {token: `token-for-${packageName}`, expiresAt: Date.now() + 60_000}
}
;(cloudClientService.core as Record<string, unknown>).registry = {
  register: async (request: RegistryRegisterRequest) => {
    registrations.push(request)
    return registryAnswer(request)
  },
}

// ---- the phone ----------------------------------------------------------------------------------------------------

interface Installed {
  versions: string[]
  identities: Map<string, MiniappReleaseIdentity>
  reasons: string[]
  assignment: MiniappAssignment | null
}
let phone: Map<string, Installed>
let running: Set<string>
let prompts: Map<string, (answer: "update" | "not_now") => void>
let releaseInstalls: Array<{bundleUrl: string; options: ReleaseInstallOptions}>
let outcomes: FleetAssignmentOutcomePayload[]
let workspaces: Array<string | null>

const active = (packageName: string) => phone.get(packageName)?.versions.at(-1) ?? null

mock.module("../../AppRegistry", () => ({
  default: {
    getInstalledVersions: (packageName: string) => phone.get(packageName)?.versions ?? [],
    getActiveReleaseVersion: active,
    getReleaseIdentity: (packageName: string, version: string) =>
      phone.get(packageName)?.identities.get(version) ?? null,
    getInstallReasons: (packageName: string) => phone.get(packageName)?.reasons ?? [],
    getMiniappAssignment: (packageName: string) => phone.get(packageName)?.assignment ?? null,
    getAssignedPackages: () => [...phone].filter(([, app]) => app.reasons.includes("assignment")).map(([name]) => name),
    isDevelopmentBuild: () => false,
    setMiniappAssignment: (packageName: string, assignment: MiniappAssignment) => {
      const app = phone.get(packageName)!
      app.assignment = assignment
      if (!app.reasons.includes("assignment")) app.reasons.push("assignment")
    },
    clearMiniappAssignment: (packageName: string) => {
      const app = phone.get(packageName)
      if (!app) return []
      app.assignment = null
      app.reasons = app.reasons.filter((reason) => reason !== "assignment")
      return app.reasons
    },
    restoreMiniappAccess: () => {},
    isMiniappAccessRevoked: () => false,
    gcReleaseVersions: async () => {},
  },
}))

class InstallCancelled extends Error {}
/** The shared installer: download through the caller, then ask a running miniapp's person, then commit. */
async function installRelease(bundleUrl: string, options: ReleaseInstallOptions): Promise<void> {
  releaseInstalls.push({bundleUrl, options})
  const packageName = options.expectedPackageName
  await options.downloadBundle!(bundleUrl)
  if (running.has(packageName) && options.askIfRunning) {
    options.onAsking?.()
    const answer = await new Promise<"update" | "not_now">((resolve) => prompts.set(packageName, resolve))
    prompts.delete(packageName)
    if (answer !== "update") throw new MiniappRunningError(packageName)
  }
  if (options.isCancelled?.()) throw new InstallCancelled()
  const app = phone.get(packageName) ?? {versions: [], identities: new Map(), reasons: [], assignment: null}
  app.versions.push(options.expectedVersion)
  app.identities.set(options.expectedVersion, {...options.releaseIdentity!})
  if (options.installReason && !app.reasons.includes(options.installReason)) app.reasons.push(options.installReason)
  if (options.assignment) app.assignment = options.assignment
  phone.set(packageName, app)
}
mock.module("../../miniappReleaseInstall", () => ({
  installMiniappRelease: installRelease,
  MiniappInstallCancelledError: InstallCancelled,
  classifyManagedInstallError: (error: unknown) =>
    error instanceof MiniappRunningError
      ? {kind: "running", retryable: true}
      : error instanceof InstallCancelled
        ? {kind: "cancelled", retryable: true}
        : {kind: "download_failed", retryable: true},
  stopMiniappForRevocation: async () => {},
  uninstallManagedMiniapp: async (packageName: string) => void phone.delete(packageName),
}))
// Local-network builds never come from an assignment.
mock.module("../../localBuildInstall", () => ({
  installLocalBuild: async () => {
    throw new Error("an assignment never installs a local build")
  },
  restoreInstalledRelease: async () => {},
}))
mock.module("../../LocalMiniappRuntime", () => ({
  default: {
    currentInstallCompatibilityPolicy: () => ({
      hostVersion: "3.4.0",
      hardwareCapabilities: {},
    }),
    installSession: () => 1,
    configuration: {setWorkspace: async () => {}, workspacePackages: () => []},
  },
}))
mock.module("../../MiniappLauncher", () => ({miniappLauncher: {isRunning: (name: string) => running.has(name)}}))
mock.module("../../miniappDataPartition", () => ({
  setFleetWorkspace: (_session: unknown, workspaceId: string | null) => workspaces.push(workspaceId),
}))
mock.module("../../runningUpdatePrompt", () => ({
  dismissRunningUpdatePrompt: (packageName: string) => prompts.get(packageName)?.("not_now"),
  onRunningUpdatePromptDue: () => () => {},
}))
mock.module("@react-native-community/netinfo", () => ({default: {addEventListener: () => () => {}}}))
mock.module("../fleetRevisionSignal", () => ({
  emitAssignmentOutcome: (outcome: FleetAssignmentOutcomePayload) => outcomes.push(outcome),
  onFleetRevision: () => () => {},
}))
mock.module("../fleetManagementState", () => ({setFleetManagementState: () => {}}))
let store = new MemoryFleetStore()
mock.module("../fleetStorage", () => ({getFleetStore: () => store}))

/** The reconciler's timers: triggers fire when a test says so; retries and timeouts never do. */
let timers: Array<{callback: () => void; ms: number}>
mock.module("../../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, ms: number) => timers.push({callback, ms}) - 1,
    clearTimeout: (handle: number) => {
      if (timers[handle]) timers[handle] = {callback: () => {}, ms: Infinity}
    },
  },
}))

const {startAssignmentReconciler, stopAssignmentReconciler, triggerAssignmentReconcile} = await import(
  "../assignmentReconcilerHost"
)

// ---- helpers ------------------------------------------------------------------------------------------------------

function managed(revision: number, entries: Array<{id: string; pkg: string; url: string}>): FleetDesiredState {
  return {
    status: "managed",
    revision,
    generatedAt: "2026-10-24T10:00:00.000Z",
    workspace: {workspaceId: "ws_acme", name: "Acme"},
    entries: entries.map((entry) => ({
      assignmentId: entry.id,
      revision: 1,
      url: entry.url,
      packageName: entry.pkg,
      selection: "latest",
    })),
  } as FleetDesiredState
}

const notesEntry = {id: "asg_notes", pkg: notes, url: notesUrl}
const toolsEntry = {id: "asg_tools", pkg: tools, url: toolsUrl}

/** Fire the reconciler's due triggers, then wait until `done` holds. */
async function reconcileUntil(done: () => boolean): Promise<void> {
  for (let round = 0; round < 400; round++) {
    const due = timers.filter((timer) => timer.ms <= TRIGGER_JITTER_MS)
    for (const timer of due) {
      timer.ms = Infinity
      timer.callback()
    }
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`never reached: ${JSON.stringify(states())}`)
}

function states(packageName?: string): string[] {
  return outcomes
    .filter((outcome) => !packageName || outcome.packageName === packageName)
    .map((outcome) => (outcome.reason ? `${outcome.state}:${outcome.reason}` : outcome.state))
}

const last = (packageName: string) => outcomes.filter((outcome) => outcome.packageName === packageName).at(-1)

function start(): void {
  startAssignmentReconciler({fetch: async () => desired})
}

beforeEach(() => {
  stopAssignmentReconciler()
  resetForTests()
  configure({auth: {}, config: {hostVersion: "3.4.0"}})
  sites = new Map()
  sent = []
  tokens = []
  registrations = []
  registryAnswer = () => ({result: "accepted", entry: {} as never, manifest: {} as never})
  phone = new Map()
  running = new Set()
  prompts = new Map()
  releaseInstalls = []
  outcomes = []
  workspaces = []
  timers = []
  store = new MemoryFleetStore()
  desired = managed(1, [notesEntry])
})

// ---- tests --------------------------------------------------------------------------------------------------------

describe("an assigned miniapp", () => {
  test("installs from its URL with no install sheet, registers the URL, and carries no token", async () => {
    sites.set(notesUrl, await site(notes, ["1.0.0"]))
    start()
    await reconcileUntil(() => states(notes).includes("installed"))

    expect(states(notes)).toEqual(["downloading", "installed"])
    expect(last(notes)).toMatchObject({selectedVersion: "1.0.0", installedVersion: "1.0.0"})
    expect(workspaces).toEqual(["ws_acme"])
    expect(registrations).toEqual([{url: notesUrl, reported: {packageName: notes, name: "notes", version: "1.0.0"}}])
    expect(releaseInstalls).toHaveLength(1)
    expect(releaseInstalls[0]!.options).toMatchObject({
      expectedPackageName: notes,
      expectedVersion: "1.0.0",
      installReason: "assignment",
      assignment: {assignmentId: "asg_notes", workspaceId: "ws_acme", coreUrl: CORE, mentraUserId: "mu_1"},
      // Headless: a first install is silent, and a running miniapp is never closed without the person.
      onlyIfStopped: true,
      askIfRunning: true,
      firstInstall: true,
    })
    expect(phone.get(notes)!.identities.get("1.0.0")).toEqual({
      source: "url",
      sourceUrl: notesUrl,
      bundleSha256: sites.get(notesUrl)!.sha256,
    })
    // A public miniapp's server never learns who is asking.
    expect(tokens).toEqual([])
    expect(sent.every((request) => !request.authorization && request.credentials === "omit")).toBe(true)
  })

  test("from a private URL installs after its sign-in challenge, with that package's token only", async () => {
    const admitted: string[] = []
    sites.set(
      notesUrl,
      await site(notes, ["1.0.0"], {
        challengeFor: notes,
        admits: (authorization) => (admitted.push(authorization), authorization === `Bearer token-for-${notes}`),
      }),
    )
    start()
    await reconcileUntil(() => states(notes).includes("installed"))

    expect(states(notes)).toEqual(["downloading", "installed"])
    // Resolving, then installMiniapp's miniapp.json and ZIP: each answers its own challenge, for this package.
    expect(tokens).toEqual([notes, notes, notes])
    expect(admitted).toHaveLength(3)
    for (const request of sent.filter((each) => each.authorization)) expect(request.redirect).toBe("error")
    expect(phone.get(notes)!.identities.get("1.0.0")).toMatchObject({source: "url", private: true})
    expect(registrations).toHaveLength(1)
  })

  test("whose server refuses the token is blocked as access_denied, and nothing downloads", async () => {
    sites.set(notesUrl, await site(notes, ["1.0.0"], {challengeFor: notes, admits: () => false}))
    start()
    await reconcileUntil(() => states(notes).includes("blocked:access_denied"))

    expect(states(notes)).toEqual(["blocked:access_denied"])
    expect(releaseInstalls).toEqual([])
    expect(phone.has(notes)).toBe(false)
  })

  test("whose ZIP's server refuses the token is blocked as access_denied", async () => {
    sites.set(notesUrl, await site(notes, ["1.0.0"], {challengeFor: notes, zipOnly: true, admits: () => false}))
    start()
    await reconcileUntil(() => states(notes).includes("blocked:access_denied"))

    expect(states(notes)).toEqual(["downloading", "blocked:access_denied"])
    expect(phone.has(notes)).toBe(false)
  })

  test("whose challenge names a package its domain doesn't own is not_a_miniapp, and gets no token", async () => {
    sites.set(notesUrl, await site(notes, ["1.0.0"], {challengeFor: "com.other.notes"}))
    start()
    await reconcileUntil(() => states(notes).length > 0)

    expect(states(notes)).toEqual(["blocked:not_a_miniapp"])
    expect(tokens).toEqual([])
  })

  test("at an archived URL is blocked as archived, and nothing downloads", async () => {
    sites.set(notesUrl, await site(notes, ["1.0.0"]))
    registryAnswer = () => ({result: "archived"})
    start()
    await reconcileUntil(() => states(notes).includes("blocked:archived"))

    expect(states(notes)).toEqual(["downloading", "blocked:archived"])
    expect(releaseInstalls).toEqual([])
    expect(phone.has(notes)).toBe(false)
  })

  test("reports the version its URL served when it installed", async () => {
    // Resolving reads 1.0.0; by the time installMiniapp reads it, the URL serves 1.1.0.
    sites.set(notesUrl, await site(notes, ["1.0.0", "1.1.0"]))
    start()
    await reconcileUntil(() => states(notes).includes("installed"))

    expect(last(notes)).toMatchObject({state: "installed", selectedVersion: "1.1.0", installedVersion: "1.1.0"})
    expect(phone.get(notes)!.versions).toEqual(["1.1.0"])
  })

  test("installs nothing from a URL that serves another package by the time it installs", async () => {
    const moved = await site(notes, ["1.0.0"])
    sites.set(notesUrl, moved)
    const served = serve
    let manifests = 0
    mock.module("expo/fetch", () => ({
      fetch: async (target: string, init: Parameters<typeof serve>[1]) => {
        if (target.endsWith("miniapp.json") && ++manifests === 2) moved.packageName = "com.acme.other"
        return served(target, init)
      },
    }))
    try {
      start()
      await reconcileUntil(() => states(notes).length > 1)
      expect(states(notes)).toEqual(["downloading", "blocked:not_a_miniapp"])
      expect(registrations).toEqual([])
      expect(releaseInstalls).toEqual([])
    } finally {
      mock.module("expo/fetch", () => ({fetch: serve}))
    }
  })
})

describe("a pinned assignment", () => {
  async function pinnedSite(): Promise<{latest: string; old: string}> {
    const latest = await site(notes, ["2.0.0"])
    const zip = new TextEncoder().encode("notes 1.5.0 zip")
    const old = Buffer.from(await crypto.subtle.digest("SHA-256", zip)).toString("hex")
    latest.listed = [
      {version: "2.0.0", url: `${notes}-2.0.0.zip`, sha256: latest.sha256, zip: latest.zip},
      {version: "1.5.0", url: `old/${notes}-1.5.0.zip`, sha256: old, zip},
    ]
    sites.set(notesUrl, latest)
    return {latest: latest.sha256, old}
  }

  function pinnedTo(version: string, sha256: string): FleetDesiredState {
    const state = managed(1, [notesEntry]) as Extract<FleetDesiredStateWithPins, {status: "managed"}>
    state.entries = [{...state.entries[0]!, selection: "pinned", pin: {version, sha256}}]
    return state as unknown as FleetDesiredState
  }

  test("keeps its pin on the phone and installs the pinned version's ZIP, checked against its hash", async () => {
    const {old} = await pinnedSite()
    desired = pinnedTo("1.5.0", old)
    start()
    await reconcileUntil(() => states(notes).includes("installed"))

    expect(JSON.parse(store.getString(`miniapp.pins.v1/${notes}`)!)).toMatchObject({
      fleet: {version: "1.5.0", sha256: old, assignmentId: "asg_notes", workspaceId: "ws_acme", url: notesUrl},
    })
    expect(releaseInstalls).toHaveLength(1)
    expect(releaseInstalls[0]!.bundleUrl).toBe(`${notesUrl}old/${notes}-1.5.0.zip`)
    expect(releaseInstalls[0]!.options).toMatchObject({expectedVersion: "1.5.0", expectedBundleSha256: old})
    expect(phone.get(notes)!.identities.get("1.5.0")).toMatchObject({bundleSha256: old})
    expect(last(notes)).toMatchObject({state: "installed", selectedVersion: "1.5.0", installedVersion: "1.5.0"})
  })

  test("whose version now has other bytes installs nothing and reports pin_hash_changed", async () => {
    await pinnedSite()
    desired = pinnedTo("1.5.0", "9".repeat(64))
    start()
    await reconcileUntil(() => states(notes).length > 0)

    expect(states(notes)).toEqual(["blocked:pin_hash_changed"])
    expect(releaseInstalls).toEqual([])
    expect(phone.has(notes)).toBe(false)
  })
})

describe("an assigned miniapp that is running", () => {
  test("waits for the person's answer to its update prompt while other assignments go on", async () => {
    sites.set(notesUrl, await site(notes, ["1.1.0"]))
    sites.set(toolsUrl, await site(tools, ["2.0.0"]))
    phone.set(notes, {
      versions: ["1.0.0"],
      identities: new Map([["1.0.0", {source: "url", sourceUrl: notesUrl}]]),
      reasons: ["assignment"],
      assignment: null,
    })
    running.add(notes)
    desired = managed(1, [notesEntry, toolsEntry])
    start()
    await reconcileUntil(() => states(tools).includes("installed"))

    // The update is staged and asks; the reconciler went on to the next assignment.
    expect(states(notes)).toEqual(["downloading", "deferred_running"])
    expect(prompts.has(notes)).toBe(true)
    expect(phone.get(notes)!.versions).toEqual(["1.0.0"])

    prompts.get(notes)!("update")
    await reconcileUntil(() => states(notes).includes("installed"))
    expect(last(notes)).toMatchObject({state: "installed", installedVersion: "1.1.0"})
  })

  test("waits for it to stop when the person says Not now", async () => {
    sites.set(notesUrl, await site(notes, ["1.1.0"]))
    phone.set(notes, {
      versions: ["1.0.0"],
      identities: new Map([["1.0.0", {source: "url", sourceUrl: notesUrl}]]),
      reasons: ["assignment"],
      assignment: null,
    })
    running.add(notes)
    start()
    await reconcileUntil(() => prompts.has(notes))
    prompts.get(notes)!("not_now")
    await reconcileUntil(() => releaseInstalls.length === 1 && prompts.size === 0)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(states(notes)).toEqual(["downloading", "deferred_running"])
    expect(phone.get(notes)!.versions).toEqual(["1.0.0"])

    // Stopped, the next pass installs it at once.
    running.delete(notes)
    triggerAssignmentReconcile()
    await reconcileUntil(() => states(notes).includes("installed"))
    expect(phone.get(notes)!.versions).toEqual(["1.0.0", "1.1.0"])
  })
})

describe("a workspace deployment whose developer tools are off", () => {
  test("still installs its workspace's assignments", async () => {
    resetForTests()
    configure({
      auth: {},
      config: {
        hostVersion: "3.4.0",
        localMiniappPolicy: {systemPackageNames: ["com.mentra.settings"], managed: []},
      },
    })
    sites.set(notesUrl, await site(notes, ["1.0.0"]))
    start()
    await reconcileUntil(() => states(notes).some((state) => state === "installed" || state.startsWith("blocked")))

    expect(states(notes)).toEqual(["downloading", "installed"])
  })
})
