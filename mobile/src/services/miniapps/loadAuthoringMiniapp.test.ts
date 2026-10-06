import {loadAuthoringMiniapp} from "./loadAuthoringMiniapp"

const mockStop = jest.fn(),
  mockInstall = jest.fn(),
  mockRefresh = jest.fn(),
  mockStart = jest.fn(),
  mockForeground = jest.fn(),
  mockPermissions = jest.fn()
let mockInstalledVersion = "1.0.27"
let mockSelectedSnapshot: string | null = null
let mockActiveVersion: string | undefined = "1.0.27"
const mockDiscard = jest.fn(), mockRestore = jest.fn(), mockAllowed = jest.fn(), mockSelect = jest.fn()
const mockReplaceSurface = jest.fn()
const mockReleaseVersions = jest.fn()
jest.mock("@/stores/miniappLaunch", () => ({useMiniappPresentationStore: {getState: () => ({replaceSurface: mockReplaceSurface})}}))
const mockSuperMode = jest.fn()
const app = {packageName: "com.mentra.notes", version: "1.0.27"}
jest.mock("@mentra/engine", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  engine: {
    settings: {get: () => mockSuperMode()},
    miniapps: {
      stop: (...args: unknown[]) => mockStop(...args),
      refresh: () => mockRefresh(),
      list: () => [{...app, version: mockInstalledVersion}],
      start: (...args: unknown[]) => mockStart(...args),
      setForeground: (...args: unknown[]) => mockForeground(...args),
    },
  },
}))
jest.mock("@mentra/engine-host-internal", () => ({
  isDevMiniappAllowed: (...args: unknown[]) => mockAllowed(...args),
  appRegistry: {installFromUrl: (...args: unknown[]) => mockInstall(...args), getActiveVersion: async () => mockActiveVersion,
    retainDevVersions: () => mockReleaseVersions, getSelectedDevSnapshot: () => mockSelectedSnapshot, selectDevSnapshot: (...args: unknown[]) => mockSelect(...args),
    discardDevSnapshot: (...args: unknown[]) => mockDiscard(...args), setActiveVersion: (...args: unknown[]) => mockRestore(...args), gcDevVersions: jest.fn()},
}))
jest.mock("@/utils/PermissionsUtils", () => ({checkPermissionsUI: (...args: unknown[]) => mockPermissions(...args)}))
const link = (url = "http://127.0.0.1:3000/bundle.zip") =>
  `com.mentra://test/load-miniapp?${new URLSearchParams({url, package: app.packageName, version: app.version})}`
beforeEach(() => {
  jest.clearAllMocks()
  mockSuperMode.mockReturnValue(true)
  mockInstalledVersion = app.version
  mockSelectedSnapshot = null
  mockActiveVersion = app.version
  mockAllowed.mockReturnValue(true)
  mockRestore.mockReturnValue({is_error: () => false})
  mockInstall.mockImplementation(async (_url, options) => {mockInstalledVersion = options.versionOverride; return {is_error: () => false}})
  mockPermissions.mockResolvedValue([])
  mockStart.mockResolvedValue(true)
})
it("replaces the exact package and opens it through the normal lifecycle", async () => {
  expect(await loadAuthoringMiniapp(link())).toEqual(app)
  expect(mockInstall).toHaveBeenCalledWith("http://127.0.0.1:3000/bundle.zip", expect.objectContaining({
    expectedPackageName: app.packageName,
    expectedVersion: app.version,
    versionOverride: expect.stringMatching(/^dev-/),
    releaseIdentity: {source: "dev_snapshot"},
  }))
  expect(mockInstall.mock.invocationCallOrder[0]).toBeLessThan(mockStop.mock.invocationCallOrder[0])
  expect(mockRefresh.mock.invocationCallOrder[0]).toBeLessThan(mockStart.mock.invocationCallOrder[0])
  expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(mockForeground.mock.invocationCallOrder[0])
  expect(mockSelect).toHaveBeenCalledWith(app.packageName, expect.stringMatching(/^dev-/))
  expect(mockForeground).toHaveBeenCalledWith(app.packageName)
})
it.each([
  link("file:///tmp/app.zip"),
  link("https://user:password@example.com/app.zip"),
  link() + "&package=other",
  link().replace("com.mentra:", "https:"),
])("rejects malformed input before stopping anything: %s", async (input) => {
  await expect(loadAuthoringMiniapp(input)).rejects.toThrow()
  expect(mockStop).not.toHaveBeenCalled()
})
it("does not open a failed installation or a launch needing permissions", async () => {
  mockInstall.mockResolvedValue({is_error: () => true, error: new Error("bundle identity mismatch")})
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("identity mismatch")
  expect(mockStart).not.toHaveBeenCalled()
  mockInstall.mockImplementation(async (_url, options) => {mockInstalledVersion = options.versionOverride; return {is_error: () => false}})
  mockPermissions.mockResolvedValue(["microphone"])
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("microphone")
  expect(mockForeground).not.toHaveBeenCalled()
})

