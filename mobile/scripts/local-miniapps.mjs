/**
 * The miniapps of this checkout, for debug builds of the Mentra App made on a developer's computer (`bun start`,
 * `bun android`, `bun ios`). CI never runs these. Every other build bundles no miniapps: it installs them from its
 * deployment's miniapp host.
 *
 * startDevMiniapps() starts each miniapp's dev server (`mentra-miniapp dev`, frontend only: it calls the backend its
 * .env names, else its .env.example's dev backend), and the app installs each as a local build that reloads on every
 * save (src/services/miniapps/devMiniapps.ts). No QR code is scanned. The ports reach the app as
 * EXPO_PUBLIC_DEV_MINIAPPS; the host is the one the bundle came from.
 *
 * A miniapp is a folder with a `pack` script: miniapps/<name>, a member of the root Bun workspace, and each folder
 * listed in MENTRA_EXTRA_MINIAPPS (separated like PATH), installed as its own Bun workspace.
 */
import {spawn, spawnSync} from "node:child_process"
import {existsSync, readFileSync, readdirSync} from "node:fs"
import {createServer} from "node:net"
import {basename, delimiter, dirname, join, resolve} from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"

const FIRST_PORT = 3100

// dotenv, loaded by the functions that read .env files.
let parse
const loadDotenv = async () => {
  parse ??= (await import("dotenv")).parse
}

const mobile = dirname(dirname(fileURLToPath(import.meta.url)))
const root = dirname(mobile)

function packageJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  } catch {
    return null
  }
}

function folders(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
}

/** The miniapps, and whether the root workspace holds each. */
function checkoutMiniapps() {
  const apps = []
  const add = (dir, workspace) => {
    const scripts = packageJson(dir)?.scripts ?? {}
    const dev = scripts["miniapp:dev"] ? "miniapp:dev" : "dev"
    if (scripts.pack) apps.push({name: basename(dir), dir, dev: scripts[dev] ? dev : null, workspace})
  }
  for (const dir of folders(join(root, "miniapps"))) add(dir, true)
  for (const dir of (process.env.MENTRA_EXTRA_MINIAPPS ?? "").split(delimiter)) if (dir) add(resolve(dir), false)
  return apps
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {cwd, env, stdio: "inherit"})
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`)
}

/**
 * Install every miniapp's dependencies, then build the miniapp SDK they all build against: each install rebuilds it
 * (mobile/modules/miniapp's `prepare`), so none may run while a miniapp builds.
 */
function prepare(apps) {
  if (apps.some((app) => app.workspace)) run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], root)
  for (const app of apps) if (!app.workspace) run("bun", ["install", "--frozen-lockfile"], app.dir)
  run("bun", ["run", "build"], join(mobile, "modules/miniapp"))
}

/** The app's public Mapbox token (pk.…), which the navigation miniapp bakes in. */
function mapboxToken() {
  const env = join(mobile, ".env")
  const fromFile = existsSync(env) ? parse(readFileSync(env)).EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN : undefined
  const token = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN || fromFile || ""
  return token.startsWith("pk.") ? token : undefined
}

/**
 * A miniapp's build env: its .env.example, then its .env, then this process's environment (as dotenv: the real
 * environment wins), then the app's Mapbox token and `extra`.
 */
function miniappEnv(app, extra = {}) {
  const values = {}
  for (const file of [".env.example", ".env"]) {
    const path = join(app.dir, file)
    if (existsSync(path)) Object.assign(values, parse(readFileSync(path)))
  }
  const token = mapboxToken()
  return {...values, ...process.env, ...(token ? {PUBLIC_MAPBOX_TOKEN: token} : {}), ...extra}
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.listen(port, "0.0.0.0", () => server.close(() => done(true)))
  })
}

/** The next free port pair: the dev server takes the port, its live-reload sidecar the next one. */
async function nextPorts(from) {
  for (let port = from; ; port += 2) if ((await portFree(port)) && (await portFree(port + 1))) return port
}

/** The package a dev server serves once it is up, or null if it exits or never answers. */
async function servedPackage(port, child, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/miniapp.json`)
      if (response.ok) return (await response.json()).packageName ?? null
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 500))
  }
  return null
}

/**
 * Whether `mentra-miniapp dev` finds a LAN address here, by its own rule (sdk/miniapp-cli/src/lan.ts): without one,
 * the dev servers reach phones over USB only.
 */
function hasLanAddress() {
  const lan = pathToFileURL(join(root, "sdk/miniapp-cli/src/lan.ts")).href
  const result = spawnSync("bun", ["-e", `const {getLanIp} = await import(${JSON.stringify(lan)}); console.log(getLanIp() ?? "")`], {
    encoding: "utf8",
  })
  return result.status === 0 && result.stdout.trim() !== ""
}

/** Publish the ports on every Android phone attached over USB, for a phone that reaches Metro through `adb reverse`. */
function reverseOverUsb(ports) {
  const devices = spawnSync("adb", ["devices"], {encoding: "utf8"})
  if (devices.status !== 0) return
  for (const line of devices.stdout.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/)
    if (state !== "device") continue
    for (const port of ports.flatMap((p) => [p, p + 1])) {
      spawnSync("adb", ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], {stdio: "ignore"})
    }
  }
}

function prefixed(name, stream, out) {
  let rest = ""
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split("\n")
    rest = lines.pop()
    for (const line of lines) out.write(`[${name}] ${line}\n`)
  })
}

/**
 * Start the dev servers, wait until each serves its miniapp.json, and set EXPO_PUBLIC_DEV_MINIAPPS
 * (`<packageName>@<port>,…`) for the bundler this process starts next. The servers stop with this process.
 * MENTRA_DEV_MINIAPPS=0 starts none. Without a LAN address they serve over USB (`mentra-miniapp dev --usb`, which
 * opens its own `adb reverse`).
 */
export async function startDevMiniapps() {
  if (process.env.CI || process.env.MENTRA_DEV_MINIAPPS === "0") return
  await loadDotenv()
  const apps = checkoutMiniapps().filter((app) => app.dev)
  if (apps.length === 0) return
  prepare(apps)

  const children = []
  process.on("exit", () => children.forEach((child) => child.kill()))
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit())

  const usb = !hasLanAddress()
  const started = []
  let port = FIRST_PORT
  for (const app of apps) {
    port = await nextPorts(port)
    const env = miniappEnv(app, {MENTRA_MINIAPP_DEV_PORT: String(port)})
    const child = spawn("bun", ["run", app.dev, ...(usb ? ["--usb"] : [])], {cwd: app.dir, env})
    prefixed(app.name, child.stdout, process.stdout)
    prefixed(app.name, child.stderr, process.stderr)
    children.push(child)
    started.push({app, port, child})
    port += 2
  }

  const served = []
  for (const {app, port, child} of started) {
    const packageName = await servedPackage(port, child, 120_000)
    if (packageName) served.push({packageName, port})
    else console.warn(`[miniapps] ${app.name} is not served on port ${port}; the app won't install it`)
  }
  if (!usb) reverseOverUsb(served.map(({port}) => port))
  process.env.EXPO_PUBLIC_DEV_MINIAPPS = served.map(({packageName, port}) => `${packageName}@${port}`).join(",")
  console.log(`[miniapps] serving ${served.length} of ${apps.length} miniapps live: ${process.env.EXPO_PUBLIC_DEV_MINIAPPS}`)
}
