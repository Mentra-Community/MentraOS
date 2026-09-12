import {render} from "@testing-library/react-native"
import {useEffect} from "react"

import {focusEffectLockScreen} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"

const mockSetOptions = jest.fn()
const mockBeforeRemoveListeners: Array<(event: unknown) => void> = []
const mockNavigation = {
  addListener: jest.fn((event: string, listener: (event: unknown) => void) => {
    if (event === "beforeRemove") mockBeforeRemoveListeners.push(listener)
    return jest.fn()
  }),
  setOptions: mockSetOptions,
}

jest.mock("expo-router", () => ({
  // React Navigation's useFocusEffect is a focus-scoped useEffect, and these
  // screens render focused, so a plain effect reproduces both run and cleanup.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const React = require("react")
    React.useEffect(effect, [effect])
  },
  useNavigation: () => mockNavigation,
  router: {
    back: jest.fn(),
    canGoBack: () => true,
    dismissAll: jest.fn(),
    dismissTo: jest.fn(),
    push: jest.fn(),
    replace: jest.fn(),
  },
}))

function LockedScreen() {
  focusEffectLockScreen()
  return null
}

/** A screen that only asks the navigator not to go back, as most screens do. */
function PreviousScreen({onBack}: {onBack: () => void}) {
  const {incPreventBack, decPreventBack, setAndroidBackFn} = useNavigationStore.getState()
  useEffect(() => {
    incPreventBack()
    setAndroidBackFn(onBack)
    return () => decPreventBack()
  }, [decPreventBack, incPreventBack, onBack, setAndroidBackFn])
  return null
}

/** Dispatch a removal at every registered beforeRemove listener, as the navigator does. */
function dispatchRemoval(actionType: string) {
  const preventDefault = jest.fn()
  const event = {data: {action: {type: actionType}}, preventDefault}
  for (const listener of mockBeforeRemoveListeners) listener(event)
  return preventDefault
}

describe("focusEffectLockScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBeforeRemoveListeners.length = 0
    useNavigationStore.setState({androidBackFn: undefined, preventBack: false, preventBackCount: 0})
  })

  it("claims the shared back-handler slot from the screen it was pushed on top of", () => {
    // The slot itself is platform-independent; NavigationHost is its Android
    // consumer. decPreventBack only clears androidBackFn once the prevent-back
    // count reaches zero, so the screen underneath still holds the slot when it
    // blurs — NavigationHost would run its handler (minimize / goBack) and pop
    // the user off the locked screen.
    const previousScreenBack = jest.fn()
    const previous = render(<PreviousScreen onBack={previousScreenBack} />)
    const locked = render(<LockedScreen />)
    previous.unmount()

    const {androidBackFn, preventBack} = useNavigationStore.getState()
    expect(preventBack).toBe(true)
    androidBackFn?.()
    expect(previousScreenBack).not.toHaveBeenCalled()

    locked.unmount()
    expect(useNavigationStore.getState().preventBack).toBe(false)
  })

  it("disables the back gesture on its own screen, not just navigator-wide", () => {
    // The navigator's default is `forceGestureEnabled || !preventBack`, so a
    // lingering forceGestureEnabled re-enables the iOS edge swipe everywhere.
    // A per-screen option beats that default.
    const locked = render(<LockedScreen />)
    expect(mockSetOptions).toHaveBeenCalledWith({gestureEnabled: false})

    mockSetOptions.mockClear()
    locked.unmount()
    expect(mockSetOptions).toHaveBeenCalledWith({gestureEnabled: undefined})
  })

  it("blocks a back action dispatched in JS", () => {
    render(<LockedScreen />)
    expect(dispatchRemoval("GO_BACK")).toHaveBeenCalled()
    expect(dispatchRemoval("POP")).toHaveBeenCalled()
  })

  it("still lets the screen's own controls leave", () => {
    // handleFinished leaves via replace() / clearHistoryAndGoHome(); blocking
    // those would strand the user on the locked screen for good.
    render(<LockedScreen />)
    expect(dispatchRemoval("REPLACE")).not.toHaveBeenCalled()
    expect(dispatchRemoval("POP_TO_TOP")).not.toHaveBeenCalled()
    expect(dispatchRemoval("POP_TO")).not.toHaveBeenCalled()
    expect(dispatchRemoval("NAVIGATE")).not.toHaveBeenCalled()
  })
})
