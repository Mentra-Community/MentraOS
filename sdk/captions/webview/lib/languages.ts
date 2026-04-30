export interface Language {
  code: string
  name: string
  nativeName?: string
  flag: string
}

export const AVAILABLE_LANGUAGES: Language[] = [
  {code: "af", name: "Afrikaans", nativeName: "Afrikaans", flag: "🇿🇦"},
  {code: "sq", name: "Albanian", nativeName: "Shqip", flag: "🇦🇱"},
  {code: "ar", name: "Arabic", nativeName: "العربية", flag: "🇸🇦"},
  {code: "az", name: "Azerbaijani", nativeName: "Azərbaycan", flag: "🇦🇿"},
  {code: "eu", name: "Basque", nativeName: "Euskara", flag: "🇪🇸"},
  {code: "be", name: "Belarusian", nativeName: "Беларуская", flag: "🇧🇾"},
  {code: "bn", name: "Bengali", nativeName: "বাংলা", flag: "🇧🇩"},
  {code: "bs", name: "Bosnian", nativeName: "Bosanski", flag: "🇧🇦"},
  {code: "bg", name: "Bulgarian", nativeName: "Български", flag: "🇧🇬"},
  {code: "ca", name: "Catalan", nativeName: "Català", flag: "🇪🇸"},
  {code: "zh", name: "Chinese", nativeName: "中文", flag: "🇨🇳"},
  {code: "hr", name: "Croatian", nativeName: "Hrvatski", flag: "🇭🇷"},
  {code: "cs", name: "Czech", nativeName: "Čeština", flag: "🇨🇿"},
  {code: "da", name: "Danish", nativeName: "Dansk", flag: "🇩🇰"},
  {code: "nl", name: "Dutch", nativeName: "Nederlands", flag: "🇳🇱"},
  {code: "en", name: "English", nativeName: "English", flag: "🇺🇸"},
  {code: "et", name: "Estonian", nativeName: "Eesti", flag: "🇪🇪"},
  {code: "fi", name: "Finnish", nativeName: "Suomi", flag: "🇫🇮"},
  {code: "fr", name: "French", nativeName: "Français", flag: "🇫🇷"},
  {code: "gl", name: "Galician", nativeName: "Galego", flag: "🇪🇸"},
  {code: "de", name: "German", nativeName: "Deutsch", flag: "🇩🇪"},
  {code: "el", name: "Greek", nativeName: "Ελληνικά", flag: "🇬🇷"},
  {code: "gu", name: "Gujarati", nativeName: "ગુજરાતી", flag: "🇮🇳"},
  {code: "he", name: "Hebrew", nativeName: "עברית", flag: "🇮🇱"},
  {code: "hi", name: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳"},
  {code: "hu", name: "Hungarian", nativeName: "Magyar", flag: "🇭🇺"},
  {code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", flag: "🇮🇩"},
  {code: "it", name: "Italian", nativeName: "Italiano", flag: "🇮🇹"},
  {code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵"},
  {code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ", flag: "🇮🇳"},
  {code: "kk", name: "Kazakh", nativeName: "Қазақ тілі", flag: "🇰🇿"},
  {code: "ko", name: "Korean", nativeName: "한국어", flag: "🇰🇷"},
  {code: "lv", name: "Latvian", nativeName: "Latviešu", flag: "🇱🇻"},
  {code: "lt", name: "Lithuanian", nativeName: "Lietuvių", flag: "🇱🇹"},
  {code: "mk", name: "Macedonian", nativeName: "Македонски", flag: "🇲🇰"},
  {code: "ms", name: "Malay", nativeName: "Bahasa Melayu", flag: "🇲🇾"},
  {code: "ml", name: "Malayalam", nativeName: "മലയാളം", flag: "🇮🇳"},
  {code: "mr", name: "Marathi", nativeName: "मराठी", flag: "🇮🇳"},
  {code: "no", name: "Norwegian", nativeName: "Norsk", flag: "🇳🇴"},
  {code: "fa", name: "Persian", nativeName: "فارسی", flag: "🇮🇷"},
  {code: "pl", name: "Polish", nativeName: "Polski", flag: "🇵🇱"},
  {code: "pt", name: "Portuguese", nativeName: "Português", flag: "🇵🇹"},
  {code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", flag: "🇮🇳"},
  {code: "ro", name: "Romanian", nativeName: "Română", flag: "🇷🇴"},
  {code: "ru", name: "Russian", nativeName: "Русский", flag: "🇷🇺"},
  {code: "sr", name: "Serbian", nativeName: "Српски", flag: "🇷🇸"},
  {code: "sk", name: "Slovak", nativeName: "Slovenčina", flag: "🇸🇰"},
  {code: "sl", name: "Slovenian", nativeName: "Slovenščina", flag: "🇸🇮"},
  {code: "es", name: "Spanish", nativeName: "Español", flag: "🇪🇸"},
  {code: "sw", name: "Swahili", nativeName: "Kiswahili", flag: "🇰🇪"},
  {code: "sv", name: "Swedish", nativeName: "Svenska", flag: "🇸🇪"},
  {code: "tl", name: "Tagalog", nativeName: "Tagalog", flag: "🇵🇭"},
  {code: "ta", name: "Tamil", nativeName: "தமிழ்", flag: "🇮🇳"},
  {code: "te", name: "Telugu", nativeName: "తెలుగు", flag: "🇮🇳"},
  {code: "th", name: "Thai", nativeName: "ไทย", flag: "🇹🇭"},
  {code: "tr", name: "Turkish", nativeName: "Türkçe", flag: "🇹🇷"},
  {code: "uk", name: "Ukrainian", nativeName: "Українська", flag: "🇺🇦"},
  {code: "ur", name: "Urdu", nativeName: "اردو", flag: "🇵🇰"},
  {code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", flag: "🇻🇳"},
  {code: "cy", name: "Welsh", nativeName: "Cymraeg", flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿"},
]

export function getLanguageName(code: string): string {
  return AVAILABLE_LANGUAGES.find((l) => l.code === code)?.name || code
}

export function searchLanguages(query: string): Language[] {
  const lowerQuery = query.toLowerCase()
  return AVAILABLE_LANGUAGES.filter(
    (l) => l.name.toLowerCase().includes(lowerQuery) || l.code.toLowerCase().includes(lowerQuery),
  )
}

export function getAvailableHints(primaryLanguage: string): Language[] {
  // Return all languages except the primary language for use as hints
  return AVAILABLE_LANGUAGES.filter((l) => l.code !== primaryLanguage)
}

export function getFlagEmoji(code: string): string {
  return AVAILABLE_LANGUAGES.find((l) => l.code === code)?.flag || "🏳️"
}
