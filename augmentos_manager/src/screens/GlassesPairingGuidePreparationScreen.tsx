import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Platform,
  Linking,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/FontAwesome';
import { useStatus } from '../providers/AugmentOSStatusProvider';
import coreCommunicator from '../bridge/CoreCommunicator';
import { loadSetting, saveSetting } from '../logic/SettingsHelper';
import { SETTINGS_KEYS } from '../consts';
import { NavigationProps } from '../components/types';
import { getGlassesImage } from '../logic/getGlassesImage';
import PairingDeviceInfo from '../components/PairingDeviceInfo';
import Button from '../components/Button';
import { getPairingGuide } from '../logic/getPairingGuide';
import GlobalEventEmitter from '../logic/GlobalEventEmitter';
import { PermissionsAndroid } from 'react-native';
import { 
  requestFeaturePermissions, 
  PermissionFeatures, 
  handlePreviouslyDeniedPermission
} from '../logic/PermissionsUtils';
import { showAlert } from '../utils/AlertUtils';
interface GlassesPairingGuidePreparationScreenProps {
  isDarkTheme: boolean;
  toggleTheme: () => void;
}

// Alert handling is now done directly in PermissionsUtils.tsx

// On Android, we'll check permissions once during the actual request process
// This simplifies our code and avoids making redundant permission requests

