// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {TableRow} from "./_TesterRow"

export default function TranslationPage() {
  const navigate = useNavigate()
  const {latest, log} = useTester("translation")
  return (
    <Shell>
      <MiniappHeader title="session.translation" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Translated speech stream. Background subscribes via
          `session.translation.on(...)`; events stream back as `tester:event`.
        </p>
        <TableRow
          emoji="🌐"
          label="latest"
          data={latest ? ((latest.payload as unknown) as Record<string, unknown>) : null}
        />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
