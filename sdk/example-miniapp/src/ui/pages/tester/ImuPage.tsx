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
  // auto-enables on subscribe, so this toggle is an override / diagnostic.
  const [imuEnabled, setImuEnabled] = useState(true)
  const toggleImu = async () => {
    const next = !imuEnabled
    await invoke("setEnabled", [next])
    setImuEnabled(next)
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
        <Button
          className="mt-3"
          variant={imuEnabled ? "secondary" : "default"}
          onClick={toggleImu}
        >
          {imuEnabled ? "Disable IMU" : "Enable IMU"} · setEnabled({String(!imuEnabled)})
        </Button>
        <ErrorRow event={lastError} />
        <p className="mt-3 text-[12px] text-muted-foreground">{log.length} event(s) seen</p>
      </div>
    </Shell>
  )
}
