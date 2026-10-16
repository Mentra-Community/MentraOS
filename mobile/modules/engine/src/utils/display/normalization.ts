import {G1_LATIN_GLYPH_WIDTHS} from "./profiles/g1LatinGlyphs"
import type {DisplayProfile} from "./profiles/types"

// Mirrors the native fallback for unmapped G1 Latin glyphs and all NIMO Latin text.
const LATIN_REPLACEMENTS: Record<string, string> = {
  Đ: "D",
  Ð: "D",
  đ: "d",
  ð: "d",
  Ł: "L",
  ł: "l",
  Ø: "O",
  ø: "o",
  Æ: "AE",
  æ: "ae",
  Œ: "OE",
  œ: "oe",
  ẞ: "SS",
  ß: "ss",
  Þ: "TH",
  þ: "th",
}

export function normalizeNimoDisplayText(text: string): string {
  return text
    .replace(/[ĐÐđðŁłØøÆæŒœẞßÞþ]/g, (character) => LATIN_REPLACEMENTS[character])
    .replace(/\p{Script=Latin}\p{M}*/gu, (cluster) => cluster.normalize("NFD").replace(/\p{M}+/gu, ""))
    .replace(/—/g, "-")
}

/** Preserve firmware-mapped G1 Latin clusters before measuring or encoding text. */
export function normalizeG1DisplayText(text: string): string {
  return text.replace(/\p{Script=Latin}\p{M}*/gu, (cluster) => {
    const composed = cluster.normalize("NFC")
    if (
      composed.length === 1 &&
      (composed.charCodeAt(0) <= 0x7e || Object.prototype.hasOwnProperty.call(G1_LATIN_GLYPH_WIDTHS, composed))
    ) {
      return composed
    }
    return normalizeNimoDisplayText(cluster)
  })
}

/** Keep feedback offsets in the miniapp's original UTF-16 source after glyph substitutions. */
export function normalizeTextWithSource(text: string, profile: DisplayProfile) {
  if (!profile.normalizeText) return {text, sourceRange: (start: number, end: number) => ({start, end})}

  let normalized = ""
  const starts: number[] = []
  const ends: number[] = []
  // Include combining marks with their base so a removed accent remains inside its source range.
  for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const replacement = profile.normalizeText(match[0])
    normalized += replacement
    for (let i = 0; i < replacement.length; i++) {
      starts.push(match.index)
      ends.push(match.index + match[0].length)
    }
  }
  return {
    text: normalized,
    sourceRange: (start: number, end: number) => ({
      start: starts[start] ?? text.length,
      end: end > start ? ends[end - 1] : (starts[start] ?? text.length),
    }),
  }
}
