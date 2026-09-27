import {randomUUID} from "node:crypto"
import {lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink} from "node:fs/promises"
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

/** A launched app's lock (`handOff`) is held by the app's own PID, with neither retention nor a reservation. */
const validLaunchedApp = (owner) =>
  owner.launchedApp === undefined ||
  (owner.launchedApp === true && owner.retainOnExit === undefined && owner.reservation === undefined)

/** Read only: the retained lifecycle reservation that holds the app lock, or undefined when none does (no lock, or a
 * lock held without a retained reservation). It never acquires, waits for, removes or changes the lock; a lock that
 * cannot be verified is an error, never taken as free. */
export async function retainedAppReservation(folder = join(homedir(), ".cache/mentra-e2e")) {
  let owner
  try {
    owner = JSON.parse(await readFile(join(folder, "com.mentra.mentra.lock"), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || !owner.token)
    throw new Error("Cannot verify the app lock owner")
  if (owner.retainOnExit !== undefined && typeof owner.retainOnExit !== "boolean")
    throw new Error("Cannot verify the retained app lock")
  if (!validLaunchedApp(owner)) throw new Error("Cannot verify the launched app lock")
  if (owner.reservation === undefined) return undefined
  validateReservation(owner.reservation)
  if (owner.retainOnExit !== true) throw new Error("Cannot verify the retained app reservation")
  return owner.reservation
}

/** Per-glasses leases live in the shared app folder's `glasses` directory, one lock folder per physical unit. Other
 * lock folders, such as an Android phone's, have none. */
export const glassesLeaseRoot = (folder = join(homedir(), ".cache/mentra-e2e")) => join(folder, "glasses")

/** As the lock primitive: an unverifiable PID is never treated as exited. */
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

/** Read only: one lock folder's state, validated by retainedAppReservation (PID, token, retention flag and
 * reservation). A lock with no directory entry is `absent`; a dangling symlink is an entry and is never free. A valid
 * reservation-less, non-retained lock whose process has exited is `reclaimable`, as acquireAppOwnership treats it;
 * every other valid lock is `held`. Any other content (JSON null, false, 0, a malformed PID, token or retention flag),
 * or a lock that changes while it is read, throws: it is never free. Nothing is acquired, changed or removed. */
export async function readLockState(folder) {
  const path = join(folder, "com.mentra.mentra.lock")
  const read = () =>
    readFile(path, "utf8").catch(async (error) => {
      if (error.code === "ENOENT" && (await lstat(path).then(() => false, (entry) => entry.code === "ENOENT")))
        return undefined
      throw error
    })
  const before = await read()
  if (before === undefined) return {state: "absent"}
  const reservation = await retainedAppReservation(folder)
  if ((await read()) !== before) throw new Error(`The lock in ${folder} changed while it was verified`)
  const owner = JSON.parse(before)
  if (reservation === undefined && owner.retainOnExit !== true && !processAlive(owner.pid)) return {state: "reclaimable"}
  return {state: "held", pid: owner.pid, ...(reservation ? {reservation} : {})}
}

/** Read only: the per-glasses lease folders under `root` that are held. Only an absent or `reclaimable` lock is free;
 * an unverifiable lock or an unreadable directory is held. A regular file is never a lease folder. */
export async function heldGlassesLeases(root) {
  let names
  try {
    names = (await readdir(root, {withFileTypes: true})).filter((entry) => !entry.isFile()).map((entry) => entry.name)
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const held = []
  for (const name of names.sort()) {
    const lease = await readLockState(join(root, name)).catch(() => ({state: "held"}))
    if (lease.state === "held") held.push(name)
  }
  return held
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
  let adopted // the PID of a running launched app this installer adopted
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
      if (!validLaunchedApp(owner)) throw new Error("Cannot verify the launched app lock; recover it before continuing")
      const ownsRecovery =
        recovering && owner.retainOnExit === true && isDeepStrictEqual(owner.reservation, reservation)
      // Mentra opened by an installer holds the lock with its own PID (handOff); readers see it held while it runs.
      // Only an installer adopts it: it keeps broad custody (no reservation) while it normally terminates that app,
      // then hands off to the next app or releases. Any other owner, which may narrow to one pair of glasses, must
      // wait until that process has exited (then the lock is reclaimed below as usual).
      if (owner.launchedApp === true && installer) {
        adopted = owner.pid
        await unlink(path)
      } else {
        if (installer || ((owner.retainOnExit === true || recovering) && !ownsRecovery))
          throw new Error(
            `Mentra is owned by a test or installation; finish it or recover its retained lease before installing: ${path}`,
          )
        try {
          process.kill(owner.pid, 0)
          throw new Error(
            owner.launchedApp === true
              ? `Mentra opened by an installer is running (PID ${owner.pid}); quit Mentra normally, or run the installer ` +
                  "with --no-launch, before starting"
              : `Another harness run owns the app (PID ${owner.pid})`,
          )
        } catch (probe) {
          if (probe.code !== "ESRCH") throw probe
          await unlink(path)
        }
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
    const release = () =>
      (released ??= (async () => {
        const current = JSON.parse(await readFile(path, "utf8"))
        if (current.token === token && current.pid === process.pid) {
          // An adopted app that was not terminated (for example after a failed installation) keeps the lock.
          if (adopted !== undefined && processAlive(adopted)) return handOff(adopted)
          await unlink(path)
          await syncDirectory(folder)
        }
      })())
    /** Transfer this installer's lock to the Mentra process it opened, instead of releasing it. The app keeps the lock
     * for its whole lifetime under its own PID; once that process exits the lock is reclaimable as usual. */
    const handOff = async (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
        throw new Error("A launched app hand-off requires the launched app's own process ID")
      try {
        await mkdir(guard, {mode: 0o700})
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        throw new Error(`Another app owner is acquiring the lock; stop all runs before removing ${guard}`)
      }
      try {
        const current = JSON.parse(await readFile(path, "utf8"))
        if (current.token !== token || current.pid !== process.pid)
          throw new Error("The app lock changed before its hand-off to the launched app")
        const next = `${path}.${token}.handoff`
        const file = await open(next, "wx", 0o600)
        try {
          await file.writeFile(JSON.stringify({pid, token, launchedApp: true}))
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(next, path)
        await syncDirectory(folder)
      } finally {
        await rmdir(guard)
      }
    }
    if (installer) release.handOff = handOff
    return release
  } finally {
    await rmdir(guard)
  }
}
