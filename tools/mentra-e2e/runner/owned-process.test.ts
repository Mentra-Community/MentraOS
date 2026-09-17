import {expect, test} from "bun:test"
import {stopOwnedProcess} from "./owned-process"

test("a graceful owned child can finalize evidence before exit", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)`,
    ],
    {stdout: "pipe"},
  )
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
    reader.releaseLock()
    await stopOwnedProcess(child)
    expect(await child.exited).toBe(0)
  } finally {
    child.kill("SIGKILL")
  }
})

test("a hung child cannot block other cleanup or be reported as graceful", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`],
    {stdout: "pipe"},
  )
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready")
    reader.releaseLock()
    await expect(stopOwnedProcess(child, "SIGTERM", 100)).rejects.toThrow("forced shutdown")
    expect(child.signalCode).toBe("SIGKILL")
  } finally {
    child.kill("SIGKILL")
  }
})
