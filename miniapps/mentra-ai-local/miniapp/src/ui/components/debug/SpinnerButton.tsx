import {useState} from "react"
import {Loader2, X} from "lucide-react"
import {DebugButton} from "./DebugButton"
import "../../../shared/channels"

interface SpinnerButtonProps {
  onLog?: (message: string) => void
}

/**
 * Toggles a 30×30 bitmap spinner animation pinned to the bottom-right of the
 * glasses HUD. Routes through the `debug:spinner` RPC; the background
 * DisplayManager cycles the pre-encoded BMP frames onto the display.
 */
export function SpinnerButton({onLog}: SpinnerButtonProps) {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)

  const log = (msg: string) => {
    console.log(`[SPINNER] ${msg}`)
    onLog?.(msg)
  }

  const toggle = async () => {
    setBusy(true)
    const next = !on
    try {
      const {running, error} = await mentra.request("debug:spinner", {
        action: next ? "start" : "stop",
      })
      setOn(running)
      if (error) {
        log(`❌ Spinner: ${error}`)
      } else {
        log(running ? "🌀 Spinner ON (bottom-right of HUD)" : "⏹️ Spinner OFF")
      }
    } catch (error) {
      log(`❌ Spinner request failed — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DebugButton variant={on ? "destructive" : "default"} onClick={toggle} disabled={busy}>
      {on ? (
        <X className="w-3.5 h-3.5" />
      ) : (
        <Loader2 className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
      )}
      <span>{on ? "Stop spinner" : "Show HUD spinner"}</span>
    </DebugButton>
  )
}
