import i18n from "i18next"

import en from "@/i18n/en"

import {
  miniappInstallFailureCopy,
  startListedMiniappInstall,
  startMiniappInstall,
  startMiniappInstallFromLink,
} from "./miniappInstallFlow"

type Confirm = (preview: Record<string, unknown>) => Promise<boolean>
type InstallOptions = {source: string; confirm: Confirm}

const mockInstall = jest.fn<Promise<{status: string; packageName: string; version: string}>, [string, InstallOptions]>()
const mockList = jest.fn(
  (): Array<{packageName: string; name: string; updating?: boolean; foregrounded?: boolean}> => [],
)
const mockStart = jest.fn(async (..._args: unknown[]) => true)
const mockSetForeground = jest.fn(async (..._args: unknown[]) => {})
const mockClearForeground = jest.fn()
jest.mock("@mentra/engine", () => ({
  engine: {
    miniapps: {
      install: (url: string, options: InstallOptions) => mockInstall(url, options),
      list: () => mockList(),
      start: (...args: unknown[]) => mockStart(...args),
      setForeground: (...args: unknown[]) => mockSetForeground(...args),
      clearForeground: () => mockClearForeground(),
    },
  },
}))

const mockConfirm = jest.fn(async (_preview: unknown, _installedName?: string | null) => true)
jest.mock("@/components/miniapps/MiniappInstallSheet", () => ({
  confirmMiniappInstall: (preview: unknown, installedName?: string | null) => mockConfirm(preview, installedName),
}))
const mockShowAlert = jest.fn(async (_alert: {title: string; message?: string}) => 0)
jest.mock("@/contexts/ModalContext", () => ({
  showAlert: (alert: {title: string; message?: string}) => mockShowAlert(alert),
  waitForAlertHost: async () => {},
}))
const mockToast = jest.fn()
jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: {show: (...args: unknown[]) => mockToast(...args)},
}))
const mockOpenBrowser = jest.fn(async (_url: string) => ({type: "opened"}))
jest.mock("expo-web-browser", () => ({openBrowserAsync: (url: string) => mockOpenBrowser(url)}))
const mockGoHome = jest.fn()
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({clearHistoryAndGoHome: mockGoHome})},
}))
let mockDirectoryUrl: string | null = "https://api.apps.example.com/"
jest.mock("@/services/deployment", () => ({
  deploymentStore: {getActive: () => ({manifest: {artifacts: {directoryUrl: mockDirectoryUrl}}})},
}))
const mockAskPermissions = jest.fn(async (..._args: unknown[]) => 1)
jest.mock("@/utils/PermissionsUtils", () => ({askPermissionsUI: (...args: unknown[]) => mockAskPermissions(...args)}))
const mockBlockUpdating = jest.fn((_packageName: string) => false)
jest.mock("@/utils/miniappUpdatingAlert", () => ({blockUpdatingMiniapp: (name: string) => mockBlockUpdating(name)}))

const preview = {
  url: "https://notes.example.com/",
  host: "notes.example.com",
  local: false,
  packageName: "com.example.notes",
  name: "Notes",
  iconUrl: null,
  ageRating: null,
  private: false,
  alreadyInstalled: false,
  missingHardware: [],
}

/** An engine install that asks through `confirm`, then answers. */
function installs(status: "installed" | "opened" = "installed", served = preview) {
  mockInstall.mockImplementation(async (_url, options) => {
    if (status === "installed" && !(await options.confirm(served))) throw installError("cancelled")
    return {status, packageName: served.packageName, version: "1.0.0"}
  })
}

function installError(code: string): Error {
  const error = new Error(`install failed: ${code}`) as Error & {code: string}
  error.name = "InstallMiniappError"
  error.code = code
  return error
}

const lastAlert = () => mockShowAlert.mock.calls.at(-1)?.[0]

beforeAll(async () => {
  await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDirectoryUrl = "https://api.apps.example.com/"
  mockConfirm.mockResolvedValue(true)
  mockList.mockReturnValue([])
  jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  jest.mocked(console.warn).mockRestore()
})

