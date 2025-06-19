import {SplashScreen} from "expo-router"
import "react-native-reanimated"
import {withWrappers} from "@/utils/with-wrappers"
import {Suspense} from "react"
import {KeyboardProvider} from "react-native-keyboard-controller"
import {StatusProvider} from "@/contexts/MentraOSStatusProvider"
import {AppStatusProvider} from "@/contexts/AppStatusProvider"
import {GestureHandlerRootView} from "react-native-gesture-handler"
import {AuthProvider} from "@/contexts/AuthContext"
import {SearchResultsProvider} from "@/contexts/SearchResultsContext"
import {AppStoreWebviewPrefetchProvider} from "@/contexts/AppStoreWebviewPrefetchProvider"
import {ModalProvider} from "./AlertUtils"
import {GlassesMirrorProvider} from "@/contexts/GlassesMirrorContext"
import {NavigationHistoryProvider} from "@/contexts/NavigationHistoryContext"

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync()

export const AllProviders = withWrappers(
  Suspense,
  KeyboardProvider,
  StatusProvider,
  AuthProvider,
  SearchResultsProvider,
  AppStoreWebviewPrefetchProvider,
  AppStatusProvider,
  GlassesMirrorProvider,
  NavigationHistoryProvider,
  GestureHandlerRootView,
  ModalProvider,
)
