import {installNativeLogConsole, installSdkUpdateNotice, nativeLogMessage} from "../_private/nativeLogConsole"

describe("native diagnostics in the JS console", () => {
  const listeners = new Set<(event: {message: string}) => void>()
  const source = {
    addListener: (_event: "log", listener: (event: {message: string}) => void) => {
      listeners.add(listener)
      return {remove: () => listeners.delete(listener)}
    },
  }

  afterEach(() => {
    listeners.clear()
    jest.restoreAllMocks()
  })

  it.each(["android", "ios"])("forwards %s diagnostics once after repeated installation", (platform) => {
    installNativeLogConsole(source, platform)
    installNativeLogConsole(source, platform)
    // Hosts can install console interception after importing the SDK.
    const output = jest.spyOn(console, "log").mockImplementation(() => {})
    listeners.forEach((listener) => listener({message: "MTU negotiation failed"}))
    expect(listeners.size).toBe(1)
    expect(output).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalledWith(`[native:${platform}]`, "MTU negotiation failed")
  })

  it.each([
    "access_token=private-value",
    "refreshToken: private-value",
    'payload: {"password":"private-value"}',
    "Authorization: Bearer private-value",
    "Secret key is: private-value",
    "Authorization: Basic private-value",
  ])("redacts credentials before console and report capture: %s", (message) => {
    expect(nativeLogMessage(message)).toBe("[REDACTED]")
  })

  it("preserves useful diagnostics and bounds oversized messages", () => {
    expect(nativeLogMessage("[E/MentraLive] MTU negotiation failed")).toBe("[E/MentraLive] MTU negotiation failed")
    expect(nativeLogMessage("x".repeat(20_000))).toHaveLength(16_384)
  })
})

describe("SDK update notice in the JS console", () => {
  const listeners = new Set<(event: {message: string}) => void>()
  const source = {
    addListener: (_event: "sdk_update_notice", listener: (event: {message: string}) => void) => {
      listeners.add(listener)
      return {remove: () => listeners.delete(listener)}
    },
  }

  afterEach(() => {
    listeners.clear()
    jest.restoreAllMocks()
  })

  it("warns once with the native banner after repeated installation", () => {
    installSdkUpdateNotice(source)
    installSdkUpdateNotice(source)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const banner = "MENTRA BLUETOOTH SDK UPDATE AVAILABLE\n  Installed: 3.1.0    Latest: 3.2.1"
    listeners.forEach((listener) => listener({message: banner}))
    expect(listeners.size).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(banner)
  })
})
