import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {access, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {config} from "dotenv"
import {writeMacXcodeEnvironment} from "./ios-mac-environment.mjs"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "mentra-mac-env-"))
  t.after(() => rm(root, {recursive: true, force: true}))
  return {root, file: path.join(root, ".xcode.env.local")}
}

test("Xcode inherits effective overrides and shell-special values literally", async (t) => {
  const {root, file} = await fixture(t)
  const dotenv = path.join(root, ".env")
  const marker = path.join(root, "must-not-exist")
  const special = `spaces 'quotes' \"double\" $HOME $(touch ${marker}) \`touch ${marker}\` ; & |\nsecond line`
  await writeFile(dotenv, "EXPO_PUBLIC_CLOUD_CORE_URL=https://stale.test\nEXPO_PUBLIC_FROM_FILE=file default\n")
  await writeFile(file, `export NODE_BINARY='${process.execPath}'\nexport EXPO_PUBLIC_CLOUD_CORE_URL=stale\n`)
  const env = {PATH: process.env.PATH, EXPO_PUBLIC_CLOUD_CORE_URL: "https://chosen.test", EXPO_PUBLIC_LABEL: special}
  // Same precedence as setBuildEnv: inherited settings win over the dotenv file.
  config({path: dotenv, processEnv: env, quiet: true})
  await writeMacXcodeEnvironment(file, env)
  const output = execFileSync(
    "/bin/sh",
    ["-c", '. "$1"; "$NODE_BINARY" -e \'console.log(JSON.stringify(process.env))\'', "test", file],
    {env: {PATH: process.env.PATH}, encoding: "utf8"},
  )
  const received = JSON.parse(output)
  assert.equal(received.EXPO_PUBLIC_CLOUD_CORE_URL, "https://chosen.test")
  assert.equal(received.EXPO_PUBLIC_FROM_FILE, "file default")
  assert.equal(received.EXPO_PUBLIC_LABEL, special)
  assert.equal(received.NODE_BINARY, process.execPath)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await assert.rejects(access(marker), {code: "ENOENT"})
})

test("preserve a working prebuild Node pin and discard unrelated old shell text", async (t) => {
  const {root, file} = await fixture(t)
  const node = path.join(root, "node with spaces")
  await symlink(process.execPath, node)
  await writeFile(file, `export NODE_BINARY="${node}"\nPRIVATE_SECRET=old-secret\nnot_a_shell_command\n`)
  const actual = await writeMacXcodeEnvironment(file, {PATH: "/nonexistent"})
  assert.equal(actual, process.execPath)
  assert.doesNotMatch(await readFile(file, "utf8"), /old-secret|not_a_shell_command/)
})

test("an explicit Node pin wins and an invalid explicit pin fails", async (t) => {
  const {file} = await fixture(t)
  await writeFile(file, "export NODE_BINARY=/obsolete/prebuild/node\n")
  assert.equal(await writeMacXcodeEnvironment(file, {NODE_BINARY: process.execPath}), process.execPath)
  await assert.rejects(writeMacXcodeEnvironment(file, {NODE_BINARY: "/nonexistent/node"}), {code: "ENOENT"})
})

test("Bun selects actual Node from PATH when a prebuild pin is stale", async (t) => {
  const {root, file} = await fixture(t)
  await writeFile(file, "export NODE_BINARY=/obsolete/prebuild/node\n")
  const module = new URL("./ios-mac-environment.mjs", import.meta.url).href
  const code = `import {writeMacXcodeEnvironment} from ${JSON.stringify(
    module,
  )}; console.log(await writeMacXcodeEnvironment(process.argv[1], {PATH: process.env.PATH}));`
  const node = execFileSync("bun", ["--eval", code, file], {cwd: root, encoding: "utf8"}).trim()
  const versions = JSON.parse(execFileSync(node, ["-p", "JSON.stringify(process.versions)"], {encoding: "utf8"}))
  assert.ok(versions.node)
  assert.equal(versions.bun, undefined)
})
