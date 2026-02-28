import {useIsMobile} from "../hooks/useMediaQuery"
import AppStoreMobile from "./AppStoreMobile"
import AppStoreDesktop from "./AppStoreDesktop"

// Extend window interface for React Native WebView
declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void
    }
  }
}

/**
 * AppStore component that routes to mobile or desktop version
 * based on screen size
 */
const AppStore: React.FC = () => {
  const isMobile = useIsMobile()

  return isMobile ? <AppStoreMobile /> : <AppStoreDesktop />
}

export default AppStore