describe("startMiniappInstall", () => {
  it("installs through the engine with the sheet as its confirm, then shows the tile on Home", async () => {
    installs()
    const onPresent = jest.fn()
    await expect(startMiniappInstall("https://Notes.Example.com", "paste", {onPresent})).resolves.toBe("installed")

    expect(mockInstall).toHaveBeenCalledWith("https://notes.example.com/", expect.objectContaining({source: "paste"}))
    expect(mockConfirm).toHaveBeenCalledWith(preview, null)
    expect(onPresent).toHaveBeenCalledTimes(1)
    expect(mockGoHome).toHaveBeenCalled()
    expect(mockToast.mock.calls).toEqual([
      [{type: "info", text1: "Installing Notes…"}],
      [{type: "success", text1: "Notes is on your Home screen"}],
    ])
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  it("names the installed copy on the sheet, which can be a development build under another name", async () => {
    installs("installed", {...preview, alreadyInstalled: true})
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes Dev"}])
    await startMiniappInstall("https://notes.example.com/", "paste")
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({alreadyInstalled: true}), "Notes Dev")
  })

  it("closes the app's own screen in front of Home, such as Settings with the developer scanner", async () => {
    installs()
    mockList.mockReturnValue([{packageName: "com.mentra.settings", name: "Settings", foregrounded: true}])
    await startMiniappInstall("https://notes.example.com/", "scanner")
    expect(mockClearForeground).toHaveBeenCalled()
    expect(mockGoHome).toHaveBeenCalled()
  })

  it("leaves a miniapp in front running, so a call isn't ended", async () => {
    installs()
    mockList.mockReturnValue([{packageName: "com.mentra.call", name: "Call", foregrounded: true}])
    await startMiniappInstall("https://notes.example.com/", "link")
    expect(mockClearForeground).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({type: "success", text1: "Notes is on your Home screen"})
  })

  it("installs nothing, and says nothing, when the person cancels the sheet", async () => {
    installs()
    mockConfirm.mockResolvedValue(false)
    await expect(startMiniappInstall("https://notes.example.com/", "link")).resolves.toBe("cancelled")
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
  })

  it("opens a miniapp already installed from that URL, as its tile would", async () => {
    installs("opened")
    const app = {packageName: "com.example.notes", name: "Notes"}
    mockList.mockReturnValue([app])
    await expect(startMiniappInstall("https://notes.example.com/", "scanner")).resolves.toBe("opened")
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockAskPermissions).toHaveBeenCalledWith(app)
    expect(mockStart).toHaveBeenCalledWith(app, {trigger: "user", skipNavigation: true})
    expect(mockGoHome).toHaveBeenCalled()
    expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
  })

  it("stays put, so a scanner resumes, when the person declines the installed miniapp's permissions", async () => {
    installs("opened")
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes"}])
    mockAskPermissions.mockResolvedValueOnce(0)
    await expect(startMiniappInstall("https://notes.example.com/", "scanner")).resolves.toBe("cancelled")
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
  })

  it("stays put when the installed miniapp can't open", async () => {
    installs("opened")
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes"}])
    mockStart.mockResolvedValueOnce(false)
    await expect(startMiniappInstall("https://notes.example.com/", "scanner")).resolves.toBe("cancelled")
    expect(mockSetForeground).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
  })

  it.each([
    ["domain_mismatch", "This miniapp's name doesn't match its website."],
    ["archived", "This miniapp isn't available."],
    ["not_a_miniapp", "notes.example.com doesn't serve a miniapp."],
    ["network", "Couldn't reach notes.example.com. Check your connection and try again."],
    ["access_denied", "notes.example.com didn't let your Mentra account install this miniapp."],
    ["integrity", "This miniapp's files didn't match what its website describes. Try again later."],
    ["signature_invalid", "This miniapp's signature couldn't be verified, so it wasn't installed."],
  ])("says why when the engine answers %s", async (code, message) => {
    mockInstall.mockRejectedValue(installError(code))
    await expect(startMiniappInstall("https://notes.example.com/", "link")).resolves.toBe("failed")
    expect(lastAlert()).toEqual({title: "Couldn't install this miniapp", message, buttons: [{text: "OK"}]})
  })

  it("names the miniapp that needs a newer Mentra App", async () => {
    mockInstall.mockImplementation(async (_url, options) => {
      await options.confirm(preview)
      throw installError("needs_newer_app")
    })
    await startMiniappInstall("https://notes.example.com/", "link")
    expect(lastAlert()?.message).toBe("Notes needs a newer version of the Mentra App.")
  })

  it("leaves the age gate to explain itself", async () => {
    mockInstall.mockRejectedValue(installError("age_restricted"))
    await expect(startMiniappInstall("https://notes.example.com/", "link")).resolves.toBe("failed")
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  it("starts one install of a URL at a time", async () => {
    let finish!: () => void
    mockInstall.mockImplementation(
      () =>
        new Promise(
          (resolve) =>
            (finish = () => resolve({status: "installed", packageName: "com.example.notes", version: "1.0.0"})),
        ),
    )
    const first = startMiniappInstall("https://notes.example.com/", "scanner")
    await expect(startMiniappInstall("https://notes.example.com", "scanner")).resolves.toBe("cancelled")
    expect(mockInstall).toHaveBeenCalledTimes(1)
    finish()
    await first
    installs()
    await expect(startMiniappInstall("https://notes.example.com/", "scanner")).resolves.toBe("installed")
  })

  it("refuses what isn't a miniapp URL before reaching the engine", async () => {
    await expect(startMiniappInstall("http://notes.example.com/", "paste")).resolves.toBe("failed")
    expect(mockInstall).not.toHaveBeenCalled()
    expect(lastAlert()?.message).toBe("This isn't a link to a miniapp.")
  })
})

describe("startMiniappInstallFromLink", () => {
  it("installs the miniapp an open link names", async () => {
    installs()
    await startMiniappInstallFromLink(
      "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2Fminiapp.json",
      "link",
    )
    expect(mockInstall).toHaveBeenCalledWith("https://notes.example.com/", expect.objectContaining({source: "link"}))
  })

  it("says a pasted text isn't a link to a miniapp", async () => {
    const onPresent = jest.fn()
    await expect(startMiniappInstallFromLink("hello there", "paste", {onPresent})).resolves.toBe("failed")
    expect(onPresent).toHaveBeenCalled()
    expect(lastAlert()?.message).toBe("This isn't a link to a miniapp.")
  })
})

describe("package links", () => {
  const listed = {
    url: "https://notes.example.com/",
    packageName: "com.example.notes",
    name: "Notes",
    description: "",
    iconUrl: null,
    ageRating: "4+",
    category: null,
    screenshots: [],
  }
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ok: true, status: 200, json: async () => listed}))
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it("looks the package up in the directory, without credentials, then installs its URL", async () => {
    installs()
    await expect(
      startMiniappInstallFromLink("https://apps.mentraglass.com/package/com.example.notes", "link"),
    ).resolves.toBe("installed")
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.apps.example.com/api/directory/miniapps/com.example.notes",
      expect.objectContaining({credentials: "omit"}),
    )
    expect(mockInstall).toHaveBeenCalledWith("https://notes.example.com/", expect.objectContaining({source: "link"}))
  })

  it("says an unlisted package isn't available", async () => {
    fetchMock.mockResolvedValue({ok: false, status: 404, json: async () => ({error: "not_found"})})
    await expect(startListedMiniappInstall("com.example.notes", "link")).resolves.toBe("failed")
    expect(mockInstall).not.toHaveBeenCalled()
    expect(lastAlert()?.message).toBe("This miniapp isn't available.")
  })

  it("installs nothing when the listed URL serves another package", async () => {
    installs("installed", {...preview, packageName: "com.example.other", name: "Other"})
    await expect(startListedMiniappInstall("com.example.notes", "link")).resolves.toBe("failed")
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(lastAlert()?.message).toBe("This miniapp isn't available.")
  })

  it("never opens another package that a listed URL already installed serves", async () => {
    installs("opened", {...preview, packageName: "com.example.other", name: "Other"})
    mockList.mockReturnValue([{packageName: "com.example.other", name: "Other"}])
    await expect(startListedMiniappInstall("com.example.notes", "link")).resolves.toBe("failed")
    expect(mockStart).not.toHaveBeenCalled()
    expect(lastAlert()?.message).toBe("This miniapp isn't available.")
  })

  it("refuses a listing for another package, or one that isn't public HTTPS", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({...listed, packageName: "com.example.other"}),
    })
    await startListedMiniappInstall("com.example.notes", "link")
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({...listed, url: "http://192.168.1.2/"}),
    })
    await startListedMiniappInstall("com.example.notes", "link")
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("says when the directory can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"))
    await expect(startListedMiniappInstall("com.example.notes", "link")).resolves.toBe("failed")
    expect(lastAlert()?.message).toBe("Couldn't reach the Mentra Miniapp Store. Check your connection and try again.")
  })

  it("opens the package's page in the browser when no directory is configured", async () => {
    mockDirectoryUrl = null
    // Nothing opened in the app, so a scanner resumes once the page closes.
    await expect(startListedMiniappInstall("com.example.notes", "scanner")).resolves.toBe("cancelled")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockOpenBrowser).toHaveBeenCalledWith("https://apps.mentraglass.com/package/com.example.notes")
  })
})

describe("miniappInstallFailureCopy", () => {
  it("says nothing for a cancel", () => {
    expect(miniappInstallFailureCopy("cancelled", {})).toBeNull()
  })

  it("has a fallback for anything unexpected", () => {
    expect(miniappInstallFailureCopy("unknown", {})?.message).toBe("Something went wrong. Try again.")
  })
})
