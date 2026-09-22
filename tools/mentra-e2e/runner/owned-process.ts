type Child = Pick<ReturnType<typeof Bun.spawn>, "exited" | "kill" | "exitCode" | "signalCode">

async function exitedWithin(child: Child, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Only accepts a process handle created by this runner, never a discovered PID. */
export async function stopOwnedProcess(child: Child, signal: "SIGTERM" | "SIGINT" = "SIGTERM", graceMs = 15000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill(signal)
  if (await exitedWithin(child, graceMs)) return
  child.kill("SIGKILL")
  if (!(await exitedWithin(child, 2000))) throw new Error("Owned child did not exit after forced shutdown")
  // A forced exit is not proof of normal browser/recording cleanup.
  throw new Error("Owned child required forced shutdown; its cleanup is unqualified")
}
