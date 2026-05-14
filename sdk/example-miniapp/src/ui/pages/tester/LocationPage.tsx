// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {TableRow} from "./_TesterRow"

export default function LocationPage() {
  const navigate = useNavigate()
  const {latest, log, fire} = useTester("location")
  return (
    <Shell>
      <MiniappHeader title="session.location" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          GPS coordinates streamed from the phone.
        </p>
        <TableRow
          emoji="📍"
          label="latest .onUpdate()"
          data={latest ? ((latest.payload as unknown) as Record<string, unknown>) : null}
        />
        <Button className="mt-3" onClick={() => fire("getOnce", [])}>
          Request a one-shot fix
        </Button>
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
