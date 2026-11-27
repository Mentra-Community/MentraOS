import {loadAuthoringMiniapp} from "./loadAuthoringMiniapp"

const mockInstall = jest.fn(),
  mockRefresh = jest.fn(),
  mockStart = jest.fn(),
  mockForeground = jest.fn(),
  mockPermissions = jest.fn(),
  mockSuperMode = jest.fn()
let mockRunning = false
const app = {packageName: "com.mentra.notes", version: "dev-1800000000000"}
jest.mock("@mentra/engine", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  engine: {
    settings: {get: () => mockSuperMode()},
    miniapps: {
      install: (...args: unknown[]) => mockInstall(...args),
      refresh: () => mockRefresh(),
      list: () => [{...app, running: mockRunning}],
      start: (...args: unknown[]) => mockStart(...args),
      setForeground: (...args: unknown[]) => mockForeground(...args),
    },
  },
}))
jest.mock("@/utils/PermissionsUtils", () => ({checkPermissionsUI: (...args: unknown[]) => mockPermissions(...args)}))

const miniappUrl = "http://127.0.0.1:3000/2f1c/"
const link = (url = miniappUrl) => `com.mentra://test/load-miniapp?${new URLSearchParams({url})}`

beforeEach(() => {
  jest.clearAllMocks()
  mockSuperMode.mockReturnValue(true)
  mockRunning = false
  mockInstall.mockResolvedValue({status: "installed", ...app})
  mockPermissions.mockResolvedValue([])
  mockStart.mockResolvedValue(true)
})

it("installs the miniapp a local address serves, as a development build, without the install sheet, and opens it", async () => {
  expect(await loadAuthoringMiniapp(link())).toEqual(app)
  expect(mockInstall).toHaveBeenCalledWith(miniappUrl, {source: "local"})
  expect(mockInstall.mock.invocationCallOrder[0]).toBeLessThan(mockRefresh.mock.invocationCallOrder[0])
  expect(mockRefresh.mock.invocationCallOrder[0]).toBeLessThan(mockStart.mock.invocationCallOrder[0])
  expect(mockStart.mock.invocationCallOrder[0]).toBeLessThan(mockForeground.mock.invocationCallOrder[0])
  expect(mockForeground).toHaveBeenCalledWith(app.packageName)
})

it("brings a running copy to the front: the install restarted it on the new build", async () => {
  mockRunning = true
  expect(await loadAuthoringMiniapp(link())).toEqual(app)
  expect(mockStart).not.toHaveBeenCalled()
  expect(mockForeground).toHaveBeenCalledWith(app.packageName)
})

it.each([
  link("https://notes.example.com/"),
  link("file:///tmp/app/"),
  `${link()}&url=http%3A%2F%2F127.0.0.1%3A4000%2F`,
  "com.mentra://test/load-miniapp",
  link().replace("com.mentra:", "https:"),
])("rejects anything but one local miniapp URL before installing: %s", async (input) => {
  await expect(loadAuthoringMiniapp(input)).rejects.toThrow()
  expect(mockInstall).not.toHaveBeenCalled()
})

it("does not open a failed installation or a miniapp needing permissions", async () => {
  mockInstall.mockRejectedValueOnce(new Error("bundle identity mismatch"))
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("identity mismatch")
  expect(mockStart).not.toHaveBeenCalled()
  mockPermissions.mockResolvedValue(["microphone"])
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("microphone")
  expect(mockForeground).not.toHaveBeenCalled()
})

it("refuses normal-mode requests before installing", async () => {
  mockSuperMode.mockReturnValue(false)
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("Super Mode")
  expect(mockInstall).not.toHaveBeenCalled()
})

it("rejects overlap without another install and releases the guard after failure", async () => {
  let fail!: (error: Error) => void
  mockInstall.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
  const first = loadAuthoringMiniapp(link())
  await Promise.resolve()
  await expect(loadAuthoringMiniapp(link())).rejects.toThrow("already in progress")
  expect(mockInstall).toHaveBeenCalledTimes(1)
  fail(new Error("download failed"))
  await expect(first).rejects.toThrow("download failed")
  await expect(loadAuthoringMiniapp(link())).resolves.toEqual(app)
})
