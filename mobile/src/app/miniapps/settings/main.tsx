import {Platform, View} from "react-native"
import {ScrollView} from "react-native-gesture-handler"

import {VersionInfo} from "@/components/dev/VersionInfo"
import {Icon, Screen} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useRef} from "react"
import {useRegisterCapsule} from "@/stores/capsule"

export default function MainSettingsPage() {
  const {theme, themed} = useAppTheme()
  const {push} = useNavigationStore.getState()
  const [devMode] = useSetting(SETTINGS.dev_mode.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const viewShotRef = useRef<View>(null)

  useRegisterCapsule({
    packageName: "com.mentra.settings",
    viewShotRef,
    visibleOnRoutes: ["/miniapps/settings/main"],
    offsetRight: theme.spacing.s2,
  })

  return (
    <>
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef} className="px-0">
        <ScrollView className="pt-8 px-6" contentInsetAdjustmentBehavior="automatic">
          <View style={{flex: 1, gap: theme.spacing.s6}}>
            <Group title={translate("account:accountSettings")}>
              <RouteButton
                icon={<Icon name="circle-user" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:profileSettings")}
                onPress={() => push("/miniapps/settings/profile")}
              />
              <RouteButton
                icon={<Icon name="message-2-star" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:feedback")}
                onPress={() => push("/miniapps/settings/feedback")}
              />
            </Group>

            {defaultWearable && (
              <Group title={translate("account:deviceSettings")}>
                <RouteButton
                  icon={<Icon name="glasses" color={theme.colors.secondary_foreground} size={24} />}
                  label={defaultWearable}
                  onPress={() => push("/miniapps/settings/glasses")}
                />
              </Group>
            )}

            <Group title={translate("account:appSettings")}>
              {superMode && (
                <RouteButton
                  icon={<Icon name="sun" size={24} color={theme.colors.secondary_foreground} />}
                  label={translate("settings:appAppearance")}
                  onPress={() => push("/miniapps/settings/appearance")}
                />
              )}
              {(Platform.OS === "android" || superMode) && (
                <RouteButton
                  icon={<Icon name="bell" size={24} color={theme.colors.secondary_foreground} />}
                  label={translate("settings:notificationsSettings")}
                  onPress={() => push("/miniapps/settings/notifications")}
                />
              )}
              <RouteButton
                icon={<Icon name="microphone" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("deviceSettings:microphone")}
                onPress={() => push("/miniapps/settings/microphone")}
              />
              <RouteButton
                icon={<Icon name="file-type-2" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:transcriptionSettings")}
                onPress={() => push("/miniapps/settings/transcription")}
              />
              <RouteButton
                icon={<Icon name="shield-lock" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:privacySettings")}
                onPress={() => push("/miniapps/settings/privacy")}
              />
            </Group>

            <Group title={translate("deviceSettings:advancedSettings")}>
              {devMode && (
                <RouteButton
                  icon={<Icon name="user-code" size={24} color={theme.colors.secondary_foreground} />}
                  label={translate("settings:developerSettings")}
                  onPress={() => push("/miniapps/settings/developer")}
                />
              )}
            </Group>
          </View>

          <VersionInfo />
          <Spacer height={theme.spacing.s10} />
        </ScrollView>
      </Screen>
    </>
  )
}
