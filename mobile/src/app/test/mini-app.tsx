import {View} from "react-native"

import {Screen, Header} from "@/components/ignite"
import {useNavigationStore} from "@/stores/navigation"

export default function MiniApp() {
  const {goBack} = useNavigationStore.getState()

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MiniApp"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />
      <View className="flex-1" />
    </Screen>
  )
}
