import {useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import {BottomNav} from "./components/BottomNav"
import {Header} from "./components/Header"
import {LanguageSelector} from "./components/LanguageSelector"
import {Settings} from "./components/Settings"
import {TranscriptList} from "./components/TranscriptList"
import {useDeveloperMode} from "./hooks/useDeveloperMode"
import {useSettings} from "./hooks/useSettings"
import {useTranscripts} from "./hooks/useTranscripts"

/**
 * App — the WebView root for the local captions miniapp.
 *
 * Identical layout/behavior to the cloud app's webview, with the transport
 * seam swapped: useSettings/useTranscripts now read/write the background
 * channel bus (mentra.on / mentra.send) instead of SSE + REST. The
 * @mentra/react useMentraAuth/frontendToken plumbing is gone — there is no
 * cross-origin backend to authenticate against in the local runtime.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<"captions" | "settings">("captions")
  const [showLanguageSelector, setShowLanguageSelector] = useState(false)
  const isDark = useColorScheme() === "dark"
  const {insets} = useSafeArea()
  const {developerMode, holdHandlers} = useDeveloperMode()
  const {
    settings,
    updateLanguage,
    updateHints,
    updateUseOfflineStt,
    updateDisplayLines,
    updateDisplayWidth,
    updateWordBreaking,
    updateCaptionTimeoutSeconds,
  } = useSettings()
  const {
    transcripts,
    connected,
    error,
    isRecording,
    toggleRecording,
    clearTranscripts,
    reconnect,
    displayPreview,
    cloudStatus,
  } = useTranscripts()

  const handleSaveLanguage = async (language: string, hints: string[]) => {
    await updateLanguage(language)
    await updateHints(hints)
    setShowLanguageSelector(false)
  }

  // Connection-status theming (baby blue when WS-connected, slate gray when
  // offline/unavailable, etc.) is a debug affordance — gate it behind
  // developer mode alongside the CloudStatusFooter below. Everyone else gets
  // the stable brand accent so the app bar/background don't flicker color with
  // cloud connectivity.
  const presentation = developerMode
    ? getCloudPresentation(cloudStatus, isDark)
    : {
        label: "",
        detail: "",
        accentColor: isDark ? "#365F5A" : "#6DAEA6",
        accentForeground: "#FFFFFF",
        dark: isDark,
      }

  return (
    <div
      className="w-screen h-screen flex overflow-hidden font-sans"
      style={{
        backgroundColor: presentation.accentColor,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="min-h-0 flex-1 bg-zinc-100 dark:bg-zinc-950 flex flex-col overflow-hidden">
        <Header
          connected={connected}
          accentColor={presentation.accentColor}
          accentForeground={presentation.accentForeground}
          error={error}
          settings={settings}
          onUpdateLanguage={updateLanguage}
          onUpdateHints={updateHints}
          onToggleLanguageSelector={() => setShowLanguageSelector(true)}
          onReconnect={reconnect}
          isLanguageSelectorOpen={showLanguageSelector}
        />

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden relative">
          {showLanguageSelector && settings ? (
            <LanguageSelector
              currentLanguage={settings.language}
              currentHints={settings.languageHints}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              onSave={handleSaveLanguage}
              onCancel={() => setShowLanguageSelector(false)}
            />
          ) : activeTab === "settings" ? (
            <Settings
              settings={settings}
              displayPreview={displayPreview}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              onUpdateUseOfflineStt={updateUseOfflineStt}
              onUpdateDisplayLines={updateDisplayLines}
              onUpdateDisplayWidth={updateDisplayWidth}
              onUpdateWordBreaking={updateWordBreaking}
              onUpdateCaptionTimeoutSeconds={updateCaptionTimeoutSeconds}
            />
          ) : (
            <TranscriptList
              transcripts={transcripts}
              isRecording={isRecording}
              onToggleRecording={toggleRecording}
              onClearTranscripts={clearTranscripts}
              accentColor={presentation.accentColor}
            />
          )}
        </div>

        {/* Bottom Navigation */}
        {!showLanguageSelector && (
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
      label: "Offline captions",
      detail: "Using on-device speech",
      accentColor: "#3F3F46",
      accentForeground: "#FFFFFF",
      dark: true,
    }
  }
  if (status.audioTransport === "ws") {
    return {
      label: "Cloud captions",
      detail: "WebSocket audio",
      accentColor: isDark ? "#36586B" : "#A7CDE3",
      accentForeground: isDark ? "#FFFFFF" : "#1F2937",
      dark: isDark,
    }
  }
  if (status.audioTransport === "udp") {
    return {
      label: "Cloud captions",
      detail: "UDP audio",
      accentColor: isDark ? "#365F5A" : "#6DAEA6",
      accentForeground: "#FFFFFF",
      dark: isDark,
    }
  }
  if (status.status === "connecting" || status.status === "reconnecting") {
    return {
      label: "Cloud reconnecting",
      detail: "Waiting for captions",
      accentColor: "#52525B",
      accentForeground: "#FFFFFF",
      dark: true,
    }
  }
  return {
    label: "Cloud unavailable",
    detail: "Captions may use fallback",
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
          : "bg-white/90 dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200"
      }`}>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{backgroundColor: accentColor, border: dark ? undefined : `1px solid ${accentForeground}22`}}
        />
        <span className="text-sm font-semibold truncate">{label}</span>
      </div>
      <span
        className={`text-xs font-medium flex-shrink-0 ${dark ? "text-zinc-300" : "text-zinc-500 dark:text-zinc-400"}`}>
        {detail}
      </span>
    </div>
  )
}
