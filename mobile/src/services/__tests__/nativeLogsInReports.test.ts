import {installNativeLogConsole} from "../../../modules/bluetooth-sdk/src/_private/nativeLogConsole"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import {logBuffer} from "../../../modules/engine/src/utils/devLogging"

jest.mock("../../../modules/engine/src/services/CloudClientService", () => ({
  cloudClientService: {
    core: {
      reports: {
        submit: jest.fn(async () => ({reportId: "combined-logs", status: "open"})),
        addLogs: jest.fn(async () => ({stored: 1})),
        complete: jest.fn(async () => ({status: "complete"})),
      },
    },
    hasCore: () => true,
    getCoreUrl: () => "https://core.example",
    syncCoreTokenToBluetooth: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/utils/diagnosticContext", () => ({
  collectDiagnosticContext: async () => ({}),
}))

describe("combined JS and native incident logs", () => {
  const originalConsole = {...console}

  beforeAll(() => {
    console.log = jest.fn()
    logBuffer.startConsoleInterception()
  })

  afterAll(() => Object.assign(console, originalConsole))

  it.each(["android", "ios"])("uploads the %s live console stream once in the phone artifact", async (platform) => {
    logBuffer.clear()
    const addLogs = cloudClientService.core.reports.addLogs as jest.Mock
    addLogs.mockClear()
    let emit: (event: {message: string}) => void = () => {}
    installNativeLogConsole(
      {
        addListener: (_event, listener) => {
          emit = listener
          return {remove() {}}
        },
      },
      platform,
    )

    console.log("JS: requesting connection")
    emit({message: "[E/MentraLive] MTU negotiation failed"})
    emit({message: "access_token=private-value"})

    await expect(
      submitAutomaticReport({
        kind: "automatic",
        trigger: {type: "automatic", source: "system", reason: "test"},
        report: {actualBehavior: "Connection failed", systemPriority: "medium"},
      }),
    ).resolves.toMatchObject({status: "submitted"})

    expect(addLogs).toHaveBeenCalledTimes(1)
    const [reportId, source, entries] = addLogs.mock.calls[0]
    expect(reportId).toBe("combined-logs")
    expect(source).toBe("phone")
    expect(entries.map((entry: {message: string}) => entry.message)).toEqual([
      "JS: requesting connection",
      `[native:${platform}] [E/MentraLive] MTU negotiation failed`,
      `[native:${platform}] [REDACTED]`,
    ])
    expect(JSON.stringify(entries)).not.toContain("private-value")
  })
})
