import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  BackHandler,
  Image,
  ToastAndroid,
  Platform,
  Linking,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { showAlert } from '../utils/AlertUtils';
import { RNCamera } from 'react-native-camera';
import { useNavigation } from '@react-navigation/native';
import GlassesDisplayMirrorFullscreen from '../components/GlassesDisplayMirrorFullscreen';
import { useStatus } from '../providers/AugmentOSStatusProvider';
import { useGlassesMirror } from '../providers/GlassesMirrorContext';
import { requestFeaturePermissions, PermissionFeatures } from '../logic/PermissionsUtils';
import { NavigationProps } from '../components/types';
import RNFS from 'react-native-fs';
import coreCommunicator from '../bridge/CoreCommunicator';

interface GlassesMirrorFullscreenProps {
  isDarkTheme: boolean;
}

// Request camera permission when needed
const requestCameraPermission = async () => {
  return await requestFeaturePermissions(PermissionFeatures.CAMERA);
};

// Request microphone permission for recording
const requestMicrophonePermission = async () => {
  return await requestFeaturePermissions(PermissionFeatures.MICROPHONE);
};

const GlassesMirrorFullscreen: React.FC<GlassesMirrorFullscreenProps> = ({ isDarkTheme }) => {
  const { status } = useStatus();
  const { events } = useGlassesMirror(); // From context
  const [hasCameraPermission, setHasCameraPermission] = useState(false);
  const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false);
  const [cameraType, setCameraType] = useState(RNCamera.Constants.Type.front);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [recordingCount, setRecordingCount] = useState(0);
  
  const cameraRef = useRef<RNCamera | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const navigation = useNavigation<NavigationProps>();

  // Helper to check if we have a glasses model name
  const isGlassesConnected = !!status.glasses_info?.model_name;
  
  // Get only the last event
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  
  // Check camera permission on component mount
  useEffect(() => {
    checkCameraPermission();
    checkMicrophonePermission();
    // Hide status bar in fullscreen mode
    StatusBar.setHidden(true);
    // Check for existing recordings
    checkRecordings();
    
    // Add a focus listener to reload recordings when returning from gallery
    const unsubscribe = navigation.addListener('focus', () => {
      // Refresh recording count when returning to this screen
      checkRecordings();
    });
    
    return () => {
      // Show status bar when exiting
      StatusBar.setHidden(false);
      // Clean up recording timer if it exists
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
      // Stop recording if it's in progress
      if (isRecording) {
        stopRecording();
      }
      // Clean up focus listener
      unsubscribe();
    };
  }, [navigation]);
  
  // Count how many recordings are available
  const checkRecordings = async () => {
    try {
      // Define the directory where recordings are stored
      const videoDir = Platform.OS === 'ios' 
        ? `${RNFS.DocumentDirectoryPath}/AugmentOSRecordings` 
        : `${RNFS.ExternalDirectoryPath}/AugmentOSRecordings`;
      
      // Check if directory exists, create if not
      const dirExists = await RNFS.exists(videoDir);
      if (!dirExists) {
        await RNFS.mkdir(videoDir);
        setRecordingCount(0);
        return;
      }
      
      // Read directory contents and count videos
      const files = await RNFS.readDir(videoDir);
      const videoFiles = files.filter(file => file.name.endsWith('.mp4'));
      setRecordingCount(videoFiles.length);
    } catch (error) {
      console.error('Error checking recordings:', error);
      setRecordingCount(0);
    }
  };
  
  // Recording timer effect
  useEffect(() => {
    if (isRecording) {
      // Start a timer that updates every second
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      // Clear the timer when recording stops
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      // Reset the counter
      setRecordingTime(0);
    }
    
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [isRecording]);
  
  // Check camera permission
  const checkCameraPermission = async () => {
    const hasPermission = await requestCameraPermission();
    setHasCameraPermission(hasPermission);
    return hasPermission;
  };
  
  // Check microphone permission
  const checkMicrophonePermission = async () => {
    const hasPermission = await requestMicrophonePermission();
    setHasMicrophonePermission(hasPermission);
    return hasPermission;
  };
  
  // Back button handler
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      handleExitFullscreen();
      return true;
    });

    return () => backHandler.remove();
  }, []);
  
  // Handle exiting fullscreen mode
  const handleExitFullscreen = () => {
    StatusBar.setHidden(false);
    navigation.goBack();
  };
  
  // Toggle camera between front and back
  const toggleCamera = () => {
    if (!isRecording) {
      setCameraType(
        cameraType === RNCamera.Constants.Type.front
          ? RNCamera.Constants.Type.back
          : RNCamera.Constants.Type.front
      );
    } else {
      // Don't allow camera switching during recording
      if (Platform.OS === 'android') {
        ToastAndroid.show('Cannot switch camera while recording', ToastAndroid.SHORT);
      } else {
        showAlert('Recording in Progress', 'Cannot switch camera while recording');
      }
    }
  };
  
  // Format seconds into MM:SS format
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  };
  
  // Start recording video
  const startRecording = async () => {
    if (!hasCameraPermission) {
      showAlert('Permission Required', 'Camera permission is needed for recording', undefined, {
        iconName: 'videocam-off',
        iconColor: '#FF3B30'
      });
      return;
    }
    
    if (!hasMicrophonePermission) {
      const hasPermission = await checkMicrophonePermission();
      if (!hasPermission) {
        showAlert('Permission Required', 'Microphone permission is needed for recording', undefined, {
          iconName: 'mic-off',
          iconColor: '#FF3B30'
        });
        return;
      }
    }
    
    // Ensure we have a directory to save recordings
    const videoDir = Platform.OS === 'ios' 
      ? `${RNFS.DocumentDirectoryPath}/AugmentOSRecordings` 
      : `${RNFS.ExternalDirectoryPath}/AugmentOSRecordings`;
    
    // Check if directory exists, create if not
    const dirExists = await RNFS.exists(videoDir);
    if (!dirExists) {
      await RNFS.mkdir(videoDir);
    }
    
    // Create a unique filename with timestamp
    const timestamp = new Date().getTime();
    const filename = `glasses-recording-${timestamp}.mp4`;
    const filePath = `${videoDir}/${filename}`;
    
    if (cameraRef.current) {
      try {
        const options = {
          quality: RNCamera.Constants.VideoQuality['720p'],
          maxDuration: 60, // 60 seconds max
          maxFileSize: 30 * 1024 * 1024, // 30MB
          mute: false, // Record with audio
          // Prevent zooming by maintaining aspect ratio and video format
          orientation: 'portrait',
          // Set video stabilization (iOS)
          videoStabilizationMode: 'auto',
          // Set these based on preview dimensions to prevent aspect ratio shift
          videoWidth: 1280,
          videoHeight: 720,
        };
        
        setIsRecording(true);
        const data = await cameraRef.current.recordAsync(options);
        
        // Store video in our app directory
        if (Platform.OS === 'ios') {
          // On iOS, copy the file
          await RNFS.copyFile(data.uri, filePath);
        } else {
          // On Android, move the file
          const sourceUri = data.uri.startsWith('file://') 
            ? data.uri.substring(7) 
            : data.uri;
          await RNFS.moveFile(sourceUri, filePath);
        }
        
        setRecordingPath(filePath);
        
        // Update recording count
        await checkRecordings();
        
        // Show success message
        if (Platform.OS === 'android') {
          ToastAndroid.show('Recording saved!', ToastAndroid.LONG);
        } else {
          showAlert(
            'Recording Saved', 
            'Your recording has been saved successfully!',
            [
              { 
                text: 'View in Gallery',
                onPress: () => navigation.goBack()
              },
              { text: 'Continue Recording' }
            ],
            {
              iconName: 'check-circle',
              iconColor: '#4CAF50'
            }
          );
        }
      } catch (error) {
        console.error('Error recording video:', error);
        showAlert('Recording Error', 'Failed to record video', undefined, {
          iconName: 'error',
          iconColor: '#FF3B30'
        });
      }
    }
  };
  
  // Stop recording video
  const stopRecording = () => {
    if (cameraRef.current && isRecording) {
      cameraRef.current.stopRecording();
      setIsRecording(false);
    }
  };
  
  // Toggle recording state
  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };
  

  return (
    <View style={styles.fullscreenContainer}>
      {isGlassesConnected && lastEvent ? (
        <>
          {/* Camera feed */}
          {hasCameraPermission ? (
            <RNCamera
              ref={cameraRef}
              style={styles.cameraBackground}
              type={cameraType}
              captureAudio={true}
              keepAudioSession={true}
              zoom={0}
              useNativeZoom={false}
              ratio="16:9"
              androidCameraPermissionOptions={{
                title: 'Camera Permission',
                message: 'This app needs access to your camera for the fullscreen mirror mode.',
                buttonPositive: 'OK',
                buttonNegative: 'Cancel',
              }}
              androidRecordAudioPermissionOptions={{
                title: 'Microphone Permission',
                message: 'This app needs access to your microphone for recording videos.',
                buttonPositive: 'OK',
                buttonNegative: 'Cancel',
              }}
            />
          ) : (
            <View style={styles.fullscreenBackground}>
              <Text style={styles.cameraPermissionText}>
                Camera permission needed for fullscreen mode
              </Text>
            </View>
          )}
          
          {/* Overlay the glasses display content */}
          <View style={styles.fullscreenOverlay}>
            <GlassesDisplayMirrorFullscreen 
              layout={lastEvent.layout}
              fallbackMessage="Unknown layout data"
            />
          </View>
          
          {/* Fullscreen exit button */}
          <TouchableOpacity
            style={styles.exitFullscreenButton}
            onPress={handleExitFullscreen}
          >
            <Text style={styles.exitFullscreenText}>Exit</Text>
          </TouchableOpacity>
          
          {/* Camera flip button */}
          {hasCameraPermission && (
            <TouchableOpacity
              style={styles.flipCameraButton}
              onPress={toggleCamera}
            >
              <Icon 
                name="flip-camera-ios" 
                size={28} 
                color="white" 
              />
            </TouchableOpacity>
          )}
          
          {/* Recording button */}
          {/* TEMPORARILY: COMMENT OUT THE RECORD BUTTON ULTIL THIS FEATURE IS COMPLETE */}
          {/* {hasCameraPermission && (
            <View style={styles.recordingContainer}>
              <TouchableOpacity
                style={[
                  styles.recordButton,
                  isRecording ? styles.recordingActive : {}
                ]}
                onPress={toggleRecording}
              >
                {isRecording ? (
                  <Icon name="stop" size={36} color="white" />
                ) : (
                  <View style={styles.recordButtonInner} />
                )}
              </TouchableOpacity>
              
              {isRecording && (
                <Text style={styles.recordingTimer}>
                  {formatTime(recordingTime)}
                </Text>
              )}
            </View>
          )} */}
          
          {/* Gallery button - goes back to main screen to view gallery */}
          {!isRecording && (
            <TouchableOpacity
              style={styles.videosButton}
              onPress={() => navigation.goBack()}
            >
              <Icon name="photo-library" size={24} color="white" />
              {recordingCount > 0 && (
                <View style={styles.badgeContainer}>
                  <Text style={styles.badgeText}>{recordingCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        </>
      ) : (
        <View style={styles.fallbackContainer}>
          <Text style={styles.fallbackText}>
            {!isGlassesConnected 
              ? "Connect glasses to use the Glasses Mirror" 
              : "No display events available"}
          </Text>
          <TouchableOpacity
            style={styles.exitFullscreenButton}
            onPress={handleExitFullscreen}
          >
            <Text style={styles.exitFullscreenText}>Back</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  fullscreenContainer: {
    flex: 1,
    padding: 0,
    backgroundColor: 'black',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
  },
  cameraBackground: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    aspectRatio: 1,
    alignSelf: 'center',
  },
  fullscreenBackground: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    backgroundColor: '#1a1a1a', // Dark background for contrast with green text
    justifyContent: 'center',
    alignItems: 'center',
  },
  cameraPermissionText: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Montserrat-Regular',
    textAlign: 'center',
  },
  fullscreenOverlay: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    padding: 40,
    zIndex: 10,
  },
  fullscreenDisplayContainer: {
    padding: 0,
    backgroundColor: 'transparent',
  },
  exitFullscreenButton: {
    position: 'absolute',
    top: 40,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 30,
    zIndex: 20,
  },
  exitFullscreenText: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Montserrat-Bold',
  },
  flipCameraButton: {
    position: 'absolute',
    top: 40,
    left: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 12,
    borderRadius: 50,
    zIndex: 20,
  },
  recordingContainer: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  recordButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(255, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: 'white',
  },
  recordButtonInner: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'white',
  },
  recordingActive: {
    backgroundColor: 'rgba(255, 0, 0, 0.9)',
    borderColor: 'white',
  },
  recordingTimer: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Montserrat-Bold',
    marginTop: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 5,
    paddingHorizontal: 15,
    borderRadius: 20,
  },
  videosButton: {
    position: 'absolute',
    bottom: 40,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: 12,
    borderRadius: 50,
    zIndex: 20,
  },
  badgeContainer: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FF4444',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(0, 0, 0, 0.6)',
  },
  badgeText: {
    color: 'white',
    fontSize: 12,
    fontFamily: 'Montserrat-Bold',
    fontWeight: 'bold',
  },
  fallbackContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#121212',
  },
  fallbackText: {
    color: 'white',
    fontSize: 18,
    fontFamily: 'Montserrat-Regular',
    textAlign: 'center',
    marginHorizontal: 20,
    marginBottom: 20,
  },
});

export default GlassesMirrorFullscreen;