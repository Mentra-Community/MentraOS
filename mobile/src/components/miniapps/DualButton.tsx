import {Button, Icon} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ClientAppletInterface, useAppletStatusStore} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {BottomSheetBackdrop, BottomSheetModal} from "@gorhom/bottom-sheet"
import {View} from "react-native"
import {Pressable} from "react-native-gesture-handler"
import {captureRef} from "react-native-view-shot"
import {Text} from "@/components/ignite"
import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from "react"
import {useMemo} from "react"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import AppIcon from "@/components/home/AppIcon"

interface DualButtonProps {
  onMinusPress?: () => void
  onEllipsisPress?: () => void
}

export function DualButton({onMinusPress, onEllipsisPress}: DualButtonProps) {
  const [isChina] = useSetting(SETTINGS.china_deployment.key)
  const {theme} = useAppTheme()

  return (
    <View className="flex-row gap-2 rounded-full bg-primary-foreground px-2 py-1 items-center">
      <Pressable hitSlop={10} onPress={onEllipsisPress}>
        <Icon name="ellipsis" color={theme.colors.foreground} />
      </Pressable>
      <View className="h-4 w-px bg-gray-300" />
      <Pressable hitSlop={10} onPress={onMinusPress}>
        <Icon name={isChina ? "x" : "minus"} color={theme.colors.foreground} />
      </Pressable>
    </View>
  )
}

export function MiniAppDualButtonHeader({
  packageName,
  viewShotRef,
  onEllipsisPress,
}: {
  packageName: string
  viewShotRef: React.RefObject<View | null>
  onEllipsisPress?: () => void
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

  const handleExit = async () => {
    // take a screenshot of the webview and save it to the applet zustand store:
    try {
      const uri = await captureRef(viewShotRef, {
        format: "jpg",
        quality: 0.5,
      })
      // save uri to zustand stoare
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
    <View className="z-2 absolute top-3 w-full items-center justify-end flex-row">
      <DualButton onMinusPress={handleExit} onEllipsisPress={handleEllipsisPress} />
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
    const snapPoints = useMemo(() => ["50%"], [])
    const internalRef = useRef<BottomSheetModal>(null)
    const insets = useSaferAreaInsets()
    const [app, setApp] = useState<ClientAppletInterface | null>(null)

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
            {app && <AppIcon app={app as ClientAppletInterface} className="w-12 h-12" />}
            <View className="gap-1 flex-col">
              <Text className="text-lg font-bold text-foreground text-center" text={app?.name} />
              <Text className="text-sm text-muted-foreground font-medium" text={app?.packageName} />
            </View>
          </View>

          <View className="flex-1 flex-row justify-between">
            <View className="flex-col gap-2 items-center">
              <Button compactIcon onPress={() => {}} preset="alternate" className="rounded-2xl">
                <Icon name="share" color={theme.colors.foreground} size={60} />
              </Button>
              <Text className="text-sm text-muted-foreground" text="[settings]" />
            </View>
            <View className="flex-col gap-2 items-center">
              <Button compactIcon onPress={() => {}} preset="alternate" className="rounded-2xl">
                <Icon name="share" color={theme.colors.foreground} size={60} />
              </Button>
              <Text className="text-sm text-muted-foreground" tx="appInfo:share" />
            </View>
            <View className="flex-col gap-2 items-center">
              <Button compactIcon onPress={() => {}} preset="alternate" className="rounded-2xl">
                <Icon name="plus" color={theme.colors.foreground} size={60} />
              </Button>
              <Text className="text-sm text-muted-foreground" tx="appInfo:addToHome" />
            </View>
            <View className="flex-col gap-2 items-center">
              <Button compactIcon onPress={() => {}} preset="alternate" className="rounded-2xl">
                <Icon name="trash" color={theme.colors.destructive} size={60} />
              </Button>
              <Text className="text-sm text-muted-foreground" tx="appInfo:uninstall" />
            </View>
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
