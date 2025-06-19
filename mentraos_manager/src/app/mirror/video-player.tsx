import React from "react"
import {View, Text} from "react-native"
import {useLocalSearchParams, router} from "expo-router"
import {Screen, Header} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"

export default function VideoPlayer() {
  const {filePath, fileName} = useLocalSearchParams()
  const {theme} = useAppTheme()

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]}>
      <Header title="Video Player" leftIcon="caretLeft" onLeftPress={() => router.back()} />
      <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
        <Text style={{color: theme.colors.text}}>Video player not implemented yet</Text>
        <Text style={{color: theme.colors.textDim, marginTop: 8}}>{fileName || "No file selected"}</Text>
      </View>
    </Screen>
  )
}
