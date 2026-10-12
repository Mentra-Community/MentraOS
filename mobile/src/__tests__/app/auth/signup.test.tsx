import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import SignupScreen from "@/app/auth/signup"

const mockSignUp = jest.fn()
const mockPush = jest.fn()
const mockReplace = jest.fn()
const mockShowAlert = jest.fn()

jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {signUp: (...args: unknown[]) => mockSignUp(...args)},
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({push: mockPush, replace: mockReplace, goBack: jest.fn()})},
}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockShowAlert(...args)}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {textDim: "gray"}, spacing: {s4: 16}}, themed: () => ({})}),
}))
jest.mock("@expo/vector-icons", () => ({FontAwesome: () => null}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Button: ({tx, onPress, disabled}: {tx: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable onPress={onPress} disabled={disabled}>
        <Text>{tx}</Text>
      </Pressable>
    ),
    Header: () => null,
    Screen: ({children}: {children: ReactNode}) => children,
    Text: ({tx, children}: {tx?: string; children?: ReactNode}) => <Text>{tx ?? children}</Text>,
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

async function submitSignup() {
  const screen = render(<SignupScreen />)
  fireEvent.changeText(screen.getByPlaceholderText("login:emailPlaceholder"), "returning@example.test")
  fireEvent.press(screen.getByText("login:signup.continue"))
  fireEvent.changeText(screen.getByPlaceholderText("login:passwordPlaceholder"), "new-password")
  fireEvent.changeText(screen.getByPlaceholderText("login:signup.confirmPasswordPlaceholder"), "new-password")
  await act(async () => fireEvent.press(screen.getByText("login:signup.createAccount")))
  return screen
}

test("an existing account offers sign-in with its email instead of claiming an email was sent", async () => {
  mockSignUp.mockResolvedValue({
    is_error: () => true,
    error: Object.assign(new Error("This email is already registered. Please sign in."), {code: "email_taken"}),
  })
  await submitSignup()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockShowAlert).toHaveBeenCalledWith("login:signup.accountExistsTitle", "login:signup.accountExistsMessage", [
    expect.objectContaining({text: "login:signup.editEmail", style: "cancel"}),
    expect.objectContaining({text: "login:logIn"}),
  ])
  const buttons = mockShowAlert.mock.calls[0][2]
  act(() => buttons[1].onPress())
  expect(mockReplace).toHaveBeenCalledWith("/auth/email-login", {email: "returning@example.test"})
})

test("the duplicate account prompt can return to editing the email", async () => {
  mockSignUp.mockResolvedValue({
    is_error: () => true,
    error: Object.assign(new Error("conflict"), {code: "email_taken"}),
  })
  const screen = await submitSignup()
  const buttons = mockShowAlert.mock.calls[0][2]
  act(() => buttons[0].onPress())
  expect(screen.getByPlaceholderText("login:emailPlaceholder").props.value).toBe("returning@example.test")
  expect(mockReplace).not.toHaveBeenCalled()
})

test("a new signup still opens verification", async () => {
  mockSignUp.mockResolvedValue({is_error: () => false})
  await submitSignup()
  expect(mockPush).toHaveBeenCalledWith("/auth/verification", {email: "returning@example.test"})
  expect(mockShowAlert).not.toHaveBeenCalled()
})

test("rate limiting offers no account-existence claim or verification navigation", async () => {
  mockSignUp.mockResolvedValue({
    is_error: () => true,
    error: Object.assign(new Error("try later"), {code: "rate_limited"}),
  })
  await submitSignup()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockShowAlert.mock.calls[0][0]).toBe("common:error")
})
