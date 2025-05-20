import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, ScrollView, Platform, ActivityIndicator, TouchableOpacity, FlatList } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import Button from '../components/Button';
import coreCommunicator from '../bridge/CoreCommunicator';
import GlobalEventEmitter from '../logic/GlobalEventEmitter';

type GlassesWifiSetupScreenProps = {
  isDarkTheme: boolean;
  toggleTheme: () => void;
};

// Define the wizard steps
enum SetupStep {
  SELECT_METHOD,    // Choose between scan or manual entry
  SCAN_NETWORKS,    // Scanning and selecting a network
  ENTER_PASSWORD,   // Enter password for selected network
  CONNECTING        // Connecting to the network
}

const GlassesWifiSetupScreen: React.FC<GlassesWifiSetupScreenProps> = ({ isDarkTheme }) => {
  // State variables
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [networks, setNetworks] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<SetupStep>(SetupStep.SELECT_METHOD);
  const [wifiConnected, setWifiConnected] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  
  // Navigation and route
  const navigation = useNavigation();
  const route = useRoute();
  const { deviceModel } = route.params as { deviceModel: string };
  
  // References to event listeners for proper cleanup
  const wifiScanResultsListenerRef = useRef<any>(null);
  const wifiStatusListenerRef = useRef<any>(null);
  
  useEffect(() => {
    // Listen for WiFi scan results
    wifiScanResultsListenerRef.current = GlobalEventEmitter.addListener(
      'WIFI_SCAN_RESULTS',
      (data: { networks: string[] }) => {
        console.log('WiFi scan results received:', data.networks);
        setNetworks(data.networks);
        setIsScanning(false);
        
        // If networks were found, automatically move to network selection
        if (data.networks && data.networks.length > 0) {
          setCurrentStep(SetupStep.SCAN_NETWORKS);
        } else {
          // If no networks found, show error and stay on same step
          GlobalEventEmitter.emit('SHOW_BANNER', { 
            message: 'No WiFi networks found. Please try again or enter details manually.', 
            type: 'error' 
          });
        }
      }
    );
    
    // Listen for WiFi connection status changes
    wifiStatusListenerRef.current = GlobalEventEmitter.addListener(
      'GLASSES_WIFI_STATUS_CHANGE',
      (data: { connected: boolean, ssid?: string }) => {
        console.log('WiFi connection status changed:', data);
        setWifiConnected(data.connected);
        
        // Clear any existing connection timeout
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        
        if (data.connected) {
          // Connection successful
          GlobalEventEmitter.emit('SHOW_BANNER', { 
            message: `Successfully connected to ${data.ssid || 'WiFi network'}`, 
            type: 'success' 
          });
          
          // Wait a moment to show success before navigating away
          setTimeout(() => {
            navigation.navigate('Home');
          }, 1500);
        } else if (currentStep === SetupStep.CONNECTING) {
          // Explicit connection failed notification
          setConnectionError('Unable to connect to the network. Please check your credentials and try again.');
          setCurrentStep(SetupStep.ENTER_PASSWORD);
          GlobalEventEmitter.emit('SHOW_BANNER', { 
            message: 'Failed to connect to WiFi network. Please check your credentials.', 
            type: 'error' 
          });
        }
      }
    );
    
    // Cleanup function runs on component unmount
    return () => {
      // Clear any existing connection timeout
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      
      // Remove event listeners
      if (wifiScanResultsListenerRef.current) {
        wifiScanResultsListenerRef.current.remove();
      }
      if (wifiStatusListenerRef.current) {
        wifiStatusListenerRef.current.remove();
      }
    };
  }, [navigation]);

  // Start the WiFi scan
  const handleStartScan = async () => {
    setIsScanning(true);
    setNetworks([]);
    
    try {
      await coreCommunicator.requestWifiScan();
      
      // No need to update UI here, the event listener will handle it
    } catch (error) {
      console.error('Error scanning for WiFi networks:', error);
      setIsScanning(false);
      GlobalEventEmitter.emit('SHOW_BANNER', { 
        message: 'Failed to scan for WiFi networks', 
        type: 'error' 
      });
    }
  };

  // Handle selection of a WiFi network from the list
  const handleNetworkSelect = (selectedNetwork: string) => {
    setSsid(selectedNetwork);
    setCurrentStep(SetupStep.ENTER_PASSWORD);
  };

  // Switch to manual network entry
  const handleManualEntry = () => {
    setSsid('');
    setPassword('');
    setCurrentStep(SetupStep.ENTER_PASSWORD);
  };

  // Timeout reference for connection attempts
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Connect to the WiFi network
  const handleConnect = async () => {
    if (!ssid) {
      GlobalEventEmitter.emit('SHOW_BANNER', { 
        message: 'WiFi network name (SSID) is required', 
        type: 'error' 
      });
      return;
    }
    
    // Clear any existing timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    
    setConnectionError('');
    setIsLoading(true);
    setCurrentStep(SetupStep.CONNECTING);
    setWifiConnected(false);
    
    try {
      // Send WiFi credentials to Core
      await coreCommunicator.sendWifiCredentials(ssid, password);
      
      // Show sending message
      GlobalEventEmitter.emit('SHOW_BANNER', { 
        message: 'WiFi credentials sent to glasses. Connecting...', 
        type: 'info' 
      });
      
      // Set a timeout for connection attempt (30 seconds)
      connectionTimeoutRef.current = setTimeout(() => {
        // Only handle timeout if we're still on connecting screen
        if (currentStep === SetupStep.CONNECTING && !wifiConnected) {
          console.log('WiFi connection timeout reached');
          setConnectionError('Connection timed out. Please try again.');
          setCurrentStep(SetupStep.ENTER_PASSWORD);
          GlobalEventEmitter.emit('SHOW_BANNER', { 
            message: 'WiFi connection timed out. Please check your credentials and try again.', 
            type: 'error' 
          });
        }
      }, 30000); // 30 second timeout
      
      // Connection success/failure will be handled by the event listener
      
    } catch (error) {
      console.error('Error setting WiFi credentials:', error);
      setConnectionError('Failed to send WiFi credentials. Please try again.');
      setCurrentStep(SetupStep.ENTER_PASSWORD);
      GlobalEventEmitter.emit('SHOW_BANNER', { 
        message: 'Failed to send WiFi credentials', 
        type: 'error' 
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Go back to the previous step
  const handleBack = () => {
    if (currentStep === SetupStep.SCAN_NETWORKS) {
      setCurrentStep(SetupStep.SELECT_METHOD);
    } else if (currentStep === SetupStep.ENTER_PASSWORD) {
      // If we came from network selection, go back to that
      if (networks.length > 0) {
        setCurrentStep(SetupStep.SCAN_NETWORKS);
      } else {
        setCurrentStep(SetupStep.SELECT_METHOD);
      }
    } else if (currentStep === SetupStep.CONNECTING) {
      setCurrentStep(SetupStep.ENTER_PASSWORD);
    }
  };

  // Render different UI based on the current step
  const renderStepContent = () => {
    switch (currentStep) {
      case SetupStep.SELECT_METHOD:
        return (
          <View style={styles.stepContainer}>
            <Text style={[styles.stepTitle, { color: isDarkTheme ? '#fff' : '#000' }]}>
              Choose WiFi Setup Method
            </Text>
            
            <View style={styles.buttonGroup}>
              <Button
                title="Scan for Networks"
                onPress={handleStartScan}
                style={styles.fullWidthButton}
                disabled={isScanning}
              />
              <ActivityIndicator
                size="small"
                color={isDarkTheme ? '#fff' : '#000'}
                style={{ marginTop: 10, opacity: isScanning ? 1 : 0 }}
              />
              
              <Text style={[styles.orDivider, { color: isDarkTheme ? '#ccc' : '#666' }]}>
                OR
              </Text>
              
              <Button
                title="Enter Network Manually"
                onPress={handleManualEntry}
                type="secondary"
                style={styles.fullWidthButton}
              />
            </View>
          </View>
        );
        
      case SetupStep.SCAN_NETWORKS:
        return (
          <View style={styles.stepContainer}>
            <Text style={[styles.stepTitle, { color: isDarkTheme ? '#fff' : '#000' }]}>
              Select WiFi Network
            </Text>
            
            {networks.length > 0 ? (
              <View style={[styles.networksContainer, { 
                backgroundColor: isDarkTheme ? '#222' : '#f0f0f0',
                borderColor: isDarkTheme ? '#444' : '#ddd'
              }]}>
                <FlatList
                  data={networks}
                  keyExtractor={(item, index) => `network-${index}`}
                  renderItem={({ item }) => (
                    <TouchableOpacity 
                      style={[styles.networkItem, {
                        backgroundColor: isDarkTheme ? '#333' : '#fff'
                      }]}
                      onPress={() => handleNetworkSelect(item)}
                    >
                      <Text style={{ color: isDarkTheme ? '#fff' : '#000' }}>
                        {item}
                      </Text>
                    </TouchableOpacity>
                  )}
                  style={styles.networksList}
                />
              </View>
            ) : (
              <ActivityIndicator 
                size="large" 
                color={isDarkTheme ? '#fff' : '#000'} 
                style={styles.centeredLoader} 
              />
            )}
            
            <View style={styles.buttonRow}>
              <Button
                title="Back"
                onPress={handleBack}
                type="secondary"
                style={styles.backButton}
              />
              <Button
                title="Scan Again"
                onPress={handleStartScan}
                disabled={isScanning}
                style={styles.actionButton}
              />
            </View>
          </View>
        );
        
      case SetupStep.ENTER_PASSWORD:
        return (
          <View style={styles.stepContainer}>
            <Text style={[styles.stepTitle, { color: isDarkTheme ? '#fff' : '#000' }]}>
              Enter WiFi Details
            </Text>
            
            <View style={styles.formGroup}>
              <Text style={[styles.label, { color: isDarkTheme ? '#fff' : '#000' }]}>
                WiFi Network Name (SSID)
              </Text>
              <TextInput
                style={[styles.input, { 
                  color: isDarkTheme ? '#fff' : '#000',
                  backgroundColor: isDarkTheme ? '#333' : '#f5f5f5',
                  borderColor: isDarkTheme ? '#444' : '#ddd'
                }]}
                value={ssid}
                onChangeText={setSsid}
                placeholder="Enter WiFi network name"
                placeholderTextColor={isDarkTheme ? '#aaa' : '#999'}
                autoCapitalize="none"
                editable={networks.length === 0} // Only editable if not selected from list
              />
            </View>
            
            <View style={styles.formGroup}>
              <Text style={[styles.label, { color: isDarkTheme ? '#fff' : '#000' }]}>
                Password
              </Text>
              <TextInput
                style={[styles.input, { 
                  color: isDarkTheme ? '#fff' : '#000',
                  backgroundColor: isDarkTheme ? '#333' : '#f5f5f5',
                  borderColor: isDarkTheme ? '#444' : '#ddd'
                }]}
                value={password}
                onChangeText={setPassword}
                placeholder="Enter WiFi password"
                placeholderTextColor={isDarkTheme ? '#aaa' : '#999'}
                secureTextEntry
                autoCapitalize="none"
              />
            </View>
            
            {connectionError ? (
              <Text style={styles.errorText}>{connectionError}</Text>
            ) : null}
            
            <View style={styles.buttonRow}>
              <Button
                title="Back"
                onPress={handleBack}
                type="secondary"
                style={styles.backButton}
              />
              <Button
                title="Connect"
                onPress={handleConnect}
                disabled={!ssid}
                style={styles.actionButton}
              />
            </View>
          </View>
        );
        
      case SetupStep.CONNECTING:
        return (
          <View style={styles.stepContainer}>
            <Text style={[styles.stepTitle, { color: isDarkTheme ? '#fff' : '#000' }]}>
              Connecting to WiFi
            </Text>
            
            <View style={styles.connectingInfo}>
              <Text style={[styles.connectingText, { color: isDarkTheme ? '#ccc' : '#666' }]}>
                Connecting to:
              </Text>
              <Text style={[styles.ssidText, { color: isDarkTheme ? '#fff' : '#000' }]}>
                {ssid}
              </Text>
              
              {!wifiConnected && (
                <ActivityIndicator 
                  size="large" 
                  color={isDarkTheme ? '#fff' : '#000'} 
                  style={{ marginTop: 20 }} 
                />
              )}
              
              {wifiConnected && (
                <View style={styles.successContainer}>
                  <Text style={styles.successText}>
                    Successfully connected!
                  </Text>
                </View>
              )}
            </View>
            
            {!wifiConnected && (
              <Button
                title="Cancel"
                onPress={handleBack}
                type="secondary"
                style={{ marginTop: 20 }}
              />
            )}
          </View>
        );
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: isDarkTheme ? '#000' : '#fff' }]}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.title, { color: isDarkTheme ? '#fff' : '#000' }]}>
          WiFi Setup
        </Text>
        
        <Text style={[styles.subtitle, { color: isDarkTheme ? '#ccc' : '#333' }]}>
          Your {deviceModel} glasses need WiFi to connect to the internet.
        </Text>
        
        {renderStepContent()}
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    flexGrow: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 30,
  },
  stepContainer: {
    width: '100%',
  },
  stepTitle: {
    fontSize: 20,
    fontWeight: '500',
    marginBottom: 20,
  },
  buttonGroup: {
    width: '100%',
    alignItems: 'center',
  },
  fullWidthButton: {
    width: '100%',
    marginVertical: 8,
  },
  orDivider: {
    marginVertical: 16,
    fontSize: 16,
    fontWeight: '500',
  },
  formGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    marginBottom: 8,
    fontWeight: '500',
  },
  input: {
    height: 50,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    width: '100%',
  },
  networksContainer: {
    borderWidth: 1,
    borderRadius: 8,
    marginBottom: 20,
    maxHeight: 300,
    width: '100%',
  },
  networksList: {
    width: '100%',
  },
  networkItem: {
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 10,
  },
  backButton: {
    flex: 1,
    marginRight: 8,
  },
  actionButton: {
    flex: 1,
    marginLeft: 8,
  },
  centeredLoader: {
    marginVertical: 30,
  },
  connectingInfo: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  connectingText: {
    fontSize: 16,
    marginBottom: 10,
  },
  ssidText: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  errorText: {
    color: '#f00',
    marginBottom: 15,
  },
  successContainer: {
    padding: 15,
    backgroundColor: '#4CAF50',
    borderRadius: 8,
    marginTop: 20,
  },
  successText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
});

export default GlassesWifiSetupScreen;