import assert from "node:assert/strict"
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {installPackages, mobilePackages} from "./install-android-sdk.mjs"
import {MOBILE_INPUT_PATHS, MOBILE_PR_PATHS} from "./pr-mobile-build.mjs"

function fixture(t, outcomes) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk retry "))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(path.join(dir, "outcomes.json"), JSON.stringify(outcomes))
  const command = path.join(dir, "sdkmanager.cjs")
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const file = path.join(__dirname, "calls.json");
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
const id = process.argv[3], n = calls.filter(x => x[1] === id).length;
calls.push(process.argv.slice(2));
fs.writeFileSync(file, JSON.stringify(calls));
const outcomes = JSON.parse(fs.readFileSync(path.join(__dirname, "outcomes.json")));
const steps = outcomes[id] || [{code: 0}];
const step = steps[Math.min(n, steps.length - 1)];
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
if (step.signal) process.kill(process.pid, step.signal);
else process.exitCode = step.code;
`,
    {mode: 0o755},
  )
  let log = ""
  return {
    dir,
    options: {
      command,
      delayMs: 0,
      output: {
        write: (chunk) => {
          log += chunk.toString()
        },
      },
    },
    calls: () => JSON.parse(readFileSync(path.join(dir, "calls.json"), "utf8")),
    log: () => log,
  }
}

const badZip = {
  code: 1,
  stderr:
    "Warning: An error occurred while preparing SDK package Android SDK Platform 33: Error on ZipFile unknown archive\njava.util.zip.ZipException: Archive is not a ZIP archive\n",
}

test("retries a corrupt Platform 33 archive without repeating successful packages", async (t) => {
  const f = fixture(t, {"platforms;android-33": [badZip, {code: 0}]})
  await installPackages(["platform-tools", "platforms;android-33", "platform-tools", "ndk;27.1.12297006"], f.options)
  assert.deepEqual(f.calls(), [
    ["--install", "platform-tools"],
    ["--install", "platforms;android-33"],
    ["--install", "platforms;android-33"],
    ["--install", "ndk;27.1.12297006"],
  ])
  assert.match(f.log(), /Transient download failure/)
})

test("NDK archive failures are retried even if sdkmanager incorrectly exits zero", async (t) => {
  const f = fixture(t, {"ndk;27.1.12297006": [{...badZip, code: 0}, {code: 0}]})
  await installPackages(["ndk;27.1.12297006"], f.options)
  assert.equal(f.calls().length, 2)
})

test("permanent corruption exhausts exactly three attempts and stops before later packages", async (t) => {
  const f = fixture(t, {"platforms;android-33": [badZip]})
  await assert.rejects(installPackages(["platforms;android-33", "platform-tools"], f.options), {exitCode: 1})
  assert.equal(f.calls().length, 3)
})

test("temporary network errors recover with bounded retries", async (t) => {
  const f = fixture(t, {
    "cmake;3.22.1": [{code: 1, stderr: "java.net.SocketTimeoutException: Read timed out"}, {code: 0}],
  })
  await installPackages(["cmake;3.22.1"], f.options)
  assert.equal(f.calls().length, 2)
})

for (const message of [
  "Failed to find package",
  "Licenses have not been accepted",
  "Permission denied",
  "No space left on device",
  "Unexpected installer configuration error",
]) {
  test(`does not retry deterministic errors: ${message}`, async (t) => {
    const f = fixture(t, {"platform-tools": [{code: 7, stderr: message}]})
    await assert.rejects(installPackages(["platform-tools"], f.options), {exitCode: 7})
    assert.equal(f.calls().length, 1)
  })
}

test("a killed installer is not retried", async (t) => {
  const f = fixture(t, {"platform-tools": [{signal: "SIGTERM", stderr: badZip.stderr}]})
  await assert.rejects(installPackages(["platform-tools"], f.options), {exitCode: 143})
  assert.equal(f.calls().length, 1)
})

test("a permanent error takes precedence over a transient error in the same attempt", async (t) => {
  const f = fixture(t, {"platform-tools": [{...badZip, stderr: `${badZip.stderr}\nNo space left on device`}]})
  await assert.rejects(installPackages(["platform-tools"], f.options), {exitCode: 1})
  assert.equal(f.calls().length, 1)
})

test("rejects bad arguments and missing executables without starting an installation", async (t) => {
  const f = fixture(t, {})
  await assert.rejects(installPackages([], f.options), /Expected Android SDK package IDs/)
  await assert.rejects(installPackages(["--licenses"], f.options), /Expected Android SDK package IDs/)
  await assert.rejects(installPackages(["platform-tools"], {...f.options, command: path.join(f.dir, "missing")}), {
    code: "ENOENT",
  })
})

test("resolves versions from the installed React Native and lc3Lib sources before running Gradle", (t) => {
  const f = fixture(t, {})
  const rn = path.join(f.dir, "node_modules/react-native/gradle")
  const lc3 = path.join(f.dir, "modules/bluetooth-sdk/android/lc3Lib")
  mkdirSync(rn, {recursive: true})
  mkdirSync(lc3, {recursive: true})
  writeFileSync(
    path.join(rn, "libs.versions.toml"),
    'compileSdk = "37"\nbuildTools = "37.0.1"\nndkVersion = "28.1.12345678"\n',
  )
  writeFileSync(
    path.join(lc3, "build.gradle"),
    "android { compileSdk 34\n externalNativeBuild { cmake { path file(\"CMakeLists.txt\")\n version '3.25.1' } } }",
  )
  assert.deepEqual(mobilePackages(f.dir), [
    "platform-tools",
    "platforms;android-37",
    "build-tools;37.0.1",
    "platforms;android-34",
    "platforms;android-31",
    "ndk;28.1.12345678",
    "cmake;3.25.1",
  ])
  writeFileSync(path.join(rn, "libs.versions.toml"), 'compileSdk = "37"')
  assert.throws(() => mobilePackages(f.dir), /Missing buildTools/)
})

test("both workflows install packages before Gradle and changes invalidate APK reuse", () => {
  for (const name of ["mentra-app-android-unit-tests.yml", "mentra-app-android-build.yml"]) {
    const workflow = readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")
    assert.match(workflow, /packages: ""/)
    const setup = workflow.indexOf("node .github/scripts/install-android-sdk.mjs --mobile mobile")
    assert.ok(setup > workflow.indexOf("bun install --frozen-lockfile"))
    const gradle = workflow.indexOf("./gradlew")
    assert.ok(gradle > setup)
    assert.ok(workflow.includes(".github/scripts/install-android-sdk*"))
    assert.ok(workflow.includes("node --test .github/scripts/install-android-sdk.test.mjs"))
    assert.doesNotMatch(workflow, /Retry build with clean cache|steps\.gradle-build/)
    for (const step of workflow.split(/\n      - name:/).filter((step) => step.includes("./gradlew"))) {
      assert.doesNotMatch(step, /continue-on-error/)
    }
  }
  assert.ok(MOBILE_INPUT_PATHS.includes(".github/scripts/install-android-sdk.mjs"))
  assert.ok(MOBILE_PR_PATHS.includes(".github/scripts/install-android-sdk*"))
})
