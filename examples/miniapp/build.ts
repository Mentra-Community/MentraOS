/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — the JSContext entry (no DOM, externalises
 *                                @mentra/miniapp/background because the
 *                                host's polyfill bundle provides the
 *                                runtime shape).
 *   dist/ui/index.html + ...  — the WebView entry (full DOM, Tailwind v4
 *                                compiled via bun-plugin-tailwind).
 *
 * Env vars whose name starts with `MENTRA_PUBLIC_` are inlined into both
 * bundles via `define`. Anything inlined into the UI bundle is visible
 * in WebView network requests + source maps; secrets MUST live behind
 * the developer's own backend, not in MENTRA_PUBLIC_*.
 */

import {getLanIp} from "@mentra/miniapp-cli/lan"
import {existsSync} from "fs"
import {rm} from "fs/promises"
import {reactSingletonPlugin} from "@mentra/miniapp-cli/build-helpers"

// Load .env.local so MENTRA_PUBLIC_* / ELEVENLABS_* from the RN example
// carry into the bake without exporting them in every shell.
try {
  const envPath = `${import.meta.dir}/.env.local`
  if (existsSync(envPath)) {
    const text = await Bun.file(envPath).text()
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) {
        process.env[key] = value
      }
    }
  }
} catch {
  /* ignore missing/unreadable .env.local */
}

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const DEFAULT_ELEVENLABS_AGENT_ID = "agent_0301ks3wg64pf9evgxqa6dw34t1f"

/** Prefer LAN IP so a MentraOS phone can reach the Mac signing server. */
const lanIp = getLanIp()
const signerPort = Number(process.env.ELEVENLABS_SIGNING_SERVER_PORT || 8788)
const DEFAULT_ELEVENLABS_SIGNED_URL_ENDPOINT = lanIp
  ? `http://${lanIp}:${signerPort}/signed-url`
  : `http://localhost:${signerPort}/signed-url`

const define: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}

// Prefer MENTRA_PUBLIC_*, then ELEVENLABS_AGENT_ID from .env.local, then RN default.
// Signed-URL endpoint defaults to this machine's LAN IP (phone ≠ Mac localhost).
if (!define["process.env.MENTRA_PUBLIC_ELEVENLABS_AGENT_ID"]) {
  const agentFromEnv = process.env.ELEVENLABS_AGENT_ID || DEFAULT_ELEVENLABS_AGENT_ID
  define["process.env.MENTRA_PUBLIC_ELEVENLABS_AGENT_ID"] = JSON.stringify(agentFromEnv)
}
if (!define["process.env.MENTRA_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT"]) {
  define["process.env.MENTRA_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT"] = JSON.stringify(
    DEFAULT_ELEVENLABS_SIGNED_URL_ENDPOINT,
  )
  console.log(`[build] ElevenLabs signed-url endpoint → ${DEFAULT_ELEVENLABS_SIGNED_URL_ENDPOINT}`)
}

// JSC + Zipline/QuickJS both evaluate the background bundle as a classic
// script. ESM `export` keywords are syntax errors there, so we emit an
// IIFE. `@mentra/miniapp/background` MUST be bundled in (not external)
// because the JSContext has no module resolver — the polyfill installs
// `__dispatch` / `__deliver` but it does NOT provide the SDK surface.
const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define,
})
if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const tailwind = (await import("bun-plugin-tailwind")).default

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [tailwind, reactSingletonPlugin(import.meta.url)],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

// Silence on success — the dev-server's `reload →` line is the
// developer-facing confirmation. Failures already print via the
// .success branches above.
