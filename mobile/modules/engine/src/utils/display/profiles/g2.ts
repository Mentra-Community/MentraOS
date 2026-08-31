import {DisplayProfile} from "./types"

/**
 * Even Realities G2 Smart Glasses Display Profile
 *
 * G2 uses the same display hardware as G1 (green monochrome, ~640x200).
 * Glyph widths and rendering formula are identical to G1.
 * The protocol differs (EvenHub protobuf vs G1 binary) but display
 * characteristics are the same.
 */

// G2 uses the same glyph widths as G1 (same display hardware/font)
import {G1_PROFILE} from "./g1"

/**
 * Measured Cyrillic advance widths for the G2 firmware font, in RENDERED px.
 *
 * The G2 firmware renders Cyrillic proportionally — the uniform 18px
 * inherited from the G1 profile was never measured on G2 and costs Russian
 * text ~40% of line capacity (32 chars per 576px line instead of the ~51 the
 * firmware actually fits). Measured via the official EvenHub simulator's
 * automation port (/api/screenshot/glasses): render a glyph 8× and 16×,
 * subtract the widths to cancel container padding, divide by 8. Field-checked
 * on physical G2 glasses: predicted wrap points match the display exactly.
 *
 * Values are stored as raw glyph units (renderFormula: (g + 1) * 2), so odd
 * rendered widths use half-unit raw values — the formula round-trips exactly.
 */
const G2_CYRILLIC_RENDERED_PX: Record<string, number> = {
  "а": 12, "б": 12, "в": 12, "г": 9, "д": 12, "е": 11, "ё": 11, "ж": 13, "з": 11, "и": 12, "й": 12,
  "к": 10, "л": 12, "м": 14, "н": 12, "о": 11, "п": 11, "р": 12, "с": 11, "т": 11, "у": 11, "ф": 13,
  "х": 11, "ц": 12, "ч": 12, "ш": 14, "щ": 15, "ъ": 13, "ы": 14, "ь": 12, "э": 11, "ю": 14, "я": 11,
  "А": 13, "Б": 13, "В": 13, "Г": 10, "Д": 15, "Е": 12, "Ё": 12, "Ж": 17, "З": 12, "И": 14, "Й": 14,
  "К": 13, "Л": 14, "М": 16, "Н": 13, "О": 14, "П": 13, "Р": 13, "С": 13, "Т": 12, "У": 13, "Ф": 16,
  "Х": 13, "Ц": 13, "Ч": 12, "Ш": 16, "Щ": 17, "Ъ": 15, "Ы": 16, "Ь": 13, "Э": 13, "Ю": 17, "Я": 13,
}

export const G2_PROFILE: DisplayProfile = {
  ...G1_PROFILE,
  id: "even-realities-g2",
  name: "Even Realities G2",
  // G2 fits more vertical text than G1 — allow up to 8 lines before the
  // wrapper truncates (G1 stays at its inherited 5).
  maxLines: 8,
  // Hardware-calibrated 2026-07-03: a 28px container overflowed one line of
  // the firmware font (triggering the fw's overflow indicator tick); 40px is
  // clean. With this set, the scene pipeline height-clips text so a box is
  // never handed more lines than fit.
  lineHeightPx: 40,
  fontMetrics: {
    ...G1_PROFILE.fontMetrics,
    // Glyph map takes priority over uniformScripts in TextMeasurer, so the
    // measured Cyrillic table overrides the uniform width for G2 only —
    // G1 keeps its verified uniform 18px untouched.
    glyphWidths: new Map<string, number>([
      ...G1_PROFILE.fontMetrics.glyphWidths,
      ...Object.entries(G2_CYRILLIC_RENDERED_PX).map(
        ([char, renderedPx]) => [char, renderedPx / 2 - 1] as [string, number],
      ),
    ]),
  },
}

/**
 * Get the hyphen width for G2 in rendered pixels.
 * Same as G1: Hyphen glyph = 4px → rendered = (4+1)*2 = 10px
 */
export const G2_HYPHEN_WIDTH_PX = 10

/**
 * Get the space width for G2 in rendered pixels.
 * Same as G1: Space glyph = 2px → rendered = (2+1)*2 = 6px
 */
export const G2_SPACE_WIDTH_PX = 6
