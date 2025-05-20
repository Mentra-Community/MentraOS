import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  Platform,
  ScrollView,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Slider} from 'react-native-elements';
import Icon from 'react-native-vector-icons/FontAwesome';
import axios from 'axios';

import {useStatus} from '../providers/AugmentOSStatusProvider';
import coreCommunicator from '../bridge/CoreCommunicator';
import { WIFI_CONFIGURABLE_MODELS } from '../consts';
import {stopExternalService} from '../bridge/CoreServiceStarter';
import {loadSetting, saveSetting} from '../logic/SettingsHelper.tsx';
import {SafeAreaView} from 'react-native-safe-area-context';
import {SETTINGS_KEYS} from '../consts';
import {supabase} from '../supabaseClient';
import {
  requestFeaturePermissions,
  PermissionFeatures,
} from '../logic/PermissionsUtils';
import showAlert from '../utils/AlertUtils';
import SelectSetting from '../components/settings/SelectSetting.tsx';
import { useAuth } from '../AuthContext.tsx';

const CLOUD_URL = process.env.CLOUD_HOST_NAME;

interface SettingsPageProps {
  isDarkTheme: boolean;
  toggleTheme: () => void;
  navigation: any;
}

const parseBrightness = (brightnessStr: string | null | undefined): number => {
  if (typeof brightnessStr === 'number') {
    return brightnessStr;
  }
  if (!brightnessStr || brightnessStr.includes('-')) {
    return 50;
  }
  const parsed = parseInt(brightnessStr.replace('%', ''), 10);
  return isNaN(parsed) ? 50 : parsed;
};

