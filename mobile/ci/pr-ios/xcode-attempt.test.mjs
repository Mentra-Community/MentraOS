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

test("early archive diagnostics survive a bounded output tail through the observer", async (t) => {
  const {mkdtempSync, writeFileSync, rmSync} = await import("node:fs")
  const {tmpdir} = await import("node:os")
  const path = await import("node:path")
  const {execFileSync} = await import("node:child_process")
  const directory = mkdtempSync(path.join(tmpdir(), "xcode-output-test-"))
  t.after(() => rmSync(directory, {recursive: true, force: true}))
  writeFileSync(path.join(directory, "xcodebuild"), `#!/usr/bin/env node
process.stdout.write("error: no such module 'MapboxDirections'\\n");
setTimeout(() => { process.stdout.write('compile noise\\n'.repeat(20000)); process.exitCode = 65; }, 30);
`, {mode: 0o755})
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {runXcode} from ${JSON.stringify(new URL("xcode-attempt.mjs", import.meta.url).href)};
    import {isSPMOrSentryTransientError} from ${JSON.stringify(new URL("../../scripts/release-utils.mjs", import.meta.url).href)};
    let seen = false;
    const result = await runXcode([], {env: process.env, onOutput: output => { seen ||= isSPMOrSentryTransientError({stdout: output}); }});
    assert.equal(result.status, 65);
    assert.equal(seen, true);
    assert.equal(result.output.includes('MapboxDirections'), false);
  `], {env: {...process.env, PATH: `${directory}:${process.env.PATH}`}, maxBuffer: 1024 * 1024})
})
