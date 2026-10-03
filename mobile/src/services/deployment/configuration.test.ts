import {engine, SETTINGS} from "@mentra/engine"
import {cloudClientService} from "@mentra/engine-host-internal"
import {result as Res} from "typesafe-ts"

import {cloudClient, deploymentCloudConfigValues, resolvedEndpoints} from "@/services/cloudClient"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"

import {deploymentDebugOverrides, resolveDeploymentManifest, saveDeploymentCloudOverrides} from "./debugOverrides"
import {createConsumerDeployment, createOfficialManifest} from "./officialManifest"
import {deploymentManifestSchema} from "./schema"
import {deploymentStore, DeploymentStore, type DeploymentStorage} from "./store"
import type {ActiveDeployment, DeploymentCandidate} from "./types"

jest.mock("@/utils/cloudClient/devHost", () => ({METRO_AUTO: "metro-auto", devServerHost: jest.fn()}))

const originalCore = process.env.EXPO_PUBLIC_CLOUD_CORE_URL
const originalRuntime = process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
const workspace: DeploymentCandidate = {
  workspaceOrigin: "https://organization.example",
  manifestUrl: "https://organization.example/.well-known/mentra-deployment.json",
  manifest: {
    ...createOfficialManifest(),
    deploymentId: "enterprise-demo",
    displayName: "Mentra Enterprise Demo",
    services: {coreUrl: "https://core.organization.example", runtimeUrl: "https://organization.example"},
    auth: {
      mode: "microsoft-entra",
      authorityUrl: "https://login.microsoftonline.com/2e7662c0-e826-4928-95b2-60bdd48d5d95",
      clientId: "c84a504c-6caa-4a00-a6a3-9206cad41218",
      sessionScopes: ["api://11111111-2222-4333-8444-555555555555/mentra.session"],
      teamsScopes: [],
    },
    features: {
      runtimeRealtimeSession: false,
      managedStreams: true,
      nativeMeetings: false,
      cloudSpeech: false,
      onDeviceSpeech: false,
      navigation: false,
    },
    content: {wallpaperUrls: []},
    telemetry: false,
  },
}

beforeEach(async () => {
  jest.clearAllMocks()
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.build.example"
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "https://runtime.build.example"
  await deploymentStore.clearSelection()
  await deploymentStore.returnToMentra()
  jest.mocked(devServerHost).mockReturnValue(undefined)
})