const SettingsPage: React.FC<SettingsPageProps> = ({
  isDarkTheme,
  toggleTheme,
  navigation,
}) => {
  const {status} = useStatus();
  const {logout} = useAuth();

  // -- Basic states from your original code --
  const [isDoNotDisturbEnabled, setDoNotDisturbEnabled] = useState(false);
  const [isSensingEnabled, setIsSensingEnabled] = useState(
    status.core_info.sensing_enabled,
  );
  const [forceCoreOnboardMic, setForceCoreOnboardMic] = useState(
    status.core_info.force_core_onboard_mic,
  );
  const [isAlwaysOnStatusBarEnabled, setIsAlwaysOnStatusBarEnabled] = useState(
    status.core_info.always_on_status_bar_enabled,
  );
  const [preferredMic, setPreferredMic] = useState(
    status.core_info.preferred_mic,
  );

  const preferredMicOptions = [
    {label: 'Phone / Headset', value: 'phone'},
    {label: 'Glasses', value: 'glasses'},
  ];

  // -- Handlers for toggles, etc. --
  const toggleSensing = async () => {
    const newSensing = !isSensingEnabled;
    await coreCommunicator.sendToggleSensing(newSensing);
    setIsSensingEnabled(newSensing);
  };

  const toggleForceCoreOnboardMic = async () => {
    // First request microphone permission if we're enabling the mic
    if (!forceCoreOnboardMic) {
      // We're about to enable the mic, so request permission
      const hasMicPermission = await requestFeaturePermissions(
        PermissionFeatures.MICROPHONE,
      );
      if (!hasMicPermission) {
        // Permission denied, don't toggle the setting
        console.log(
          'Microphone permission denied, cannot enable phone microphone',
        );
        showAlert(
          'Microphone Permission Required',
          'Microphone permission is required to use the phone microphone feature. Please grant microphone permission in settings.',
          [{text: 'OK'}],
          {
            isDarkTheme,
            iconName: 'microphone',
            iconColor: '#2196F3',
          },
        );
        return;
      }
    }
    // Continue with toggling the setting if permission granted or turning off
    const newVal = !forceCoreOnboardMic;
    await coreCommunicator.sendToggleForceCoreOnboardMic(newVal);
    setForceCoreOnboardMic(newVal);
  };

  const setMic = async (val: string) => {
    if (val === 'phone') {
      // We're potentially about to enable the mic, so request permission
      const hasMicPermission = await requestFeaturePermissions(
        PermissionFeatures.MICROPHONE,
      );
      if (!hasMicPermission) {
        // Permission denied, don't toggle the setting
        console.log(
          'Microphone permission denied, cannot enable phone microphone',
        );
        showAlert(
          'Microphone Permission Required',
          'Microphone permission is required to use the phone microphone feature. Please grant microphone permission in settings.',
          [{text: 'OK'}],
          {
            isDarkTheme,
            iconName: 'microphone',
            iconColor: '#2196F3',
          },
        );
        return;
      }
    }

    setPreferredMic(val);
    await coreCommunicator.sendSetPreferredMic(val);
  };

  const toggleAlwaysOnStatusBar = async () => {
    const newVal = !isAlwaysOnStatusBarEnabled;
    await coreCommunicator.sendToggleAlwaysOnStatusBar(newVal);
    setIsAlwaysOnStatusBarEnabled(newVal);
  };

  const forgetGlasses = async () => {
    await coreCommunicator.sendForgetSmartGlasses();
  };

  const confirmForgetGlasses = () => {
    showAlert(
      'Forget Glasses',
      'Are you sure you want to forget your glasses?',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Yes', onPress: forgetGlasses},
      ],
      {
        cancelable: false,
        isDarkTheme,
      },
    );
  };

  const handleSignOut = async () => {
    try {
      await logout();

      // Navigate to Login screen directly instead of SplashScreen
      // This ensures we skip the SplashScreen logic that might detect stale user data
      navigation.reset({
        index: 0,
        routes: [{name: 'SplashScreen'}],
      });
    } catch (err) {
      console.error('Error during sign-out:', err);
      // Even if there's an error, still try to navigate away to login
      navigation.reset({
        index: 0,
        routes: [{name: 'SplashScreen'}],
      });
    }
  };

  const confirmSignOut = () => {
    showAlert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Yes', onPress: handleSignOut},
      ],
      {
        cancelable: false,
        isDarkTheme,
      },
    );
  };

  // Switch track colors
  const switchColors = {
    trackColor: {
      false: isDarkTheme ? '#666666' : '#D1D1D6',
      true: '#2196F3',
    },
    thumbColor:
      Platform.OS === 'ios' ? undefined : isDarkTheme ? '#FFFFFF' : '#FFFFFF',
    ios_backgroundColor: isDarkTheme ? '#666666' : '#D1D1D6',
  };

  // Theming
  const theme = {
    backgroundColor: isDarkTheme ? '#1c1c1c' : '#f9f9f9',
    headerBg: isDarkTheme ? '#333333' : '#fff',
    textColor: isDarkTheme ? '#FFFFFF' : '#333333',
    subTextColor: isDarkTheme ? '#999999' : '#666666',
    cardBg: isDarkTheme ? '#333333' : '#fff',
    borderColor: isDarkTheme ? '#444444' : '#e0e0e0',
    searchBg: isDarkTheme ? '#2c2c2c' : '#f5f5f5',
    categoryChipBg: isDarkTheme ? '#444444' : '#e9e9e9',
    categoryChipText: isDarkTheme ? '#FFFFFF' : '#555555',
    selectedChipBg: isDarkTheme ? '#666666' : '#333333',
    selectedChipText: isDarkTheme ? '#FFFFFF' : '#FFFFFF',
  };

  // Slider theme styles - not used anymore, but keep style references for potential future use

  return (
    <SafeAreaView style={{flex: 1}}>
      <View style={styles.container}>
        {/* Title Section */}
        <View
          style={[
            styles.titleContainer,
            isDarkTheme
              ? styles.titleContainerDark
              : styles.titleContainerLight,
          ]}>
          <Text
            style={[
              styles.title,
              isDarkTheme ? styles.lightText : styles.darkText,
            ]}>
            Settings
          </Text>
        </View>

        <ScrollView style={styles.scrollViewContainer}>
          <View style={styles.settingItem2}>
            <SelectSetting
              label={'Preferred Microphone'}
              value={preferredMic}
              description={
                "Select which microphone to use"
              }
              options={preferredMicOptions}
              onValueChange={val => setMic(val)}
              theme={theme}
            />
            {status.glasses_info?.model_name === 'Simulated Glasses' && (
              <View style={styles.flagContainer}>
                <Text style={[styles.flagText, {color: '#ff6b6b'}]}>
                  This setting has no effect when using Simulated Glasses
                </Text>
              </View>
            )}
          </View>

          {/* Always on time, date and battery */}
          {/* {Platform.OS === 'android' && (
            <View style={styles.settingItem}>
              <View style={styles.settingTextContainer}>
                <Text
                  style={[
                    styles.label,
                    isDarkTheme ? styles.lightText : styles.darkText,
                  ]}>
                  Always On Status Bar (Beta Feature)
                </Text>
                <Text
                  style={[
                    styles.value,
                    isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                  ]}>
                  Always show the time, date and battery level on your smart
                  glasses.
                </Text>
              </View>
              <Switch
                value={isAlwaysOnStatusBarEnabled}
                onValueChange={toggleAlwaysOnStatusBar}
                trackColor={switchColors.trackColor}
                thumbColor={switchColors.thumbColor}
                ios_backgroundColor={switchColors.ios_backgroundColor}
              />
            </View>
          )} */}

          {/* Proofile Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              navigation.navigate('ProfileSettings');
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                ]}>
                Profile Settings
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>



          {/* Privacy Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              navigation.navigate('PrivacySettingsScreen');
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                ]}>
                Privacy Settings
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>

          {/* Dashboard Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              navigation.navigate('DashboardSettingsScreen', {
                isDarkTheme,
              });
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                ]}>
                Dashboard Settings
              </Text>
              <Text
                style={[
                  styles.value,
                  isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                ]}>
                Configure the contextual dashboard and HeadUp settings
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>

          {/* Screen Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              navigation.navigate('ScreenSettingsScreen');
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                ]}>
                Screen Settings
              </Text>
              <Text
                style={[
                  styles.value,
                  isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                ]}>
                Adjust brightness, auto-brightness, and other display settings.
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>

          {/* Glasses Wifi Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              // Check if connected glasses support WiFi
              const supportsWifi = status.glasses_info && status.glasses_info.glasses_use_wifi === true;
              
              if (supportsWifi) {
                navigation.navigate('GlassesWifiSetupScreen', {
                  deviceModel: status.glasses_info?.model_name || 'Glasses'
                });
              } else {
                showAlert(
                  'Not Available',
                  'WiFi configuration is only available for glasses that support WiFi connectivity.',
                  [{ text: 'OK' }],
                  {
                    isDarkTheme,
                    iconName: 'wifi',
                    iconColor: '#2196F3'
                  }
                );
              }
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                  (!status.glasses_info || status.glasses_info.glasses_use_wifi !== true) && 
                    styles.disabledItem,
                ]}>
                Glasses WiFi Settings
              </Text>
              <Text
                style={[
                  styles.value,
                  isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                  (!status.glasses_info || status.glasses_info.glasses_use_wifi !== true) && 
                    styles.disabledItem,
                ]}>
                Configure WiFi settings for your smart glasses.
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>

          {/* Developer Settings */}
          <TouchableOpacity
            style={styles.settingItem}
            onPress={() => {
              navigation.navigate('DeveloperSettingsScreen');
            }}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  isDarkTheme ? styles.lightText : styles.darkText,
                ]}>
                Developer Settings
              </Text>
            </View>
            <Icon
              name="angle-right"
              size={20}
              color={
                isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color
              }
            />
          </TouchableOpacity>

          {/* Bug Report */}
          {/* <TouchableOpacity style={styles.settingItem} onPress={() => {
            navigation.navigate('ErrorReportScreen');
        }}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.label, styles.redText]}>Report an Issue</Text>
          </View>
        </TouchableOpacity> */}

          {/* Forget Glasses */}
          <TouchableOpacity
            style={styles.settingItem}
            disabled={
              !status.core_info.puck_connected ||
              status.core_info.default_wearable === ''
            }
            onPress={confirmForgetGlasses}>
            <View style={styles.settingTextContainer}>
              <Text
                style={[
                  styles.label,
                  styles.redText,
                  (!status.core_info.puck_connected ||
                    status.core_info.default_wearable === '') &&
                    styles.disabledItem,
                ]}>
                Forget Glasses
              </Text>
            </View>
          </TouchableOpacity>

          {/* Sign Out */}
          <TouchableOpacity style={styles.settingItem} onPress={confirmSignOut}>
            <View style={styles.settingTextContainer}>
              <Text style={[styles.label, styles.redText]}>Sign Out</Text>
            </View>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
};

