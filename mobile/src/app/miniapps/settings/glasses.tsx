import {ScrollView, Image} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import {EmptyState} from "@/components/glasses/info/EmptyState"
import {Header, Screen} from "@/components/ignite"
import {DeviceSettingsSection} from "@/components/settings/DeviceSettingsSection"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n/translate"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"

import {DeviceTypes} from "@/../../cloud/packages/types/src"

/**
 * Standalone device/glasses settings page.
 *
 * The body is the shared {@link DeviceSettingsSection}, which is now also
 * rendered inline on the flattened main settings page. Normal navigation
 * (home tile, main settings) goes straight to the flattened page; this route is
 * kept resolvable for the offline miniapp host and any deep links.
 */
export default function Glasses() {
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {goBack} = useNavigationStore.getState()

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  let pageSubtitle
  let glassesComponent

  if (defaultWearable) {
    pageSubtitle = formatGlassesTitle(defaultWearable)
    if (defaultWearable !== DeviceTypes.SIMULATED) {
      glassesComponent = (
        <Image source={getGlassesImage(defaultWearable)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
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
      <ScrollView
        style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        {!defaultWearable ? (
          <>
            {/* No device paired — keep the pairing CTA above the empty state */}
            <Spacer height={theme.spacing.s6} />
            <ConnectDeviceButton />
            <Spacer height={theme.spacing.s6} />
            <EmptyState />
          </>
        ) : (
          <>
            <Spacer height={theme.spacing.s6} />
            {/* Header already shows the device identity, so hide the inline one. */}
            <DeviceSettingsSection showDeviceHeader={false} />
            <Spacer height={theme.spacing.s8} />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}
