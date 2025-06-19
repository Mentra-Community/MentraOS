import {useAppTheme} from "@/utils/useAppTheme"
import {LinearGradient} from "expo-linear-gradient"

export default function BackgroundGradient({children}: {children: React.ReactNode}) {
  const {themed, theme} = useAppTheme()
  return (
    <LinearGradient
      colors={[theme.colors.tabBarBackground1, theme.colors.tabBarBackground2]}
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
