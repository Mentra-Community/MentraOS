import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, Switch} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from 'react-native-vector-icons/FontAwesome';
import MaterialIcon from 'react-native-vector-icons/MaterialIcons';
import coreCommunicator from '../bridge/CoreCommunicator';
import {useStatus} from '../providers/AugmentOSStatusProvider';
import {NavigationProps} from '../components/types';
import {useNavigation} from '@react-navigation/native';
import {getGlassesImage} from '../logic/getGlassesImage';
import GlobalEventEmitter from '../logic/GlobalEventEmitter';
import {getBatteryColor, getBatteryIcon} from '../logic/getBatteryIcon';
import {WIFI_CONFIGURABLE_MODELS} from '../consts';
import {Slider} from 'react-native-elements';

interface ConnectedDeviceInfoProps {
  isDarkTheme: boolean;
}

const ConnectedDeviceInfo: React.FC<ConnectedDeviceInfoProps> = ({isDarkTheme}) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const slideAnim = useRef(new Animated.Value(-50)).current;
  const [connectedGlasses, setConnectedGlasses] = useState('');
  const {status, refreshStatus} = useStatus();
  const navigation = useNavigation<NavigationProps>();
  const [microphoneActive, setMicrophoneActive] = useState(status.core_info.is_mic_enabled_for_frontend);

  const [isConnectButtonDisabled, setConnectButtonDisabled] = useState(false);
  const [isDisconnectButtonDisabled, setDisconnectButtonDisabled] = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      // Reset animations to initial values
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.8);
      slideAnim.setValue(-50);

      // Update connectedGlasses state when default_wearable changes
      if (status.core_info.default_wearable) {
        setConnectedGlasses(status.core_info.default_wearable);
      }

      // Start animations if device is connected
      if (status.core_info.puck_connected) {
        Animated.parallel([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.spring(scaleAnim, {
            toValue: 1,
            friction: 8,
            tension: 60,
            useNativeDriver: true,
          }),
          Animated.timing(slideAnim, {
            toValue: 0,
            duration: 700,
            useNativeDriver: true,
          }),
        ]).start();
      }
      if (status.core_info.default_wearable !== '') {
        setDisconnectButtonDisabled(false);
      }
      // Cleanup function
      return () => {
        fadeAnim.stopAnimation();
        scaleAnim.stopAnimation();
        slideAnim.stopAnimation();
      };
    }, [status.core_info.default_wearable, status.core_info.puck_connected, fadeAnim, scaleAnim, slideAnim]),
  );

  useEffect(() => {
    setMicrophoneActive(status.core_info.is_mic_enabled_for_frontend);
  }, [status.core_info.is_mic_enabled_for_frontend]);

  const handleConnectToCore = async () => {
    try {
      // Request status to check connection instead of scanning
      await coreCommunicator.sendRequestStatus();
    } catch (error) {
      GlobalEventEmitter.emit('SHOW_BANNER', {message: 'Failed to connect to AugmentOS Core', type: 'error'});
    }
  };

  const connectGlasses = async () => {
    if (!status.core_info.default_wearable) {
      navigation.navigate('SelectGlassesModelScreen');
      return;
    }

    // Check that Bluetooth and Location are enabled/granted
    const requirementsCheck = await coreCommunicator.checkConnectivityRequirements();
    if (!requirementsCheck.isReady) {
      // Show alert about missing requirements
      console.log('Requirements not met, showing banner with message:', requirementsCheck.message);
      GlobalEventEmitter.emit('SHOW_BANNER', {
        message: requirementsCheck.message || 'Cannot connect to glasses - check Bluetooth and Location settings',
        type: 'error',
      });

      return;
    }

    setConnectButtonDisabled(true);
    setDisconnectButtonDisabled(false);

    try {
      console.log('Connecting to glasses:', status.core_info.default_wearable);
      if (status.core_info.default_wearable && status.core_info.default_wearable != '') {
        console.log('Connecting to glasses:', status.core_info.default_wearable);
        await coreCommunicator.sendConnectWearable(status.core_info.default_wearable);
      }
    } catch (error) {
      console.error('connect to glasses error:', error);
      setConnectButtonDisabled(false);
      GlobalEventEmitter.emit('SHOW_BANNER', {
        message: 'Failed to connect to glasses',
        type: 'error',
      });
    }
  };

  const sendDisconnectWearable = async () => {
    setDisconnectButtonDisabled(true);
    setConnectButtonDisabled(false);

    console.log('Disconnecting wearable');

    try {
      await coreCommunicator.sendDisconnectWearable();
    } catch (error) {}
  };

  // New handler: if already connecting, pressing the button calls disconnect.
  const handleConnectOrDisconnect = async () => {
    if (isConnectButtonDisabled || status.core_info.is_searching) {
      await sendDisconnectWearable();
    } else {
      await connectGlasses();
    }
  };

  const themeStyles = {
    backgroundColor: isDarkTheme ? '#333333' : '#F2F2F7',
    textColor: isDarkTheme ? '#FFFFFF' : '#333333',
    statusLabelColor: isDarkTheme ? '#CCCCCC' : '#666666',
    statusValueColor: isDarkTheme ? '#FFFFFF' : '#333333',
    connectedDotColor: '#28a745',
    separatorColor: isDarkTheme ? '#666666' : '#999999',
  };

  const formatGlassesTitle = (title: string) => title.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

  const batteryIcon = getBatteryIcon(status.glasses_info?.battery_life ?? 0);
  const batteryColor = getBatteryColor(status.glasses_info?.battery_life ?? 0);

  // Determine the button style for connecting glasses
  const getConnectButtonStyle = () => {
    return status.core_info.is_searching
      ? styles.connectingButton
      : isConnectButtonDisabled
      ? styles.disabledButton
      : styles.connectButton;
  };

  let [autoBrightness, setAutoBrightness] = useState(status?.glasses_settings?.auto_brightness ?? true);
  let [brightness, setBrightness] = useState(status?.glasses_settings?.brightness ?? 50);

  useEffect(() => {
    setBrightness(status?.glasses_settings?.brightness ?? 50);
    setAutoBrightness(status?.glasses_settings?.auto_brightness ?? true);
  }, [status?.glasses_settings?.brightness, status?.glasses_settings?.auto_brightness]);

  const renderInterface = () => {
    if (!status.glasses_info?.model_name) {
      return (
        // Connect button rendering with spinner on right
        <View style={styles.noGlassesContent}>
          <TouchableOpacity
            style={getConnectButtonStyle()}
            onPress={handleConnectOrDisconnect}
            disabled={isConnectButtonDisabled && !status.core_info.is_searching}>
            <Text style={styles.buttonText}>
              {isConnectButtonDisabled || status.core_info.is_searching ? 'Connecting Glasses...' : 'Connect Glasses'}
            </Text>
            {status.core_info.is_searching && <ActivityIndicator size="small" color="#fff" style={{marginLeft: 5}} />}
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <>
        <Animated.View style={[styles.statusBar, {opacity: fadeAnim}]}>
          <View style={styles.statusInfo}>
            {status.glasses_info?.battery_life != null && typeof status.glasses_info?.battery_life === 'number' && (
              <>
                <Text style={[styles.statusLabel, {color: themeStyles.statusLabelColor}]}>Battery</Text>
                <View style={styles.batteryContainer}>
                  {status.glasses_info?.battery_life >= 0 && (
                    <Icon name={batteryIcon} size={16} color={batteryColor} style={styles.batteryIcon} />
                  )}
                  <Text style={[styles.batteryValue, {color: batteryColor}]}>
                    {status.glasses_info.battery_life == -1 ? '-' : `${status.glasses_info.battery_life}%`}
                  </Text>
                </View>
              </>
            )}
          </View>
          <TouchableOpacity
            style={[styles.disconnectButton, isDisconnectButtonDisabled && styles.disabledDisconnectButton]}
            onPress={sendDisconnectWearable}
            disabled={isDisconnectButtonDisabled}>
            <Icon name="power-off" size={18} color="white" style={styles.icon} />
            <Text style={styles.disconnectText}>Disconnect</Text>
          </TouchableOpacity>
        </Animated.View>
        <View
          style={[
            styles.statusBar,
            {
              flexDirection: 'row',
              justifyContent: 'space-between',
              width: '100%',
              gap: 12,
              paddingVertical: 12,
              marginBottom: 8,
              marginTop: 8,
            },
          ]}>
          <View style={[{flex: 8, flexShrink: 1}]}>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', width: '100%'}}>
              <Text style={[styles.statusLabel, {color: themeStyles.statusLabelColor}]}>Brightness</Text>
              {!autoBrightness ? (
                <Text style={[styles.statusValue, {color: themeStyles.statusValueColor}]}>{brightness}%</Text>
              ) : (
                <Text style={[styles.statusValue, {color: themeStyles.statusValueColor}]}></Text>
              )}
            </View>
            {/* this is so dumb but it doesn't want to work any other way */}
            {autoBrightness && (
              <Slider
                disabled={true}
                style={{width: '100%'}}
                value={100}
                minimumValue={0}
                maximumValue={100}
                step={1}
                thumbStyle={{height: 20, width: 20, backgroundColor: 'transparent'}}
                thumbTouchSize={{width: 40, height: 40}}
                thumbTintColor='transparent'
                trackStyle={{height: 5}}
                minimumTrackTintColor='transparent'
              />
            )}
            {!autoBrightness && (
              <Slider
                disabled={false}
                allowTouchTrack={false}
                style={{width: '100%'}}
                value={brightness}
                minimumValue={0}
                maximumValue={100}
                step={1}
                thumbStyle={{height: 20, width: 20}}
                thumbTouchSize={{width: 40, height: 40}}
                thumbTintColor="#FFFFFF"
                trackStyle={{height: 5}}
                onSlidingComplete={value => {
                  coreCommunicator.setGlassesBrightnessMode(value, autoBrightness);
                }}
              />
            )}
          </View>

          <View style={[{flex: 2, alignItems: 'center', gap: 4, flexDirection: 'column', paddingTop: 0}]}>
            <Text style={[styles.statusLabel, {color: themeStyles.statusLabelColor, marginTop: -10}]}>Auto</Text>
            <Switch
              hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
              value={status.glasses_settings.auto_brightness}
              onValueChange={value => {
                coreCommunicator.setGlassesBrightnessMode(brightness, value);
              }}
            />
          </View>
        </View>
      </>
    );
  };

  const renderStatusBars = () => {
    if (!status.core_info.puck_connected) {
      return (
        <View style={styles.disconnectedContent}>
          <Text style={[styles.connectText, {color: themeStyles.textColor}]}>{'Core service not connected'}</Text>
          <TouchableOpacity style={styles.connectButton} onPress={handleConnectToCore}>
            <Icon name="wifi" size={16} color="white" style={styles.icon} />
            <Text style={styles.buttonText}>Connect to Core</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (!status.core_info.default_wearable) {
      if (status.core_info.is_searching) {
        return (
          <View style={styles.disconnectedContent}>
            <Text style={[styles.connectText, {color: themeStyles.textColor}]}>Searching for glasses</Text>
            <ActivityIndicator size="small" color="#2196F3" />
          </View>
        );
      }

      return (
        <View style={styles.noGlassesContent}>
          <Text style={styles.noGlassesText}>{'No Glasses Paired'}</Text>
          <TouchableOpacity style={styles.connectButton} onPress={connectGlasses}>
            <Text style={styles.buttonText}>{'Connect Glasses'}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.connectedContent}>
        <Animated.Image
          source={getGlassesImage(status.core_info.default_wearable)}
          style={[styles.glassesImage, {opacity: fadeAnim, transform: [{scale: scaleAnim}]}]}
        />
        <Animated.View style={[styles.connectedStatus, {transform: [{translateX: slideAnim}]}]}>
          <Text style={[styles.connectedTextTitle, {color: themeStyles.textColor}]}>
            {formatGlassesTitle(connectedGlasses)}
          </Text>
        </Animated.View>
        {renderInterface()}
      </View>
    );
  };

  return (
    <View style={[styles.deviceInfoContainer]}>
      {/* Status Indicators Row - Only render if indicators present */}
      {(microphoneActive || (status.glasses_info && status.glasses_info.glasses_use_wifi === true)) && (
        <View style={styles.statusIndicatorsRow}>
          {microphoneActive && <Icon name="microphone" size={20} color="#4CAF50" />}

          {/* Centered flex space */}
          <View style={{flex: 1}} />

          {/* WiFi Status Indicator */}
          {status.glasses_info && status.glasses_info.glasses_use_wifi === true && (
            <TouchableOpacity
              style={styles.wifiContainer}
              onPress={() => {
                if (status.glasses_info) {
                  navigation.navigate('GlassesWifiSetupScreen', {
                    deviceModel: status.glasses_info.model_name || 'Glasses',
                  });
                }
              }}>
              {status.glasses_info.glasses_wifi_connected ? (
                <>
                  {status.glasses_info.glasses_wifi_ssid && (
                    <Text style={styles.wifiSsidText}>{status.glasses_info.glasses_wifi_ssid}</Text>
                  )}
                  <Icon name="wifi" size={20} color="#4CAF50" />
                </>
              ) : (
                <MaterialIcon name="wifi-off" size={20} color="#E53935" />
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {renderStatusBars()}
    </View>
  );
};

const styles = StyleSheet.create({
  deviceInfoContainer: {
    padding: 16,
    borderRadius: 12,
    width: '100%',
    minHeight: 240,
    justifyContent: 'center',
    marginTop: 16, // Increased space above component
    backgroundColor: '#E5E5EA',
  },
  connectedContent: {
    flex: 1,
    flexShrink: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  noGlassesContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  disconnectedContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  glassesImage: {
    width: '80%',
    height: 120,
    resizeMode: 'contain',
  },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    padding: 10,
    width: '100%',
    backgroundColor: '#6750A414',
    flexWrap: 'wrap',
  },
  statusInfoNotConnected: {
    alignItems: 'center',
    flex: 1,
    width: '100%',
  },
  statusInfo: {
    alignItems: 'center',
    flex: 1,
    marginRight: 20,
  },
  batteryContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  batteryIcon: {
    marginRight: 4,
    alignSelf: 'center',
  },
  batteryValue: {
    fontSize: 14,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  statusValue: {
    fontSize: 14,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  connectedStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  connectedDot: {
    fontSize: 14,
    marginRight: 2,
    fontFamily: 'Montserrat-Bold',
  },
  separator: {
    marginHorizontal: 10,
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  connectedTextGreen: {
    color: '#28a745',
    marginLeft: 4,
    marginRight: 2,
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  connectedTextTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  statusLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: -0.08,
    fontFamily: 'SF Pro',
  },
  connectText: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 10,
    fontFamily: 'Montserrat-Bold',
  },
  noGlassesText: {
    color: 'black',
    textAlign: 'center',
    fontSize: 16,
    marginBottom: 10,
  },
  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2196F3',
    padding: 10,
    borderRadius: 8,
    width: '80%',
  },
  connectingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFC107', // Yellow when enabled & searching
    padding: 10,
    borderRadius: 8,
    width: '80%',
  },
  disabledButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A9A9A9', // Grey when disabled
    padding: 10,
    borderRadius: 8,
    width: '80%',
  },
  disabledDisconnectButton: {
    backgroundColor: '#A9A9A9',
  },
  icon: {
    marginRight: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
  },
  disconnectButton: {
    flexDirection: 'row',
    backgroundColor: '#E24A24',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    justifyContent: 'center',
    marginRight: 5,
    width: '40%',
  },
  disconnectText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    fontFamily: 'Montserrat-Regular',
  },
  statusIndicatorsRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    //height: 30,
  },
  iconContainer: {
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wifiContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 18,
  },
  wifiSsidText: {
    fontSize: 12,
    color: '#4CAF50',
    fontWeight: 'bold',
    marginRight: 5,
    maxWidth: 120,
  },
});

export default ConnectedDeviceInfo;
