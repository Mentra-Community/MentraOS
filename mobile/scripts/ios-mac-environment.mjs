import {execFileSync} from "node:child_process"
import {chmod, readFile, writeFile} from "node:fs/promises"
import {parse} from "dotenv"
import {xcodeEnvironmentExports} from "./release-bundle-config.mjs"

function nodeExecutable(candidate, env) {
  return execFileSync(
    candidate,
    [
      "-e",
      "if (!process.versions.node || process.versions.bun) process.exit(1); process.stdout.write(process.execPath)",
    ],
    {env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000},
  ).trim()
}

/** Persist the resolved build values, not raw dotenv text, for Xcode child processes. */
export async function writeMacXcodeEnvironment(file, env = process.env) {
  let previous = ""
  try {
    previous = await readFile(file, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  // Expo pins Node during prebuild. Read only that value as data; never source this file.
  const generatedNode = parse(previous).NODE_BINARY
  let nodeBinary
  if (env.NODE_BINARY) {
    nodeBinary = nodeExecutable(env.NODE_BINARY, env)
  } else {
    try {
      if (generatedNode) nodeBinary = nodeExecutable(generatedNode, env)
    } catch {
      // Prebuild can leave a temporary or obsolete executable path.
    }
    nodeBinary ??= nodeExecutable("node", env)
  }
  // This entrypoint runs under Bun, so process.execPath is not a Node pin.
  await writeFile(
    file,
    `# Effective build environment for Xcode.\n${xcodeEnvironmentExports(env, nodeBinary).join("\n")}\n`,
    {mode: 0o600},
  )
  await chmod(file, 0o600)
  return nodeBinary
}
