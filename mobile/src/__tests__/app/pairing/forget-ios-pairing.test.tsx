import {engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {AppState} from "react-native"

import ForgetIosPairingScreen from "@/app/pairing/forget-ios-pairing"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

let mockGuideProps: any

jest.mock("@react-navigation/native", () => ({useRoute: jest.fn()}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({focusEffectPreventBack: jest.fn()}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/SettingsNavigationUtils", () => ({
  SettingsNavigationUtils: {openBluetoothSettings: jest.fn(async () => true)},
}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({
  MentraLogoStandalone: () => {
    const {View} = require("react-native")
    return <View testID="mentra-logo" />
  },
}))
jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string, options?: Record<string, string>) => {
    const [namespace, name] = key.split(":")
    const value = require("@/i18n/en").default[namespace][name]
    return String(value).replace(/\{\{(\w+)\}\}/g, (_match: string, token: string) => options?.[token] ?? "")
  }),
}))
jest.mock("@/components/ignite", () => {
  const {TouchableOpacity, View} = require("react-native")
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Header: ({
      onLeftPress,
      leftIcon,
      RightActionComponent,
    }: {
      onLeftPress: () => void
      leftIcon: string
      RightActionComponent: ReactNode
    }) => (
      <View>
        <TouchableOpacity accessibilityLabel={leftIcon} onPress={onLeftPress} />
        {RightActionComponent}
      </View>
    ),
  }
})
jest.mock("@/components/onboarding/OnboardingGuide", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  return {
    OnboardingGuide: (props: any) => {
      mockGuideProps = props
      return (
        <View>
          {props.steps.map((step: any) => (
            <View key={step.name}>
              <Text>{step.title}</Text>
              <Text>{step.subtitle}</Text>
              {step.numberedBullets.map((bullet: string) => (
                <Text key={bullet}>{bullet}</Text>
              ))}
            </View>
          ))}
          <TouchableOpacity onPress={props.endButtonFn}>
            <Text>{props.endButtonText}</Text>
          </TouchableOpacity>
        </View>
      )
    },
  }
})

describe("forget the old iOS pairing screen (S8)", () => {
  const replace = jest.fn()
  const goBack = jest.fn()
  const push = jest.fn()
  let appStateListener: ((state: string) => void) | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    mockGuideProps = undefined
    appStateListener = undefined
    ;(useRoute as jest.Mock).mockReturnValue({
      params: {deviceModel: "Mentra Live", deviceName: "Mentra_Live_03BE"},
    })
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({
      replace,
      goBack,
      push,
      history: ["/pairing/scan", "/pairing/forget-ios-pairing"],
    })
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _event: string,
      listener: (state: string) => void,
    ) => {
      appStateListener = listener
      return {remove: jest.fn()}
    }) as any)
    Object.defineProperty(AppState, "currentState", {value: "active", configurable: true, writable: true})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("shows the exact title, subtitle and three steps", () => {
    const screen = render(<ForgetIosPairingScreen />)

    expect(screen.getByText("Forget the old pairing")).toBeTruthy()
    expect(screen.getByText("Remove the saved Bluetooth pairing on your iPhone to continue.")).toBeTruthy()
    expect(screen.getByText("Open Settings, then tap Bluetooth.")).toBeTruthy()
    expect(screen.getByText("Tap ⓘ next to Mentra Live 03BE, then tap Forget This Device.")).toBeTruthy()
    expect(screen.getByText("Return to the Mentra App to pair again.")).toBeTruthy()
    expect(mockGuideProps.steps[0].numberedBullets).toHaveLength(3)
  })

  it("shows the programmatic illustration with a back chevron and the Mentra logo", () => {
    const screen = render(<ForgetIosPairingScreen />)

    expect(mockGuideProps.steps[0].type).toBe("image")
    expect(mockGuideProps.steps[0].source).toBeTruthy()
    expect(screen.getByLabelText("chevron-left")).toBeTruthy()
    expect(screen.getByTestId("mentra-logo")).toBeTruthy()
  })

  it("has one Open Settings button, no Try Again, and opens Bluetooth settings", async () => {
    const screen = render(<ForgetIosPairingScreen />)

    expect(screen.getByText("Open Settings")).toBeTruthy()
    expect(screen.queryByText(/try again/i)).toBeNull()
    expect(mockGuideProps.showSkipButton).toBe(false)

    await act(async () => fireEvent.press(screen.getByText("Open Settings")))

    expect(SettingsNavigationUtils.openBluetoothSettings).toHaveBeenCalledTimes(1)
  })

  it("goes back to the scan list from the back chevron without connecting", () => {
    const screen = render(<ForgetIosPairingScreen />)

    fireEvent.press(screen.getByLabelText("chevron-left"))

    expect(goBack).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(engine.pairing.pair).not.toHaveBeenCalled()
  })

  it("lets an iOS back swipe land on the scan list without popping it too", () => {
    render(<ForgetIosPairingScreen />)

    // The beforeRemove listener: the swipe is already removing this screen.
    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "POP"})

    expect(goBack).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(engine.pairing.pair).not.toHaveBeenCalled()
  })

  it("replaces with the scan list when the scan screen is not directly underneath", () => {
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({
      replace,
      goBack,
      push,
      history: ["/home", "/pairing/forget-ios-pairing"],
    })
    const screen = render(<ForgetIosPairingScreen />)

    fireEvent.press(screen.getByLabelText("chevron-left"))

    expect(replace).toHaveBeenCalledWith("/pairing/scan", {deviceModel: "Mentra Live"})
    expect(goBack).not.toHaveBeenCalled()
  })

  it("returns to the scan list once when the app comes back to the foreground", () => {
    render(<ForgetIosPairingScreen />)

    act(() => appStateListener?.("background"))
    expect(goBack).not.toHaveBeenCalled()
    act(() => appStateListener?.("active"))
    act(() => {
      appStateListener?.("background")
      appStateListener?.("active")
    })

    expect(goBack).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(engine.pairing.pair).not.toHaveBeenCalled()
  })

  it("is reachable only from the loading screen", () => {
    const {execSync} = require("child_process")
    const root = require("path").resolve(__dirname, "../../../..")
    const files = execSync(
      `grep -rlE "forget-ios-pairing|FORGET_IOS_PAIRING_ROUTE" src --include='*.ts' --include='*.tsx'`,
      {
        cwd: root,
      },
    )
      .toString()
      .split("\n")
      .filter((file: string) => file && !file.includes("__tests__") && !file.includes(".test."))
      .sort()

    expect(files).toEqual([
      "src/app/pairing/forget-ios-pairing.tsx",
      "src/app/pairing/loading.tsx",
      "src/utils/pairing/iosStaleBond.ts",
    ])
  })
})
