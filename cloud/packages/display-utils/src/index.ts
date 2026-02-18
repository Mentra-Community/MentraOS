/**
 * @mentra/display-utils
 *
 * Glasses-agnostic, pixel-accurate text measurement and wrapping library
 * for smart glasses displays.
 *
 * Key features:
 * - Pixel-perfect measurement (no abstract units or averages)
 * - Multiple break modes (character, word, strict-word)
 * - Full script support (Latin, CJK, Korean, Cyrillic)
 * - Configurable display profiles for different glasses hardware
 *
 * @example
 * ```typescript
 * import {
 *   TextMeasurer,
 *   TextWrapper,
 *   DisplayHelpers,
 *   G1_PROFILE
 * } from '@mentra/display-utils'
 *
 * // Create measurer and wrapper for G1 glasses
 * const measurer = new TextMeasurer(G1_PROFILE)
 * const wrapper = new TextWrapper(measurer, { breakMode: 'character' })
 * const helpers = new DisplayHelpers(measurer, wrapper)
 *
 * // Wrap text for display
 * const result = wrapper.wrap("Hello, world! This is a long text.")
 * console.log(result.lines)
 * // ["Hello, world! This is a long text th-", "at needs wrapping."]
 * ```
 */

// =============================================================================
// Profiles - Hardware configurations for different glasses
// =============================================================================

export type {
  DisplayProfile,
  FontMetrics,
  UniformScriptWidths,
  FallbackConfig,
  DisplayConstraints,
  ScriptType,
} from "./profiles";

export { G1_PROFILE, G1_PROFILE_LEGACY, G1_HYPHEN_WIDTH_PX, G1_SPACE_WIDTH_PX } from "./profiles";

// Z100 Profile
export { Z100_PROFILE, Z100_HYPHEN_WIDTH_PX, Z100_SPACE_WIDTH_PX } from "./profiles";

// Mentra Nex Profile (a.k.a. Mentra Display)
export { NEX_PROFILE, NEX_HYPHEN_WIDTH_PX, NEX_SPACE_WIDTH_PX } from "./profiles";

// Import for factory functions
import { G1_PROFILE_LEGACY, Z100_PROFILE, NEX_PROFILE } from "./profiles";

// =============================================================================
// Measurer - Pixel-accurate text measurement
// =============================================================================

export { TextMeasurer } from "./measurer";
export type { CharMeasurement, TextMeasurement } from "./measurer";

// Script detection utilities
export {
  detectScript,
  isCJKCharacter,
  isKoreanCharacter,
  isUniformWidthScript,
  isUnsupportedScript,
  needsHyphenForBreak,
  SCRIPT_RANGES,
} from "./measurer";

// =============================================================================
// Wrapper - Text wrapping with multiple break modes
// =============================================================================

export { TextWrapper } from "./wrapper";
export type { WrapOptions, WrapResult, LineMetrics, BreakMode } from "./wrapper";
export { DEFAULT_WRAP_OPTIONS } from "./wrapper";

// =============================================================================
// Helpers - Optional convenience utilities
// =============================================================================

export { DisplayHelpers, ScrollView } from "./helpers";
export type { TruncateResult, Page, Chunk, ScrollPosition, ScrollViewport } from "./helpers";

// =============================================================================
// Composer - Multi-column layout composition
// =============================================================================

export { ColumnComposer, createColumnComposer } from "./composer";
export type { ColumnConfig, ComposeOptions, ComposeResult } from "./composer";

// =============================================================================
// Convenience factory functions
// =============================================================================

import { TextMeasurer } from "./measurer";
import { TextWrapper } from "./wrapper";
import { DisplayHelpers } from "./helpers";
import { ColumnComposer } from "./composer";
import { G1_PROFILE } from "./profiles";
import type { DisplayProfile } from "./profiles";
import type { WrapOptions } from "./wrapper";

