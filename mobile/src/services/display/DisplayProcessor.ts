/**
 * DisplayProcessor
 *
 * Processes display events with pixel-accurate text wrapping using the same
 * display-utils library as the cloud. This ensures the mobile preview matches
 * exactly what is shown on the glasses.
 *
 * Key responsibilities:
 * 1. Intercept display events before sending to native SGC
 * 2. Wrap text using the correct device profile (G1, etc.)
 * 3. Ensure GlassesDisplayMirror shows exactly what glasses will show
 *
 * @see cloud/issues/026-mobile-display-processor for design docs
 */

import {
  createDisplayToolkit,
  G1_PROFILE,
  Z100_PROFILE,
  NEX_PROFILE,
  TextMeasurer,
  TextWrapper,
  DisplayHelpers,
  ColumnComposer,
  type DisplayProfile,
  type WrapOptions,
  type BreakMode,
} from "@mentra/display-utils"

import {useGlassesStore} from "@/stores/glasses"

// =============================================================================
// Types
// =============================================================================

/**
 * Supported device models for display processing
 */
export type DeviceModel = "g1" | "z100" | "nex" | "mach1" | "mentra-live" | "simulated" | "unknown"

/**
 * Display event types that we process
 */
export type DisplayLayoutType =
  | "text_wall"
  | "text_line"
  | "text_rows"
  | "reference_card"
  | "double_text_wall"
  | "bitmap_view"

/**
 * Raw display event from the cloud/WebSocket
 */
export interface DisplayEvent {
  view: "main" | "dashboard"
  layoutType?: DisplayLayoutType
  layout?: {
    layoutType: DisplayLayoutType
    text?: string | string[] // string for text_wall/text_line, string[] for text_rows
    title?: string
    topText?: string
    bottomText?: string
    data?: string // For bitmap_view
    [key: string]: unknown
  }
  text?: string | string[]
  title?: string
  topText?: string
  bottomText?: string
  [key: string]: unknown
}

/**
 * Processed display event with guaranteed wrapped text
 */
export interface ProcessedDisplayEvent extends DisplayEvent {
  /** Marks this event as processed */
  _processed: true
  /** The device profile used for processing */
  _profile: string
  /** Pre-split lines for text_wall/text_line (for easy rendering) */
  _lines?: string[]
  /** Original layout type before processing (e.g., double_text_wall -> text_wall) */
  _originalLayoutType?: DisplayLayoutType
  /** Column composition metadata for double_text_wall */
  _composedColumns?: {
    leftLines: string[]
    rightLines: string[]
    config: {
      leftColumnWidthPx: number
      rightColumnStartPx: number
      rightColumnWidthPx: number
      maxLines: number
      leftMarginSpaces?: number
    }
  }
}

/**
 * Options for the DisplayProcessor
 */
export interface DisplayProcessorOptions {
  /** Default break mode for text wrapping */
  breakMode?: BreakMode
  /** Whether to log processing details */
  debug?: boolean
}

// =============================================================================
// Placeholder Replacement
// =============================================================================

/**
 * Placeholder values that can be replaced in display text.
 * These match the placeholders used in CoreManager.kt/CoreManager.swift
 */
interface PlaceholderValues {
  /** Current time in 12-hour format (e.g., "2:30 PM") */
  TIME12: string
  /** Current time in 24-hour format (e.g., "14:30") */
  TIME24: string
  /** Current date (e.g., "1/22") */
  DATE: string
  /** Glasses battery level (e.g., "85%" or "" if unknown) */
  GBATT: string
  /** Connection status */
  CONNECTION_STATUS: string
}

/**
 * Get current placeholder values from device state
 */
