import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, Alert, PermissionsAndroid, Platform, Image } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/FontAwesome';
import coreCommunicator from '../bridge/CoreCommunicator';
import { useStatus } from '../providers/AugmentOSStatusProvider';
import { NavigationProps } from './types';
import { useNavigation } from '@react-navigation/native';
import { getGlassesImage } from '../logic/getGlassesImage';


interface PairingDeviceInfoProps {
  isDarkTheme: boolean;
  glassesModelName: string;
}

const PairingDeviceInfo: React.FC<PairingDeviceInfoProps> = ({ isDarkTheme, glassesModelName }) => {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const slideAnim = useRef(new Animated.Value(-50)).current;
  const [connectedGlasses, setConnectedGlasses] = useState('');
  const { status, refreshStatus } = useStatus();
  const navigation = useNavigation<NavigationProps>();

  useFocusEffect(
    React.useCallback(() => {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.8);
      slideAnim.setValue(-50);

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

      return () => {
        fadeAnim.stopAnimation();
        scaleAnim.stopAnimation();
        slideAnim.stopAnimation();
      };
    }, [fadeAnim, scaleAnim, slideAnim])
  );


  const themeStyles = {
    backgroundColor: isDarkTheme ? '#333333' : '#6750A414',
    textColor: isDarkTheme ? '#FFFFFF' : '#333333',
    statusLabelColor: isDarkTheme ? '#CCCCCC' : '#666666',
    statusValueColor: isDarkTheme ? '#FFFFFF' : '#333333',
    connectedDotColor: '#28a745',
    separatorColor: isDarkTheme ? '#666666' : '#999999',
  };

  return (
    <View style={[styles.deviceInfoContainer, { backgroundColor: themeStyles.backgroundColor }]}>

      <View style={styles.disconnectedContent}>
        <Image
          source={getGlassesImage(glassesModelName)}
          style={styles.glassesImage}
        />
        <Text style={[styles.connectText, { color: themeStyles.textColor }]}>
          {`Searching for ${glassesModelName}`}
        </Text>
        {status.core_info.is_searching && (
          <ActivityIndicator size="small" color="#2196F3" />
        )}
      </View>


    </View>
  );
};

const styles = StyleSheet.create({
  deviceInfoContainer: {
    padding: 10,
    borderRadius: 16,
    width: '100%',
    minHeight: 250,
    justifyContent: 'center',
    marginTop: 15,
  },
  connectedContent: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  noGlassesContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  disconnectedContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  glassesImage: {
    width: '80%',
    height: '50%',
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
    marginVertical: 10,
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
    fontSize: 14,
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
    width: '35%',
  },
  disconnectText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
    fontFamily: 'Montserrat-Regular',
  },
});

export default PairingDeviceInfo;