// Test-only stdio peer. Never starts Codex or calls GitHub.
import {spawn} from "node:child_process"
import {appendFileSync, readFileSync, writeFileSync} from "node:fs"
import {join} from "node:path"
import {createInterface} from "node:readline"

const state = process.env.FAKE_STATE
const mode = process.env.FAKE_CODEX_MODE ?? "ok"
const calls = join(state, "codex-calls")
let count = 0
try { count = Number(readFileSync(calls, "utf8")) } catch {}
writeFileSync(calls, String(count + 1))
writeFileSync(join(state, "server-env.json"), JSON.stringify({
  marker: process.env.CODEX_REVIEW_ATTEMPT,
  postingTokenPresent: Boolean(process.env.GH_TOKEN),
}))
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const reply = (message, result) => send({id: message.id, result})
const notify = (method, params) => send({method, params})
const final = {type: "agentMessage", id: "message-final", phase: "final_answer", text: "Approve. reviewed"}
const post = () => writeFileSync(join(state, "receipts"), "1")
function leaveChild(stdio = "ignore") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached: true, stdio})
  child.unref()
  appendFileSync(join(state, "grandchildren"), `${child.pid}\n`)
}
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line)
  appendFileSync(join(state, "requests.jsonl"), `${line}\n`)
  if (message.method === "initialize") {
    if (mode === "rpc-error") send({id: message.id, error: {code: -32602, message: "Rejected initialize"}})
    else if (mode === "malformed-error") send({id: message.id, error: {code: -32602}})
    else if (mode === "invalid-json") process.stdout.write("not json\n")
    else reply(message, {userAgent: "test fixture"})
  } else if (message.method === "thread/start") {
    reply(message, {thread: {
      id: "thread-1", cwd: mode === "wrong-project" ? "/wrong" : message.params.cwd,
      projectId: message.params.projectId ?? null,
      source: mode === "exec-source" ? "exec" : "vscode", ephemeral: false,
    }})
  } else if (message.method === "thread/name/set") {
    reply(message, {})
  } else if (message.method === "turn/start") {
    const start = () => reply(message, {turn: {id: "turn-1", status: "inProgress", items: []}})
    if (mode !== "terminal-before-response") start()
    if (mode === "eof") process.exit(1)
    if (mode === "post-then-crash") { post(); process.exit(1) }
    if (mode === "success-with-child") leaveChild(["ignore", "inherit", "inherit"])
    if (mode === "hang" || mode === "orphan") {
      leaveChild()
      if (mode === "orphan") process.exit(1)
      continue
    }
    if (mode === "client-request") {
      send({id: "server-request", method: "item/tool/requestUserInput", params: {}})
      continue
    }
    const threadId = mode === "wrong-thread" ? "other-thread" : "thread-1"
    const turnId = mode === "wrong-turn" ? "other-turn" : "turn-1"
    const item = mode === "commentary-only" ? {...final, phase: "commentary"}
      : mode === "legacy-phase" ? {...final, phase: null} : final
    notify("item/completed", {threadId, turnId, item: {type: "agentMessage", id: "progress", phase: "commentary", text: "Working"}})
    if (mode !== "terminal-items-only" && mode !== "missing-final") notify("item/completed", {threadId, turnId, item})
    if (mode === "heartbeat-hang") {
      setInterval(() => notify("thread/tokenUsage/updated", {threadId}), 100)
      continue
    }
    notify("turn/completed", {threadId, turn: {
      id: turnId, status: mode === "failed-turn" ? "failed" : "completed", error: null,
      items: mode === "terminal-items-only" ? [item] : [],
    }})
    if (mode === "terminal-before-response") start()
    post()
  } else if (message.method === "turn/interrupt") {
    reply(message, {})
  }
}
