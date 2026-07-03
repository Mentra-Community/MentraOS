/**
 * MiniappCatalog.loadExtraApps — local miniapps own their packageName.
 *
 * A cloud applet with the same packageName as an installed new-SDK (or dev)
 * miniapp must never reach the island store: the store dedupes by
 * packageName with the cloud copy winning, so an unfiltered duplicate
 * shadows the local miniapp entirely. Shadowed cloud applets that still
 * report running get a one-shot stop request.
 */
import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import restComms from "@/services/RestComms"
import {appRegistry, useAppStatusStore} from "@mentra/island"

jest.mock("@sentry/react-native", () => ({captureException: jest.fn()}))

jest.mock("@mentra/bluetooth-sdk-internal", () => ({
  __esModule: true,
  default: {restartTranscriber: jest.fn()},
}))

jest.mock("@mentra/island", () => ({
  __esModule: true,
  appRegistry: {
    installOfflineApp: jest.fn(),
    getInstalledMiniapps: jest.fn(async () => []),
  },
  BgTimer: {
    setTimeout: jest.fn(),
    clearTimeout: jest.fn(),
    setInterval: jest.fn(),
    clearInterval: jest.fn(),
  },
  configureIsland: jest.fn(),
  decideDevLaunchRoute: jest.fn(),
  HardwareRequirementLevel: {REQUIRED: "required", OPTIONAL: "optional"},
  HardwareType: {EXIST: "exist", CAMERA: "camera", DISPLAY: "display"},
  sttModelManager: {isModelAvailable: jest.fn()},
  useAppStatusStore: {
    getState: jest.fn(() => ({apps: [], refresh: jest.fn()})),
    setState: jest.fn(),
  },
}))

jest.mock("@/../../cloud/packages/types/src", () => ({
  DeviceTypes: {NONE: "none"},
  getModelCapabilities: jest.fn(() => ({})),
}))

jest.mock("@/components/miniapp/offlineHostedPackages", () => ({
  isOfflineHosted: jest.fn(() => false),
}))

jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn()}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {
    getState: jest.fn(() => ({push: jest.fn(), getCurrentRoute: jest.fn(() => "/home")})),
  },
}))

jest.mock("@/i18n", () => ({translate: jest.fn((key: string) => key)}))

jest.mock("@/services/bugReport/miniappStartBugReport", () => ({
  submitMiniappStartFailedBugReport: jest.fn(),
}))

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    getApplets: jest.fn(),
    startApp: jest.fn(),
    stopApp: jest.fn(),
    uninstallApp: jest.fn(),
  },
}))

jest.mock("@/stores/settings", () => ({
  SETTINGS: {
    default_wearable: {key: "default_wearable"},
    offline_captions_running: {key: "offline_captions_running"},
    offline_camera_running: {key: "offline_camera_running"},
    has_ever_activated_app: {key: "has_ever_activated_app"},
    menu_apps: {key: "menu_apps"},
  },
  useSettingsStore: {
    getState: jest.fn(() => ({getSetting: jest.fn(), setSetting: jest.fn()})),
    subscribe: jest.fn(),
  },
}))

jest.mock("@/utils/glassesMenu", () => ({getDefaultMenuApps: jest.fn(async () => [])}))
jest.mock("@/utils/miniappDevMode", () => ({markMiniappDevMode: jest.fn()}))

jest.mock("@/constants/miniapps", () => ({
  cameraPackageName: "com.mentra.camera",
  captionsPackageName: "com.mentra.captions",
  CHINA_HIDDEN_APPS: [],
  feedbackPackageName: "com.mentra.feedback",
  isChinaBuild: jest.fn(() => false),
  mirrorPackageName: "com.mentra.mirror",
  notifyPackageName: "com.mentra.notify",
  settingsPackageName: "com.mentra.settings",
  storePackageName: "com.mentra.store",
}))

const restMock = restComms as jest.Mocked<typeof restComms>
const getInstalledMiniappsMock = appRegistry.getInstalledMiniapps as jest.Mock
const getStateMock = useAppStatusStore.getState as jest.Mock

