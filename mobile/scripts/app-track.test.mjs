import assert from "node:assert/strict"
import {createRequire} from "node:module"
import test from "node:test"

const require = createRequire(import.meta.url)
const {resolveAppTrack} = require("./app-track.cjs")
const {resolveAndroidPackageName} = require("./android-package-name.cjs")

// A fake git: `distances` gives the commits from HEAD back to each branch's merge base.
const gitWith = (distances) => (args) => {
  if (args[0] === "merge-base") {
    if (!(args[2] in distances)) throw new Error("unknown ref")
    return `base-of-${args[2]}`
  }
  if (args[0] === "rev-list") return String(distances[args[2].replace(/^base-of-(.*)\.\.HEAD$/, "$1")])
  throw new Error(`unexpected git ${args.join(" ")}`)
}

test("a local build takes the track of the nearer branch, staging on a tie", () => {
  assert.equal(resolveAppTrack({env: {}, run: gitWith({"origin/dev": 2, "origin/staging": 40})}), "dev")
  assert.equal(resolveAppTrack({env: {}, run: gitWith({"origin/dev": 40, "origin/staging": 2})}), "staging")
  assert.equal(resolveAppTrack({env: {}, run: gitWith({"origin/dev": 0, "origin/staging": 0})}), "staging")
  // Without the remote branches, the Mentra App, as before.
  assert.equal(resolveAppTrack({env: {}, run: gitWith({})}), "staging")
})

test("MENTRA_APP_TRACK wins, and a CI build that names none stays the Mentra App", () => {
  const dev = gitWith({"origin/dev": 0, "origin/staging": 9})
  assert.equal(resolveAppTrack({env: {MENTRA_APP_TRACK: "staging"}, run: dev}), "staging")
  assert.equal(resolveAppTrack({env: {MENTRA_APP_TRACK: "dev", CI: "true"}, run: dev}), "dev")
  assert.equal(resolveAppTrack({env: {CI: "true"}, run: dev}), "staging")
  assert.throws(() => resolveAppTrack({env: {MENTRA_APP_TRACK: "prod"}}), /must be dev or staging/)
})

test("the dev track builds com.mentra.mentra.dev", () => {
  assert.equal(resolveAndroidPackageName({track: "dev", buildName: ""}), "com.mentra.mentra.dev")
  assert.equal(resolveAndroidPackageName({track: "staging", buildName: ""}), "com.mentra.mentra")
  assert.equal(resolveAndroidPackageName({track: "staging", buildName: "stable"}), "com.mentra.mentra.stable")
})
