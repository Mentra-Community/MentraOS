import {act, render} from "@testing-library/react-native"
import {Linking, Platform} from "react-native"

import LocalMiniappView from "../LocalMiniappView"
import {useNavigationStore} from "@/stores/navigation"
import {useRegisterCapsule} from "@/stores/capsule"
import {miniappLauncher} from "../../../../modules/engine/src/services/MiniappLauncher"
import devServerBridge from "../../../../modules/engine/src/services/DevServerBridge"
import appRegistry from "../../../../modules/engine/src/services/AppRegistry"
import {miniappFileUrl} from "../../../../modules/engine/src/services/miniappScreenOrigin"
import {useStressTestStore} from "@/stores/stressTest"
import {
  resetWebStorageMoveStateForTests,
  writeWebStorageReader,
  webStorageMoveAttemptsKey,
  webStorageMovedKey,
} from "@/services/miniapps/webStorageMigration"
import {storage} from "@/utils/storage"
import {OLD_WEB_STORAGE_READ_TIMEOUT_MS} from "@/components/miniapp/OldWebStorageReader"

jest.mock("expo-router", () => ({router: {push: jest.fn(), replace: jest.fn(), back: jest.fn()}}))
jest.mock("react-native-webview", () => ({WebView: "WebView"}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {isDark: false, colors: {background: "white"}}}),
}))
jest.mock("@/contexts/SaferAreaContext", () => ({
  useSaferAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}))
jest.mock("@/components/ignite", () => ({Text: "Text"}))
jest.mock("@/effects/CapsuleMenu", () => () => {
  const {View} = require("react-native")
  return <View testID="capsule" />
})
jest.mock("@/stores/capsule", () => ({useRegisterCapsule: jest.fn()}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("../MiniappSplash", () => (props: {error?: string; label?: string}) => {
  const {Text} = require("react-native")
  return (
    <>
      <Text testID="splash-error">{props.error}</Text>
      <Text testID="splash-label">{props.label}</Text>
    </>
  )
})
/** The miniapp in front, as the engine's apps store holds it. */
let mockForegroundedPackage: string | null = null
/** What each miniapp's start waits for, as the engine reports it, and who listens. */
let mockStartWaits: Record<string, "check" | "update"> = {}
const mockStartWaitListeners = new Set<() => void>()
let mockDevMode = false
// The engine modules MiniappView runs on.
jest.mock("../../../../modules/engine/src/services/MiniappLauncher", () => ({
  miniappLauncher: {ensureRunning: jest.fn(), resolveBundle: jest.fn()},
}))
jest.mock("../../../../modules/engine/src/services/MiniappEngine", () => ({getMiniappEngine: () => null}))
const mockOwnFilesDirectoryUri = jest.fn((_packageName: string): string | null => FILES_DIR)
jest.mock("../../../../modules/engine/src/services/LocalMiniappRuntime", () => ({
  __esModule: true,
  default: {
    installedVersionOf: () => null,
    ownFilesDirectoryUri: (packageName: string) => mockOwnFilesDirectoryUri(packageName),
  },
}))
jest.mock("../../../../modules/engine/src/services/DevServerBridge", () => ({
  __esModule: true,
  default: {forwardLog: jest.fn()},
}))
// The installs the screen follows: the version each package runs, and who hears of a change.
let mockActiveVersion = "1.0.0"
jest.mock("../../../../modules/engine/src/services/AppRegistry", () => {
  const listeners = new Set<() => void>()
  return {
    __esModule: true,
    default: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      peekActiveVersion: () => mockActiveVersion,
      getBundleDir: (packageName: string, version: string) => `file:///documents/lmas/${packageName}/${version}/`,
      notifyForTests: () => listeners.forEach((listener) => listener()),
    },
  }
})
jest.mock("../../../../modules/engine/src/services/fleet/fleetEvents", () => ({fleetEvents: {crash: jest.fn()}}))
jest.mock("../../../../modules/engine/src/runtime/bootstrap", () => ({getConfigValues: () => ({})}))
jest.mock("../../../../modules/engine/src/utils/miniappGlobals", () => ({buildMiniappGlobalsScript: () => ""}))
jest.mock("../../../../modules/engine/src/services/mentraUiShim", () => ({buildMentraUiShim: () => ""}))
jest.mock("../../../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setInterval: jest.fn(),
    clearInterval: jest.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
}))
jest.mock("@mentra/engine-host-internal", () => ({
  useAppStatusStore: {getState: () => ({foregroundedPackage: mockForegroundedPackage})},
  localMiniappRuntime: {hasManifestPermission: () => false},
  redactSecrets: jest.requireActual("../../../../modules/engine/src/services/MentraJSLogPipeline").redactSecrets,
  ...jest.requireActual("../../../../modules/engine/src/services/miniappWebStorage"),
  resolveMiniappDataPartition: () => ({id: "test-partition", personalUserId: "test-user"}),
  cloudClientService: {resolveMentraUserId: () => Promise.resolve("test-user")},
}))

