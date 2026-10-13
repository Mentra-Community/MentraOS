import {DeviceEventEmitter, Platform} from "react-native"
import {fetchVersionInfo} from "../../modules/engine/src/services/OtaUpdateCheckService"
import {observeManifestNativeErrors} from "../../modules/engine/src/services/otaNativeNetworkDiagnostics"
import {logBuffer} from "../../modules/engine/src/utils/devLogging"

const marker = "OTA: native network failure observation "

describe("Android native manifest-window diagnostics", () => {
  const originalPlatform = Platform.OS
  const originalFetch = global.fetch
  let log: jest.SpyInstance
  let warn: jest.SpyInstance
  let stop: (() => void) | undefined
  const events = () =>
    log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith(marker))
      .map((message) => JSON.parse(message.slice(marker.length)))

  beforeEach(() => {
    Platform.OS = "android"
    log = jest.spyOn(console, "log").mockImplementation(() => {})
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    Platform.OS = originalPlatform
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it.each([
    ["Unable to resolve host private.example: No address associated with hostname", undefined, "dns"],
    ["java.net.UnknownHostException: private.example", undefined, "dns"],
    ["Failed to connect to private.example/192.0.2.1:443", undefined, "connect"],
    ["ECONNREFUSED (Connection refused)", undefined, "connect"],
    ["Network is unreachable", undefined, "connect"],
    ["SSLHandshakeException: secret certificate", undefined, "tls"],
    ["java.security.cert.CertPathValidatorException: Trust anchor for certification path not found", undefined, "tls"],
    ["Handshake failed", undefined, "tls"],
    ["timeout", undefined, "timeout"],
    ["read timed out", undefined, "timeout"],
    ["other private error", true, "timeout"],
    ["unexpected private error https://private.example?token=secret", false, "other"],
  ] as const)("classifies native completion errors without retaining %s", (message, timeout, category) => {
    stop = observeManifestNativeErrors(7, Date.now() - 10)
    DeviceEventEmitter.emit(
      "didCompleteNetworkResponse",
      timeout === undefined ? [42, message] : [42, message, timeout],
    )
    expect(events()).toEqual([
      expect.objectContaining({
        manifestRequestId: 7,
        nativeRequestId: 42,
        correlation: "unavailable",
        category,
        observedAtMs: expect.any(Number),
        elapsedMs: expect.any(Number),
      }),
    ])
    expect(events()[0]).not.toHaveProperty("message")
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private\.example|192\.0\.2\.1|secret/)
  })

  it("ignores successful and malformed payloads", () => {
    stop = observeManifestNativeErrors(7, Date.now())
    for (const payload of [
      null,
      {},
      [],
      [42, null],
      [42, ""],
      ["42", "timeout"],
      [-1, "timeout"],
      [42, "timeout", "true"],
      [42, "timeout", true, "extra"],
    ]) {
      DeviceEventEmitter.emit("didCompleteNetworkResponse", payload)
    }
    expect(events()).toEqual([])
  })

  it("does not subscribe on iOS", () => {
    Platform.OS = "ios"
    const subscribe = jest.spyOn(DeviceEventEmitter, "addListener")
    stop = observeManifestNativeErrors(7, Date.now())
    expect(subscribe).not.toHaveBeenCalled()
  })

  it.each(["success", "fetch-failure", "http-failure", "body-failure"])(
    "removes its own listener after %s without removing others",
    async (outcome) => {
      const other = jest.fn()
      const otherSubscription = DeviceEventEmitter.addListener("didCompleteNetworkResponse", other)
      const before = DeviceEventEmitter.listenerCount("didCompleteNetworkResponse")
      const json = {versionCode: 123}
      global.fetch = jest.fn(() => {
        expect(DeviceEventEmitter.listenerCount("didCompleteNetworkResponse")).toBe(before + 1)
        DeviceEventEmitter.emit("didCompleteNetworkResponse", [42, "Unable to resolve host private.example"])
        if (outcome === "fetch-failure") return Promise.reject(new TypeError("Network request failed"))
        return Promise.resolve({
          ok: outcome !== "http-failure",
          status: outcome === "http-failure" ? 503 : 200,
          json: () =>
            outcome === "body-failure" ? Promise.reject(new SyntaxError("invalid JSON")) : Promise.resolve(json),
        })
      }) as unknown as typeof fetch
      try {
        expect(await fetchVersionInfo("https://private.example?token=secret")).toEqual(
          outcome === "success" ? json : null,
        )
        expect(DeviceEventEmitter.listenerCount("didCompleteNetworkResponse")).toBe(before)
        expect(events()).toHaveLength(1)
        DeviceEventEmitter.emit("didCompleteNetworkResponse", [43, "timeout"])
        expect(events()).toHaveLength(1)
        expect(other).toHaveBeenCalledTimes(2)
      } finally {
        otherSubscription.remove()
      }
    },
  )

  it("subscription failure does not prevent normal fetch", async () => {
    jest.spyOn(DeviceEventEmitter, "addListener").mockImplementation(() => {
      throw new Error("event unavailable")
    })
    const json = {versionCode: 123}
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve(json)}),
    ) as unknown as typeof fetch
    expect(await fetchVersionInfo("https://example.test/manifest")).toBe(json)
  })

  it("listener and cleanup failures cannot replace a manifest result", async () => {
    let callback: ((payload: unknown) => void) | undefined
    const remove = jest.fn(() => {
      throw new Error("cleanup unavailable")
    })
    jest.spyOn(DeviceEventEmitter, "addListener").mockImplementation((_name, listener) => {
      callback = listener
      return {remove}
    })
    log.mockImplementation((message) => {
      if (String(message).startsWith(marker)) throw new Error("log unavailable")
    })
    const json = {versionCode: 123}
    global.fetch = jest.fn(() => {
      expect(() => callback?.([42, "timeout", true])).not.toThrow()
      return Promise.resolve({ok: true, json: () => Promise.resolve(json)})
    }) as unknown as typeof fetch
    expect(await fetchVersionInfo("https://example.test/manifest")).toBe(json)
    expect(remove).toHaveBeenCalledTimes(1)
    log.mockClear()
    callback?.([43, "timeout", true])
    expect(log).not.toHaveBeenCalled()
  })

  it("retains one redacted JSON line in the actual incident phone buffer", () => {
    const originals = {...console}
    logBuffer.clear()
    try {
      logBuffer.startConsoleInterception()
      stop = observeManifestNativeErrors(7, Date.now())
      DeviceEventEmitter.emit("didCompleteNetworkResponse", [42, "Unable to resolve host private.example?token=secret"])
      const entries = logBuffer.getRecentLogs().filter(({message}) => message.startsWith(marker))
      expect(entries).toHaveLength(1)
      expect(entries[0].message).not.toMatch(/private|secret|\n/)
      expect(JSON.parse(entries[0].message.slice(marker.length))).toEqual(
        expect.objectContaining({category: "dns", correlation: "unavailable"}),
      )
    } finally {
      Object.assign(console, originals)
    }
  })
})
