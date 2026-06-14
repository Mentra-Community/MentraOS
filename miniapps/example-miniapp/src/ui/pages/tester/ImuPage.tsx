// Tester page — diagnostic surface, ephemeral by design.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/ui"

import {useTester} from "../../hooks/useTester"
import {Shell} from "../Shell"
import {Button} from "../../components/button"
import {ErrorRow, TableRow} from "./_TesterRow"

export default function ImuPage() {
  const navigate = useNavigate()
  const {latestByKind, log, invoke, lastError} = useTester("imu")

  // The IMU tester subscribes to both head-pose and raw accel; the controller
  // tags them with distinct kinds ("head" / "accel") so each gets its own row.
  const head = latestByKind("head")
  const accel = latestByKind("accel")

  // Explicit IMU control via session.imu.setEnabled(). The accel stream also
  // auto-enables on subscribe, so these are an override / diagnostic.
  const [imuEnabled, setImuEnabled] = useState(true)
  const setEnabled = async (next: boolean) => {
    try {
      await invoke("setEnabled", [next])
      setImuEnabled(next)
    } catch {
      // Leave the toggle as-is on failure; the error is surfaced via
      // lastError → ErrorRow. The catch also prevents an unhandled rejection.
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.imu" onBack={() => navigate("/")} />
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Head pose + raw accelerometer from the glasses IMU.
        </p>
        <TableRow
          emoji="🧭"
          label=".onHeadPosition()"
          data={head ? ((head.payload as unknown) as Record<string, unknown>) : null}
        />
        <TableRow
          emoji="📈"
          label=".onAccel() — x/y/z (g)"
          data={accel ? ((accel.payload as unknown) as Record<string, unknown>) : null}
        />
        <div className="mt-3 flex flex-row gap-2">
          <Button
            disabled={imuEnabled}
            onClick={() => setEnabled(true)}
          >
            Enable IMU
          </Button>
          <Button
            variant="destructive"
            disabled={!imuEnabled}
            onClick={() => setEnabled(false)}
          >
            Disable IMU
          </Button>
        </div>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