/**
 * Create a complete display toolkit for a given profile.
 *
 * @param profile - Display profile (defaults to G1)
 * @param wrapOptions - Default wrap options
 * @returns Object with measurer, wrapper, and helpers
 *
 * @example
 * ```typescript
 * const { measurer, wrapper, helpers } = createDisplayToolkit()
 * const lines = wrapper.wrapToLines("Hello, world!")
 * ```
 */
export function createDisplayToolkit(
  profile: DisplayProfile = G1_PROFILE,
  wrapOptions?: WrapOptions,
): {
  measurer: TextMeasurer;
  wrapper: TextWrapper;
  helpers: DisplayHelpers;
  composer: ColumnComposer;
  profile: DisplayProfile;
} {
  const measurer = new TextMeasurer(profile);
  const wrapper = new TextWrapper(measurer, wrapOptions);
  const helpers = new DisplayHelpers(measurer, wrapper);
  const composer = new ColumnComposer(profile, wrapOptions?.breakMode || "word");

  return {
    measurer,
    wrapper,
    helpers,
    composer,
    profile,
  };
}

/**
 * Create a G1-configured display toolkit with character breaking.
 * This is the recommended setup for captions and similar high-utilization use cases.
 *
 * @returns Object with measurer, wrapper, and helpers configured for G1
 *
 * @example
 * ```typescript
 * const { wrapper, composer } = createG1Toolkit()
 * const result = wrapper.wrap("Your text here")
 * const columns = composer.composeDoubleTextWall("Left", "Right")
 * ```
 */
export function createG1Toolkit(): {
  measurer: TextMeasurer;
  wrapper: TextWrapper;
  helpers: DisplayHelpers;
  composer: ColumnComposer;
  profile: DisplayProfile;
} {
  return createDisplayToolkit(G1_PROFILE, {
    breakMode: "character-no-hyphen",
  });
}

/**
 * Create a G1-configured display toolkit for LEGACY mobile clients.
 *
 * Use this when the mobile client has old wrapping logic that re-wraps
 * text received from the cloud. This profile uses a reduced display width
 * (~522px instead of 576px) to prevent double-wrapping overflow.
 *
 * @returns Object with measurer, wrapper, and helpers configured for legacy G1 clients
 *
 * @example
 * ```typescript
 * // For old mobile clients that double-wrap
 * const { wrapper } = createG1LegacyToolkit()
 * const result = wrapper.wrap("Your text here")
 * // Lines will be shorter to account for mobile re-wrapping
 * ```
 */
export function createG1LegacyToolkit(): {
  measurer: TextMeasurer;
  wrapper: TextWrapper;
  helpers: DisplayHelpers;
  composer: ColumnComposer;
  profile: DisplayProfile;
} {
  return createDisplayToolkit(G1_PROFILE_LEGACY, {
    breakMode: "character-no-hyphen",
  });
}

/**
 * Create a Z100-configured display toolkit with character breaking.
 *
 * @returns Object with measurer, wrapper, and helpers configured for Vuzix Z100
 *
 * @example
 * ```typescript
 * const { wrapper } = createZ100Toolkit()
 * const result = wrapper.wrap("Your text here")
 * ```
 */
export function createZ100Toolkit(): {
  measurer: TextMeasurer;
  wrapper: TextWrapper;
  helpers: DisplayHelpers;
  composer: ColumnComposer;
  profile: DisplayProfile;
} {
  return createDisplayToolkit(Z100_PROFILE, {
    breakMode: "character-no-hyphen",
  });
}

/**
 * Create a Mentra Nex-configured display toolkit with character breaking.
 * Also known as "Mentra Display".
 *
 * @returns Object with measurer, wrapper, and helpers configured for Mentra Nex
 *
 * @example
 * ```typescript
 * const { wrapper } = createNexToolkit()
 * const result = wrapper.wrap("Your text here")
 * ```
 */
export function createNexToolkit(): {
  measurer: TextMeasurer;
  wrapper: TextWrapper;
  helpers: DisplayHelpers;
  composer: ColumnComposer;
  profile: DisplayProfile;
} {
  return createDisplayToolkit(NEX_PROFILE, {
    breakMode: "character-no-hyphen",
  });
}
