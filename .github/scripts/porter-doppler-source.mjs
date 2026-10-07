import {readFile, readdir} from "node:fs/promises"
import {fileURLToPath} from "node:url"
import {linkedGroups} from "./porter-doppler-health.mjs"

export function sourceProblems(name, text) {
  const problems = []
  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*env\s*:/.test(line)) problems.push(`${name}:${index + 1}: put application settings in Doppler`)
  }
  const groups = linkedGroups(text)
  if (groups.length !== 1 || !/^cloud-v2-[a-z0-9-]*doppler[a-z0-9-]*$/.test(groups[0])) {
    problems.push(`${name}: missing Doppler environment group`)
  }
  return problems
}

export async function checkSources() {
  const directory = new URL("../../cloud-v2/", import.meta.url)
  const names = (await readdir(directory)).filter((name) => /^porter(?:\.[a-z]+)?\.yaml$/.test(name))
  const problems = []
  for (const name of names) problems.push(...sourceProblems(name, await readFile(new URL(name, directory), "utf8")))
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await checkSources()
  if (problems.length) {
    console.error(problems.join("\n"))
    process.exitCode = 1
  } else console.info("Cloud deployment settings come from Doppler.")
}
