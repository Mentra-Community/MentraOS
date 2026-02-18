/**
 * Display Utils
 *
 * Glasses-agnostic, pixel-accurate text measurement and wrapping library
 * for smart glasses displays.
 *
 * This module re-exports from the shared @mentra/display-utils package.
 *
 * @example
 * ```typescript
 * import {
 *   TextMeasurer,
 *   TextWrapper,
 *   DisplayHelpers,
 *   ScrollView,
 *   G1_PROFILE,
 *   createG1Toolkit
 * } from '@mentra/sdk/display-utils'
 *
 * // Quick start
 * const { wrapper } = createG1Toolkit()
 * const result = wrapper.wrap("Your text here")
 *
 * // Scrollable content
 * const scrollView = new ScrollView(measurer, wrapper)
 * scrollView.setContent("Very long text...")
 * scrollView.scrollDown()
 * const viewport = scrollView.getViewport()
 * ```
 */

// Re-export everything from the shared package
export * from "@mentra/display-utils"
