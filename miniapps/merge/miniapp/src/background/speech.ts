const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
}

/** Convert display-oriented insight text into plain words for the TTS API. */
export function insightToSpeechText(text: string): string {
  let speech = text.replace(/&(amp|lt|gt|quot|#39);/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)

  speech = speech
    .replace(/<say-as\b[^>]*>(.*?)<\/say-as>/gis, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[\[\]{}()<>]/g, " ")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/=/g, " equals ")
    .replace(/#/g, " hash ")
    .replace(/@/g, " at ")
    .replace(/%/g, " percent ")
    .replace(/\\/g, " backslash ")
    .replace(/\//g, " slash ")
    .replace(/\*/g, " star ")

  return speech.replace(/\s+/g, " ").trim()
}
