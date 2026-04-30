import {Button, Icon, Text} from "@/components/ignite"
import {focusEffectPreventBack, push, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ClientAppletInterface, SYSTEM_APPS, useAppletStatusStore} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {BottomSheetBackdrop, BottomSheetModal} from "@gorhom/bottom-sheet"
import {Dimensions, Image as RNImage, InteractionManager, Platform, Share, View, PixelRatio} from "react-native"
import {Pressable} from "react-native-gesture-handler"
import {captureRef} from "react-native-view-shot"
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useMemo} from "react"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import AppIcon from "@/components/home/AppIcon"
import GlassView from "@/components/ui/GlassView"
import * as ImageManipulator from "expo-image-manipulator"
import {withUniwind} from "uniwind"

interface CapsuleButtonProps {
  onMinusPress?: () => void
  onEllipsisPress?: () => void
}

const WrappedPressable = withUniwind(Pressable)

export function CapsuleButton({onMinusPress, onEllipsisPress}: CapsuleButtonProps) {
  // const [isChina] = useSetting(SETTINGS.china_deployment.key)
  const {theme} = useAppTheme()

  // On Android, GlassView is just a plain View with no blur, so the capsule
  // needs an explicit background to stay readable over arbitrary app content.
  const androidStyle = Platform.OS === "android" ? {backgroundColor: theme.colors.card} : undefined

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

export function MiniAppCapsuleMenu({
  packageName,
  viewShotRef,
  onEllipsisPress,
  onMinusPress,
  onBackPress,
  appNameOverride,
  iconUrlOverride,
}: {
  packageName: string
  viewShotRef: React.RefObject<View | null>
  onEllipsisPress?: () => void
  onMinusPress?: () => void
  onBackPress?: () => void
  /** Fallback name for miniapps not registered in the applet store (e.g. dev QR-sideloaded). */
  appNameOverride?: string
  /** Fallback icon URL for miniapps not registered in the applet store. */
  iconUrlOverride?: string
}) {
  const {goBack} = useNavigationHistory()
  const insets = useSaferAreaInsets()
  const {theme} = useAppTheme()
  const bottomSheetRef = useRef<BottomSheetModal>(null)
  const top = insets.top + theme.spacing.s2

  const handleEllipsisPress = useCallback(() => {
    if (onEllipsisPress) {
      onEllipsisPress()
    } else {
      bottomSheetRef.current?.present()
    }
  }, [onEllipsisPress])

  const handleMinusPress = useCallback(() => {
    if (onMinusPress) {
      onMinusPress()
    } else {
      handleExit(true)
    }
  }, [onMinusPress])

  const handleExit = async (shouldGoBack?: boolean) => {
    try {
      const uri = await captureRef(viewShotRef, {
        format: "jpg",
        quality: 0.1,
      })
      const {width, height} = await new Promise<{width: number; height: number}>((resolve, reject) => {
        RNImage.getSize(uri, (w, h) => resolve({width: w, height: h}), reject)
      })
      let amountToChop = insets.top * PixelRatio.get()
      amountToChop = 0
      const context = ImageManipulator.ImageManipulator.manipulate(uri)
      context.crop({originX: 0, originY: amountToChop, width: width, height: height - amountToChop})
      const imageRef = await context.renderAsync()
      const cropped = await imageRef.saveAsync({
        format: ImageManipulator.SaveFormat.JPEG,
        compress: 0.1,
      })

      if (Platform.OS === "ios") {
        await useAppletStatusStore.getState().saveScreenshot(packageName, cropped.uri)
      } else {
        // android is weird and the crop doesn't work properly:
        await useAppletStatusStore.getState().saveScreenshot(packageName, uri)
      }

      // await useAppletStatusStore.getState().saveScreenshot(packageName, cropped.uri)
      await useAppletStatusStore.getState().saveScreenshot(packageName, uri)
    } catch (e) {
      console.warn("screenshot failed:", e)
    }

    if (shouldGoBack) {
      goBack()
    }
  }

  // focusEffectPreventBack(
  //   onBackPress
  //     ? () => {
  //         onBackPress()
  //       }
  //     : () => {
  //         // Defer screenshot capture so it doesn't block the navigation animation
  //         // InteractionManager.runAfterInteractions(() => {
  //         //   let shouldGoBack = Platform.OS === "android"
  //         //   handleExit(shouldGoBack)
  //         // })
  //         let shouldGoBack = Platform.OS === "android"
  //         handleExit(shouldGoBack)
  //       },
  //   onBackPress ? false : true,
  // )

  focusEffectPreventBack(
    onBackPress
      ? () => {
          console.log("CAPSULE MENU: handleBackPress() called")
          handleExit(false)
          onBackPress()
        }
      : () => {
          console.log("CAPSULE MENU: focusEffectPreventBack() called")
          // Defer screenshot capture so it doesn't block the navigation animation
          InteractionManager.runAfterInteractions(() => {
            let shouldGoBack = Platform.OS === "android"
            handleExit(shouldGoBack)
          })
        },
    true,
  )

  return (
    <View className="z-2 absolute right-2 items-center justify-end flex-row" style={{top: top}}>
      <CapsuleButton onMinusPress={handleMinusPress} onEllipsisPress={handleEllipsisPress} />
      <MiniAppMoreActionsSheet
        ref={bottomSheetRef}
        packageName={packageName}
        appNameOverride={appNameOverride}
        iconUrlOverride={iconUrlOverride}
      />
    </View>
  )
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
    const [app, setApp] = useState<ClientAppletInterface | null>(null)
    const {clearHistoryAndGoHome} = useNavigationHistory()
    const [superMode] = useSetting(SETTINGS.super_mode.key)

    useEffect(() => {
      const storeApp = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)
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
        } as unknown as ClientAppletInterface)
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
      if (app && app.hidden) {
        useAppletStatusStore.getState().setHiddenStatus(packageName, false)
      } else {
        useAppletStatusStore.getState().setHiddenStatus(packageName, true)
      }
      internalRef.current?.dismiss()
      // useAppletStatusStore.getState().refreshApplets()
      clearHistoryAndGoHome()
    }, [packageName])

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
      push("/miniapps/settings/feedback", {
        submissionMode: "USER_INITIATED",
        triggerArea: "applet_capsule_menu",
        triggerReason: "manual_bug_report",
        sourceAppletPackageName: packageName,
        sourceAppletName: app?.name,
      })
    }, [packageName, app?.name])

    const handleSettings = useCallback(() => {
      internalRef.current?.dismiss()
      push("/applet/settings", {
        packageName: packageName,
        appName: app?.name,
      })
    }, [packageName])

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
            {app && <AppIcon app={app as ClientAppletInterface} disableLoader={true} className="w-12 h-12" />}
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
