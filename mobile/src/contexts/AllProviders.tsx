import {BottomSheetModalProvider} from "@gorhom/bottom-sheet"
import * as Sentry from "@sentry/react-native"
import {Stack} from "expo-router"
import {PostHogProvider} from "posthog-react-native"
import {Suspense, FunctionComponent, PropsWithChildren} from "react"
import {View} from "react-native"
import ErrorBoundary from "react-native-error-boundary"
import {GestureHandlerRootView} from "react-native-gesture-handler"
import {KeyboardProvider} from "react-native-keyboard-controller"
import {SafeAreaProvider, useSafeAreaInsets} from "react-native-safe-area-context"
import Toast from "react-native-toast-message"

// import {ErrorBoundary} from "@/components/error"
import {Text} from "@/components/ignite"
import {AppStoreProvider} from "@/contexts/AppStoreContext"
import {AuthProvider} from "@/contexts/AuthContext"
import {DeeplinkProvider} from "@/contexts/DeeplinkContext"
import {NavigationHistoryProvider, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useThemeProvider} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {ModalProvider} from "@/utils/AlertUtils"
import {KonamiCodeProvider} from "@/utils/debug/konami"
import ConnectionOverlayProvider from "@/contexts/ConnectionOverlayContext"
// JsStack imports commented out - were used for Android-specific navigation (currently disabled)
// import {getAnimation, JsStack, simplePush, woltScreenOptions} from "@/components/navigation/JsStack"

// components at the top wrap everything below them in order:
export const AllProviders = withWrappers(
  // props => {
  //   return <ErrorBoundary catchErrors="always">{props.children}</ErrorBoundary>
  // },
  (props) => {
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
  (props) => {
    const {themeScheme, setThemeContextOverride, ThemeProvider} = useThemeProvider()
    return <ThemeProvider value={{themeScheme, setThemeContextOverride}}>{props.children}</ThemeProvider>
  },
  Suspense,
  SafeAreaProvider,
  KeyboardProvider,
  AuthProvider,
  AppStoreProvider,
  NavigationHistoryProvider,
  DeeplinkProvider,
  (props) => {
    return <GestureHandlerRootView style={{flex: 1}}>{props.children}</GestureHandlerRootView>
  },
  ModalProvider,
  BottomSheetModalProvider,
  (props) => {
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
  // props => {
  //   return (
  //     <View style={{flex: 1}}>
  //       <BackgroundGradient>{props.children}</BackgroundGradient>
  //     </View>
  //   )
  // },
  (props) => {
    return (
      <>
        {props.children}
        <Toast />
      </>
    )
  },
  KonamiCodeProvider,
  (props) => {
    const {preventBack, getHistory} = useNavigationHistory()
    const [debugNavigationHistory] = useSetting(SETTINGS.debug_navigation_history.key)
    const history = getHistory().map((item) => item.replaceAll("/", "\\"))
    const top = useSafeAreaInsets().top
    if (!debugNavigationHistory) {
      return <>{props.children}</>
    }

    // render the history as list at the top of the screen:

    return (
      <>
        <View style={{height: top}} />
        <View className="h-12 items-center justify-center bg-red-800">
          <Text className="text-white text-sm">{history.join(" -> ")}</Text>
        </View>
        <View className={`h-6 items-center justify-center ${!preventBack ? "bg-green-800" : "bg-red-600"}`}>
          <Text className="text-white text-sm">preventBack: {preventBack ? "true" : "false"}</Text>
        </View>
        {props.children}
      </>
    )
  },
  ConnectionOverlayProvider,
  (props) => {
    const {preventBack, animation} = useNavigationHistory()

    // if (Platform.OS === "ios") {
    return (
      <>
        {props.children}
        <Stack
          screenOptions={{
            headerShown: false,
            gestureEnabled: !preventBack,
            gestureDirection: "horizontal",
            animation: animation,
          }}
        />
      </>
    )
    // }

    // return (
    //   <>
    //     {props.children}
    //     <JsStack
    //       screenOptions={{
    //         headerShown: false,
    //         ...woltScreenOptions,
    //         gestureEnabled: !preventBack,
    //         gestureDirection: "horizontal",
    //         cardStyleInterpolator: getAnimation(animation),
    //       }}
    //     />
    //   </>
    // )
  },
)

type WrapperComponent = FunctionComponent<{children: React.ReactNode}>

export function withWrappers(...wrappers: Array<WrapperComponent>) {
  return function (props: PropsWithChildren) {
    return wrappers.reduceRight((acc, Wrapper) => {
      return <Wrapper>{acc}</Wrapper>
    }, props.children)
  }
}
