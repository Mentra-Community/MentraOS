import {ScrollView, Image, View} from "react-native"

import {ConnectControllerButton} from "@/components/glasses/ConnectDeviceButton"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Header, Screen, Icon} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import CoreModule from "core"

import {EmptyState} from "@/components/glasses/info/EmptyState"
import {showAlert} from "@/contexts/ModalContext"

function DeviceSettings() {
  const {theme} = useAppTheme()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const controllerConnected = useGlassesStore((state) => state.controllerConnected)
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  const {push, goBack} = useNavigationHistory()

  const confirmForgetController = async () => {
    let result = await showAlert({
      title: translate("settings:forgetController"),
      message: translate("settings:forgetControllerConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:unpair")}],
      options: {allowDismiss: false},
    })
    if (result === 1) {
      try {
        CoreModule.forgetController()
      } catch (e) {
        console.log(e)
      }
      // give us a second to forget the glasses before going back
      setTimeout(() => {
        goBack()
      }, 500)
    }
  }

  const confirmDisconnectController = async () => {
    let result = await showAlert({
      title: translate("settings:disconnectControllerTitle"),
      message: translate("settings:disconnectControllerConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:disconnect")}],
      options: {allowDismiss: false},
    })

    if (result === 1) {
      CoreModule.disconnectController()
    }
  }

  // Check if no glasses are paired at all
  if (!defaultController) {
    return <EmptyState />
  }

  return (
    <View className="gap-6">
      {superMode && (
        <RouteButton label={translate("settings:layoutSettings")} onPress={() => push("/miniapps/settings/layout")} />
      )}

      <Group title={translate("deviceSettings:general")}>
        {controllerConnected && defaultController !== DeviceTypes.SIMULATED && (
          <RouteButton
            icon={<Icon name="unlink" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:disconnectController")}
            onPress={confirmDisconnectController}
          />
        )}

        {defaultController && (
          <RouteButton
            icon={<Icon name="unplug" size={24} color={theme.colors.secondary_foreground} />}
            label={translate("deviceSettings:forgetController")}
            onPress={confirmForgetController}
          />
        )}
      </Group>

      {/* this just gives the user a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}

export default function ControllerSettings() {
  const {theme} = useAppTheme()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const {goBack} = useNavigationHistory()
  const controllerConnected = useGlassesStore((state) => state.controllerConnected)

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  let pageSubtitle
  let glassesComponent

  if (defaultController) {
    pageSubtitle = formatGlassesTitle(defaultController)
    if (defaultController !== DeviceTypes.SIMULATED) {
      glassesComponent = (
        <Image source={getGlassesImage(defaultController)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
      )
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("deviceSettings:title")}
        subtitle={pageSubtitle}
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        RightActionComponent={glassesComponent}
      />
      <ScrollView className="pr-4 -mr-4" contentInsetAdjustmentBehavior="automatic">
        {!controllerConnected && <Spacer height={theme.spacing.s6} />}
        {!controllerConnected && <ConnectControllerButton />}
        <Spacer height={theme.spacing.s6} />
        <DeviceSettings />
      </ScrollView>
    </Screen>
  )
}
