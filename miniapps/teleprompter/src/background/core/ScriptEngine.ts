/** Script content, reading position, and voice matching. MentraOS owns wrapping. */
import type {RenderTextLayout} from "@mentra/miniapp/background"

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
  private text = ""
  private wordNorms: string[] = []
  private wordStarts: number[] = []
  private wordEnds: number[] = []
  private lineStarts = [0]
  private numberOfLines: number

  constructor(config: {numberOfLines: number}) {
    this.numberOfLines = config.numberOfLines
  }

  setScript(text: string): void {
    this.text = text ?? ""
    this.wordNorms = []
    this.wordStarts = []
    this.wordEnds = []
    for (const match of this.text.matchAll(/\S+/gu)) {
      const word = normalizeWord(match[0])
      if (!word) continue
      this.wordNorms.push(word)
      this.wordStarts.push(match.index!)
      this.wordEnds.push(match.index! + match[0].length)
    }
    this.invalidateLayout()
  }

  invalidateLayout(): void {
    this.lineStarts = [0]
  }
  setLines(lines: number): void {
    this.numberOfLines = Math.max(1, lines)
  }

  /** These boundaries come from a render result, never from app font tables. */
  acceptLayout(sourceStart: number, result: RenderTextLayout): void {
    this.lineStarts = [
      ...this.lineStarts.filter((start) => start < sourceStart),
      ...result.lineStarts.map((start) => sourceStart + start),
    ]
    if (!this.lineStarts.length) this.lineStarts = [0]
    this.numberOfLines = Math.max(1, result.capacity)
  }

  get viewportLines(): number {
    return this.numberOfLines
  }
  get totalWords(): number {
    return this.wordNorms.length
  }
  get totalLines(): number {
    return this.lineStarts.length
  }
  get maxTopLine(): number {
    return Math.max(0, this.totalLines - this.numberOfLines)
  }
  sourceStartForLine(line: number): number {
    return this.lineStarts[Math.max(0, Math.min(line, this.totalLines - 1))] ?? 0
  }
  textFrom(sourceStart: number): string {
    return this.text.slice(sourceStart)
  }

  lineForWord(word: number): number {
    const offset = this.wordStarts[Math.min(word, this.totalWords - 1)] ?? 0
    let line = 0
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line++
    return line
  }
  topLineForWord(word: number): number {
    return Math.min(this.lineForWord(word), this.maxTopLine)
  }
  firstWordOfLine(line: number): number {
    const start = this.sourceStartForLine(line)
    const word = this.wordEnds.findIndex((end) => end > start)
    return word < 0 ? this.totalWords : word
  }
  wordForPercent(percent: number): number {
    return Math.round((Math.max(0, Math.min(100, percent)) / 100) * this.totalWords)
  }
  progressForWord(word: number): number {
    return this.totalWords ? Math.max(0, Math.min(100, Math.round((word / this.totalWords) * 100))) : 0
  }

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
}
