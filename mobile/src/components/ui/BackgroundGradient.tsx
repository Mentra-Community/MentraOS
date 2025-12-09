import {LinearGradient} from "expo-linear-gradient"

import {useAppTheme} from "@/utils/useAppTheme"

export default function BackgroundGradient({children, colors}: {children: React.ReactNode; colors?: [string, string]}) {
  const {theme} = useAppTheme()
  return (
    <LinearGradient
      colors={colors ?? [theme.colors.backgroundStart, theme.colors.backgroundEnd]}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
      }}
      start={{x: 0, y: 1}}
      end={{x: 0, y: 0}}>
      {children}
    </LinearGradient>
  )
}
