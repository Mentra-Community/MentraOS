/**
 * Text Wrapper Module
 *
 * Provides text wrapping with multiple break modes:
 * - 'character': Break mid-word with hyphen for 100% line utilization
 * - 'word': Break at word boundaries, hyphenate only if word > line width
 * - 'strict-word': Break at word boundaries only, no hyphenation
 */

// Main class
export { TextWrapper } from "./TextWrapper"

// Types
export type { WrapOptions, WrapResult, LineMetrics, BreakMode } from "./types"
export { DEFAULT_WRAP_OPTIONS } from "./types"
