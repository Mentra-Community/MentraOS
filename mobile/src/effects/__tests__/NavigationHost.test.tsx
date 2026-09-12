import {render} from "@testing-library/react-native"
import {BackHandler} from "react-native"

import NavigationHost from "@/effects/NavigationHost"
import {useNavigationStore, type NavInterceptor} from "@/stores/navigation"

const mockRouter = {
  back: jest.fn(),
  canGoBack: () => true,
  dismissAll: jest.fn(),
  dismissTo: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
}

jest.mock("expo-router", () => ({
  usePathname: () => "/ota/check-for-updates",
  // Lazy: jest hoists this factory above the mockRouter declaration.
  get router() {
    return mockRouter
  },
}))

function interceptorStub(goBack: () => boolean): NavInterceptor {
  return {goBack, push: () => false, replace: () => false}
}

/** Press Android hardware back the way the OS does, and report whether it was consumed. */
function pressHardwareBack(): boolean {
  const addEventListener = BackHandler.addEventListener as jest.Mock
  const handler = addEventListener.mock.calls.at(-1)?.[1] as () => boolean
  return handler()
}

describe("NavigationHost hardware back", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(BackHandler, "addEventListener").mockReturnValue({remove: jest.fn()} as never)
    useNavigationStore.setState({
      androidBackFn: undefined,
      history: ["/home", "/ota/check-for-updates"],
      historyParams: [undefined, undefined],
      interceptor: null,
      preventBack: false,
      preventBackCount: 0,
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it("hands back to an interceptor that claims it", () => {
    // A hosted miniapp holds preventBack for as long as it is mounted.
    const interceptorBack = jest.fn(() => true)
    useNavigationStore.setState({interceptor: interceptorStub(interceptorBack), preventBack: true})
    render(<NavigationHost />)

    expect(pressHardwareBack()).toBe(true)
    expect(interceptorBack).toHaveBeenCalledTimes(1)
    expect(mockRouter.back).not.toHaveBeenCalled()
  })

  it("does not let a declining interceptor bypass a locked screen", () => {
    // An offline miniapp host stays mounted (and registered) through its
    // ~260ms exit fade after pushing an external route. Its interceptor
    // declines once it is standing down, and back used to fall through to
    // router.back() — popping the screen the push just landed on.
    const lockedScreenBack = jest.fn()
    const interceptorBack = jest.fn(() => false)
    useNavigationStore.setState({
      androidBackFn: lockedScreenBack,
      interceptor: interceptorStub(interceptorBack),
      preventBack: true,
    })
    render(<NavigationHost />)

    expect(pressHardwareBack()).toBe(true)
    expect(mockRouter.back).not.toHaveBeenCalled()
    expect(lockedScreenBack).toHaveBeenCalled()
    expect(interceptorBack).toHaveBeenCalledTimes(1)
  })

  it("still goes back normally when nothing is guarding the screen", () => {
    const interceptorBack = jest.fn(() => false)
    useNavigationStore.setState({interceptor: interceptorStub(interceptorBack)})
    render(<NavigationHost />)

    expect(pressHardwareBack()).toBe(true)
    expect(mockRouter.back).toHaveBeenCalled()
    // goBack() is the single dispatch site when no guard is up.
    expect(interceptorBack).toHaveBeenCalledTimes(1)
  })
})
