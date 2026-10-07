import assert from "node:assert/strict"
import test from "node:test"
import {sourceProblems} from "./porter-doppler-source.mjs"

test("rejects application and ignored service-level overrides without exposing values", () => {
  const text =
    "envGroups:\n  - cloud-v2-dev-doppler\nenv:\n  KEY: private-value\nservices:\n  - name: web\n    env:\n      OTHER: private-value\n"
  const problems = sourceProblems("porter.yaml", text)
  assert.equal(problems.length, 2)
  assert.ok(!problems.join().includes("private-value"))
})

test("requires a Doppler group and permits deployment topology", () => {
  assert.deepEqual(
    sourceProblems(
      "porter.yaml",
      "envGroups:\n  - cloud-v2-prod-doppler-sync\nservices:\n  - name: web\n    port: 80\n",
    ),
    [],
  )
  assert.equal(sourceProblems("porter.yaml", "envGroups:\n  - manual\n").length, 1)
})
