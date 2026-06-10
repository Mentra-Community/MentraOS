#!/usr/bin/env bun
/**
 * @fileoverview App-health sweep: navigate every route, score what renders.
 *
 * The single most useful "QA the whole app" move the harness can make. It
 * enumerates the expo-router routes from the filesystem (no app cooperation),
 * navigates to each through the bridge, and asks the app's error channel "did
 * anything throw?" — turning a screen-by-screen manual click-through into one
 * quantified pass with a scorecard. Output ends with machine-readable JSON so
 * runs are comparable over time (is the app getting healthier or not?).
 *
 *   bun tools/mentra-agent/sweep.ts            # sweep all routes
 *   bun tools/mentra-agent/sweep.ts --json     # JSON only (CI)
 *   bun tools/mentra-agent/sweep.ts --filter settings
 */
import {readdirSync, readFileSync} from "node:fs"
import {join, relative} from "node:path"

const BASE = process.env.MENTRA_AGENT_URL ?? "http://localhost:8787"
const APP_DIR = join(import.meta.dir, "..", "..", "mobile", "src", "app")
const SETTLE_MS = 1500

async function rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({method, params, timeoutMs}),
  })
  const body = (await res.json()) as {ok: boolean; result?: unknown; error?: string}
  if (!body.ok) throw new Error(body.error ?? `rpc ${method} failed`)
  return body.result
}

/**
 * Convert the src/app file tree into navigable routes. expo-router maps file
 * paths to URLs; we apply the same rules well enough to enumerate static
 * routes and SKIP the ones a blind sweep can't meaningfully hit:
 *   - layouts (_layout) and the not-found route
 *   - dynamic segments ([id], [...rest]) — no real param to supply
 *   - route groups (group) collapse out of the URL
 */
