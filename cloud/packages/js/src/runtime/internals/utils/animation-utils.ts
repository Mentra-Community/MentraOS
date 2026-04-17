/**
 * 🎬 Animation Utilities Module
 *
 * Provides helper functions for creating and managing bitmap animations in MentraOS applications.
 * Includes timing utilities, animation factories, and performance optimization helpers.
 *
 * @example
 * ```typescript
 * import { AnimationUtils } from '@mentra/sdk';
 *
 * // Create animation from files
 * const animation = await AnimationUtils.createBitmapAnimation(
 *   session, './frames', 10, 1750, true
 * );
 *
 * // Simple delay utility
 * await AnimationUtils.delay(2000);
 *
 * // Stop animation
 * animation.stop();
 * ```
 */

import { AppSession } from "../app/session";
import { BitmapUtils, LoadFramesOptions } from "./bitmap-utils";

/**
 * Configuration options for bitmap animations
 */
export interface AnimationConfig {
  /** Time between frames in milliseconds (default: 1750ms - optimized for MentraOS) */
  intervalMs?: number;
  /** Whether to loop the animation continuously (default: false) */
  repeat?: boolean;
  /** Validate frames before starting animation (default: true) */
  validateFrames?: boolean;
  /** Options for loading frames from files */
  loadOptions?: LoadFramesOptions;
  /** Callback fired when animation starts */
  onStart?: () => void;
  /** Callback fired when animation stops/completes */
  onStop?: () => void;
  /** Callback fired on each frame display */
  onFrame?: (frameIndex: number, totalFrames: number) => void;
  /** Callback fired if animation encounters an error */
  onError?: (error: string) => void;
}

/**
 * Animation controller interface
 */
export interface AnimationController {
  /** Stop the animation */
  stop: () => void;
  /** Check if animation is currently running */
  isRunning: () => boolean;
  /** Get current frame index */
  getCurrentFrame: () => number;
  /** Get total frame count */
  getTotalFrames: () => number;
}

/**
 * Performance timing information
 */
export interface TimingInfo {
  /** Target interval between frames */
  targetInterval: number;
  /** Actual measured interval between frames */
  actualInterval: number;
  /** Timing drift (difference between target and actual) */
  drift: number;
  /** Frame rate (frames per second) */
  fps: number;
}

/**
 * Utility class for creating and managing animations in MentraOS applications
 */
