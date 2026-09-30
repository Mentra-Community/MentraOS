import {spawnSync} from "node:child_process"
import {delimiter, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"

// Probe the command we will actually run: an executable npm shim can still
// point at a missing native binary. No model session or login is started here.
export function resolveCodex(mode, {env = process.env, platform = process.platform} = {}) {
  const requiredFlag = mode === "app-server" ? "--stdio" : mode === "exec" ? "--json" : null
  if (!requiredFlag) throw new Error("Expected exec or app-server transport")
  const pathCandidates = (env.PATH || "").split(delimiter).map((dir) => resolve(dir, "codex"))
  const explicit = env.CODEX_BIN
  let candidates = explicit
    ? explicit.includes("/") ? [resolve(explicit)] : (env.PATH || "").split(delimiter).map((dir) => resolve(dir, explicit))
    : pathCandidates
  if (!explicit && platform === "darwin") {
    for (const applications of [...(env.HOME ? [join(env.HOME, "Applications")] : []), "/Applications"]) {
      for (const app of ["Codex.app", "ChatGPT.app"]) {
        const resources = join(applications, app, "Contents/Resources")
        candidates.push(join(resources, "codex-cli/CodexCLI.app/Contents/MacOS/codex"), join(resources, "codex"))
      }
    }
  }
  for (const candidate of new Set(candidates)) {
    const result = spawnSync(candidate, [mode, "--help"], {
      env, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    })
    if (!result.error && result.status === 0 && result.stdout.includes(requiredFlag)) return candidate
    // An explicit executable is a deliberate selection; never silently replace it.
    if (explicit && (explicit.includes("/") || result.error?.code !== "ENOENT")) break
  }
  throw new Error(explicit
    ? `CODEX_BIN cannot run ${mode} with ${requiredFlag}: ${explicit}. Repair it or unset CODEX_BIN to use automatic discovery.`
    : `No working Codex CLI supports ${mode} with ${requiredFlag}. Repair the Codex installation on PATH or set CODEX_BIN to a working executable.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(resolveCodex(process.argv[2]))
  } catch (error) {
    console.error(`codex-review: ${error.message}`)
    process.exitCode = 1
  }
}
