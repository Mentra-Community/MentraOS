import {MaterialCommunityIcons} from "@expo/vector-icons"
import {useState} from "react"
import {TouchableOpacity, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {AppPicker} from "@/components/misc/AppPicker"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {translate} from "@/i18n"
import {ClientAppletInterface} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
interface ButtonSettingsProps {
  enabled: boolean
  selectedApp: string
  applets: ClientAppletInterface[]
  onEnabledChange: (value: boolean) => void
  onAppChange: (packageName: string) => void
}

export function ButtonSettings({enabled, selectedApp, applets, onEnabledChange, onAppChange}: ButtonSettingsProps) {
  const {theme, themed} = useAppTheme()
  const [showAppPicker, setShowAppPicker] = useState(false)

  return (
    <>
      <View style={themed($container)}>
        <ToggleSetting
          label="Default Button Action"
          value={enabled}
          onValueChange={onEnabledChange}
          style={{
            paddingHorizontal: 0,
            paddingTop: 0,
            paddingBottom: enabled ? theme.spacing.s3 : 0,
            borderWidth: 0,
          }}
        />

        {enabled && (
          <>
            <View
              style={{
                height: 1,
                backgroundColor: theme.colors.separator,
                marginBottom: theme.spacing.s3,
              }}
            />
            <TouchableOpacity
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
              onPress={() => setShowAppPicker(true)}>
              <View style={{flex: 1}}>
                <Text style={{color: theme.colors.text, fontSize: 14, fontWeight: "500", marginBottom: 4}}>
                  Default App
                </Text>
                <Text style={{color: theme.colors.textDim, fontSize: 13}}>
                  {applets.find(app => app.packageName === selectedApp)?.name || "Select app"}
                </Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={20} color={theme.colors.textDim} />
            </TouchableOpacity>
          </>
        )}
      </View>

      <AppPicker
        visible={showAppPicker}
        onClose={() => setShowAppPicker(false)}
        onSelect={app => {
          onAppChange(app.packageName)
        }}
        apps={applets}
        selectedPackageName={selectedApp}
        title={translate("deviceSettings:selectDefaultApp")}
        filterPredicate={app => app.type === "standard" && app.compatibility?.isCompatible !== false} // Only show compatible foreground apps
        showCompatibilityWarnings={true}
      />
    </>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
})
