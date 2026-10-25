/**
 * The miniapps of this checkout, for builds of the Mentra App made on a developer's computer. CI packs its own
 * (.github/ci/pack-miniapps.sh in the monorepo) and never runs these.
 *
 * - A debug build (`bun start`, `bun android`, `bun ios`) gets every miniapp live: startDevMiniapps() starts each
 *   one's dev server (`mentra-miniapp dev`, frontend only: it calls the backend its .env names, else its
 *   .env.example's dev backend), and the app installs each as a local build that reloads on every save
 *   (src/services/miniapps/devMiniapps.ts). No QR code is scanned. The ports reach the app as
 *   EXPO_PUBLIC_DEV_MINIAPPS; the host is the one the bundle came from.
 * - Any other local build bundles them: packMiniapps() packs each from the working tree into assets/miniapps/.
 *
 * A bundled miniapp is a folder with a `pack` script:
 * - in the Mentra monorepo, miniapps/<name> (its own Bun workspace) and miniapps/public/<name> (a member of
 *   MentraOS's root workspace, so built from a copy at public/mentraos/miniapps/<name> that follows the original);
 * - in MentraOS, miniapps/<name>.
 */
import {spawn, spawnSync} from "node:child_process"
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch} from "node:fs"
import {createServer} from "node:net"
import {basename, join} from "node:path"
import {pathToFileURL} from "node:url"
import {parse} from "dotenv"

const FIRST_PORT = 3100

const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"})
const top = git.status === 0 ? git.stdout.trim() : ""
const monorepo = existsSync(join(top, "public/mentraos/mobile"))
const mentraos = monorepo ? join(top, "public/mentraos") : top
const mobile = join(mentraos, "mobile")

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

/** The bundled miniapps: where each is edited (`source`), built (`dir`), and whether MentraOS's workspace holds it. */
function bundledMiniapps() {
  const apps = []
  const add = (dir, workspace, built = dir) => {
    const scripts = packageJson(dir)?.scripts ?? {}
    const dev = scripts["miniapp:dev"] ? "miniapp:dev" : "dev"
    if (scripts.pack) apps.push({name: basename(dir), source: dir, dir: built, dev: scripts[dev] ? dev : null, workspace})
  }
  if (monorepo) {
    for (const dir of folders(join(top, "miniapps"))) if (basename(dir) !== "public") add(dir, false)
    for (const dir of folders(join(top, "miniapps/public"))) add(dir, true, join(mentraos, "miniapps", basename(dir)))
  } else {
    for (const dir of folders(join(top, "miniapps"))) add(dir, true)
  }
  return apps
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {cwd, env, stdio: "inherit"})
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`)
}

/** Make a public miniapp's copy equal to the original, deletions included. */
function copy(app) {
  if (app.dir === app.source) return
  run("rsync", ["-a", "--delete", "--exclude", "node_modules", "--exclude", "dist", `${app.source}/`, app.dir], top)
}

/** Keep copying it on every change. */
function follow(app) {
  if (app.dir === app.source) return
  let timer
  watch(app.source, {recursive: true}, (_event, file) => {
    if (file && /(^|\/)(node_modules|dist|build)(\/|$)/.test(file)) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        copy(app)
      } catch (error) {
        console.warn(`[miniapps] ${app.name}: ${error.message}`)
      }
    }, 100)
  })
}

/**
 * Install every miniapp's dependencies, then build the miniapp SDK they all build against: each install rebuilds it
 * (mobile/modules/miniapp's `prepare`), so none may run while a miniapp builds.
 */
function prepare(apps) {
  for (const app of apps) copy(app)
  if (apps.some((app) => app.workspace)) run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], mentraos)
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
    const path = join(app.source, file)
    if (existsSync(path)) Object.assign(values, parse(readFileSync(path)))
  }
  const token = mapboxToken()
  return {...values, ...process.env, ...(token ? {PUBLIC_MAPBOX_TOKEN: token} : {}), ...extra}
}

/** The ZIPs under `dir`'s build/ folders written after `since`. */
function newZips(dir, since) {
  const found = []
  const visit = (path, inBuild) => {
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      if (entry.name === "node_modules") continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child, inBuild || entry.name === "build")
      else if (inBuild && entry.name.endsWith(".zip") && statSync(child).mtimeMs >= since) found.push(child)
    }
  }
  visit(dir, false)
  return found
}

/** Pack every bundled miniapp from the working tree into assets/miniapps/, or throw naming those that failed. */
export async function packMiniapps() {
  if (process.env.CI || !top) return
  const apps = bundledMiniapps()
  const dest = join(mobile, "assets/miniapps")
  mkdirSync(dest, {recursive: true})
  for (const name of readdirSync(dest)) if (name.endsWith(".zip")) rmSync(join(dest, name))
  if (apps.length === 0) return
  prepare(apps)
  const failed = []
  for (const app of apps) {
    const since = Date.now()
    try {
      run("bun", ["run", "pack"], app.dir, miniappEnv(app))
      const zips = newZips(app.dir, since)
      if (zips.length !== 1) throw new Error(`expected one new build/*.zip, found ${zips.length}`)
      copyFileSync(zips[0], join(dest, basename(zips[0])))
    } catch (error) {
      console.error(`[miniapps] ${app.name}: ${error.message}`)
      failed.push(app.name)
    }
  }
  if (failed.length) throw new Error(`Not packed: ${failed.join(", ")} (the navigation miniapp needs EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN in .env)`)
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
  const lan = pathToFileURL(join(mentraos, "sdk/miniapp-cli/src/lan.ts")).href
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
  if (process.env.CI || process.env.MENTRA_DEV_MINIAPPS === "0" || !top) return
  const apps = bundledMiniapps().filter((app) => app.dev)
  if (apps.length === 0) return
  prepare(apps)
  for (const app of apps) follow(app)

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
