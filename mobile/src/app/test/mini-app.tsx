import {useRef, useEffect} from "react"
import {View, ViewStyle, TextStyle, ActivityIndicator} from "react-native"
import {WebView} from "react-native-webview"

import {Screen, Header, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import miniComms, {SuperWebViewMessage} from "@/services/MiniComms"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function MiniApp() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const webViewRef = useRef<WebView>(null)

  // Set up SuperComms message handler to send messages to WebView
  useEffect(() => {
    const sendToWebView = (message: string) => {
      if (webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          window.receiveNativeMessage(${message});
          true;
        `)
      }
    }

    miniComms.setWebViewMessageHandler(sendToWebView)

    // Listen for messages from SuperComms
    const handleMessage = (message: SuperWebViewMessage) => {
      console.log(`SUPERAPP: Native received: ${message.type}`)
    }

    miniComms.on("message", handleMessage)

    return () => {
      miniComms.off("message", handleMessage)
    }
  }, [])

  // Handle messages from WebView
  const handleWebViewMessage = (event: any) => {
    const data = event.nativeEvent.data
    miniComms.handleWebViewMessage(data)
  }

  // HTML content with buttons
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
          padding: 20px;
          background: ${theme.isDark ? "#1c1c1c" : "#f9f9f9"};
          color: ${theme.isDark ? "#ffffff" : "#333333"};
        }

        h1 {
          font-size: 24px;
          margin-bottom: 20px;
          text-align: center;
          color: ${theme.colors.palette.primary300};
        }

        .button-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
          margin-bottom: 30px;
        }

        button {
          padding: 15px;
          font-size: 16px;
          font-weight: 600;
          border: none;
          border-radius: 12px;
          background: ${theme.colors.palette.primary300};
          color: white;
          cursor: pointer;
          transition: all 0.3s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        button:active {
          transform: scale(0.95);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
        }

        .log-container {
          background: ${theme.isDark ? "#2c2c2c" : "#ffffff"};
          border-radius: 12px;
          padding: 15px;
          max-height: 300px;
          overflow-y: auto;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .log-title {
          font-weight: 600;
          margin-bottom: 10px;
          color: ${theme.colors.palette.primary300};
        }

        .log-entry {
          padding: 8px;
          margin: 5px 0;
          background: ${theme.isDark ? "#3c3c3c" : "#f5f5f5"};
          border-radius: 6px;
          font-size: 14px;
          border-left: 3px solid ${theme.colors.palette.primary300};
        }

        .timestamp {
          color: ${theme.isDark ? "#888888" : "#666666"};
          font-size: 12px;
          margin-right: 8px;
        }
      </style>
    </head>
    <body>
      <h1>SuperApp WebView Demo</h1>

      <div class="button-grid">
        <button onclick="sendMessage('button_1')">Button 1</button>
        <button onclick="sendMessage('button_2')">Button 2</button>
        <button onclick="sendMessage('button_3')">Button 3</button>
        <button onclick="sendMessage('button_4')">Button 4</button>
        <button onclick="requestData()">Request Data</button>
        <button onclick="sendCustomAction()">Custom Action</button>
      </div>

      <div class="log-container">
        <div class="log-title">Message Log</div>
        <div id="log"></div>
      </div>

      <script>
        // Initialize the bridge
        window.messageLog = [];

        // Function to send messages to React Native
        function sendToNative(message) {
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify(message));
            addLog('Sent to Native: ' + message.type);
          } else {
            addLog('Error: ReactNativeWebView not available');
          }
        }

        // Function to receive messages from React Native
        window.receiveNativeMessage = function(messageStr) {
          try {
            const message = JSON.parse(messageStr);
            addLog('Received from Native: ' + message.type);
            handleNativeMessage(message);
          } catch (error) {
            addLog('Error parsing native message: ' + error.message);
            addLog('Message: ' + messageStr);
          }
        }

        // Handle messages from native side
        function handleNativeMessage(message) {
          switch(message.type) {
            case 'button_click_response':
              addLog(' ' + message.payload.message);
              break;
            case 'init_data':
              addLog('=� Init: ' + message.payload.message);
              break;
            case 'notification':
              addLog('= ' + message.payload.title + ': ' + message.payload.message);
              break;
            case 'data_update':
              addLog('= Data updated: ' + JSON.stringify(message.payload));
              break;
            default:
              addLog('Unknown message type: ' + message.type);
          }
        }

        // Button click handlers
        function sendMessage(buttonId) {
          sendToNative({
            type: 'button_click',
            payload: { buttonId: buttonId },
            timestamp: Date.now()
          });
        }

        function requestData() {
          sendToNative({
            type: 'custom_action',
            payload: { action: 'request_data' },
            timestamp: Date.now()
          });
        }

        function sendCustomAction() {
          sendToNative({
            type: 'custom_action',
            payload: {
              action: 'custom',
              data: { example: 'test data', value: Math.random() }
            },
            timestamp: Date.now()
          });
        }

        // Logging function
        function addLog(message) {
          const logDiv = document.getElementById('log');
          const entry = document.createElement('div');
          entry.className = 'log-entry';

          const timestamp = new Date().toLocaleTimeString();
          entry.innerHTML = '<span class="timestamp">' + timestamp + '</span>' + message;

          logDiv.insertBefore(entry, logDiv.firstChild);

          // Keep only last 20 messages
          while (logDiv.children.length > 20) {
            logDiv.removeChild(logDiv.lastChild);
          }
        }

        // Notify native that page is ready
        window.addEventListener('load', function() {
          sendToNative({
            type: 'page_ready',
            timestamp: Date.now()
          });
        });

        let count = 0;
        setInterval(function() {
          count++;
          sendToNative({
            type: 'data_update',
            payload: { count: count },
            timestamp: Date.now()
          });
        }, 1000);
      </script>
    </body>
    </html>
  `

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MiniApp"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
        containerStyle={{paddingTop: 0}}
      />
      <View style={themed($container)}>
        <WebView
          ref={webViewRef}
          source={{html: htmlContent}}
          style={themed($webView)}
          onMessage={handleWebViewMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          renderLoading={() => (
            <View style={themed($loadingOverlay)}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text text="Loading MiniApp..." style={themed($loadingText)} />
            </View>
          )}
        />
      </View>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $webView: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $loadingOverlay: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.3)",
  bottom: 0,
  justifyContent: "center",
  left: 0,
  position: "absolute",
  right: 0,
  top: 0,
})

const $loadingText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: spacing.s4,
  marginTop: 10,
  color: colors.text,
})
