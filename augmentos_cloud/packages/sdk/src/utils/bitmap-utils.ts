/**
 * 🎨 Bitmap Utilities Module
 *
 * Provides helper functions for working with bitmap images in MentraOS applications.
 * Includes file loading, data validation, and format conversion utilities.
 *
 * @example
 * ```typescript
 * import { BitmapUtils } from '@mentra/sdk';
 *
 * // Load a single BMP file
 * const bmpHex = await BitmapUtils.loadBmpAsHex('./my-image.bmp');
 * session.layouts.showBitmapView(bmpHex);
 *
 * // Load multiple animation frames
 * const frames = await BitmapUtils.loadBmpFrames('./animations', 10);
 * session.layouts.showBitmapAnimation(frames, 1500, true);
 * ```
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Validation result for bitmap data
 */
export interface BitmapValidation {
  /** Whether the bitmap data is valid */
  isValid: boolean;
  /** Total byte count of the bitmap */
  byteCount: number;
  /** Number of black (non-FF) pixels found */
  blackPixels: number;
  /** Array of validation error messages */
  errors: string[];
  /** Additional metadata about the bitmap */
  metadata?: {
    /** Expected bitmap dimensions (if detectable) */
    dimensions?: { width: number; height: number };
    /** Bitmap file format info */
    format?: string;
  };
}

/**
 * Options for loading bitmap frames
 */
export interface LoadFramesOptions {
  /** File name pattern (default: 'animation_10_frame_{i}.bmp') */
  filePattern?: string;
  /** Starting frame number (default: 1) */
  startFrame?: number;
  /** Validate each frame during loading (default: true) */
  validateFrames?: boolean;
  /** Continue loading if a frame is missing (default: false) */
  skipMissingFrames?: boolean;
}

/**
 * Utility class for working with bitmap images in MentraOS applications
 */
export class BitmapUtils {
  
  /**
   * Load a BMP file as hex string from filesystem
   * 
   * @param filePath - Path to the BMP file
   * @returns Promise resolving to hex-encoded bitmap data
   * @throws Error if file cannot be read or is not a valid BMP
   * 
   * @example
   * ```typescript
   * const bmpHex = await BitmapUtils.loadBmpAsHex('./assets/icon.bmp');
   * session.layouts.showBitmapView(bmpHex);
   * ```
   */
  static async loadBmpAsHex(filePath: string): Promise<string> {
    try {
      const bmpData = await fs.readFile(filePath);
      
      // Basic BMP validation - check for BMP signature
      if (bmpData.length < 14 || bmpData[0] !== 0x42 || bmpData[1] !== 0x4D) {
        throw new Error(`File ${filePath} is not a valid BMP file (missing BM signature)`);
      }
      
      const hexString = bmpData.toString('hex');
      console.log(`📁 Loaded BMP: ${path.basename(filePath)} (${bmpData.length} bytes)`);
      
      return hexString;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load BMP file ${filePath}: ${error.message}`);
      }
      throw new Error(`Failed to load BMP file ${filePath}: Unknown error`);
    }
  }

  /**
   * Load multiple BMP frames as hex array for animations
   * 
   * @param basePath - Directory containing the frame files
   * @param frameCount - Number of frames to load
   * @param options - Loading options and configuration
   * @returns Promise resolving to array of hex-encoded bitmap data
   * 
   * @example
   * ```typescript
   * // Load 10 frames with default pattern
   * const frames = await BitmapUtils.loadBmpFrames('./animations', 10);
   * 
   * // Load with custom pattern
   * const customFrames = await BitmapUtils.loadBmpFrames('./sprites', 8, {
   *   filePattern: 'sprite_{i}.bmp',
   *   startFrame: 0
   * });
   * ```
   */
  static async loadBmpFrames(
    basePath: string, 
    frameCount: number, 
    options: LoadFramesOptions = {}
  ): Promise<string[]> {
    const {
      filePattern = 'animation_10_frame_{i}.bmp',
      startFrame = 1,
      validateFrames = true,
      skipMissingFrames = false
    } = options;

    const frames: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < frameCount; i++) {
      const frameNumber = startFrame + i;
      const fileName = filePattern.replace('{i}', frameNumber.toString());
      const filePath = path.join(basePath, fileName);

      try {
        const frameHex = await this.loadBmpAsHex(filePath);
        
        if (validateFrames) {
          const validation = this.validateBmpHex(frameHex);
          if (!validation.isValid) {
            const errorMsg = `Frame ${frameNumber} validation failed: ${validation.errors.join(', ')}`;
            if (skipMissingFrames) {
              console.warn(`⚠️ ${errorMsg} - skipping`);
              continue;
            } else {
              throw new Error(errorMsg);
            }
          }
          console.log(`✅ Frame ${frameNumber} validated (${validation.blackPixels} black pixels)`);
        }
        
        frames.push(frameHex);
      } catch (error) {
        const errorMsg = `Failed to load frame ${frameNumber} (${fileName}): ${error instanceof Error ? error.message : 'Unknown error'}`;
        
        if (skipMissingFrames) {
          console.warn(`⚠️ ${errorMsg} - skipping`);
          continue;
        } else {
          errors.push(errorMsg);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to load frames:\n${errors.join('\n')}`);
    }

    if (frames.length === 0) {
      throw new Error(`No valid frames loaded from ${basePath}`);
    }

