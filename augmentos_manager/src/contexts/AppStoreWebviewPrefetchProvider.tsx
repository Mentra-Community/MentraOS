import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants'
import BackendServerComms from '../backend_comms/BackendServerComms';
import { View } from 'react-native';
import { useAppTheme } from '@/utils/useAppTheme';
import GlobalEventEmitter from '@/utils/GlobalEventEmitter';

const STORE_PACKAGE_NAME = 'org.augmentos.store';

interface AppStoreWebviewPrefetchContextType {
  appStoreUrl: string;
  webviewLoading: boolean;
  webViewRef: React.RefObject<WebView>;
  reloadWebview: () => void;
}

const AppStoreWebviewPrefetchContext = createContext<AppStoreWebviewPrefetchContextType | undefined>(undefined);

export const useAppStoreWebviewPrefetch = () => {
  const ctx = useContext(AppStoreWebviewPrefetchContext);
  if (!ctx) throw new Error('useAppStoreWebviewPrefetch must be used within AppStoreWebviewPrefetchProvider');
  return ctx;
};

export const AppStoreWebviewPrefetchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [appStoreUrl, setAppStoreUrl] = useState('');
  const [webviewLoading, setWebviewLoading] = useState(true);
  const webViewRef = useRef<WebView>(null);
  const {theme} = useAppTheme()

  // Prefetch logic
  const prefetchWebview = async () => {
    setWebviewLoading(true);

    try {
      const baseUrl = Constants.expoConfig?.extra?.AUGMENTOS_APPSTORE_URL
      const backendComms = BackendServerComms.getInstance();
      const tempToken = await backendComms.generateWebviewToken(STORE_PACKAGE_NAME);
      let signedUserToken: string | undefined;
      try {
        signedUserToken = await backendComms.generateWebviewToken(STORE_PACKAGE_NAME, "generate-webview-signed-user-token");
      } catch (error) {
        console.warn('Failed to generate signed user token:', error);
        signedUserToken = undefined;
      }
      const urlWithToken = new URL(baseUrl);
      urlWithToken.searchParams.append('aos_temp_token', tempToken);
      if (signedUserToken) {
        urlWithToken.searchParams.append('aos_signed_user_token', signedUserToken);
      }
      urlWithToken.searchParams.append('theme', theme.isDark ? 'dark' : 'light');
      setAppStoreUrl(urlWithToken.toString());
    } catch (error) {
      // fallback to base URL
      const baseUrl = Constants.expoConfig?.extra?.AUGMENTOS_APPSTORE_URL;
      const urlWithToken = new URL(baseUrl);
      urlWithToken.searchParams.append('theme', theme.isDark ? 'dark' : 'light');
      setAppStoreUrl(baseUrl);
    } finally {
      setWebviewLoading(false);
    }
  };

  useEffect(() => {
    prefetchWebview();
    // Optionally, refresh on login/logout or token change
  }, []);

  // Listen for logout events to clear WebView data
  useEffect(() => {
    const handleClearWebViewData = () => {
      console.log('AppStoreWebviewPrefetchProvider: Clearing WebView data on logout');
      
      // Clear WebView cache and data
      if (webViewRef.current) {
        webViewRef.current.clearCache?.(true);
        webViewRef.current.clearFormData?.();
        webViewRef.current.clearHistory?.();
      }
      
      // Reset the URL state to force fresh token generation
      setAppStoreUrl('');
      
      // Reload with fresh tokens after clearing
      setTimeout(() => {
        prefetchWebview();
      }, 100);
    };

    GlobalEventEmitter.on('CLEAR_WEBVIEW_DATA', handleClearWebViewData);
    
    return () => {
      GlobalEventEmitter.removeListener('CLEAR_WEBVIEW_DATA', handleClearWebViewData);
    };
  }, []);

  // Expose a reload method (e.g., for logout/login)
  const reloadWebview = () => {
    prefetchWebview();
  };

  return (
    <AppStoreWebviewPrefetchContext.Provider value={{ appStoreUrl, webviewLoading, webViewRef, reloadWebview }}>
      {/* Hidden WebView for prefetching */}
      {appStoreUrl ? (
        <View style={{ width: 0, height: 0, position: 'absolute', opacity: 0 }} pointerEvents="none">
          <WebView
            ref={webViewRef}
            source={{ uri: appStoreUrl }}
            style={{ width: 0, height: 0 }}
            onLoadStart={() => setWebviewLoading(true)}
            onLoadEnd={() => setWebviewLoading(false)}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={false}
          />
        </View>
      ) : null}
      {children}
    </AppStoreWebviewPrefetchContext.Provider>
  );
};