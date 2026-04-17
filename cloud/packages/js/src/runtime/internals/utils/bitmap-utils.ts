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

import * as fs from "fs/promises";
import * as path from "path";
import { Jimp } from "jimp";

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
  static async convert24BitTo1BitBMP(input24BitBmp: Buffer): Promise<Buffer> {
    // Read header information from 24-bit BMP
    const width = input24BitBmp.readUInt32LE(18);
    const height = Math.abs(input24BitBmp.readInt32LE(22)); // Height can be negative (top-down BMP)
    const isTopDown = input24BitBmp.readInt32LE(22) < 0;
    const bitsPerPixel = input24BitBmp.readUInt16LE(28);

    if (bitsPerPixel !== 24) {
      throw new Error("Input must be a 24-bit BMP");
    }

    // Calculate row sizes (both must be 4-byte aligned)
    const rowSize24 = Math.ceil((width * 3) / 4) * 4;
    const rowSize1 = Math.ceil(width / 32) * 4; // 32 pixels per 4 bytes

    // Calculate sizes for 1-bit BMP
    const colorTableSize = 8; // 2 colors * 4 bytes each
    const headerSize = 54 + colorTableSize;
    const pixelDataSize = rowSize1 * height;
    const fileSize = headerSize + pixelDataSize;

    // Create new buffer for 1-bit BMP
    const output1BitBmp = Buffer.alloc(fileSize);
    let offset = 0;

    // Write BMP file header (14 bytes)
    output1BitBmp.write("BM", offset);
    offset += 2; // Signature
    output1BitBmp.writeUInt32LE(fileSize, offset);
    offset += 4; // File size
    output1BitBmp.writeUInt16LE(0, offset);
    offset += 2; // Reserved 1
    output1BitBmp.writeUInt16LE(0, offset);
    offset += 2; // Reserved 2
    output1BitBmp.writeUInt32LE(headerSize, offset);
    offset += 4; // Pixel data offset

    // Write DIB header (40 bytes)
    output1BitBmp.writeUInt32LE(40, offset);
    offset += 4; // DIB header size
    output1BitBmp.writeInt32LE(width, offset);
    offset += 4; // Width
    output1BitBmp.writeInt32LE(height, offset);
    offset += 4; // Height (positive for bottom-up)
    output1BitBmp.writeUInt16LE(1, offset);
    offset += 2; // Planes
    output1BitBmp.writeUInt16LE(1, offset);
    offset += 2; // Bits per pixel (1-bit)
    output1BitBmp.writeUInt32LE(0, offset);
    offset += 4; // Compression (none)
    output1BitBmp.writeUInt32LE(pixelDataSize, offset);
    offset += 4; // Image size
    output1BitBmp.writeInt32LE(2835, offset);
    offset += 4; // X pixels per meter (72 DPI)
    output1BitBmp.writeInt32LE(2835, offset);
    offset += 4; // Y pixels per meter (72 DPI)
    output1BitBmp.writeUInt32LE(2, offset);
    offset += 4; // Colors used
    output1BitBmp.writeUInt32LE(2, offset);
    offset += 4; // Important colors

    // Write color table (8 bytes)
    // Black (index 0): B=0, G=0, R=0, Reserved=0
    output1BitBmp.writeUInt32LE(0x00000000, offset);
    offset += 4;
    // White (index 1): B=255, G=255, R=255, Reserved=0
    output1BitBmp.writeUInt8(255, offset++); // Blue
    output1BitBmp.writeUInt8(255, offset++); // Green
    output1BitBmp.writeUInt8(255, offset++); // Red
    output1BitBmp.writeUInt8(0, offset++); // Reserved

    // Convert pixel data from 24-bit to 1-bit
    const pixelDataStart24 = 54; // 24-bit BMP has no color table

    for (let y = 0; y < height; y++) {
      // BMP files are usually stored bottom-up
      const sourceY = isTopDown ? y : height - 1 - y;
      const destY = height - 1 - y; // Always write bottom-up for compatibility

      // Initialize the row with zeros
      const rowData = Buffer.alloc(rowSize1);

      for (let x = 0; x < width; x++) {
        // Get pixel from 24-bit BMP
        const offset24 = pixelDataStart24 + sourceY * rowSize24 + x * 3;
        const blue = input24BitBmp[offset24];
        const green = input24BitBmp[offset24 + 1];
        const red = input24BitBmp[offset24 + 2];

        // Determine if pixel is white (assuming pure black or white)
        // White = 1, Black = 0
        const isWhite = red > 128 || green > 128 || blue > 128 ? 1 : 0;

        // Calculate bit position
        const byteIndex = Math.floor(x / 8);
        const bitPosition = 7 - (x % 8); // MSB first

        // Set bit if white
        if (isWhite) {
          rowData[byteIndex] |= 1 << bitPosition;
        }
      }

      // Write row to output buffer
      const destOffset = offset + destY * rowSize1;
      rowData.copy(output1BitBmp, destOffset);
    }

    return output1BitBmp;
  }

  /**
   * Load a BMP file as hex string from filesystem
   *
   * @param filePath - Path to the BMP file
   * @returns Promise resolving to hex-encoded bitmap data
   * @throws Error if file cannot be read or is not a valid BMP
   *
   * @example
   * ```typescript
   * const bmpBase64 = await BitmapUtils.loadBmpFromFileAsBase64('./assets/icon.bmp');
   * session.layouts.showBitmapView(bmpBase64);
   * ```
   */
  static async fileToBase64(filePath: string): Promise<string> {
    try {
      const bmpData = await fs.readFile(filePath);

      return this.bufferToBase64(bmpData);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load BMP file ${filePath}: ${error.message}`);
      }
      throw new Error(`Failed to load BMP file ${filePath}: Unknown error`);
    }
  }

  static async bufferToBase64(bmpData: Buffer): Promise<string> {
    return bmpData.toString("base64");
  }

  static async padBase64Bitmap(bmpBase64: string, padding?: { left: number; top: number }): Promise<string> {
    const buffer = Buffer.from(bmpBase64, "base64");
    const paddedBuffer = await this.padBmpForGlasses(buffer, padding?.left, padding?.top);
    return paddedBuffer.toString("base64");
  }

  static async padBmpForGlasses(bmpData: Buffer, leftPadding: number = 50, topPadding: number = 35): Promise<Buffer> {
    try {
      // Basic BMP validation - check for BMP signature
      if (bmpData.length < 14 || bmpData[0] !== 0x42 || bmpData[1] !== 0x4d) {
        throw new Error(`Bmp data is not a valid BMP file (missing BM signature)`);
      }

      let finalBmpData = bmpData;

      // Load the image with Jimp
      const image = await Jimp.read(bmpData);

      // Check if we need to add padding
      if (image.width !== 576 || image.height !== 135) {
        console.log(
          `Adding padding to BMP since it isn't 576x135 (assuming it's 526x100!)(current: ${image.width}x${image.height})`,
        );

        // Create a new 576x135 white canvas
        const paddedImage = new Jimp({
          width: 576,
          height: 135,
          color: 0x00000000,
        });

        // // Calculate position to place the original image (with padding)
        const leftPadding = 50; // 45px padding on left
        const topPadding = 35; // 35px padding on top

        // Composite the original image onto the white canvas
        // paddedImage.composite(image, leftPadding, topPadding);
        paddedImage.composite(image, leftPadding, topPadding);

        finalBmpData = await this.convert24BitTo1BitBMP(await paddedImage.getBuffer("image/bmp"));
      }
      // No padding needed, just return as hex
      console.log(`finalBmpData: ${finalBmpData.length} bytes`);
      return finalBmpData;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load BMP data: ${error.message}`);
      }
      throw new Error(`Failed to load BMP data: Unknown error`);
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
  static async loadBmpFrames(basePath: string, frameCount: number, options: LoadFramesOptions = {}): Promise<string[]> {
    const {
      filePattern = "animation_10_frame_{i}.bmp",
      startFrame = 1,
      validateFrames = true,
      skipMissingFrames = false,
    } = options;

    const frames: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < frameCount; i++) {
      const frameNumber = startFrame + i;
      const fileName = filePattern.replace("{i}", frameNumber.toString());
      const filePath = path.join(basePath, fileName);

      try {
        const frameBase64 = await this.fileToBase64(filePath);

        if (validateFrames) {
          const validation = this.validateBase64Bitmap(frameBase64);
          if (!validation.isValid) {
            const errorMsg = `Frame ${frameNumber} validation failed: ${validation.errors.join(", ")}`;
            if (skipMissingFrames) {
              console.warn(`⚠️ ${errorMsg} - skipping`);
              continue;
            } else {
              throw new Error(errorMsg);
            }
          }
          console.log(`✅ Frame ${frameNumber} validated (${validation.blackPixels} black pixels)`);
        }

        frames.push(frameBase64);
      } catch (error) {
        const errorMsg = `Failed to load frame ${frameNumber} (${fileName}): ${
          error instanceof Error ? error.message : "Unknown error"
        }`;

        if (skipMissingFrames) {
          console.warn(`⚠️ ${errorMsg} - skipping`);
          continue;
        } else {
          errors.push(errorMsg);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to load frames:\n${errors.join("\n")}`);
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
  static validateBase64Bitmap(bmpFrame: string): BitmapValidation {
    const errors: string[] = [];
    let byteCount = 0;
    let blackPixels = 0;
    const metadata: BitmapValidation["metadata"] = {};

    try {
      const hexString = Buffer.from(bmpFrame, "base64").toString("hex");
      // Basic hex validation
      if (typeof hexString !== "string" || hexString.length === 0) {
        errors.push("Hex string is empty or invalid");
        return { isValid: false, byteCount: 0, blackPixels: 0, errors };
      }

      if (hexString.length % 2 !== 0) {
        errors.push("Hex string length must be even");
        return { isValid: false, byteCount: 0, blackPixels: 0, errors };
      }

      // Convert to buffer
      const buffer = Buffer.from(hexString, "hex");
      byteCount = buffer.length;

      // BMP signature validation
      if (buffer.length < 14) {
        errors.push("File too small to be a valid BMP (minimum 14 bytes for header)");
      } else {
        if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) {
          errors.push('Invalid BMP signature (should start with "BM")');
        }
      }

      // Size validation for MentraOS (576x135 = ~9782 bytes expected)
      const expectedSize = 9782;
      if (buffer.length < expectedSize - 100) {
        // Allow some tolerance
        errors.push(`BMP too small (${buffer.length} bytes, expected ~${expectedSize})`);
      } else if (buffer.length > expectedSize + 1000) {
        // Allow some tolerance
        errors.push(`BMP too large (${buffer.length} bytes, expected ~${expectedSize})`);
      }

      // Extract BMP metadata if header is valid
      if (buffer.length >= 54) {
        try {
          // BMP width and height are at offsets 18 and 22 (little-endian)
          const width = buffer.readUInt32LE(18);
          const height = buffer.readUInt32LE(22);
          metadata.dimensions = { width, height };
          metadata.format = "BMP";

          // Validate dimensions for MentraOS glasses
          if (width !== 576 || height !== 135) {
            errors.push(`Invalid dimensions (${width}x${height}, expected 576x135 for MentraOS)`);
          }
        } catch (e) {
          errors.push("Failed to parse BMP header metadata");
        }
      }

      // Pixel data validation (assumes 54-byte header + pixel data)
      if (buffer.length > 62) {
        const pixelData = buffer.slice(62); // Skip BMP header
        blackPixels = Array.from(pixelData).filter((b) => b !== 0xff).length;

        if (blackPixels === 0) {
          errors.push("No black pixels found (image appears to be all white)");
        }
      } else {
        errors.push("File too small to contain pixel data");
      }
    } catch (error) {
      errors.push(`Failed to parse hex data: ${error instanceof Error ? error.message : "Unknown error"}`);
    }

    return {
      isValid: errors.length === 0,
      byteCount,
      blackPixels,
      errors,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
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
    fromFormat: "hex" | "base64" | "buffer",
    toFormat: "hex" | "base64" | "buffer",
  ): string | Buffer {
    let buffer: Buffer;

    // Convert input to buffer
    switch (fromFormat) {
      case "hex":
        buffer = Buffer.from(data as string, "hex");
        break;
      case "base64":
        buffer = Buffer.from(data as string, "base64");
        break;
      case "buffer":
        buffer = data as Buffer;
        break;
      default:
        throw new Error(`Unsupported source format: ${fromFormat}`);
    }

    // Convert buffer to target format
    switch (toFormat) {
      case "hex":
        return buffer.toString("hex");
      case "base64":
        return buffer.toString("base64");
      case "buffer":
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
      const buffer = Buffer.from(hexString, "hex");
      const isValidBmp = buffer.length >= 14 && buffer[0] === 0x42 && buffer[1] === 0x4d;

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
      const blackPixels = Array.from(pixelData).filter((b) => b !== 0xff).length;

      return {
        byteCount: buffer.length,
        blackPixels,
        width,
        height,
        isValidBmp,
      };
    } catch (error) {
      return {
        byteCount: 0,
        blackPixels: 0,
        isValidBmp: false,
      };
    }
  }
}
