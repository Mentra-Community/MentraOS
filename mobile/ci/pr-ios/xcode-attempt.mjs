import {spawn} from "node:child_process"

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

export function runXcode(args, {onOutput, ...options} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("xcodebuild", args, {...options, stdio: ["inherit", "pipe", "pipe"]})
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
