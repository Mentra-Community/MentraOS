import {afterAll, describe, expect, test} from "bun:test"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "fs"
import {tmpdir} from "os"
import {dirname, join} from "path"
import {spawn, spawnSync} from "child_process"

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
  "api repos/Mentra-Community/fixture/pulls/1/reviews")
    case "\${FAKE_GH_REVIEWS:-ok}" in
      fail) echo "gh: HTTP 502 from GitHub" >&2; exit 1 ;;
      garbage) echo "not a number" ;;
      *) cat "$FAKE_STATE/receipts" 2>/dev/null || echo 0 ;;
    esac ;;
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
  hang)
    # Like a Codex tool command: a descendant in its own session and process group.
    python3 -c 'import os,time; os.setsid(); time.sleep(300)' & echo $! >> "$FAKE_STATE/grandchildren"
    sleep 300 & echo $! >> "$FAKE_STATE/grandchildren"
    echo '{"type":"item"}'; sleep 120 ;;
  silent-hang)      sleep 120 ;;
  orphan)
    # Codex dies first: its tool command keeps running in its own session and
    # re-parents to init before the runner can walk the tree.
    python3 -c 'import os,time; os.setsid(); time.sleep(300)' & echo $! >> "$FAKE_STATE/grandchildren"
    echo '{"type":"item"}'; sleep 0.3; exit 1 ;;
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

// The wrapper honours several environment overrides (CODEX_BIN, GH_ACCOUNT, GH_TOKEN,
// model, limits). None may leak in from the developer's shell: the fixtures must be the
// only gh and codex the scripts can reach, and GH_ACCOUNT must be derived, not inherited.
function env(f, extraEnv = {}) {
  const base = {...process.env}
  for (const k of Object.keys(base)) {
    if (/^(CODEX_|GH_|REVIEW_|STALL_|MAX_|POLL_|ATTEMPTS$|LOCK_)/.test(k)) delete base[k]
  }
  return {
    ...base,
    PATH: `${f.bin}:${process.env.PATH}`,
    CODEX_BIN: join(f.bin, "codex"),
    FAKE_ORIGIN: f.origin,
    FAKE_STATE: f.state,
    CODEX_REVIEW_HOME: f.reviews,
    STALL_SECONDS: "2",
    POLL_SECONDS: "1",
    MAX_SECONDS: "30",
    ATTEMPTS: "2",
    ...extraEnv,
  }
}

function run(f, args, extraEnv = {}) {
  const r = spawnSync("bash", [wrapper, ...args], {encoding: "utf8", timeout: 90_000, env: env(f, extraEnv)})
  return {code: r.status, out: `${r.stdout}${r.stderr}`}
}

