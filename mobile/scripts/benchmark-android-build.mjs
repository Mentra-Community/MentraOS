#!/usr/bin/env bun
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync} from "node:fs"
import {execFileSync, spawn} from "node:child_process"
import {homedir} from "node:os"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const MOBILE_ROOT = join(SCRIPT_DIR, "..")
const BENCH_DIR = join(MOBILE_ROOT, ".benchmarks")
const BENCH_FILE = join(BENCH_DIR, "android-build.ndjson")
const DEBUG_APK = join(MOBILE_ROOT, "android/app/build/outputs/apk/debug/app-debug.apk")
const MB = 1048576

export function parseGradleSummary(text) {
  const timeMatches = [...String(text).matchAll(/BUILD SUCCESSFUL in (\d+(?:\.\d+)?)\s*(ms|s|m)/g)]
  const taskMatches = [...String(text).matchAll(/(\d+) actionable tasks:\s*([^\n]+)/g)]
  const lastTime = timeMatches.at(-1)
  const lastTasks = taskMatches.at(-1)
  return {
    wallMs: lastTime ? toMs(lastTime[1], lastTime[2]) : null,
    actionable: lastTasks ? Number(lastTasks[1]) : null,
    executed: lastTasks ? parseExecuted(lastTasks[2]) : null,
    upToDate: lastTasks ? parseNamedCount(lastTasks[2], "up-to-date") : null,
    fromCache: lastTasks ? parseNamedCount(lastTasks[2], "from cache") : null,
    rawTasks: lastTasks ? lastTasks[2].trim() : null,
  }
}

function toMs(value, unit) {
  const n = Number(value)
  if (unit === "ms") return n
  if (unit === "m") return n * 60_000
  return n * 1000
}

function parseExecuted(summary) {
  const match = summary.match(/(\d+)\s+executed/)
  return match ? Number(match[1]) : 0
}

function parseNamedCount(summary, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = summary.match(new RegExp(`(\\d+)\\s+${escaped}`))
  return match ? Number(match[1]) : 0
}

export function analyzeApk(apkPath) {
  if (!existsSync(apkPath)) {
    return {bytes: 0, mb: 0, abis: [], libBytes: {}, dexBytes: 0}
  }
  const bytes = statSync(apkPath).size
  const listing = execFileSync("unzip", ["-v", apkPath], {encoding: "utf8"})
  const libBytes = {}
  let dexBytes = 0
  for (const line of listing.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    const compressed = Number(parts[2])
    const name = parts[parts.length - 1]
    if (!Number.isFinite(compressed)) continue
    const abiMatch = name.match(/^lib\/([^/]+)\//)
    if (abiMatch) {
      libBytes[abiMatch[1]] = (libBytes[abiMatch[1]] || 0) + compressed
    }
    if (/classes.*\.dex$/.test(name)) {
      dexBytes += compressed
    }
  }
  return {
    bytes,
    mb: Number((bytes / MB).toFixed(1)),
    abis: Object.keys(libBytes).sort(),
    libBytes,
    dexBytes,
  }
}

export function parseAutolinkingGuard(text) {
  const match = String(text).match(/\[autolinking-guard\]\s+(\w+)\s+\(([^)]+)\)/)
  if (!match) return {wiped: null, reason: null}
  return {wiped: match[1] === "wiped", reason: match[2]}
}

export function compareRecords(before, after) {
  const gradleDeltaMs =
    before.gradle?.wallMs != null && after.gradle?.wallMs != null ? before.gradle.wallMs - after.gradle.wallMs : null
  const installDeltaMs =
    before.install?.ms != null && after.install?.ms != null ? before.install.ms - after.install.ms : null
  const totalDeltaMs = before.totalWallMs != null && after.totalWallMs != null ? before.totalWallMs - after.totalWallMs : null
  return {
    gradleWallMs: {before: before.gradle?.wallMs ?? null, after: after.gradle?.wallMs ?? null, savedMs: gradleDeltaMs},
    gradleExecuted: {before: before.gradle?.executed ?? null, after: after.gradle?.executed ?? null},
    apkMb: {before: before.apk?.mb ?? null, after: after.apk?.mb ?? null},
    apkAbis: {before: before.apk?.abis ?? [], after: after.apk?.abis ?? []},
    installMs: {before: before.install?.ms ?? null, after: after.install?.ms ?? null, savedMs: installDeltaMs},
    installMbps: {before: before.install?.mbps ?? null, after: after.install?.mbps ?? null},
    totalWallMs: {before: before.totalWallMs ?? null, after: after.totalWallMs ?? null, savedMs: totalDeltaMs},
  }
}

function latestLabeledRecord(label) {
  if (!existsSync(BENCH_FILE)) return null
  const lines = readFileSync(BENCH_FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = JSON.parse(lines[i])
    if (record.label === label) return record
  }
  return null
}

