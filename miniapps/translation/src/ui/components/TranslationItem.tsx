import {TranslationEntry} from "../hooks/useTranslations"
import {getFlagEmoji, getLanguageName} from "../lib/languages"

function formatTimestamp(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epochMs))
}

interface TranslationItemProps {
  translation: TranslationEntry
  isFirst: boolean
  isLast: boolean
  showOriginalText?: boolean
}

const SPEAKER_COLORS = [
  {bg: "#3183BD", text: "#3183BD"},
  {bg: "#93A246", text: "#93A246"},
  {bg: "#3F7D76", text: "#3F7D76"},
  {bg: "#CF7627", text: "#CF7627"},
  {bg: "#EC4899", text: "#EC4899"},
]

export function TranslationItem({translation, isFirst, isLast, showOriginalText = true}: TranslationItemProps) {
  const speakerNumber = parseInt(translation.speaker.replace(/\D/g, ""), 10) || 1
  const speakerIndex = (speakerNumber - 1) % SPEAKER_COLORS.length
  const colors = SPEAKER_COLORS[speakerIndex]
  const sourceLanguage = translation.sourceLanguage

  return (
    <div
      className={`self-stretch p-4 bg-white/80 dark:bg-zinc-900/80 rounded-md flex flex-col gap-2 ${
        translation.isFinal ? "opacity-100" : "opacity-80"
      } ${isFirst ? "rounded-t-2xl" : ""} ${isLast ? "rounded-b-2xl" : ""}`}>
      <div className="flex items-center gap-2">
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
          style={{backgroundColor: colors.bg, minWidth: "20px"}}>
          <span
            className="text-[10px] font-bold font-['Red_Hat_Display'] leading-none"
            style={{color: readableTextColor(colors.bg)}}>
            {speakerNumber}
          </span>
        </div>

        <span className="text-sm font-bold font-['Red_Hat_Display'] leading-5" style={{color: colors.text}}>
          {translation.speaker}
        </span>

        <span className="text-gray-500 dark:text-zinc-400 text-xs font-medium font-['Red_Hat_Display'] leading-4">
          {sourceLanguage && sourceLanguage !== "auto"
            ? `${getFlagEmoji(sourceLanguage)} ${getLanguageName(sourceLanguage)} -> `
            : ""}
          {getFlagEmoji(translation.targetLanguage)} {getLanguageName(translation.targetLanguage)}
        </span>

        <span className="text-gray-600 dark:text-zinc-300 text-xs font-normal font-['Red_Hat_Display'] leading-4 ml-auto">
          {translation.timestamp ? formatTimestamp(translation.timestamp) : translation.isFinal ? "" : "Now"}
        </span>
      </div>

      {showOriginalText && translation.originalText && (
        <p className="selectable-text self-stretch text-gray-500 dark:text-zinc-400 text-sm font-normal font-['Red_Hat_Display'] leading-5">
          {translation.originalText}
        </p>
      )}

      <p
        className={`selectable-text self-stretch text-gray-900 dark:text-zinc-50 text-base font-normal font-['Red_Hat_Display'] leading-6 ${
          translation.isFinal ? "" : "italic"
        }`}>
        {translation.text}
      </p>
    </div>
  )
}

function readableTextColor(hex: string): string {
  const color = hex.replace("#", "")
  if (color.length !== 6) return "#FFFFFF"
  const r = parseInt(color.slice(0, 2), 16)
  const g = parseInt(color.slice(2, 4), 16)
  const b = parseInt(color.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? "#1F2937" : "#FFFFFF"
}
