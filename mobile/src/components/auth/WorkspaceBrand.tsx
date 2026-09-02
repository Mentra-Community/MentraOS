import {useEffect, useState} from "react"
import {Image, View} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"

interface WorkspaceBrandProps {
  displayName: string
  logoUrls?: {
    light: string
    dark: string
  }
  showFallbackName?: boolean
}

export function WorkspaceBrand({displayName, logoUrls, showFallbackName = false}: WorkspaceBrandProps) {
  const {theme} = useAppTheme()
  const [logoFailed, setLogoFailed] = useState(false)
  const logoUrl = theme.isDark ? logoUrls?.dark : logoUrls?.light

  useEffect(() => setLogoFailed(false), [logoUrl])

  if (logoUrl && !logoFailed) {
    return (
      <Image
        accessibilityLabel={`${displayName} logo`}
        className="w-[180px] h-24"
        resizeMode="contain"
        source={{uri: logoUrl}}
        onError={() => setLogoFailed(true)}
      />
    )
  }

  return (
    <View className="items-center">
      <View className="w-[180px] h-24 items-center justify-center">
        <Icon name="office-building" size={64} color={theme.colors.foreground} />
      </View>
      {showFallbackName ? <Text className="text-[36px] text-foreground text-center mt-4" text={displayName} /> : null}
    </View>
  )
}
