/**
 * 💡 LED Control Module
 *
 * Provides RGB LED control functionality for App Sessions.
 * Controls the RGB LEDs on smart glasses with custom colors and timing patterns.
 */

import {RgbLedControlRequest, AppToCloudMessageType, LedColor} from "../../../types"
import {Logger} from "pino"

/**
 * Options for LED control
 */
export interface LedControlOptions {
  /** LED color */
  color?: LedColor
  /** LED on duration in milliseconds */
  ontime?: number
  /** LED off duration in milliseconds */
  offtime?: number
  /** Number of on/off cycles */
  count?: number
}

/**
 * 💡 LED Control Module Implementation
 *
 * Provides methods for controlling LEDs on smart glasses.
 * Supports both low-level on/off control and higher-level pattern methods.
 *
 * @example
 * ```typescript
 * // General LED control
 * await session.led.turnOn({ color: 'red', ontime: 1000, count: 1 });
 *
 * // Blink green LED
 * await session.led.blink('green', 500, 500, 5);
 *
 * // Turn off all LEDs
 * await session.led.turnOff();
 * ```
 */
export class LedModule {
  private session: any
  private packageName: string
  private sessionId: string
  private logger: Logger

  /**
   * Create a new LedModule
   *
   * @param session - Reference to the parent AppSession
   * @param packageName - The App package name
   * @param sessionId - The current session ID
   * @param logger - Logger instance for debugging
   */
  constructor(session: any, packageName: string, sessionId: string, logger?: Logger) {
    this.session = session
    this.packageName = packageName
    this.sessionId = sessionId
    this.logger = logger || (console as any)
  }

  // =====================================
  // 💡 Low-level LED Control
  // =====================================

  /**
   * 💡 Turn on an LED with specified timing parameters
   *
   * @param options - LED control options (color, timing, count)
   * @returns Promise that resolves immediately after sending the command
   *
   * @example
   * ```typescript
   * // Solid red for 2 seconds
   * await session.led.turnOn({ color: 'red', ontime: 2000, count: 1 });
   *
   * // Blink white 3 times
   * await session.led.turnOn({ color: 'white', ontime: 500, offtime: 500, count: 3 });
   * ```
   */
  async turnOn(options: LedControlOptions): Promise<void> {
    try {
      // Generate unique request ID for tracking
      const requestId = `led_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

      // Create LED control request message
      const message: RgbLedControlRequest = {
        type: AppToCloudMessageType.RGB_LED_CONTROL,
        packageName: this.packageName,
        sessionId: this.sessionId,
        requestId,
        timestamp: new Date(),
        action: "on",
        color: options.color || "red",
        ontime: options.ontime || 1000,
        offtime: options.offtime || 0,
        count: options.count || 1,
      }

      // Send request to cloud (fire-and-forget)
      this.session.sendMessage(message)

      this.logger.info(
        {
          requestId,
          color: options.color,
          ontime: options.ontime,
          offtime: options.offtime,
          count: options.count,
        },
        `💡 LED control request sent`,
      )

      // Resolve immediately - no waiting for response
      return Promise.resolve()
    } catch (error) {
      this.logger.error({error, options}, "❌ Error in LED turnOn request")
      throw error
    }
  }

  /**
   * 💡 Turn off all LEDs
   *
   * @returns Promise that resolves immediately after sending the command
   *
   * @example
   * ```typescript
   * await session.led.turnOff();
   * ```
   */
  async turnOff(): Promise<void> {
    try {
      // Generate unique request ID for tracking
      const requestId = `led_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

      // Create LED control request message
      const message: RgbLedControlRequest = {
        type: AppToCloudMessageType.RGB_LED_CONTROL,
        packageName: this.packageName,
        sessionId: this.sessionId,
        requestId,
        timestamp: new Date(),
        action: "off",
      }

      // Send request to cloud (fire-and-forget)
      this.session.sendMessage(message)

      this.logger.info({requestId}, `💡 LED turn off request sent`)

      // Resolve immediately - no waiting for response
      return Promise.resolve()
    } catch (error) {
      this.logger.error({error}, "❌ Error in LED turnOff request")
      throw error
    }
  }

  /**
   * 💡 Get available LED capabilities
   *
   * @returns Array of available LED configurations
   *
   * @example
   * ```typescript
   * const capabilities = session.led.getCapabilities();
   * console.log('Available LEDs:', capabilities);
   * ```
   */
  getCapabilities(): Array<{
    id: string
    purpose: string
    isFullColor: boolean
    color?: string
    position?: string
  }> {
    // This would need to be implemented with access to session capabilities
    // For now, return empty array - this would be populated from session.capabilities
    return []
  }

  // =====================================
  // 💡 Pattern Methods (SDK-generated)
  // =====================================

  /**
   * 💡 Blink an LED with specified timing
   *
   * @param color - LED color to use
   * @param ontime - How long LED stays on (ms)
   * @param offtime - How long LED stays off (ms)
   * @param count - Number of blink cycles
   * @returns Promise that resolves immediately after sending the command
   *
   * @example
   * ```typescript
   * // Blink red LED 5 times (500ms on, 500ms off)
   * await session.led.blink('red', 500, 500, 5);
   * ```
   */
  async blink(color: LedColor, ontime: number, offtime: number, count: number): Promise<void> {
    return this.turnOn({
      color,
      ontime,
      offtime,
      count,
    })
  }

  /**
   * 💡 Solid LED mode - LED stays on continuously for specified duration
   *
   * Creates a solid LED effect with no off time, perfect for continuous illumination.
   *
   * @param color - LED color to use
   * @param duration - How long LED stays on (ms)
   * @returns Promise that resolves when the command is sent
   *
   * @example
   * ```typescript
   * // Solid red LED for 5 seconds
   * await session.led.solid('red', 5000);
   *
   * // Solid white LED for 30 seconds
   * await session.led.solid('white', 30000);
   * ```
   */
  async solid(color: LedColor, duration: number): Promise<void> {
    return this.turnOn({
      color,
      ontime: duration,
      offtime: 0, // No off time for solid mode
      count: 1, // Single cycle
    })
  }

  // =====================================
  // 💡 Cleanup
  // =====================================

  /**
   * Clean up LED module
   *
   * @internal
   */
  cleanup(): void {
    this.logger.info("🧹 LED module cleaned up")
  }
}
