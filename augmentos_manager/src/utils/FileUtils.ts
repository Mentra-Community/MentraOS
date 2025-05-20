import { Platform, Share, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';

const { FileProviderModule } = NativeModules;

// Log the available native modules for debugging
console.log('Available Native Modules:', Object.keys(NativeModules));
console.log('FileProviderModule available:', !!FileProviderModule);

/**
 * Utility functions for file operations
 */

/**
 * Ensures a file path has the proper URI scheme
 * @param path The file path to normalize
 * @returns The normalized file path
 */
const normalizeFilePath = (path: string): string => {
  // If on Android and the path doesn't have a file:// prefix, add it
  if (Platform.OS === 'android' && !path.startsWith('file://') && !path.startsWith('content://')) {
    return `file://${path}`;
  }
  
  // On iOS, ensure no file:// prefix as it's not needed
  if (Platform.OS === 'ios' && path.startsWith('file://')) {
    return path.substring(7);
  }
  
  return path;
};

/**
 * Shares a file with platform-specific handling
 * @param filePath The path to the file to share
 * @param mimeType The MIME type of the file (e.g. 'video/mp4', 'image/jpeg')
 * @param title (Optional) The title for the share dialog
 * @param message (Optional) The message to share with the file
 * @returns A promise that resolves when sharing is complete
 */

export const shareFile = async (
  filePath: string,
  mimeType: string,
  title?: string,
  message?: string
): Promise<void> => {
  try {
    console.log('Sharing file:', filePath);
    console.log('File MIME type:', mimeType);
    console.log('Current platform:', Platform.OS);
    
    // Check if the file exists
    const fileExists = await RNFS.exists(filePath);
    console.log('File exists:', fileExists);
    
    if (!fileExists) {
      throw new Error(`File does not exist: ${filePath}`);
    }
    
    // Get file info
    try {
      const fileInfo = await RNFS.stat(filePath);
      console.log('File size:', fileInfo.size);
      console.log('File is directory:', fileInfo.isDirectory());
      console.log('File modified time:', fileInfo.mtime);
    } catch (statError) {
      console.log('Error getting file info:', statError);
    }
    
    // Normalize the file path according to platform requirements
    const normalizedPath = normalizeFilePath(filePath);
    console.log('Normalized file path:', normalizedPath);
    
    if (Platform.OS === 'android') {
      // For Android, we need to use content:// URI through FileProvider
      console.log('Using Android sharing');
      
      if (FileProviderModule) {
        console.log('FileProviderModule found');
        
        // Check if direct share method is available
        if (FileProviderModule.shareFile) {
          console.log('Using direct shareFile method from native module');
          try {
            // Strip file:// prefix if present before sending to native module
            const pathForNative = normalizedPath.startsWith('file://') 
              ? normalizedPath.substring(7) 
              : normalizedPath;
              
            console.log('Path for native module:', pathForNative);
            
            // Use the direct native sharing method
            await FileProviderModule.shareFile(
              pathForNative,
              mimeType,
              title || 'Share File', 
              message || ''
            );
            console.log('Direct share completed successfully');
            return;
          } catch (directShareError) {
            console.error('Error with direct sharing:', directShareError);
            // Continue to fallback methods
          }
        }
        
        // Fallback to content URI method
        try {
          console.log('Attempting to get content URI for sharing');
          // Strip file:// prefix if present before sending to native module
          const pathForNative = normalizedPath.startsWith('file://') 
            ? normalizedPath.substring(7) 
            : normalizedPath;
            
          console.log('Path for native module:', pathForNative);
          const contentUri = await FileProviderModule.getUriForFile(pathForNative);
          console.log('Content URI received:', contentUri);
          
          const shareOptions = {
            title: title || 'Share File',
            message: message || '',
            url: contentUri,
            type: mimeType,
          };
          
          console.log('Share options:', JSON.stringify(shareOptions));
          await Share.share(shareOptions, {
            dialogTitle: title || 'Share File',
          });
        } catch (uriError) {
          console.error('Error getting content URI:', uriError);
          // Try last resort sharing method if content URI fails
          console.log('Trying last resort sharing method with direct file path');
          const shareOptions = {
            title: title || 'Share File',
            message: message || '',
            url: normalizedPath,
            type: mimeType,
          };
          
          await Share.share(shareOptions, {
            dialogTitle: title || 'Share File',
          });
        }
      } else {
        // Fallback if native module is not available
        const shareOptions = {
          title: title || 'Share File',
          message: `${message || ''}\n\nFile: ${filePath}`,
          // Note: This might not work for sharing the actual file
        };
        
        await Share.share(shareOptions, {
          dialogTitle: title || 'Share File',
        });
        
        console.warn(
          'FileProviderModule not available - file sharing may not work properly. ' +
          'Make sure the native module is properly linked.'
        );
      }
    } else {
      // For iOS, use a different approach with UTI instead of MIME type
      // Map common MIME types to UTIs
      let uti = 'public.item'; // Default fallback
      
      if (mimeType === 'video/mp4') {
        uti = 'public.movie';
      } else if (mimeType.startsWith('image/')) {
        uti = 'public.image';
      } else if (mimeType.startsWith('audio/')) {
        uti = 'public.audio';
      }
      
      console.log('iOS UTI type:', uti);
      
      // Normalize path for iOS (removing file:// prefix if present)
      const iosPath = normalizedPath;
      console.log('iOS sharing path:', iosPath);
      
      const shareOptions = {
        url: iosPath,
        UTI: uti,
        // Include optional message if provided
        message: message,
      };
      
      console.log('iOS share options:', JSON.stringify(shareOptions));
      
      await Share.share(shareOptions);
    }
  } catch (error) {
    console.error('Error sharing file:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
};