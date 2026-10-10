/** Script content, reading position, and voice matching. MentraOS owns wrapping. */
import type {RenderTextLayout} from "@mentra/miniapp/background"

/** Lowercase + strip everything but letters/digits. "" for punctuation-only. */
export function normalizeWord(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

// Character anchors stay stable as a partial Japanese transcript grows. Keep
// Latin words intact, and retain source offsets before Unicode normalization.
function* speechTokens(text: string) {
  const pattern =
    /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]\p{M}*|[^\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\s]+/gu
  for (const match of text.matchAll(pattern)) {
    const word = normalizeWord(match[0])
    if (word) yield {word, end: match.index! + match[0].length}
  }
}

/** Shared script/transcription anchors, including unspaced Japanese text. */
export function normalizeWords(text: string): string[] {
  return Array.from(speechTokens(text), (token) => token.word)
}

export class ScriptEngine {
  private text = ""
  private wordNorms: string[] = []
  private wordStarts: number[] = []
  private wordEnds: number[] = []
  private speechNorms: string[] = []
  private speechPositions: number[] = []
  private splitWords: boolean[] = []
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
    this.speechNorms = []
    this.speechPositions = []
    this.splitWords = []
    for (const match of this.text.matchAll(/\S+/gu)) {
      const word = normalizeWord(match[0])
      if (!word) continue
      this.wordNorms.push(word)
      this.wordStarts.push(match.index!)
      this.wordEnds.push(match.index! + match[0].length)
      const tokens = Array.from(speechTokens(match[0]))
      const index = this.wordNorms.length - 1
      this.splitWords.push(tokens.length > 1)
      for (let i = 0; i < tokens.length; i++) {
        this.speechNorms.push(tokens[i].word)
        // Fractional word positions let speech move within an unspaced sentence
        // without changing WPM timing, word counts, or English cursor semantics.
        this.speechPositions.push(index + (i === tokens.length - 1 ? 1 : tokens[i].end / match[0].length))
      }
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
    const index = Math.min(Math.floor(word), this.totalWords - 1)
    const start = this.wordStarts[index] ?? 0
    const fraction = word >= this.totalWords ? 1 : word - Math.floor(word)
    const offset = start + (this.splitWords[index] ? Math.round(fraction * (this.wordEnds[index] - start)) : 0)
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
    if (word < 0) return this.totalWords
    return (
      word +
      (this.splitWords[word]
        ? Math.max(0, start - this.wordStarts[word]) / (this.wordEnds[word] - this.wordStarts[word])
        : 0)
    )
  }
  wordForPercent(percent: number): number {
    const position = (Math.max(0, Math.min(100, percent)) / 100) * this.totalWords
    return this.splitWords[Math.floor(position)] ? position : Math.round(position)
  }
  progressForWord(word: number): number {
    return this.totalWords ? Math.max(0, Math.min(100, Math.round((word / this.totalWords) * 100))) : 0
  }

  matchSpoken(probe: string[], cursor: number): number {
    if (probe.length === 0 || this.totalWords === 0) return cursor

    const AHEAD = 60 // how far ahead we'll let a jump land (skipped a paragraph)
    const BACK = 4 // tolerate a touch of backward drift from interim noise
    const MAX_RUN = 6 // cap the backward-match run we score
    const japaneseProbe = probe.some((word) =>
      /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u.test(word),
    )
    // A delayed Japanese update may cover far more than 60 character anchors.
    // Bound recovery to 600 anchors and require the full six-token suffix for
    // jumps outside the normal window; short common suffixes cannot recover.
    const recoveryAhead = japaneseProbe ? 600 : AHEAD

    // Find the next speech anchor in logarithmic time, including fractional
    // positions inside Japanese source words.
    let low = 0
    let high = this.speechPositions.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (this.speechPositions[mid] <= cursor) low = mid + 1
      else high = mid
    }
    const start = Math.max(0, low - BACK)
    const end = Math.min(this.speechNorms.length, low + recoveryAhead)

    let bestPos = -1
    let bestScore = 0
    for (let i = start; i < end; i++) {
      let score = 0
      let pi = probe.length - 1
      let si = i
      while (pi >= 0 && si >= 0 && probe[pi] === this.speechNorms[si]) {
        score++
        pi--
        si--
        if (score >= MAX_RUN) break
      }
      if (i >= low + AHEAD && score < MAX_RUN) continue
      if (score > bestScore) {
        bestScore = score
        bestPos = i
      } else if (score === bestScore && score > 0 && bestPos >= 0) {
        // Tie: prefer the match nearest the current cursor so a repeated phrase
        // later in the script doesn't yank us forward.
        if (Math.abs(i - low) < Math.abs(bestPos - low)) bestPos = i
      }
    }

    if (bestPos < 0) return cursor
    // Two Japanese characters can be a common suffix rather than evidence that
    // the reader reached another sentence. Require three when available.
    const needed = Math.min(probe.length, japaneseProbe ? 3 : 2)
    if (bestScore < needed) return cursor

    const candidate = this.speechPositions[bestPos]
    if (candidate <= cursor) return cursor
    // A lone single-word match is weak evidence — only honor it close to home.
    if (bestScore === 1 && bestPos + 1 > low + 8) return cursor
    return Math.min(candidate, this.totalWords)
  }
}
