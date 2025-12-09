import {TextStyle, View, ViewStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

import {DeviceTypes} from "@/../../cloud/packages/types/src"

export const PairGlassesCard = ({style}: {style?: ViewStyle}) => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  return (
    <View style={[themed($container), style]}>
      <Text tx="onboarding:doYouHaveGlasses" style={themed($title)} />
      <View style={themed($buttonContainer)}>
        <Button
          flex={false}
          tx="home:pairGlasses"
          preset="primary"
          onPress={() => push("/pairing/select-glasses-model")}
        />
        <Button
          flex={false}
          tx="home:setupWithoutGlasses"
          preset="secondary"
          style={{backgroundColor: theme.colors.background}}
          onPress={() => push("/pairing/prep", {glassesModelName: DeviceTypes.SIMULATED})}
        />
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingHorizontal: spacing.s6,
  paddingVertical: spacing.s4,
  borderRadius: spacing.s4,
  height: 180,
  alignItems: "center",
  justifyContent: "space-between",
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  gap: spacing.s4,
  width: "100%",
})

const $title: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s4,
  fontWeight: "bold",
  color: colors.secondary_foreground,
})
