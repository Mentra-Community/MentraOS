import {useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import {BottomNav} from "./components/BottomNav"
import {Header} from "./components/Header"
import {Settings} from "./components/Settings"
import {TargetLanguageSelector} from "./components/TargetLanguageSelector"
import {TranslationList} from "./components/TranslationList"
import {useDeveloperMode} from "./hooks/useDeveloperMode"
import {useSettings} from "./hooks/useSettings"
import {useTranslations} from "./hooks/useTranslations"

/**
 * App — the WebView root for the local translation miniapp.
 *
 * Identical layout/behavior to the cloud app's webview, with the transport
 * seam swapped: useSettings/useTranslations now read/write the background
 * channel bus (mentra.on / mentra.send) instead of SSE + REST. The
 * @mentra/react useMentraAuth/frontendToken plumbing is gone — there is no
 * cross-origin backend to authenticate against in the local runtime.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<"translation" | "settings">("translation")
  const [showTargetLanguageSelector, setShowTargetLanguageSelector] = useState(false)
  const isDark = useColorScheme() === "dark"
  const {insets} = useSafeArea()
  const {developerMode, holdHandlers} = useDeveloperMode()
  const {
    settings,
    updateTargetLanguage,
    updateDisplayLines,
    updateDisplayWidth,
    updateWordBreaking,
    updateShowOriginalText,
    updateGlassesDisplayMode,
  } = useSettings()
  const {
    translations,
    connected,
    error,
    isRecording,
    toggleRecording,
    clearTranslations,
    reconnect,
    displayPreview,
    cloudStatus,
  } = useTranslations()

  const handleSaveTargetLanguage = async (targetLanguage: string) => {
    await updateTargetLanguage(targetLanguage)
    setShowTargetLanguageSelector(false)
  }

  const presentation = getCloudPresentation(cloudStatus, isDark)
  const appBarBackground = isDark ? "#174A73" : "#2089F3"

  return (
    <div
      className="w-screen h-screen flex overflow-hidden font-sans"
      style={{
        // Paint the safe-area insets with the app-bar surface so the status-bar
        // area blends into the header instead of showing the cloud-status color.
        backgroundColor: appBarBackground,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="min-h-0 flex-1 bg-zinc-100 dark:bg-zinc-950 flex flex-col overflow-hidden">
        <Header
          connected={connected}
          appBarBackground={appBarBackground}
          accentColor={presentation.accentColor}
          accentForeground={presentation.accentForeground}
          error={error}
          settings={settings}
          onToggleTargetLanguageSelector={() => setShowTargetLanguageSelector(true)}
          onReconnect={reconnect}
          isTargetLanguageSelectorOpen={showTargetLanguageSelector}
        />

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden relative">
          {showTargetLanguageSelector && settings ? (
            <TargetLanguageSelector
              currentTargetLanguage={settings.targetLanguage}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              onSave={handleSaveTargetLanguage}
              onCancel={() => setShowTargetLanguageSelector(false)}
            />
          ) : activeTab === "settings" ? (
            <Settings
              settings={settings}
              displayPreview={displayPreview}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              onUpdateDisplayLines={updateDisplayLines}
              onUpdateDisplayWidth={updateDisplayWidth}
              onUpdateWordBreaking={updateWordBreaking}
              onUpdateShowOriginalText={updateShowOriginalText}
              onUpdateGlassesDisplayMode={updateGlassesDisplayMode}
            />
          ) : (
            <TranslationList
              translations={translations}
              isRecording={isRecording}
              onToggleRecording={toggleRecording}
              onClearTranslations={clearTranslations}
              accentColor={presentation.accentColor}
              showOriginalText={settings?.showOriginalText ?? true}
            />
          )}
        </div>

        {/* Bottom Navigation */}
        {!showTargetLanguageSelector && (
          <div className="w-full flex flex-col">
            {developerMode && (
              <CloudStatusFooter
                label={presentation.label}
                detail={presentation.detail}
                accentColor={presentation.accentColor}
                accentForeground={presentation.accentForeground}
                dark={presentation.dark}
              />
            )}
            <BottomNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              settingsHoldHandlers={holdHandlers}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default App

function getCloudPresentation(
  cloudStatus: {status: string; audioTransport: string} | undefined,
  isDark: boolean,
): {
  label: string
  detail: string
  accentColor: string
  accentForeground: string
  dark: boolean
} {
  const status = cloudStatus ?? {status: "disconnected", audioTransport: "none"}
  if (status.audioTransport === "offline") {
    return {
      label: "Cloud unavailable",
      detail: "Translation needs cloud",
      accentColor: "#3F3F46",
      accentForeground: "#FFFFFF",
      dark: true,
    }
  }
  if (status.audioTransport === "ws") {
    return {
      label: "Cloud translation",
      detail: "WebSocket audio",
      accentColor: isDark ? "#285A7D" : "#A9D4FB",
      accentForeground: isDark ? "#FFFFFF" : "#1F2937",
      dark: isDark,
    }
  }
  if (status.audioTransport === "udp") {
    return {
      label: "Cloud translation",
      detail: "UDP audio",
      accentColor: isDark ? "#174A73" : "#2089F3",
      accentForeground: "#FFFFFF",
      dark: isDark,
    }
  }
  if (status.status === "connecting" || status.status === "reconnecting") {
    return {
      label: "Cloud reconnecting",
      detail: "Waiting for translation",
      accentColor: "#52525B",
      accentForeground: "#FFFFFF",
      dark: true,
    }
  }
  return {
    label: "Cloud unavailable",
    detail: "Translation needs cloud",
    accentColor: "#52525B",
    accentForeground: "#FFFFFF",
    dark: true,
  }
}

function CloudStatusFooter({
  label,
  detail,
  accentColor,
  accentForeground,
  dark,
}: {
  label: string
  detail: string
  accentColor: string
  accentForeground: string
  dark: boolean
}) {
  return (
    <div
      className={`w-full px-5 py-2 border-t flex items-center justify-between gap-3 ${
        dark
          ? "bg-zinc-900 border-zinc-800 text-white"
          : "bg-white/90 border-zinc-200 text-zinc-800 dark:bg-zinc-900/90 dark:border-zinc-800 dark:text-zinc-200"
      }`}>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{backgroundColor: accentColor, border: dark ? undefined : `1px solid ${accentForeground}22`}}
        />
        <span className="text-sm font-semibold truncate">{label}</span>
      </div>
      <span className={`text-xs font-medium flex-shrink-0 ${dark ? "text-zinc-300" : "text-zinc-500 dark:text-zinc-400"}`}>
        {detail}
      </span>
    </div>
  )
}