function getPlaceholderValues(): PlaceholderValues {
  const now = new Date()

  // Format time in 12-hour format
  const hours12 = now.getHours() % 12 || 12
  const minutes = now.getMinutes().toString().padStart(2, "0")
  const ampm = now.getHours() >= 12 ? "PM" : "AM"
  const TIME12 = `${hours12}:${minutes} ${ampm}`

  // Format time in 24-hour format
  const hours24 = now.getHours().toString().padStart(2, "0")
  const TIME24 = `${hours24}:${minutes}`

  // Format date
  const month = now.getMonth() + 1
  const day = now.getDate()
  const DATE = `${month}/${day}`

  // Get battery level from glasses store
  const batteryLevel = useGlassesStore.getState().batteryLevel
  const GBATT = batteryLevel === -1 ? "" : `${batteryLevel}%`

  // Connection status
  const connected = useGlassesStore.getState().connected
  const CONNECTION_STATUS = connected ? "Connected" : ""

  return {TIME12, TIME24, DATE, GBATT, CONNECTION_STATUS}
}

/**
 * Replace placeholders in text with actual values.
 * Placeholders are in format $NAME$ (e.g., $GBATT$, $TIME12$)
 *
 * @param text - Text containing placeholders
 * @returns Text with placeholders replaced
 */
function replacePlaceholders(text: string): string {
  if (!text || !text.includes("$")) {
    return text
  }

  const values = getPlaceholderValues()

  return text
    .replace(/\$TIME12\$/g, values.TIME12)
    .replace(/\$TIME24\$/g, values.TIME24)
    .replace(/\$DATE\$/g, values.DATE)
    .replace(/\$GBATT\$/g, values.GBATT)
    .replace(/\$CONNECTION_STATUS\$/g, values.CONNECTION_STATUS)
    .replace(/\$no_datetime\$/g, `${values.DATE}, ${values.TIME12}`)
}

// =============================================================================
// Device Profile Mapping
// =============================================================================

/**
 * Map device model names to display profiles
 */
const DEVICE_PROFILES: Record<DeviceModel, DisplayProfile> = {
  "g1": G1_PROFILE,
  "z100": Z100_PROFILE,
  "nex": NEX_PROFILE,
  "mach1": Z100_PROFILE, // Mach1 uses same hardware as Vuzix Z100
  "mentra-live": G1_PROFILE, // Mentra Live has no display, uses G1 as fallback
  "simulated": G1_PROFILE, // Simulated uses G1 profile
  "unknown": G1_PROFILE, // Default to G1
}

/**
 * Normalize various model name strings to our DeviceModel type
 */
function normalizeModelName(modelName: string | null | undefined): DeviceModel {
  if (!modelName) return "unknown"

  const lower = modelName.toLowerCase()

  if (lower.includes("g1") || lower.includes("even realities")) {
    return "g1"
  }
  if (lower.includes("z100") || lower.includes("vuzix")) {
    return "z100"
  }
  if (lower.includes("nex") || lower.includes("mentra display")) {
    return "nex"
  }
  if (lower.includes("mach1") || lower.includes("mach 1")) {
    return "mach1"
  }
  if (lower.includes("mentra live") || lower.includes("mentra-live")) {
    return "mentra-live"
  }
  if (lower.includes("simulated") || lower.includes("simulator")) {
    return "simulated"
  }

  return "unknown"
}

// =============================================================================
// DisplayProcessor Class
// =============================================================================

/**
 * Processes display events with pixel-accurate text wrapping.
 *
 * Usage:
 * ```typescript
 * const processor = DisplayProcessor.getInstance()
 *
 * // When glasses connect
 * processor.setDeviceModel("Even Realities G1")
 *
 * // Process display events
 * const processed = processor.processDisplayEvent(rawEvent)
 * ```
 */
export class DisplayProcessor {
  private static instance: DisplayProcessor | null = null

  private measurer: TextMeasurer
  private wrapper: TextWrapper
  private helpers: DisplayHelpers
  private composer: ColumnComposer
  private profile: DisplayProfile
  private deviceModel: DeviceModel = "unknown"
  private options: DisplayProcessorOptions

