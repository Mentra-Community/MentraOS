import React from "react"
import * as SystemUI from "expo-system-ui"
import {createContext, FC, useCallback, useContext, useEffect, useMemo, useRef, useState} from "react"
import {Appearance, ColorSchemeName, StyleProp, useColorScheme} from "react-native"
import * as NavigationBar from "expo-navigation-bar"

import {useSetting, SETTINGS} from "@/stores/settings"
import {type Theme, type ThemeContexts, type ThemedStyle, type ThemedStyleArray, lightTheme, darkTheme} from "@/theme"
import {setStatusBarStyle} from "expo-status-bar"
import {BackgroundTimer} from "@/utils/timers"
import {Uniwind} from "uniwind"

type ThemeContextType = {
  themeScheme: ThemeContexts
  setThemeContextOverride: (newTheme: ThemeContexts) => void
}

const ThemeContext = createContext<ThemeContextType>({
  themeScheme: undefined,
  setThemeContextOverride: (_newTheme: ThemeContexts) => {
    console.error("Tried to call setThemeContextOverride before the ThemeProvider was initialized")
  },
})

const themeNameToTheme = (name: ColorSchemeName): Theme => (name === "dark" ? darkTheme : lightTheme)

export type ThemeType = "light" | "dark" | "system"

export const ThemeProvider: FC<{children: React.ReactNode}> = ({children}) => {
  const colorScheme = useColorScheme()
  const [overrideTheme, setTheme] = useState<ThemeContexts>(undefined)
  const [savedTheme] = useSetting(SETTINGS.theme_preference.key)
  const hasLoaded = useRef(false)

  const setThemeContextOverride = useCallback((newTheme: ThemeContexts) => {
    setTheme(newTheme)
  }, [])

  const updateThemeType = (lightOrDark: "light" | "dark", updateUniwind = true) => {
    console.log("updateThemeType()", lightOrDark, updateUniwind)
    // somehow this helps with getting the status bar style to update:
    BackgroundTimer.setTimeout(() => {
      setStatusBarStyle(lightOrDark === "dark" ? "light" : "dark", true)
      let theme = themeNameToTheme(lightOrDark)
      SystemUI.setBackgroundColorAsync(theme.colors.background)
      NavigationBar.setButtonStyleAsync(lightOrDark === "dark" ? "light" : "dark")
      NavigationBar.setStyle(lightOrDark == "dark" ? "light" : "dark")
    }, 1000)
    setTheme(lightOrDark)
    // until the uniwind bug is fixed we can't set the uniwind theme without breaking the useColorScheme hook:
    if (updateUniwind) {
      Uniwind.setTheme(lightOrDark)
    }
  }

  // Load saved theme preference on mount
  useEffect(() => {
    console.log("loadThemePreference", savedTheme, colorScheme)

    if (savedTheme !== "system") {
      updateThemeType(savedTheme, true)
    } else {
      let themeType: "light" | "dark" = colorScheme === "dark" ? "dark" : "light"
      updateThemeType(themeType, false)
    }

    BackgroundTimer.setTimeout(() => {
      hasLoaded.current = true
    }, 1000)
  }, [])

  useEffect(() => {
    console.log("colorScheme changed", colorScheme)
    if (!hasLoaded.current) {
      return
    }

    if (savedTheme !== "system") {
    //   updateThemeType(savedTheme, true)
      return
    }

    let themeType: "light" | "dark" = colorScheme === "dark" ? "dark" : "light"
    updateThemeType(themeType, false)
  }, [colorScheme])

  // react to the setting being changed:
  useEffect(() => {
    if (!hasLoaded.current) {
      return
    }

    if (savedTheme !== "system") {
      updateThemeType(savedTheme, true)
      return
    }

    let scheme = Appearance.getColorScheme()
    let themeType: "light" | "dark" = scheme === "dark" ? "dark" : "light"
    updateThemeType(themeType, false)
  }, [savedTheme])

  const themeScheme: ThemeContexts = overrideTheme || (colorScheme === "dark" ? "dark" : "light")

  return <ThemeContext.Provider value={{themeScheme, setThemeContextOverride}}>{children}</ThemeContext.Provider>
}

interface UseAppThemeValue {
  setThemeContextOverride: (newTheme: ThemeContexts) => void
  theme: Theme
  themeContext: ThemeContexts
  themed: <T>(styleOrStyleFn: ThemedStyle<T> | StyleProp<T> | ThemedStyleArray<T>) => T
}

export const useAppTheme = (): UseAppThemeValue => {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  const {themeScheme: overrideTheme, setThemeContextOverride} = context

  const themeContext: ThemeContexts = useMemo(() => overrideTheme || "dark", [overrideTheme])
  const themeVariant: Theme = useMemo(() => themeNameToTheme(themeContext), [themeContext])

  const themed = useCallback(
    <T,>(styleOrStyleFn: ThemedStyle<T> | StyleProp<T> | ThemedStyleArray<T>) => {
      const flatStyles = [styleOrStyleFn].flat(3)
      const stylesArray = flatStyles.map((f) => {
        if (typeof f === "function") {
          return (f as ThemedStyle<T>)(themeVariant)
        } else {
          return f
        }
      })

      return Object.assign({}, ...stylesArray) as T
    },
    [themeVariant],
  )

  return {
    setThemeContextOverride,
    theme: themeVariant,
    themeContext,
    themed,
  }
}
