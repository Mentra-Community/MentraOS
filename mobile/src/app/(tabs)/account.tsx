import {Platform, View} from "react-native"
import {ScrollView} from "react-native-gesture-handler"

import {ProfileCard} from "@/components/account/ProfileCard"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {VersionInfo} from "@/components/dev/VersionInfo"
import {Header, Icon, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useAppTheme} from "@/utils/useAppTheme"

export default function AccountPage() {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [devMode] = useSetting(SETTINGS.dev_mode.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.s6}}>
      <Header leftTx="settings:title" RightActionComponent={<MentraLogoStandalone />} />

      <ScrollView
        style={{marginRight: -theme.spacing.s6, paddingRight: theme.spacing.s6}}
        contentInsetAdjustmentBehavior="automatic">
        <ProfileCard />

        <View style={{flex: 1, gap: theme.spacing.s6}}>
          <Group title={translate("account:accountSettings")}>
            <RouteButton
              icon={<Icon name="circle-user" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:profileSettings")}
              onPress={() => push("/settings/profile")}
            />
            <RouteButton
              icon={<Icon name="message-2-star" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:feedback")}
              onPress={() => push("/settings/feedback")}
            />
          </Group>

          {defaultWearable && (
            <Group title={translate("account:deviceSettings")}>
              <RouteButton
                icon={<Icon name="glasses" color={theme.colors.secondary_foreground} size={24} />}
                label={defaultWearable}
                onPress={() => push("/settings/glasses")}
              />
            </Group>
          )}

          <Group title={translate("account:appSettings")}>
            {/* Theme selector hidden - dark mode not complete yet
            <RouteButton
              icon={<Icon name="sun" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:appAppearance")}
              onPress={() => push("/settings/theme")}
            />
            */}
            {(Platform.OS === "android" || devMode) && (
              <RouteButton
                icon={<Icon name="bell" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:notificationsSettings")}
                onPress={() => push("/settings/notifications")}
              />
            )}
            <RouteButton
              icon={<Icon name="file-type-2" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:transcriptionSettings")}
              onPress={() => push("/settings/transcription")}
            />
            <RouteButton
              icon={<Icon name="shield-lock" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:privacySettings")}
              onPress={() => push("/settings/privacy")}
            />
          </Group>

          <Group title={translate("deviceSettings:advancedSettings")}>
            {devMode && (
              <RouteButton
                icon={<Icon name="user-code" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:developerSettings")}
                onPress={() => push("/settings/developer")}
              />
            )}
          </Group>
        </View>

        <VersionInfo />
        <Spacer height={theme.spacing.s10} />
      </ScrollView>
    </Screen>
  )
}