const ok = <T>(value: T): any => ({is_ok: () => true, is_error: () => false, value})
const err = (error: Error): any => ({is_ok: () => false, is_error: () => true, error})

const cloudApplet = (packageName: string, running = false) => ({
  packageName,
  name: packageName,
  running,
  loading: false,
  healthy: true,
  hidden: false,
  type: "standard",
  webviewUrl: "https://example.com",
  logoUrl: "",
  permissions: [],
  hardwareRequirements: [],
})

const localMiniapp = (packageName: string, extra: Record<string, unknown> = {}) => ({
  packageName,
  name: packageName,
  local: true,
  running: false,
  ...extra,
})

const loadExtraApps = (): Promise<Array<{packageName: string}>> => (miniappCatalog as any).loadExtraApps()
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

describe("MiniappCatalog.loadExtraApps — local miniapps shadow cloud applets", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(miniappCatalog as any).shadowedCloudStopsRequested.clear()
    getInstalledMiniappsMock.mockResolvedValue([])
    getStateMock.mockReturnValue({apps: [], refresh: jest.fn()})
    restMock.stopApp.mockResolvedValue(ok(undefined))
  })

  it("drops a cloud applet when an installed local miniapp has the same packageName", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes"), cloudApplet("com.other.app")]))

    const apps = await loadExtraApps()

    expect(apps.map((a) => a.packageName)).toEqual(["com.other.app"])
  })

  it("dev miniapps shadow their cloud counterpart too", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes", {local: false, isMiniappDev: true})])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes")]))

    const apps = await loadExtraApps()

    expect(apps).toEqual([])
  })

  it("offline built-ins (local:false) do NOT shadow cloud applets", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.mentra.settings", {local: false, offline: true})])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.mentra.settings")]))

    const apps = await loadExtraApps()

    expect(apps.map((a) => a.packageName)).toEqual(["com.mentra.settings"])
  })

  it("sends a single stop request for a shadowed cloud applet that reports running", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", true)]))

    await loadExtraApps()
    await loadExtraApps()
    await flushMicrotasks()

    expect(restMock.stopApp).toHaveBeenCalledTimes(1)
    expect(restMock.stopApp).toHaveBeenCalledWith("com.example.notes")
  })

  it("does not send a stop for a shadowed cloud applet that is not running", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", false)]))

    await loadExtraApps()
    await flushMicrotasks()

    expect(restMock.stopApp).not.toHaveBeenCalled()
  })

  it("re-arms the stop once the cloud copy reports stopped, catching a later cloud-side start", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])

    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", true)]))
    await loadExtraApps()
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", false)]))
    await loadExtraApps()
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", true)]))
    await loadExtraApps()
    await flushMicrotasks()

    expect(restMock.stopApp).toHaveBeenCalledTimes(2)
  })

  it("retries the stop on the next refresh if the stop request failed", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])
    restMock.getApplets.mockResolvedValue(ok([cloudApplet("com.example.notes", true)]))
    restMock.stopApp.mockResolvedValueOnce(err(new Error("503")))

    await loadExtraApps()
    await flushMicrotasks()
    await loadExtraApps()
    await flushMicrotasks()

    expect(restMock.stopApp).toHaveBeenCalledTimes(2)
  })

  it("filters locally-owned packages from the stale-snapshot fallback when the cloud fetch fails", async () => {
    getInstalledMiniappsMock.mockResolvedValue([localMiniapp("com.example.notes")])
    getStateMock.mockReturnValue({
      apps: [
        {...cloudApplet("com.example.notes"), local: false, offline: false},
        {...cloudApplet("com.other.app"), local: false, offline: false},
      ],
      refresh: jest.fn(),
    })
    restMock.getApplets.mockResolvedValue(err(new Error("network down")))

    const apps = await loadExtraApps()

    expect(apps.map((a) => a.packageName)).toEqual(["com.other.app"])
  })
})
