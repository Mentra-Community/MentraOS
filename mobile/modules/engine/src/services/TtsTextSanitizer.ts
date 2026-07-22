const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
}

/** Convert display-oriented text into plain words before TTS synthesis. */
export function sanitizeTtsText(text: string): string {
  let speech = text.replace(/&(amp|lt|gt|quot|#39);/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)

  speech = speech
    .replace(/<say-as\b[^>]*>(.*?)<\/say-as>/gis, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*?)?\s*\/?>/gi, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*(?:°\s*f\b|℉)/gi, "$1 degrees Fahrenheit")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*(?:°\s*c\b|℃)/gi, "$1 degrees Celsius")
    .replace(/(-?\d+(?:[.,]\d+)?)\s*°/g, "$1 degrees")
    .replace(/<=/g, " less than or equal to ")
    .replace(/>=/g, " greater than or equal to ")
    .replace(/</g, " less than ")
    .replace(/>/g, " greater than ")
    .replace(/[[\]{}()]/g, " ")
    .replace(/(degrees Fahrenheit)\s+(-?\d+(?:[.,]\d+)? degrees Celsius)\b/gi, "$1 or $2")
    .replace(/(degrees Celsius)\s+(-?\d+(?:[.,]\d+)? degrees Fahrenheit)\b/gi, "$1 or $2")
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

/** Prepare an already-trimmed sentence list while preserving the exact-text opt-out. */
export function prepareTtsSentences(sentences: string[], enableSanitization = true): string[] {
  if (!enableSanitization) return sentences

  const sanitized = sentences.map((sentence) => sanitizeTtsText(sentence)).filter(Boolean)

  return sanitized.map((sentence, index) => {
    const previous = sanitized[index - 1]
    if (!previous) return sentence

    const followsFahrenheit = /degrees Fahrenheit[,.;:!?]?$/i.test(previous)
    const followsCelsius = /degrees Celsius[,.;:!?]?$/i.test(previous)
    const startsWithFahrenheit = /^-?\d+(?:[.,]\d+)? degrees Fahrenheit\b/i.test(sentence)
    const startsWithCelsius = /^-?\d+(?:[.,]\d+)? degrees Celsius\b/i.test(sentence)

    return (followsFahrenheit && startsWithCelsius) || (followsCelsius && startsWithFahrenheit)
      ? `or ${sentence}`
      : sentence
  })
}
