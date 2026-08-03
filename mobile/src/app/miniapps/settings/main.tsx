import {Platform, View} from "react-native"
import {ScrollView} from "react-native-gesture-handler"

import {VersionInfo} from "@/components/dev/VersionInfo"
import {Icon, Screen} from "@/components/ignite"
import {DeviceSettingsSection} from "@/components/settings/DeviceSettingsSection"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@mentra/engine"
import {useRef} from "react"
import {useRegisterCapsule} from "@/stores/capsule"

export default function MainSettingsPage() {
  const {theme} = useAppTheme()
  const {push} = useNavigationStore.getState()
  const [debugMode] = useSetting(SETTINGS.debug_mode.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [appearanceMenuEnabled] = useSetting(SETTINGS.appearance_menu_enabled.key)
  const [miniappDevMode] = useSetting(SETTINGS.miniapp_dev_mode.key)
  const viewShotRef = useRef<View>(null)

  useRegisterCapsule({
    packageName: "com.mentra.settings",
    viewShotRef,
    visibleOnRoutes: ["/miniapps/settings/"],
    offsetRight: theme.spacing.s2,
  })

  return (
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
              onPress={() =>
                push("/miniapps/settings/feedback", {
                  triggerSource: "settings",
                  sourceRoute: "/miniapps/settings/",
                })
              }
            />
          </Group>

          {/* Device/glasses settings, flattened inline (previously a separate page) */}
          <DeviceSettingsSection />

          <Group title={translate("account:appSettings")}>
            {appearanceMenuEnabled && (
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
            {/* Microphone lives in the device section above (it's a glasses mic selector) */}
            <RouteButton
              icon={<Icon name="volume" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:speechSettings")}
              onPress={() => push("/miniapps/settings/speech")}
            />
            <RouteButton
              icon={<Icon name="shield-lock" size={24} color={theme.colors.secondary_foreground} />}
              label={translate("settings:privacySettings")}
              onPress={() => push("/miniapps/settings/privacy")}
            />
          </Group>

          <Group title={translate("deviceSettings:advancedSettings")}>
            {debugMode && (
              <RouteButton
                icon={<Icon name="user-code" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:debugSettings")}
                onPress={() => push("/miniapps/settings/debug")}
                onLongPress={() => superMode && push("/miniapps/settings/super")}
              />
            )}
            {miniappDevMode && (
              <RouteButton
                icon={<Icon name="user-code" size={24} color={theme.colors.secondary_foreground} />}
                label={translate("settings:miniappDeveloperSettings")}
                onPress={() => push("/miniapps/settings/miniapp-dev")}
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
