import {useState} from "react"
import {Volume2} from "lucide-react"
import {DebugButton} from "./DebugButton"
import "../../../shared/channels"

interface TtsTestButtonProps {
  /** Optional log sink — every step of the test is reported here. */
  onLog?: (message: string) => void
}

const TEST_PHRASE =
  "This is a Mentra A I text to speech test. If you can hear this, the speak function works."

/**
 * One-click TTS test. Ported from the cloud version: instead of POST /api/speak
 * it calls the `debug:speak` channel RPC, which runs session.speaker.speak() on
 * the background and reports the device outcome + capabilities back here.
 */
export function TtsTestButton({onLog}: TtsTestButtonProps) {
  const [busy, setBusy] = useState(false)

  const log = (msg: string) => {
    console.log(`[TTS-TEST] ${msg}`)
    onLog?.(msg)
  }

  const runTest = async () => {
    setBusy(true)
    log("🔊 TTS test: sending fixed phrase…")
    try {
      const t0 = performance.now()
      const data = await mentra.request("debug:speak", {text: TEST_PHRASE})
      const ms = Math.round(performance.now() - t0)

      const caps = data.capabilities
      log(
        `🎛️ glasses: model=${caps.modelName ?? "?"} hasSpeaker=${caps.hasSpeaker} hasDisplay=${caps.hasDisplay}`,
      )

      if (!data.accepted) {
        log(`❌ TTS test: not played — ${data.error ?? "unknown error"}`)
      } else if (data.completed === true) {
        log(`👂 TTS test: glasses confirmed playback (${ms}ms) — you should have heard it.`)
      } else if (data.completed === false) {
        log("🔇 TTS test: playback was interrupted before finishing.")
      } else {
        log("📤 TTS test: request sent to glasses (no playback confirmation).")
      }

      if (caps.hasSpeaker === false) {
        log("🔇 Note: glasses report NO speaker — that device cannot play audio.")
      }
    } catch (error) {
      log(`❌ TTS test: request failed — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DebugButton onClick={runTest} disabled={busy}>
      <Volume2 className={`w-3.5 h-3.5 ${busy ? "animate-pulse" : ""}`} />
      <span>{busy ? "Testing TTS…" : "Run TTS test"}</span>
    </DebugButton>
  )
}
