import {afterAll, describe, expect, test} from "bun:test"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "fs"
import {tmpdir} from "os"
import {dirname, join} from "path"
import {spawnSync} from "child_process"

// Lifecycle tests for codex-pr-review.sh + codex-review.sh, driven with fake
// `gh` and `codex` binaries on PATH against a local bare "origin". Nothing here
// talks to GitHub or runs a model.

const here = dirname(new URL(import.meta.url).pathname)
const wrapper = join(here, "codex-pr-review.sh")
const receipt = join(here, "review-receipt.sh")
const roots = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, {recursive: true, force: true})
})

function sh(cwd, cmd) {
  const r = spawnSync("bash", ["-euo", "pipefail", "-c", cmd], {cwd, encoding: "utf8"})
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

const FAKE_GH = `#!/usr/bin/env bash
# Minimal gh for the wrapper: repo/PR metadata and the review-receipt query.
case "$1 $2" in
  "repo view") echo "Mentra-Community/fixture" ;;
  "pr view")
    if [[ "$*" == *headRefOid* ]]; then git -C "$FAKE_ORIGIN" rev-parse refs/pull/1/head
    else echo "alice main feature OPEN Fixture title"; fi ;;
  "api user") echo "bob" ;;
  "api repos/Mentra-Community/fixture/pulls/1/reviews") cat "$FAKE_STATE/receipts" 2>/dev/null || echo 0 ;;
  *) exit 0 ;;
esac
`

const FAKE_CODEX = `#!/usr/bin/env bash
# Fake codex exec: honours -o <file>, streams JSON events, and behaves per FAKE_CODEX_MODE.
out=""
while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
echo $(( $(cat "$FAKE_STATE/codex-calls" 2>/dev/null || echo 0) + 1 )) > "$FAKE_STATE/codex-calls"
post() { echo 1 > "$FAKE_STATE/receipts"; }
case "\${FAKE_CODEX_MODE:-ok}" in
  ok)               echo '{"type":"item"}'; post; echo "Approve. reviewed" > "$out"; exit 0 ;;
  post-then-crash)  echo '{"type":"item"}'; post; exit 1 ;;
  hang)             echo '{"type":"item"}'; sleep 120 ;;
  silent-hang)      sleep 120 ;;
esac
`

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-review-test-"))
  roots.push(root)
  const origin = join(root, "origin.git")
  const repo = join(root, "repo")
  const bin = join(root, "bin")
  const state = join(root, "state")
  mkdirSync(bin)
  mkdirSync(state)
  sh(root, `git init -q --bare -b main origin.git && git clone -q origin.git repo`)
  sh(
    repo,
    `git config user.email t@example.com && git config user.name t && echo base > file && git add file && git commit -qm base && git push -q origin main`,
  )
  sh(
    repo,
    `git checkout -qb feature && echo change >> file && git commit -qam change && git push -q origin feature && git checkout -q main`,
  )
  sh(origin, `git update-ref refs/pull/1/head "$(git rev-parse refs/heads/feature)"`)
  writeFileSync(join(bin, "gh"), FAKE_GH, {mode: 0o755})
  writeFileSync(join(bin, "codex"), FAKE_CODEX, {mode: 0o755})
  return {root, origin, repo, bin, state, worktree: `${repo}-pr-1`, reviews: join(root, "reviews")}
}

function run(f, args, extraEnv = {}) {
  const r = spawnSync("bash", [wrapper, ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      FAKE_ORIGIN: f.origin,
      FAKE_STATE: f.state,
      CODEX_REVIEW_HOME: f.reviews,
      STALL_SECONDS: "2",
      POLL_SECONDS: "1",
      MAX_SECONDS: "30",
      ATTEMPTS: "2",
      ...extraEnv,
    },
  })
  return {code: r.status, out: `${r.stdout}${r.stderr}`}
}

const codexCalls = (f) =>
  existsSync(join(f.state, "codex-calls")) ? Number(readFileSync(join(f.state, "codex-calls"), "utf8").trim()) : 0

