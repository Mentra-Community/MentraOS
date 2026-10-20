// Stripe stays out of MentraOS. Billing lives in the Store's billing module, the
// only code that talks to Stripe; Core only stores the licenses billing writes.
// No Stripe SDK, key, address or name belongs in Cloud V2's code, builds or
// configuration. Docs (markdown) are reviewed by people and are not scanned.
// This guard keeps it that way.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const GUARDED_DIR = "cloud-v2"

/** Code, build and configuration files: sources, manifests and lockfiles, workflows, Dockerfiles and env files. */
const GUARDED_FILE =
  /(\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|ya?ml)|(^|\/)bun\.lock|(^|\/)Dockerfile[^/]*|(^|\/)\.env[^/]*)$/

/**
 * Stripe by name (its SDK, `@stripe/*`, `api.stripe.com`), or a key of its shape: a secret, restricted or
 * publishable key (`sk_`, `rk_`, `pk_` then `live_` or `test_` and at least 20 characters), or a webhook
 * signing secret (`whsec_`). WorkOS's keys share the `sk_test_` prefix, so a short placeholder such as
 * the legacy claim tests' `sk_test_export` is not a key.
 */
const STRIPE = /stripe|\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{20,}|\bwhsec_[A-Za-z0-9]{20,}/i

/** Whether a repository path is one this guard scans. */
export function isGuarded(file) {
  return file.startsWith(`${GUARDED_DIR}/`) && GUARDED_FILE.test(file)
}

/**
 * The guarded files under `repoRoot`: tracked ones, and untracked ones git does not ignore (so a file
 * planted locally is caught before it is committed). Ignored build output and dependencies are not.
 */
function guardedFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", GUARDED_DIR], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  return [...new Set(result.stdout.split("\0").filter(Boolean))].filter(isGuarded)
}

/** Every `file:line: text` under `repoRoot` that names Stripe. A file listed but gone (deleted, not committed) is skipped. */
export function stripeMentions(repoRoot) {
  const mentions = []
  for (const file of guardedFiles(repoRoot)) {
    let text
    try {
      text = readFileSync(path.join(repoRoot, file), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    text.split("\n").forEach((line, index) => {
      if (STRIPE.test(line)) mentions.push(`${file}:${index + 1}: ${line.trim()}`)
    })
  }
  return mentions
}

test("nothing in Cloud V2's code, builds or configuration names Stripe", () => {
  const mentions = stripeMentions(root)
  assert.deepEqual(
    mentions,
    [],
    `Stripe belongs to the Store's billing module only; remove these:\n${mentions.join("\n")}`,
  )
})

test("a planted Stripe import, key or address is caught, and a doc is not scanned", () => {
  const planted = mkdtempSync(path.join(tmpdir(), "no-stripe-"))
  try {
    const git = (...args) => assert.equal(spawnSync("git", args, {cwd: planted, encoding: "utf8"}).status, 0)
    git("init", "-q")
    const write = (file, text) => {
      mkdirSync(path.dirname(path.join(planted, file)), {recursive: true})
      writeFileSync(path.join(planted, file), text)
    }
    // Key-shaped values are assembled here so this file holds no literal that a secret scanner reads as a key.
    const restrictedKey = ["rk", "test", "51Hb6".padEnd(24, "x")].join("_")
    const webhookSecret = ["whsec", "0123456789".padEnd(24, "y")].join("_")
    write(".gitignore", "node_modules/\n")
    write("cloud-v2/packages/core/src/billing.ts", 'import Stripe from "stripe"\n')
    write("cloud-v2/packages/core/package.json", '{"dependencies": {"stripe": "17.0.0"}}\n')
    write("cloud-v2/.env.example", `BILLING_KEY=${restrictedKey}\nWORKOS_KEY=sk_test_export\n`)
    write("cloud-v2/docker/Dockerfile", "RUN curl https://api.stripe.com/v1/charges\n")
    write("cloud-v2/porter.yaml", `secret: ${webhookSecret}\n`)
    // Not scanned: docs, dependencies git ignores, and anything outside Cloud V2.
    write("cloud-v2/docs/billing.md", "Billing uses Stripe.\n")
    write("cloud-v2/node_modules/stripe/index.js", "module.exports = require('stripe')\n")
    write("mobile/src/pay.ts", 'import Stripe from "stripe"\n')
    git("add", "cloud-v2/packages/core/src/billing.ts")

    assert.deepEqual(stripeMentions(planted).sort(), [
      `cloud-v2/.env.example:1: BILLING_KEY=${restrictedKey}`,
      "cloud-v2/docker/Dockerfile:1: RUN curl https://api.stripe.com/v1/charges",
      'cloud-v2/packages/core/package.json:1: {"dependencies": {"stripe": "17.0.0"}}',
      'cloud-v2/packages/core/src/billing.ts:1: import Stripe from "stripe"',
      `cloud-v2/porter.yaml:1: secret: ${webhookSecret}`,
    ])
  } finally {
    rmSync(planted, {recursive: true, force: true})
  }
})

test("the file rule covers code, build and configuration files under Cloud V2, and nothing else", () => {
  for (const file of [
    "cloud-v2/packages/core/src/a.ts",
    "cloud-v2/websites/portal/src/b.tsx",
    "cloud-v2/scripts/c.mjs",
    "cloud-v2/d.js",
    "cloud-v2/package.json",
    "cloud-v2/bun.lock",
    "cloud-v2/porter.debug.yaml",
    "cloud-v2/infra/e.yml",
    "cloud-v2/docker/Dockerfile",
    "cloud-v2/docker/Dockerfile.runtime",
    "cloud-v2/.env",
    "cloud-v2/packages/core/.env.example",
  ]) {
    assert.equal(isGuarded(file), true, file)
  }
  for (const file of ["cloud-v2/docs/licenses.md", "cloud-v2/README.md", "mobile/src/a.ts", "sdk/package.json"]) {
    assert.equal(isGuarded(file), false, file)
  }
})