jest.mock("@/services/miniapps/webStorageMigration", () => ({
  ...jest.requireActual("@/services/miniapps/webStorageMigration"),
  writeWebStorageReader: jest.fn(() => ({
    pageUri: "file:///cache/miniapp-web-storage-move/com.mentra.notes/read.html",
    directoryUri: "file:///cache/miniapp-web-storage-move/com.mentra.notes",
  })),
  removeWebStorageReader: jest.fn(),
}))

jest.mock("@mentra/engine", () => ({
  BgTimer: {
    setInterval: jest.fn(),
    clearInterval: jest.fn(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  },
  SETTINGS: {dev_mode: {key: "dev_mode"}},
  useSetting: () => [mockDevMode],
  engine: {
    miniapps: {
      clearForeground: jest.fn(),
      startWait: (packageName: string) => mockStartWaits[packageName] ?? null,
      onStartWaitChanged: (listener: () => void) => {
        mockStartWaitListeners.add(listener)
        return () => mockStartWaitListeners.delete(listener)
      },
    },
  },
}))
jest.mock("@/services/streamPreview", () => {
  const coordinator = {
    bindView: jest.fn(),
    documentEnded: jest.fn(),
    noteInstallReload: jest.fn(),
    viewDestroyed: jest.fn(),
  }
  return {STREAM_PREVIEW_BIND_TIMEOUT_MS: 0, getStreamPreviewCoordinator: () => coordinator}
})

const NO_UI = {uiUri: null, uiOrigin: null, uiRootDir: null, uiOriginName: null, devBuild: false}
const FILES_DIR = "file:///documents/mentra_blobs/core.mu_1.p/com.mentra.test/"
const INSTALLED = {
  uiUri: "https://com.mentra.test.miniapp.invalid/ui/index.html",
  uiOrigin: "https://com.mentra.test.miniapp.invalid",
  uiRootDir: "file:///documents/lmas/com.mentra.test/1.0.0/",
  uiOriginName: "com.mentra.test",
  devBuild: false,
}

const props = {
  packageName: "com.mentra.test",
  onExit: jest.fn(),
  onClose: jest.fn(),
  onMinimize: jest.fn(),
  showCapsule: true,
  openingComplete: true,
}

async function finishLaunch() {
  await act(async () => {
    jest.advanceTimersByTime(40)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  jest.replaceProperty(Platform, "OS", "android")
  useNavigationStore.setState({interceptor: null})
  mockStartWaits = {}
  jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(NO_UI)
  mockActiveVersion = "1.0.0"
  resetWebStorageMoveStateForTests()
  jest.requireActual("../../../../modules/engine/src/services/miniappWebStorage").resetMiniappWebStorageForTests()
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it("exposes exit controls above the splash when startup resolves without a UI", async () => {
  const view = render(<LocalMiniappView {...props} />)
  await finishLaunch()
  expect(miniappLauncher.ensureRunning).toHaveBeenCalled()
  expect(view.getByTestId("splash-error").props.children).toBe("common:miniappUiUnavailable")
  // The error capsule is a sibling of the splash, outside the disabled content layer.
  let ancestor = view.getByTestId("capsule").parent
  while (ancestor) {
    expect(ancestor.props.pointerEvents).not.toBe("none")
    ancestor = ancestor.parent
  }
  act(() => jest.mocked(useRegisterCapsule).mock.calls.at(-1)![0].onClosePress!())
  expect(props.onClose).toHaveBeenCalledTimes(1)
})

it("logs the native load error while preserving the existing stress event and loading behavior", async () => {
  jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
  const recordEvent = jest.spyOn(useStressTestStore.getState(), "recordEvent")
  const view = render(<LocalMiniappView {...props} />)
  await finishLaunch()
  const initialError = view.getByTestId("splash-error").props.children
  act(() => {
    view.UNSAFE_getByType("WebView" as never).props.onError({
      nativeEvent: {
        domain: "NSURLErrorDomain",
        code: -1009,
        description: "Could not load https://example.com/private'copy/private-account?access_token=private",
        url: "https://example.com/?access_token=private",
      },
    })
  })
  expect(warn).toHaveBeenCalledWith("[MiniappView:com.mentra.test] WebView load error", {
    domain: "NSURLErrorDomain",
    code: -1009,
    description: "Could not load [REDACTED]",
  })
  expect(recordEvent).toHaveBeenCalledWith({packageName: props.packageName, at: expect.any(Number), kind: "error"})
  expect(view.getByTestId("splash-error").props.children).toBe(initialError)
  expect(props.onExit).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
})

it("does not reclaim Back after external navigation changes presentation callbacks", () => {
  const view = render(<LocalMiniappView {...props} onShouldCapture={() => undefined} />)
  const interceptor = useNavigationStore.getState().interceptor!
  act(() => {
    interceptor.push("/settings")
  })
  expect(props.onExit).toHaveBeenCalledTimes(1)
  view.rerender(<LocalMiniappView {...props} onShouldCapture={() => undefined} />)
  expect(useNavigationStore.getState().interceptor!.goBack()).toBe(false)
  expect(props.onExit).toHaveBeenCalledTimes(1)
})

it.each(["onClosePress", "onMinimizePress"] as const)("releases Back as soon as %s starts dismissal", (action) => {
  const view = render(<LocalMiniappView {...props} />)
  act(() => jest.mocked(useRegisterCapsule).mock.calls.at(-1)![0][action]!())
  view.rerender(<LocalMiniappView {...props} onShouldCapture={() => undefined} />)
  expect(useNavigationStore.getState().interceptor!.goBack()).toBe(false)
  expect(props.onExit).not.toHaveBeenCalled()
})

function attempts(packageName: string): number | null {
  const stored = storage.load<number>(webStorageMoveAttemptsKey(packageName))
  return stored.is_ok() ? stored.value : null
}

function miniappWebView(view: ReturnType<typeof render>) {
  const webViews = view.UNSAFE_queryAllByType("WebView" as never)
  return webViews.find((webView) => webView.props.miniappOrigin !== undefined || !webView.props.allowFileAccess)
}

describe("the screen's origin", () => {
  it("loads an installed screen from its package's own origin, with no file access", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const webView = view.UNSAFE_getByType("WebView" as never)
    expect(webView.props.source).toEqual({uri: INSTALLED.uiUri})
    // The same origin serves the miniapp's own files (its photos) under /.mentra/files/.
    expect(webView.props.miniappOrigin).toEqual({
      packageName: "com.mentra.test",
      rootDir: INSTALLED.uiRootDir,
      filesDir: FILES_DIR,
    })
    expect(mockOwnFilesDirectoryUri).toHaveBeenCalledWith("com.mentra.test")
    expect(webView.props.originWhitelist).toContain(INSTALLED.uiOrigin)
    expect(webView.props.originWhitelist).not.toContain("*")
    expect(webView.props.originWhitelist.some((entry: string) => entry.startsWith("file"))).toBe(false)
    expect(webView.props.allowFileAccess).toBeUndefined()
    expect(webView.props.allowFileAccessFromFileURLs).toBeUndefined()
    expect(webView.props.allowUniversalAccessFromFileURLs).toBeUndefined()
    expect(webView.props.allowingReadAccessToURL).toBeUndefined()
  })

  it("serves no files while the miniapp's files directory is unknown", async () => {
    mockOwnFilesDirectoryUri.mockReturnValueOnce(null)
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const webView = view.UNSAFE_getByType("WebView" as never)
    expect(webView.props.miniappOrigin).toEqual({packageName: "com.mentra.test", rootDir: INSTALLED.uiRootDir})
  })

  it("serves a development snapshot under its development origin, never the package's", async () => {
    const snapshot = {
      uiUri: "https://invalid.dev.com.mentra.test.miniapp.invalid/ui/index.html",
      uiOrigin: "https://invalid.dev.com.mentra.test.miniapp.invalid",
      uiRootDir: "file:///documents/lmas/com.mentra.test/dev-1000/",
      uiOriginName: "invalid.dev.com.mentra.test",
      devBuild: true,
    }
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(snapshot)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const webView = view.UNSAFE_getByType("WebView" as never)
    expect(webView.props.source).toEqual({uri: snapshot.uiUri})
    expect(webView.props.miniappOrigin).toEqual({
      packageName: snapshot.uiOriginName,
      rootDir: snapshot.uiRootDir,
      filesDir: FILES_DIR,
    })
    expect(webView.props.originWhitelist).toContain(snapshot.uiOrigin)
    expect(webView.props.originWhitelist).not.toContain(INSTALLED.uiOrigin)
  })

  it("records the screen each open loads, so the miniapp's own files get URLs it can load", async () => {
    // A development build of the miniapp keeps running while it opens from a release, then from its snapshot.
    const snapshot = {
      uiUri: "https://invalid.dev.com.mentra.test.miniapp.invalid/ui/index.html",
      uiOrigin: "https://invalid.dev.com.mentra.test.miniapp.invalid",
      uiRootDir: "file:///documents/lmas/com.mentra.test/dev-1000/",
      uiOriginName: "invalid.dev.com.mentra.test",
      devBuild: true,
    }
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const first = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(miniappFileUrl("com.mentra.test", "photo-1.jpg")).toBe(`${INSTALLED.uiOrigin}/.mentra/files/photo-1.jpg`)
    first.unmount()

    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(snapshot)
    render(<LocalMiniappView {...props} devBuild />)
    await finishLaunch()
    expect(miniappFileUrl("com.mentra.test", "photo-1.jpg")).toBe(`${snapshot.uiOrigin}/.mentra/files/photo-1.jpg`)
  })

  it("opens a development build from the build on the phone, and follows each new build that installs", async () => {
    const build = {
      uiUri: "https://invalid.dev.com.mentra.test.miniapp.invalid/ui/index.html",
      uiOrigin: "https://invalid.dev.com.mentra.test.miniapp.invalid",
      uiRootDir: "file:///documents/lmas/com.mentra.test/dev-1000/",
      uiOriginName: "invalid.dev.com.mentra.test",
      devBuild: true,
    }
    mockActiveVersion = "dev-1000"
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(build)
    const view = render(<LocalMiniappView {...props} devBuild />)
    await finishLaunch()
    const first = view.UNSAFE_getByType("WebView" as never)
    expect(first.props.source).toEqual({uri: build.uiUri})
    expect(first.props.miniappOrigin).toEqual({
      packageName: build.uiOriginName,
      rootDir: build.uiRootDir,
      filesDir: FILES_DIR,
    })

    // An install that left this package's build as it was keeps the screen.
    act(() => (appRegistry as unknown as {notifyForTests: () => void}).notifyForTests())
    await finishLaunch()
    expect(view.UNSAFE_getByType("WebView" as never)).toBe(first)
    expect(miniappLauncher.ensureRunning).toHaveBeenCalledTimes(1)

    // A new build (a developer's save) opens from its own bundle, in a new WebView.
    const next = {...build, uiRootDir: "file:///documents/lmas/com.mentra.test/dev-2000/"}
    mockActiveVersion = "dev-2000"
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(next)
    act(() => (appRegistry as unknown as {notifyForTests: () => void}).notifyForTests())
    await finishLaunch()
    const second = view.UNSAFE_getByType("WebView" as never)
    expect(second.props.miniappOrigin.rootDir).toBe(next.uiRootDir)
    expect(() => first.props).toThrow(/unmounted/)
  })

  it("follows a release's new build too", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const next = {...INSTALLED, uiRootDir: "file:///documents/lmas/com.mentra.test/1.1.0/"}
    mockActiveVersion = "1.1.0"
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(next)
    act(() => (appRegistry as unknown as {notifyForTests: () => void}).notifyForTests())
    await finishLaunch()
    expect(view.UNSAFE_getByType("WebView" as never).props.miniappOrigin.rootDir).toBe(next.uiRootDir)
  })

  it("keeps the miniapp's document on its origin and opens other links in the system browser", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const decide = view.UNSAFE_getByType("WebView" as never).props.onShouldStartLoadWithRequest
    expect(decide({url: `${INSTALLED.uiOrigin}/ui/settings.html`, isTopFrame: true})).toBe(true)
    expect(decide({url: "https://customer-x.cloudflarestream.com/abc/iframe", isTopFrame: false})).toBe(true)
    expect(openURL).not.toHaveBeenCalled()
    expect(decide({url: "https://example.com/article", isTopFrame: true})).toBe(false)
    expect(openURL).toHaveBeenCalledWith("https://example.com/article")
    expect(decide({url: "https://com.mentra.other.miniapp.invalid/ui/index.html", isTopFrame: true})).toBe(false)
    expect(decide({url: "com.mentra://applet/local", isTopFrame: true})).toBe(false)
    expect(openURL).toHaveBeenCalledTimes(1)
  })

  it("reloads the screen on a new bundle root", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} version="1.0.0" />)
    await finishLaunch()
    const first = view.UNSAFE_getByType("WebView" as never)
    const firstSource = first.props.source
    jest
      .mocked(miniappLauncher.ensureRunning)
      .mockResolvedValue({...INSTALLED, uiRootDir: "file:///documents/lmas/com.mentra.test/1.0.1/"})
    view.rerender(<LocalMiniappView {...props} version="1.0.1" />)
    await finishLaunch()
    // The URL is the same; the WebView is a new one, so the new bundle loads.
    const second = view.UNSAFE_getByType("WebView" as never)
    expect(second.props.source).toEqual(firstSource)
    expect(second.props.miniappOrigin.rootDir).toBe("file:///documents/lmas/com.mentra.test/1.0.1/")
    expect(() => first.props).toThrow(/unmounted/)
  })
})

