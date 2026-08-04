// Tester page — diagnostic surface, ephemeral by design.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, Row, TableRow} from "./_TesterRow"

export default function MicrophonePage() {
  const navigate = useNavigate()
  const {log, latestByKind, invoke, lastError} = useTester("mic")
  const lastAudio = latestByKind("audio")
  const lastVad = latestByKind("vad")

  // Explicit glasses-side mic gates via session.mic setters. Local UI state
  // tracks the last successful invoke; failures leave the toggle as-is and
  // surface via lastError → ErrorRow.
  const [vadEnabled, setVadEnabledState] = useState(true)
  const [loudnessGateEnabled, setLoudnessGateState] = useState(true)

  const setVad = async (next: boolean) => {
    try {
      await invoke("setVoiceActivityDetectionEnabled", [next])
      setVadEnabledState(next)
    } catch {
      // Leave the toggle as-is on failure; the error is surfaced via
      // lastError → ErrorRow. The catch also prevents an unhandled rejection.
    }
  }

  const setLoudnessGate = async (next: boolean) => {
    try {
      await invoke("setLoudnessGateEnabled", [next])
      setLoudnessGateState(next)
    } catch {
      // Leave the toggle as-is on failure; the error is surfaced via
      // lastError → ErrorRow. The catch also prevents an unhandled rejection.
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.mic" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Audio chunks + VAD from the glasses mic, plus Mentra Live gate
          controls (VAD / Barrier). Requires
          <code className="mx-1">MICROPHONE</code>
          in the manifest — there is no runtime grant step.
        </p>
        <Row
          emoji="🎚️"
          label=".onVoiceActivity(handler) — latest"
          value={lastVad ? JSON.stringify(lastVad.payload) : "(none)"}
        />
        <TableRow
          emoji="🎵"
          label=".onAudioChunk(handler) — latest"
          data={lastAudio ? ((lastAudio.payload as unknown) as Record<string, unknown>) : null}
        />
        <p className="mt-4 mb-2 text-[13px] font-medium">.setVoiceActivityDetectionEnabled()</p>
        <div className="flex flex-row gap-2">
          <Button disabled={vadEnabled} onClick={() => setVad(true)}>
            Enable VAD
          </Button>
          <Button variant="destructive" disabled={!vadEnabled} onClick={() => setVad(false)}>
            Disable VAD
          </Button>
        </div>
        <p className="mt-4 mb-2 text-[13px] font-medium">.setLoudnessGateEnabled() — Barrier</p>
        <div className="flex flex-row gap-2">
          <Button disabled={loudnessGateEnabled} onClick={() => setLoudnessGate(true)}>
            Enable Barrier
          </Button>
          <Button
            variant="destructive"
            disabled={!loudnessGateEnabled}
            onClick={() => setLoudnessGate(false)}
          >
            Disable Barrier
          </Button>
        </div>
        <Button variant="destructive" className="mt-3" onClick={() => invoke("stop", []).catch(() => {})}>
          stop() — release all mic subscriptions
        </Button>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
