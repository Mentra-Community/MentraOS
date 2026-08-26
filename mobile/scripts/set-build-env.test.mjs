import assert from "node:assert/strict"
import test from "node:test"

import {resolveBuildUser} from "./set-build-env.mjs"

test("uses the GitHub actor for CI build metadata", () => {
  assert.equal(
    resolveBuildUser({
      githubActor: "mentra release bot",
      readGitUsername: () => {
        throw new Error("Git config should not be read")
      },
    }),
    "mentra_release_bot",
  )
})

test("falls back to the local Git username outside CI", () => {
  assert.equal(resolveBuildUser({githubActor: "", readGitUsername: () => "Philippe Ferreira\n"}), "Philippe_Ferreira")
})

test("does not fail a build when Git user.name is unset", () => {
  assert.equal(
    resolveBuildUser({
      githubActor: null,
      readGitUsername: () => {
        throw new Error("missing git user.name")
      },
    }),
    "unknown",
  )
})