  private constructor(options: DisplayProcessorOptions = {}) {
    this.options = {
      breakMode: "character-no-hyphen",
      debug: false,
      ...options,
    }

    // Initialize with default G1 profile
    const toolkit = createDisplayToolkit(G1_PROFILE, {
      breakMode: this.options.breakMode,
    })

    this.measurer = toolkit.measurer
    this.wrapper = toolkit.wrapper
    this.helpers = toolkit.helpers
    this.composer = new ColumnComposer(toolkit.profile, this.options.breakMode)
    this.profile = toolkit.profile
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(options?: DisplayProcessorOptions): DisplayProcessor {
    if (!DisplayProcessor.instance) {
      DisplayProcessor.instance = new DisplayProcessor(options)
    }
    return DisplayProcessor.instance
  }

  /**
   * Reset the singleton (useful for testing)
   */
  public static resetInstance(): void {
    DisplayProcessor.instance = null
  }

  // ===========================================================================
  // Device Profile Management
  // ===========================================================================

  /**
   * Set the device model and update the display profile accordingly.
   * Call this when glasses connect.
   *
   * @param modelName - The model name from the connected glasses (e.g., "Even Realities G1")
   */
  public setDeviceModel(modelName: string | null | undefined): void {
    const normalizedModel = normalizeModelName(modelName)

    if (normalizedModel === this.deviceModel) {
      return // No change needed
    }

    this.deviceModel = normalizedModel
    const newProfile = DEVICE_PROFILES[normalizedModel]

    if (newProfile !== this.profile) {
      this.updateProfile(newProfile)
    }

    if (this.options.debug) {
      console.log(`[DisplayProcessor] Device model set to: ${normalizedModel} (from: ${modelName})`)
    }
  }

  /**
   * Update the display profile and recreate toolkit
   */
  private updateProfile(newProfile: DisplayProfile): void {
    const toolkit = createDisplayToolkit(newProfile, {
      breakMode: this.options.breakMode,
    })

    this.measurer = toolkit.measurer
    this.wrapper = toolkit.wrapper
    this.helpers = toolkit.helpers
    this.composer = new ColumnComposer(newProfile, this.options.breakMode)
    this.profile = toolkit.profile

    if (this.options.debug) {
      console.log(`[DisplayProcessor] Profile updated to: ${newProfile.id}`)
    }
  }

  /**
   * Get the current device model
   */
  public getDeviceModel(): DeviceModel {
    return this.deviceModel
  }

  /**
   * Get the current display profile
   */
  public getProfile(): DisplayProfile {
    return this.profile
  }

  // ===========================================================================
  // Display Event Processing
  // ===========================================================================

  /**
   * Process a display event, wrapping text as needed.
   *
   * @param event - Raw display event from WebSocket
   * @returns Processed event with wrapped text
   */
  public processDisplayEvent(event: DisplayEvent): ProcessedDisplayEvent {
    // Already processed? Return as-is
    if ((event as ProcessedDisplayEvent)._processed) {
      return event as ProcessedDisplayEvent
    }

    // Get layout type from either root or nested layout object
    const layoutType = event.layoutType || event.layout?.layoutType
    const layout = event.layout || event

    if (!layoutType) {
      // No layout type - pass through
      return {
        ...event,
        _processed: true,
        _profile: this.profile.id,
      }
    }

    switch (layoutType) {
      case "text_wall":
      case "text_line":
        return this.processTextWall(event, layout)

      case "text_rows":
        return this.processTextRows(event, layout)

      case "reference_card":
        return this.processReferenceCard(event, layout)

      case "double_text_wall":
        return this.processDoubleTextWall(event, layout)

      case "bitmap_view":
        // Bitmap views don't need text processing
        return {
          ...event,
          _processed: true,
          _profile: this.profile.id,
        }

      default:
        // Unknown layout type - pass through
        if (this.options.debug) {
          console.log(`[DisplayProcessor] Unknown layout type: ${layoutType}`)
        }
        return {
          ...event,
          _processed: true,
          _profile: this.profile.id,
        }
    }
  }

  /**
   * Process text_wall or text_line layout
   */
  private processTextWall(
    event: DisplayEvent,
    layout: DisplayEvent | NonNullable<DisplayEvent["layout"]>,
  ): ProcessedDisplayEvent {
    // text_wall/text_line always have string text, not string[]
    const rawText = layout.text
    const text = typeof rawText === "string" ? rawText : ""

    // Replace placeholders BEFORE wrapping (so we measure actual content)
    const textWithPlaceholders = replacePlaceholders(text)

    // Wrap the text
    const lines = this.wrapText(textWithPlaceholders)
    const wrappedText = lines.join("\n")

    // Update both root and nested layout if present
    const processedLayout = event.layout
      ? {
          ...event.layout,
          text: wrappedText,
        }
      : undefined

    return {
      ...event,
      // Store original text with placeholders for debugging
      _originalText: text,
      text: wrappedText,
      layout: processedLayout,
      _processed: true,
      _profile: this.profile.id,
      _lines: lines,
    }
  }

  /**
   * Process text_rows layout
   */
  private processTextRows(
    event: DisplayEvent,
    layout: DisplayEvent | NonNullable<DisplayEvent["layout"]>,
  ): ProcessedDisplayEvent {
    const textField = layout.text
    const rows: string[] = Array.isArray(textField) ? textField : []

    // Replace placeholders and wrap each row
    const wrappedRows = rows.map((row: string) => {
      const rowWithPlaceholders = replacePlaceholders(row)
      const lines = this.wrapText(rowWithPlaceholders)
      return lines.join("\n")
    })

    const processedLayout = event.layout
      ? {
          ...event.layout,
          text: wrappedRows as string | string[],
        }
      : undefined

    return {
      ...event,
      text: wrappedRows as string | string[],
      layout: processedLayout,
      _processed: true,
      _profile: this.profile.id,
    }
  }

  /**
   * Process reference_card layout
   */
  private processReferenceCard(
    event: DisplayEvent,
    layout: DisplayEvent | NonNullable<DisplayEvent["layout"]>,
  ): ProcessedDisplayEvent {
    const title = layout.title || ""
    // reference_card text is always string, not string[]
    const rawText = layout.text
    const text = typeof rawText === "string" ? rawText : ""

    // Replace placeholders BEFORE wrapping
    const titleWithPlaceholders = replacePlaceholders(title)
    const textWithPlaceholders = replacePlaceholders(text)

    // Wrap title and text separately
    // Title typically gets 1 line, text gets remaining lines
    const wrappedTitle = this.wrapText(titleWithPlaceholders, {maxLines: 1})
    const wrappedText = this.wrapText(textWithPlaceholders, {maxLines: this.profile.maxLines - 1})

    const processedLayout = event.layout
      ? {
          ...event.layout,
          title: wrappedTitle.join("\n"),
          text: wrappedText.join("\n"),
        }
      : undefined

    return {
      ...event,
      title: wrappedTitle.join("\n"),
      text: wrappedText.join("\n"),
      layout: processedLayout,
      _processed: true,
      _profile: this.profile.id,
    }
  }

  /**
   * Process double_text_wall layout
   *
   * Uses ColumnComposer to create a fully composed string with both columns
   * merged line-by-line with pixel-precise space alignment. This is the single
   * source of truth for double_text_wall composition, replacing duplicate
   * implementations in native iOS (G1Text.swift) and Android (G1Text.kt).
   *
   * The composed text is sent to native as a regular text_wall - native just
   * chunks and sends it without any re-wrapping or column composition.
   */
  private processDoubleTextWall(
    event: DisplayEvent,
    layout: DisplayEvent | NonNullable<DisplayEvent["layout"]>,
  ): ProcessedDisplayEvent {
    const leftText = layout.topText || ""
    const rightText = layout.bottomText || ""

    // Replace placeholders BEFORE composition (so we measure actual content)
    const leftTextWithPlaceholders = replacePlaceholders(leftText)
    const rightTextWithPlaceholders = replacePlaceholders(rightText)

    // Use ColumnComposer for pixel-precise column composition
    const result = this.composer.composeDoubleTextWall(leftTextWithPlaceholders, rightTextWithPlaceholders)

    if (this.options.debug) {
      console.log(`[DisplayProcessor] double_text_wall composed:`)
      console.log(`  Left lines: ${result.leftLines.length}`)
      console.log(`  Right lines: ${result.rightLines.length}`)
      console.log(`  Config: ${JSON.stringify(result.config)}`)
    }

    // The composed text is a single string with both columns merged
    // Native will receive this as a text_wall and just chunk & send it
    const processedLayout = event.layout
      ? {
          ...event.layout,
          // Keep original topText/bottomText for reference but add composed text
          topText: leftTextWithPlaceholders,
          bottomText: rightTextWithPlaceholders,
          // The composed text is what native should actually display
          _composedText: result.composedText,
        }
      : undefined

    return {
      ...event,
      // Override the layout type to text_wall since we've pre-composed the columns
      // This tells native to use sendTextWall instead of sendDoubleTextWall
      layoutType: "text_wall" as DisplayLayoutType,
      text: result.composedText,
      // Keep original values for debugging/preview (with placeholders replaced)
      topText: leftTextWithPlaceholders,
      bottomText: rightTextWithPlaceholders,
      // Store original values with placeholders for debugging
      _originalTopText: leftText,
      _originalBottomText: rightText,
      layout: processedLayout
        ? {
            ...processedLayout,
            layoutType: "text_wall" as DisplayLayoutType,
            text: result.composedText,
          }
        : undefined,
      _processed: true,
      _profile: this.profile.id,
      _originalLayoutType: "double_text_wall",
      _composedColumns: {
        leftLines: result.leftLines,
        rightLines: result.rightLines,
        config: result.config,
      },
    }
  }

  // ===========================================================================
  // Text Wrapping Utilities
  // ===========================================================================

  /**
   * Wrap text using the current profile
   *
   * @param text - Text to wrap
   * @param options - Optional override options
   * @returns Array of wrapped lines
   */
  public wrapText(text: string, options?: WrapOptions): string[] {
    if (!text) return [""]

    const result = this.wrapper.wrap(text, options)
    return result.lines
  }

  /**
   * Measure the pixel width of text
   *
   * @param text - Text to measure
   * @returns Width in pixels
   */
  public measureText(text: string): number {
    return this.measurer.measureText(text)
  }

  /**
   * Check if text fits on a single line
   *
   * @param text - Text to check
   * @returns true if text fits without wrapping
   */
  public fitsOnSingleLine(text: string): boolean {
    return this.measurer.measureText(text) <= this.profile.displayWidthPx
  }

  /**
   * Get the display width in pixels
   */
  public getDisplayWidth(): number {
    return this.profile.displayWidthPx
  }

  /**
   * Get the maximum number of lines
   */
  public getMaxLines(): number {
    return this.profile.maxLines
  }

  /**
   * Get detailed text measurement
   */
  public measureTextDetailed(text: string) {
    return this.measurer.measureTextDetailed(text)
  }

  // ===========================================================================
  // Break Mode Control
  // ===========================================================================

  /**
   * Set the break mode for text wrapping
   *
   * @param breakMode - 'character' | 'word' | 'strict-word'
   */
  public setBreakMode(breakMode: BreakMode): void {
    if (this.options.breakMode === breakMode) return

    this.options.breakMode = breakMode
    this.updateProfile(this.profile) // Recreate wrapper with new break mode

    if (this.options.debug) {
      console.log(`[DisplayProcessor] Break mode set to: ${breakMode}`)
    }
  }

  /**
   * Get the current break mode
   */
  public getBreakMode(): BreakMode {
    return this.options.breakMode || "character"
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

/**
 * Default DisplayProcessor instance
 */
export const displayProcessor = DisplayProcessor.getInstance()

export default displayProcessor
