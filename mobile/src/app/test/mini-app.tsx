import {useState, useEffect} from "react"
import {View} from "react-native"
import {Asset} from "expo-asset"

import {Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import LocalMiniApp from "@/components/home/LocalMiniApp"

export default function MiniApp() {
  const {goBack} = useNavigationHistory()
  const [htmlContent, setHtmlContent] = useState<string | null>(null)

  useEffect(() => {
    const loadHtml = async () => {
      const asset = Asset.fromModule(require("../../../lma_example/index.html"))
      await asset.downloadAsync()
      const response = await fetch(asset.localUri!)
      const html = await response.text()
      setHtmlContent(html)
    }
    loadHtml()
  }, [])

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MiniApp"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />
      <View className="flex-1">{htmlContent && <LocalMiniApp html={htmlContent} />}</View>
    </Screen>
  )
}
