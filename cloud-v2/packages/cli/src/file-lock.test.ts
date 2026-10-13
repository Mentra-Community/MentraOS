import {afterEach, beforeEach, expect, test} from "bun:test"
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {inspectLock, takeOverStaleLock, withFileLock, type FileLockOptions} from "./file-lock"

let dir = ""
let lock = ""
const options: FileLockOptions = {staleMs: 1_000, waitMs: 5_000, busyMessage: "busy"}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mentra-cli-lock-"))
  lock = join(dir, "store-refresh.lock")
})

afterEach(() => {
  rmSync(dir, {recursive: true, force: true})
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A lock left by a holder that died `ageMs` ago, as a crashed command leaves it. */
function deadHolderLock(holder: string, ageMs: number): void {
  mkdirSync(lock)
  writeFileSync(join(lock, "holder"), holder)
  const then = new Date(Date.now() - ageMs)
  utimesSync(join(lock, "holder"), then, then)
}

const holderOf = () => readFileSync(join(lock, "holder"), "utf8")

test("one command holds the lock at a time", async () => {
  let active = 0
  let most = 0
  await Promise.all(
    Array.from({length: 5}, () =>
      withFileLock(lock, options, async () => {
        active += 1
        most = Math.max(most, active)
        await sleep(20)
        active -= 1
      }),
    ),
  )
  expect(most).toBe(1)
  expect(existsSync(lock)).toBe(false)
})

test("separate processes never hold it at once", async () => {
  const log = join(dir, "intervals.log")
  writeFileSync(log, "")
  const workers = Array.from({length: 4}, () =>
    Bun.spawn(["bun", join(import.meta.dir, "testing", "lock-worker.ts"), lock, log, "3"], {stderr: "inherit"}),
  )
  expect(await Promise.all(workers.map(worker => worker.exited))).toEqual([0, 0, 0, 0])
  const intervals = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map(line => line.split(" ").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0])
  expect(intervals).toHaveLength(12)
  for (let i = 1; i < intervals.length; i += 1) expect(intervals[i]![0]).toBeGreaterThanOrEqual(intervals[i - 1]![1])
})

test("a lock whose holder died is taken over", async () => {
  deadHolderLock("dead-holder", 5_000)
  let ran = false
  await withFileLock(lock, options, async () => {
    ran = true
    expect(holderOf()).not.toBe("dead-holder")
  })
  expect(ran).toBe(true)
})

test("a live holder keeps its lock past the stale age, and the next command waits for it", async () => {
  const fast: FileLockOptions = {staleMs: 200, waitMs: 5_000, busyMessage: "busy"}
  const order: string[] = []
  const first = withFileLock(lock, fast, async () => {
    order.push("first start")
    await sleep(700)
    order.push("first end")
  })
  await sleep(50)
  const second = withFileLock(lock, fast, async () => {
    order.push("second")
  })
  await Promise.all([first, second])
  expect(order).toEqual(["first start", "first end", "second"])
})

test("a command that saw a stale lock late never moves the lock that replaced it", async () => {
  deadHolderLock("dead-holder", 5_000)
  // Another command inspects the dead holder's lock, and is overtaken before it acts.
  const seen = inspectLock(lock)
  expect(seen?.holder).toBe("dead-holder")
  await withFileLock(lock, options, async () => {
    const mine = holderOf()
    expect(mine).not.toBe("dead-holder")
    expect(takeOverStaleLock(lock, seen!)).toBe(false)
    expect(holderOf()).toBe(mine)
  })
})

test("a holder whose lock was taken over does not release its successor's lock", async () => {
  const slow: FileLockOptions = {staleMs: 200, waitMs: 5_000, busyMessage: "busy", heartbeatMs: 60_000}
  let successorHolder = ""
  let releaseSuccessor = () => {}
  let successor: Promise<void> | undefined
  await withFileLock(lock, slow, async () => {
    // This holder stops touching its lock (as a suspended command does); another command takes over.
    const then = new Date(Date.now() - 5_000)
    utimesSync(join(lock, "holder"), then, then)
    successor = withFileLock(lock, slow, async () => {
      successorHolder = holderOf()
      await new Promise<void>(resolve => (releaseSuccessor = resolve))
    })
    while (!successorHolder) await sleep(10)
  })
  expect(holderOf()).toBe(successorHolder)
  releaseSuccessor()
  await successor
  expect(existsSync(lock)).toBe(false)
})

test("a command gives up waiting for a busy lock after waitMs", async () => {
  let release = () => {}
  const holding = withFileLock(lock, options, () => new Promise<void>(resolve => (release = resolve)))
  await sleep(20)
  const started = Date.now()
  await expect(withFileLock(lock, {...options, waitMs: 300}, async () => {})).rejects.toThrow("busy")
  expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  release()
  await holding
})

test("what earlier takeovers left behind is cleared once it is old", async () => {
  mkdirSync(`${lock}.gone-old`)
  writeFileSync(join(`${lock}.gone-old`, "holder"), "old")
  mkdirSync(`${lock}.new-crashed`)
  deadHolderLock("dead-holder", 5_000)
  await sleep(150)

  await withFileLock(lock, {...options, tombstoneMs: 100}, async () => {})

  const left = readdirSync(dir).sort()
  // What this takeover and this release left stays, for any command that saw those locks earlier.
  expect(left).toContain("store-refresh.lock.gone-dead-holder")
  expect(left).toHaveLength(2)
  expect(left.every(name => name.startsWith("store-refresh.lock.gone-"))).toBe(true)
  expect(left).not.toContain("store-refresh.lock.gone-old")
})

test("a holder that resumes and releases after another command saw its lock stale leaves that command nothing to move", async () => {
  const slow: FileLockOptions = {staleMs: 200, waitMs: 5_000, busyMessage: "busy", heartbeatMs: 60_000}
  let seen: ReturnType<typeof inspectLock> = null
  await withFileLock(lock, slow, async () => {
    // This holder was suspended long enough to look stale, and another command saw it so...
    const then = new Date(Date.now() - 5_000)
    utimesSync(join(lock, "holder"), then, then)
    seen = inspectLock(lock)
  })
  // ...then it resumed and released, and a third command took the lock.
  await withFileLock(lock, options, async () => {
    const mine = holderOf()
    expect(takeOverStaleLock(lock, seen!)).toBe(false)
    expect(holderOf()).toBe(mine)
  })
})
