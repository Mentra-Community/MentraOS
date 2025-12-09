import {BottomSheetModalProvider} from "@gorhom/bottom-sheet"
import * as Sentry from "@sentry/react-native"
import {PostHogProvider} from "posthog-react-native"
import {Suspense} from "react"
import {TextStyle, View, ViewStyle} from "react-native"
import ErrorBoundary from "react-native-error-boundary"
import {GestureHandlerRootView} from "react-native-gesture-handler"
import {KeyboardProvider} from "react-native-keyboard-controller"
import {SafeAreaProvider} from "react-native-safe-area-context"
import Toast from "react-native-toast-message"

// import {ErrorBoundary} from "@/components/error"
import {Text} from "@/components/ignite"
import BackgroundGradient from "@/components/ui/BackgroundGradient"
import {AppStoreWebviewPrefetchProvider} from "@/contexts/AppStoreWebviewPrefetchProvider"
import {AuthProvider} from "@/contexts/AuthContext"
import {CoreStatusProvider} from "@/contexts/CoreStatusProvider"
import {DeeplinkProvider} from "@/contexts/DeeplinkContext"
import {NavigationHistoryProvider} from "@/contexts/NavigationHistoryContext"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {ModalProvider} from "@/utils/AlertUtils"
import {withWrappers} from "@/utils/structure/with-wrappers"
import {useAppTheme, useThemeProvider} from "@/utils/useAppTheme"

// components at the top wrap everything below them in order:
export const AllProviders = withWrappers(
  // props => {
  //   return <ErrorBoundary catchErrors="always">{props.children}</ErrorBoundary>
  // },
  props => {
    return (
      <ErrorBoundary
        onError={(error, stackTrace) => {
          console.error("Error caught by boundary:", error)
          console.error("Stack trace:", stackTrace)
          Sentry.captureException(error)
        }}
        FallbackComponent={({error}) => (
          <View style={{flex: 1, justifyContent: "center", alignItems: "center", padding: 20}}>
            <Text style={{marginBottom: 16}}>Something went wrong</Text>
            <Text style={{marginBottom: 16, fontSize: 12}}>{error.toString()}</Text>
          </View>
        )}>
        {props.children}
      </ErrorBoundary>
    )
  },
  // props => {
  //   // return <ErrorBoundary catchErrors="always">{props.children}</ErrorBoundary>
  //   return (
  //     <Sentry.ErrorBoundary
  //       showDialog={true}
  //       // fallback={
  //       //   <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
  //       //     <Text>Something went wrong</Text>
  //       //   </View>
  //       // }
  //     >
  //       {props.children}
  //     </Sentry.ErrorBoundary>
  //   )
  // },
  props => {
    const {themeScheme, setThemeContextOverride, ThemeProvider} = useThemeProvider()
    return <ThemeProvider value={{themeScheme, setThemeContextOverride}}>{props.children}</ThemeProvider>
  },
  Suspense,
  SafeAreaProvider,
  KeyboardProvider,
  CoreStatusProvider,
  AuthProvider,
  AppStoreWebviewPrefetchProvider,
  NavigationHistoryProvider,
  DeeplinkProvider,
  props => {
    return <GestureHandlerRootView style={{flex: 1}}>{props.children}</GestureHandlerRootView>
  },
  ModalProvider,
  BottomSheetModalProvider,
  props => {
    const posthogApiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY
    const isChina = useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)

    // If no API key is provided, disable PostHog to prevent errors
    if (!posthogApiKey) {
      console.log("PostHog API key not found, disabling PostHog analytics")
      return <>{props.children}</>
    }

    if (isChina) {
      console.log("PostHog is disabled for China")
      return <>{props.children}</>
    }

    return (
      <PostHogProvider apiKey={posthogApiKey} options={{disabled: false}}>
        {props.children}
      </PostHogProvider>
    )
  },
  props => {
    return (
      <View style={{flex: 1}}>
        <BackgroundGradient>{props.children}</BackgroundGradient>
      </View>
    )
  },
  props => {
    const {themed} = useAppTheme()
    const toastConfig = {
      baseToast: ({text1, props}: {text1?: string; props?: {icon?: React.ReactNode}}) => (
        <View style={themed($toastContainer)}>
          {props?.icon && <View style={themed($toastIcon)}>{props.icon}</View>}
          <Text text={text1} style={themed($toastText)} />
        </View>
      ),
    }
    return (
      <>
        {props.children}
        <Toast config={toastConfig} />
      </>
    )
  },
)

const $toastIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.s4,
  justifyContent: "center",
  alignItems: "center",
})

const $toastText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.text,
  fontSize: spacing.s4,
})

const $toastContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  backgroundColor: colors.background,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s4,
  marginHorizontal: spacing.s4,
})
