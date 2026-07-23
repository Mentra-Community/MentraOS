import {useState} from "react"
import {Image} from "expo-image"
import {StyleSheet, View} from "react-native"

import {SETTINGS, useSetting} from "@mentra/engine"

export function CustomBackground() {
  const [background] = useSetting<string>(SETTINGS.home_background.key)
  const [loaded, setLoaded] = useState(false)

  if (!background) return null

  return (
    <View className="absolute inset-0" pointerEvents="none" style={!loaded && {opacity: 0}}>
      <Image
        source={{uri: background}}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
        onLoad={() => setLoaded(true)}
      />
      <View className="absolute inset-0 bg-black/30" />
    </View>
  )
}
