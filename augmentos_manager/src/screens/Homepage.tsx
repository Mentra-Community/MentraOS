import React, {useRef, useCallback, PropsWithChildren, useState, useEffect} from 'react';
import {View, StyleSheet, Animated, Text, Platform, ActivityIndicator} from 'react-native';
import {useNavigation, useFocusEffect, useRoute} from '@react-navigation/native';
import type {NavigationProp} from '@react-navigation/native';
import Header from '../components/Header';
import ConnectedDeviceInfo from '../components/ConnectedDeviceInfo';
import ConnectedSimulatedGlassesInfo from '../components/ConnectedSimulatedGlassesInfo';
import RunningAppsList from '../components/RunningAppsList';
import YourAppsList from '../components/YourAppsList';
import {useStatus} from '../providers/AugmentOSStatusProvider';
import {useAppStatus} from '../providers/AppStatusProvider';
import {ScrollView} from 'react-native-gesture-handler';
import BackendServerComms from '../backend_comms/BackendServerComms';
import semver from 'semver';
import {Config} from 'react-native-config';
import CloudConnection from '../components/CloudConnection';
import {loadSetting, saveSetting} from '../logic/SettingsHelper';

import {NativeModules, NativeEventEmitter} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import SensingDisabledWarning from '../components/SensingDisabledWarning';
import {SETTINGS_KEYS} from '../consts';
import NonProdWarning from '../components/NonProdWarning';

interface HomepageProps {
  isDarkTheme: boolean;
  toggleTheme: () => void;
}

interface AnimatedSectionProps extends PropsWithChildren {
  delay?: number;
}