export class AnimationUtils {
  /**
   * Simple async delay helper
   *
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after the specified delay
   *
   * @example
   * ```typescript
   * console.log('Starting...');
   * await AnimationUtils.delay(2000);
   * console.log('2 seconds later!');
   * ```
   */
  static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create bitmap animation from files with advanced configuration
   *
   * @param session - MentraOS app session
   * @param basePath - Directory containing animation frames
   * @param frameCount - Number of frames to load
   * @param config - Animation configuration options
   * @returns Promise resolving to animation controller
   *
   * @example
   * ```typescript
   * // Simple animation
   * const animation = await AnimationUtils.createBitmapAnimation(
   *   session, './animations', 10
   * );
   *
   * // Advanced configuration
   * const advancedAnimation = await AnimationUtils.createBitmapAnimation(
   *   session, './sprites', 8, {
   *     intervalMs: 1000,
   *     repeat: true,
   *     loadOptions: { filePattern: 'sprite_{i}.bmp', startFrame: 0 },
   *     onFrame: (frame, total) => console.log(`Frame ${frame}/${total}`),
   *     onError: (error) => console.error('Animation error:', error)
   *   }
   * );
   * ```
   */
  static async createBitmapAnimation(
    session: AppSession,
    basePath: string,
    frameCount: number,
    config: AnimationConfig = {},
  ): Promise<AnimationController> {
    const {
      intervalMs = 1750, // Optimized for MentraOS hardware
      repeat = false,
      validateFrames = true,
      loadOptions = {},
      onStart,
      onStop,
      onFrame,
      onError,
    } = config;

    try {
      console.log(`🎬 Loading ${frameCount} animation frames from ${basePath}...`);

      // Load frames with validation
      const frames = await BitmapUtils.loadBmpFrames(basePath, frameCount, {
        validateFrames,
        ...loadOptions,
      });

      if (frames.length === 0) {
        throw new Error("No frames loaded for animation");
      }

      console.log(`📚 Animation ready: ${frames.length} frames at ${intervalMs}ms intervals`);

      // Create enhanced animation with the loaded frames
      return this.createBitmapAnimationFromFrames(session, frames, {
        intervalMs,
        repeat,
        onStart,
        onStop,
        onFrame,
        onError,
      });
    } catch (error) {
      const errorMsg = `Failed to create animation: ${error instanceof Error ? error.message : "Unknown error"}`;
      console.error(`❌ ${errorMsg}`);
      if (onError) {
        onError(errorMsg);
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * Create bitmap animation from pre-loaded frame data
   *
   * @param session - MentraOS app session
   * @param frames - Array of hex-encoded bitmap data
   * @param config - Animation configuration options
   * @returns Animation controller
   *
   * @example
   * ```typescript
   * const frames = ['424d461a...', '424d461b...', '424d461c...'];
   * const animation = AnimationUtils.createBitmapAnimationFromFrames(
   *   session, frames, { intervalMs: 1500, repeat: true }
   * );
   * ```
   */
  static createBitmapAnimationFromFrames(
    session: AppSession,
    frames: string[],
    config: Omit<AnimationConfig, "loadOptions" | "validateFrames"> = {},
  ): AnimationController {
    const { intervalMs = 1750, repeat = false, onStart, onStop, onFrame, onError } = config;

    let isRunning = false;
    const currentFrame = 0;
    let animationController: { stop: () => void } | null = null;

    const controller: AnimationController = {
      stop: () => {
        if (animationController) {
          animationController.stop();
          animationController = null;
        }
        isRunning = false;
        if (onStop) {
          onStop();
        }
        console.log("🛑 Animation stopped");
      },

      isRunning: () => isRunning,

      getCurrentFrame: () => currentFrame,

      getTotalFrames: () => frames.length,
    };

    try {
      // Start the animation using the session's built-in method
      animationController = session.layouts.showBitmapAnimation(frames, intervalMs, repeat);
      isRunning = true;

      if (onStart) {
        onStart();
      }

      console.log(`🎬 Animation started: ${frames.length} frames at ${intervalMs}ms${repeat ? " (repeating)" : ""}`);

      // If we have frame callbacks, we need to track timing manually
      // This is a limitation of the current SDK - we can't hook into individual frame displays
      if (onFrame) {
        let frameTracker = 0;

        // Call onFrame for the first frame immediately
        onFrame(frameTracker, frames.length);

        const frameInterval = setInterval(() => {
          if (!isRunning) {
            clearInterval(frameInterval);
            return;
          }

          frameTracker = (frameTracker + 1) % frames.length;
          onFrame(frameTracker, frames.length);

          // If not repeating and we've shown all frames, stop tracking
          if (!repeat && frameTracker === frames.length - 1) {
            clearInterval(frameInterval);
          }
        }, intervalMs);

        // Override stop to also clear frame tracking
        const originalStop = controller.stop;
        controller.stop = () => {
          clearInterval(frameInterval);
          originalStop();
        };
      }
    } catch (error) {
      const errorMsg = `Failed to start animation: ${error instanceof Error ? error.message : "Unknown error"}`;
      console.error(`❌ ${errorMsg}`);
      if (onError) {
        onError(errorMsg);
      }
      throw new Error(errorMsg);
    }

    return controller;
  }

  /**
   * Create a sequence of bitmap displays with custom timing
   *
   * @param session - MentraOS app session
   * @param sequence - Array of frame data with individual timing
   * @returns Promise that resolves when sequence completes
   *
   * @example
   * ```typescript
   * await AnimationUtils.createBitmapSequence(session, [
   *   { frame: frame1Hex, duration: 1000 },
   *   { frame: frame2Hex, duration: 500 },
   *   { frame: frame3Hex, duration: 2000 }
   * ]);
   * ```
   */
  static async createBitmapSequence(
    session: AppSession,
    sequence: Array<{ frame: string; duration: number }>,
  ): Promise<void> {
    console.log(`🎭 Starting bitmap sequence: ${sequence.length} frames with custom timing`);

    for (let i = 0; i < sequence.length; i++) {
      const { frame, duration } = sequence[i];

      try {
        console.log(`📽️ Sequence frame ${i + 1}/${sequence.length} (${duration}ms)`);
        session.layouts.showBitmapView(frame);

        if (i < sequence.length - 1) {
          // Don't delay after the last frame
          await this.delay(duration);
        }
      } catch (error) {
        console.error(`❌ Error in sequence frame ${i + 1}:`, error);
        throw error;
      }
    }

    console.log("✅ Bitmap sequence completed");
  }

  /**
   * Measure animation timing performance
   *
   * @param targetInterval - Expected interval between frames in ms
   * @param measureDuration - How long to measure in ms (default: 10 seconds)
   * @returns Promise resolving to timing performance data
   *
   * @example
   * ```typescript
   * const timing = await AnimationUtils.measureTiming(1750, 10000);
   * console.log(`Target: ${timing.targetInterval}ms, Actual: ${timing.actualInterval}ms`);
   * console.log(`Drift: ${timing.drift}ms, FPS: ${timing.fps.toFixed(1)}`);
   * ```
   */
  static async measureTiming(targetInterval: number, measureDuration: number = 10000): Promise<TimingInfo> {
    return new Promise((resolve) => {
      const timestamps: number[] = [];
      const startTime = Date.now();

      const measureInterval = setInterval(() => {
        timestamps.push(Date.now());
      }, targetInterval);

      setTimeout(() => {
        clearInterval(measureInterval);

        if (timestamps.length < 2) {
          resolve({
            targetInterval,
            actualInterval: targetInterval,
            drift: 0,
            fps: 1000 / targetInterval,
          });
          return;
        }

        // Calculate actual interval
        const intervals = [];
        for (let i = 1; i < timestamps.length; i++) {
          intervals.push(timestamps[i] - timestamps[i - 1]);
        }

        const actualInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const drift = actualInterval - targetInterval;
        const fps = 1000 / actualInterval;

        resolve({
          targetInterval,
          actualInterval,
          drift,
          fps,
        });
      }, measureDuration);
    });
  }

  /**
   * Create optimized animation settings for different hardware
   *
   * @param deviceType - Target device type
   * @returns Recommended animation configuration
   *
   * @example
   * ```typescript
   * const config = AnimationUtils.getOptimizedConfig('even-realities-g1');
   * const animation = await AnimationUtils.createBitmapAnimation(
   *   session, './frames', 10, config
   * );
   * ```
   */
  static getOptimizedConfig(deviceType: "even-realities-g1" | "generic"): AnimationConfig {
    switch (deviceType) {
      case "even-realities-g1":
        return {
          intervalMs: 1650, // Tested optimal timing for Even Realities G1
          repeat: false,
          validateFrames: true,
          loadOptions: {
            validateFrames: true,
            skipMissingFrames: false,
          },
        };

      case "generic":
      default:
        return {
          intervalMs: 1000,
          repeat: false,
          validateFrames: true,
          loadOptions: {
            validateFrames: true,
            skipMissingFrames: false,
          },
        };
    }
  }

  /**
   * Preload and cache animation frames for better performance
   *
   * @param basePath - Directory containing frames
   * @param frameCount - Number of frames to preload
   * @param options - Loading options
   * @returns Promise resolving to cached frame data
   *
   * @example
   * ```typescript
   * // Preload frames
   * const cachedFrames = await AnimationUtils.preloadFrames('./animations', 10);
   *
   * // Use cached frames multiple times
   * const animation1 = AnimationUtils.createBitmapAnimationFromFrames(session, cachedFrames);
   * const animation2 = AnimationUtils.createBitmapAnimationFromFrames(session, cachedFrames);
   * ```
   */
  static async preloadFrames(basePath: string, frameCount: number, options: LoadFramesOptions = {}): Promise<string[]> {
    console.log(`📦 Preloading ${frameCount} frames from ${basePath}...`);

    const frames = await BitmapUtils.loadBmpFrames(basePath, frameCount, {
      validateFrames: true,
      ...options,
    });

    console.log(
      `✅ Preloaded ${frames.length} frames (${frames.reduce((total: number, frame: string) => total + frame.length, 0)} total characters)`,
    );

    return frames;
  }
}
