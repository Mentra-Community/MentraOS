// Stripe stays out of MentraOS. Billing lives in the Store's billing module, the
// only code that talks to Stripe; Core only stores the licenses billing writes.
// No Stripe SDK, key, address or name belongs anywhere in Cloud V2: code, builds,
// configuration, scripts, installers or infrastructure templates. Docs (markdown)
// are reviewed by people and are not scanned. This guard keeps it that way.
import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const GUARDED_DIR = "cloud-v2"

/** Docs, the one kind of text file under Cloud V2 this guard leaves to reviewers. */
const DOC_FILE = /\.mdx?$/i

/**
 * What `git grep` looks for, case-insensitively: anything that might be Stripe. Each hit is then held to
 * {@link namesStripe}, which is precise; this only has to find every candidate line.
 */
const CANDIDATE = "stripe|whsec_|(sk|rk|pk)_(live|test)_"

/**
 * Stripe by name, as its own word: `stripe`, `Stripe`, `@stripe/stripe-js`, `api.stripe.com` and
 * `STRIPE_SECRET_KEY` (an underscore or digit separates a word here), but not `striped` or
 * `pinstripe`.
 */
const STRIPE_WORD = /(?<![a-z])stripe(?![a-z])/i
/** Stripe as a part of a camel-case name: `createStripeClient`, `StripeClient`, `stripeKey`. */
const STRIPE_CAMEL = /Stripe(?![a-z])|stripe(?=[A-Z])/
/**
 * A key of Stripe's shape: a secret, restricted or publishable key (`sk_`, `rk_`, `pk_`, then `live_` or
 * `test_` and at least 20 characters) or a webhook signing secret (`whsec_`). WorkOS's keys share the
 * `sk_test_` prefix, so a short placeholder such as the legacy claim tests' `sk_test_export` is no key.
 */
const STRIPE_KEY = /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{20,}|\bwhsec_[A-Za-z0-9]{20,}/

/** Whether a line names Stripe or holds one of its keys. */
export function namesStripe(line) {
  return STRIPE_WORD.test(line) || STRIPE_CAMEL.test(line) || STRIPE_KEY.test(line)
}

/** Whether a repository path is one this guard scans: anything under Cloud V2 but its docs (binaries are git's to skip). */
export function isGuarded(file) {
  return file.startsWith(`${GUARDED_DIR}/`) && !DOC_FILE.test(file)
}

/**
 * Every `file:line: text` under `repoRoot`'s Cloud V2 that names Stripe: in every text file git tracks, and
 * every untracked one it does not ignore (so a file planted locally is caught before it is committed).
 * Binary files (`-I`) and ignored build output and dependencies are not read.
 */