const Homepage: React.FC<HomepageProps> = ({isDarkTheme, toggleTheme}) => {
  const navigation = useNavigation<NavigationProp<any>>();
  const {appStatus, refreshAppStatus} = useAppStatus();
  const {status} = useStatus();
  const [isSimulatedPuck, setIsSimulatedPuck] = React.useState(false);
  const [isCheckingVersion, setIsCheckingVersion] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [nonProdBackend, setNonProdBackend] = useState(false);
  const route = useRoute();

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(-50)).current;

  // Reset loading state when connection status changes
  useEffect(() => {
    if (status.core_info.cloud_connection_status === 'CONNECTED') {
      setIsInitialLoading(true);
      const timer = setTimeout(() => {
        setIsInitialLoading(false);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [status.core_info.cloud_connection_status]);

  const checkNonProdBackend = async () => {
    const url = await loadSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null);
    setNonProdBackend(url && !url.includes('prod.augmentos.cloud') && !url.includes('global.augmentos.cloud'));
  };

  // Clear loading state if apps are loaded
  useEffect(() => {
    if (appStatus.length > 0) {
      setIsInitialLoading(false);
    }
  }, [appStatus.length]);

  // Get local version from env file
  const getLocalVersion = () => {
    try {
      const version = Config.AUGMENTOS_VERSION;
      console.log('Local version from env:', version);
      return version || null;
    } catch (error) {
      console.error('Error getting local version:', error);
      return null;
    }
  };

  // Check cloud version and navigate if needed
  const checkCloudVersion = async () => {
    if (isCheckingVersion) return;
    setIsCheckingVersion(true);

    try {
      // Check if version checks are being ignored this session
      const ignoreCheck = await loadSetting('ignoreVersionCheck', false);
      if (ignoreCheck) {
        console.log('Version check skipped due to user preference');
        setIsCheckingVersion(false);
        return;
      }

      const backendComms = BackendServerComms.getInstance();
      const localVer = getLocalVersion();

      if (!localVer) {
        console.error('Failed to get local version from env file');
        // Navigate to update screen with connection error
        navigation.navigate('VersionUpdateScreen', {
          isDarkTheme,
          connectionError: true,
        });
        setIsCheckingVersion(false);
        return;
      }

      // Call the endpoint to get cloud version
      await backendComms.restRequest('/apps/version', null, {
        onSuccess: data => {
          const cloudVer = data.version;
          console.log(`Comparing local version (${localVer}) with cloud version (${cloudVer})`);

          // Compare versions using semver
          if (semver.lt(localVer, cloudVer)) {
            console.log('A new version is available. Navigate to update screen.');
            // Navigate to update screen with version mismatch
            navigation.navigate('VersionUpdateScreen', {
              isDarkTheme,
              localVersion: localVer,
              cloudVersion: cloudVer,
            });
          } else {
            console.log('Local version is up-to-date.');
            // Stay on homepage, no navigation needed
          }
          setIsCheckingVersion(false);
        },
        onFailure: errorCode => {
          console.error('Failed to fetch cloud version:', errorCode);
          // Navigate to update screen with connection error
          navigation.navigate('VersionUpdateScreen', {
            isDarkTheme,
            connectionError: true,
          });
          setIsCheckingVersion(false);
        },
      });
      // console.log('Version check completed');
    } catch (error) {
      console.error('Error checking cloud version:', error);
      // Navigate to update screen with connection error
      navigation.navigate('VersionUpdateScreen', {
        isDarkTheme,
        connectionError: true,
      });
      setIsCheckingVersion(false);
    }
  };

  // Check version once on mount
  useEffect(() => {
    if (Platform.OS == 'android') {
      checkCloudVersion();
    }
  }, []);

  // Simple animated wrapper so we do not duplicate logic
  const AnimatedSection: React.FC<AnimatedSectionProps> = useCallback(
    ({children}) => (
      <Animated.View
        style={{
          opacity: fadeAnim,
          transform: [{translateY: slideAnim}],
        }}>
        {children}
      </Animated.View>
    ),
    [fadeAnim, slideAnim],
  );

  useFocusEffect(
    useCallback(() => {
      checkNonProdBackend();

      // Reset animations when screen is about to focus
      fadeAnim.setValue(0);
      slideAnim.setValue(-50);

      // Start animations after a short delay
      const animationTimeout = setTimeout(() => {
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ]).start();
      }, 50);

      return () => {
        clearTimeout(animationTimeout);
        fadeAnim.setValue(0);
        slideAnim.setValue(-50);
      };
    }, [fadeAnim, slideAnim]),
  );

  const currentThemeStyles = isDarkTheme ? darkThemeStyles : lightThemeStyles;

  return (
    <SafeAreaView style={{flex: 1}}>
      <View style={currentThemeStyles.container}>
        <AnimatedSection>
          <Header isDarkTheme={isDarkTheme} navigation={navigation} />
        </AnimatedSection>
        <ScrollView
          style={currentThemeStyles.contentContainer}
          contentContainerStyle={{paddingBottom: 0, flexGrow: 1}} // Force content to fill available space
        >
          {status.core_info.cloud_connection_status !== 'CONNECTED' && (
            <AnimatedSection>
              <CloudConnection isDarkTheme={isDarkTheme} />
            </AnimatedSection>
          )}

          {/* Sensing Disabled Warning */}
          <AnimatedSection>
            <SensingDisabledWarning isSensingEnabled={status.core_info.sensing_enabled} />
          </AnimatedSection>

          {nonProdBackend && (
            <AnimatedSection>
              <NonProdWarning isNonProdBackend={nonProdBackend} />
            </AnimatedSection>
          )}

          <View style={{flex: 1}}>
            <AnimatedSection>
              {/* Use the simulated version if we're connected to simulated glasses */}
              {status.glasses_info?.model_name && status.glasses_info.model_name.toLowerCase().includes('simulated') ? (
                <ConnectedSimulatedGlassesInfo isDarkTheme={isDarkTheme} />
              ) : (
                <ConnectedDeviceInfo isDarkTheme={isDarkTheme} />
              )}
            </AnimatedSection>
          </View>
          {status.core_info.puck_connected && (
            <>
              {appStatus.length > 0 ? (
                <>
                  <AnimatedSection>
                    <RunningAppsList isDarkTheme={isDarkTheme} />
                  </AnimatedSection>

                  <AnimatedSection>
                    <YourAppsList isDarkTheme={isDarkTheme} key={`apps-list-${appStatus.length}`} />
                  </AnimatedSection>
                </>
              ) : status.core_info.cloud_connection_status === 'CONNECTED' ? (
                isInitialLoading ? (
                  <AnimatedSection>
                    <View style={currentThemeStyles.loadingContainer}>
                      <Text style={currentThemeStyles.loadingText}>Loading your apps...</Text>
                    </View>
                  </AnimatedSection>
                ) : (
                  <AnimatedSection>
                    <View style={currentThemeStyles.noAppsContainer}>
                      <Text style={currentThemeStyles.noAppsText}>
                        Unable to load your apps.{'\n'}Please check your internet connection and try again.
                      </Text>
                    </View>
                  </AnimatedSection>
                )
              ) : (
                <AnimatedSection>
                  <Text style={currentThemeStyles.noAppsText}>
                    Unable to load apps. Please check your cloud connection to view and manage your apps.
                  </Text>
                </AnimatedSection>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
};

const lightThemeStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 0, // Explicitly set to 0 to prevent space above navbar
    marginBottom: -15, // Negative margin to help close the gap
  },
  warningContainer: {
    paddingHorizontal: 20,
  },
  noAppsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  noAppsText: {
    color: '#000000',
    fontFamily: 'Montserrat-Regular',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
  brightnessContainer: {
    marginTop: 15,
    marginBottom: 10,
    padding: 10,
    backgroundColor: '#F5F5F5',
    borderRadius: 8,
  },
  brightnessText: {
    color: '#000000',
    marginBottom: 5,
    fontFamily: 'Montserrat-Regular',
  },
  brightnessRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  loadingText: {
    color: '#000000',
    fontFamily: 'Montserrat-Regular',
    fontSize: 16,
  },
});

const darkThemeStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 0, // Remove bottom padding that causes space above navbar
    marginBottom: -15, // Negative margin to help close the gap
  },
  noAppsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  noAppsText: {
    color: '#ffffff',
    fontFamily: 'Montserrat-Regular',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
  brightnessContainer: {
    marginTop: 15,
    marginBottom: 10,
    padding: 10,
    backgroundColor: '#222222',
    borderRadius: 8,
  },
  brightnessText: {
    color: '#ffffff',
    marginBottom: 5,
    fontFamily: 'Montserrat-Regular',
  },
  brightnessRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  loadingText: {
    color: '#ffffff',
    fontFamily: 'Montserrat-Regular',
    fontSize: 16,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fullWidthItem: {
    width: '100%',
    paddingHorizontal: 0,
    marginHorizontal: 0,
  },
});

export default Homepage;
