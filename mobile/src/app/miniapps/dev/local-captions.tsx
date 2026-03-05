import {useEffect, useRef, useState} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import LocalMiniApp from "@/components/home/LocalMiniApp"
import {Asset} from "expo-asset"
// import * as FileSystem from "expo-file-system"
import {File} from "expo-file-system"

export default function LocalCaptionsExampleDev() {
  const viewShotRef = useRef<View>(null)
  const [html, setHtml] = useState<string>("<html><body><h1>Hello World</h1></body></html>")

  useEffect(() => {
    const loadHtml = async () => {
      // load the html from the dev directory:
      const asset = Asset.fromModule(require("../../../../lma_example/com.mentra.local_captions/index.html"))
      await asset.downloadAsync()
      const res = await new File(asset.localUri!).text()
      setHtml(res)
    }
    loadHtml()
  }, [])
  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <MiniAppDualButtonHeader packageName="com.mentra.local_captions" viewShotRef={viewShotRef} />

      <View className="flex-1 -mx-6">
        <LocalMiniApp html={html} packageName="com.mentra.local_captions" />
      </View>
    </Screen>
  )
}