function runAsync(f, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [wrapper, ...args], {env: env(f, extraEnv)})
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("close", (code) => resolve({code, out}))
  })
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

  test("inherited review overrides never reach the scripts", () => {
    const f = makeFixture()
    const poisoned = {...process.env, CODEX_BIN: "/nonexistent/codex", GH_ACCOUNT: "app", GH_TOKEN: "leaked"}
    const saved = process.env
    process.env = poisoned
    try {
      const r = run(f, [f.repo, "1"])
      expect(r.out).toContain("GH_ACCOUNT=own")
      expect(r.out).toContain("codex-pr-review: done")
      expect(codexCalls(f)).toBe(1)
    } finally {
      process.env = saved
    }
  }, 90_000)

  test("works when stat has GNU semantics", () => {
    const f = makeFixture()
    // GNU: `stat -c %Y` is the mtime; `stat -f` is filesystem status and prints text with exit 0.
    writeFileSync(
      join(f.bin, "stat"),
      '#!/usr/bin/env bash\nif [[ "$1" == "-c" ]]; then exec /usr/bin/stat -f %m "$3"; fi\nif [[ "$1" == "-f" ]]; then echo "  File: \\"$3\\""; exit 0; fi\nexec /usr/bin/stat "$@"\n',
      {mode: 0o755},
    )
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "post-then-crash"})
    expect(r.out).not.toContain("unbound variable")
    expect(r.out).toContain("codex-pr-review: done")
  }, 90_000)

  test("a stale lock replaced by a live one after inspection is not stolen", () => {
    const f = makeFixture()
    mkdirSync(`${f.worktree}.lock`)
    writeFileSync(`${f.worktree}.lock/pid`, "999999")
    // Between the first inspection and the reclaim, another caller reclaims the lock
    // and starts running (its live pid is ours). The late reclaimer must back off.
    const hook = `echo ${process.pid} > "${f.worktree}.lock/pid"`
    const r = run(f, [f.repo, "1"], {CODEX_REVIEW_HOOK_BEFORE_RECLAIM: hook})
    expect(r.out).toContain(`is running (pid ${process.pid})`)
    expect(r.out).not.toContain("reclaiming")
    expect(readFileSync(`${f.worktree}.lock/pid`, "utf8").trim()).toBe(String(process.pid))
    expect(existsSync(`${f.worktree}.lock.reclaim`)).toBe(false)
    expect(codexCalls(f)).toBe(0)
  }, 90_000)

  test("fails closed while another caller holds the reclaim mutex", () => {
    const f = makeFixture()
    mkdirSync(`${f.worktree}.lock`)
    writeFileSync(`${f.worktree}.lock/pid`, "999999")
    mkdirSync(`${f.worktree}.lock.reclaim`)
    const r = run(f, [f.repo, "1"])
    expect(r.out).toContain("another caller is reclaiming")
    expect(existsSync(`${f.worktree}.lock.reclaim`)).toBe(true)
    expect(existsSync(`${f.worktree}.lock/pid`)).toBe(true)
    expect(codexCalls(f)).toBe(0)
  }, 90_000)

  test("two callers recovering the same stale lock: the late one sees the winner and backs off", async () => {
    const f = makeFixture()
    mkdirSync(`${f.worktree}.lock`)
    writeFileSync(`${f.worktree}.lock/pid`, "999999")
    // Contender B reclaims and then hangs, so it stays the live owner. Contender A
    // pauses after its first inspection until B's live pid is in the lock, which
    // is exactly the interleaving that used to steal B's fresh lock.
    const waitForWinner = `until pid=$(cat "${f.worktree}.lock/pid" 2>/dev/null) && [[ "$pid" != 999999 ]] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; done`
    const [a, b] = await Promise.all([
      runAsync(f, [f.repo, "1"], {
        CODEX_REVIEW_HOOK_BEFORE_RECLAIM: waitForWinner,
        FAKE_CODEX_MODE: "hang",
        ATTEMPTS: "1",
      }),
      runAsync(f, [f.repo, "1"], {FAKE_CODEX_MODE: "hang", ATTEMPTS: "1"}),
    ])
    const both = `--- A ---\n${a.out}\n--- B ---\n${b.out}`
    expect(both).toContain("reclaiming stale lock left by dead pid 999999")
    expect(both).toMatch(/is running \(pid \d+\)/)
    expect(a.out).not.toContain("reclaiming")
    expect(codexCalls(f)).toBe(1)
    expect(existsSync(`${f.worktree}.lock`)).toBe(false)
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
    expect(r.out).toContain("reclaiming stale lock left by dead pid 999999")
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

  test("descendants of a killed attempt, including ones in their own session, are terminated before the retry", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "hang"})
    expect(r.out).toContain("codex-pr-review: FAILED")
    const pids = readFileSync(join(f.state, "grandchildren"), "utf8").trim().split("\n").map(Number)
    expect(pids.length).toBe(4) // two per attempt: one in its own session, one in the group
    for (const pid of pids) {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    }
  }, 90_000)

  test("a tool command that outlives a crashed Codex is found and terminated", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "orphan"})
    expect(r.out).toContain("codex-pr-review: FAILED")
    const pids = readFileSync(join(f.state, "grandchildren"), "utf8").trim().split("\n").map(Number)
    expect(pids.length).toBe(2) // one orphan per attempt; the first must be dead before the retry
    for (const pid of pids) {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    }
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

describe("receipt lookup failures", () => {
  test("a failed lookup after a clean Codex exit is FAILED, never done", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_GH_REVIEWS: "fail"})
    expect(r.out).toContain("cannot verify whether the review was posted")
    expect(r.out).not.toContain("codex-pr-review: done")
  }, 90_000)

  test("a crash with unknown posting status is not retried", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_CODEX_MODE: "post-then-crash", FAKE_GH_REVIEWS: "fail"})
    expect(r.out).toContain("codex-pr-review: FAILED")
    expect(codexCalls(f)).toBe(1)
    const runner = readFileSync(join(f.reviews, sh(f.reviews, "ls"), "runner.log"), "utf8")
    expect(runner).toContain("cannot tell whether attempt 1 posted its review")
  }, 90_000)

  test("an unparseable lookup is treated as unknown", () => {
    const f = makeFixture()
    const r = run(f, [f.repo, "1"], {FAKE_GH_REVIEWS: "garbage"})
    expect(r.out).toContain("cannot verify whether the review was posted")
    expect(r.out).not.toContain("codex-pr-review: done")
  }, 90_000)
})

describe("review-receipt.sh", () => {
  function receiptRun(f, extraEnv = {}) {
    return spawnSync("bash", [receipt, "Mentra-Community/fixture", "1", "abc", "2026-01-01T00:00:00Z"], {
      encoding: "utf8",
      env: {...process.env, PATH: `${f.bin}:${process.env.PATH}`, FAKE_STATE: f.state, ...extraEnv},
    })
  }

  test("exits 2 with no output when GitHub fails or answers garbage", () => {
    const f = makeFixture()
    for (const mode of ["fail", "garbage"]) {
      const r = receiptRun(f, {FAKE_GH_REVIEWS: mode})
      expect(r.status).toBe(2)
      expect(r.stdout.trim()).toBe("")
    }
  })

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
