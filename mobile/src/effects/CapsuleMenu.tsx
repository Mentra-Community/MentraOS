import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCapsuleStore} from "@/stores/capsule"

import {PixelRatio, Platform, View} from "react-native"
import {Pressable} from "react-native-gesture-handler"
import {useMemo} from "react"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import GlassView from "@/components/ui/GlassView"
import {usePathname} from "expo-router"
import {useAppStatusStore} from "@mentra/island"
import * as ImageManipulator from "expo-image-manipulator"
import {captureRef} from "react-native-view-shot"
import {Image as RNImage} from "react-native"

interface CapsuleButtonProps {
  onMinusPress?: () => void
}

function CapsuleButton({onMinusPress}: CapsuleButtonProps) {
  const {theme} = useAppTheme()

  // On Android, GlassView is just a plain View with no blur, so the capsule
  // needs an explicit background to stay readable over arbitrary app content.
  const androidStyle = Platform.OS === "android" ? {backgroundColor: theme.colors.primary_foreground} : undefined

  return (
    <GlassView
      transparent={true}
      className="flex-row justify-between rounded-full h-10.5 w-10.5 items-center"
      style={androidStyle}>
      <Pressable
        hitSlop={10}
        onPress={onMinusPress}
        style={({pressed}) => [
          pressed && {backgroundColor: theme.colors.input},
          {
            position: "absolute",
            width: 42,
            height: 42,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 100,
            // borderTopRightRadius: 40,
            // borderBottomRightRadius: 40,
          },
        ]}>
        <Icon name={"house"} size={20} color={theme.colors.foreground} className="mb-0.5" />
      </Pressable>
    </GlassView>
  )
}

/**
 * App-wide capsule button host. Mount once in AllEffects. Reads the active
 * registration from useCapsuleStore (populated by useRegisterCapsule from each
 * miniapp screen) and renders the house-icon button when the current pathname
 * matches the registration's visibleOnRoutes. The screenshot focus effect is
 * owned by useRegisterCapsule, not here, because useFocusEffect must run inside
 * a screen.
 */
export default function CapsuleMenu({forceShow}: {forceShow: boolean}) {
  const active = useCapsuleStore((s) => s.active)
  const pathname = usePathname()
  const insets = useSaferAreaInsets()
  const {theme} = useAppTheme()
  let top = theme.spacing.s2
  let right = theme.spacing.s4
  top += active?.offsetTop ?? 0
  right += active?.offsetRight ?? 0
  top += insets.top

  if (!forceShow) {
    const isOnAllowedRoute = useMemo(() => {
      if (!active) return false
      const routes = active.visibleOnRoutes
      if (!routes || routes.length === 0) return true
      return routes.some((r) => pathname === r || pathname.startsWith(r.endsWith("/") ? r : r + "/"))
    }, [active, pathname])

    if (!active || !isOnAllowedRoute) return null
  }

  return (
    <View
      className="z-12 absolute items-center justify-end flex-row"
      style={{top: top, right: right}}
      pointerEvents="box-none">
      <CapsuleButton onMinusPress={() => active?.handleExit(true)} />
    </View>
  )
}

export async function captureScreenshot(
  viewShotRef: React.RefObject<View | null>,
  packageName: string,
  topInsetOffset: number = 0,
) {
  if (Platform.OS === "ios") {
    captureRef(viewShotRef, {
      format: "jpg",
      quality: 0.1,
      result: "tmpfile",
    })
      .then(async (uri) => {
        const {width, height} = await new Promise<{width: number; height: number}>((resolve, reject) => {
          RNImage.getSize(uri, (w, h) => resolve({width: w, height: h}), reject)
        })
        let amountToChop = topInsetOffset * PixelRatio.get()
        amountToChop = 0
        const context = ImageManipulator.ImageManipulator.manipulate(uri)
        context.crop({originX: 0, originY: amountToChop, width: width, height: height - amountToChop})
        const imageRef = await context.renderAsync()
        const cropped = await imageRef.saveAsync({
          format: ImageManipulator.SaveFormat.JPEG,
          compress: 0.1,
        })
        await useAppStatusStore.getState().saveScreenshot(packageName, cropped.uri)
      })
      .catch((e) => {
        console.warn("screenshot failed:", e)
      })
  } else {
    captureRef(viewShotRef, {
      format: "jpg",
      // handleGLSurfaceViewOnAndroid: true,
      quality: 0.5, // android needs a higher quality to avoid compression artifacts
      result: "tmpfile",
    })
      .then(async (uri) => {
        // android is weird and the crop doesn't work properly:
        useAppStatusStore.getState().saveScreenshot(packageName, uri)
      })
      .catch((e) => {
        console.warn("screenshot failed:", e)
      })
  }
}
