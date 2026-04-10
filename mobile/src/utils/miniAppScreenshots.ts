import {useFocusEffect} from "@react-navigation/native"
import {useNavigation} from "expo-router"
import {RefObject, useCallback, useRef} from "react"
import {Platform, View} from "react-native"
import {captureRef} from "react-native-view-shot"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppletStatusStore} from "@/stores/applets"

export async function captureAndSaveMiniAppScreenshot(
  viewShotRef: RefObject<View | null>,
  packageName: string | null | undefined,
) {
  if (!packageName || !viewShotRef.current) {
    return
  }

  try {
    const uri = await captureRef(viewShotRef, {
      format: "jpg",
      quality: 0.5,
    })
    await useAppletStatusStore.getState().saveScreenshot(packageName, uri)
  } catch (error) {
    console.warn("screenshot failed:", error)
  }
}

export function useMiniAppScreenshotBackHandler(
  viewShotRef: RefObject<View | null>,
  resolvePackageName: () => string | null | undefined,
) {
  const navigation = useNavigation()
  const {goBack, incPreventBack, decPreventBack, setAndroidBackFn} = useNavigationHistory()
  const isExitingRef = useRef(false)
  const allowNextBeforeRemoveRef = useRef(false)

  const saveScreenshot = useCallback(async () => {
    await captureAndSaveMiniAppScreenshot(viewShotRef, resolvePackageName())
  }, [resolvePackageName, viewShotRef])

  const runExitFlow = useCallback(
    async (resumeNavigation: () => void) => {
      if (isExitingRef.current) {
        return
      }

      isExitingRef.current = true

      try {
        await saveScreenshot()
        allowNextBeforeRemoveRef.current = true
        resumeNavigation()
      } catch (_error) {
        isExitingRef.current = false
        allowNextBeforeRemoveRef.current = false
      }
    },
    [saveScreenshot],
  )

  const goBackWithScreenshot = useCallback(async () => {
    await runExitFlow(() => {
      goBack()
    })
  }, [goBack, runExitFlow])

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "ios") {
        return undefined
      }

      const unsubscribe = navigation.addListener("beforeRemove", (event: any) => {
        if (allowNextBeforeRemoveRef.current) {
          allowNextBeforeRemoveRef.current = false
          return
        }

        event.preventDefault()

        void runExitFlow(() => {
          const action = event.data?.action
          if (action) {
            navigation.dispatch(action)
            return
          }
          goBack()
        })
      })

      return unsubscribe
    }, [goBack, navigation, runExitFlow]),
  )

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") {
        return undefined
      }

      incPreventBack()
      setAndroidBackFn(() => {
        void runExitFlow(() => {
          goBack()
        })
      })

      return () => {
        decPreventBack()
      }
    }, [decPreventBack, goBack, incPreventBack, runExitFlow, setAndroidBackFn]),
  )

  return {
    saveScreenshot,
    goBackWithScreenshot,
  }
}
