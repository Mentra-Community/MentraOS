import RNFS from 'react-native-fs';
import { Platform, Image } from 'react-native';
import { createThumbnail } from 'react-native-create-thumbnail';

/**
 * Cache for video thumbnails to improve performance
 */
class ThumbnailCache {
  private cache: Map<string, string>;
  private cacheDirectory: string;
  private pendingGenerations: Map<string, Promise<string>>;

  constructor() {
    this.cache = new Map<string, string>();
    this.pendingGenerations = new Map<string, Promise<string>>();
    
    // Cache directory for thumbnails
    this.cacheDirectory = Platform.OS === 'ios' 
      ? `${RNFS.CachesDirectoryPath}/AugmentOSThumbnails` 
      : `${RNFS.CachesDirectoryPath}/AugmentOSThumbnails`;
    
    // Ensure cache directory exists
    this.ensureCacheDirectory();
  }

  /**
   * Ensure thumbnail cache directory exists
   */
  private async ensureCacheDirectory() {
    try {
      const exists = await RNFS.exists(this.cacheDirectory);
      if (!exists) {
        await RNFS.mkdir(this.cacheDirectory);
      }
    } catch (error) {
      console.error('Error creating thumbnail cache directory:', error);
    }
  }

  /**
   * Generate a cache key from a video path
   * @param videoPath Path to the video file
   * @returns Cache key for this video
   */
  private getCacheKey(videoPath: string): string {
    // Use the filename and last modified time as the cache key
    const filename = videoPath.split('/').pop() || '';
    return filename;
  }

  /**
   * Get the path where a thumbnail should be stored
   * @param cacheKey Cache key for the video
   * @returns Path to the thumbnail file
   */
  private getThumbnailPath(cacheKey: string): string {
    return `${this.cacheDirectory}/${cacheKey}.jpg`;
  }

  /**
   * Check if a thumbnail exists in the cache
   * @param videoPath Path to the video file
   * @returns Promise that resolves to the thumbnail path if it exists, or null if it doesn't
   */
  public async getThumbnail(videoPath: string): Promise<string | null> {
    const cacheKey = this.getCacheKey(videoPath);
    
    // Check in-memory cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) || null;
    }
    
    // Check if there's a pending generation for this video
    if (this.pendingGenerations.has(cacheKey)) {
      return this.pendingGenerations.get(cacheKey) || null;
    }
    
    // Check if thumbnail exists on disk
    const thumbnailPath = this.getThumbnailPath(cacheKey);
    try {
      const exists = await RNFS.exists(thumbnailPath);
      if (exists) {
        this.cache.set(cacheKey, thumbnailPath);
        return thumbnailPath;
      }
    } catch (error) {
      console.log('Error checking thumbnail existence:', error);
    }
    
    return null;
  }

  /**
   * Generate a thumbnail for a video and cache it
   * @param videoPath Path to the video file
   * @returns Promise that resolves to the thumbnail path when generation is complete
   */
  public async generateThumbnail(videoPath: string): Promise<string> {
    const cacheKey = this.getCacheKey(videoPath);
    const thumbnailPath = this.getThumbnailPath(cacheKey);
    
    // If there's already a pending generation, return that promise
    if (this.pendingGenerations.has(cacheKey)) {
      return this.pendingGenerations.get(cacheKey) as Promise<string>;
    }
    
    // Create a new generation promise
    const generationPromise = (async () => {
      try {
        // Create video URI in the right format for the platform
        const videoUri = Platform.OS === 'ios' 
          ? videoPath 
          : `file://${videoPath}`;
        
        // Generate the thumbnail
        const result = await createThumbnail({
          url: videoUri,
          timeStamp: 1000, // 1 second into the video
          quality: 0.8,
        });
        
        // Save thumbnail to cache directory
        await RNFS.copyFile(result.path, thumbnailPath);
        
        // Add to memory cache
        this.cache.set(cacheKey, thumbnailPath);
        
        return thumbnailPath;
      } catch (error) {
        console.error(`Error generating thumbnail for ${videoPath}:`, error);
        throw error;
      } finally {
        // Remove from pending set when done
        this.pendingGenerations.delete(cacheKey);
      }
    })();
    
    // Store the promise in pending generations
    this.pendingGenerations.set(cacheKey, generationPromise);
    
    return generationPromise;
  }

  /**
   * Get or generate a thumbnail for a video
   * @param videoPath Path to the video file
   * @returns Promise that resolves to the thumbnail path
   */
  public async getOrGenerateThumbnail(videoPath: string): Promise<string> {
    // Try to get from cache first
    const cachedThumbnail = await this.getThumbnail(videoPath);
    if (cachedThumbnail) {
      return cachedThumbnail;
    }
    
    // Generate if not in cache
    return this.generateThumbnail(videoPath);
  }

  /**
   * Clear thumbnail cache
   */
  public async clearCache(): Promise<void> {
    try {
      // Clear memory cache
      this.cache.clear();
      
      // Clear disk cache
      const files = await RNFS.readDir(this.cacheDirectory);
      const deletePromises = files.map(file => RNFS.unlink(file.path));
      await Promise.all(deletePromises);
    } catch (error) {
      console.error('Error clearing thumbnail cache:', error);
    }
  }
}

// Export a singleton instance
export const thumbnailCache = new ThumbnailCache();