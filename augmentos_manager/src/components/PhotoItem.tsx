import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';

interface PhotoItemProps {
  photo: {
    photoUrl: string;
    uploadDate: string;
    appId: string;
    id: string;
  };
  isDarkTheme: boolean;
  onViewPhoto: (photo: any) => void;
  onDeletePhoto: (photoId: string) => void;
  showSourceBadge?: boolean; // Optional prop to show source badge
}

const PhotoItem: React.FC<PhotoItemProps> = ({
  photo,
  isDarkTheme,
  onViewPhoto,
  onDeletePhoto,
  showSourceBadge = false,
}) => {
  // Parse date from string
  const dateObj = new Date(photo.uploadDate);
  
  return (
    <TouchableOpacity
      style={[
        styles.photoItem,
        isDarkTheme ? styles.photoItemDark : styles.photoItemLight
      ]}
      onPress={() => onViewPhoto(photo)}
      activeOpacity={0.7}
    >
      <View style={styles.photoItemContent}>
        {/* Left: Photo Thumbnail */}
        <View style={styles.thumbnailContainer}>
          <Image
            source={{ uri: photo.photoUrl }}
            style={styles.thumbnail}
            resizeMode="cover"
          />
        </View>
        
        {/* Right: Info and Actions */}
        <View style={styles.photoInfoContainer}>
          {/* Date and Time */}
          <Text style={[
            styles.photoDate,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            {dateObj.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </Text>
          
          <Text style={[
            styles.photoTime,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            {dateObj.toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          
          {/* App source */}
          <Text style={[
            styles.appSource,
            isDarkTheme ? styles.lightText : styles.darkText
          ]}>
            From: {photo.appId}
          </Text>
          
          {/* Action Buttons */}
          <View style={styles.photoActions}>
            <TouchableOpacity 
              style={[styles.photoActionButton, styles.deleteButton]}
              onPress={(e) => {
                e.stopPropagation(); // Prevent triggering the card's onPress
                onDeletePhoto(photo.id);
              }}
            >
              <Icon name="delete" size={16} color="white" />
            </TouchableOpacity>
          </View>
          
          {/* Source badge */}
          {showSourceBadge && (
            <View style={styles.sourceBadge}>
              <Text style={styles.sourceBadgeText}>
                Cloud
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
  photoItem: {
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
  photoItemDark: {
    backgroundColor: '#2a2a2a',
  },
  photoItemLight: {
    backgroundColor: '#ffffff',
  },
  photoItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  thumbnailContainer: {
    padding: 8,
  },
  thumbnail: {
    width: 90,
    height: 90,
    borderRadius: 4,
  },
  photoInfoContainer: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
  },
  photoDate: {
    fontSize: 14,
    fontFamily: 'Montserrat-Bold',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  photoTime: {
    fontSize: 13,
    fontFamily: 'Montserrat-Regular',
    marginBottom: 6,
    opacity: 0.7,
  },
  appSource: {
    fontSize: 12,
    fontFamily: 'Montserrat-Italic',
    fontStyle: 'italic',
    marginBottom: 10,
    opacity: 0.8,
  },
  photoActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10, // Gap between buttons
  },
  photoActionButton: {
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

export default PhotoItem;