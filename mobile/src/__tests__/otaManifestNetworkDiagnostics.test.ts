import {fetchVersionInfo} from "../../modules/engine/src/services/OtaUpdateCheckService"
import type {NetworkDiagnostics} from "../../modules/bluetooth-sdk/src/ota-transport"
import {mentraLocalNetworkMock} from "../test-utils/mockBluetoothSdk"
import {logBuffer} from "../../modules/engine/src/utils/devLogging"

describe("OTA manifest network observations", () => {
  const originalFetch = global.fetch
  const network: NetworkDiagnostics = {
    sampledAtMs: 123,
    processBound: {present: false, capabilities: null},
    activeNetwork: {
      present: true,
      capabilities: {
        wifi: true,
        cellular: false,
        ethernet: false,
        vpn: false,
        internet: true,
        validated: true,
        captivePortal: false,
      },
    },
    glassesLocal: {present: false, capabilities: null},
    processBoundMatchesActive: false,
    processBoundMatchesGlassesLocal: false,
    activeNetworkMatchesGlassesLocal: false,
  }
  let log: jest.SpyInstance
  let warn: jest.SpyInstance
  const observations = () =>
    log.mock.calls.map(([message]) => JSON.parse(String(message).split("OTA: manifest network observation ")[1]))

  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation(() => {})
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mentraLocalNetworkMock.getNetworkDiagnostics.mockReset()
    mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(network)
  })
  afterEach(() => {
    global.fetch = originalFetch
    log.mockRestore()
    warn.mockRestore()
    mentraLocalNetworkMock.getNetworkDiagnostics.mockReset()
  })

  it("collects the native observation before starting fetch and excludes the URL", async () => {
    const url = "https://example.test/manifest?token=private"
    const json = {apps: []}
    global.fetch = jest.fn(() => {
      expect(mentraLocalNetworkMock.getNetworkDiagnostics).toHaveBeenCalledTimes(1)
      expect(observations()).toEqual([expect.objectContaining({stage: "start", network, observation: "collected"})])
      return Promise.resolve({ok: true, json: () => Promise.resolve(json)})
    }) as unknown as typeof fetch

    expect(await fetchVersionInfo(url)).toBe(json)
    expect(JSON.stringify(log.mock.calls)).not.toContain("private")
    expect(mentraLocalNetworkMock.getNetworkDiagnostics).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["fetch-failed", () => Promise.reject(new Error("fetch failed")), undefined],
    ["http-failed", () => Promise.resolve({ok: false, status: 503}), 503],
    [
      "body-failed",
      () => Promise.resolve({ok: true, status: 200, json: () => Promise.reject(new Error("body failed"))}),
      200,
    ],
  ] as const)("records a fresh %s observation while preserving the failure result", async (stage, response, status) => {
    global.fetch = jest.fn(response) as unknown as typeof fetch
    expect(await fetchVersionInfo("https://example.test/manifest")).toBeNull()
    expect(mentraLocalNetworkMock.getNetworkDiagnostics).toHaveBeenCalledTimes(2)
    expect(observations().at(-1)).toEqual(expect.objectContaining({stage, network}))
    expect(observations().at(-1).status).toBe(status)
  })

  it("native getter rejection cannot change a successful fetch", async () => {
    mentraLocalNetworkMock.getNetworkDiagnostics.mockImplementation(() => {
      throw new Error("native unavailable")
    })
    const json = {apps: []}
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve(json)}),
    ) as unknown as typeof fetch
    expect(await fetchVersionInfo("https://example.test/manifest")).toBe(json)
    expect(observations()).toEqual([expect.objectContaining({stage: "start", observation: "native-read-failed"})])
  })

  it("native getter rejection cannot suppress the existing fetch failure", async () => {
    mentraLocalNetworkMock.getNetworkDiagnostics.mockImplementation(() => {
      throw new Error("native unavailable")
    })
    const failure = new Error("fetch failed")
    global.fetch = jest.fn(() => Promise.reject(failure)) as unknown as typeof fetch
    expect(await fetchVersionInfo("https://example.test/manifest")).toBeNull()
    expect(warn).toHaveBeenCalledWith("OTA: Error fetching version info:", failure)
    expect(observations().at(-1)).toEqual(
      expect.objectContaining({stage: "fetch-failed", observation: "native-read-failed"}),
    )
  })

  it("reports a missing native module explicitly instead of implying a healthy route", async () => {
    mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(null)
    global.fetch = jest.fn(() =>
      Promise.resolve({ok: true, json: () => Promise.resolve({})}),
    ) as unknown as typeof fetch
    await fetchVersionInfo("https://example.test/manifest")
    expect(observations()).toEqual([expect.objectContaining({observation: "native-module-unavailable", network: null})])
  })

  it("retains the complete JSON line in the actual phone incident log buffer", async () => {
    const originals = {...console}
    logBuffer.clear()
    try {
      logBuffer.startConsoleInterception()
      global.fetch = jest.fn(() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch
      await fetchVersionInfo("https://example.test/manifest?token=private")
      const entries = logBuffer
        .getRecentLogs()
        .filter(({message}) => message.startsWith("OTA: manifest network observation "))
      expect(entries).toHaveLength(2)
      expect(entries.every(({message}) => !message.includes("\n") && !message.includes("private"))).toBe(true)
      expect(
        entries.map(({message}) => JSON.parse(message.slice("OTA: manifest network observation ".length))),
      ).toEqual([
        expect.objectContaining({stage: "start", network}),
        expect.objectContaining({stage: "fetch-failed", network}),
      ])
    } finally {
      Object.assign(console, originals)
    }
  })
})
