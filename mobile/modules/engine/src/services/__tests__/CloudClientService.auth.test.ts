import {afterEach, beforeEach, describe, expect, it, mock} from "bun:test"

import type {CloudEndpoints} from "../cloudEndpointPolicy"

const production = {core: "https://core.example", runtime: "https://runtime.example"}
const development = {core: "https://core.dev.example", runtime: "https://runtime.dev.example"}
let configuredEndpoints: CloudEndpoints = production
const clients: FakeCloudClient[] = []
const unsubscribe = () => () => {}
const status = {status: "disconnected", audioTransport: "none"}

class FakeCloudClient {
  auth: {
    identity: {mentraUserId: string; tenantId: string}
    getMiniappToken: (packageName: string) => Promise<{token: string; expiresAt: number}>
  }
  runtime = {
    close: mock(() => {}),
    onStatusChanged: unsubscribe,
    onTranscript: unsubscribe,
    onTranslation: unsubscribe,
    onConnected: unsubscribe,
    onDisconnected: unsubscribe,
    onError: unsubscribe,
    getStatus: () => status,
  }

  constructor({endpoints}: {endpoints: CloudEndpoints}) {
    this.auth = {
      identity: {mentraUserId: "mu_test", tenantId: "mentra"},
      getMiniappToken: async (packageName) => ({token: `${endpoints.core}/${packageName}`, expiresAt: 2_000_000_000}),
    }
    clients.push(this)
  }
}

mock.module("@mentra/cloud-client/react-native", () => ({
  CloudClient: FakeCloudClient,
  setNativeHttp: () => {},
  setNativeUdp: () => {},
  setSecureStorage: () => {},
}))
mock.module("@mentra/cloud-client", () => ({DEFAULT_REFRESH_TOKEN_KEY: "test-refresh"}))
mock.module("react-native", () => ({Platform: {OS: "ios"}}))
mock.module("@mentra/bluetooth-sdk/internal", () => ({default: {}}))
mock.module("@mentra/crust", () => ({default: {}}))
mock.module("../../runtime/bootstrap", () => ({
  getAuth: () => ({getRuntimeToken: async () => "runtime-token", getSubjectToken: async () => ({token: "subject"})}),
  getConfigValues: () => ({resolveCloudEndpoints: () => configuredEndpoints, runtimeRealtimeSession: false}),
  isFeatureEnabled: () => false,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {lc3_frame_size: {key: "lc3_frame_size"}},
  useSettingsStore: {getState: () => ({getSetting: () => 20})},
}))
mock.module("../../utils/cloudClient/RnUdpAdapter", () => ({createCloudUdpSocket: () => {}}))
mock.module("../../utils/cloudClient/cloudSecureStore", () => ({cloudSecureStore: {}}))
mock.module("../../utils/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), remove: () => ({is_error: () => false})},
}))
mock.module("../../stores/cloudClientStatus", () => ({
  useCloudClientStatusStore: {getState: () => ({...status, setSnapshot: () => {}, reset: () => {}})},
}))
mock.module("../NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../../utils/timers", () => ({BgTimer: {setTimeout, clearTimeout, setInterval, clearInterval}}))
mock.module("../CloudTranscriptE2EMetrics", () => ({logCloudV2TranscriptMetric: () => {}}))

const {cloudClientService} = await import("../CloudClientService")

function pauseMint() {
  let complete!: (result: {token: string; expiresAt: number}) => void
  const pending = new Promise<{token: string; expiresAt: number}>((resolve) => {
    complete = resolve
  })
  clients.at(-1)!.auth.getMiniappToken = () => pending
  return () => complete({token: "previous-client-token", expiresAt: 2_000_000_000})
}

beforeEach(() => {
  configuredEndpoints = production
  clients.length = 0
  cloudClientService.reconnect(null)
})
afterEach(() => cloudClientService.stop())

describe("miniapp credentials across Core changes", () => {
  it("returns the token with its issuing client's endpoint and normalized expiry", async () => {
    expect(await cloudClientService.getMiniappAuthToken("com.mentra.store")).toEqual({
      mentraUserId: "mu_test",
      tenantId: "mentra",
      coreUrl: production.core,
      token: `${production.core}/com.mentra.store`,
      expiresAt: 2_000_000_000_000,
    })
  })

  it("keeps the constructed endpoint if host configuration changes before reconnecting", async () => {
    configuredEndpoints = development
    const auth = await cloudClientService.getMiniappAuthToken("com.mentra.store")
    expect(auth.coreUrl).toBe(production.core)
    expect(auth.token).toBe(`${production.core}/com.mentra.store`)
  })

  it("rejects an old mint after reconnect and obtains subsequent credentials from the new client", async () => {
    const complete = pauseMint()
    const pending = cloudClientService.getMiniappAuthToken("com.mentra.store")
    cloudClientService.reconnect(development)
    complete()
    await expect(pending).rejects.toThrow("cloud client changed while obtaining miniapp credentials")

    const auth = await cloudClientService.getMiniappAuthToken("com.mentra.store")
    expect(auth.coreUrl).toBe(development.core)
    expect(auth.token).toBe(`${development.core}/com.mentra.store`)
  })

  it("rejects an in-flight mint after the engine stops", async () => {
    const complete = pauseMint()
    const pending = cloudClientService.getMiniappAuthToken("com.mentra.store")
    cloudClientService.stop()
    complete()
    await expect(pending).rejects.toThrow("cloud client changed while obtaining miniapp credentials")
  })
})
