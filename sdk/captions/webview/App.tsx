import {useState} from "react"

import {useMentra} from "@mentra/miniapp/framework/react"

import type * as Client from "../client"
import type {AppState} from "../shared/types"

import {BottomNav} from "./components/BottomNav"
import {Header} from "./components/Header"
import {LanguageSelector} from "./components/LanguageSelector"
import {Settings} from "./components/Settings"
import {TranscriptList} from "./components/TranscriptList"

export default function App() {
  const {state, client} = useMentra<AppState, typeof Client>()
  const [activeTab, setActiveTab] = useState<"captions" | "settings">("captions")
  const [showLanguageSelector, setShowLanguageSelector] = useState(false)

  const {settings, transcripts, displayPreview} = state

  const handleSaveLanguage = async (language: string, hints: string[]) => {
    await client.setLanguage(language)
    await client.setLanguageHints(hints)
    setShowLanguageSelector(false)
  }

  return (
    <div className="w-screen h-screen bg-zinc-100 flex flex-col overflow-hidden font-sans">
      <Header
        settings={settings}
        onToggleLanguageSelector={() => setShowLanguageSelector(true)}
        isLanguageSelectorOpen={showLanguageSelector}
      />

      <div className="flex-1 overflow-hidden relative">
        {showLanguageSelector ? (
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
            onUpdateDisplayLines={client.setDisplayLines}
            onUpdateDisplayWidth={client.setDisplayWidth}
          />
        ) : (
          <TranscriptList transcripts={transcripts} onClear={() => client.clearTranscripts()} />
        )}
      </div>

      {!showLanguageSelector && <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />}
    </div>
  )
}
