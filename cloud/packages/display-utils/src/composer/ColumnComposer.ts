/**
 * ColumnComposer
 *
 * Handles composition of multi-column layouts like double_text_wall.
 * This is the single source of truth for column layout logic, replacing
 * the duplicate implementations in native iOS (G1Text.swift) and
 * Android (G1Text.kt, G1.java).
 *
 * The composer:
 * 1. Wraps each column's text to its allocated width
 * 2. Merges columns line-by-line with pixel-precise space padding
 * 3. Returns a single pre-composed string ready for native to chunk & send
 *
 * @see cloud/issues/026-mobile-display-processor for design docs
 */

import type { DisplayProfile } from "../profiles/types";
import { TextMeasurer } from "../measurer/TextMeasurer";
import { TextWrapper } from "../wrapper/TextWrapper";
import type { WrapOptions, BreakMode } from "../wrapper/types";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for column layout
 */
export interface ColumnConfig {
  /** Width of the left column in pixels */
  leftColumnWidthPx: number;
  /** X position where the right column starts in pixels */
  rightColumnStartPx: number;
  /** Width of the right column in pixels (calculated from start position) */
  rightColumnWidthPx: number;
  /** Maximum number of lines to display */
  maxLines: number;
  /** Left margin in spaces (for indentation) */
  leftMarginSpaces?: number;
}

/**
 * Options for composing double text wall
 */
export interface ComposeOptions {
  /** Break mode for text wrapping */
  breakMode?: BreakMode;
  /** Custom column configuration (overrides profile defaults) */
  columnConfig?: Partial<ColumnConfig>;
}

/**
 * Result of column composition
 */
export interface ComposeResult {
  /** The fully composed text with both columns merged */
  composedText: string;
  /** Lines from the left column (for debugging/preview) */
  leftLines: string[];
  /** Lines from the right column (for debugging/preview) */
  rightLines: string[];
  /** The column configuration that was used */
  config: ColumnConfig;
}

// =============================================================================
// ColumnComposer Class
// =============================================================================

/**
 * Composes multi-column layouts for smart glasses displays.
 *
 * Usage:
 * ```typescript
 * const composer = new ColumnComposer(G1_PROFILE)
 * const result = composer.composeDoubleTextWall("Left content", "Right content")
 * // result.composedText is ready to send to native SGC
 * ```
 */
export class ColumnComposer {
  private profile: DisplayProfile;
  private measurer: TextMeasurer;
  private wrapper: TextWrapper;
  private spaceWidthPx: number;

