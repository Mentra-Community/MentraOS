import {View, ViewStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import GlassView from "@/components/ui/GlassView"
import CoreModule from "core"

export const PairGlassesCard = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  return (
    <GlassView className="p-5 bg-primary-foreground" style={style}>
      <Text tx="onboarding:phoneMode" className="text-lg font-semibold text-secondary-foreground mb-2" />
      <Text tx="onboarding:phoneModeDescription" className="text-xs font-semibold text-muted-foreground mb-6" />
      <View className="flex-col gap-4 w-full">
        <Button
          flex={false}
          tx="home:start"
          preset="primary"
          onPress={() => {
            CoreModule.connectSimulated()
          }}
        />
        <Button
          flex={false}
          tx="home:connectGlasses"
          preset="secondary"
          style={{backgroundColor: theme.colors.background}}
          onPress={() => push("/pairing/select-glasses-model")}
        />
      </View>
    </GlassView>
  )
}