const GlassesPairingGuidePreparationScreen: React.FC<GlassesPairingGuidePreparationScreenProps> = ({
  isDarkTheme,
  toggleTheme,
}) => {
  const { status } = useStatus();
  const route = useRoute();
  const { glassesModelName } = route.params as { glassesModelName: string };
  const navigation = useNavigation<NavigationProps>();

  React.useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      const actionType = e.data?.action?.type;
    });

    return unsubscribe;
  }, [navigation]);

  React.useEffect(() => {
  }, [glassesModelName]);


  const advanceToPairing = async () => {
    if (glassesModelName == null || glassesModelName == "") {
      console.log("SOME WEIRD ERROR HERE");
      return;
    }
    
    // For Simulated Glasses, we still need critical permissions but can skip Bluetooth
    const needsBluetoothPermissions = glassesModelName !== 'Simulated Glasses';
    
    try {
      // Check for Android-specific permissions
      if (Platform.OS === 'android') {
        // Android-specific Phone State permission - request for ALL glasses including simulated
        console.log("Requesting PHONE_STATE permission...");
        const phoneStateGranted = await requestFeaturePermissions(PermissionFeatures.PHONE_STATE);
        console.log("PHONE_STATE permission result:", phoneStateGranted);
        
        if (!phoneStateGranted) {
          // The specific alert for previously denied permission is already handled in requestFeaturePermissions
          // We just need to stop the flow here
          return;
        }
        
        // Bluetooth permissions only for physical glasses
        if (needsBluetoothPermissions) {
        const bluetoothPermissions: any[] = [];
        
        // Bluetooth permissions based on Android version
        if (typeof Platform.Version === 'number' && Platform.Version >= 30 && Platform.Version < 31) {
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH);
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADMIN);
        }
        if (typeof Platform.Version === 'number' && Platform.Version >= 31) {
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE);
          
          // Add NEARBY_DEVICES permission for Android 12+ (API 31+)
          if (PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES) {
            bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_DEVICES);
          }
        }
        
        // Request Bluetooth permissions directly
        if (bluetoothPermissions.length > 0) {
          const results = await PermissionsAndroid.requestMultiple(bluetoothPermissions);
          const allGranted = Object.values(results).every(
            (value) => value === PermissionsAndroid.RESULTS.GRANTED
          );
          
          // Since we now handle NEVER_ASK_AGAIN in requestFeaturePermissions,
          // we just need to check if all are granted
          if (!allGranted) {
            // Check if any are NEVER_ASK_AGAIN to show proper dialog
            const anyNeverAskAgain = Object.values(results).some(
              (value) => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
            );
            
            if (anyNeverAskAgain) {
              // Show "previously denied" dialog for Bluetooth
              showAlert(
                'Permission Required',
                'Bluetooth permissions are required but have been denied previously. Please enable them in Settings to continue.',
                [
                  { 
                    text: 'Open Settings', 
                    onPress: () => Linking.openSettings() 
                  },
                  {
                    text: 'Cancel',
                    style: 'cancel'
                  }
                ]
              );
            } else {
              // Show standard permission required dialog
              showAlert(
                'Permission Required',
                'Bluetooth permissions are required to connect to glasses',
                [{ text: 'OK' }]
              );
            }
            return;
          }
        }
        
        // Phone state permission already requested above for all Android devices
        } // End of Bluetooth permissions block
      } // End of Android-specific permissions block
      
      // Cross-platform permissions needed for both iOS and Android

      const hasBluetoothPermission = await requestFeaturePermissions(PermissionFeatures.BLUETOOTH);
      if (!hasBluetoothPermission) {
        showAlert(
          'Bluetooth Permission Required',
          'Bluetooth permission is required to connect to smart glasses.',
          [{ text: 'OK' }]
        );
        return; // Stop the connection process
      }
      
      // Request microphone permission (needed for both platforms)
      console.log("Requesting microphone permission...");
      
      // This now handles showing alerts for previously denied permissions internally
      const micGranted = await requestFeaturePermissions(PermissionFeatures.MICROPHONE);
      
      console.log("Microphone permission result:", micGranted);
      
      if (!micGranted) {
        // The specific alert for previously denied permission is already handled in requestFeaturePermissions
        // We just need to stop the flow here
        return;
      }
      
      // Request location permission (needed for both platforms)
      console.log("Requesting location permission...");
      
      // This now handles showing alerts for previously denied permissions internally
      const locGranted = await requestFeaturePermissions(PermissionFeatures.LOCATION);
      
      console.log("Location permission result:", locGranted);
      
      if (!locGranted) {
        // The specific alert for previously denied permission is already handled in requestFeaturePermissions
        // We just need to stop the flow here
        return;
      }
    } catch (error) {
      console.error('Error requesting permissions:', error);
      showAlert(
        'Error',
        'Failed to request necessary permissions',
        [{ text: 'OK' }]
      );
      return;
    }

    // Check that Bluetooth and Location are enabled/granted (skip for simulated glasses)
    if (needsBluetoothPermissions) {
      const requirementsCheck = await coreCommunicator.checkConnectivityRequirements();
      if (!requirementsCheck.isReady) {
        // Show alert about missing requirements
        showAlert(
          'Connection Issue',
          requirementsCheck.message || 'Cannot connect to glasses - check Bluetooth and Location settings',
          [{ text: 'OK' }]
        );
        
        return;
      }
    }

    console.log("needsBluetoothPermissions", needsBluetoothPermissions);

    // slight delay for bluetooth perms
    navigation.navigate('SelectGlassesBluetoothScreen', {
      glassesModelName: glassesModelName,
    });
  }

  return (
    <View style={[styles.container, isDarkTheme ? styles.darkBackground : styles.lightBackground]}>
      <ScrollView style={styles.scrollViewContainer}>
        <View style={styles.contentContainer}>
          {getPairingGuide(glassesModelName, isDarkTheme)}
        </View>
      </ScrollView>
      <View style={styles.buttonContainer}>
        <Button onPress={advanceToPairing} disabled={false}>
          <Text>Continue</Text>
        </Button>
      </View>
    </View>
  );
};

export default GlassesPairingGuidePreparationScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollViewContainer: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonContainer: {
    alignItems: 'center',
    marginBottom: 64,
    marginTop: 16,
  },
  text: {
    fontSize: 16,
    marginBottom: 10,
  },
  glassesImage: {
    width: 100,
    height: 60,
    resizeMode: 'contain',
    marginTop: 20,
  },
  darkBackground: {
    backgroundColor: '#1c1c1c',
  },
  lightBackground: {
    backgroundColor: '#f0f0f0',
  },
  darkText: {
    color: '#FFFFFF',
  },
  lightText: {
    color: '#333333',
  },
});
