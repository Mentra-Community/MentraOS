import { useState } from "react"

import { BottomNav } from "./components/BottomNav"
import { Header } from "./components/Header"
import { LanguageSelector } from "./components/LanguageSelector"
import { Settings } from "./components/Settings"
import { TranscriptList } from "./components/TranscriptList"
import { useSettings } from "./hooks/useSettings"
import { useTranscripts } from "./hooks/useTranscripts"
import "./index.css"

export function App() {
  const [activeTab, setActiveTab] = useState<"captions" | "settings">("captions")
  const [showLanguageSelector, setShowLanguageSelector] = useState(false)
  const {
    settings,
    loading: settingsLoading,
    updateLanguage,
    updateHints,
    updateDisplayLines,
    updateDisplayWidth,
  } = useSettings()
  const { transcripts, connected, error, isRecording, toggleRecording, clearTranscripts, reconnect, displayPreview } = useTranscripts()

  const handleSaveLanguage = async (language: string, hints: string[]) => {
    await updateLanguage(language)
    await updateHints(hints)
    setShowLanguageSelector(false)
  }

  return (
    <div className="w-screen h-screen bg-zinc-100 flex flex-col overflow-hidden font-sans">
      {/* Header */}
      {/* {!showLanguageSelector && ( */}
      {!false && (
        <Header
          connected={connected}
          error={error}
          settings={settings}
          onUpdateLanguage={updateLanguage}
          onUpdateHints={updateHints}
          onToggleLanguageSelector={() => setShowLanguageSelector(true)}
          onReconnect={reconnect}
          isLanguageSelectorOpen={showLanguageSelector}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden relative">
        {showLanguageSelector && settings ? (
          <LanguageSelector
            currentLanguage={settings.language}
            currentHints={settings.languageHints}
            onSave={handleSaveLanguage}
            onCancel={() => setShowLanguageSelector(false)}
          />
        ) : activeTab === "settings" ? (
          <Settings
            settings={settings}
            displayPreview={displayPreview}
            onUpdateDisplayLines={updateDisplayLines}
            onUpdateDisplayWidth={updateDisplayWidth}
          />
        ) : (
          <TranscriptList
            transcripts={transcripts}
            isRecording={isRecording}
            onToggleRecording={toggleRecording}
            onClearTranscripts={clearTranscripts}
          />
        )}
      </div>

      {/* Bottom Navigation */}
      {!showLanguageSelector && <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />}
    </div>
  )
}
export default App