describe("the ready handshake", () => {
  const READY_TIMEOUT_MS = 5000

  /** One document load: its start, the shim's envelopes for it, then the WebView's load end. */
  function load(view: ReturnType<typeof render>, ...envelopes: object[]) {
    const webView = miniappWebView(view)!
    act(() => {
      webView.props.onLoadStart()
      for (const envelope of envelopes) webView.props.onMessage({nativeEvent: {data: JSON.stringify(envelope)}})
      webView.props.onLoadEnd()
    })
  }

  function splashError(view: ReturnType<typeof render>) {
    return view.getByTestId("splash-error").props.children
  }

  beforeEach(() => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    jest.spyOn(console, "log").mockImplementation(() => undefined)
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    mockDevMode = false
  })

  it("fails a page that loaded without calling mentra.ready() at the first timeout", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    load(view, {type: "page_loaded"})
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBe("common:miniappFailedToLoad")
    expect(devServerBridge.forwardLog).toHaveBeenCalledWith(
      "com.mentra.test",
      "error",
      [expect.stringContaining("never called mentra.ready()")],
      expect.any(Number),
      "ui",
    )
  })

  it("names the missing mentra.ready() call in developer mode", async () => {
    mockDevMode = true
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    load(view, {type: "page_loaded"})
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBe("common:miniappNeverReady")
  })

  it("lifts the splash for a page that calls mentra.ready()", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    load(view, {type: "page_loaded"}, {type: "ready"})
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS * 2))
    expect(splashError(view)).toBeUndefined()
  })

  it("reloads a page the shim never reached, then reports a load failure", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    for (let attempt = 1; attempt < 10; attempt++) {
      load(view)
      act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
      expect(splashError(view)).toBeUndefined()
    }
    load(view)
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBe("common:miniappFailedToLoad")
    expect(devServerBridge.forwardLog).not.toHaveBeenCalled()
  })

  it("opens a page on the reload after its shim arrived too late to announce page_loaded", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    load(view)
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    load(view, {type: "page_loaded"}, {type: "ready"})
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS * 2))
    expect(splashError(view)).toBeUndefined()
    expect(devServerBridge.forwardLog).not.toHaveBeenCalled()
  })

  it("fails a reloaded page that reached the shim but never called mentra.ready()", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    load(view)
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBeUndefined()
    load(view, {type: "page_loaded"})
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBe("common:miniappFailedToLoad")
  })

  it("retries a new document the shim never reached after an earlier one reported page_loaded", async () => {
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const webView = miniappWebView(view)!
    act(() => webView.props.onMessage({nativeEvent: {data: JSON.stringify({type: "page_loaded"})}}))
    load(view)
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBeUndefined()
  })

  it("retries a new development build's page the shim never reached", async () => {
    const build = {
      uiUri: "https://invalid.dev.com.mentra.test.miniapp.invalid/ui/index.html",
      uiOrigin: "https://invalid.dev.com.mentra.test.miniapp.invalid",
      uiRootDir: "file:///documents/lmas/com.mentra.test/dev-1000/",
      uiOriginName: "invalid.dev.com.mentra.test",
      devBuild: true,
    }
    mockActiveVersion = "dev-1000"
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(build)
    const view = render(<LocalMiniappView {...props} devBuild />)
    await finishLaunch()
    load(view, {type: "page_loaded"}, {type: "ready"})
    const next = {...build, uiRootDir: "file:///documents/lmas/com.mentra.test/dev-2000/"}
    mockActiveVersion = "dev-2000"
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(next)
    act(() => (appRegistry as unknown as {notifyForTests: () => void}).notifyForTests())
    await finishLaunch()
    load(view)
    act(() => jest.advanceTimersByTime(READY_TIMEOUT_MS))
    expect(splashError(view)).toBeUndefined()
    expect(devServerBridge.forwardLog).not.toHaveBeenCalled()
  })
})