function pickPhoneSerial() {
  const out = execFileSync("adb", ["devices", "-l"], {encoding: "utf8"})
  const lines = out.trim().split("\n").slice(1)
  const valid = lines.filter(
    (line) => line.trim() && !line.includes("emulator") && !line.toLowerCase().includes("live") && !line.startsWith("emulator"),
  )
  if (valid.length === 0) {
    throw new Error("No suitable physical device found")
  }
  return valid[0].split(/\s+/)[0]
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {encoding: "utf8", cwd: MOBILE_ROOT}).trim()
  } catch {
    return "unknown"
  }
}

function parseLatestDaemonSummary() {
  const daemonRoot = join(homedir(), ".gradle/daemon")
  if (!existsSync(daemonRoot)) return parseGradleSummary("")
  const versions = readdirSync(daemonRoot).filter((name) => /^\d/.test(name))
  const logs = []
  for (const version of versions) {
    const dir = join(daemonRoot, version)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".out.log")) continue
      const path = join(dir, name)
      logs.push({path, mtime: statSync(path).mtimeMs})
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime)
  for (const log of logs.slice(0, 6)) {
    const text = readFileSync(log.path, "utf8")
    const summary = parseGradleSummary(text)
    if (summary.actionable && summary.actionable > 100) return summary
  }
  return parseGradleSummary("")
}

function runLogged(command, args, {cwd = MOBILE_ROOT} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"]})
    let output = ""
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    })
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      output += text
      process.stderr.write(text)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
        return
      }
      resolve(output)
    })
  })
}

function printCompare(delta) {
  const fmt = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`)
  console.log("\n=== Android build benchmark: before vs after ===")
  console.log(`Gradle wall     ${fmt(delta.gradleWallMs.before)} -> ${fmt(delta.gradleWallMs.after)}  (saved ${fmt(delta.gradleWallMs.savedMs)})`)
  console.log(`Gradle executed ${delta.gradleExecuted.before ?? "n/a"} -> ${delta.gradleExecuted.after ?? "n/a"}`)
  console.log(`APK size        ${delta.apkMb.before ?? "n/a"} MB -> ${delta.apkMb.after ?? "n/a"} MB`)
  console.log(`APK ABIs        ${(delta.apkAbis.before || []).join(",") || "n/a"} -> ${(delta.apkAbis.after || []).join(",") || "n/a"}`)
  console.log(`adb install     ${fmt(delta.installMs.before)} -> ${fmt(delta.installMs.after)}  (saved ${fmt(delta.installMs.savedMs)}) @ ${delta.installMbps.after ?? delta.installMbps.before ?? "n/a"} MB/s`)
  console.log(`Total wall      ${fmt(delta.totalWallMs.before)} -> ${fmt(delta.totalWallMs.after)}  (saved ${fmt(delta.totalWallMs.savedMs)})`)
}

async function runBenchmark(label) {
  mkdirSync(BENCH_DIR, {recursive: true})
  const started = Date.now()
  const output = await runLogged("bun", ["android"], {cwd: MOBILE_ROOT})
  const totalWallMs = Date.now() - started
  const fromOutput = parseGradleSummary(output)
  const gradle = fromOutput.wallMs != null ? fromOutput : parseLatestDaemonSummary()
  const apk = analyzeApk(DEBUG_APK)
  const serial = pickPhoneSerial()
  const installStarted = Date.now()
  execFileSync("adb", ["-s", serial, "install", "-r", DEBUG_APK], {stdio: "inherit"})
  const installMs = Date.now() - installStarted
  const installMbps = installMs > 0 ? Number((apk.bytes / MB / (installMs / 1000)).toFixed(1)) : null
  const autolinking = parseAutolinkingGuard(output)
  const record = {
    label,
    gitSha: gitSha(),
    timestamp: new Date().toISOString(),
    totalWallMs,
    gradle,
    apk,
    install: {ms: installMs, mbps: installMbps, serial},
    autolinking,
  }
  appendFileSync(BENCH_FILE, `${JSON.stringify(record)}\n`)
  console.log(`\n[benchmark] wrote ${label} record to ${BENCH_FILE}`)
  console.log(JSON.stringify(record, null, 2))
  return record
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
const args = process.argv.slice(2)
const compareIndex = args.indexOf("--compare")
if (isMain) {
  if (compareIndex !== -1) {
    const beforeLabel = args[compareIndex + 1]
    const afterLabel = args[compareIndex + 2]
    const before = latestLabeledRecord(beforeLabel)
    const after = latestLabeledRecord(afterLabel)
    if (!before || !after) {
      console.error(`Missing records for ${beforeLabel}/${afterLabel} in ${BENCH_FILE}`)
      process.exit(1)
    }
    const delta = compareRecords(before, after)
    printCompare(delta)
    console.log(JSON.stringify(delta, null, 2))
  } else {
    const labelIndex = args.indexOf("--label")
    const label = labelIndex !== -1 ? args[labelIndex + 1] : "run"
    await runBenchmark(label)
  }
}
