/**
 * @fileoverview The canonical language registry (issue 021, WP1).
 *
 * Single source of truth for every language value that crosses a layer
 * boundary: miniapp SDK types, miniapp UI pickers, engine validation, cloud
 * subscription validation, and STT provider config all derive from THIS
 * module. Per-miniapp mapping tables are banned; the captions bugbash
 * (OS-1746) traced directly to two hand-maintained registries disagreeing.
 *
 * Two vocabularies exist on purpose:
 *   - `TranscriptionLanguage`: BCP-47 tags ("en-US") used in subscriptions and
 *     stream keys. What a miniapp asks for.
 *   - `LanguageHint`: bare ISO 639-1 codes ("en") — the only format the STT
 *     provider (Soniox) accepts as language hints. Passing a BCP-47 tag kills
 *     the session with "Invalid language hint." (verified live 2026-07-21).
 *
 * Design doc: docs/issues/021-typed-language-subscriptions/README.md
 */

/**
 * Bare ISO 639-1 code -> canonical default BCP-47 tag. One entry per language
 * the platform offers. The key set doubles as the supported-hints list; the
 * value set doubles as the supported-subscription-tags list.
 *
 * Seeded from the 63 languages the captions UI offers (all Soniox stt-rt-v4
 * supported); regional variants beyond the default (e.g. "en-GB", "zh-TW",
 * "pt-PT") are listed in EXTRA_REGIONAL_TAGS below.
 */
const CANONICAL_TAG_BY_CODE = {
  af: "af-ZA",
  am: "am-ET",
  ar: "ar-AE",
  az: "az-AZ",
  be: "be-BY",
  bg: "bg-BG",
  bn: "bn-IN",
  bs: "bs-BA",
  ca: "ca-ES",
  cs: "cs-CZ",
  cy: "cy-GB",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  et: "et-EE",
  eu: "eu-ES",
  fa: "fa-IR",
  fi: "fi-FI",
  fr: "fr-FR",
  gl: "gl-ES",
  gu: "gu-IN",
  he: "he-IL",
  hi: "hi-IN",
  hr: "hr-HR",
  hu: "hu-HU",
  hy: "hy-AM",
  id: "id-ID",
  it: "it-IT",
  ja: "ja-JP",
  ka: "ka-GE",
  kk: "kk-KZ",
  kn: "kn-IN",
  ko: "ko-KR",
  lt: "lt-LT",
  lv: "lv-LV",
  mk: "mk-MK",
  ml: "ml-IN",
  mr: "mr-IN",
  ms: "ms-MY",
  nb: "nb-NO",
  ne: "ne-NP",
  nl: "nl-NL",
  no: "nb-NO",
  pa: "pa-IN",
  pl: "pl-PL",
  pt: "pt-BR",
  ro: "ro-RO",
  ru: "ru-RU",
  sk: "sk-SK",
  sl: "sl-SI",
  sq: "sq-AL",
  sr: "sr-RS",
  sv: "sv-SE",
  sw: "sw-KE",
  ta: "ta-IN",
  te: "te-IN",
  th: "th-TH",
  tl: "fil-PH",
  tr: "tr-TR",
  uk: "uk-UA",
  ur: "ur-IN",
  vi: "vi-VN",
  zh: "zh-CN",
} as const;

/**
 * Regional variants accepted IN ADDITION to the canonical defaults above.
 * A tag listed here is a valid `TranscriptionLanguage` but is never produced
 * by bare-code canonicalization.
 */
const EXTRA_REGIONAL_TAGS = [
  "ar-EG",
  "ar-SA",
  "de-AT",
  "de-CH",
  "en-AU",
  "en-CA",
  "en-GB",
  "en-IN",
  "es-419",
  "es-MX",
  "es-US",
  "fr-CA",
  "nl-BE",
  "pt-PT",
  "zh-HK",
  "zh-TW",
] as const;

type CodeMap = typeof CANONICAL_TAG_BY_CODE;

/** Bare ISO 639-1 hint codes the STT provider accepts ("en", "fr", ...). */
export type LanguageHint = keyof CodeMap;

/** BCP-47 tags valid in transcription subscriptions and stream keys. */
export type TranscriptionLanguage =
  | CodeMap[LanguageHint]
  | (typeof EXTRA_REGIONAL_TAGS)[number];

/** Every supported hint code, sorted, deduped. */
export const SUPPORTED_LANGUAGE_HINTS = Object.freeze(
  [...new Set(Object.keys(CANONICAL_TAG_BY_CODE))].sort(),
) as readonly LanguageHint[];

/** Every supported subscription tag, sorted, deduped. */
export const SUPPORTED_TRANSCRIPTION_LANGUAGES = Object.freeze(
  [
    ...new Set<string>([
      ...Object.values(CANONICAL_TAG_BY_CODE),
      ...EXTRA_REGIONAL_TAGS,
    ]),
  ].sort(),
) as readonly TranscriptionLanguage[];

const TAG_SET = new Set<string>(SUPPORTED_TRANSCRIPTION_LANGUAGES);
const HINT_SET = new Set<string>(SUPPORTED_LANGUAGE_HINTS);

/** Type guard: is `value` a supported subscription tag? */
export function isTranscriptionLanguage(
  value: string,
): value is TranscriptionLanguage {
  return TAG_SET.has(value);
}

/** Type guard: is `value` a supported bare hint code? */
export function isLanguageHint(value: string): value is LanguageHint {
  return HINT_SET.has(value);
}

/**
 * Canonicalize developer input to a subscription tag:
 *   - a supported tag passes through ("fr-FR" -> "fr-FR")
 *   - a bare supported code maps to its canonical default ("fr" -> "fr-FR")
 *   - anything else returns null (caller decides how loudly to fail)
 *
 * Per issue 021 open question 1, bare codes are accepted and canonicalized
 * rather than rejected: it matches user intent and the canonicalization table
 * lives HERE, nowhere else.
 */
export function toTranscriptionLanguage(
  value: string,
): TranscriptionLanguage | null {
  if (TAG_SET.has(value)) return value as TranscriptionLanguage;
  const canonical = (CANONICAL_TAG_BY_CODE as Record<string, string>)[
    value.toLowerCase()
  ];
  return (canonical as TranscriptionLanguage) ?? null;
}

/**
 * Reduce a subscription tag (or bare code) to the hint format the STT
 * provider accepts. "en-US" -> "en", "fil-PH" -> "tl" is NOT attempted (the
 * primary subtag is what providers key on), so "fil-PH" -> "fil" falls back
 * to null and the caller simply omits the hint. Null means "no valid hint";
 * never pass the raw value through on null (that is the exact Soniox
 * session-killer this registry exists to prevent).
 */
export function toLanguageHint(value: string): LanguageHint | null {
  const primary = value.split("-")[0].toLowerCase();
  return HINT_SET.has(primary) ? (primary as LanguageHint) : null;
}

/**
 * Nearest valid tag for an invalid input, for error messages
 * ("unknown language \"fr_FR\", did you mean \"fr-FR\"?"). Cheap heuristics
 * only: underscore/case fixes, then primary-subtag canonical default.
 */
export function suggestTranscriptionLanguage(
  value: string,
): TranscriptionLanguage | null {
  const normalized = value.replace(/_/g, "-");
  const parts = normalized.split("-");
  const recased =
    parts.length >= 2
      ? `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`
      : normalized.toLowerCase();
  return toTranscriptionLanguage(recased);
}
