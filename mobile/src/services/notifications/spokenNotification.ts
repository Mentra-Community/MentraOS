/**
 * Turning a phone notification into something worth hearing.
 *
 * Glasses with no screen (Mentra Live) announce notifications out loud, and a
 * notification's raw text is written to be *seen*, not heard. Read verbatim it
 * arrives as noise: URLs get spelled out character by character, emoji and
 * separators become nonsense syllables, and a long body turns a two-second
 * announcement into a paragraph the wearer cannot skip or skim (OS-1821).
 *
 * So this trims the announcement down to what a person actually needs — who it
 * is from and the gist — and drops the ones that were never meant to be spoken.
 */

/** Longest announcement we will speak. Past this it stops being a notification. */
export const SPOKEN_MAX_CHARS = 140

/**
 * Notifications that exist to be glanced at, not heard: group summaries and
 * counters that carry no content ("3 new messages"). The native layer already
 * drops the exact string "N new messages"; these cover the rest of the family.
 */
const SUMMARY_PATTERNS = [
  /^\d+\s+new\s+(messages?|notifications?|emails?)$/i,
  /^\d+\s+(messages?|notifications?|updates?)$/i,
  /^\d+\s+more$/i,
]

/**
 * Android priority floor. PRIORITY_LOW (-1) and PRIORITY_MIN (-2) are the
 * levels apps use for things they explicitly do not want to interrupt you with,
 * so speaking them aloud is the one thing they asked us not to do.
 */
const MIN_SPOKEN_PRIORITY = 0

/**
 * Strip the parts that only make sense on a screen.
 *
 * URLs are the big one: "https://ex.co/a?b=1" read aloud is the single largest
 * source of what sounds like gibberish. Emoji, box-drawing and zero-width
 * characters are the rest.
 */
export function sanitizeForSpeech(raw: string): string {
  return (
    raw
      // URLs and bare domains, unspeakable and never the point of the message.
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
      .replace(/\b[\w.-]+\.(?:com|org|net|io|co|dev|app|gg|ly)\b\S*/gi, "")
      // Emoji, pictographs and variation selectors.
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
      // Variation selectors, dropped separately for the same reason as the
      // joiner: they combine with the preceding character rather than
      // standing alone, so a character class is the wrong tool.
      .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
      // Zero-width joiner, dropped separately: inside the class above it would
      // split composed emoji (families, skin tones) into their component parts.
      .replace(/\u200D/gu, "")
      // Box drawing, bullets and separators that apps use as visual dividers.
      .replace(/[\u2500-\u257F\u2022\u00B7\u2219|]+/g, " ")
      // Control characters, plus the remaining zero-width and bidi marks.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u200B\u200C\u200E\u200F\uFEFF]/g, " ")
      // Runs of punctuation ("!!!", "---", "...") read as stuttering.
      .replace(/([!?.,\-_~*#])\1{1,}/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/** Cut to a length without slicing a word in half — a clipped word sounds broken. */
export function truncateOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const clipped = text.slice(0, maxChars)
  // Prefer ending on a sentence, then a word; fall back to the hard cut only if
  // the text has no break at all (a single very long token).
  const sentenceEnd = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "))
  if (sentenceEnd > maxChars * 0.5) return clipped.slice(0, sentenceEnd + 1)
  const wordEnd = clipped.lastIndexOf(" ")
  return (wordEnd > 0 ? clipped.slice(0, wordEnd) : clipped).trimEnd()
}

export interface SpokenNotificationInput {
  app: string
  title: string
  content: string
  /** Android notification priority, when the platform reported one. */
  priority?: number
}

/**
 * Build the sentence to speak, or null when this notification should stay
 * silent. Shape is "App: title. body" — who it's from first, because that is
 * what the wearer needs to decide whether to reach for their phone.
 */
export function buildSpokenNotification(input: SpokenNotificationInput): string | null {
  if (typeof input.priority === "number" && input.priority < MIN_SPOKEN_PRIORITY) return null

  const app = sanitizeForSpeech(input.app)
  const title = sanitizeForSpeech(input.title)
  const content = sanitizeForSpeech(input.content)

  // A summary row ("3 new messages") tells you nothing you can act on.
  if (SUMMARY_PATTERNS.some((pattern) => pattern.test(title) || pattern.test(content))) return null

  // Once URLs and emoji are gone some notifications have nothing left to say —
  // a link-only message, or a body that was purely decorative.
  const headline = title && title !== app ? title : ""
  const body = content && content !== headline ? content : ""
  if (!headline && !body) return null

  const lead = [app, headline].filter(Boolean).join(": ")
  const spoken = [lead, body].filter(Boolean).join(". ")
  const trimmed = truncateOnWordBoundary(spoken, SPOKEN_MAX_CHARS)
  return trimmed.length > 0 ? trimmed : null
}
