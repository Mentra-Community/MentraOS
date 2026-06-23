/**
 * ScriptEngine — the layout + voice-following brain of the teleprompter.
 *
 * Given the script text and a glasses display profile, it:
 *   1. Wraps the whole script into pixel-accurate display lines (TextWrapper).
 *   2. Builds a normalized word list and a word→line index so a "reading
 *      cursor" (which word is being read) maps to a scroll position.
 *   3. Renders the visible window of N lines for any cursor position.
 *   4. Follows the speaker's voice: given recently-spoken words, it anchors
 *      them against the upcoming script and advances the cursor — robust to
 *      skips, filler words, and transcription noise.
 *
 * It owns no timers, no display calls, and no I/O — it's a pure function of
 * (script, layout, cursor) so the controller can drive it from either a WPM
 * timer or live transcription and stay easy to reason about.
 */

import {TextMeasurer} from "../../vendor/display-utils/measurer"
import {TextWrapper} from "../../vendor/display-utils/wrapper"
import {G1_PROFILE, NEX_PROFILE, Z100_PROFILE} from "../../vendor/display-utils/profiles"
import type {DisplayProfile} from "../../vendor/display-utils/profiles"
import type {LineWidth} from "../../shared/types"

export interface LayoutConfig {
  profile: DisplayProfile
  /** 0 = Narrow, 1 = Medium, 2 = Wide. */
  widthSetting: LineWidth
  /** Lines shown on the glasses at once (clamped to 2..profile.maxLines). */
  numberOfLines: number
}

export {G1_PROFILE, Z100_PROFILE, NEX_PROFILE}
export type {DisplayProfile}

/** Map the line-width setting to a fraction of the profile's usable width. */
function widthFraction(setting: LineWidth): number {
  switch (setting) {
    case 0:
      return 0.7
    case 1:
      return 0.85
    case 2:
    default:
      return 1.0
  }
}

/** Lowercase + strip everything but letters/digits. "" for punctuation-only. */
export function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

/** Split arbitrary spoken/script text into normalized, non-empty word tokens. */
export function normalizeWords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\s+/)) {
    const n = normalizeWord(raw)
    if (n) out.push(n)
  }
  return out
}

export class ScriptEngine {
  private profile: DisplayProfile
  private widthSetting: LineWidth
  private numberOfLines: number

  private measurer: TextMeasurer
  private wrapper: TextWrapper

  private text = ""
  private allLines: string[] = []
  /** Parallel arrays: for each readable word, its normalized form + line index. */
  private wordNorms: string[] = []
  private wordLines: number[] = []

  constructor(config: LayoutConfig) {
    this.profile = config.profile
    this.widthSetting = config.widthSetting
    this.numberOfLines = this.clampLines(config.numberOfLines)
    this.measurer = new TextMeasurer(this.profile)
    this.wrapper = new TextWrapper(this.measurer)
    this.rewrap()
  }

  // ── Configuration ────────────────────────────────────────────────────────

  setScript(text: string): void {
    this.text = text ?? ""
    this.rewrap()
  }

  /** Update layout in place (profile / width / line-count) and re-wrap. */
  setLayout(partial: Partial<LayoutConfig>): void {
    if (partial.profile && partial.profile.id !== this.profile.id) {
      this.profile = partial.profile
      this.measurer = new TextMeasurer(this.profile)
      this.wrapper = new TextWrapper(this.measurer)
    }
    if (partial.widthSetting !== undefined) this.widthSetting = partial.widthSetting
    if (partial.numberOfLines !== undefined) this.numberOfLines = this.clampLines(partial.numberOfLines)
    this.rewrap()
  }

  get viewportLines(): number {
    return this.numberOfLines
  }

  get totalWords(): number {
    return this.wordNorms.length
  }

  get totalLines(): number {
    return this.allLines.length
  }

  get maxTopLine(): number {
    return Math.max(0, this.allLines.length - this.numberOfLines)
  }

  // ── Cursor ↔ layout mapping ────────────────────────────────────────────────

  /** Line index that contains the word at `wordIndex`. */
  lineForWord(wordIndex: number): number {
    if (this.wordLines.length === 0) return 0
    const i = Math.max(0, Math.min(wordIndex, this.wordLines.length - 1))
    return this.wordLines[i]
  }