describe("the screen's localStorage", () => {
  const NOTES = {
    uiUri: "miniapp://com.mentra.notes/ui/index.html",
    uiOrigin: "miniapp://com.mentra.notes",
    uiRootDir: "file:///documents/lmas/com.mentra.notes/1.0.30/",
    uiOriginName: "com.mentra.notes",
    devBuild: false,
  }
  const notesProps = {...props, packageName: "com.mentra.notes"}

  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "ios")
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(NOTES)
    jest.spyOn(console, "log").mockImplementation(() => undefined)
  })

  function reader(view: ReturnType<typeof render>) {
    return view.UNSAFE_queryAllByType("WebView" as never).find((webView) => webView.props.allowFileAccess === true)
  }

  function injected(view: ReturnType<typeof render>): string {
    return miniappWebView(view)!.props.injectedJavaScriptBeforeContentLoaded
  }

  /** The kept values the keeper script on the miniapp's page restores. */
  function keptIn(view: ReturnType<typeof render>): Record<string, string> {
    const literal = /var KEPT = JSON\.parse\(("(?:[^"\\]|\\.)*")\);/.exec(injected(view))![1]
    return JSON.parse(JSON.parse(literal))
  }

  async function answerRead(view: ReturnType<typeof render>, entries: Record<string, string>) {
    const move = jest.mocked(writeWebStorageReader).mock.calls.at(-1)![0]
    await act(async () => {
      reader(view)!.props.onMessage({
        nativeEvent: {data: JSON.stringify({type: "mentra_web_storage_read", nonce: move.nonce, entries, error: null})},
      })
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    return move
  }

  /** The nonce the keeper script on the miniapp's page reports with. */
  function keeperNonce(view: ReturnType<typeof render>): string {
    return /var NONCE = "([0-9a-f]+)";/.exec(injected(view))![1]
  }

  function report(view: ReturnType<typeof render>, nonce: string, ops: unknown[], loaded = false) {
    miniappWebView(view)!.props.onMessage({
      nativeEvent: {
        data: JSON.stringify({type: "mentra_web_storage_changed", nonce, ops, ...(loaded ? {loaded} : {})}),
      },
    })
  }

  it("moves the old store with the hidden page, then the page gets the kept keys before its own scripts", async () => {
    const view = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()

    // The hidden page loads first, alone, at a file:// URL with the old pages' file settings.
    const hidden = reader(view)!
    expect(hidden.props.source).toEqual({uri: "file:///cache/miniapp-web-storage-move/com.mentra.notes/read.html"})
    expect(hidden.props.allowingReadAccessToURL).toBe("file:///cache/miniapp-web-storage-move/com.mentra.notes")
    expect(hidden.props.injectedJavaScriptBeforeContentLoaded).toBeUndefined()
    expect(miniappWebView(view)).toBeUndefined()

    const move = await answerRead(view, {"onboarding-progress": '{"step":2}', "MENTRA_MOCK": "1"})
    expect(move).toMatchObject({packageName: "com.mentra.notes", attempt: 1})
    expect(reader(view)).toBeUndefined()
    expect(storage.load(webStorageMovedKey("com.mentra.notes")).is_ok()).toBe(true)

    // The miniapp's page gets the kept keys ahead of its own scripts, on its own origin only.
    const script = injected(view)
    expect(keptIn(view)).toEqual({"onboarding-progress": '{"step":2}'})
    // First of the injected scripts (the globals and shim are stubbed to "" here).
    expect(script.startsWith("(function () {")).toBe(true)
    expect(script).toContain('window.location.origin !== "miniapp://com.mentra.notes"')
    expect(script).not.toContain("MENTRA_MOCK")

    // Moved: the next open goes straight to the miniapp, still with the keeper.
    view.unmount()
    const again = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(again)).toBeUndefined()
    expect(keptIn(again)).toEqual({"onboarding-progress": '{"step":2}'})
  })

  it("keeps a third-party miniapp's localStorage too: the page's changes come back at the next load", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(reader(view)).toBeUndefined()
    const nonce = keeperNonce(view)
    act(() => {
      report(view, nonce, [], true)
      report(view, nonce, [
        ["set", "draft", "Dear diary"],
        ["set", "gone", "x"],
      ])
      report(view, nonce, [["remove", "gone"]])
      // Another screen's nonce changes nothing.
      report(view, "f".repeat(32), [["set", "draft", "forged"]])
    })
    view.unmount()

    const again = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(keptIn(again)).toEqual({draft: "Dear diary"})
    expect(injected(again)).toContain("var REPLACE = false")
  })

  it("after a replace, later documents in the same WebView merge instead of replacing again", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    // A first screen that never confirmed its load leaves the origin's contents unknown.
    const first = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    first.unmount()
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(injected(view)).toContain("var REPLACE = true")
    const nonce = keeperNonce(view)
    act(() => report(view, nonce, [["set", "draft", "after replace"]], true))
    // The page's `ready` may be on its way: the WebView's scripts don't change until it lands.
    expect(injected(view)).toContain("var REPLACE = true")
    act(() => miniappWebView(view)!.props.onMessage({nativeEvent: {data: JSON.stringify({type: "ready"})}}))
    expect(injected(view)).toContain("var REPLACE = false")
    expect(keeperNonce(view)).toBe(nonce)
    expect(keptIn(view)).toEqual({draft: "after replace"})
  })

  it("after a replace, a keeper that reports its load after `ready` still merges later documents", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const first = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    first.unmount()
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const nonce = keeperNonce(view)
    act(() => miniappWebView(view)!.props.onMessage({nativeEvent: {data: JSON.stringify({type: "ready"})}}))
    expect(injected(view)).toContain("var REPLACE = true")
    act(() => report(view, nonce, [], true))
    expect(injected(view)).toContain("var REPLACE = false")
  })

  it("keeps a development build's localStorage, and moves nothing for it", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue({...NOTES, devBuild: true})
    const dev = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(dev)).toBeUndefined()
    expect(injected(dev)).toContain("mentra_web_storage_changed")
  })

  it("keeps taking the page's reports while a relaunch of the same miniapp resolves", async () => {
    storage.save(webStorageMovedKey("com.mentra.notes"), 1)
    const view = render(<LocalMiniappView {...notesProps} version="1.0.30" />)
    await finishLaunch()
    const nonce = keeperNonce(view)
    let finishRelaunch!: (result: typeof NOTES) => void
    jest.mocked(miniappLauncher.ensureRunning).mockReturnValue(
      new Promise((resolve) => {
        finishRelaunch = resolve
      }) as never,
    )
    view.rerender(<LocalMiniappView {...notesProps} version="1.0.31" />)
    await finishLaunch()
    // The 1.0.30 page is still showing and still reported.
    expect(injected(view)).toContain(nonce)
    act(() => report(view, nonce, [["set", "mentra_recent_searches", "[1]"]]))
    await act(async () => {
      finishRelaunch({...NOTES, uiRootDir: "file:///documents/lmas/com.mentra.notes/1.0.31/"})
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(keeperNonce(view)).toBe(nonce)
    expect(keptIn(view)).toEqual({mentra_recent_searches: "[1]"})
  })

  it("opens without the move when the hidden page doesn't answer, and retries at the next open", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const view = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(view)).toBeDefined()
    await act(async () => {
      jest.advanceTimersByTime(OLD_WEB_STORAGE_READ_TIMEOUT_MS)
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(reader(view)).toBeUndefined()
    const screen = miniappWebView(view)!
    expect(screen.props.source).toEqual({uri: NOTES.uiUri})
    // The page's own changes are kept even before the move succeeds.
    expect(injected(view)).toContain("mentra_web_storage_changed")
    expect(storage.load(webStorageMovedKey("com.mentra.notes")).is_error()).toBe(true)
    view.unmount()

    const again = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(again)).toBeDefined()
    expect(attempts("com.mentra.notes")).toBe(2)
  })
})

