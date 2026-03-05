import {useRef, useEffect} from "react"
import {View, ActivityIndicator} from "react-native"
import {WebView} from "react-native-webview"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import miniComms, {MiniAppMessage} from "@/services/MiniComms"
import {BackgroundTimer} from "@/utils/timers"

interface LocalMiniAppProps {
  packageName: string
  url?: string | null
  html?: string | null
}

export default function LocalMiniApp(props: LocalMiniAppProps) {
  const {theme} = useAppTheme()
  const webViewRef = useRef<WebView>(null)
  const keepAliveIntervalRef = useRef<number | null>(null)
  const {packageName} = props

  // Set up SuperComms message handler to send messages to WebView
  useEffect(() => {
    const sendToWebView = (message: string) => {
      if (webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          window.receiveNativeMessage(${message});
        `)
      }
    }

    miniComms.setWebViewMessageHandler(packageName, sendToWebView)

    // Listen for messages from SuperComms
    const handleMessage = (message: MiniAppMessage) => {
      console.log(`SUPERAPP: Native received: ${message.type}`)
    }

    keepAliveIntervalRef.current = BackgroundTimer.setInterval(() => {
      console.log("KEEPING ALIVE", Math.random())
      webViewRef.current?.injectJavaScript(`true;`)
    }, 1000)

    // miniComms.on("message", handleMessage)

    return () => {
      miniComms.setWebViewMessageHandler(packageName, undefined)
      if (keepAliveIntervalRef.current) {
        clearInterval(keepAliveIntervalRef.current)
      }
    }
  }, [])

  // Handle messages from WebView
  const handleWebViewMessage = (event: any) => {
    const data = event.nativeEvent.data
    // miniComms.handleRawMessageFromMiniApp(packageName, data)
  }

  let source: any = null
  if (props.html) {
    source = {html: props.html}
  } else if (props.url) {
    source = {uri: props.url}
  }

  return (
    <WebView
      ref={webViewRef}
      source={source}
      style={{flex: 1}}
      onMessage={handleWebViewMessage}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      startInLoadingState={true}
      renderLoading={() => (
        <View className="absolute inset-0 items-center bg-background justify-center">
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <Text text="Loading Local Mini App..." className="text-foreground text-sm mt-2" />
        </View>
      )}
    />
  )
}