describe("codex-pr-review.sh lifecycle", () => {
  test("posts, verifies the receipt, prints the done marker and releases the lock", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"])
    expect(r.out).toContain("codex-pr-review: done")
    expect(r.code).toBe(0)
    expect(existsSync(`${f.worktree}.codex-review-owned`)).toBe(true)
    expect(existsSync(`${f.worktree}.lock`)).toBe(false)
    expect(codexCalls(f)).toBe(1)
  }, 90_000)

  test("every preflight failure prints the FAILED marker", () => {
    const f = makeFixture()
    expect(run(f, []).out).toContain("codex-pr-review: FAILED: usage")
    expect(run(f, [join(f.root, "missing"), "1"]).out).toContain("codex-pr-review: FAILED: repo dir")
    expect(run(f, [f.repo, "x"]).out).toContain("codex-pr-review: FAILED: pr-number")
    expect(run(f, [f.root, "1"]).out).toContain("codex-pr-review: FAILED: " + f.root + " has no git remote")
  }, 90_000)

  test("never touches a sibling path it did not create", () => {
    const f = makeFixture()
    mkdirSync(f.worktree)
    writeFileSync(join(f.worktree, "precious"), "keep me")
    const r = run(f, [f.repo, "1"])
    expect(r.out).toContain("was not created by codex-pr-review")
    expect(readFileSync(join(f.worktree, "precious"), "utf8")).toBe("keep me")
    expect(codexCalls(f)).toBe(0)
  }, 90_000)

  test("reuses its own worktree after resetting leftovers", () => {
    const f = makeFixture()
    expect(run(f, [f.repo, "1"]).out).toContain("codex-pr-review: done")
    writeFileSync(join(f.worktree, "file"), "dirty")
    writeFileSync(join(f.worktree, "leftover"), "x")
    expect(run(f, [f.repo, "1"]).out).toContain("codex-pr-review: done")
    expect(sh(f.worktree, "git status --porcelain")).toBe("")
    expect(existsSync(join(f.worktree, "leftover"))).toBe(false)
  }, 90_000)

  test("fails closed while another run holds or is taking the lock", () => {
    const f = makeFixture()
    mkdirSync(`${f.worktree}.lock`)
    writeFileSync(`${f.worktree}.lock/pid`, String(process.pid))
    expect(run(f, [f.repo, "1"]).out).toContain(`is running (pid ${process.pid})`)
    rmSync(`${f.worktree}.lock/pid`)
    expect(run(f, [f.repo, "1"]).out).toContain("is starting (lock")
    expect(existsSync(`${f.worktree}.lock`)).toBe(true)
    expect(codexCalls(f)).toBe(0)
  }, 90_000)

  test("reclaims a lock whose owner is dead", () => {
    const f = makeFixture()
    mkdirSync(`${f.worktree}.lock`)
    writeFileSync(`${f.worktree}.lock/pid`, "999999")
    const r = run(f, [f.repo, "1"])
    expect(r.out).toContain("reclaiming lock left by dead pid 999999")
    expect(r.out).toContain("codex-pr-review: done")
  }, 90_000)

  test("a verdict posted before a crash is not retried into a duplicate", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "post-then-crash"})
    expect(r.out).toContain("codex-pr-review: done")
    expect(codexCalls(f)).toBe(1)
    const runner = readFileSync(join(f.reviews, sh(f.reviews, "ls"), "runner.log"), "utf8")
    expect(runner).toContain("posted its review before exiting")
  }, 90_000)

  test("a stalled attempt is killed, retried once, then reported as FAILED", () => {
    const f = makeFixture()
    const started = Date.now()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "hang"})
    expect(r.out).toContain("codex-pr-review: FAILED: runner did not finish")
    expect(codexCalls(f)).toBe(2)
    expect(Date.now() - started).toBeLessThan(60_000)
    const runner = readFileSync(join(f.reviews, sh(f.reviews, "ls"), "runner.log"), "utf8")
    expect(runner).toContain("stalled for")
    expect(runner).toContain("FAILED after 2 attempts")
  }, 90_000)

  test("an attempt that never emits an event is also killed", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "silent-hang", ATTEMPTS: "1"})
    expect(r.out).toContain("codex-pr-review: FAILED")
    expect(codexCalls(f)).toBe(1)
  }, 90_000)

  test("a clean exit without a review on the head is a failure, not done", () => {
    const f = makeFixture()
    // Pretend the receipt query sees nothing: freeze receipts at 0 after codex "posts".
    writeFileSync(
      join(f.bin, "codex"),
      FAKE_CODEX.replace('post() { echo 1 > "$FAKE_STATE/receipts"; }', "post() { :; }"),
      {mode: 0o755},
    )
    const r = run(f, [f.repo, "1"])
    expect(r.out).toContain("no review from this run is on")
    expect(r.out).not.toContain("codex-pr-review: done")
  }, 90_000)
})

describe("review-receipt.sh", () => {
  test("sums the per-page counts gh prints", () => {
    const f = makeFixture()
    writeFileSync(join(f.state, "receipts"), "1\n2\n")
    const r = spawnSync("bash", [receipt, "Mentra-Community/fixture", "1", "abc", "2026-01-01T00:00:00Z"], {
      encoding: "utf8",
      env: {...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_STATE: f.state},
    })
    expect(r.stdout.trim()).toBe("3")
  }, 90_000)
})
