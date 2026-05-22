import {useCallback, useEffect, useRef} from "react"
import type {RefObject} from "react"
import {Image as RNImage, PixelRatio, Platform, View} from "react-native"
import {captureRef} from "react-native-view-shot"
import * as ImageManipulator from "expo-image-manipulator"
import {create} from "zustand"

import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {useAppStatusStore, useForegroundMiniApp} from "@mentra/island"
import {captureScreenshot} from "@/effects/CapsuleMenu"

export interface CapsuleRegistration {
  packageName: string
  viewShotRef: RefObject<View | null>
  appNameOverride?: string
  iconUrlOverride?: string
  /** Routes on which the visible capsule button should render. Empty/undefined = always visible while registered. */
  visibleOnRoutes?: string[]
  /** Called when the user taps the house/minus button. Captures screenshot + navigates back. */
  handleExit: (shouldGoBack?: boolean) => Promise<void> | void
  offsetTop?: number
  offsetRight?: number
}

interface CapsuleStore {
  active: CapsuleRegistration | null
  setActive: (reg: CapsuleRegistration | null) => void
}

export const useCapsuleStore = create<CapsuleStore>((set) => ({
  active: null,
  setActive: (reg) => set({active: reg}),
}))

interface UseRegisterCapsuleArgs {
  packageName: string
  viewShotRef: RefObject<View | null>
  appNameOverride?: string
  iconUrlOverride?: string
  visibleOnRoutes?: string[]
  /** Override the default screenshot+goBack behavior on Android back press. */
  onBackPress?: () => void
  offsetTop?: number
  offsetRight?: number
}

/**
 * Call from any miniapp screen that wants the global capsule button to appear
 * over its content. This hook:
 *   - Owns the screen-scoped useFocusEffect (must run inside a screen, not AllEffects).
 *   - Captures a screenshot via the screen's viewShotRef on back-navigation.
 *   - Registers metadata + the screenshot fn into useCapsuleStore so the
 *     globally-mounted <CapsuleMenu /> can render the visible button.
 */
export function useRegisterCapsule({
  packageName,
  viewShotRef,
  appNameOverride,
  iconUrlOverride,
  visibleOnRoutes,
  offsetTop,
  offsetRight,
  onBackPress,
}: UseRegisterCapsuleArgs) {
  const insets = useSaferAreaInsets()
  const {goBack} = useNavigationStore.getState()

  // Stable ref to insets.top so handleExit doesn't reallocate on every render.
  const insetsTopRef = useRef(insets.top)
  insetsTopRef.current = insets.top

  const handleExit = useCallback(
    async (shouldGoBack?: boolean) => {
      console.log("CAPSULE MENU: handleExit() called")

      captureScreenshot(viewShotRef, packageName, insets.top)

      console.log("CAPSULE MENU: screenshot captured")

      if (shouldGoBack) {
        goBack()
      }
    },
    [packageName, viewShotRef, goBack],
  )

  // Always run focusEffectPreventBack with the same shape every render to keep
  // hook order stable inside that helper.
  focusEffectPreventBack(
    onBackPress
      ? () => {
          onBackPress()
        }
      : () => {
          let shouldGoBack = Platform.OS === "android"
          handleExit(shouldGoBack)
        },
    onBackPress ? false : true,
  )

  // Register / update / unregister the capsule entry in the store.
  const routesKey = visibleOnRoutes?.join("|") ?? ""
  useEffect(() => {
    useCapsuleStore.getState().setActive({
      packageName,
      viewShotRef,
      appNameOverride,
      iconUrlOverride,
      visibleOnRoutes,
      handleExit,
      offsetTop,
      offsetRight,
    })
    return () => {
      const current = useCapsuleStore.getState().active
      if (current?.packageName === packageName && current?.viewShotRef === viewShotRef) {
        useCapsuleStore.getState().setActive(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    packageName,
    viewShotRef,
    appNameOverride,
    iconUrlOverride,
    routesKey,
    handleExit,
    offsetTop,
    offsetRight,
  ])
}
