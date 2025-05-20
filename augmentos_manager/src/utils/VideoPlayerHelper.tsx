import { Platform, Share } from 'react-native';
import RNFS from 'react-native-fs';
import { showAlert } from './AlertUtils';

/**
 * Helper class for video playback and sharing that handles Android & iOS differences
 */
export default class VideoPlayerHelper {
  /**
   * Play a video with the device's default video player
   * @param filePath Path to the video file
   */
  static async playVideo(filePath: string): Promise<void> {
    try {
      if (Platform.OS === 'android') {
        // On Android, share the video for playback which bypasses permission issues
        const fileName = filePath.split('/').pop() || 'video.mp4';
        
        // Share the video for playback
        await Share.share({
          title: 'Play Video',
          message: 'Play this video',
          url: `file://${filePath}`,
        });
      } else {
        // On iOS, direct file:// URLs work as expected
        const supported = await RNFS.exists(filePath);
        
        if (!supported) {
          throw new Error('File does not exist');
        }
        
        // iOS uses a different mechanism to open files
        // that is handled by the OS
        const success = await Share.share({
          url: filePath,
        });
        
        if (!success) {
          throw new Error('Failed to open video player');
        }
      }
    } catch (error) {
      console.error('Error playing video:', error);
      showAlert(
        'Playback Error',
        'Unable to play the video. The file may be corrupted or your device may not have a compatible video player installed.',
        undefined,
        {
          iconName: 'error',
          iconColor: '#FF3B30',
        }
      );
    }
  }

  /**
   * Share a video with other apps
   * @param filePath Path to the video file
   */
  static async shareVideo(filePath: string): Promise<void> {
    try {
      const fileName = filePath.split('/').pop() || 'video.mp4';
      
      // Share options
      const shareOptions = {
        title: 'Share AugmentOS Recording',
        message: 'Check out this recording from my smart glasses!',
        url: Platform.OS === 'android' ? `file://${filePath}` : filePath,
      };
      
      // Open the share dialog
      await Share.share(shareOptions, {
        dialogTitle: 'Share your video recording',
      });
    } catch (error) {
      console.error('Error sharing video:', error);
      showAlert(
        'Sharing Error',
        'Failed to share the video. Please try again.',
        undefined,
        {
          iconName: 'error',
          iconColor: '#FF3B30',
        }
      );
    }
  }
}