import {useEffect, useState} from "react"
import {Image, View} from "react-native"

import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"

interface WorkspaceBrandProps {
  displayName: string
  logoUrls?: {
    light: string
    dark: string
  }
}

export function WorkspaceBrand({displayName, logoUrls}: WorkspaceBrandProps) {
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
    <View className="w-[180px] h-24 items-center justify-center">
      <Icon name="office-building" size={64} color={theme.colors.foreground} />
    </View>
  )
}
