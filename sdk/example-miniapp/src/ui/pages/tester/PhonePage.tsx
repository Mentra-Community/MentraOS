// Tester page — phone-side surfaces (notifications, battery, etc.).

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {TableRow} from "./_TesterRow"

export default function PhonePage() {
  const navigate = useNavigate()
  const {log, fire} = useTester("phone")
  const lastNotif = [...log].reverse().find((e) => e.kind === "notification")
  const lastBattery = [...log].reverse().find((e) => e.kind === "battery")
  return (
    <Shell>
      <MiniappHeader title="session.phone" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Phone-side surfaces — notifications, battery, calendar.
        </p>
        <TableRow
          emoji="🔔"
          label="last .onNotification()"
          data={lastNotif ? ((lastNotif.payload as unknown) as Record<string, unknown>) : null}
        />
        <TableRow
          emoji="🔋"
          label="last .onBattery()"
          data={lastBattery ? ((lastBattery.payload as unknown) as Record<string, unknown>) : null}
        />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => fire("openUrl", ["https://mentra.glass"])}>
            openUrl("https://mentra.glass")
          </Button>
        </div>
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