    console.log(`📚 Loaded ${frames.length} animation frames from ${basePath}`);
    return frames;
  }

  /**
   * Validate BMP hex data integrity and extract metadata
   * 
   * @param hexString - Hex-encoded bitmap data
   * @returns Validation result with detailed information
   * 
   * @example
   * ```typescript
   * const validation = BitmapUtils.validateBmpHex(bmpHex);
   * if (!validation.isValid) {
   *   console.error('Invalid bitmap:', validation.errors);
   * } else {
   *   console.log(`Valid bitmap: ${validation.blackPixels} black pixels`);
   * }
   * ```
   */
  static validateBmpHex(hexString: string): BitmapValidation {
    const errors: string[] = [];
    let byteCount = 0;
    let blackPixels = 0;
    let metadata: BitmapValidation['metadata'] = {};

    try {
      // Basic hex validation
      if (typeof hexString !== 'string' || hexString.length === 0) {
        errors.push('Hex string is empty or invalid');
        return { isValid: false, byteCount: 0, blackPixels: 0, errors };
      }

      if (hexString.length % 2 !== 0) {
        errors.push('Hex string length must be even');
        return { isValid: false, byteCount: 0, blackPixels: 0, errors };
      }

      // Convert to buffer
      const buffer = Buffer.from(hexString, 'hex');
      byteCount = buffer.length;

      // BMP signature validation
      if (buffer.length < 14) {
        errors.push('File too small to be a valid BMP (minimum 14 bytes for header)');
      } else {
        if (buffer[0] !== 0x42 || buffer[1] !== 0x4D) {
          errors.push('Invalid BMP signature (should start with "BM")');
        }
      }

      // Size validation for MentraOS (576x135 = ~9782 bytes expected)
      const expectedSize = 9782;
      if (buffer.length < expectedSize - 100) { // Allow some tolerance
        errors.push(`BMP too small (${buffer.length} bytes, expected ~${expectedSize})`);
      } else if (buffer.length > expectedSize + 1000) { // Allow some tolerance
        errors.push(`BMP too large (${buffer.length} bytes, expected ~${expectedSize})`);
      }

      // Extract BMP metadata if header is valid
      if (buffer.length >= 54) {
        try {
          // BMP width and height are at offsets 18 and 22 (little-endian)
          const width = buffer.readUInt32LE(18);
          const height = buffer.readUInt32LE(22);
          metadata.dimensions = { width, height };
          metadata.format = 'BMP';

          // Validate dimensions for MentraOS glasses
          if (width !== 576 || height !== 135) {
            errors.push(`Invalid dimensions (${width}x${height}, expected 576x135 for MentraOS)`);
          }
        } catch (e) {
          errors.push('Failed to parse BMP header metadata');
        }
      }

      // Pixel data validation (assumes 54-byte header + pixel data)
      if (buffer.length > 62) {
        const pixelData = buffer.slice(62); // Skip BMP header
        blackPixels = Array.from(pixelData).filter(b => b !== 0xFF).length;
        
        if (blackPixels === 0) {
          errors.push('No black pixels found (image appears to be all white)');
        }
      } else {
        errors.push('File too small to contain pixel data');
      }

    } catch (error) {
      errors.push(`Failed to parse hex data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      isValid: errors.length === 0,
      byteCount,
      blackPixels,
      errors,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined
    };
  }

  /**
   * Convert bitmap data between different formats
   * 
   * @param data - Input bitmap data
   * @param fromFormat - Source format ('hex' | 'base64' | 'buffer')
   * @param toFormat - Target format ('hex' | 'base64' | 'buffer')
   * @returns Converted bitmap data
   * 
   * @example
   * ```typescript
   * const base64Data = BitmapUtils.convertFormat(hexData, 'hex', 'base64');
   * const bufferData = BitmapUtils.convertFormat(base64Data, 'base64', 'buffer');
   * ```
   */
  static convertFormat(
    data: string | Buffer, 
    fromFormat: 'hex' | 'base64' | 'buffer', 
    toFormat: 'hex' | 'base64' | 'buffer'
  ): string | Buffer {
    let buffer: Buffer;

    // Convert input to buffer
    switch (fromFormat) {
      case 'hex':
        buffer = Buffer.from(data as string, 'hex');
        break;
      case 'base64':
        buffer = Buffer.from(data as string, 'base64');
        break;
      case 'buffer':
        buffer = data as Buffer;
        break;
      default:
        throw new Error(`Unsupported source format: ${fromFormat}`);
    }

    // Convert buffer to target format
    switch (toFormat) {
      case 'hex':
        return buffer.toString('hex');
      case 'base64':
        return buffer.toString('base64');
      case 'buffer':
        return buffer;
      default:
        throw new Error(`Unsupported target format: ${toFormat}`);
    }
  }

  /**
   * Get bitmap information without full validation
   * 
   * @param hexString - Hex-encoded bitmap data
   * @returns Basic bitmap information
   * 
   * @example
   * ```typescript
   * const info = BitmapUtils.getBitmapInfo(bmpHex);
   * console.log(`Bitmap: ${info.width}x${info.height}, ${info.blackPixels} black pixels`);
   * ```
   */
  static getBitmapInfo(hexString: string): {
    byteCount: number;
    blackPixels: number;
    width?: number;
    height?: number;
    isValidBmp: boolean;
  } {
    try {
      const buffer = Buffer.from(hexString, 'hex');
      const isValidBmp = buffer.length >= 14 && buffer[0] === 0x42 && buffer[1] === 0x4D;
      
      let width: number | undefined;
      let height: number | undefined;
      
      if (isValidBmp && buffer.length >= 54) {
        try {
          width = buffer.readUInt32LE(18);
          height = buffer.readUInt32LE(22);
        } catch (e) {
          // Ignore metadata parsing errors
        }
      }

      const pixelData = buffer.slice(62);
      const blackPixels = Array.from(pixelData).filter(b => b !== 0xFF).length;

      return {
        byteCount: buffer.length,
        blackPixels,
        width,
        height,
        isValidBmp
      };
    } catch (error) {
      return {
        byteCount: 0,
        blackPixels: 0,
        isValidBmp: false
      };
    }
  }
}