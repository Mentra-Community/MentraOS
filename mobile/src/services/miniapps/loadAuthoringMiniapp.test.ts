import {loadAuthoringMiniapp} from "./loadAuthoringMiniapp"

const mockStop = jest.fn(),
  mockInstall = jest.fn(),
  mockRefresh = jest.fn(),
  mockStart = jest.fn(),
  mockForeground = jest.fn(),
  mockPermissions = jest.fn()
const app = {packageName: "com.mentra.notes", version: "1.0.27"}
jest.mock("@mentra/engine", () => ({
  engine: {
    miniapps: {
      stop: (...args: unknown[]) => mockStop(...args),
      refresh: () => mockRefresh(),
      list: () => [app],
      start: (...args: unknown[]) => mockStart(...args),
      setForeground: (...args: unknown[]) => mockForeground(...args),
    },
  },
}))
jest.mock("@mentra/engine-host-internal", () => ({
  appRegistry: {installFromUrl: (...args: unknown[]) => mockInstall(...args)},
}))
jest.mock("@/utils/PermissionsUtils", () => ({checkPermissionsUI: (...args: unknown[]) => mockPermissions(...args)}))
const link = (url = "http://127.0.0.1:3000/bundle.zip") =>
  `com.mentra://test/load-miniapp?${new URLSearchParams({url, package: app.packageName, version: app.version})}`
beforeEach(() => {
  jest.clearAllMocks()
  mockInstall.mockResolvedValue({is_error: () => false})
  mockPermissions.mockResolvedValue([])
  mockStart.mockResolvedValue(true)
})
it("replaces the exact package and opens it through the normal lifecycle", async () => {
  expect(await loadAuthoringMiniapp(link())).toEqual(app)
  expect(mockInstall).toHaveBeenCalledWith("http://127.0.0.1:3000/bundle.zip", {
    expectedPackageName: app.packageName,
    expectedVersion: app.version,
  })
  expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(mockInstall.mock.invocationCallOrder[0])
  expect(mockRefresh.mock.invocationCallOrder[0]).toBeLessThan(mockStart.mock.invocationCallOrder[0])
  expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(mockForeground.mock.invocationCallOrder[0])
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
  mockInstall.mockResolvedValue({is_error: () => false})
  mockPermissions.mockResolvedValue(["microphone"])
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("microphone")
  expect(mockForeground).not.toHaveBeenCalled()
})
