import {act, render} from "@testing-library/react-native"
import {FirmwareRecoveryStatus} from "@/components/ota/FirmwareRecoveryStatus"

let mockUser: object | null = {id: "user"}
let mockNativeListener: (value: unknown) => void
const mockStop = jest.fn()
const mockRetained: unknown[] = []
const mockSubscribe = jest.fn((_listener: () => void) => () => {})
const mockObserve = jest.fn((listener: (value: unknown) => void) => {
  mockNativeListener = listener
  return mockStop
})
jest.mock("@mentra/engine", () => ({
  engine: {
    firmwareUpdates: {
      retainedSnapshots: () => mockRetained,
      subscribeRetained: (listener: () => void) => mockSubscribe(listener),
      observeNativeRecovery: (listener: (value: unknown) => void) => mockObserve(listener),
    },
  },
}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: mockUser})}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({top: 0})}))
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {Text: ({tx}: {tx: string}) => <Text>{tx}</Text>}
})

it("keeps recovery visible after auth disappears and removes it only after native safety is observed", () => {
  const view = render(<FirmwareRecoveryStatus />)
  act(() => mockNativeListener({phase: "installing", safeToRelease: false}))
  expect(view.queryByText("ota:recoveryUpdating")).toBeNull()
  mockUser = null
  view.rerender(<FirmwareRecoveryStatus />)
  expect(view.getByText("ota:recoveryUpdating")).toBeTruthy()
  expect(view.getByText("ota:recoverySignedOut")).toBeTruthy()
  act(() => mockNativeListener({phase: "interrupted", safeToRelease: false}))
  expect(view.getByText("ota:recoveryNeedsAttention")).toBeTruthy()
  act(() => mockNativeListener({phase: "complete", safeToRelease: true}))
  expect(view.queryByText("ota:recoveryNeedsAttention")).toBeNull()
  view.unmount()
  expect(mockStop).toHaveBeenCalledTimes(1)
  expect(mockObserve).toHaveBeenCalledTimes(1)
})
