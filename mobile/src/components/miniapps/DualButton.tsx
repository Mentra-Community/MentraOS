import {Button, Icon, Text} from "@/components/ignite"
import {focusEffectPreventBack, push, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ClientAppletInterface, SYSTEM_APPS, uninstallAppUI, useAppletStatusStore} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {BottomSheetBackdrop, BottomSheetModal} from "@gorhom/bottom-sheet"
import {Dimensions, Platform, Share, View} from "react-native"
import {Pressable} from "react-native-gesture-handler"
import {captureRef} from "react-native-view-shot"
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useMemo} from "react"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import AppIcon from "@/components/home/AppIcon"
import GlassView from "@/components/ui/GlassView"
import {translate} from "@/i18n"

interface DualButtonProps {
  onMinusPress?: () => void
  onEllipsisPress?: () => void
}

export function DualButton({onMinusPress, onEllipsisPress}: DualButtonProps) {
  const [isChina] = useSetting(SETTINGS.china_deployment.key)
  const {theme} = useAppTheme()

  return (
    <GlassView transparent={false} className="flex-row gap-2 rounded-full bg-primary-foreground px-2 py-1 items-center">
      <Pressable hitSlop={10} onPress={onEllipsisPress}>
        <Icon name="ellipsis" color={theme.colors.foreground} />
      </Pressable>
      <View className="h-4 w-px bg-gray-300" />
      <Pressable hitSlop={10} onPress={onMinusPress}>
        <Icon name={isChina ? "x" : "minus"} color={theme.colors.foreground} />
      </Pressable>
    </GlassView>
  )
}

export function MiniAppDualButtonHeader({
  packageName,
  viewShotRef,
  onEllipsisPress,
  onMinusPress,
}: {
  packageName: string
  viewShotRef: React.RefObject<View | null>
  onEllipsisPress?: () => void
  onMinusPress?: () => void
}) {
  const {goBack} = useNavigationHistory()
  const bottomSheetRef = useRef<BottomSheetModal>(null)

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
      handleExit()
    }
  }, [onMinusPress])

  const handleExit = async () => {
    // take a screenshot of the webview and save it to the applet zustand store:
    try {
      const uri = await captureRef(viewShotRef, {
        format: "jpg",
        quality: 0.1,
      })
      // save uri to zustand store
      await useAppletStatusStore.getState().saveScreenshot(packageName, uri)
    } catch (e) {
      console.warn("screenshot failed:", e)
    }
    goBack()
  }
  focusEffectPreventBack(() => {
    handleExit()
  }, true)
  return (
    <View className="z-2 absolute top-3 right-6 items-center justify-end flex-row">
      <DualButton onMinusPress={handleMinusPress} onEllipsisPress={handleEllipsisPress} />
      <MiniAppMoreActionsSheet ref={bottomSheetRef} packageName={packageName} />
    </View>
  )
}
interface MiniAppMoreActionsSheetProps {
  packageName: string
}

export const MiniAppMoreActionsSheet = forwardRef<BottomSheetModal, MiniAppMoreActionsSheetProps>(
  ({packageName}, ref) => {
    const {theme} = useAppTheme()
    const screenHeight = Dimensions.get("window").height
    const snapPoints = useMemo(() => [screenHeight < 700 ? "70%" : "50%"], [screenHeight])
    const internalRef = useRef<BottomSheetModal>(null)
    const insets = useSaferAreaInsets()
    const [app, setApp] = useState<ClientAppletInterface | null>(null)
    const {clearHistoryAndGoHome} = useNavigationHistory()
    const [superMode] = useSetting(SETTINGS.super_mode.key)

    useEffect(() => {
      const app = useAppletStatusStore.getState().apps.find((app) => app.packageName === packageName)
      if (app) {
        setApp(app)
      }
    }, [packageName])

    // Merge refs so both the parent and internal ref work
    useImperativeHandle(ref, () => internalRef.current!)

    const renderBackdrop = useCallback(
      (props: any) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />
      ),
      [],
    )

    const handleUninstall = useCallback(() => {
      // Composer.getInstance().uninstallMiniApp(packageName)
      const app = useAppletStatusStore.getState().apps.find((app) => app.packageName === packageName)
      if (app) {
        uninstallAppUI(app)
      }
    }, [packageName])

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
      push("/miniapps/settings/feedback")
    }, [packageName])

    const handleSettings = useCallback(() => {
      internalRef.current?.dismiss()
      push("/applet/settings", {
        packageName: packageName,
        appName: app?.name,
      })
    }, [packageName])

    const isSystemApp = SYSTEM_APPS.includes(packageName)
    const isUninstallable = isSystemApp ? false : true
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
            <View className="flex-col gap-2 items-center w-1/4">
              <Button compactIcon onPress={handleShare} preset="alternate" className="rounded-2xl w-16 h-16">
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

            <View className="flex-col gap-2 items-center w-1/4">
              <Button compactIcon onPress={handleSettings} preset="alternate" className="rounded-2xl w-16 h-16">
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
