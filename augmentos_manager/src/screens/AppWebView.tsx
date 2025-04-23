import React, { useRef, useState, useEffect } from 'react';
import { View, StyleSheet, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import LoadingOverlay from '../components/LoadingOverlay';
import InternetConnectionFallbackComponent from '../components/InternetConnectionFallbackComponent';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../components/types';
import FontAwesome from 'react-native-vector-icons/FontAwesome';
import BackendServerComms from '../backend_comms/BackendServerComms';
import showAlert from '../utils/AlertUtils';

type AppWebViewProps = NativeStackScreenProps<RootStackParamList, 'AppWebView'> & {
  isDarkTheme: boolean;
  toggleTheme: () => void;
};

const AppWebView: React.FC<AppWebViewProps> = ({ route, navigation, isDarkTheme, toggleTheme }) => {
  const webviewURL = route.params?.webviewURL;
  const appName = route.params?.appName || 'App';
  const packageName = route.params?.packageName;
  const fromSettings = route.params?.fromSettings === true;
  const [isLoading, setIsLoading] = useState(true); // For WebView loading itself
  const [hasError, setHasError] = useState(false);
  const webViewRef = useRef<WebView>(null);

  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // Set up the header with settings button if we came from app settings
  useEffect(() => {
    if (fromSettings && packageName) {
      navigation.setOptions({
        headerRight: () => (
          <View style={{ marginRight: 8 }}>
            <FontAwesome.Button
              name="cog"
              size={22}
              color={isDarkTheme ? '#FFFFFF' : '#000000'}
              backgroundColor="transparent"
              underlayColor="transparent"
              onPress={() => {
                navigation.replace('AppSettings', {
                  packageName,
                  appName,
                  fromWebView: true
                });
              }}
              style={{ padding: 0, margin: 0 }}
              iconStyle={{ marginRight: 0 }}
            />
          </View>
        )
      });
    }
  }, [navigation, fromSettings, packageName, appName, isDarkTheme]);

  function determineCloudUrl():string|undefined {
    const cloudHostName = process.env.CLOUD_PUBLIC_HOST_NAME || process.env.CLOUD_HOST_NAME || process.env.AUGMENTOS_HOST;
    if (cloudHostName && cloudHostName.trim() !== 'prod.augmentos.cloud' && cloudHostName.trim() !== 'cloud' && cloudHostName.includes('.')) {
      console.log(`For TPA webview token verification, using cloud host name: ${cloudHostName}`);
      return `https://${cloudHostName}`;
    }
    return undefined;
  }

  // Theme colors
  const theme = {
    backgroundColor: isDarkTheme ? '#1c1c1c' : '#f9f9f9',
    headerBg: isDarkTheme ? '#333333' : '#fff',
    textColor: isDarkTheme ? '#FFFFFF' : '#333333',
    secondaryTextColor: isDarkTheme ? '#aaaaaa' : '#777777',
    borderColor: isDarkTheme ? '#444444' : '#e0e0e0',
    buttonBg: isDarkTheme ? '#444444' : '#eeeeee',
    buttonTextColor: isDarkTheme ? '#ffffff' : '#333333',
    primaryColor: '#0088FF'
  };

  // Fetch temporary token on mount
  useEffect(() => {
    const generateTokenAndSetUrl = async () => {
      setIsLoadingToken(true);
      setTokenError(null);

      if (!packageName) {
        setTokenError("App package name is missing. Cannot authenticate.");
        setIsLoadingToken(false);
        return;
      }
      if (!webviewURL) {
        setTokenError("Webview URL is missing.");
        setIsLoadingToken(false);
        return;
      }

      try {
        const backendComms = BackendServerComms.getInstance();
        const tempToken = await backendComms.generateWebviewToken(packageName);
        const cloudApiUrl = determineCloudUrl();

        // Construct final URL
        const url = new URL(webviewURL);
        url.searchParams.set('aos_temp_token', tempToken);
        if (cloudApiUrl) {
          const checksum = await backendComms.hashWithApiKey(cloudApiUrl, packageName);
          url.searchParams.set('cloudApiUrl', cloudApiUrl);
          url.searchParams.set('cloudApiUrlChecksum', checksum);
        }

        setFinalUrl(url.toString());
        console.log(`Constructed final webview URL: ${url.toString()}`);

      } catch (error: any) {
        console.error("Error generating webview token:", error);
        setTokenError(`Failed to prepare secure access: ${error.message}`);
        showAlert(
          'Authentication Error',
          `Could not securely connect to ${appName}. Please try again later. Details: ${error.message}`,
          [{ text: 'OK', onPress: () => navigation.goBack() }] // Option to go back
        );
      } finally {
        setIsLoadingToken(false);
      }
    };

    generateTokenAndSetUrl();
  }, [packageName, webviewURL, navigation, appName]); // Dependencies

  // Handle WebView loading events
  const handleLoadStart = () => setIsLoading(true);
  const handleLoadEnd = () => setIsLoading(false);
  const handleError = (syntheticEvent: any) => { // Use any for syntheticEvent
    const { nativeEvent } = syntheticEvent;
    console.warn('WebView error: ', nativeEvent);
    setIsLoading(false);
    setHasError(true);
    setTokenError(`Failed to load ${appName}: ${nativeEvent.description}`); // Show WebView load error
  };

  // Render loading state while fetching token
  if (isLoadingToken) {
    return (
      <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
        <LoadingOverlay
          message={`Preparing secure access to ${appName}...`}
          isDarkTheme={isDarkTheme}
        />
      </View>
    );
  }

  // Render error state if token generation failed
  if (tokenError) {
    return (
      <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
        <InternetConnectionFallbackComponent
          retry={() => { /* Implement retry logic if desired, e.g., refetch token */ }}
          isDarkTheme={isDarkTheme}
        />
         <Text style={[styles.errorText, { color: theme.textColor }]}>{tokenError}</Text>
      </View>
    );
  }

  // Render error state if WebView loading failed after token success
  if (hasError) {
     return (
      <View style={[styles.container, { backgroundColor: theme.backgroundColor }]}>
        <InternetConnectionFallbackComponent
          retry={() => {
            setHasError(false);
            // Optionally re-trigger token generation or just reload
            if (webViewRef.current) {
              webViewRef.current.reload();
            }
          }}
          isDarkTheme={isDarkTheme}
        />
         <Text style={[styles.errorText, { color: theme.textColor }]}>{tokenError || `Failed to load ${appName}`}</Text>
      </View>
    );
  }

  // Render WebView only when finalUrl is ready
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.backgroundColor }}>
      <View style={styles.container}>
        {finalUrl ? (
          <WebView
            ref={webViewRef}
            source={{ uri: finalUrl }} // Use the final URL with the token
            style={styles.webView}
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true} // Keep this true for WebView's own loading indicator
            renderLoading={() => (
              // Show loading overlay while WebView itself loads
              <LoadingOverlay
                message={`Loading ${appName}...`}
                isDarkTheme={isDarkTheme}
              />
            )}
          />
        ) : (
          // This state should ideally not be reached if isLoadingToken handles it,
          // but added as a fallback.
          <LoadingOverlay message="Preparing..." isDarkTheme={isDarkTheme} />
        )}
        {/* Show loading overlay specifically for the WebView loading phase */}
        {isLoading && finalUrl && (
           <LoadingOverlay message={`Loading ${appName}...`} isDarkTheme={isDarkTheme} />
        )}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webView: {
    flex: 1,
  },
  errorText: {
    textAlign: 'center',
    marginTop: -40,
    paddingHorizontal: 20,
  }
});

export default AppWebView;
