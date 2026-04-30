import {View, ViewStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import GlassView from "@/components/ui/GlassView"
import CoreModule from "core"
import {useState} from "react"

export const PairGlassesCard = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [started, setStarted] = useState(false)

  if (!started) {
    return (
      <GlassView className="p-5 bg-primary-foreground" style={style}>
        <Text tx="onboarding:doYouHaveGlasses" className="text-lg font-semibold text-secondary-foreground mb-4" />
        <View className="flex-col gap-4 w-full">
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
            onPress={() => setStarted(true)}
          />
        </View>
      </GlassView>
    )
  }

  return (
    <GlassView className="p-5 bg-primary-foreground" style={style}>
      <Text tx="onboarding:phoneMode" className="text-lg font-semibold text-secondary-foreground mb-2" />
      <Text tx="onboarding:phoneModeDescription" className="text-xs font-semibold text-muted-foreground mb-9" />
      <View className="flex-row gap-4">
        <Button
          flex
          className="w-1/2"
          tx="home:start"
          preset="primary"
          onPress={() => {
            CoreModule.connectSimulated()
          }}
        />
        <Button
          flex
          className="w-1/2"
          tx="home:connectGlasses"
          preset="secondary"
          style={{backgroundColor: theme.colors.background}}
          onPress={() => push("/pairing/select-glasses-model")}
        />
      </View>
    </GlassView>
  )
}
