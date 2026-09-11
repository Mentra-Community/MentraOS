const packageJson = require("../../../package.json")
const {applyBluetoothSdkInfoPlist, INFO_SDK_VERSION, INFO_ANALYTICS_ENVIRONMENT} = require("../withIos")

describe("Bluetooth SDK iOS config", () => {
  it("stamps the package version into Info.plist for workspace builds", () => {
    const infoPlist = applyBluetoothSdkInfoPlist({}, undefined)

    expect(infoPlist[INFO_SDK_VERSION]).toBe(packageJson.version)
  })

  it("preserves analytics configuration while stamping the SDK version", () => {
    const infoPlist = applyBluetoothSdkInfoPlist(
      {
        MentraBluetoothSdkPostHogApiKey: "stale-key",
        MentraBluetoothSdkPostHogHost: "https://stale.example.com",
      },
      {analytics: false},
    )

    expect(infoPlist).toMatchObject({
      [INFO_SDK_VERSION]: packageJson.version,
      MentraBluetoothSdkAnalyticsDisabled: true,
    })
    expect(infoPlist).not.toHaveProperty("MentraBluetoothSdkPostHogApiKey")
    expect(infoPlist).not.toHaveProperty("MentraBluetoothSdkPostHogHost")
  })

  it("stamps the host environment and clears a stale one when unset", () => {
    const stamped = applyBluetoothSdkInfoPlist({}, {analytics: {environment: "Staging"}})
    expect(stamped[INFO_ANALYTICS_ENVIRONMENT]).toBe("staging")
    expect(stamped).not.toHaveProperty("MentraBluetoothSdkAnalyticsDisabled")

    const cleared = applyBluetoothSdkInfoPlist({[INFO_ANALYTICS_ENVIRONMENT]: "prod"}, {analytics: true})
    expect(cleared).not.toHaveProperty(INFO_ANALYTICS_ENVIRONMENT)
    expect(cleared.MentraBluetoothSdkAnalyticsDisabled).toBe(false)
  })
})
