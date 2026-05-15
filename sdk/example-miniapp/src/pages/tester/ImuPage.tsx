// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Shell} from "../Shell"
import {Row} from "./_TesterRow"

export default function ImuPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [headPos, setHeadPos] = useState("(unknown)")
  const [updateCount, setUpdateCount] = useState(0)

  useEffect(() => {
    const unsub = session.imu.onHeadPosition((d) => {
      setHeadPos(d.position ?? "?")
      setUpdateCount((n) => n + 1)
    })
    return () => unsub()
  }, [session])

  return (
    <Shell>
      <MiniappHeader title="session.imu" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Head pose / motion. Today only <code className="font-mono">onHeadPosition</code> is wired —
          quaternions, raw gyro, etc. land in a future round.
        </p>

        <Row emoji="↕️" label=".onHeadPosition(handler)" value={headPos} />
        <Row emoji="🔢" label="Updates received" value={String(updateCount)} mono />
      </div>
    </Shell>
  )
}