  constructor(profile: DisplayProfile, breakMode: BreakMode = "character-no-hyphen") {
    this.profile = profile;
    this.measurer = new TextMeasurer(profile);
    this.wrapper = new TextWrapper(this.measurer, {
      breakMode,
    });

    // Cache space width for alignment calculations
    this.spaceWidthPx = this.measurer.measureText(" ");
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Compose a double text wall layout.
   *
   * Takes left and right text, wraps each to their column width,
   * and merges them with pixel-precise space alignment.
   *
   * @param leftText - Text for the left column
   * @param rightText - Text for the right column
   * @param options - Optional composition settings
   * @returns Composed result with merged text and metadata
   */
  public composeDoubleTextWall(leftText: string, rightText: string, options: ComposeOptions = {}): ComposeResult {
    const config = this.getColumnConfig(options.columnConfig);

    // Wrap each column independently
    const leftWrapOptions: WrapOptions = {
      maxWidthPx: config.leftColumnWidthPx,
      maxLines: config.maxLines,
    };

    const rightWrapOptions: WrapOptions = {
      maxWidthPx: config.rightColumnWidthPx,
      maxLines: config.maxLines,
    };

    const leftResult = this.wrapper.wrap(leftText || "", leftWrapOptions);
    const rightResult = this.wrapper.wrap(rightText || "", rightWrapOptions);

    // Pad arrays to have exactly maxLines entries
    const leftLines = this.padLines(leftResult.lines, config.maxLines);
    const rightLines = this.padLines(rightResult.lines, config.maxLines);

    // Merge columns with space alignment
    const composedText = this.mergeColumns(leftLines, rightLines, config);

    return {
      composedText,
      leftLines,
      rightLines,
      config,
    };
  }

  /**
   * Get the default column configuration for the current profile.
   */
  public getDefaultColumnConfig(): ColumnConfig {
    return this.getColumnConfig();
  }

  /**
   * Update the break mode for text wrapping.
   */
  public setBreakMode(breakMode: BreakMode): void {
    this.wrapper = new TextWrapper(this.measurer, {
      breakMode,
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Get column configuration, merging defaults with overrides.
   */
  private getColumnConfig(overrides?: Partial<ColumnConfig>): ColumnConfig {
    const displayWidth = this.profile.displayWidthPx;

    // Default layout: 50% for left column, right starts at 55%
    // This matches the native G1Text implementations
    const defaults: ColumnConfig = {
      leftColumnWidthPx: Math.floor(displayWidth * 0.5),
      rightColumnStartPx: Math.floor(displayWidth * 0.55),
      rightColumnWidthPx: displayWidth - Math.floor(displayWidth * 0.55),
      maxLines: this.profile.maxLines,
      leftMarginSpaces: 0,
    };

    return {
      ...defaults,
      ...overrides,
    };
  }

  /**
   * Pad lines array to exactly `count` entries.
   */
  private padLines(lines: string[], count: number): string[] {
    const result = [...lines];
    while (result.length < count) {
      result.push("");
    }
    return result.slice(0, count);
  }

  /**
   * Merge left and right columns with pixel-precise space alignment.
   *
   * For each line:
   * 1. Take the left column text
   * 2. Calculate its pixel width
   * 3. Calculate how many spaces needed to reach rightColumnStartPx
   * 4. Append spaces and right column text
   */
  private mergeColumns(leftLines: string[], rightLines: string[], config: ColumnConfig): string {
    const lines: string[] = [];

    for (let i = 0; i < config.maxLines; i++) {
      const leftText = this.cleanEnspaces(leftLines[i] || "");
      const rightText = this.cleanEnspaces(rightLines[i] || "");

      // Calculate pixel width of left text
      const leftWidthPx = this.measurer.measureText(leftText);

      // Calculate spaces needed to reach the right column start
      const spacesNeeded = this.calculateSpacesForAlignment(leftWidthPx, config.rightColumnStartPx);

      // Build the merged line
      let line = "";

      // Add left margin if configured
      if (config.leftMarginSpaces && config.leftMarginSpaces > 0) {
        line += " ".repeat(config.leftMarginSpaces);
      }

      line += leftText;
      line += " ".repeat(spacesNeeded);
      line += rightText;

      lines.push(line);
    }

    return lines.join("\n");
  }

  /**
   * Calculate the number of spaces needed to align to a target position.
   *
   * @param currentWidthPx - Current position in pixels
   * @param targetPositionPx - Target position in pixels
   * @returns Number of space characters needed
   */
  private calculateSpacesForAlignment(currentWidthPx: number, targetPositionPx: number): number {
    const pixelsNeeded = targetPositionPx - currentWidthPx;

    // Ensure at least one space for separation
    if (pixelsNeeded <= 0) {
      return 1;
    }

    // Calculate spaces needed (round up to ensure we reach the target)
    const spaces = Math.ceil(pixelsNeeded / this.spaceWidthPx);

    // Cap at a reasonable maximum to prevent runaway spacing
    return Math.min(spaces, 100);
  }

  /**
   * Remove en-space characters (U+2002) that may have been added during wrapping.
   * Native implementations do this cleanup before merging.
   */
  private cleanEnspaces(text: string): string {
    return text.replace(/\u2002/g, "");
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a ColumnComposer for a given profile.
 *
 * @param profile - Display profile to use
 * @param breakMode - Break mode for text wrapping (default: "word")
 * @returns Configured ColumnComposer instance
 */
export function createColumnComposer(profile: DisplayProfile, breakMode: BreakMode = "word"): ColumnComposer {
  return new ColumnComposer(profile, breakMode);
}
