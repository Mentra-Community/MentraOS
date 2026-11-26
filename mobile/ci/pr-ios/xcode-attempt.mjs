import {spawn} from "node:child_process"
import {fileURLToPath} from "node:url"
import os from "node:os"
import path from "node:path"

// Xcode's compilation cache, on this Mac outside any one build's derived data,
// so a build reuses what an earlier build (any runner, PR or release) compiled
// from the same inputs. Xcode bounds its size (a share of the disk).
// Swift is cached only with explicit modules, which React Native's Podfile
// turns off for every pod when it uses prebuilt React Native: without them the
// pods' Swift (most of the build) compiles again on every run.
export const compilationCacheSettings = [
  "COMPILATION_CACHE_ENABLE_CACHING=YES",
  "SWIFT_ENABLE_EXPLICIT_MODULES=YES",
  `COMPILATION_CACHE_CAS_PATH=${path.join(os.homedir(), "Library/Caches/mentra-compilation-cache")}`,
]

// Xcode lists every failed build command at the end. Retry only when signing
// is the sole failure; mixed compiler/signing failures need normal diagnosis.
export function signingOnlyFailure({status, signal, output}) {
  if (status === 0 || signal) return false
  const summary = output.match(/The following build commands failed:\s*\n([\s\S]*?)\n\(\d+ failures?\)/)?.[1]
  const commands =
    summary
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean) || []
  return (
    commands.some((line) => line.startsWith("CodeSign ")) &&
    commands.every((line) => /^(CodeSign |Archiving workspace )/.test(line))
  )
}

export function runXcode(args, {onOutput, keychain, ...options} = {}) {
  return new Promise((resolve, reject) => {
    const command = keychain ? "python3" : "xcodebuild"
    const commandArgs = keychain
      ? [fileURLToPath(new URL("keychain-search.py", import.meta.url)), "run", keychain, "xcodebuild", ...args]
      : args
    const child = spawn(command, commandArgs, {...options, stdio: ["inherit", "pipe", "pipe"]})
    let output = ""
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        destination.write(chunk)
        output = (output + chunk).slice(-128 * 1024)
        onOutput?.(output)
      })
    }
    child.on("error", reject)
    child.on("close", (status, signal) => resolve({status, signal, output}))
  })
}
