import i18n from "i18next"

import en from "@/i18n/en"

import {consumeMiniappOpeningAnimation} from "@/stores/miniappLaunch"
import {cancelMiniappLinkOpens, useMiniappLinkOpenStore} from "@/stores/miniappLinkOpen"

import {
  miniappInstallFailureCopy,
  startListedMiniappInstall,
  startMiniappInstall,
  startMiniappInstallFromLink,
} from "./miniappInstallFlow"

type Confirm = (preview: Record<string, unknown>) => Promise<boolean>
type InstallOptions = {source: string; confirm: Confirm; isCancelled?: () => boolean}

const mockInstall = jest.fn<Promise<{status: string; packageName: string; version: string}>, [string, InstallOptions]>()
const mockList = jest.fn(
  (): Array<{packageName: string; name: string; updating?: boolean; foregrounded?: boolean}> => [],
)
const mockStart = jest.fn(async (..._args: unknown[]) => true)
const mockSetForeground = jest.fn(async (..._args: unknown[]) => {})
const mockClearForeground = jest.fn()
const mockStop = jest.fn(async (..._args: unknown[]) => {})
jest.mock("@mentra/engine", () => ({
  engine: {
    miniapps: {
      install: (url: string, options: InstallOptions) => mockInstall(url, options),
      list: () => mockList(),
      start: (...args: unknown[]) => mockStart(...args),
      setForeground: (...args: unknown[]) => mockSetForeground(...args),
      clearForeground: () => mockClearForeground(),
      stop: (...args: unknown[]) => mockStop(...args),
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

  it("opens a development build installed from the local network, as the developer scanner does", async () => {
    const local = {...preview, url: "http://192.168.1.20:3160/", host: "192.168.1.20:3160", local: true}
    installs("installed", local)
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes"}])
    await expect(startMiniappInstall("http://192.168.1.20:3160/", "link")).resolves.toBe("opened")

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({packageName: "com.example.notes"}),
      expect.objectContaining({trigger: "user"}),
    )
    expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
    expect(mockToast).not.toHaveBeenCalledWith({type: "success", text1: "Notes is on your Home screen"})
  })

  it("shows a local development build's tile on Home when it can't open", async () => {
    const local = {...preview, url: "http://192.168.1.20:3160/", host: "192.168.1.20:3160", local: true}
    installs("installed", local)
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes"}])
    mockAskPermissions.mockResolvedValueOnce(0)
    await expect(startMiniappInstall("http://192.168.1.20:3160/", "link")).resolves.toBe("installed")

    expect(mockStart).not.toHaveBeenCalled()
    expect(mockGoHome).toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({type: "success", text1: "Notes is on your Home screen"})
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
    expect(mockStart).toHaveBeenCalledWith(app, {
      trigger: "user",
      skipNavigation: true,
      onAccepted: expect.any(Function),
    })
    expect(mockGoHome).toHaveBeenCalled()
    expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
  })

  it("shows the installed miniapp's splash once its start is accepted, before the wait for its update check", async () => {
    installs("opened")
    mockList.mockReturnValue([{packageName: "com.example.notes", name: "Notes"}])
    mockStart.mockImplementationOnce(async (_app, options) => {
      // Not before: a refused start leaves the person in the scanner.
      expect(mockGoHome).not.toHaveBeenCalled()
      await (options as {onAccepted: () => Promise<void>}).onAccepted()
      expect(mockGoHome).toHaveBeenCalledTimes(1)
      expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
      return true
    })
    await expect(startMiniappInstall("https://notes.example.com/", "scanner")).resolves.toBe("opened")
    expect(mockSetForeground).toHaveBeenCalledTimes(1)
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

describe("a link opens the miniapp with nothing to press", () => {
  const LINK = "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F"
  const notes = {packageName: "com.example.notes", name: "Notes"}
  const splash = () => useMiniappLinkOpenStore.getState().view

  afterEach(() => {
    cancelMiniappLinkOpens()
    consumeMiniappOpeningAnimation("")
  })

  it("installs without the sheet, under the miniapp's splash, then opens it in place", async () => {
    const seen: unknown[] = []
    mockInstall.mockImplementation(async (_url, options) => {
      // Before the link is read, the splash is up with no miniapp on it yet.
      seen.push(splash())
      expect(await options.confirm({...preview, iconUrl: "https://notes.example.com/icon.png"})).toBe(true)
      seen.push(splash())
      mockList.mockReturnValue([notes])
      return {status: "installed", packageName: "com.example.notes", version: "1.0.0"}
    })
    mockSetForeground.mockImplementation(async () => {
      // The miniapp comes to the front under the splash, which is still up.
      seen.push(splash())
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("installed")

    expect(seen[0]).toEqual({id: expect.any(Number), installing: false})
    const installing = {name: "Notes", iconUrl: "https://notes.example.com/icon.png", installing: true}
    expect(seen[1]).toEqual({id: expect.any(Number), ...installing})
    expect(seen[2]).toEqual(seen[1])
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockToast).not.toHaveBeenCalled()
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockAskPermissions).toHaveBeenCalledWith(notes)
    expect(mockStart).toHaveBeenCalledWith(notes, {
      trigger: "user",
      skipNavigation: true,
      onAccepted: expect.any(Function),
    })
    expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
    // It appears in place: no opening animation over the splash.
    expect(consumeMiniappOpeningAnimation("com.example.notes")).toBe("none")
    expect(splash()).toBeNull()
  })

  it("opens a miniapp already installed from that URL the same way", async () => {
    installs("opened")
    mockList.mockReturnValue([notes])
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("opened")
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockSetForeground).toHaveBeenCalledWith("com.example.notes")
    expect(consumeMiniappOpeningAnimation("com.example.notes")).toBe("none")
    expect(splash()).toBeNull()
  })

  it("closes the splash before it says why a link couldn't be installed, and opens nothing", async () => {
    mockInstall.mockRejectedValue(installError("network"))
    mockShowAlert.mockImplementationOnce(async () => {
      expect(splash()).toBeNull()
      return 0
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("failed")
    expect(lastAlert()?.message).toBe("Couldn't reach notes.example.com. Check your connection and try again.")
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
    expect(splash()).toBeNull()
  })

  it("closes the splash on a link that names no miniapp", async () => {
    mockShowAlert.mockImplementationOnce(async () => {
      expect(splash()).toBeNull()
      return 0
    })
    await expect(startMiniappInstallFromLink("https://apps.mentraglass.com/open", "link")).resolves.toBe("failed")
    expect(lastAlert()?.message).toBe("This isn't a link to a miniapp.")
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("leaves a miniapp the person wouldn't give its permissions on Home, unopened", async () => {
    installs()
    mockList.mockReturnValue([notes])
    mockAskPermissions.mockResolvedValueOnce(0)
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("installed")
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockSetForeground).not.toHaveBeenCalled()
    expect(splash()).toBeNull()
  })

  it("stops when the person closes the splash: nothing more installs, and nothing opens", async () => {
    mockInstall.mockImplementation(async (_url, options) => {
      expect(options.isCancelled?.()).toBe(false)
      cancelMiniappLinkOpens()
      expect(splash()).toBeNull()
      expect(options.isCancelled?.()).toBe(true)
      throw installError("cancelled")
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("says nothing about a failure that comes after the person closed the splash", async () => {
    mockInstall.mockImplementation(async () => {
      cancelMiniappLinkOpens()
      throw installError("network")
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockShowAlert).not.toHaveBeenCalled()
  })

  it.each([
    ["can't be reached", () => Promise.reject(new Error("offline"))],
    ["doesn't list the package", async () => ({ok: false, status: 404, json: async () => null})],
  ])("says nothing when the splash is closed while a directory that %s is asked", async (_case, answer) => {
    const realFetch = global.fetch
    global.fetch = jest.fn(() => {
      cancelMiniappLinkOpens()
      return answer()
    }) as unknown as typeof fetch
    try {
      await expect(
        startMiniappInstallFromLink("https://apps.mentraglass.com/package/com.example.notes", "link"),
      ).resolves.toBe("cancelled")
    } finally {
      global.fetch = realFetch
    }
    expect(mockShowAlert).not.toHaveBeenCalled()
    expect(mockInstall).not.toHaveBeenCalled()
  })

  it("opens nothing when the splash is closed just as the install finishes", async () => {
    mockInstall.mockImplementation(async (_url, options) => {
      await options.confirm(preview)
      mockList.mockReturnValue([notes])
      cancelMiniappLinkOpens()
      return {status: "installed", packageName: "com.example.notes", version: "1.0.0"}
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockAskPermissions).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("starts nothing when the splash is closed while the miniapp's permissions are asked", async () => {
    installs()
    mockList.mockReturnValue([notes])
    mockAskPermissions.mockImplementationOnce(async () => {
      cancelMiniappLinkOpens()
      return 1
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("installed")
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockSetForeground).not.toHaveBeenCalled()
  })

  it("puts the miniapp's own splash under the link's as soon as its start is accepted, for the wait that follows", async () => {
    installs("opened")
    mockList.mockReturnValue([notes])
    const seen: unknown[] = []
    mockSetForeground.mockImplementation(async () => {
      seen.push(splash())
    })
    // As the engine: the start is accepted, then waits for the miniapp's update check before anything starts.
    mockStart.mockImplementationOnce(async (_app, options) => {
      await (options as {onAccepted: () => Promise<void>}).onAccepted()
      // The link's splash has closed over the miniapp's own, which is what says it is updating meanwhile.
      seen.push(splash())
      expect(mockGoHome).toHaveBeenCalledTimes(1)
      expect(consumeMiniappOpeningAnimation("com.example.notes")).toBe("none")
      return true
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("opened")
    expect(seen).toEqual([{id: expect.any(Number), installing: false}, null])
    // Brought to the front once, when the start was accepted.
    expect(mockSetForeground).toHaveBeenCalledTimes(1)
    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("closes the miniapp's splash again when its start fails, or is cancelled, after it came up", async () => {
    installs("opened")
    mockList.mockReturnValue([{...notes, foregrounded: true}])
    mockStart.mockImplementationOnce(async (_app, options) => {
      await (options as {onAccepted: () => Promise<void>}).onAccepted()
      return false
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockClearForeground).toHaveBeenCalledTimes(1)
    expect(splash()).toBeNull()
  })

  it("leaves another miniapp the person moved to alone when that start fails", async () => {
    installs("opened")
    mockList.mockReturnValue([notes])
    mockStart.mockImplementationOnce(async (_app, options) => {
      await (options as {onAccepted: () => Promise<void>}).onAccepted()
      return false
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockClearForeground).not.toHaveBeenCalled()
  })

  it("brings nothing to the front for a link closed before its start was accepted", async () => {
    installs("opened")
    mockList.mockReturnValue([notes])
    mockStart.mockImplementationOnce(async (_app, options) => {
      cancelMiniappLinkOpens()
      await (options as {onAccepted: () => Promise<void>}).onAccepted()
      return true
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(mockSetForeground).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
    expect(mockStop).toHaveBeenCalledWith("com.example.notes")
  })

  it("stops a miniapp that started as the splash was closed, without bringing it to the front", async () => {
    installs()
    mockList.mockReturnValue([notes])
    mockStart.mockImplementationOnce(async () => {
      cancelMiniappLinkOpens()
      return true
    })
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("installed")
    expect(mockStop).toHaveBeenCalledWith("com.example.notes")
    expect(mockSetForeground).not.toHaveBeenCalled()
    expect(mockGoHome).not.toHaveBeenCalled()
  })

  it.each([
    ["a development build from the local network", {...preview, local: true}],
    ["an install that replaces the copy the person has", {...preview, alreadyInstalled: true}],
  ])("still asks through the sheet for %s, with the splash closed", async (_case, served) => {
    mockConfirm.mockImplementationOnce(async () => {
      expect(splash()).toBeNull()
      return true
    })
    installs("installed", served)
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("installed")
    expect(mockConfirm).toHaveBeenCalledTimes(1)
    // As from the scanner: the tile is on Home, and nothing opens.
    expect(mockGoHome).toHaveBeenCalledTimes(1)
    expect(mockToast).toHaveBeenLastCalledWith({type: "success", text1: "Notes is on your Home screen"})
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("keeps the splash of a link that is opening when the same link is tapped again", async () => {
    let finish!: () => void
    mockInstall.mockImplementationOnce(async (_url, options) => {
      await options.confirm(preview)
      await new Promise<void>((resolve) => (finish = resolve))
      mockList.mockReturnValue([notes])
      return {status: "installed", packageName: "com.example.notes", version: "1.0.0"}
    })
    const first = startMiniappInstallFromLink(LINK, "link")
    await Promise.resolve()
    await expect(startMiniappInstallFromLink(LINK, "link")).resolves.toBe("cancelled")
    expect(splash()).toEqual(expect.objectContaining({name: "Notes", installing: true}))
    finish()
    await expect(first).resolves.toBe("installed")
    expect(splash()).toBeNull()
  })

  it("asks through the sheet from the scanner and the paste box, with no splash", async () => {
    installs()
    await expect(startMiniappInstallFromLink("https://notes.example.com/", "scanner")).resolves.toBe("installed")
    await expect(startMiniappInstallFromLink("notes.example.com", "paste")).resolves.toBe("installed")
    expect(mockConfirm).toHaveBeenCalledTimes(2)
    expect(mockStart).not.toHaveBeenCalled()
    expect(splash()).toBeNull()
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
