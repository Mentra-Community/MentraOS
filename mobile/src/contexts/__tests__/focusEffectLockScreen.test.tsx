import {render} from "@testing-library/react-native"
import {useEffect} from "react"

import {focusEffectLockScreen} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"

const mockSetOptions = jest.fn()
const mockNavigation = {
  addListener: jest.fn(() => jest.fn()),
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

describe("focusEffectLockScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useNavigationStore.setState({androidBackFn: undefined, preventBack: false, preventBackCount: 0})
  })

  it("claims the Android back slot from the screen it was pushed on top of", () => {
    // decPreventBack only clears androidBackFn once the count reaches zero, so
    // the screen underneath still holds the slot when it blurs — NavigationHost
    // would run its handler (minimize / goBack) and pop us off the OTA flow.
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
})
