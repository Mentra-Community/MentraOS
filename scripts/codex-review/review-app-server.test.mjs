import {afterAll, describe, expect, test} from "bun:test"
import {spawn, spawnSync} from "node:child_process"
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const roots = []
afterAll(() => { for (const path of roots) rmSync(path, {recursive: true, force: true}) })
function fixture(mode = "ok") {
  const path = mkdtempSync(join(tmpdir(), "review-app-server-"))
  roots.push(path)
  const codex = join(path, "fake-codex")
  const prompt = join(path, "prompt.txt")
  const output = join(path, "output.txt")
  writeFileSync(codex, `#!/usr/bin/env bash\nexec node '${join(here, "fixtures/fake-app-server.mjs")}'\n`, {mode: 0o755})
  writeFileSync(prompt, "Review the exact checkout without changing files.")
  return {
    path, output,
    args: [join(here, "review-app-server.mjs"), codex, path, join(path, "checkout"), output, prompt, "gpt-6-astra", "medium", "fixture #1 · review", "project-1"],
    env: {...process.env, FAKE_STATE: path, FAKE_CODEX_MODE: mode, CODEX_REVIEW_ATTEMPT: "fixture-attempt", GH_TOKEN: "fixture-non-secret"},
  }
}
const run = (f) => spawnSync("node", f.args, {env: f.env, encoding: "utf8", timeout: 10_000})
const requests = (f) => readFileSync(join(f.path, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse)

describe("project review app-server protocol", () => {
  test("uses the actual interactive protocol and preserves model, workspace, prompt and child environment", () => {
    const f = fixture()
    const result = run(f)
    expect(result.status).toBe(0)
    expect(readFileSync(f.output, "utf8")).toBe("Approve. reviewed\n")
    const sent = requests(f)
    expect(sent.map((x) => x.method)).toEqual(["initialize", "initialized", "thread/start", "thread/name/set", "turn/start"])
    expect(sent[2].params).toMatchObject({
      model: "gpt-6-astra", cwd: f.path, projectId: "project-1", ephemeral: false,
      runtimeWorkspaceRoots: [f.path, join(f.path, "checkout")],
      approvalPolicy: "never", sandbox: "danger-full-access", config: {model_reasoning_effort: "medium"},
    })
    expect(sent[2].params).not.toHaveProperty("threadSource")
    expect(sent[4].params).toMatchObject({threadId: "thread-1", model: "gpt-6-astra", effort: "medium"})
    expect(sent[4].params.input).toEqual([{type: "text", text: "Review the exact checkout without changing files.", text_elements: []}])
    expect(JSON.parse(readFileSync(join(f.path, "server-env.json"), "utf8"))).toEqual({marker: "fixture-attempt", postingTokenPresent: true})
    expect(result.stdout).toContain('"type":"thread.started","thread_id":"thread-1"')
    expect(result.stdout).toContain('"method":"item/completed"')
  })

  for (const mode of ["terminal-before-response", "terminal-items-only", "legacy-phase"]) {
    test(`accepts documented completion ordering/content: ${mode}`, () => {
      const f = fixture(mode)
      expect(run(f).status).toBe(0)
      expect(readFileSync(f.output, "utf8")).toContain("Approve.")
    })
  }

  for (const mode of ["rpc-error", "malformed-error", "invalid-json", "wrong-project", "exec-source", "eof", "wrong-thread", "wrong-turn", "failed-turn", "commentary-only", "missing-final", "client-request"]) {
    test(`refuses invalid/incomplete protocol without a final result: ${mode}`, () => {
      const f = fixture(mode)
      const result = run(f)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain("codex-review app-server:")
      expect(existsSync(f.output)).toBe(false)
    })
  }

  test("cancellation fails the adapter rather than treating progress as completion", async () => {
    const f = fixture("heartbeat-hang")
    const child = spawn("node", f.args, {env: f.env})
    let signalled = false
    const exit = new Promise((resolve) => child.once("close", resolve))
    child.stdout.on("data", (data) => {
      if (!signalled && data.toString().includes("thread/tokenUsage/updated")) {
        signalled = true
        child.kill("SIGTERM")
      }
    })
    child.stderr.resume()
    expect(await exit).not.toBe(0)
    expect(signalled).toBe(true)
    expect(existsSync(f.output)).toBe(false)
  }, 10_000)
})