export default SettingsPage;

const styles = StyleSheet.create({
  scrollViewContainer: {
    paddingHorizontal: 20,
  },
  container: {
    flex: 1,
  },
  titleContainer: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  titleContainerDark: {
    backgroundColor: '#333333',
  },
  titleContainerLight: {
    // backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
    textAlign: 'left',
    color: '#FFFFFF',
    marginBottom: 5,
  },
  darkBackground: {
    backgroundColor: '#1c1c1c',
  },
  lightBackground: {
    backgroundColor: '#f0f0f0',
  },
  redText: {
    color: '#FF0F0F',
  },
  darkText: {
    color: 'black',
  },
  lightText: {
    color: 'white',
  },
  darkSubtext: {
    color: '#666666',
  },
  lightSubtext: {
    color: '#999999',
  },
  darkIcon: {
    color: '#333333',
  },
  lightIcon: {
    color: '#666666',
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
    borderBottomColor: '#333',
    borderBottomWidth: 1,
  },
  settingItem2: {
    paddingVertical: 20,
    borderBottomColor: '#333',
    borderBottomWidth: 1,
  },
  settingTextContainer: {
    flex: 1,
    paddingRight: 10,
  },
  label: {
    fontSize: 16,
    flexWrap: 'wrap',
  },
  value: {
    fontSize: 12,
    marginTop: 5,
    flexWrap: 'wrap',
  },
  disabledItem: {
    opacity: 0.4,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  thumbTouchSize: {
    width: 40,
    height: 40,
  },
  trackStyle: {
    height: 5,
  },
  thumbStyle: {
    height: 20,
    width: 20,
  },
  minimumTrackTintColor: {
    color: '#2196F3',
  },
  maximumTrackTintColorDark: {
    color: '#666666',
  },
  maximumTrackTintColorLight: {
    color: '#D1D1D6',
  },
  thumbTintColor: {
    color: '#FFFFFF',
  },
  flagContainer: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 107, 107, 0.1)', // Returning to original red color
    alignSelf: 'flex-start',
  },
  flagText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
