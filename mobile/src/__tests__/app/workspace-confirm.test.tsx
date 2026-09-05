import {act, fireEvent, render} from "@testing-library/react-native"

import WorkspaceConfirmScreen from "@/app/auth/workspace-confirm"

type RemoveEvent = {data: {action: {type: string}}; preventDefault: jest.Mock}
const mockListeners = new Set<(event: RemoveEvent) => void>()
const mockNavigation = {
  addListener: jest.fn((_name: string, listener: (event: RemoveEvent) => void) => {
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  }),
}
const mockEmitRemove = (type: string) => {
  const event = {data: {action: {type}}, preventDefault: jest.fn()}
  for (const listener of [...mockListeners]) listener(event)
  return event
}
const mockNavigationState = {
  goBack: jest.fn(),
  replace: jest.fn(),
  incPreventBack: jest.fn(),
  decPreventBack: jest.fn(),
  setAndroidBackFn: jest.fn(),
}
const mockCandidate = {
  workspaceOrigin: "https://workspace.example",
  manifest: {displayName: "Example", auth: {mode: "microsoft-entra"}},
}
const mockDeployment = {
  candidate: mockCandidate,
  clearCandidate: jest.fn(),
  store: {activate: jest.fn()},
}
const mockLogout = jest.fn()

jest.mock("expo-router", () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: (effect: () => void) => require("react").useEffect(effect, [effect]),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: Object.assign(
    (selector: (state: typeof mockNavigationState) => unknown) => selector(mockNavigationState),
    {getState: () => mockNavigationState},
  ),
}))
jest.mock("@/services/deployment", () => ({useDeployment: () => mockDeployment}))
jest.mock("@/utils/LogoutUtils", () => ({
  LogoutUtils: {performCompleteLogout: (...args: unknown[]) => mockLogout(...args)},
}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {background: "white"}}}),
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/auth/WorkspaceBrand", () => ({WorkspaceBrand: () => null}))
jest.mock("@/components/ignite", () => {
  const {Text, View, Pressable} = require("react-native")
  return {
    Text,
    Screen: View,
    Header: () => null,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled: boolean}) => (
      <Pressable onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockListeners.clear()
  mockLogout.mockResolvedValue(undefined)
})

it.each(["immediate", "deferred"])("does not cancel the %s iOS replacement after confirmation", async (timing) => {
  let replacement: RemoveEvent | undefined
  mockNavigationState.replace.mockImplementation(() => {
    if (timing === "immediate") replacement = mockEmitRemove("REPLACE")
  })
  const screen = render(<WorkspaceConfirmScreen />)
  await act(async () => fireEvent.press(screen.getByText("common:continue")))
  if (timing === "deferred") {
    act(() => {
      replacement = mockEmitRemove("REPLACE")
    })
  }

  expect(mockLogout).toHaveBeenCalledWith({skipAuthSignOut: true})
  expect(mockDeployment.store.activate).toHaveBeenCalledWith(mockCandidate)
  expect(mockNavigationState.replace).toHaveBeenCalledWith("/auth/workspace-signin")
  expect(replacement?.preventDefault).not.toHaveBeenCalled()
  expect(mockNavigationState.goBack).not.toHaveBeenCalled()
})

it("blocks back during teardown and allows back before activation", async () => {
  let finishLogout!: () => void
  mockLogout.mockImplementation(() => new Promise<void>((resolve) => (finishLogout = resolve)))
  const screen = render(<WorkspaceConfirmScreen />)
  act(() => mockEmitRemove("GO_BACK"))
  expect(mockNavigationState.goBack).toHaveBeenCalledTimes(1)
  mockNavigationState.goBack.mockClear()

  fireEvent.press(screen.getByText("common:continue"))
  let back!: RemoveEvent
  act(() => {
    back = mockEmitRemove("GO_BACK")
  })
  expect(back.preventDefault).toHaveBeenCalled()
  expect(mockNavigationState.goBack).not.toHaveBeenCalled()
  expect(mockDeployment.store.activate).not.toHaveBeenCalled()
  await act(async () => finishLogout())
})
