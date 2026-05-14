// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {Row, TableRow} from "./_TesterRow"

export default function MicrophonePage() {
  const navigate = useNavigate()
  const {log, fire} = useTester("mic")
  const lastAudio = [...log].reverse().find((e) => e.kind === "audio")
  const lastVad = [...log].reverse().find((e) => e.kind === "vad")
  return (
    <Shell>
      <MiniappHeader title="session.mic" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Audio chunks + VAD from the glasses mic.
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
        <Button className="mt-3" onClick={() => fire("requestPermission", [])}>
          Request mic permission
        </Button>
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
