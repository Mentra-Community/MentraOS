import {VisualWidthSettings, getVisualWidthForSetting} from "./visualWidth"

/**
 * Converts a line width setting to visual width units
 *
 * Visual width units are based on character widths:
 * - Latin characters (a-z, A-Z, 0-9): 1.0 unit
 * - CJK characters (Chinese, Japanese, Korean): 2.0 units
 *
 * This means:
 * - "wide" (44 units) fits ~44 Latin chars OR ~22 CJK chars OR a mix
 * - The TranscriptProcessor calculates the actual fit based on content
 *
 * Supports two input formats:
 * 1. Numeric enum values: 0=Narrow, 1=Medium, 2=Wide
 * 2. String values: "narrow", "medium", "wide"
 *
 * @param width The width setting as a string or number
 * @param _isHanzi Deprecated - no longer used, kept for backwards compatibility
 * @returns Visual width in units (not character count)
 */
export function convertLineWidth(width: string | number, _isHanzi?: boolean): number {
  // Use the visual width utilities for consistent handling
  return getVisualWidthForSetting(width)
}

// Re-export the visual width settings for convenience
export {VisualWidthSettings}
