import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import LoginScreen from "@/app/auth/start"
import EmailLoginScreen from "@/app/auth/email-login"

const mockPush = jest.fn()
const mockReturnToMentra = jest.fn()
const mockShowAlert = jest.fn()

jest.mock("expo-router", () => ({useLocalSearchParams: () => ({})}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({focusEffectPreventBack: jest.fn()}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {
    getState: () => ({push: mockPush, setAnimation: jest.fn(), goBack: jest.fn(), replace: jest.fn()}),
  },
}))
jest.mock("@/services/deployment", () => ({useDeployment: () => ({store: {returnToMentra: mockReturnToMentra}})}))
jest.mock("@mentra/engine", () => ({SETTINGS: {china_deployment: {key: "china"}}, useSetting: () => [true]}))
jest.mock("@/contexts/DeeplinkContext", () => ({useDeeplink: () => ({processUrl: jest.fn()})}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {foreground: "black", background: "white", textDim: "gray"}}}),
}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockShowAlert(...args)}))
jest.mock("@/utils/auth/authErrors", () => ({mapAuthError: (error: Error) => error.message}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("assets/icons/component/AppleIcon", () => () => null, {virtual: true})
jest.mock("assets/icons/component/GoogleIcon", () => () => null, {virtual: true})
jest.mock("@expo/vector-icons", () => ({FontAwesome: () => null}))
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {
    Button: () => null,
    Header: () => null,
    Icon: () => null,
    Screen: ({children}: {children: ReactNode}) => children,
    Text: ({text, tx, children}: {text?: string; tx?: string; children?: ReactNode}) => (
      <Text>{text ?? tx ?? children}</Text>
    ),
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockReturnToMentra.mockResolvedValue(undefined)
})

test("Log in uses the same deployment-gated navigation for native activation and touch", async () => {
  const {getByText} = render(<LoginScreen />)
  await act(async () => fireEvent(getByText("login:logIn"), "accessibilityTap"))
  expect(mockReturnToMentra).toHaveBeenCalledTimes(1)
  expect(mockPush).toHaveBeenCalledWith("/auth/email-login")

  await act(async () => fireEvent.press(getByText("login:logIn")))
  expect(mockReturnToMentra).toHaveBeenCalledTimes(2)
  expect(mockPush).toHaveBeenCalledTimes(2)

  mockReturnToMentra.mockRejectedValue(new Error("Deployment unavailable"))
  await act(async () => fireEvent(getByText("login:logIn"), "accessibilityTap"))
  expect(mockPush).toHaveBeenCalledTimes(2)
  expect(mockShowAlert).toHaveBeenCalledWith("common:error", "Deployment unavailable", [{text: "common:ok"}])
})

test("Forgot password opens the existing form through native activation and touch", () => {
  const {getByText} = render(<EmailLoginScreen />)
  fireEvent(getByText("login:forgotPassword"), "accessibilityTap")
  expect(mockPush).toHaveBeenCalledWith("/auth/forgot-password")
  expect(mockPush).toHaveBeenCalledTimes(1)
  fireEvent.press(getByText("login:forgotPassword"))
  expect(mockPush).toHaveBeenCalledTimes(2)
})
