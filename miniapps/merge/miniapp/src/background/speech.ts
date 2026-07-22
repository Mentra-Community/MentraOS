const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
}

interface InsightSpeaker {
  speak(text: string, options: {stopOtherAudio: boolean}): Promise<unknown>
  stop(): void
}

/** Convert display-oriented insight text into plain words for the TTS API. */
export function insightToSpeechText(text: string): string {
  let speech = text.replace(/&(amp|lt|gt|quot|#39);/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)

  speech = speech
    .replace(/<say-as\b[^>]*>(.*?)<\/say-as>/gis, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/gi, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\(\s*(-?\d+(?:[.,]\d+)?)\s*(?:°\s*f\b|℉)\s*\)/gi, " or $1 degrees Fahrenheit")
    .replace(/\(\s*(-?\d+(?:[.,]\d+)?)\s*(?:°\s*c\b|℃)\s*\)/gi, " or $1 degrees Celsius")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*(?:°\s*f\b|℉)/gi, "$1 degrees Fahrenheit")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*(?:°\s*c\b|℃)/gi, "$1 degrees Celsius")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*°/g, "$1 degrees")
    .replace(/<=/g, " less than or equal to ")
    .replace(/>=/g, " greater than or equal to ")
    .replace(/</g, " less than ")
    .replace(/>/g, " greater than ")
    .replace(/[[\]{}()]/g, " ")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/=/g, " equals ")
    .replace(/#/g, " hash ")
    .replace(/@/g, " at ")
    .replace(/%/g, " percent ")
    .replace(/\\/g, " backslash ")
    .replace(/\//g, (slash, offset, source) => {
      const numericSeparator = /\d/.test(source[offset - 1] ?? "") && /\d/.test(source[offset + 1] ?? "")
      return numericSeparator ? slash : " slash "
    })
    .replace(/\*/g, " star ")

  return speech
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/** Replace the current spoken insight, even when its display text has no speakable content. */
export async function speakInsightText(speaker: InsightSpeaker, text: string): Promise<void> {
  const speechText = insightToSpeechText(text)
  if (!speechText) {
    speaker.stop()
    return
  }
  await speaker.speak(speechText, {stopOtherAudio: true})
}
