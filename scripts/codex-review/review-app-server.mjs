#!/usr/bin/env node
// Optional transport for desktop-project reviews. The shell runner remains the
// owner of retries, deadlines, process-tree cleanup and GitHub verdict receipts.
import {spawn} from "node:child_process"
import {readFileSync, renameSync, writeFileSync} from "node:fs"

const [codex, project, checkout, output, promptFile, model, effort, name, projectId = ""] = process.argv.slice(2)
if (!codex || !project || !checkout || !output || !promptFile || !model || !effort || !name) {
  throw new Error("Usage: review-app-server.mjs <codex> <project> <checkout> <output> <prompt> <model> <effort> <name> [project-id]")
}
const prompt = readFileSync(promptFile, "utf8")
const child = spawn(codex, ["app-server", "--stdio"], {
  cwd: project,
  env: process.env, // Includes posting credentials and the watchdog's attempt marker.
  stdio: ["pipe", "pipe", "inherit"],
})
let nextId = 1
let threadId
let turnId
let stopped = false
let failure
let buffer = ""
const pending = new Map()
const turns = new Map()
let resolveCompletion
let rejectCompletion
const completion = new Promise((resolve, reject) => {
  resolveCompletion = resolve
  rejectCompletion = reject
})
// Protocol errors can arrive before run() starts waiting for the turn.
completion.catch(() => {})
const exited = new Promise((resolve) => {
  child.once("exit", resolve)
  child.once("error", resolve)
})
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 200
function fail(error) {
  if (failure) return
  failure = error instanceof Error ? error : new Error(String(error))
  for (const {reject} of pending.values()) reject(failure)
  pending.clear()
  rejectCompletion(failure)
}
function send(message) {
  if (failure) throw failure
  child.stdin.write(`${JSON.stringify(message)}\n`)
}
function request(method, params) {
  if (failure) return Promise.reject(failure)
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject})
    try { send({id, method, params}) } catch (error) { fail(error) }
  })
}
function turnState(id) {
  if (!identifier(id)) throw new Error("Invalid turn identifier in app-server notification")
  if (!turns.has(id)) {
    if (turns.size >= 8) throw new Error("Unexpected extra turns in review session")
    turns.set(id, {messages: new Map(), terminal: null})
  }
  return turns.get(id)
}
function captureMessage(state, item) {
  if (!object(item) || item.type !== "agentMessage") return
  if (!identifier(item.id) || typeof item.text !== "string") throw new Error("Invalid agent message")
  if (item.phase !== undefined && item.phase !== null && !["commentary", "final_answer"].includes(item.phase)) {
    throw new Error("Unknown agent message phase")
  }
  state.messages.set(item.id, item)
}
function finishTurn() {
  if (!turnId) return
  const state = turns.get(turnId)
  if (!state?.terminal) return
  if (state.terminal.status !== "completed" || state.terminal.error) {
    fail(new Error(`Review turn ${state.terminal.status}`))
    return
  }
  const messages = [...state.messages.values()]
  const final = messages.filter((item) => item.phase === "final_answer").at(-1)
    // The protocol explicitly allows a missing phase for legacy providers.
    ?? messages.filter((item) => item.phase == null).at(-1)
  if (!final?.text.trim()) {
    fail(new Error("Completed review turn has no final agent message"))
    return
  }
  resolveCompletion(final.text)
}
function receive(message) {
  if (!object(message)) throw new Error("Invalid app-server message")
  if (Object.hasOwn(message, "id")) {
    if (message.method) {
      send({id: message.id, error: {code: -32601, message: "Non-interactive review does not support client requests"}})
      throw new Error(`Unexpected app-server client request: ${message.method}`)
    }
    const waiter = pending.get(message.id)
    if (!waiter || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
      throw new Error("Uncorrelated or malformed app-server response")
    }
    if (message.error) {
      if (!object(message.error) || typeof message.error.message !== "string") throw new Error("Invalid app-server error")
      pending.delete(message.id)
      waiter.reject(new Error(`App-server request failed: ${message.error.message}`))
    } else {
      pending.delete(message.id)
      waiter.resolve(message.result)
    }
    return
  }
  if (typeof message.method !== "string") throw new Error("Invalid app-server notification")
  if (!["item/completed", "turn/completed"].includes(message.method)) return
  if (!object(message.params)) throw new Error("Invalid app-server notification parameters")
  const params = message.params
  if (!threadId || params.threadId !== threadId) throw new Error("Notification belongs to another review thread")
  if (message.method === "item/completed") {
    captureMessage(turnState(params.turnId), params.item)
  } else {
    if (!object(params.turn) || !["completed", "failed", "interrupted"].includes(params.turn.status)) {
      throw new Error("Invalid completed turn")
    }
    const state = turnState(params.turn.id)
    if (state.terminal) throw new Error("Duplicate terminal notification")
    if (!Array.isArray(params.turn.items)) throw new Error("Invalid completed turn items")
    for (const item of params.turn.items) captureMessage(state, item)
    state.terminal = params.turn
  }
  if (turnId && [...turns.keys()].some((id) => id !== turnId)) throw new Error("Notification belongs to another review turn")
  finishTurn()
}
child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  if (failure) return
  buffer += chunk
  try {
    let newline
    while ((newline = buffer.indexOf("\n")) !== -1) {
      if (newline > 8 * 1024 * 1024) throw new Error("App-server message exceeds 8 MiB")
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line)
      // Only actual server activity refreshes the outer shell's watchdog.
      process.stdout.write(`${JSON.stringify(message)}\n`)
      receive(message)
    }
    if (buffer.length > 8 * 1024 * 1024) throw new Error("App-server message exceeds 8 MiB")
  } catch (error) { fail(error) }
})
child.on("error", fail)
child.stdin.on("error", fail)
child.once("exit", (code, signal) => {
  if (!stopped) fail(new Error(`App-server exited before review completion (${signal ?? code})`))
})
async function stop() {
  stopped = true
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1500)
    await exited
    clearTimeout(killTimer)
  }
  // A detached tool can retain the server's stdout after the server exits.
  // The shell owns draining those marked descendants before trusting a receipt.
  child.stdin.destroy()
  child.stdout.destroy()
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    process.exitCode = 130
    if (threadId && turnId && !failure) {
      request("turn/interrupt", {threadId, turnId}).catch(() => {})
    }
    fail(new Error(`Review adapter cancelled (${signal})`))
  })
}
try {
  const initialized = await request("initialize", {
    clientInfo: {name: "mentra_codex_review", title: "Mentra PR review", version: "1.0.0"},
    capabilities: {experimentalApi: true},
  })
  if (!object(initialized)) throw new Error("Invalid initialize response")
  send({method: "initialized", params: {}})
  const started = await request("thread/start", {
    model,
    cwd: project,
    runtimeWorkspaceRoots: [project, checkout],
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: {model_reasoning_effort: effort},
    ephemeral: false,
    ...(projectId ? {projectId} : {}),
  })
  const thread = started?.thread
  if (!object(thread) || !identifier(thread.id) || thread.cwd !== project || thread.ephemeral !== false
      || !["cli", "vscode"].includes(thread.source) || (projectId && thread.projectId !== projectId)) {
    throw new Error("App-server did not create a persistent interactive review in the requested project")
  }
  threadId = thread.id
  // Keep the small existing receipt/monitor event useful across both transports.
  process.stdout.write(`${JSON.stringify({type: "thread.started", thread_id: threadId})}\n`)
  await request("thread/name/set", {threadId, name})
  const startedTurn = await request("turn/start", {
    threadId,
    model,
    effort,
    input: [{type: "text", text: prompt, text_elements: []}],
  })
  if (!identifier(startedTurn?.turn?.id)) throw new Error("Invalid turn/start response")
  turnId = startedTurn.turn.id
  if ([...turns.keys()].some((id) => id !== turnId)) throw new Error("Notification belongs to another review turn")
  finishTurn() // Completion may arrive before the turn/start response.
  const final = await completion
  if (failure) throw failure
  writeFileSync(`${output}.${process.pid}.tmp`, `${final}\n`, {mode: 0o600})
  renameSync(`${output}.${process.pid}.tmp`, output)
} catch (error) {
  console.error(`codex-review app-server: ${error.message}`)
  process.exitCode = 1
} finally {
  await stop()
}
