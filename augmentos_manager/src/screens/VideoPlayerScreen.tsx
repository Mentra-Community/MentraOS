import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Platform,
  StatusBar,
} from 'react-native';
import Video from 'react-native-video';
import { useNavigation, useRoute } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';

interface VideoPlayerScreenProps {
  isDarkTheme: boolean;
}

const VideoPlayerScreen: React.FC<VideoPlayerScreenProps> = ({ isDarkTheme }) => {
  const navigation = useNavigation();
  const route = useRoute();
  const { filePath, fileName } = route.params as { filePath: string; fileName?: string };
  
  // Ensure file path is correctly formatted for the platform
  const videoUri = Platform.OS === 'ios' ? filePath : `file://${filePath}`;
  
  const [isLoading, setIsLoading] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const videoRef = useRef(null);
  
  // Go back to the gallery
  const handleBack = () => {
    navigation.goBack();
  };
  
  // Handle video end - only set finished state
  const handleEnd = () => {
    setIsFinished(true);
    // Don't automatically seek here, as it can cause playback issues
  };
  
  // Ensure status bar is visible with proper styling for video player
  useEffect(() => {
    // Make sure status bar is visible and properly styled
    StatusBar.setHidden(false);
    // Set status bar to light content since the player has a dark background
    StatusBar.setBarStyle('light-content');
    
    return () => {
      // Reset status bar style when leaving this screen
      StatusBar.setBarStyle('default');
    };
  }, []);
  
  return (
    <SafeAreaView style={styles.container}>
      {/* Explicitly show status bar */}
      <StatusBar 
        hidden={false}
        barStyle="light-content"
        backgroundColor="#000000"
        translucent={false}
      />
      
      {/* Simple header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Icon name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.headerText}>
          {fileName || 'Video'}
        </Text>
        {/* Add empty view to balance layout */}
        <View style={styles.rightPlaceholder} />
      </View>
      
      {/* Simple video container */}
      <View style={styles.videoWrapper}>
        <Video 
          ref={videoRef}
          source={{ uri: videoUri }}
          style={styles.video}
          resizeMode="contain"
          onLoad={() => setIsLoading(false)}
          onEnd={handleEnd}
          controls={true}
          fullscreenAutorotate={false}
          disableFullscreen={true}
          // Explicitly control paused state
          paused={isFinished}
          playInBackground={false}
          playWhenInactive={false}
          // Add this to prevent the built-in fullscreen button from appearing
          controlTimeout={3000}
        />
        
        {isLoading && (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color="#4c8bf5" />
          </View>
        )}
        
        {isFinished && (
          <TouchableOpacity 
            style={styles.restartOverlay}
            onPress={() => {
              // First seek to beginning
              if (videoRef.current) {
                videoRef.current.seek(0);
              }
              // Then after a short delay, set finished to false to unpause
              setTimeout(() => {
                setIsFinished(false);
              }, 100);
            }}
          >
            <View style={styles.restartButton}>
              <Icon name="replay" size={40} color="#fff" />
              <Text style={styles.restartText}>Tap to replay</Text>
            </View>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  backButton: {
    padding: 8,
    marginRight: 16,
  },
  headerText: {
    flex: 1, // Allow text to take available space but not push other elements
    color: '#fff',
    fontSize: 18,
    fontFamily: 'Montserrat-Bold',
    marginRight: 16, // Add margin to prevent text from touching right edge
  },
  rightPlaceholder: {
    width: 40, // Match width of back button for balanced layout
  },
  videoWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  restartOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  restartButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  restartText: {
    color: '#fff',
    marginTop: 10,
    fontSize: 16,
    fontFamily: 'Montserrat-Regular',
  },
});

export default VideoPlayerScreen;