function enumerateRoutes(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (/\.(tsx|jsx|ts|js)$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  walk(APP_DIR)

  const routes = new Set<string>()
  for (const file of files) {
    const rel = relative(APP_DIR, file).replace(/\.(tsx|jsx|ts|js)$/, "")
    const segments = rel.split("/")
    const base = segments[segments.length - 1]
    if (base.startsWith("_")) continue // _layout etc.
    if (/\+not-found|\+html|\+native-intent/.test(base)) continue
    // Non-route files that live under src/app: tests, and plain modules
    // (helpers/util colocated with routes) that expo-router does not register.
    if (/\.(test|spec)$|__tests__/.test(rel)) continue
    if (rel === "test/agent-selftest") continue // harness self-test, exercised separately
    if (segments.some((s) => /\[.*\]/.test(s))) continue // dynamic params
    // Only files that `export default` a component are expo-router routes;
    // colocated helper modules (ota/deriveOtaDisplayState, otaProgressTimeouts)
    // live under src/app but are not screens.
    if (!/export default/.test(readFileSync(file, "utf8"))) continue
    // route groups: (group) segments drop out of the URL
    const urlSegments = segments.filter((s) => !/^\(.*\)$/.test(s))
    let path = "/" + urlSegments.join("/")
    path = path.replace(/\/index$/, "") || "/"
    routes.add(path)
  }
  return [...routes].sort()
}

type Verdict = "clean" | "redirected" | "broken"
interface RouteResult {
  route: string
  verdict: Verdict
  navMs: number
  landed: string | null
  errors: {source: string; fatal: boolean; message: string}[]
}

type CapturedError = {source: string; fatal: boolean; message: string}

/**
 * What counts as a render FAILURE vs benign console noise. A screen logs all
 * sorts of warnings (deprecations, missing-key, network blips) that are not
 * the screen being broken; we only flag fatal throws and the signatures of an
 * actual render/registration failure. Keeping this in ONE place means the
 * trust gate and the sweep judge routes identically.
 */
function realErrors(errors: CapturedError[]): CapturedError[] {
  return errors.filter(
    (e) => e.fatal || /render error|invariant|undefined is not|cannot read prop|getEnforcing|unmatched route|element type is invalid/i.test(e.message),
  )
}

async function sweepRoute(route: string, knownRoutes: Set<string>): Promise<RouteResult> {
  await rpc("clearErrors")
  const t0 = Date.now()
  let navMs = 0
  try {
    // replace (not push) so we don't build a 50-deep stack across the sweep.
    await rpc("navigate", {path: route, replace: true})
    navMs = Date.now() - t0
  } catch (err) {
    return {route, verdict: "broken", navMs: Date.now() - t0, landed: null, errors: [{source: "navigate", fatal: true, message: (err as Error).message}]}
  }
  await Bun.sleep(SETTLE_MS)
  const landed = ((await rpc("currentRoute")) as {path: string | null}).path
  const {errors} = (await rpc("getErrors")) as {errors: CapturedError[]}
  const real = realErrors(errors)

  // Three-way verdict, because not every "didn't stay put" is a bug:
  //   broken     = threw a real render error, OR bounced to +not-found (the
  //                "Unmatched Route" class).
  //   redirected = landed on a DIFFERENT but VALID route — auth/onboarding
  //                guards and param-required screens (e.g. / -> /home,
  //                /applet/local -> /home without a packageName). Working as
  //                designed; reported, not failed.
  //   clean      = landed on the requested route, no real errors.
  if (real.length > 0) return {route, verdict: "broken", navMs, landed, errors: real}
  if (landed != null && landed !== route) {
    const toValidRoute = knownRoutes.has(landed) || landed === "/home" || landed === "/"
    if (toValidRoute) {
      return {route, verdict: "redirected", navMs, landed, errors: []}
    }
    return {route, verdict: "broken", navMs, landed, errors: [{source: "route", fatal: false, message: `bounced to ${landed} (not-found)`}]}
  }
  return {route, verdict: "clean", navMs, landed, errors: []}
}

function pctl(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/**
 * Prove the error channel works before trusting any green: the healthy
 * self-test route must pass, and the SAME route with ?crash=1 must be caught
 * as a failure. If the probe can't tell a broken screen from a healthy one,
 * the whole scorecard is meaningless — so this gates the run.
 */
async function validateErrorChannel(): Promise<void> {
  await rpc("clearErrors")
  await rpc("navigate", {path: "/test/agent-selftest", replace: true})
  await Bun.sleep(SETTLE_MS)
  const healthy = (await rpc("getErrors")) as {errors: CapturedError[]}
  if (realErrors(healthy.errors).length !== 0) {
    throw new Error(`self-test: healthy route reported real errors — ${realErrors(healthy.errors)[0]?.message}`)
  }

  await rpc("clearErrors")
  await rpc("navigate", {path: "/test/agent-selftest", params: {crash: "1"}, replace: true})
  await Bun.sleep(SETTLE_MS)
  const crashed = (await rpc("getErrors")) as {errors: {message: string}[]}
  const caught = crashed.errors.some((e) => /deliberate render crash/.test(e.message))
  if (!caught) throw new Error("self-test: deliberate crash NOT caught — error channel is blind, scorecard untrustworthy")
}

const json = process.argv.includes("--json")
const filterIdx = process.argv.indexOf("--filter")
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined

if (process.argv.includes("--selftest")) {
  try {
    await validateErrorChannel()
    console.log("error-channel self-test: PASS (healthy route clean; deliberate crash caught)")
    process.exit(0)
  } catch (err) {
    console.error(`error-channel self-test: FAIL — ${(err as Error).message}`)
    process.exit(1)
  }
}

// Gate every run on the channel self-test: a green scorecard is only
// meaningful if a known-broken screen would have turned it red.
try {
  await validateErrorChannel()
} catch (err) {
  console.error(`ABORT: ${(err as Error).message}`)
  process.exit(2)
}

const allRoutes = enumerateRoutes()
const knownRoutes = new Set(allRoutes)
const sweepRoutes = allRoutes.filter((r) => !filter || r.includes(filter))
if (!json) console.error(`sweeping ${sweepRoutes.length} routes (settle ${SETTLE_MS}ms each)...`)

const results: RouteResult[] = []
for (const route of sweepRoutes) {
  const r = await sweepRoute(route, knownRoutes)
  results.push(r)
  if (!json) {
    const mark = r.verdict === "clean" ? "✓" : r.verdict === "redirected" ? "~" : "✗"
    const land = r.landed && r.landed !== route ? ` -> ${r.landed}` : ""
    console.log(`${mark} ${route.padEnd(38)} ${String(r.navMs).padStart(4)}ms${land}`)
    for (const e of r.errors) console.log(`    ${e.source}: ${e.message.split("\n")[0].slice(0, 100)}`)
  }
}

// return the app to a sane state
await rpc("navigate", {path: "/home", replace: true}).catch(() => {})

const clean = results.filter((r) => r.verdict === "clean")
const redirected = results.filter((r) => r.verdict === "redirected")
const broken = results.filter((r) => r.verdict === "broken")
const navTimes = results.map((r) => r.navMs)
// Health = of routes that ACTUALLY RENDER a screen (clean + broken; redirects
// are guards working as designed and don't render their own screen), how many
// render clean. This is the number to watch move over time.
const renderable = clean.length + broken.length
const scorecard = {
  routesTotal: results.length,
  clean: clean.length,
  redirected: redirected.length,
  broken: broken.length,
  healthPct: renderable ? Math.round((clean.length / renderable) * 1000) / 10 : 100,
  navMs: {p50: pctl(navTimes, 50), p95: pctl(navTimes, 95), max: Math.max(0, ...navTimes)},
  slowest: [...results].sort((a, b) => b.navMs - a.navMs).slice(0, 3).map((r) => ({route: r.route, navMs: r.navMs})),
  brokenRoutes: broken.map((r) => ({route: r.route, errors: r.errors.map((e) => e.message.split("\n")[0].slice(0, 120))})),
  redirectedRoutes: redirected.map((r) => ({route: r.route, to: r.landed})),
}

if (json) {
  console.log(JSON.stringify(scorecard, null, 2))
} else {
  console.log("")
  console.log(
    `SCORECARD  health ${scorecard.healthPct}%  (${scorecard.clean} clean, ${scorecard.redirected} guarded/redirected, ${scorecard.broken} broken of ${scorecard.routesTotal})`,
  )
  console.log(`           nav p50 ${scorecard.navMs.p50}ms  p95 ${scorecard.navMs.p95}ms  max ${scorecard.navMs.max}ms`)
  console.log(`           slowest: ${scorecard.slowest.map((s) => `${s.route} ${s.navMs}ms`).join(", ")}`)
  if (scorecard.broken.length) {
    console.log(`           ${scorecard.broken} BROKEN:`)
    for (const f of scorecard.brokenRoutes) console.log(`             ✗ ${f.route} — ${f.errors[0] ?? "render error"}`)
  }
}

process.exit(broken.length === 0 ? 0 : 1)
