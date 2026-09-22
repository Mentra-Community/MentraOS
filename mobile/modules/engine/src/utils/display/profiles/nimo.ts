import type {DisplayProfile} from "./types"

/**
 * NIMO Dynamic Layout V1, logical canvas (not the physical framebuffer).
 *
 * Native uses font_size=0 (16 px). ASCII 8 px and CJK 16 px advances with
 * 20 px line spacing were checked against repeated panel-memory captures on
 * dynamic-v1 firmware 537cf1. Other script widths remain conservative estimates;
 * this is not a claim of glyph coverage for every language.
 */
export const NIMO_PROFILE: DisplayProfile = {
  id: "nimo",
  name: "NIMO",
  displayWidthPx: 500,
  displayHeightPx: 220,
  maxLines: 11,
  lineHeightPx: 20,

  // Mirrors Dynamic V1 object and reassembly limits. Image admission reserves
  // worst-case RLE size; native may compress further but cannot exceed this bound.
  sceneBudget: {
    maxObjects: 64,
    maxTextBytes: 8192,
    maxImagePixels: 110000,
    maxEncodedBytes: 12288 - 8,
    frameOverheadBytes: 3,
    textLineOverheadBytes: 17,
    rectBytes: 15,
    image: {bitsPerPixel: 2, overheadBytes: 32, maxLiteralRunBytes: 127},
  },

  // Per-wrap ceiling; scene processing also enforces the cumulative budget.
  maxPayloadBytes: 8192,
  // Helper default only; the native transport uses the negotiated write size.
  bleChunkSize: 244,

  fontMetrics: {
    glyphWidths: new Map(
      Array.from({length: 95}, (_, index): [string, number] => [String.fromCharCode(0x20 + index), 8]),
    ),
    defaultGlyphWidth: 16,
    renderFormula: (glyphWidth: number) => glyphWidth,
    uniformScripts: {
      cjk: 16,
      hiragana: 16,
      katakana: 16,
      korean: 16,
      cyrillic: 16,
    },
    fallback: {
      latinMaxWidth: 16,
      unknownBehavior: "useLatinMax",
    },
  },
}
