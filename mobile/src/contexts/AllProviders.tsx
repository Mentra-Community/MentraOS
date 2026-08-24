import {BottomSheetModalProvider} from "@gorhom/bottom-sheet"
import * as Sentry from "@sentry/react-native"
import {Stack} from "expo-router"
import {PostHogProvider, usePostHog} from "posthog-react-native"
import {Suspense, FunctionComponent, PropsWithChildren, useEffect, useMemo, useRef} from "react"
import {AppState, Platform, View} from "react-native"
import ErrorBoundary from "react-native-error-boundary"
import {GestureHandlerRootView} from "react-native-gesture-handler"
import {KeyboardProvider} from "react-native-keyboard-controller"
import {SafeAreaProvider} from "react-native-safe-area-context"
import Toast from "react-native-toast-message"

// import {ErrorBoundary} from "@/components/error"
import {Text} from "@/components/ignite"
import {AuthProvider, useAuth} from "@/contexts/AuthContext"
import {DeeplinkProvider} from "@/contexts/DeeplinkContext"
import {SplashLoaderProvider} from "@/contexts/SplashLoaderProvider"
import {ThemeProvider} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting, engine} from "@mentra/engine"
import {ModalProvider as LegacyModalProvider} from "@/utils/AlertUtils"
import {ModalProvider} from "@/contexts/ModalContext"
import {KonamiCodeProvider} from "@/utils/dev/konami"
import ConnectionOverlayProvider from "@/contexts/ConnectionOverlayContext"
import {SaferAreaProvider, useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import CoreStatusBar from "@/components/dev/CoreStatusBar"
import {useShallow} from "zustand/shallow"
import {useNavigationStore} from "@/stores/navigation"
import {captureMentraAppActive} from "@/utils/analytics/mentraAppAnalytics"
// JsStack imports commented out - were used for Android-specific navigation (currently disabled)
// import {getAnimation, JsStack, woltScreenOptions} from "@/components/navigation/JsStack"

const convertToNativeAnimation = (animation: string) => {
  if (animation === "zoom") {
    return "fade"
  }
  return animation
}

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
  ThemeProvider,
  Suspense,
  SafeAreaProvider,
  SaferAreaProvider,
  KeyboardProvider,
  AuthProvider,
  SplashLoaderProvider,
  DeeplinkProvider,
  (props) => {
    return <GestureHandlerRootView style={{flex: 1}}>{props.children}</GestureHandlerRootView>
  },
  ModalProvider,
  LegacyModalProvider,
  BottomSheetModalProvider,
  (props) => {
    const posthogApiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY
    const isChina = engine.settings.get(SETTINGS.china_deployment.key)

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
        <PostHogIdentityBridge>{props.children}</PostHogIdentityBridge>
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
    const insets = useSaferAreaInsets()
    return (
      <>
        {props.children}
        <Toast topOffset={insets.top} bottomOffset={insets.bottom} />
      </>
    )
  },
  KonamiCodeProvider,
  (props) => {
    const {preventBack, history: navHistory} = useNavigationStore(
      useShallow((s) => ({preventBack: s.preventBack, history: s.history})),
    )
    const [debugNavigationHistory] = useSetting(SETTINGS.debug_navigation_history.key)
    const history = navHistory.map((item) => item.replaceAll("/", "\\"))
    const {top} = useSaferAreaInsets()
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
  (props) => {
    const [debugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
    if (!debugCoreStatusBarEnabled) {
      return <>{props.children}</>
    }
    return (
      <>
        <CoreStatusBar />
        {props.children}
      </>
    )
  },
  ConnectionOverlayProvider,
  // (props) => {
  //   console.log(`NAV: @@@@@@@@@@@@@@@@@@@@@@@@@@@ rerendering above stack (probably a root render)`)
  //   return <>{props.children}</>
  // },
  (props) => {
    const {preventBack, forceGestureEnabled, animation} = useNavigationStore(
      useShallow((s) => ({
        preventBack: Platform.OS === "android" ? true : s.preventBack,
        forceGestureEnabled: s.forceGestureEnabled,
        animation: s.animation,
      })),
    )
    console.log("NAV: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@", preventBack, forceGestureEnabled, animation)
    const screenOptions = useMemo(
      () => ({
        headerShown: false,
        gestureEnabled: forceGestureEnabled || !preventBack,
        gestureDirection: "horizontal" as const,
        animation: convertToNativeAnimation(animation) as any,
        autoHideHomeIndicator: false,
      }),
      [preventBack, forceGestureEnabled, animation],
    )

    return (
      <>
        {props.children}
        <Stack screenOptions={screenOptions} />
      </>
    )

    // return (
    //   <>
    //     {props.children}
    //     <JsStack
    //       screenOptions={{
    //         headerShown: false,
    //         ...woltScreenOptions,
    //         gestureEnabled: screenOptions.gestureEnabled,
    //         gestureDirection: screenOptions.gestureDirection,
    //         cardStyleInterpolator: getAnimation(screenOptions.animation),
    //       }}
    //     />
    //   </>
    // )
  },
)

type WrapperComponent = FunctionComponent<{children: React.ReactNode}>

/** Join phone analytics to the same stable Cloud V2 identity used by support profiles. */
function PostHogIdentityBridge({children}: PropsWithChildren) {
  const posthog = usePostHog()
  const {user, loading} = useAuth()
  const identifiedThisSession = useRef(false)
  const identifiedUserId = useRef<string | null>(null)

  useEffect(() => {
    if (loading) return
    if (!user?.id) identifiedUserId.current = null
    let cancelled = false
    void (async () => {
      // getDistinctId() returns "" until PostHog hydrates its persisted
      // identity; deciding before then would mistake a stale identified
      // session for an anonymous one on a signed-out cold boot.
      await posthog.ready()
      if (cancelled) return
      if (user?.id) {
        // Email is intentionally omitted here. Cloud V2 resolves the verified
        // first-party address server-side and owns that PostHog person property.
        posthog.identify(user.id)
        identifiedThisSession.current = true
        identifiedUserId.current = user.id
        captureMentraAppActive(posthog)
      } else if (identifiedThisSession.current || !isAnonymousDistinctId(posthog.getDistinctId())) {
        // Reset only a still-identified session (sign-out, or a boot that kept a
        // prior identity from any auth provider). Resetting on every signed-out
        // boot would mint a fresh anonymous PostHog person each time the app opens.
        posthog.reset()
        identifiedThisSession.current = false
        identifiedUserId.current = null
      } else {
        identifiedUserId.current = null
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loading, posthog, user?.id])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && identifiedUserId.current) captureMentraAppActive(posthog)
    })
    return () => subscription.remove()
  }, [posthog])

  return <>{children}</>
}

/** PostHog's own anonymous distinct ids are UUIDs; every identity our auth
 * providers pass to identify() (Cloud V2 `mu_<ULID>`, Authing hex id) is not.
 * Callers await posthog.ready() first, so "" (not yet hydrated) is a dead
 * path kept only as a safe default. */
function isAnonymousDistinctId(distinctId: string): boolean {
  return !distinctId || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(distinctId)
}

export function withWrappers(...wrappers: Array<WrapperComponent>) {
  return function (props: PropsWithChildren) {
    return wrappers.reduceRight((acc, Wrapper) => {
      return <Wrapper>{acc}</Wrapper>
    }, props.children)
  }
}
