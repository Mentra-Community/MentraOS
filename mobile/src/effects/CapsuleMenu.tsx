import {Button, Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCapsuleStore} from "@/stores/capsule"

import {Dimensions, PixelRatio, Platform, Share, View} from "react-native"
import {Pressable} from "react-native-gesture-handler"
import {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from "react"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import GlassView from "@/components/ui/GlassView"
import {usePathname} from "expo-router"
import {ClientApp, useAppStatusStore} from "@mentra/island"
import * as ImageManipulator from "expo-image-manipulator"
import {captureRef} from "react-native-view-shot"
import {Image as RNImage} from "react-native"
import {BottomSheetBackdrop, BottomSheetModal} from "@gorhom/bottom-sheet"
import AppIcon from "@/components/home/AppIcon"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useNavigationStore} from "@/stores/navigation"
import {SYSTEM_APPS} from "@/constants/miniapps"

interface CapsuleButtonProps {
  onMinusPress?: () => void
  onEllipsisPress?: () => void
}

function CapsuleButton({onMinusPress, onEllipsisPress}: CapsuleButtonProps) {
  const {theme} = useAppTheme()

  // On Android, GlassView is just a plain View with no blur, so the capsule
  // needs an explicit background to stay readable over arbitrary app content.
  const androidStyle = Platform.OS === "android" ? {backgroundColor: theme.colors.primary_foreground} : undefined

  // just home button:
  // return (
  //   <GlassView
  //     transparent={true}
  //     className="flex-row justify-between rounded-full h-10.5 w-10.5 items-center"
  //     style={androidStyle}>
  //     <Pressable
  //       hitSlop={10}
  //       onPress={onMinusPress}
  //       style={({pressed}) => [
  //         pressed && {backgroundColor: theme.colors.input},
  //         {
  //           position: "absolute",
  //           width: 42,
  //           height: 42,
  //           alignItems: "center",
  //           justifyContent: "center",
  //           borderRadius: 100,
  //           // borderTopRightRadius: 40,
  //           // borderBottomRightRadius: 40,
  //         },
  //       ]}>
  //       <Icon name={"house"} size={20} color={theme.colors.foreground} className="mb-0.5" />
  //     </Pressable>
  //   </GlassView>
  // )
  return (
    <GlassView
      transparent={true}
      className="flex-row justify-between rounded-full h-8 w-20 items-center"
      style={androidStyle}>
      <Pressable
        hitSlop={10}
        onPress={onEllipsisPress}
        // className="w-8 h-full items-center justify-center rounded-l-full bg-red-500"
        style={({pressed}) => [
          pressed && {backgroundColor: theme.colors.input},
          {
            position: "absolute",
            left: 0,
            width: 40,
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            borderTopLeftRadius: 40,
            borderBottomLeftRadius: 40,
          },
        ]}>
        <Icon name="ellipsis" size={20} color={theme.colors.foreground} />
      </Pressable>
      <View className="h-4 w-px bg-primary-foreground/80 absolute left-1/2 -translate-x-1/2" />
      <Pressable
        hitSlop={10}
        onPress={onMinusPress}
        style={({pressed}) => [
          pressed && {backgroundColor: theme.colors.input},
          {
            position: "absolute",
            right: 0,
            width: 40,
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            borderTopRightRadius: 40,
            borderBottomRightRadius: 40,
          },
        ]}>
        {/* position circle under the icon: */}
        <View className="relative -top-[1px] left-0 w-4 h-4">
          <View className="w-5.5 h-5.5 bg-input rounded-full z-0 absolute -top-0.5 -left-0.5" />
          <Icon name={"x"} size={16} color={theme.colors.foreground} className="z-0 absolute top-[1px] left-[1px]" />
        </View>
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
  const bottomSheetRef = useRef<BottomSheetModal>(null)
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
      <CapsuleButton
        onMinusPress={() => active?.handleExit(true)}
        onEllipsisPress={() => {
          bottomSheetRef.current?.present()
        }}
      />
      <MiniAppMoreActionsSheet
        ref={bottomSheetRef}
        packageName={active?.packageName ?? ""}
        appNameOverride={active?.appNameOverride}
        iconUrlOverride={active?.iconUrlOverride}
      />
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

interface MiniAppMoreActionsSheetProps {
  packageName: string
  appNameOverride?: string
  iconUrlOverride?: string
}

export const MiniAppMoreActionsSheet = forwardRef<BottomSheetModal, MiniAppMoreActionsSheetProps>(
  function MiniAppMoreActionsSheet({packageName, appNameOverride, iconUrlOverride}, ref) {
    const {theme} = useAppTheme()
    const screenHeight = Dimensions.get("window").height
    const snapPoints = useMemo(() => [screenHeight < 700 ? "70%" : "50%"], [screenHeight])
    const internalRef = useRef<BottomSheetModal>(null)
    const insets = useSaferAreaInsets()
    const [app, setApp] = useState<ClientApp | null>(null)
    const [superMode] = useSetting(SETTINGS.super_mode.key)

    useEffect(() => {
      const storeApp = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
      if (storeApp) {
        setApp(storeApp)
      } else if (appNameOverride || iconUrlOverride) {
        // Dev-sideloaded miniapp not in the applet store — synthesize a minimal
        // record so the sheet can show a name + icon.
        setApp({
          packageName,
          name: appNameOverride ?? packageName,
          logoUrl: iconUrlOverride ?? "",
          loading: false,
          running: true,
          hidden: false,
          healthy: true,
          permissions: [],
        } as unknown as ClientApp)
      }
    }, [packageName, appNameOverride, iconUrlOverride])

    // Merge refs so both the parent and internal ref work
    useImperativeHandle(ref, () => internalRef.current!)

    const renderBackdrop = useCallback(
      (props: any) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />
      ),
      [],
    )

    const handleAddRemoveFromHome = useCallback(() => {
      useAppStatusStore.getState().setHiddenStatus(packageName, !app?.hidden)
      internalRef.current?.dismiss()
      useNavigationStore.getState().clearHistoryAndGoHome()
    }, [packageName, app?.hidden])

    const handleShare = useCallback(() => {
      const storeUrl = `https://apps.mentraglass.com/package/${packageName}`
      // on Android, Share.share ignores `url` and only uses `message`
      Share.share(
        Platform.OS === "android"
          ? {message: `${app?.name ?? packageName}\n${storeUrl}`}
          : {message: app?.name ?? packageName, url: storeUrl},
      )
    }, [packageName, app?.name])

    const handleFeedback = useCallback(() => {
      internalRef.current?.dismiss()
      useNavigationStore.getState().push("/miniapps/settings/feedback", {
        submissionMode: "USER_INITIATED",
        triggerArea: "applet_capsule_menu",
        triggerReason: "manual_bug_report",
        sourceAppletPackageName: packageName,
        sourceAppletName: app?.name,
      })
    }, [packageName, app?.name])

    const handleSettings = useCallback(() => {
      internalRef.current?.dismiss()
      useNavigationStore.getState().push("/applet/settings", {
        packageName: packageName,
        appName: app?.name,
      })
    }, [packageName, app?.name])

    const isSystemApp = SYSTEM_APPS.includes(packageName)
    const size = 28

    return (
      <BottomSheetModal
        ref={internalRef}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        enableDynamicSizing={false}
        backgroundStyle={{backgroundColor: theme.colors.primary_foreground}}
        handleIndicatorStyle={{backgroundColor: theme.colors.muted_foreground}}>
        <View className="px-4 flex-1 gap-6" style={{paddingBottom: insets.bottom}}>
          {/* <View className="gap-4 px-4 mb-2">
            <Text className="text-lg font-bold text-foreground text-center" tx="home:incompatibleApps" />
            <Text className="text-sm text-muted-foreground font-medium" tx="home:incompatibleAppsDescription" />
          </View> */}

          <View />

          <View className="flex-row items-center justify-center gap-4">
            {app && <AppIcon app={app as ClientApp} disableLoader={true} className="w-12 h-12" />}
            <View className="gap-1 flex-col">
              <Text className="text-lg font-bold text-foreground text-center" text={app?.name} />
              {superMode && <Text className="text-sm text-chart-4 font-medium" text={app?.packageName} />}
            </View>
          </View>

          <View className="flex-1 flex-row flex-wrap">
            {/* <View className="flex-col gap-2 items-center w-16">
              <Button compactIcon onPress={() => {}} preset="alternate" className="rounded-2xl w-16 h-16">
                <Icon name="share" color={theme.colors.foreground} size={size} />
              </Button>
              <Text className="text-sm text-muted-foreground w-full text-center" text="[settings]" />
            </View> */}
            <View className="flex-col gap-2 items-center w-1/4" style={isSystemApp ? {opacity: 0.8} : undefined}>
              <Button
                compactIcon
                onPress={isSystemApp ? undefined : handleShare}
                preset="alternate"
                className="rounded-2xl w-16 h-16"
                disabled={isSystemApp}>
                <Icon name="share" color={theme.colors.foreground} size={size} />
              </Button>
              <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:share" />
            </View>
            {app && app.hidden && (
              <View className="flex-col gap-2 items-center w-1/4">
                <Button
                  compactIcon
                  onPress={handleAddRemoveFromHome}
                  preset="alternate"
                  className="rounded-2xl w-16 h-16">
                  <Icon name="plus" color={theme.colors.foreground} size={size} />
                </Button>
                <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:addToHome" />
              </View>
            )}
            {app && !app.hidden && (
              <View className="flex-col gap-2 items-center w-1/4">
                <Button
                  compactIcon
                  onPress={handleAddRemoveFromHome}
                  preset="alternate"
                  className="rounded-2xl w-16 h-16">
                  <Icon name="minus" color={theme.colors.foreground} size={size} />
                </Button>
                <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:removeFromHome" />
              </View>
            )}

            <View className="flex-col gap-2 items-center w-1/4">
              <Button compactIcon onPress={handleFeedback} preset="alternate" className="rounded-2xl w-16 h-16">
                <Icon name="message-2-star" color={theme.colors.foreground} size={size} />
              </Button>
              <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:feedback" />
            </View>

            <View className="flex-col gap-2 items-center w-1/4" style={isSystemApp ? {opacity: 0.8} : undefined}>
              <Button
                compactIcon
                onPress={isSystemApp ? undefined : handleSettings}
                preset="alternate"
                className="rounded-2xl w-16 h-16"
                disabled={isSystemApp}>
                <Icon name="cog" color={theme.colors.foreground} size={size} />
              </Button>
              <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:settings" />
            </View>

            {/* Uninstall removed from 3-dot menu - users can uninstall from miniapp settings page */}
            {/* {isUninstallable && (
              <View className="flex-col gap-2 items-center w-1/4">
                <Button compactIcon onPress={handleUninstall} preset="alternate" className="rounded-2xl w-16 h-16">
                  <Icon name="trash" color={theme.colors.destructive} size={size} />
                </Button>
                <Text className="text-sm text-muted-foreground w-full text-center" tx="appInfo:uninstall" />
              </View>
            )} */}
          </View>

          <View className="flex-1" />

          <Button
            tx="common:cancel"
            onPress={() => {
              internalRef.current?.dismiss()
            }}
          />
        </View>
      </BottomSheetModal>
    )
  },
)
