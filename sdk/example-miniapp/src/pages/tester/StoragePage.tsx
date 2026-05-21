// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useEffect, useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Shell} from "../Shell"

export default function StoragePage() {
  const session = useSession()
  const navigate = useNavigate()

  const [key, setKey] = useState("my-key")
  const [value, setValue] = useState("hello world")
  const [getResult, setGetResult] = useState<string | null>(null)
  const [allKeys, setAllKeys] = useState<string[]>([])
  const [log, setLog] = useState<string[]>([])

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 20))

  const refreshList = async () => {
    try {
      const keys = await session.storage.list()
      setAllKeys(keys)
      appendLog(`list() → ${keys.length} key${keys.length !== 1 ? "s" : ""}`)
    } catch (err) {
      appendLog(`list() error: ${String(err)}`)
    }
  }

  useEffect(() => {
    void refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSet = async () => {
    try {
      await session.storage.set(key, value)
      appendLog(`set("${key}", "${value}") ✓`)
      void refreshList()
    } catch (err) {
      appendLog(`set error: ${String(err)}`)
    }
  }

  const handleGet = async () => {
    try {
      const v = await session.storage.get(key)
      setGetResult(v)
      appendLog(`get("${key}") → ${v === null ? "null" : JSON.stringify(v)}`)
    } catch (err) {
      appendLog(`get error: ${String(err)}`)
    }
  }

  const handleDelete = async () => {
    try {
      await session.storage.delete(key)
      appendLog(`delete("${key}") ✓`)
      void refreshList()
    } catch (err) {
      appendLog(`delete error: ${String(err)}`)
    }
  }

  return (
    <Shell>
      <MiniappHeader title="session.storage" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-4 text-[13px] text-muted-foreground">
          Phone-local storage scoped to this miniapp. Values survive app reloads (but not uninstall).
          Round-trip test: set a key, reload the miniapp (re-scan QR), then get — the value should still be there.
        </p>

        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
          <Label htmlFor="key">Key</Label>
          <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} />
          <Label htmlFor="val" className="mt-2">Value</Label>
          <Input id="val" value={value} onChange={(e) => setValue(e.target.value)} />

          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={handleSet}>Set</Button>
            <Button variant="outline" onClick={handleGet}>Get</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
            <Button variant="outline" onClick={refreshList}>Refresh</Button>
          </div>

          {getResult !== null && (
            <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-sm">
              <span className="text-muted-foreground">result: </span>
              <span className="font-mono">{JSON.stringify(getResult)}</span>
            </div>
          )}
        </div>

        <div className="mb-4 rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              Stored keys ({allKeys.length})
            </span>
          </div>
          {allKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet — hit Set above.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {allKeys.map((k) => (
                <button
                  key={k}
                  onClick={() => setKey(k)}
                  className="truncate rounded-md px-2 py-1 text-left font-mono text-[12px] hover:bg-accent">
                  {k}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Log
          </div>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {log.map((entry, i) => (
                <div key={i} className="font-mono text-[11px] text-foreground/80">{entry}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}