afterAll(async () => {
  if (originalCore === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = originalCore
  if (originalRuntime === undefined) delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  else process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = originalRuntime
  await deploymentStore.returnToMentra()
})

it("embeds a complete schema-v1 official manifest and respects build environment URLs", () => {
  const manifest = createOfficialManifest()
  expect(deploymentManifestSchema.parse(manifest)).toEqual(manifest)
  expect(manifest.services).toEqual({
    coreUrl: "https://core.build.example",
    runtimeUrl: "https://runtime.build.example",
  })
  expect(manifest.auth).toEqual({mode: "mentra-account"})
  expect(manifest.glasses.allowedModelsOverride).toBeNull()
  expect(manifest.features.runtimeRealtimeSession).toBe(true)
  expect(manifest.telemetry).toBe(true)
})

it("uses shared dev defaults for missing or blank environment values", () => {
  delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "   "
  expect(createOfficialManifest().services).toEqual({
    coreUrl: "https://core.dev.us-west-2.mentraglass.com",
    runtimeUrl: "https://runtime.dev.us-west-2.mentraglass.com",
  })
})

it.each(["consumer", "workspace"])("uses one resolver for %s debug overrides, startup and reconnect", async (kind) => {
  if (kind === "workspace") await deploymentStore.activate(workspace)
  const deployment = deploymentStore.getActive()
  const originalManifest = JSON.stringify(deployment.manifest)
  await saveDeploymentCloudOverrides(deployment, {core: "http://localhost:3000", runtime: "http://localhost:3001"})
  const config = deploymentCloudConfigValues(deployment)
  expect(resolvedEndpoints()).toEqual({core: "http://localhost:3000", runtime: "http://localhost:3001"})
  expect(config).toMatchObject({coreUrl: "http://localhost:3000", runtimeUrl: "http://localhost:3001"})
  expect(config.resolveCloudEndpoints?.()).toEqual({core: "http://localhost:3000", runtime: "http://localhost:3001"})
  cloudClient.reconnect()
  expect(cloudClientService.reconnect).toHaveBeenCalledWith(null)
  expect(JSON.stringify(deployment.manifest)).toBe(originalManifest)

  await saveDeploymentCloudOverrides(deployment, {core: "", runtime: ""})
  expect(resolvedEndpoints()).toEqual({
    core: deployment.manifest.services.coreUrl,
    runtime: deployment.manifest.services.runtimeUrl,
  })
  expect(deploymentStore.getActive()).toBe(deployment)
})

it.each(["consumer", "workspace"])(
  "resolves Metro dynamically for %s and falls back to its own defaults",
  async (kind) => {
    if (kind === "workspace") await deploymentStore.activate(workspace)
    const deployment = deploymentStore.getActive()
    await saveDeploymentCloudOverrides(deployment, {core: METRO_AUTO, runtime: METRO_AUTO})
    jest.mocked(devServerHost).mockReturnValue("192.0.2.10")
    expect(resolvedEndpoints()).toEqual({core: "http://192.0.2.10:3000", runtime: "http://192.0.2.10:3001"})
    jest.mocked(devServerHost).mockReturnValue("192.0.2.11")
    expect(deploymentCloudConfigValues(deployment).resolveCloudEndpoints?.().runtime).toBe("http://192.0.2.11:3001")
    jest.mocked(devServerHost).mockReturnValue(undefined)
    expect(resolveDeploymentManifest(deployment).services).toEqual(deployment.manifest.services)
  },
)

it("preserves legacy consumer overrides but never applies them to a restored workspace", () => {
  engine.settings.setManyLocal({cloud_core_url: "http://localhost:3000", cloud_runtime_url: "http://localhost:3001"})
  expect(resolvedEndpoints().core).toBe("http://localhost:3000")
  const restored = {...workspace, kind: "workspace", source: "manual", activatedAt: new Date().toISOString()} as const
  expect(resolveDeploymentManifest(restored).services).toEqual(workspace.manifest.services)
})

it.each(["activate", "returnToMentra", "beginWorkspaceSelection", "clearSelection"])(
  "clears overrides on %s",
  async (action) => {
    await deploymentStore.activate(workspace)
    await saveDeploymentCloudOverrides(deploymentStore.getActive(), {
      core: "https://debug.example",
      runtime: "https://debug.example",
    })
    engine.settings.setManyLocal({ota_version_url: "https://debug.example/ota.json"})
    if (action === "activate") await deploymentStore.activate(workspace)
    else await deploymentStore[action as "returnToMentra" | "beginWorkspaceSelection" | "clearSelection"]()
    expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("")
    expect(engine.settings.get(SETTINGS.cloud_runtime_url.key)).toBe("")
    expect(engine.settings.get(SETTINGS.ota_version_url.key)).toBe("")
    expect(deploymentDebugOverrides(deploymentStore.getActive()).core).toBeUndefined()
  },
)

it("keeps overrides on a normal restart while rebuilding official defaults from the current build", async () => {
  let value: ActiveDeployment | null = createConsumerDeployment()
  const persistence: DeploymentStorage = {
    load: () => value,
    save: (next) => {
      value = next
    },
    remove: () => {
      value = null
    },
  }
  const store = new DeploymentStore(persistence)
  await saveDeploymentCloudOverrides(store.getActive(), {
    core: "http://localhost:3000",
    runtime: "http://localhost:3001",
  })
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.new-build.example"
  const restored = new DeploymentStore(persistence).getActive()
  expect(restored.manifest.services.coreUrl).toBe("https://core.new-build.example")
  expect(resolveDeploymentManifest(restored).services.coreUrl).toBe("http://localhost:3000")
})

it("retains workspace capability limits and official OTA fallback policy", async () => {
  expect(deploymentCloudConfigValues(deploymentStore.getActive()).allowLegacyOtaFallback).toBe(true)
  await deploymentStore.activate(workspace)
  expect(deploymentCloudConfigValues(deploymentStore.getActive())).toMatchObject({
    features: {nativeMeetings: false, cloudSpeech: false, onDeviceSpeech: false, navigation: false},
    runtimeRealtimeSession: false,
    allowLegacyOtaFallback: false,
  })
})

it("preserves legacy overrides when restoring an existing consumer login after upgrade", async () => {
  const persistence: DeploymentStorage = {load: () => null, save: jest.fn(), remove: jest.fn()}
  const store = new DeploymentStore(persistence)
  engine.settings.setManyLocal({cloud_core_url: "http://localhost:3000"})
  store.restoreConsumerSessionSelection()
  expect(store.isResolved()).toBe(true)
  expect(resolveDeploymentManifest(store.getActive()).services.coreUrl).toBe("http://localhost:3000")

  await store.beginWorkspaceSelection()
  store.restoreConsumerSessionSelection()
  expect(store.isResolved()).toBe(false)
})

it("keeps consumer overrides when login reconfirms the active deployment", async () => {
  await saveDeploymentCloudOverrides(deploymentStore.getActive(), {
    core: "http://localhost:3000",
    runtime: "http://localhost:3001",
  })
  await deploymentStore.returnToMentra()
  expect(resolvedEndpoints()).toEqual({core: "http://localhost:3000", runtime: "http://localhost:3001"})
})

it("does not complete a deployment switch when clearing persisted settings fails, and can retry", async () => {
  const {storage: settingsStorage} = jest.requireActual<
    typeof import("../../../modules/engine/src/utils/storage/storage")
  >("../../../modules/engine/src/utils/storage/storage")
  const persistence: DeploymentStorage = {load: () => null, save: jest.fn(), remove: jest.fn()}
  const store = new DeploymentStore(persistence)
  await saveDeploymentCloudOverrides(store.getActive(), {
    core: "http://localhost:3000",
    runtime: "http://localhost:3001",
  })
  const write = jest.spyOn(settingsStorage, "save").mockReturnValueOnce(Res.error(new Error("Cannot persist settings")))
  try {
    await expect(store.activate(workspace)).rejects.toThrow("Cannot persist settings")
    expect(persistence.save).not.toHaveBeenCalled()
    expect(store.getActive().kind).toBe("consumer")
    expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("http://localhost:3000")
    await store.activate(workspace)
    expect(persistence.save).toHaveBeenCalledTimes(1)
    expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("")
    const persisted = settingsStorage.load(SETTINGS.cloud_core_url.key)
    if (persisted.is_error()) throw persisted.error
    expect(persisted.value).toBe("")
  } finally {
    write.mockRestore()
  }
})

it("does not enable navigation in the China official manifest", () => {
  const previousRegion = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
  try {
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "china"
    expect(createOfficialManifest().features.navigation).toBe(false)
    process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = "default"
    expect(createOfficialManifest().features.navigation).toBe(true)
  } finally {
    if (previousRegion === undefined) delete process.env.EXPO_PUBLIC_DEPLOYMENT_REGION
    else process.env.EXPO_PUBLIC_DEPLOYMENT_REGION = previousRegion
  }
})

it.each(["activate", "returnToMentra", "beginWorkspaceSelection", "clearSelection"] as const)(
  "restores overrides when %s cannot persist the selection",
  async (action) => {
    const persistence: DeploymentStorage = {load: () => null, save: jest.fn(), remove: jest.fn()}
    const store = new DeploymentStore(persistence)
    await store.activate(workspace)
    const previous = store.getActive()
    await saveDeploymentCloudOverrides(previous, {
      core: "https://debug-core.example",
      runtime: "https://debug-runtime.example",
    })
    await engine.settings.setManyLocal({
      ota_version_url: "https://debug-ota.example/version.json",
      cached_required_version: "runtime:99.0.0",
    })
    const keys = [
      "cloud_core_url",
      "cloud_runtime_url",
      "cloud_url_deployment",
      "ota_version_url",
      "cached_required_version",
    ]
    const oldValues = Object.fromEntries(keys.map((key) => [key, engine.settings.get(key)]))
    const write = action === "activate" || action === "returnToMentra" ? persistence.save : persistence.remove
    jest.mocked(write).mockImplementationOnce(() => {
      throw new Error("Cannot persist deployment")
    })

    await expect(action === "activate" ? store.activate(workspace) : store[action]()).rejects.toThrow(
      "Cannot persist deployment",
    )
    expect(store.getActive()).toBe(previous)
    expect(store.isResolved()).toBe(true)
    expect(store.isSelectingWorkspace()).toBe(false)
    const {storage: settingsStorage} = jest.requireActual<
      typeof import("../../../modules/engine/src/utils/storage/storage")
    >("../../../modules/engine/src/utils/storage/storage")
    for (const key of keys) {
      expect(engine.settings.get(key)).toBe(oldValues[key])
      const persisted = settingsStorage.load(key)
      if (persisted.is_error()) throw persisted.error
      expect(persisted.value).toBe(oldValues[key])
    }

    if (action === "activate") await store.activate(workspace)
    else await store[action]()
    for (const key of keys) expect(engine.settings.get(key)).toBe("")
  },
)
