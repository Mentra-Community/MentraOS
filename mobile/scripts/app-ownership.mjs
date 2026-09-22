import {randomUUID} from "node:crypto"
import {mkdir, open, readFile, rmdir, unlink} from "node:fs/promises"
import {homedir} from "node:os"
import {join} from "node:path"

/** Shared with the native installer's AppOwnershipLease. Never reclaim a guard
 * or an installer's retained lease: interruption requires explicit recovery. */
export async function acquireAppOwnership(folder = join(homedir(), ".cache/mentra-e2e"), {installer = false} = {}) {
  await mkdir(folder, {recursive: true})
  const path = join(folder, "com.mentra.mentra.lock")
  const guard = `${path}.reclaim`
  const token = randomUUID()
  try {
    await mkdir(guard, {mode: 0o700})
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    throw new Error(`Another app owner is acquiring the lock; stop all runs before removing ${guard}`)
  }
  try {
    try {
      const owner = JSON.parse(await readFile(path, "utf8"))
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !owner.token)
        throw new Error("Cannot verify the app lock owner; stop all runs before removing the lock")
      if (owner.retainOnExit !== undefined && typeof owner.retainOnExit !== "boolean")
        throw new Error("Cannot verify the retained app lock; recover it before continuing")
      if (installer || owner.retainOnExit === true)
        throw new Error(
          `Mentra is owned by a test or installation; finish it or recover its retained lease before installing: ${path}`,
        )
      try {
        process.kill(owner.pid, 0)
        throw new Error(`Another harness run owns the app (PID ${owner.pid})`)
      } catch (probe) {
        if (probe.code !== "ESRCH") throw probe
        await unlink(path)
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const file = await open(path, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify({pid: process.pid, token, ...(installer ? {retainOnExit: true} : {})}))
      await file.sync()
    } finally {
      await file.close()
    }
    let released
    return () =>
      (released ??= (async () => {
        const current = JSON.parse(await readFile(path, "utf8"))
        if (current.token === token && current.pid === process.pid) await unlink(path)
      })())
  } finally {
    await rmdir(guard)
  }
}
