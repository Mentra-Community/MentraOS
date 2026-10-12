import {fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import ControllerPrepScreen from "@/app/pairing/prep-controller"
import en from "@/i18n/en"

jest.mock("@react-navigation/native", () => ({
  useRoute: () => ({params: {deviceModel: "Even Realities R1"}}),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({goBack: jest.fn(), push: jest.fn(), clearHistoryAndGoHome: jest.fn()})},
}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {}, spacing: {s6: 24}}})}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {},
  checkConnectivityRequirementsUI: jest.fn(),
  requestFeaturePermissions: jest.fn(),
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  const translate = (tx: string) => {
    const [namespace, name] = tx.split(":")
    return require("@/i18n/en").default[namespace][name]
  }
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Header: ({title}: {title: string}) => <Text>{title}</Text>,
    Text: ({text, tx}: {text?: string; tx?: string}) => <Text>{tx ? translate(tx) : text}</Text>,
    Button: ({tx, onPress}: {tx: string; onPress: () => void}) => (
      <TouchableOpacity onPress={onPress}>
        <Text>{translate(tx)}</Text>
      </TouchableOpacity>
    ),
  }
})
jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => {
  const {Text} = require("react-native")
  return function MockTroubleshootingModal({isVisible, deviceModel}: {isVisible: boolean; deviceModel: string}) {
    return isVisible ? <Text>{`Help for ${deviceModel}`}</Text> : null
  }
})

test("R1 preparation uses ring instructions and exposes R1 help", () => {
  const screen = render(<ControllerPrepScreen />)
  expect(screen.getByText("Even Realities R1")).toBeTruthy()
  expect(screen.getByText(en.pairing.r1PreviousPhone)).toBeTruthy()
  expect(screen.queryByText(/your G2/)).toBeNull()
  expect(screen.queryByText("Help for Even Realities R1")).toBeNull()
  fireEvent.press(screen.getByText(en.pairing.needMoreHelp))
  expect(screen.getByText("Help for Even Realities R1")).toBeTruthy()
})
