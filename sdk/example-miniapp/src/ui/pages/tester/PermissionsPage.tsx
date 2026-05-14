// Tester page — diagnostic surface, ephemeral by design.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {TableRow} from "./_TesterRow"

export default function PermissionsPage() {
  const navigate = useNavigate()
  const {latest, log, fire} = useTester("permissions")
  return (
    <Shell>
      <MiniappHeader title="session.permissions" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Declared permission set + grant state, streamed via
          `.onUpdate(handler)`.
        </p>
        <TableRow
          emoji="🔐"
          label="latest .onUpdate()"
          data={latest ? ((latest.payload as unknown) as Record<string, unknown>) : null}
        />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => fire("getAll", [])}>getAll()</Button>
          <Button onClick={() => fire("request", ["MICROPHONE"])}>
            request("MICROPHONE")
          </Button>
        </div>
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
