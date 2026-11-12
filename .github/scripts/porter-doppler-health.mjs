import {execFile} from "node:child_process"
import {readFile} from "node:fs/promises"
import {fileURLToPath} from "node:url"
import {promisify} from "node:util"

const execute = promisify(execFile)
const contractUrl = new URL("../production-release/doppler-porter-contract.json", import.meta.url)

export function environmentKeys(text) {
  return [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1])
}

export function linkedGroups(text) {
  const block = text.match(/^envGroups:\s*\n((?:[ \t]+[^\n]*\n|- [^\n]*\n)*)/m)?.[1] ?? ""
  return [...block.matchAll(/^\s*-\s*['"]?([a-z0-9-]+)['"]?\s*$/gm)].map((match) => match[1])
}

export function appProblems(app, yaml, exportedOverrides) {
  const problems = []
  const groups = linkedGroups(yaml)
  if (groups.length !== app.groups.length || app.groups.some((group) => !groups.includes(group))) {
    problems.push(`${app.name}: unexpected linked environment groups`)
  }
  const keys = environmentKeys(exportedOverrides)
  if (keys.length) problems.push(`${app.name}: Porter overrides ${keys.join(", ")}`)
  return problems
}

export function groupProblems(scope, exported) {
  const problems = []
  const keys = new Set(environmentKeys(exported))
  const missing = scope.keys.filter((key) => !keys.has(key))
  if (missing.length) problems.push(`${scope.name}: missing Doppler keys ${missing.join(", ")}`)
  for (const [key, expected] of [
    ["DOPPLER_PROJECT", scope.project],
    ["DOPPLER_CONFIG", scope.config],
  ]) {
    const actual = exported.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.replace(/^['"]|['"]$/g, "")
    if (actual !== expected) problems.push(`${scope.name}: unexpected ${key}`)
  }
  return problems
}

async function porter(args, token) {
  const command = token ? ["--token", token, ...args] : args
  try {
    return (await execute("porter", command, {timeout: 60_000, maxBuffer: 8 * 1024 * 1024})).stdout
  } catch {
    // CLI output and arguments may contain secrets. Never relay them.
    throw new Error("Porter read failed; check credentials and read permissions. Output suppressed.")
  }
}

export async function checkHealth(contract, {run = porter, token = process.env.PORTER_TOKEN} = {}) {
  const problems = []
  for (const cluster of contract.clusters) {
    const apps = contract.apps.filter((app) => app.cluster === cluster.id)
    const flags = ["--project", String(contract.project), "--cluster", String(cluster.id)]
    for (const scope of contract.groups.filter((group) => group.cluster === cluster.id)) {
      const exported = await run(["env", "pull", "--group", scope.name, ...flags], token)
      problems.push(...groupProblems(scope, exported))
    }
    // Bounded batches keep the audit read-only and avoid overloading the API.
    for (let offset = 0; offset < apps.length; offset += 4) {
      const batch = await Promise.all(
        apps.slice(offset, offset + 4).map(async (app) => {
          const appFlags = [...flags, "--target", cluster.target]
          const [yaml, overrides] = await Promise.all([
            run(["app", "yaml", app.name, ...appFlags], token),
            run(["env", "pull", "--app", app.name, ...appFlags], token),
          ])
          return appProblems(app, yaml, overrides)
        }),
      )
      problems.push(...batch.flat())
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const contract = JSON.parse(await readFile(contractUrl, "utf8"))
    const problems = await checkHealth(contract)
    if (problems.length) {
      console.error(problems.join("\n"))
      process.exitCode = 1
    } else {
      console.info(
        `Doppler groups complete for ${contract.apps.length} managed apps; no Porter overrides or manual groups.`,
      )
      if (contract.exceptions?.length)
        console.info(
          `${contract.exceptions.length} documented legacy exceptions remain outside the managed app checks.`,
        )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
