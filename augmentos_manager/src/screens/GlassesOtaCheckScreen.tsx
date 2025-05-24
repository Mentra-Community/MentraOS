import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import NavigationBar from '../components/NavigationBar';

import { useStatus } from '../../src/providers/AugmentOSStatusProvider';
import coreCommunicator from '../bridge/CoreCommunicator.android';

interface GlassesOtaCheckScreenProps {
  isDarkTheme: boolean;
  navigation: any;
}

const GlassesOtaCheckScreen: React.FC<GlassesOtaCheckScreenProps> = ({ isDarkTheme }) => {
  const { status } = useStatus();
  const containerStyle = isDarkTheme ? styles.darkContainer : styles.lightContainer;
  const textStyle = isDarkTheme ? styles.darkText : styles.lightText;
  const otaUpdateCheckUrl = "http://192.168.164.38:8000/version.json";

  const [versionInfo] = useState<string | null>(null);


  const handleOtaCheck = () => {
    coreCommunicator.sendVersionUpdateRequest();
    
  };


  return (
    <View style={[styles.container, containerStyle]}>
      <View style={styles.content}>
        <Text style={[styles.title, textStyle]}>Glasses OTA Check</Text>
        <TouchableOpacity style={styles.button} onPress={handleOtaCheck}>
          <Text style={styles.buttonText}>Check for Updates</Text>
        </TouchableOpacity>
        {versionInfo && (
          <Text style={[styles.versionText, textStyle]}>{versionInfo}</Text>
        )}
      </View>
      <View style={styles.navigationBarContainer}>
        <NavigationBar toggleTheme={() => {}} isDarkTheme={isDarkTheme} />
      </View>
    </View>
  );
};

export default GlassesOtaCheckScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  lightContainer: {
    backgroundColor: '#ffffff',
  },
  darkContainer: {
    backgroundColor: '#000000',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 24,
  },
  lightText: {
    color: '#000000',
  },
  darkText: {
    color: '#ffffff',
  },
  button: {
    backgroundColor: '#2196F3',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 6,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  versionText: {
    marginTop: 20,
    fontSize: 16,
    textAlign: 'center',
  },
  navigationBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
});
