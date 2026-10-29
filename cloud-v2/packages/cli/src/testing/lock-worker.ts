/**
 * A separate process for the lock tests: takes `<lock>` `<rounds>` times and appends each
 * holding interval (`start end` in ms) to `<log>`.
 *
 *   bun src/testing/lock-worker.ts <lock> <log> <rounds>
 */

import {appendFileSync} from "node:fs"

import {withFileLock} from "../file-lock"

const [lock, log, rounds] = process.argv.slice(2)
for (let round = 0; round < Number(rounds); round += 1) {
  await withFileLock(lock!, {staleMs: 5_000, waitMs: 20_000, busyMessage: "busy"}, async () => {
    const start = performance.timeOrigin + performance.now()
    await new Promise(resolve => setTimeout(resolve, 15))
    const end = performance.timeOrigin + performance.now()
    appendFileSync(log!, `${start} ${end}\n`)
  })
}
