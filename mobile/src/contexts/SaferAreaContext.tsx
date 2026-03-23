import {useAppTheme} from "@/contexts/ThemeContext"
import React, {createContext, useContext, useMemo} from "react"
import {Platform} from "react-native"
import {EdgeInsets, useSafeAreaInsets} from "react-native-safe-area-context"

const SaferAreaContext = createContext<EdgeInsets>({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
})

export const useSaferAreaInsets = () => useContext(SaferAreaContext)

interface SaferAreaProviderProps {
  children: React.ReactNode
}

export function SaferAreaProvider({children}: SaferAreaProviderProps) {
  const insets = useSafeAreaInsets()
  const {theme} = useAppTheme()

  const adjustedInsets = useMemo<EdgeInsets>(() => {
    if (Platform.OS !== "android") {
      return insets
    }

    let overrides = {...insets}

    if (insets.top) {
      overrides.top += theme.spacing.s4
    } else {
      overrides.top = theme.spacing.s4
    }

    if (insets.bottom) {
      overrides.bottom += theme.spacing.s6
    } else {
      overrides.bottom = theme.spacing.s6
    }
    return overrides
  }, [insets])

  return <SaferAreaContext.Provider value={adjustedInsets}>{children}</SaferAreaContext.Provider>
}
