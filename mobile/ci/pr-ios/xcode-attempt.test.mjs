import assert from "node:assert/strict"
import test from "node:test"
import {signingOnlyFailure} from "./xcode-attempt.mjs"

const output = `** ARCHIVE FAILED **
The following build commands failed:
  CodeSign /build/Mentra.app/Frameworks/Turf.framework (in target 'Mentra')
  Archiving workspace Mentra with scheme Mentra
(2 failures)
`
test("only a confirmed signing failure can skip the clean compile retry", () => {
  assert.equal(signingOnlyFailure({status: 65, output}), true)
  assert.equal(
    signingOnlyFailure({status: 65, output: output.replace("  Archiving", "  SwiftCompile broken.swift\n  Archiving")}),
    false,
  )
  assert.equal(signingOnlyFailure({status: 65, output: "errSecInternalComponent"}), false)
  assert.equal(signingOnlyFailure({status: null, signal: "SIGTERM", output}), false)
  assert.equal(signingOnlyFailure({status: 0, output}), false)
})