export function stripeMentions(repoRoot) {
  const result = spawnSync("git", ["grep", "-I", "-n", "-i", "--untracked", "-E", CANDIDATE, "--", GUARDED_DIR], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  // 1 means no match at all.
  if (result.status === 1) return []
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((hit) => {
      const [, file, line, text] = /^([^:]+):(\d+):(.*)$/.exec(hit) ?? []
      if (!file || !isGuarded(file) || !namesStripe(text)) return []
      return [`${file}:${line}: ${text.trim()}`]
    })
}

test("nothing in Cloud V2 but its docs names Stripe", () => {
  const mentions = stripeMentions(root)
  assert.deepEqual(
    mentions,
    [],
    `Stripe belongs to the Store's billing module only; remove these:\n${mentions.join("\n")}`,
  )
})

test("a planted Stripe import, key, address or name is caught in any kind of file; docs and words like it are not", () => {
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
    const liveKey = ["sk", "live", "51Hb6".padEnd(24, "z")].join("_")
    const webhookSecret = ["whsec", "0123456789".padEnd(24, "y")].join("_")
    write(".gitignore", "node_modules/\n")
    write("cloud-v2/packages/core/src/billing.ts", 'import Stripe from "stripe"\n')
    write("cloud-v2/packages/core/src/client.ts", "const client = createStripeClient()\n")
    write("cloud-v2/packages/core/package.json", '{"dependencies": {"stripe": "17.0.0"}}\n')
    write("cloud-v2/.env.example", `BILLING_KEY=${restrictedKey}\nWORKOS_KEY=sk_test_export\nSTRIPE_API_VERSION=2025\n`)
    write("cloud-v2/docker/Dockerfile", "RUN npm install @stripe/stripe-js\n")
    write("cloud-v2/deploy/charge.sh", "curl https://api.stripe.com/v1/charges\n")
    write("cloud-v2/infra/main.bicep", `param billingKey string = '${liveKey}'\n`)
    write("cloud-v2/porter.yaml", `secret: ${webhookSecret}\n`)
    // Not caught: docs, words that only contain the name, binaries, ignored dependencies, and anything outside Cloud V2.
    write("cloud-v2/docs/billing.md", "Billing uses Stripe.\n")
    write("cloud-v2/docs/billing.mdx", "Billing uses Stripe.\n")
    write("cloud-v2/websites/portal/src/table.css", ".rows-striped { border: pinstripe; }\n")
    write("cloud-v2/websites/portal/public/logo.png", "\u0000PNG stripe\u0000")
    write("cloud-v2/node_modules/stripe/index.js", "module.exports = require('stripe')\n")
    write("mobile/src/pay.ts", 'import Stripe from "stripe"\n')
    git("add", "cloud-v2/packages/core/src/billing.ts", "cloud-v2/websites/portal/src/table.css")

    assert.deepEqual(stripeMentions(planted).sort(), [
      `cloud-v2/.env.example:1: BILLING_KEY=${restrictedKey}`,
      "cloud-v2/.env.example:3: STRIPE_API_VERSION=2025",
      "cloud-v2/deploy/charge.sh:1: curl https://api.stripe.com/v1/charges",
      "cloud-v2/docker/Dockerfile:1: RUN npm install @stripe/stripe-js",
      `cloud-v2/infra/main.bicep:1: param billingKey string = '${liveKey}'`,
      'cloud-v2/packages/core/package.json:1: {"dependencies": {"stripe": "17.0.0"}}',
      'cloud-v2/packages/core/src/billing.ts:1: import Stripe from "stripe"',
      "cloud-v2/packages/core/src/client.ts:1: const client = createStripeClient()",
      `cloud-v2/porter.yaml:1: secret: ${webhookSecret}`,
    ])
  } finally {
    rmSync(planted, {recursive: true, force: true})
  }
})

test("the name rule finds Stripe as a word or a camel-case part, and not inside another word", () => {
  for (const line of [
    'import Stripe from "stripe"',
    "STRIPE_SECRET_KEY=",
    "https://js.stripe.com/v3",
    "new StripeClient()",
    "const stripeKey = ''",
    "stripe2",
  ]) {
    assert.equal(namesStripe(line), true, line)
  }
  for (const line of ["table-striped", "a pinstripe suit", "Striped rows", "stripes", "sk_test_export"]) {
    assert.equal(namesStripe(line), false, line)
  }
})

test("the file rule covers every file under Cloud V2 but its docs", () => {
  for (const file of [
    "cloud-v2/packages/core/src/a.ts",
    "cloud-v2/deploy/b.sh",
    "cloud-v2/deploy/azure/c.bicep",
    "cloud-v2/deploy/azure/installer/d.py",
    "cloud-v2/websites/portal/index.html",
    "cloud-v2/websites/portal/src/e.css",
    "cloud-v2/bun.lock",
    "cloud-v2/docker/Dockerfile",
    "cloud-v2/.env",
    "cloud-v2/websites/admin/public/_redirects",
  ]) {
    assert.equal(isGuarded(file), true, file)
  }
  for (const file of ["cloud-v2/docs/licenses.md", "cloud-v2/README.md", "cloud-v2/docs/a.mdx", "mobile/src/a.ts"]) {
    assert.equal(isGuarded(file), false, file)
  }
})
