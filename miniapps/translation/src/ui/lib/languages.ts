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

export function getLanguageName(code: string): string {
  return TARGET_LANGUAGES.find((l) => l.code === code)?.name || code
}

export function getFlagEmoji(code: string): string {
  return TARGET_LANGUAGES.find((l) => l.code === code)?.flag || "🏳️"
}
