const mockSettings: Record<string, boolean> = {}
let mockDeploymentAllowsTelemetry = true
const mockFirebase = {
  setAnalyticsCollectionEnabled: jest.fn<Promise<void>, [boolean]>(),
  logEvent: jest.fn(),
  logScreenView: jest.fn(),
  setUserId: jest.fn(),
  setUserProperty: jest.fn(),
}

jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    china_deployment: {key: "china_deployment"},
    telemetry_enabled: {key: "telemetry_enabled"},
  },
  engine: {settings: {get: (key: string) => mockSettings[key]}},
}))
jest.mock("@/services/deployment", () => ({
  deploymentStore: {isTelemetryAllowed: () => mockDeploymentAllowsTelemetry},
}))
jest.mock("@react-native-firebase/analytics", () => ({__esModule: true, default: () => mockFirebase}))

let analytics: typeof import("./analytics")

beforeEach(() => {
  jest.clearAllMocks()
  mockFirebase.setAnalyticsCollectionEnabled.mockResolvedValue(undefined)
  mockSettings.china_deployment = false
  mockSettings.telemetry_enabled = false
  mockDeploymentAllowsTelemetry = true
  jest.isolateModules(() => {
    analytics = require("./analytics")
  })
})

it("overrides Firebase's persisted enabled flag on a cold start without an opt-in", async () => {
  await analytics.disableAnalytics()
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenCalledWith(false)
})

it("does not collect detailed usage or identity until opted in", async () => {
  await analytics.initAnalytics()
  await analytics.logEvent("feature_used")
  await analytics.logScreenView("settings")
  await analytics.setUserId("user-1")
  await analytics.setUserProperty("plan", "free")
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenCalledWith(false)
  expect(mockFirebase.logEvent).not.toHaveBeenCalled()
  expect(mockFirebase.logScreenView).not.toHaveBeenCalled()
  expect(mockFirebase.setUserId).not.toHaveBeenCalled()
  expect(mockFirebase.setUserProperty).not.toHaveBeenCalled()
})

it("enables detailed usage after opt-in and stops it immediately on opt-out", async () => {
  mockSettings.telemetry_enabled = true
  await analytics.initAnalytics()
  await analytics.logEvent("feature_used", {feature: "gallery"})
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(true)
  expect(mockFirebase.logEvent).toHaveBeenCalledWith("feature_used", {feature: "gallery"})

  mockSettings.telemetry_enabled = false
  await analytics.logEvent("after_opt_out")
  await analytics.logScreenView("private_screen")
  await analytics.initAnalytics()
  expect(mockFirebase.logEvent).toHaveBeenCalledTimes(1)
  expect(mockFirebase.logScreenView).not.toHaveBeenCalled()
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(false)
})

it.each(["deployment", "china"])("keeps the %s restriction in force even with a user opt-in", async (restriction) => {
  mockSettings.telemetry_enabled = true
  mockDeploymentAllowsTelemetry = restriction !== "deployment"
  mockSettings.china_deployment = restriction === "china"
  await analytics.initAnalytics()
  await analytics.logEvent("feature_used")
  if (restriction === "china") expect(mockFirebase.setAnalyticsCollectionEnabled).not.toHaveBeenCalled()
  else expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenCalledWith(false)
  expect(mockFirebase.logEvent).not.toHaveBeenCalled()
})

it("disables collection after an in-flight enable finishes", async () => {
  let finishEnable!: () => void
  mockFirebase.setAnalyticsCollectionEnabled.mockImplementationOnce(
    () => new Promise<void>((resolve) => (finishEnable = resolve)),
  )
  mockSettings.telemetry_enabled = true
  const enabling = analytics.initAnalytics()
  await Promise.resolve()
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenCalledWith(true)

  mockSettings.telemetry_enabled = false
  const disabling = analytics.disableAnalytics()
  await analytics.logEvent("during_opt_out")
  finishEnable()
  await Promise.all([enabling, disabling])
  expect(mockFirebase.setAnalyticsCollectionEnabled.mock.calls).toEqual([[true], [false]])
  expect(mockFirebase.logEvent).not.toHaveBeenCalled()
})

it("recovers after a failed native transition", async () => {
  mockFirebase.setAnalyticsCollectionEnabled.mockRejectedValueOnce(new Error("Native failure"))
  mockSettings.telemetry_enabled = true
  await expect(analytics.initAnalytics()).rejects.toThrow("Native failure")
  mockSettings.telemetry_enabled = false
  await analytics.disableAnalytics()
  expect(mockFirebase.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith(false)
})
