import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';
import Config from 'react-native-config';
import BackendServerComms from '../backend_comms/BackendServerComms';
import { View } from 'react-native';

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

  // Prefetch logic
  const prefetchWebview = async () => {
    setWebviewLoading(true);
    try {
      const baseUrl = Config.AUGMENTOS_APPSTORE_URL!;
      const backendComms = BackendServerComms.getInstance();
      const tempToken = await backendComms.generateWebviewToken(STORE_PACKAGE_NAME);
      const urlWithToken = new URL(baseUrl);
      urlWithToken.searchParams.append('aos_temp_token', tempToken);
      setAppStoreUrl(urlWithToken.toString());
    } catch (error) {
      // fallback to base URL
      const baseUrl = Config.AUGMENTOS_APPSTORE_URL!;
      setAppStoreUrl(baseUrl);
    } finally {
      setWebviewLoading(false);
    }
  };

  useEffect(() => {
    prefetchWebview();
    // Optionally, refresh on login/logout or token change
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