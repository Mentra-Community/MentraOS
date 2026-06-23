import {useEffect, useState} from "react"
import {Sparkles, X} from "lucide-react"
import {DebugButton} from "./DebugButton"

interface WakeGlowButtonProps {
  onLog?: (message: string) => void
}

declare global {
  interface Window {
    /** Force the chromatic activation ring on (true) or off (false). No auto-revert. */
    __setDevWakeWord?: (on: boolean) => void
  }
}

/**
 * Toggles the activation glow (the chromatic ring around the chat) on/off so a
 * developer can preview the wake-word UI without saying the wake phrase.
 * Local-only — no network round-trip. ChatInterface installs the
 * `__setDevWakeWord` hook on window.
 */
export function WakeGlowButton({onLog}: WakeGlowButtonProps) {
  const [on, setOn] = useState(false)

  const log = (msg: string) => {
    console.log(`[WAKE-GLOW] ${msg}`)
    onLog?.(msg)
  }

  useEffect(() => {
    return () => {
      window.__setDevWakeWord?.(false)
    }
  }, [])

  const toggle = () => {
    const set = window.__setDevWakeWord
    if (!set) {
      log("⚠️ Wake glow hook not installed yet — open the chat first.")
      return
    }
    const next = !on
    set(next)
    setOn(next)
    log(next ? "✨ Wake glow ON" : "🌑 Wake glow OFF")
  }

  return (
    <DebugButton variant={on ? "destructive" : "default"} onClick={toggle}>
      {on ? <X className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
      <span>{on ? "Stop wake glow" : "Trigger wake glow"}</span>
    </DebugButton>
  )
}