  /**
   * Top line to show so the word being read sits at the top of the viewport —
   * except on the final page, which stays pinned so we never show blank rows
   * mid-script.
   */
  topLineForWord(wordIndex: number): number {
    return Math.min(this.lineForWord(wordIndex), this.maxTopLine)
  }

  /** Cursor (word index) of the first readable word on or after `line`. */
  firstWordOfLine(line: number): number {
    for (let i = 0; i < this.wordLines.length; i++) {
      if (this.wordLines[i] >= line) return i
    }
    return this.totalWords
  }

  /** The exact lines to render for a given top line, padded to the viewport. */
  windowAt(topLine: number): string[] {
    const top = Math.max(0, Math.min(topLine, this.maxTopLine))
    const out = this.allLines.slice(top, top + this.numberOfLines)
    while (out.length < this.numberOfLines) out.push("")
    return out
  }

  /** Convert a 0–100 scrub fraction to a word cursor. */
  wordForPercent(percent: number): number {
    if (this.totalWords === 0) return 0
    const p = Math.max(0, Math.min(100, percent)) / 100
    return Math.round(p * this.totalWords)
  }

  /** Read progress (0–100) for a cursor. */
  progressForWord(wordIndex: number): number {
    if (this.totalWords === 0) return 0
    return Math.max(0, Math.min(100, Math.round((wordIndex / this.totalWords) * 100)))
  }

  // ── Voice following ────────────────────────────────────────────────────────

  /**
   * Anchor recently-spoken words against the upcoming script and return the
   * new cursor. Forward-only: speech never scrolls the prompter backwards.
   *
   * `probe` is the tail of what the speaker just said (already normalized).
   * We look for the position whose preceding words best match the probe's
   * tail, within a forward window of the current cursor.
   */
  matchSpoken(probe: string[], cursor: number): number {
    if (probe.length === 0 || this.totalWords === 0) return cursor

    const AHEAD = 60 // how far ahead we'll let a jump land (skipped a paragraph)
    const BACK = 4 // tolerate a touch of backward drift from interim noise
    const MAX_RUN = 6 // cap the backward-match run we score

    const start = Math.max(0, cursor - BACK)
    const end = Math.min(this.totalWords, cursor + AHEAD)

    let bestPos = -1
    let bestScore = 0
    for (let i = start; i < end; i++) {
      let score = 0
      let pi = probe.length - 1
      let si = i
      while (pi >= 0 && si >= 0 && probe[pi] === this.wordNorms[si]) {
        score++
        pi--
        si--
        if (score >= MAX_RUN) break
      }
      if (score > bestScore) {
        bestScore = score
        bestPos = i
      } else if (score === bestScore && score > 0 && bestPos >= 0) {
        // Tie: prefer the match nearest the current cursor so a repeated phrase
        // later in the script doesn't yank us forward.
        if (Math.abs(i - cursor) < Math.abs(bestPos - cursor)) bestPos = i
      }
    }

    if (bestPos < 0) return cursor
    const needed = probe.length === 1 ? 1 : 2
    if (bestScore < needed) return cursor

    const candidate = bestPos + 1
    if (candidate <= cursor) return cursor
    // A lone single-word match is weak evidence — only honor it close to home.
    if (bestScore === 1 && candidate > cursor + 8) return cursor
    return Math.min(candidate, this.totalWords)
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private clampLines(n: number): number {
    return Math.max(2, Math.min(Math.round(n), this.profile.maxLines))
  }

  private rewrap(): void {
    const widthPx = Math.round(this.profile.displayWidthPx * widthFraction(this.widthSetting))
    const result = this.wrapper.wrap(this.text, {
      maxWidthPx: widthPx,
      maxLines: Infinity,
      maxBytes: Infinity,
      breakMode: "word",
      trimLines: true,
      preserveNewlines: true,
    })
    this.allLines = result.lines

    const norms: string[] = []
    const lines: number[] = []
    for (let lineIdx = 0; lineIdx < this.allLines.length; lineIdx++) {
      for (const raw of this.allLines[lineIdx].split(/\s+/)) {
        const n = normalizeWord(raw)
        if (!n) continue
        norms.push(n)
        lines.push(lineIdx)
      }
    }
    this.wordNorms = norms
    this.wordLines = lines
  }
}
