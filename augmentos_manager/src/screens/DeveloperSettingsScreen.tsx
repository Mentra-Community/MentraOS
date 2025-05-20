import React, {useState, useEffect} from 'react';
import {View, Text, StyleSheet, Switch, TouchableOpacity, Platform, ScrollView, TextInput, Alert} from 'react-native';
import {useStatus} from '../providers/AugmentOSStatusProvider';
import coreCommunicator from '../bridge/CoreCommunicator';
import NavigationBar from '../components/NavigationBar';
import {saveSetting, loadSetting} from '../logic/SettingsHelper';
import {SETTINGS_KEYS} from '../consts';
import axios from 'axios';
import showAlert from '../utils/AlertUtils';
import TestFlightDetector from '../bridge/TestFlightDetector';

interface DeveloperSettingsScreenProps {
  isDarkTheme: boolean;
  toggleTheme: () => void;
  navigation: any;
}

const DeveloperSettingsScreen: React.FC<DeveloperSettingsScreenProps> = ({isDarkTheme, toggleTheme, navigation}) => {
  const {status} = useStatus();
  const [isBypassVADForDebuggingEnabled, setIsBypassVADForDebuggingEnabled] = React.useState(
    status.core_info.bypass_vad_for_debugging,
  );
  const [isBypassAudioEncodingForDebuggingEnabled, setIsBypassAudioEncodingForDebuggingEnabled] = React.useState(
    status.core_info.bypass_audio_encoding_for_debugging,
  );
  const [isTestFlightOrDev, setIsTestFlightOrDev] = useState<boolean>(false);

  // State for custom URL management
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [savedCustomUrl, setSavedCustomUrl] = useState<string | null>(null);
  const [isSavingUrl, setIsSavingUrl] = useState(false); // Add loading state

  // Load saved URL on mount
  useEffect(() => {
    const loadUrl = async () => {
      const url = await loadSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null);
      setSavedCustomUrl(url);
      setCustomUrlInput(url || '');
    };
    loadUrl();
  }, []);

  useEffect(() => {
    setIsBypassVADForDebuggingEnabled(status.core_info.bypass_vad_for_debugging);
  }, [status.core_info.bypass_vad_for_debugging]);

  // Check if running on TestFlight (iOS) or development mode
  useEffect(() => {
    async function checkTestFlightOrDev() {
      setIsTestFlightOrDev(await TestFlightDetector.isTestFlightOrDev());
    }
    checkTestFlightOrDev();
  }, []);

  const toggleBypassVadForDebugging = async () => {
    let newSetting = !isBypassVADForDebuggingEnabled;
    await coreCommunicator.sendToggleBypassVadForDebugging(newSetting);
    setIsBypassVADForDebuggingEnabled(newSetting);
  };

  const toggleBypassAudioEncodingForDebugging = async () => {
    let newSetting = !isBypassAudioEncodingForDebuggingEnabled;
    await coreCommunicator.sendToggleBypassAudioEncodingForDebugging(newSetting);
    setIsBypassAudioEncodingForDebuggingEnabled(newSetting);
  };

  // Modified handler for Custom URL
  const handleSaveUrl = async () => {
    const urlToTest = customUrlInput.trim().replace(/\/+$/, '');

    // Basic validation
    if (!urlToTest) {
      showAlert('Empty URL', 'Please enter a URL or reset to default.', [{text: 'OK'}], {isDarkTheme});
      return;
    }
    if (!urlToTest.startsWith('http://') && !urlToTest.startsWith('https://')) {
      showAlert('Invalid URL', 'Please enter a valid URL starting with http:// or https://', [{text: 'OK'}], {
        isDarkTheme,
      });
      return;
    }

    setIsSavingUrl(true); // Start loading indicator

    try {
      // Test the URL by fetching the version endpoint
      const testUrl = `${urlToTest}/apps/version`;
      console.log(`Testing URL: ${testUrl}`);
      const response = await axios.get(testUrl, {timeout: 5000});

      // Check if the request was successful (status 200-299)
      if (response.status >= 200 && response.status < 300) {
        console.log('URL Test Successful:', response.data);
        // Save the URL if the test passes
        await saveSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, urlToTest);
        await coreCommunicator.setServerUrl(urlToTest);
        setSavedCustomUrl(urlToTest);
        showAlert(
          'Success',
          'Custom backend URL saved and verified. It will be used on the next connection attempt or app restart.',
          [{text: 'OK'}],
          {isDarkTheme},
        );
      } else {
        // Handle non-2xx responses as errors
        console.error(`URL Test Failed: Status ${response.status}`);
        showAlert(
          'Verification Failed',
          `The server responded, but with status ${response.status}. Please check the URL and server status.`,
          [{text: 'OK'}],
          {isDarkTheme},
        );
      }
    } catch (error: unknown) {
      // Handle network errors or timeouts
      console.error('URL Test Failed:', error instanceof Error ? error.message : 'Unknown error');
      let errorMessage = 'Could not connect to the specified URL. Please check the URL and your network connection.';

      // Type guard for axios error with code property
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ECONNABORTED') {
        errorMessage = 'Connection timed out. Please check the URL and server status.';
      }
      // Type guard for axios error with response property
      else if (
        error &&
        typeof error === 'object' &&
        'response' in error &&
        error.response &&
        typeof error.response === 'object' &&
        'status' in error.response
      ) {
        // Server responded with an error status code (4xx, 5xx)
        errorMessage = `Server responded with error ${error.response.status}. Please check the URL and server status.`;
      }

      showAlert('Verification Failed', errorMessage, [{text: 'OK'}], {
        isDarkTheme,
      });
    } finally {
      setIsSavingUrl(false); // Stop loading indicator
    }
  };

  const handleResetUrl = async () => {
    await saveSetting(SETTINGS_KEYS.CUSTOM_BACKEND_URL, null);
    setSavedCustomUrl(null);
    setCustomUrlInput('');
    Alert.alert('Success', 'Backend URL reset to default.');
  };

  const switchColors = {
    trackColor: {
      false: isDarkTheme ? '#666666' : '#D1D1D6',
      true: '#2196F3',
    },
    thumbColor: Platform.OS === 'ios' ? undefined : isDarkTheme ? '#FFFFFF' : '#FFFFFF',
    ios_backgroundColor: isDarkTheme ? '#666666' : '#D1D1D6',
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView}>
        {/* Bypass VAD for Debugging Toggle */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.label, isDarkTheme ? styles.lightText : styles.darkText]}>
              Bypass VAD for Debugging
            </Text>
            <Text style={[styles.value, isDarkTheme ? styles.lightSubtext : styles.darkSubtext]}>
              Bypass Voice Activity Detection in case transcription stops working.
            </Text>
          </View>
          <Switch
            value={isBypassVADForDebuggingEnabled}
            onValueChange={toggleBypassVadForDebugging}
            trackColor={switchColors.trackColor}
            thumbColor={switchColors.thumbColor}
            ios_backgroundColor={switchColors.ios_backgroundColor}
          />
        </View>

        {isTestFlightOrDev && (
          <>
            <View style={styles.warningContainer}>
              <Text style={styles.warningText}>Warning: These settings may break the app. Use at your own risk.</Text>
            </View>

            <View style={styles.settingItem}>
              <View style={styles.settingTextContainer}>
                <Text style={[styles.label, isDarkTheme ? styles.lightText : styles.darkText]}>Custom Backend URL</Text>
                <Text style={[styles.value, isDarkTheme ? styles.lightSubtext : styles.darkSubtext]}>
                  Override the default backend server URL. Leave blank to use default.
                  {savedCustomUrl && `\nCurrently using: ${savedCustomUrl}`}
                </Text>
                <TextInput
                  style={[
                    styles.urlInput,
                    {
                      backgroundColor: isDarkTheme ? '#333333' : '#FFFFFF',
                      borderColor: isDarkTheme ? '#555555' : '#CCCCCC',
                      color: isDarkTheme ? '#FFFFFF' : '#000000',
                    },
                  ]}
                  placeholder="e.g., http://192.168.1.100:7002"
                  placeholderTextColor={isDarkTheme ? '#999999' : '#666666'}
                  value={customUrlInput}
                  onChangeText={setCustomUrlInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!isSavingUrl}
                />
                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[
                      styles.saveButton,
                      {backgroundColor: isDarkTheme ? '#3b82f6' : '#007BFF'},
                      isSavingUrl && styles.disabledItem,
                    ]}
                    onPress={handleSaveUrl}
                    disabled={isSavingUrl}>
                    <Text style={styles.buttonText}>{isSavingUrl ? 'Testing...' : 'Save & Test URL'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.resetButton,
                      {backgroundColor: isDarkTheme ? '#555555' : '#AAAAAA'},
                      isSavingUrl && styles.disabledItem,
                    ]}
                    onPress={handleResetUrl}
                    disabled={isSavingUrl}>
                    <Text style={styles.buttonText}>Reset</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <View style={styles.buttonColumn}>
              <TouchableOpacity
                style={styles.button}
                onPress={() => setCustomUrlInput('https://prod.augmentos.cloud:443')}>
                <Text style={styles.buttonText}>Production</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.button}
                onPress={() => setCustomUrlInput('https://debug.augmentos.cloud:443')}>
                <Text style={styles.buttonText}>Debug</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.button}
                onPress={() => setCustomUrlInput('https://global.augmentos.cloud:443')}>
                <Text style={styles.buttonText}>Global</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Bypass Audio Encoding for Debugging Toggle
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText
              ]}>
              Bypass Audio Encoding for Debugging
            </Text>
            <Text
              style={[
                styles.value,
                isDarkTheme ? styles.lightSubtext : styles.darkSubtext
              ]}>
              Bypass audio encoding processing for debugging purposes.
            </Text>
          </View>
          <Switch
            value={isBypassAudioEncodingForDebuggingEnabled}
            onValueChange={toggleBypassAudioEncodingForDebugging}
            trackColor={switchColors.trackColor}
            thumbColor={switchColors.thumbColor}
            ios_backgroundColor={switchColors.ios_backgroundColor}
          />
        </View> */}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  warningContainer: {
    backgroundColor: '#f00',
    padding: 10,
    borderRadius: 8,
    marginTop: 10,
  },
  warningText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    flexShrink: 1,
    backgroundColor: '#333333',
  },
  buttonColumn: {
    marginTop: 12,
    gap: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scrollView: {
    marginBottom: 55,
  },
  container: {
    flex: 1,
    padding: 20,
  },
  darkBackground: {
    backgroundColor: '#1c1c1c',
  },
  lightBackground: {
    backgroundColor: '#f0f0f0',
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
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  // New styles for custom URL section
  urlInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginTop: 10,
    marginBottom: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  saveButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    flex: 1,
    marginRight: 10,
  },
  resetButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    flex: 1,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
    textAlign: 'center',
  },
});

export default DeveloperSettingsScreen;
