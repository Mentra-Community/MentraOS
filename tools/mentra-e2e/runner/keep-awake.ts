export const KEEP_AWAKE_SECONDS = 4 * 60 * 60

// Scoped power assertions, not input events or persistent system preferences.
// -w also releases them if the runner exits before its normal cleanup.
export function keepAwake() {
  const child = Bun.spawn(
    ["/usr/bin/caffeinate", "-d", "-i", "-u", "-t", String(KEEP_AWAKE_SECONDS), "-w", String(process.pid)],
    {stdin: "ignore", stdout: "ignore", stderr: "ignore"},
  )
  return {
    pid: child.pid,
    async stop() {
      if (child.exitCode === null) child.kill()
      await child.exited
    },
  }
}