describe("a miniapp whose start waits for its update check", () => {
  function setStartWait(wait: "check" | "update" | null) {
    act(() => {
      mockStartWaits = wait ? {"com.mentra.test": wait} : {}
      for (const listener of mockStartWaitListeners) listener()
    })
  }

  afterEach(() => {
    mockForegroundedPackage = null
  })

  it("says it is updating on the splash while an update installs, and nothing while it is only checked", async () => {
    let start!: (result: typeof INSTALLED) => void
    jest.mocked(miniappLauncher.ensureRunning).mockReturnValue(
      new Promise((resolve) => {
        start = resolve
      }),
    )
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    const label = () => view.getByTestId("splash-label").props.children
    // The splash is up from the first render, as for any open.
    expect(label()).toBeUndefined()
    setStartWait("check")
    expect(label()).toBeUndefined()
    // While it is only checked, the capsule stays under the splash, as for any open.
    let underSplash = false
    for (let node = view.getByTestId("capsule").parent; node; node = node.parent) {
      if (node.props.pointerEvents === "none") underSplash = true
    }
    expect(underSplash).toBe(true)
    setStartWait("update")
    expect(label()).toBe("home:miniappUpdating")
    // An update can take a while: the way out is above the splash, where it can be pressed.
    let ancestor = view.getByTestId("capsule").parent
    while (ancestor) {
      expect(ancestor.props.pointerEvents).not.toBe("none")
      ancestor = ancestor.parent
    }
    // Another miniapp's wait says nothing here.
    act(() => {
      mockStartWaits = {"com.mentra.notes": "update"}
      for (const listener of mockStartWaitListeners) listener()
    })
    expect(label()).toBeUndefined()
    setStartWait("update")
    // Installed: the miniapp starts, and the splash goes back to what it always shows.
    setStartWait(null)
    await act(async () => {
      start(INSTALLED)
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(label()).toBeUndefined()
    expect(view.getByTestId("splash-error").props.children).toBeUndefined()
  })

  it("closes the screen, with no error, when the miniapp is stopped before it started", async () => {
    const {engine} = jest.requireMock("@mentra/engine") as {engine: {miniapps: {clearForeground: jest.Mock}}}
    mockForegroundedPackage = "com.mentra.test"
    jest
      .mocked(miniappLauncher.ensureRunning)
      .mockRejectedValue(Object.assign(new Error("stopped before it started"), {name: "MiniappStartCancelledError"}))
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(engine.miniapps.clearForeground).toHaveBeenCalledTimes(1)
    expect(view.getByTestId("splash-error").props.children).toBeUndefined()
  })

  it("leaves the screen the person moved on to alone when its cancelled start reports back", async () => {
    const {engine} = jest.requireMock("@mentra/engine") as {engine: {miniapps: {clearForeground: jest.Mock}}}
    mockForegroundedPackage = null
    jest
      .mocked(miniappLauncher.ensureRunning)
      .mockRejectedValue(Object.assign(new Error("stopped before it started"), {name: "MiniappStartCancelledError"}))
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()
    expect(view.getByTestId("splash-error").props.children).toBeUndefined()
  })
})

describe("a launch the age gate refuses", () => {
  const ageRestricted = () => Object.assign(new Error("age-rated"), {name: "MiniappAgeRestrictedError"})

  afterEach(() => {
    mockForegroundedPackage = null
  })

  it("closes the screen instead of showing an error", async () => {
    const {engine} = jest.requireMock("@mentra/engine") as {engine: {miniapps: {clearForeground: jest.Mock}}}
    mockForegroundedPackage = "com.mentra.test"
    jest.mocked(miniappLauncher.ensureRunning).mockRejectedValue(ageRestricted())
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(engine.miniapps.clearForeground).toHaveBeenCalledTimes(1)
    expect(view.getByTestId("splash-error").props.children).toBeUndefined()
  })

  it("leaves another miniapp in front alone", async () => {
    const {engine} = jest.requireMock("@mentra/engine") as {engine: {miniapps: {clearForeground: jest.Mock}}}
    mockForegroundedPackage = "com.mentra.notes"
    jest.mocked(miniappLauncher.ensureRunning).mockRejectedValue(ageRestricted())
    render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()
  })

  it("arriving after the view moved on to another miniapp, closes nothing", async () => {
    const {engine} = jest.requireMock("@mentra/engine") as {engine: {miniapps: {clearForeground: jest.Mock}}}
    let refuse!: (error: Error) => void
    jest
      .mocked(miniappLauncher.ensureRunning)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)))
      .mockResolvedValue(NO_UI)
    const view = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    mockForegroundedPackage = "com.mentra.notes"
    view.rerender(<LocalMiniappView {...props} packageName="com.mentra.notes" />)
    // Even if the refused miniapp is in front again by the time the answer lands, the old launch closes nothing.
    mockForegroundedPackage = "com.mentra.test"
    await act(async () => {
      refuse(ageRestricted())
      await Promise.resolve()
    })
    expect(engine.miniapps.clearForeground).not.toHaveBeenCalled()
  })
})
