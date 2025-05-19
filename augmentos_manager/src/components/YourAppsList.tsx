// YourAppsList.tsx
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Platform} from 'react-native';
import showAlert from '../utils/AlertUtils';
import MessageModal from './MessageModal';
import {useStatus} from '../providers/AugmentOSStatusProvider';
import BackendServerComms from '../backend_comms/BackendServerComms';
import {loadSetting, saveSetting} from '../logic/SettingsHelper';
import {SETTINGS_KEYS} from '../consts';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import AppIcon from './AppIcon';
import {NavigationProps} from './types';
import {AppInterface, TPAPermission, useAppStatus} from '../providers/AppStatusProvider';
import {requestFeaturePermissions} from '../logic/PermissionsUtils';
import {checkFeaturePermissions} from '../logic/PermissionsUtils';
import {PermissionFeatures} from '../logic/PermissionsUtils';

interface YourAppsListProps {
  isDarkTheme: boolean;
}

const YourAppsList: React.FC<YourAppsListProps> = ({isDarkTheme}) => {
  const {
    appStatus,
    refreshAppStatus,
    optimisticallyStartApp,
    optimisticallyStopApp,
    clearPendingOperation,
    isSensingEnabled,
  } = useAppStatus();
  const navigation = useNavigation<NavigationProps>();
  const [_isLoading, setIsLoading] = React.useState(false);
  const [onboardingModalVisible, setOnboardingModalVisible] = useState(false);
  const [onboardingCompleted, setOnboardingCompleted] = useState(true);
  const [inLiveCaptionsPhase, setInLiveCaptionsPhase] = useState(false);
  const [showSettingsHint, setShowSettingsHint] = useState(false);
  const [showOnboardingTip, setShowOnboardingTip] = useState(false);
  // Static values instead of animations
  const bounceAnim = React.useRef(new Animated.Value(0)).current;
  const pulseAnim = React.useRef(new Animated.Value(0)).current;

  const [containerWidth, setContainerWidth] = React.useState(0);
  const arrowAnimation = React.useRef(new Animated.Value(0)).current;

  // Reference for the Live Captions list item
  const liveCaptionsRef = useRef<any>(null);
  // State to store Live Captions item position
  const [liveCaptionsPosition, setLiveCaptionsPosition] = useState({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    index: 0,
  });

  // Constants for grid item sizing
  const GRID_MARGIN = 6; // Total horizontal margin per item (left + right)
  const numColumns = 4; // Desired number of columns

  // Calculate the item width based on container width and margins
  const itemWidth = containerWidth > 0 ? (containerWidth - GRID_MARGIN * numColumns) / numColumns : 0;

  const textColor = isDarkTheme ? '#FFFFFF' : '#000000';

  const backendComms = BackendServerComms.getInstance();

  // console.log('%%% appStatus', appStatus);

  // Check onboarding status whenever the screen comes into focus
  useFocusEffect(
    React.useCallback(() => {
      const checkOnboardingStatus = async () => {
        const completed = await loadSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true);
        setOnboardingCompleted(completed);

        if (!completed) {
          setOnboardingModalVisible(true);
          setShowSettingsHint(false); // Hide settings hint during onboarding
          setShowOnboardingTip(true);
        } else {
          setShowOnboardingTip(false);

          // If onboarding is completed, check how many times settings have been accessed
          const settingsAccessCount = await loadSetting(SETTINGS_KEYS.SETTINGS_ACCESS_COUNT, 0);
          // Only show hint if they've accessed settings less than 1 times
          setShowSettingsHint(settingsAccessCount < 1);
        }
      };

      checkOnboardingStatus();
    }, []),
  );

  // Just set arrow to static position
  useEffect(() => {
    // Set static value
    arrowAnimation.setValue(0);
  }, [showOnboardingTip]);

  // Check if onboarding is completed on initial load
  useEffect(() => {
    const checkOnboardingStatus = async () => {
      const completed = await loadSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true);
      setOnboardingCompleted(completed);
      setShowOnboardingTip(!completed);
    };

    checkOnboardingStatus();
  }, []);

  // Set static values instead of animations
  useEffect(() => {
    if (showOnboardingTip) {
      // Set static values instead of animating
      bounceAnim.setValue(0);
      pulseAnim.setValue(0.5);
    } else {
      bounceAnim.setValue(0);
      pulseAnim.setValue(0);
    }
  }, [showOnboardingTip]);

  // Safely measure Live Captions position when onboarding tip should be shown
  useEffect(() => {
    // Only try to measure if the tip should be shown
    if (!showOnboardingTip) return;

    // Track if component is mounted for safety
    let isMounted = true;
    
    // Use timeout to ensure we measure after layout
    const timeoutId = setTimeout(() => {
      // Safety check that the component is still mounted and ref is valid
      if (isMounted && liveCaptionsRef.current) {
        try {
          liveCaptionsRef.current.measure(
            (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
              // Another safety check before state update
              if (isMounted) {
                setLiveCaptionsPosition(prev => ({
                  ...prev, // Keep existing index if we have it
                  x: pageX,
                  y: pageY,
                  width: width || prev.width,  // Keep previous values if new ones are invalid
                  height: height || prev.height,
                }));
              }
            },
          );
        } catch (e) {
          // Silently handle measurement errors
          console.log('Could not measure Live Captions position');
        }
      }
    }, 500); // Give more time for layout to settle
    
    // Cleanup timeout on unmount and mark as unmounted
    return () => {
      clearTimeout(timeoutId);
      isMounted = false;
    };
  }, [showOnboardingTip]);

  const completeOnboarding = () => {
    saveSetting(SETTINGS_KEYS.ONBOARDING_COMPLETED, true);
    setOnboardingCompleted(true);
    setShowOnboardingTip(false);
    setInLiveCaptionsPhase(false); // Reset any live captions phase state

    // Make sure to post an update to ensure all components re-render
    // This is important to immediately hide any UI elements that depend on these states
    setTimeout(() => {
      // Force a re-render by setting state again
      setShowOnboardingTip(false);
      setShowSettingsHint(true);
    }, 100);
  };

  const checkPermissions = async (app: AppInterface) => {
    let permissions = app.permissions || [];
    let neededPermissions: string[] = [];

    if (permissions.length == 1 && permissions[0].type == 'ALL') {
      permissions = [
        {type: 'MICROPHONE', required: true},
        {type: 'CALENDAR', required: true},
        {type: 'NOTIFICATIONS', required: true},
        {type: 'LOCATION', required: true},
      ] as TPAPermission[];
    }

    for (const permission of permissions) {
      if (!(permission['required'] ?? true)) {
        continue;
      }
      switch (permission.type) {
        case 'MICROPHONE':
          const hasMicrophone = await checkFeaturePermissions(PermissionFeatures.MICROPHONE);
          if (!hasMicrophone) {
            neededPermissions.push(PermissionFeatures.MICROPHONE);
          }
          break;
        case 'CAMERA':
          const hasCamera = await checkFeaturePermissions(PermissionFeatures.CAMERA);
          if (!hasCamera) {
            neededPermissions.push(PermissionFeatures.CAMERA);
          }
          break;
        case 'CALENDAR':
          const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR);
          if (!hasCalendar) {
            neededPermissions.push(PermissionFeatures.CALENDAR);
          }
          break;
        case 'NOTIFICATIONS':
          const hasNotifications = await checkFeaturePermissions(PermissionFeatures.NOTIFICATIONS);
          if (!hasNotifications && Platform.OS !== 'ios') {
            neededPermissions.push(PermissionFeatures.NOTIFICATIONS);
          }
          break;
        case 'LOCATION':
          const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION);
          if (!hasLocation) {
            neededPermissions.push(PermissionFeatures.LOCATION);
          }
          break;
      }
    }

    return neededPermissions;
  };

  const requestPermissions = async (permissions: string[]) => {
    for (const permission of permissions) {
      await requestFeaturePermissions(permission);
    }
  };

  const startApp = async (packageName: string) => {
    if (!onboardingCompleted) {
      if (packageName !== 'com.augmentos.livecaptions' && packageName !== 'cloud.augmentos.live-captions') {
        showAlert(
          'Complete Onboarding',
          'Please tap the Live Captions app to complete the onboarding process.',
          [{text: 'OK'}],
          {
            isDarkTheme,
            iconName: 'information-outline',
          },
        );
        return;
      } else {
        completeOnboarding();
      }
    }

    // Find the app we're trying to start
    const appToStart = appStatus.find(app => app.packageName === packageName);
    if (!appToStart) {
      console.error('App not found:', packageName);
      return;
    }

    // check perms:
    const neededPermissions = await checkPermissions(appToStart);
    if (neededPermissions.length > 0) {
      await showAlert(
        neededPermissions.length > 1 ? 'Permissions Required' : 'Permission Required',
        'Please grant the following permissions to continue: ' + neededPermissions.join(', '),
        // neededPermissions.map(permission => ({text: permission})),
        [
          {
            text: 'OK',
            onPress: async () => {
              await requestPermissions(neededPermissions);
              startApp(packageName);
            },
          },
          {
            text: 'Cancel',
            style: 'cancel',
          },
        ],
        {
          isDarkTheme,
          iconName: 'information-outline',
        },
      );
      return;
    }

    // Optimistically update UI
    optimisticallyStartApp(packageName);

    // Check if it's a standard app
    if (appToStart?.tpaType === 'standard') {
      console.log('% appToStart', appToStart);
      // Find any running standard apps
      const runningStandardApps = appStatus.filter(
        app => app.is_running && app.tpaType === 'standard' && app.packageName !== packageName,
      );

      console.log('%%% runningStandardApps', runningStandardApps);

      // If there's any running standard app, stop it first
      for (const runningApp of runningStandardApps) {
        // Optimistically update UI
        optimisticallyStopApp(runningApp.packageName);

        try {
          console.log('%%% stopping app', runningApp.packageName);
          await backendComms.stopApp(runningApp.packageName);
          clearPendingOperation(runningApp.packageName);
        } catch (error) {
          console.error('stop app error:', error);
          refreshAppStatus();
        }
      }
    }

    // Start the operation in the background
    setIsLoading(true);
    try {
      console.log('%%% starting app', packageName);
      await backendComms.startApp(packageName);
      // Clear the pending operation since it completed successfully
      clearPendingOperation(packageName);

      if (!onboardingCompleted && packageName === 'com.augmentos.livecaptions') {
        // If this is the Live Captions app, make sure we've hidden the tip
        setShowOnboardingTip(false);

        setTimeout(() => {
          showAlert(
            'Try Live Captions!',
            'Start talking now to see your speech transcribed on your glasses in real-time!',
            [{text: 'OK'}],
            {
              isDarkTheme,
              iconName: 'microphone',
            },
          );
        }, 500);
      }
    } catch (error) {
      // Revert the app state when there's an error starting the app
      console.error('start app error:', error);

      // Clear the pending operation for this app
      clearPendingOperation(packageName);
      // Refresh the app status to move the app back to inactive
      refreshAppStatus();
    } finally {
      setIsLoading(false);
    }
  };

  const openAppSettings = (app: any) => {
    navigation.navigate('AppSettings', {
      packageName: app.packageName,
      appName: app.name,
    });
  };

  const renderOnboardingArrow = () => {
    if (!showOnboardingTip) {
      return null;
    }
    
    // Default to a reasonable position if we don't have valid measurements yet
    const defaultPosition = 90; // Default Y position from top if we can't calculate
    const calculatedPosition = liveCaptionsPosition.height > 0 && liveCaptionsPosition.index >= 0 
      ? (liveCaptionsPosition.index * (liveCaptionsPosition.height + 10) - 40)
      : defaultPosition;
    
    return (
      <View
        style={[
          styles.arrowContainer,
          {
            position: 'absolute',
            top: calculatedPosition,
            // Make sure it's visible in the viewport
            opacity: liveCaptionsPosition.height > 0 ? 1 : 0.9,
          },
        ]}>
        <View style={styles.arrowWrapper}>
          <View
            style={[
              styles.arrowBubble,
              {
                backgroundColor: '#00B0FF',
                borderColor: '#0288D1',
                shadowColor: '#0288D1',
                shadowOpacity: 0.4,
              },
            ]}>
            <Text
              style={[
                styles.arrowBubbleText,
                {
                  textShadowColor: 'rgba(0, 0, 0, 0.2)',
                  textShadowOffset: {width: 0, height: 1},
                  textShadowRadius: 2,
                },
              ]}>
              TAP TO START
            </Text>
            <Icon
              name="gesture-tap"
              size={20}
              color="#FFFFFF"
              style={[
                styles.bubbleIcon,
                {
                  textShadowColor: 'rgba(0, 0, 0, 0.2)',
                  textShadowOffset: {width: 0, height: 1},
                  textShadowRadius: 2,
                },
              ]}
            />
          </View>
          <View
            style={[
              styles.arrowIconContainer,
              isDarkTheme ? styles.arrowIconContainerDark : styles.arrowIconContainerLight,
              {
                backgroundColor: '#00B0FF',
                borderColor: '#0288D1',
                marginTop: 5,
                shadowColor: '#0288D1',
                shadowOpacity: 0.4,
              },
            ]}>
            <View
              style={[
                styles.glowEffect,
                {
                  opacity: 0.4,
                  backgroundColor: 'rgba(0, 176, 255, 0.3)',
                },
              ]}
            />
            <Icon
              name="arrow-down-bold"
              size={30}
              color="#FFFFFF"
              style={{
                textShadowColor: 'rgba(0, 0, 0, 0.3)',
                textShadowOffset: {width: 0, height: 1},
                textShadowRadius: 3,
              }}
            />
          </View>
        </View>
      </View>
    );
  };

  // Filter out duplicate apps and running apps
  let availableApps = appStatus.filter(app => {
    if (app.is_running) {
      return false;
    }
    // Check if this is the first occurrence of this package name
    const firstIndex = appStatus.findIndex(a => a.packageName === app.packageName);
    return firstIndex === appStatus.indexOf(app);
  });

  // remove the notify app on iOS
  if (Platform.OS === 'ios') {
    availableApps = availableApps.filter(app => app.packageName !== 'cloud.augmentos.notify' && app.name !== 'Notify');
  }
  // alphabetically sort the available apps
  availableApps.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={styles.appsContainer}>
      <View style={styles.titleContainer}>
        <Text style={[styles.sectionTitle, {color: textColor}]}>Inactive Apps</Text>
      </View>

      {renderOnboardingArrow()}

      <ScrollView
        style={styles.listContainer}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollViewContent}>
        {availableApps.map((app, index) => {
          // Check if this is the LiveCaptions app
          const isLiveCaptions = app.packageName === 'com.augmentos.livecaptions' || 
                               app.packageName === 'cloud.augmentos.live-captions';
          
          // Only set ref for LiveCaptions app
          const ref = isLiveCaptions ? liveCaptionsRef : null;
          
          // Update LiveCaptions index without causing rerender loops
          // This is safer than updating state during render
          if (isLiveCaptions && liveCaptionsPosition.index !== index) {
            // Use setTimeout to defer the state update until after render
            setTimeout(() => {
              setLiveCaptionsPosition(prev => ({ ...prev, index }));
            }, 0);
          }
          
          return (
            <TouchableOpacity
              key={app.packageName}
              onPress={() => startApp(app.packageName)}
              onLongPress={() => openAppSettings(app)}
              delayLongPress={500}
              style={styles.appItem}
              ref={ref}>
              <View style={styles.appContent}>
                <AppIcon
                  app={app}
                  isDarkTheme={isDarkTheme}
                  onClick={() => startApp(app.packageName)}
                  style={styles.appIconStyle}
                />
                <Text style={[styles.appName, {color: textColor}]}>{app.name || 'Convoscope'}</Text>
                <TouchableOpacity onPress={() => openAppSettings(app)} style={styles.settingsButton}>
                  <Icon name="cog-outline" size={24} color={textColor} />
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  appsContainer: {
    marginTop: -8,
    marginBottom: 0,
    width: '100%',
    paddingHorizontal: 0,
    paddingVertical: 10,
  },
  titleContainer: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginLeft: 0,
    paddingLeft: 0,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'Montserrat-Bold',
    lineHeight: 22,
    letterSpacing: 0.38,
    marginBottom: 10,
  },
  adjustableText: {
    minHeight: 0,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  listContainer: {
    gap: 4,
  },
  appItem: {
    backgroundColor: '#E8E8E8',
    borderRadius: 12,
    padding: 11, // Match RunningAppsList padding
    marginBottom: 9,
  },
  appContent: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40, // Match RunningAppsList minHeight
  },
  itemContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tipButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 15,
  },
  tipText: {
    marginLeft: 5,
    fontSize: 14,
  },
  appTextContainer: {
    flex: 1,
    marginLeft: 8,
    justifyContent: 'center',
  },
  appName: {
    flex: 1,
    fontSize: 17, // Match RunningAppsList fontSize
    fontWeight: '500',
    marginLeft: 8,
  },
  settingsButton: {
    padding: 50,
    margin: -46,
  },
  appIconStyle: {
    width: 50, // Match RunningAppsList icon size
    height: 50, // Match RunningAppsList icon size
  },
  arrowContainer: {
    position: 'absolute',
    top: -90,
    zIndex: 10,
    alignItems: 'center',
    marginLeft: 20,
  },
  arrowWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowBubble: {
    backgroundColor: '#00B0FF',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#0288D1',
    shadowOffset: {width: 0, height: 3},
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 10,
    borderWidth: 1,
    borderColor: '#0288D1',
  },
  arrowBubbleText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
    marginRight: 6,
    textShadowColor: 'rgba(0, 0, 0, 0.2)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 2,
  },
  bubbleIcon: {
    marginLeft: 2,
  },
  arrowIconContainer: {
    width: 45,
    height: 45,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0288D1',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 12,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 2,
    borderColor: '#0288D1',
  },
  arrowIconContainerLight: {
    backgroundColor: '#00B0FF',
  },
  arrowIconContainerDark: {
    backgroundColor: '#00B0FF',
  },
  glowEffect: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    borderRadius: 23,
    backgroundColor: 'rgba(0, 176, 255, 0.3)',
  },
  settingsHintContainer: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  hintContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hintText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '500',
  },
  sensingWarningContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
  },
  warningContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  warningText: {
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '500',
    color: '#E65100',
    flex: 1,
  },
  settingsButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  settingsButtonBlue: {
    backgroundColor: '#007AFF',
    borderRadius: 5,
    paddingVertical: 5,
    paddingHorizontal: 10,
    margin: 0,
  },
  settingsButtonTextBlue: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  scrollViewContent: {
    paddingBottom: Platform.OS === 'ios' ? 24 : 38, // Account for nav bar height + iOS home indicator
  },
});

export default YourAppsList;
