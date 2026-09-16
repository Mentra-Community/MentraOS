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

  // This is a per-wrap ceiling. Native additionally validates aggregate text
  // and encoded frame budgets before transmission (multiple labels share it).
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
