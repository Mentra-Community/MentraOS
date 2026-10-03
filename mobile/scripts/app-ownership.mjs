import {randomUUID} from "node:crypto"
import {mkdir, open, readFile, rmdir, unlink} from "node:fs/promises"
import {homedir} from "node:os"
import {isAbsolute, join, resolve} from "node:path"
import {isDeepStrictEqual} from "node:util"

function validateReservation(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !== "fixtureID,runDirectory,runID" ||
    ![value.runID, value.fixtureID].every(
      (part) => typeof part === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(part),
    ) ||
    typeof value.runDirectory !== "string" ||
    !isAbsolute(value.runDirectory) ||
    resolve(value.runDirectory) !== value.runDirectory ||
    /[\0\r\n]/.test(value.runDirectory)
  )
    throw new Error("A retained app reservation requires the exact lifecycle owner")
}

async function syncDirectory(path) {
  const directory = await open(path, "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/** Shared with the native installer's AppOwnershipLease. Retained lifecycle
 * reservations can only transfer to the same run's explicit recovery process. */
export async function acquireAppOwnership(
  folder = join(homedir(), ".cache/mentra-e2e"),
  {installer = false, reservation, recovering = false} = {},
) {
  if (reservation !== undefined) validateReservation(reservation)
  if ((recovering && !reservation) || (installer && reservation))
    throw new Error("Only an owning lifecycle may recover its retained app reservation")
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
      if (owner.reservation !== undefined) validateReservation(owner.reservation)
      if (owner.reservation !== undefined && owner.retainOnExit !== true)
        throw new Error("Cannot verify the retained app reservation; recover it before continuing")
      const ownsRecovery =
        recovering && owner.retainOnExit === true && isDeepStrictEqual(owner.reservation, reservation)
      if (installer || ((owner.retainOnExit === true || recovering) && !ownsRecovery))
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
      await file.writeFile(
        JSON.stringify({
          pid: process.pid,
          token,
          ...(installer || reservation ? {retainOnExit: true} : {}),
          ...(reservation ? {reservation} : {}),
        }),
      )
      await file.sync()
    } finally {
      await file.close()
    }
    await syncDirectory(folder)
    let released
    return () =>
      (released ??= (async () => {
        const current = JSON.parse(await readFile(path, "utf8"))
        if (current.token === token && current.pid === process.pid) {
          await unlink(path)
          await syncDirectory(folder)
        }
      })())
  } finally {
    await rmdir(guard)
  }
}
