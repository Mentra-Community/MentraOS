import CCIcon from "../assets/icons/path0.svg"
import {getLanguageName, getFlagEmoji} from "../lib/languages"
import type {CaptionSettings} from "../../shared/types"

interface HeaderProps {
  settings: CaptionSettings
  onToggleLanguageSelector: () => void
  isLanguageSelectorOpen?: boolean
}

export function Header({settings, onToggleLanguageSelector, isLanguageSelectorOpen = false}: HeaderProps) {
  return (
    <div className="w-full flex flex-col">
      <div
        className="w-full px-6 py-3 backdrop-blur-lg flex justify-center items-center"
        style={{backgroundColor: "#6DAEA6"}}>
        <div className="flex justify-start items-center gap-2">
          <img src={CCIcon} alt="CC" className="w-7 h-5" />
          <div className="text-center text-white text-lg font-semibold font-['Red_Hat_Display'] leading-7">
            Captions
          </div>
        </div>
      </div>

      {!isLanguageSelectorOpen && (
        <button
          onClick={onToggleLanguageSelector}
          className="w-full px-3 py-3 bg-white rounded-bl-2xl rounded-br-2xl backdrop-blur-lg hover:bg-gray-50 transition-colors flex items-center gap-2 shadow-md">
          <div
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors"
            style={{backgroundColor: "#6DAEA6"}}
            title="Connected"
          />

          <div className="relative flex-1 min-w-0">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-r from-white to-transparent pointer-events-none z-10" />

            <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
              <div className="px-0"></div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#6DAEA6] rounded-full flex-shrink-0">
                <span className="text-base">
                  {settings.language === "auto" ? "🏳️" : getFlagEmoji(settings.language)}
                </span>
                <span className="text-sm font-semibold text-white font-['Red_Hat_Display']">
                  {settings.language === "auto" ? "Auto" : getLanguageName(settings.language)}
                </span>
              </div>

              {settings.languageHints.map((hint) => (
                <div key={hint} className="flex items-center gap-2 px-3 py-1.5 bg-[#6DAEA6] rounded-full flex-shrink-0">
                  <span className="text-base">{getFlagEmoji(hint)}</span>
                  <span className="text-sm font-semibold text-white font-['Red_Hat_Display']">
                    {getLanguageName(hint)}
                  </span>
                </div>
              ))}
              <div className="px-0"></div>
            </div>

            <div className="absolute right-0 top-0 bottom-0 w-1 bg-gradient-to-l from-white to-transparent pointer-events-none z-10" />
          </div>

          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="flex-shrink-0">
            <path
              d="M6 9L12 15L18 9"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-gray-600"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
