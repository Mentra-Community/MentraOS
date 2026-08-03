import {useEffect, useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import {BottomNav, type Tab} from "./components/BottomNav"
import {Header} from "./components/Header"
import {ScriptView} from "./components/ScriptView"
import {SettingsView} from "./components/SettingsView"
import {useDeveloperMode} from "./hooks/useDeveloperMode"
import {useTeleprompter} from "./hooks/useTeleprompter"
import {HEADER_FROM, HEADER_TO} from "./lib/theme"

/**
 * App — the WebView root for the teleprompter miniapp.
 *
 * The background JSContext owns all teleprompter logic; this UI is a thin
 * control surface over the channel bus. Two tabs: the Script cockpit
 * (preview + transport + editor) and Settings.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<Tab>("script")
  const scheme = useColorScheme()
  const {insets} = useSafeArea()

  // Mirror the host-reported color scheme onto <html> so `.dark` CSS variable
  // overrides and Tailwind `dark:` variants activate together.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark")
  }, [scheme])
  const {developerMode, holdHandlers} = useDeveloperMode()
  const tp = useTeleprompter()

  return (
    <div
      className="w-screen h-screen flex overflow-hidden font-sans"
      style={{
        backgroundImage: `linear-gradient(90deg, ${HEADER_FROM}, ${HEADER_TO})`,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      <div className="min-h-0 flex-1 bg-zinc-100 dark:bg-zinc-950 flex flex-col overflow-hidden">
        <Header connected={tp.connected} />

        <div className="flex-1 min-h-0 overflow-hidden">
          {!tp.settings ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-zinc-400 dark:text-zinc-500 text-sm">Loading…</p>
            </div>
          ) : activeTab === "settings" ? (
            <SettingsView
              settings={tp.settings}
              onSetWpm={tp.setWpm}
              onSetLines={tp.setLines}
              onSetWidth={tp.setWidth}
              onSetAutoRestart={tp.setAutoRestart}
              onSetShowTimecode={tp.setShowTimecode}
            />
          ) : (
            <ScriptView
              settings={tp.settings}
              status={tp.status}
              onSetScript={tp.setScript}
              onPlay={tp.play}
              onPause={tp.pause}
              onRestart={tp.restart}
              onSeek={tp.seek}
              onNudge={tp.nudge}
              onSetVoiceFollow={tp.setVoiceFollow}
            />
          )}
        </div>

        {developerMode && tp.status && (
          <div className="w-full px-4 py-1.5 bg-zinc-900 text-zinc-300 text-[11px] font-mono flex items-center justify-between">
            <span>
              w {tp.status.wordIndex}/{tp.status.totalWords} · ln {tp.status.topLine}/{tp.status.totalLines}
            </span>
            <span>
              {tp.status.state}
              {tp.status.voiceMode ? " · voice" : " · timed"} · disp {tp.status.hasDisplay ? "1" : "0"}
            </span>
          </div>
        )}

        <BottomNav activeTab={activeTab} onTabChange={setActiveTab} settingsHoldHandlers={holdHandlers} />
      </div>
    </div>
  )
}

export default App
