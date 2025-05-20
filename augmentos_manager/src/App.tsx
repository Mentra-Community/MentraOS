import React, {useEffect, useState} from 'react';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {
  useNavigationContainerRef,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {StatusProvider} from './providers/AugmentOSStatusProvider';
import {AppStatusProvider} from './providers/AppStatusProvider';
// import IntroScreen from './screens/IntroScreen';
import NotificationListener from './components/NotificationListener';
import {StyleSheet} from 'react-native';
import {RootStackParamList} from './components/types'; // Update path as needed
import MessageBanner from './components/MessageBanner';
import {ModalProvider} from './utils/AlertUtils';
import {SearchResultsProvider} from './providers/SearchResultsContext';
import 'react-native-url-polyfill/auto';
import {AuthProvider, useAuth} from './AuthContext';
import {GlassesMirrorProvider} from './providers/GlassesMirrorContext';
import {saveSetting} from './logic/SettingsHelper';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import GlobalEventEmitter from './logic/GlobalEventEmitter';
import Routes from './Routes.tsx';
import { AppStoreWebviewPrefetchProvider } from './providers/AppStoreWebviewPrefetchProvider';

// Assign the RootStackParamList to the navigator
const Stack = createNativeStackNavigator<RootStackParamList>();

const App: React.FC = () => {
  const [isDarkTheme, setIsDarkTheme] = useState(false);
  const [currentRouteName, setCurrentRouteName] = useState<string>('');
  const navigationRef = useNavigationContainerRef();
  const {user, loading} = useAuth();

  // Reset ignoreVersionCheck setting on app start
  useEffect(() => {
    saveSetting('ignoreVersionCheck', false);
    console.log('Reset version check ignore flag on app start');
  }, []);

  // Set up listener for WiFi credentials request
  useEffect(() => {
    const handleGlassesNeedWifiCredentials = (data: { deviceModel: string }) => {
      console.log('Handling GLASSES_NEED_WIFI_CREDENTIALS event:', data);
      
      // Navigate to the WiFi setup screen if we have navigation available
      if (navigationRef.current) {
        // @ts-ignore - We know navigationRef.current has a navigate method
        navigationRef.current.navigate('GlassesWifiSetupScreen', {
          deviceModel: data.deviceModel
        });
      }
    };

    // Subscribe to the event
    GlobalEventEmitter.addListener(
      'GLASSES_NEED_WIFI_CREDENTIALS',
      handleGlassesNeedWifiCredentials
    );

    // Clean up
    return () => {
      GlobalEventEmitter.removeListener(
        'GLASSES_NEED_WIFI_CREDENTIALS',
        handleGlassesNeedWifiCredentials
      );
    };
  }, []);

  const toggleTheme = () => {
    setIsDarkTheme(prevTheme => !prevTheme);
  };

  return (
    <GestureHandlerRootView style={styles.container}>
      <SafeAreaProvider>
        <AppStoreWebviewPrefetchProvider>
          <NotificationListener>
            <AuthProvider>
              <StatusProvider>
                <AppStatusProvider>
                  <SearchResultsProvider>
                    <GlassesMirrorProvider>
                      <MessageBanner />
                      <ModalProvider isDarkTheme={isDarkTheme} />
                      <Routes isDarkTheme={isDarkTheme} toggleTheme={toggleTheme}/>
                    </GlassesMirrorProvider>
                  </SearchResultsProvider>
                </AppStatusProvider>
              </StatusProvider>
            </AuthProvider>
          </NotificationListener>
        </AppStoreWebviewPrefetchProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mainContainer: {
    flex: 1,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  contentContainer: {
    flex: 1,
  },
});

export default App;
