import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {View, ViewStyle} from "react-native"

import {Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"

export const PairGlassesCard = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  return (
    <View className="py-5 px-6 bg-primary-foreground" style={style}>
      <Text
        tx="onboarding:doYouHaveGlasses"
        className="text-lg text-center font-semibold text-secondary-foreground mb-6"
      />
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
          onPress={() => push("/pairing/prep", {modelName: DeviceTypes.SIMULATED})}
        />
      </View>
    </View>
  )
}