import {act, render} from "@testing-library/react-native"
import {Linking, Platform} from "react-native"

import LocalMiniappView from "../LocalMiniappView"
import {useNavigationStore} from "@/stores/navigation"
import {useRegisterCapsule} from "@/stores/capsule"
import {miniappLauncher} from "@mentra/engine-host-internal"
import {useStressTestStore} from "@/stores/stressTest"
import {
  keptWebStorage,
  keptWebStorageKey,
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
jest.mock("@/services/mentraJsBootstrap", () => ({getMentraJS: () => null}))
jest.mock("@/components/ignite", () => ({Text: "Text"}))
jest.mock("@/effects/CapsuleMenu", () => () => {
  const {View} = require("react-native")
  return <View testID="capsule" />
})
jest.mock("@/stores/capsule", () => ({useRegisterCapsule: jest.fn()}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("../MiniappSplash", () => (props: {error?: string}) => {
  const {Text} = require("react-native")
  return <Text testID="splash-error">{props.error}</Text>
})
/** The miniapp in front, as the engine's apps store holds it. */
let mockForegroundedPackage: string | null = null
jest.mock("@mentra/engine-host-internal", () => ({
  miniappLauncher: {ensureRunning: jest.fn()},
  useAppStatusStore: {getState: () => ({foregroundedPackage: mockForegroundedPackage})},
  buildMiniappGlobalsScript: () => "",
  buildMentraUiShim: () => "",
  localMiniappRuntime: {hasManifestPermission: () => false},
  redactSecrets: jest.requireActual("../../../../modules/engine/src/services/MentraJSLogPipeline").redactSecrets,
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
  useSetting: () => [false],
  engine: {miniapps: {clearForeground: jest.fn()}},
}))
jest.mock("@mentra/engine-host-internal/devtools", () => ({devServerBridge: {onReload: jest.fn()}}))
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
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  jest.replaceProperty(Platform, "OS", "android")
  useNavigationStore.setState({interceptor: null})
  jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(NO_UI)
  resetWebStorageMoveStateForTests()
  for (const packageName of ["com.mentra.notes", "com.mentra.test"]) {
    storage.remove(webStorageMovedKey(packageName))
    storage.remove(webStorageMoveAttemptsKey(packageName))
    storage.remove(keptWebStorageKey(packageName))
  }
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
  expect(warn).toHaveBeenCalledWith("[LocalMiniappView:com.mentra.test] WebView load error", {
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
    expect(webView.props.miniappOrigin).toEqual({packageName: "com.mentra.test", rootDir: INSTALLED.uiRootDir})
    expect(webView.props.originWhitelist).toContain(INSTALLED.uiOrigin)
    expect(webView.props.originWhitelist).not.toContain("*")
    expect(webView.props.originWhitelist.some((entry: string) => entry.startsWith("file"))).toBe(false)
    expect(webView.props.allowFileAccess).toBeUndefined()
    expect(webView.props.allowFileAccessFromFileURLs).toBeUndefined()
    expect(webView.props.allowUniversalAccessFromFileURLs).toBeUndefined()
    expect(webView.props.allowingReadAccessToURL).toBeUndefined()
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
    expect(webView.props.miniappOrigin).toEqual({packageName: snapshot.uiOriginName, rootDir: snapshot.uiRootDir})
    expect(webView.props.originWhitelist).toContain(snapshot.uiOrigin)
    expect(webView.props.originWhitelist).not.toContain(INSTALLED.uiOrigin)
  })

  it("keeps a live development build on its server", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue({
      uiUri: "http://192.168.1.20:8081/dist/ui/index.html",
      uiOrigin: "http://192.168.1.20:8081",
      uiRootDir: null,
      uiOriginName: null,
      devBuild: true,
    })
    const view = render(<LocalMiniappView {...props} devUrl="http://192.168.1.20:8081" />)
    await finishLaunch()
    const webView = view.UNSAFE_getByType("WebView" as never)
    expect(webView.props.source).toEqual({uri: "http://192.168.1.20:8081/dist/ui/index.html"})
    expect(webView.props.miniappOrigin).toBeUndefined()
    expect(webView.props.originWhitelist).toContain("http://192.168.1.20:8081")
    expect(webView.props.allowFileAccess).toBeUndefined()
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

describe("a first-party miniapp's web storage", () => {
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

  async function answerRead(view: ReturnType<typeof render>, entries: Record<string, string>) {
    const move = jest.mocked(writeWebStorageReader).mock.calls.at(-1)![0]
    await act(async () => {
      reader(view)!.props.onMessage({
        nativeEvent: {data: JSON.stringify({type: "mentra_web_storage_read", nonce: move.nonce, entries, error: null})},
      })
      await Promise.resolve()
    })
    return move
  }

  /** The nonce the keeper script on the miniapp's page reports with. */
  function keeperNonce(view: ReturnType<typeof render>): string {
    return /var NONCE = "([0-9a-f]+)";/.exec(injected(view))![1]
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
    expect(attempts("com.mentra.notes")).toBe(1)

    const move = await answerRead(view, {"onboarding-progress": '{"step":2}', "MENTRA_MOCK": "1"})
    expect(move).toMatchObject({packageName: "com.mentra.notes", attempt: 1})
    expect(reader(view)).toBeUndefined()
    expect(storage.load(webStorageMovedKey("com.mentra.notes")).is_ok()).toBe(true)
    expect(keptWebStorage("com.mentra.notes")).toEqual({"onboarding-progress": '{"step":2}'})

    // The miniapp's page gets the kept keys ahead of its own scripts, on its own origin only.
    const script = injected(view)
    expect(script.indexOf('"onboarding-progress"')).toBeGreaterThan(-1)
    // First of the injected scripts (the globals and shim are stubbed to "" here).
    expect(script.startsWith("(function () {")).toBe(true)
    expect(script).toContain("var KEPT")
    expect(script).toContain('window.location.origin !== "miniapp://com.mentra.notes"')
    expect(script).not.toContain("MENTRA_MOCK")

    // Moved: the next open goes straight to the miniapp, still with the keeper.
    view.unmount()
    const again = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(again)).toBeUndefined()
    expect(injected(again)).toContain('"{\\"step\\":2}"')
  })

  it("keeps the page's changes, so the next load brings them back", async () => {
    const view = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    await answerRead(view, {"onboarding-progress": "x", "mentra-email-drawer-to": "ada@example.com"})
    const nonce = keeperNonce(view)
    act(() => {
      miniappWebView(view)!.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({type: "mentra_web_storage_changed", nonce, set: {mentra_recent_searches: '["q"]'}}),
        },
      })
      miniappWebView(view)!.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({type: "mentra_web_storage_changed", nonce, remove: ["mentra-email-drawer-to"]}),
        },
      })
      // Another screen's nonce changes nothing.
      miniappWebView(view)!.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: "mentra_web_storage_changed",
            nonce: "f".repeat(32),
            set: {"onboarding-progress": "z"},
          }),
        },
      })
    })
    expect(keptWebStorage("com.mentra.notes")).toEqual({"onboarding-progress": "x", "mentra_recent_searches": '["q"]'})
    view.unmount()

    const again = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(injected(again)).toContain('"mentra_recent_searches":"[\\"q\\"]"')
    expect(injected(again)).not.toContain("ada@example.com")
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
    act(() => {
      miniappWebView(view)!.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({type: "mentra_web_storage_changed", nonce, set: {mentra_recent_searches: "[1]"}}),
        },
      })
    })
    expect(keptWebStorage("com.mentra.notes")).toEqual({mentra_recent_searches: "[1]"})
    await act(async () => {
      finishRelaunch({...NOTES, uiRootDir: "file:///documents/lmas/com.mentra.notes/1.0.31/"})
      await Promise.resolve()
    })
    expect(keeperNonce(view)).toBe(nonce)
  })

  it("opens without the move when the hidden page doesn't answer, and retries at the next open", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const view = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(view)).toBeDefined()
    await act(async () => {
      jest.advanceTimersByTime(OLD_WEB_STORAGE_READ_TIMEOUT_MS)
      await Promise.resolve()
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

  it("keeps nothing for a miniapp without listed keys or a development build", async () => {
    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue(INSTALLED)
    const third = render(<LocalMiniappView {...props} />)
    await finishLaunch()
    expect(reader(third)).toBeUndefined()
    expect(injected(third)).not.toContain("mentra_web_storage")
    third.unmount()

    jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue({...NOTES, devBuild: true})
    const dev = render(<LocalMiniappView {...notesProps} />)
    await finishLaunch()
    expect(reader(dev)).toBeUndefined()
    expect(injected(dev)).not.toContain("mentra_web_storage")
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
