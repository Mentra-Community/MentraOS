import {View, TextStyle, ViewStyle} from "react-native"

import {Text, Icon} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {StatusCard} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import {engine} from "@mentra/engine"

interface BatteryStatusProps {
  compact?: boolean
}

export function BatteryStatus({compact}: BatteryStatusProps) {
  const {theme, themed} = useAppTheme()

  const status = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const caseBatteryLevel = status.case.battery
  const caseCharging = status.case.charging
  const caseRemoved = status.case.removed
  const glassesBatteryLevel = status.battery
  const glassesCharging = status.charging

  if (glassesBatteryLevel === undefined || glassesBatteryLevel === -1) {
    return null
  }

  if (compact) {
    return (
      <View style={themed($sideBySideContainer)}>
        {glassesBatteryLevel !== -1 && (
          <StatusCard
            style={{
              backgroundColor: theme.colors.primary_foreground,
              flex: 1,
              paddingHorizontal: theme.spacing.s4,
              paddingRight: theme.spacing.s5,
              paddingVertical: theme.spacing.s5,
            }}
            label={translate("deviceSettings:glasses")}
            textStyle={themed($compactLabelStyle)}
            iconEnd={
              <View style={themed($compactBatteryValue)}>
                <Icon name={glassesCharging ? "battery-charging" : "battery-3"} size={16} color={theme.colors.text} />
                <Text style={themed($compactTextStyle)}>{glassesBatteryLevel}%</Text>
              </View>
            }
          />
        )}

        {caseBatteryLevel !== undefined && caseBatteryLevel !== -1 && !caseRemoved && (
          <StatusCard
            style={{
              backgroundColor: theme.colors.primary_foreground,
              flex: 1,
              paddingHorizontal: theme.spacing.s4,
              paddingVertical: theme.spacing.s5,
            }}
            label={translate("deviceSettings:case")}
            subtitle={caseCharging ? translate("deviceSettings:charging") : undefined}
            textStyle={themed($compactLabelStyle)}
            iconEnd={
              <View style={themed($compactBatteryValue)}>
                <Icon name={caseCharging ? "battery-charging" : "battery-3"} size={16} color={theme.colors.text} />
                <Text style={themed($compactTextStyle)}>{caseBatteryLevel}%</Text>
              </View>
            }
          />
        )}
      </View>
    )
  }

  return (
    <Group title={translate("deviceSettings:batteryStatus")}>
      {/* Glasses Battery */}
      {glassesBatteryLevel !== -1 && (
        <StatusCard
          label={translate("deviceSettings:glasses")}
          iconStart={<Icon name="glasses" size={24} color={theme.colors.foreground} />}
          iconEnd={
            <View style={themed($batteryValue)}>
              <Icon name={glassesCharging ? "battery-charging" : "battery-3"} size={16} color={theme.colors.text} />
              <Text style={themed($textStyle)}>{glassesBatteryLevel}%</Text>
            </View>
          }
        />
      )}

      {/* Case Battery */}
      {caseBatteryLevel !== undefined && caseBatteryLevel !== -1 && !caseRemoved && (
        <StatusCard
          iconStart={<Icon name="device-airpods-case" size={24} color={theme.colors.foreground} />}
          iconEnd={
            <View style={themed($batteryValue)}>
              <Icon name={caseCharging ? "battery-charging" : "battery-3"} size={16} color={theme.colors.text} />
              <Text style={themed($textStyle)}>{caseBatteryLevel}%</Text>
            </View>
          }
          label={caseCharging ? translate("deviceSettings:caseCharging") : translate("deviceSettings:case")}
        />
      )}
    </Group>
  )
}

const $sideBySideContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s2,
  // paddingHorizontal: spacing.s1,
  width: "100%",
})

// The "Glasses"/"Case" label — not bold, per Parth's design.
const $compactLabelStyle: ThemedStyle<TextStyle> = () => ({
  fontSize: 14,
})

// The battery percentage value.
const $compactTextStyle: ThemedStyle<TextStyle> = () => ({
  fontSize: 14,
  width: 60,
  fontWeight: 600,
})

const $textStyle: ThemedStyle<TextStyle> = () => ({
  // fontSize: spacing.s3,
  // fontWeight: "500",
})

const $compactBatteryValue: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  width: spacing.s8,
  marginRight: spacing.s4,
  justifyContent: "space-between",
  gap: spacing.s1,
})

const $batteryValue: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s1,
  // width: spacing.s16,
  // marginRight: spacing.s1,
  // justifyContent: "space-between",
})
