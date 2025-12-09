import {useLocalSearchParams} from "expo-router"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/utils/useAppTheme"

export default function VideoPlayer() {
  const {fileName} = useLocalSearchParams()
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]}>
      <Header title="Video Player" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
        <Text style={{color: theme.colors.text}}>Video player not implemented yet</Text>
        <Text style={{color: theme.colors.textDim, marginTop: 8}}>{fileName || "No file selected"}</Text>
      </View>
    </Screen>
  )
}
