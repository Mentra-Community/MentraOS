import {useState} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import {BottomNav} from "./components/BottomNav"
import {Header} from "./components/Header"
import {LanguageSelector} from "./components/LanguageSelector"
import {Settings} from "./components/Settings"
import {TranscriptList} from "./components/TranscriptList"
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
  const {insets} = useSafeArea()
  const {settings, updateLanguage, updateHints, updateDisplayLines, updateDisplayWidth, updateWordBreaking} =
    useSettings()
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

  const presentation = getCloudPresentation(cloudStatus)

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
      <div className="min-h-0 flex-1 bg-zinc-100 flex flex-col overflow-hidden">
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
              onUpdateDisplayLines={updateDisplayLines}
              onUpdateDisplayWidth={updateDisplayWidth}
              onUpdateWordBreaking={updateWordBreaking}
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
            <CloudStatusFooter
              label={presentation.label}
              detail={presentation.detail}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
              dark={presentation.dark}
            />
            <BottomNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              accentColor={presentation.accentColor}
              accentForeground={presentation.accentForeground}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default App

function getCloudPresentation(cloudStatus?: {status: string; audioTransport: string}): {
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
      accentColor: "#A7CDE3",
      accentForeground: "#1F2937",
      dark: false,
    }
  }
  if (status.audioTransport === "udp") {
    return {
      label: "Cloud captions",
      detail: "UDP audio",
      accentColor: "#6DAEA6",
      accentForeground: "#FFFFFF",
      dark: false,
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
        dark ? "bg-zinc-900 border-zinc-800 text-white" : "bg-white/90 border-zinc-200 text-zinc-800"
      }`}>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{backgroundColor: accentColor, border: dark ? undefined : `1px solid ${accentForeground}22`}}
        />
        <span className="text-sm font-semibold truncate">{label}</span>
      </div>
      <span className={`text-xs font-medium flex-shrink-0 ${dark ? "text-zinc-300" : "text-zinc-500"}`}>{detail}</span>
    </div>
  )
}
