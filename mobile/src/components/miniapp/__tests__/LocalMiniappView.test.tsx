import {act, render} from "@testing-library/react-native"
import {Platform} from "react-native"

import LocalMiniappView from "../LocalMiniappView"
import {useNavigationStore} from "@/stores/navigation"
import {useRegisterCapsule} from "@/stores/capsule"
import {miniappLauncher} from "@mentra/engine-host-internal"

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
jest.mock("@mentra/engine-host-internal", () => ({
  miniappLauncher: {ensureRunning: jest.fn()},
  buildMiniappGlobalsScript: () => "",
  buildMentraUiShim: () => "",
}))

jest.mock("@mentra/engine", () => ({
  BgTimer: {setInterval: jest.fn(), clearInterval: jest.fn(), clearTimeout: jest.fn()},
  SETTINGS: {dev_mode: {key: "dev_mode"}},
  useSetting: () => [false],
  engine: {miniapps: {clearForeground: jest.fn()}},
}))
jest.mock("@mentra/engine-host-internal/devtools", () => ({devServerBridge: {onReload: jest.fn()}}))

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
  jest.mocked(miniappLauncher.ensureRunning).mockResolvedValue({uiUri: null, uiBaseDir: null} as never)
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
