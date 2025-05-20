import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import VideoThumbnail from './VideoThumbnail';

interface VideoItemProps {
  videoPath: string;
  isDarkTheme: boolean;
  onPlayVideo: (filePath: string) => void;
  onShareVideo: (filePath: string) => void;
  onDeleteVideo: (filePath: string) => void;
  showSourceBadge?: boolean; // Optional prop to show source badge
}

const VideoItem: React.FC<VideoItemProps> = ({
  videoPath,
  isDarkTheme,
  onPlayVideo,
  onShareVideo,
  onDeleteVideo,
  showSourceBadge = false,
}) => {
  // Extract filename from path
  const filename = videoPath.split('/').pop() || '';
  // Convert timestamp in filename to readable date
  let dateString = "Unknown date";
  let timestamp = 0;
  const match = filename.match(/glasses-recording-(\d+)\.mp4/);
  if (match && match[1]) {
    timestamp = parseInt(match[1]);
    dateString = new Date(timestamp).toLocaleString();
  }

  return (
    <TouchableOpacity
      style={[
        styles.videoItem,
        isDarkTheme ? styles.videoItemDark : styles.videoItemLight
      ]}
      onPress={() => onPlayVideo(videoPath)}
      activeOpacity={0.7}
    >
      <View style={styles.videoItemContent}>
        {/* Left: Video Thumbnail */}
        <View style={styles.thumbnailContainer}>
          <VideoThumbnail
            videoPath={videoPath}
            isDarkTheme={isDarkTheme}
          />
        </View>
        
        {/* Right: Info and Actions */}
        <View style={styles.videoInfoContainer}>
          {/* Date and Time */}
          <Text style={[
            styles.videoDate,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            {timestamp ? new Date(timestamp).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }) : "Unknown date"}
          </Text>
          
          <Text style={[
            styles.videoTime,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            {timestamp ? new Date(timestamp).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            }) : ""}
          </Text>
          
          {/* Action Buttons */}
          <View style={styles.videoActions}>
            <TouchableOpacity 
              style={[styles.videoActionButton, styles.shareButton]}
              onPress={(e) => {
                e.stopPropagation(); // Prevent triggering the card's onPress
                onShareVideo(videoPath);
              }}
            >
              <Icon name="share" size={16} color="white" />
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.videoActionButton, styles.deleteButton]}
              onPress={(e) => {
                e.stopPropagation(); // Prevent triggering the card's onPress
                onDeleteVideo(videoPath);
              }}
            >
              <Icon name="delete" size={16} color="white" />
            </TouchableOpacity>
          </View>
          
          {/* Source badge */}
          {showSourceBadge && (
            <View style={styles.sourceBadge}>
              <Text style={styles.sourceBadgeText}>
                Local
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  darkText: {
    color: '#000000',
  },
  lightText: {
    color: '#ffffff',
  },
  videoItem: {
    marginBottom: 12,
    borderRadius: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    borderWidth: 0.5,
    borderColor: 'rgba(0, 0, 0, 0.1)',
    overflow: 'hidden',
  },
  videoItemDark: {
    backgroundColor: '#2a2a2a',
  },
  videoItemLight: {
    backgroundColor: '#ffffff',
  },
  videoItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumbnailContainer: {
    padding: 8,
  },
  videoInfoContainer: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
  },
  videoDate: {
    fontSize: 14,
    fontFamily: 'Montserrat-Bold',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  videoTime: {
    fontSize: 13,
    fontFamily: 'Montserrat-Regular',
    marginBottom: 10,
    opacity: 0.7,
  },
  videoActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10, // Gap between buttons
  },
  videoActionButton: {
    width: 36, // Smaller buttons
    height: 36, // Smaller buttons
    borderRadius: 18, // Circular buttons
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  shareButton: {
    backgroundColor: '#2196F3', // Blue
  },
  deleteButton: {
    backgroundColor: '#FF5252', // Red
  },
  sourceBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sourceBadgeText: {
    color: 'white',
    fontSize: 10,
    fontFamily: 'Montserrat-Medium',
  },
});

export default VideoItem;