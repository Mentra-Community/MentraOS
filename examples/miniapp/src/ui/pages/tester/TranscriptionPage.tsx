// Tester page — diagnostic surface, ephemeral by design.
// Two-layer port: streams events from background via useTester("transcription").

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Row, TableRow} from "./_TesterRow"

export default function TranscriptionPage() {
  const navigate = useNavigate()
  const {latest, latestByKind} = useTester("transcription")
  const lastFinal = latestByKind("final")
  return (
    <Shell>
      <MiniappHeader title="session.transcription" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Live speech-to-text — background subscribes via `session.transcription.on(handler)`
          and forwards every event through the `tester:event` channel.
        </p>
        <Row
          emoji="🎙️"
          label="latest"
          value={
            latest
              ? `${latest.kind}: ${(latest.payload as {text: string})?.text ?? "—"}`
              : "(no events yet)"
          }
        />
        <TableRow
          emoji="✅"
          label="last final"
          data={lastFinal ? ((lastFinal.payload as unknown) as Record<string, unknown>) : null}
        />
      </div>
    </Shell>
  )
}
