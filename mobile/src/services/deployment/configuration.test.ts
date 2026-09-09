import {engine, SETTINGS} from "@mentra/engine"
import {cloudClientService} from "@mentra/engine-host-internal"

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

beforeEach(() => {
  jest.clearAllMocks()
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.build.example"
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "https://runtime.build.example"
  deploymentStore.returnToMentra()
  jest.mocked(devServerHost).mockReturnValue(undefined)
})

afterAll(() => {
  if (originalCore === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = originalCore
  if (originalRuntime === undefined) delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  else process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = originalRuntime
  deploymentStore.returnToMentra()
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
  if (kind === "workspace") deploymentStore.activate(workspace)
  const deployment = deploymentStore.getActive()
  const originalManifest = JSON.stringify(deployment.manifest)
  await saveDeploymentCloudOverrides(deployment, {core: "http://localhost:3000", runtime: "http://localhost:3001"})
  const config = deploymentCloudConfigValues(deployment)
  expect(resolvedEndpoints()).toEqual({core: "http://localhost:3000", runtime: "http://localhost:3001"})
  expect(config).toMatchObject({coreUrl: "http://localhost:3000", runtimeUrl: "http://localhost:3001"})
  expect(config.resolveCloudEndpoints?.()).toEqual(resolvedEndpoints())
  cloudClient.reconnect()
  expect(cloudClientService.reconnect).toHaveBeenCalledWith(resolvedEndpoints())
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
    if (kind === "workspace") deploymentStore.activate(workspace)
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
    deploymentStore.activate(workspace)
    await saveDeploymentCloudOverrides(deploymentStore.getActive(), {
      core: "https://debug.example",
      runtime: "https://debug.example",
    })
    engine.settings.setManyLocal({ota_version_url: "https://debug.example/ota.json"})
    if (action === "activate") deploymentStore.activate(workspace)
    else deploymentStore[action as "returnToMentra" | "beginWorkspaceSelection" | "clearSelection"]()
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

it("retains workspace capability limits and official OTA fallback policy", () => {
  expect(deploymentCloudConfigValues(deploymentStore.getActive()).allowLegacyOtaFallback).toBe(true)
  deploymentStore.activate(workspace)
  expect(deploymentCloudConfigValues(deploymentStore.getActive())).toMatchObject({
    features: {nativeMeetings: false, cloudSpeech: false, onDeviceSpeech: false, navigation: false},
    runtimeRealtimeSession: false,
    allowLegacyOtaFallback: false,
  })
})

it("preserves legacy overrides when restoring an existing consumer login after upgrade", () => {
  const persistence: DeploymentStorage = {load: () => null, save: jest.fn(), remove: jest.fn()}
  const store = new DeploymentStore(persistence)
  engine.settings.setManyLocal({cloud_core_url: "http://localhost:3000"})
  store.restoreConsumerSessionSelection()
  expect(store.isResolved()).toBe(true)
  expect(resolveDeploymentManifest(store.getActive()).services.coreUrl).toBe("http://localhost:3000")

  store.beginWorkspaceSelection()
  store.restoreConsumerSessionSelection()
  expect(store.isResolved()).toBe(false)
})
