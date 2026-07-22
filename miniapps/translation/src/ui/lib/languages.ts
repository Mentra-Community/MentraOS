export interface Language {
  code: string
  name: string
  nativeName?: string
  flag: string
}

export const TARGET_LANGUAGES: Language[] = [
  {code: "en", name: "English", nativeName: "English", flag: "🇺🇸"},
  {code: "es", name: "Spanish", nativeName: "Español", flag: "🇪🇸"},
  {code: "fr", name: "French", nativeName: "Français", flag: "🇫🇷"},
  {code: "de", name: "German", nativeName: "Deutsch", flag: "🇩🇪"},
  {code: "pt", name: "Portuguese", nativeName: "Português", flag: "🇵🇹"},
  {code: "it", name: "Italian", nativeName: "Italiano", flag: "🇮🇹"},
  {code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵"},
  {code: "zh", name: "Chinese", nativeName: "中文", flag: "🇨🇳"},
  {code: "ko", name: "Korean", nativeName: "한국어", flag: "🇰🇷"},
  {code: "ar", name: "Arabic", nativeName: "العربية", flag: "🇸🇦"},
  {code: "hi", name: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳"},
  {code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", flag: "🇻🇳"},
]

/**
 * Look up a language by code. Accepts both bare codes ("es") and BCP-47 tags
 * ("es-ES", "en-US") — the primary subtag is matched, so target languages that
 * arrive canonicalized (e.g. from the translation subscription) still resolve
 * to a flag and name instead of falling back to the raw code + white flag.
 */
function findLanguage(code: string): Language | undefined {
  const primary = (code ?? "").split("-")[0].toLowerCase()
  return TARGET_LANGUAGES.find((l) => l.code === primary)
}

export function getLanguageName(code: string): string {
  return findLanguage(code)?.name || code
}

export function getFlagEmoji(code: string): string {
  return findLanguage(code)?.flag || "🏳️"
}