it("refuses normal-mode install requests before stopping or installing", async () => {
  mockSuperMode.mockReturnValue(false)
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("Super Mode")
  expect(mockStop).not.toHaveBeenCalled()
  expect(mockInstall).not.toHaveBeenCalled()
})

it("rejects overlap without another stop or install and releases the guard after failure", async () => {
  let fail!: (error: Error) => void
  mockInstall.mockReturnValueOnce(new Promise((_, reject) => {fail = reject}))
  const first = loadAuthoringMiniapp(link())
  await Promise.resolve()
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("already in progress")
  expect(mockStop).not.toHaveBeenCalled()
  fail(new Error("download failed"))
  await expect(first).rejects.toThrow("download failed")
  await expect(loadAuthoringMiniapp(link())).resolves.toEqual(app)
  expect(mockReplaceSurface).toHaveBeenCalledWith(app.packageName)
})

it("refuses a deployment-disallowed package before installing or stopping", async () => {
  mockAllowed.mockReturnValue(false)
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("deployment")
  expect(mockInstall).not.toHaveBeenCalled()
  expect(mockStop).not.toHaveBeenCalled()
})
it("a failed download keeps the previous miniapp running and its selected version", async () => {
  mockInstall.mockRejectedValueOnce(new Error("download failed"))
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("download failed")
  expect(mockStop).not.toHaveBeenCalled()
  expect(mockRestore).toHaveBeenCalledWith(app.packageName, app.version)
  expect(mockDiscard).toHaveBeenCalledWith(app.packageName, expect.stringMatching(/^dev-/))
  expect(mockSelect).toHaveBeenCalledWith(app.packageName, null)
  expect(mockReleaseVersions).toHaveBeenCalled()
})

it("restores the prior packed-source selection when replacement fails", async () => {
  mockSelectedSnapshot = "dev-1000-a"
  mockInstall.mockRejectedValueOnce(new Error("download failed"))
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("download failed")
  expect(mockSelect).toHaveBeenCalledWith(app.packageName, "dev-1000-a")
})

it("retains rollback versions through a deferred download and releases after completion", async () => {
  let finish!: (value: unknown) => void
  mockInstall.mockReturnValueOnce(new Promise(resolve => {finish = resolve}))
  const pending = loadAuthoringMiniapp(link())
  await Promise.resolve()
  expect(mockReleaseVersions).not.toHaveBeenCalled()
  finish({is_error: () => true, error: new Error("failed")})
  await expect(pending).rejects.toThrow("failed")
  expect(mockReleaseVersions).toHaveBeenCalledTimes(1)
})

it("loads a never-installed or scanned-only package without a previous version", async () => {
  mockActiveVersion = undefined
  await expect(loadAuthoringMiniapp(link())).resolves.toEqual(app)
  expect(mockInstall).toHaveBeenCalled()
})
