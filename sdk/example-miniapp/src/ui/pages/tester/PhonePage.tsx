// Tester page — phone-side surfaces (notifications, battery, etc.).

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {TableRow} from "./_TesterRow"

export default function PhonePage() {
  const navigate = useNavigate()
  const {log} = useTester("phone")
  const lastNotif = [...log].reverse().find((e) => e.kind === "notification")
  const lastBattery = [...log].reverse().find((e) => e.kind === "battery")
  return (
    <Shell>
      <MiniappHeader title="session.phone" onBack={() => navigate("/tester")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Phone-side surfaces — notifications, battery, calendar.
          <span className="block mt-2">
            For URL opening / share / clipboard / download see
            <span className="font-mono mx-1">session.system</span>.
          </span>
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
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
