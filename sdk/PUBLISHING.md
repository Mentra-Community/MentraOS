# Publishing the Miniapp SDK to npm

The miniapp SDK + Cloud V2 developer packages ship as five npm packages, all from
one workflow ([`miniapp-sdk-release.yml`](../.github/workflows/miniapp-sdk-release.yml)):

| Package | Source | What it is |
| --- | --- | --- |
| [`@mentra/miniapp`](https://www.npmjs.com/package/@mentra/miniapp) | `mobile/modules/miniapp` | The SDK runtime (`MiniappSession`, modules, `/background`, `/ui`, `/react`). Ships compiled JS + types. |
| [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli) | `sdk/miniapp-cli` | The `mentra-miniapp` author CLI (`dev` / `release` / `pack` / `manifest`). Bun-only. |
| [`create-mentra-miniapp`](https://www.npmjs.com/package/create-mentra-miniapp) | `sdk/create-mentra-miniapp` | The `bunx create-mentra-miniapp` scaffolder + template. Bun-only. |
| [`@mentra/auth`](https://www.npmjs.com/package/@mentra/auth) | `cloud-v2/packages/auth` | Cloud V2 auth helper for miniapp backends — verify Local Runtime JWKS tokens. Compiled JS + types (Node-compatible). |
| [`@mentra/cli`](https://www.npmjs.com/package/@mentra/cli) | `cloud-v2/packages/cli` | The `mentra` developer CLI — build + **publish** to the Cloud V2 console. Wraps `@mentra/miniapp-cli` and adds login/org/miniapps/releases/publish. Bun-only. This is the CLI most developers want. |

`@mentra/miniapp`, `@mentra/miniapp-cli`, `create-mentra-miniapp`, and `@mentra/auth`
are not on npm yet. `@mentra/cli` has a legacy `1.0.3` on the `latest` tag (the
v1 CLI); the Cloud V2 rewrite here is `2.0.0-alpha.*` and publishes to the `alpha`
tag, so it does **not** disturb `latest` — see the collision note below. This doc
is how they get to npm and stay there.

## Channels (branch → dist-tag)

Same model as the websites and the mobile app: each long-lived branch maps to an
npm dist-tag, and the tag is derived from the package **version's prerelease
label** (so the tag can never drift from the version — this matches how
`@mentra/sdk` already ships).

| Branch | Version shape | dist-tag | `npm install` resolves it when… |
| --- | --- | --- | --- |
| `main` | `1.2.3` | `latest` | `npm i @mentra/miniapp` (default) |
| `staging` | `1.2.3-beta.4` | `beta` | `npm i @mentra/miniapp@beta` |
| `dev` | `1.2.3-dev.4` | `dev` | `npm i @mentra/miniapp@dev` |

`-alpha.N` → `alpha` and any other `-<label>.N` → `<label>` also work, so you can
cut a one-off channel without touching CI.

## One-time setup (required before the first publish)

1. **npm org access.** The `@mentra` org already owns `@mentra/sdk`,
   `@mentra/types`, and `@mentra/bluetooth-sdk`, so the scope exists. Make sure
   the publishing account is a member with **publish** rights.
2. **Create an npm automation token.** npm → _Access Tokens_ → _Generate New
   Token_ → **Automation** (bypasses 2FA, which CI can't satisfy). Scope it to the
   `@mentra` org.
3. **Add it as a GitHub repo secret named `NPM_TOKEN`.** The
   `Release Miniapp SDK` workflow wires it in as `NODE_AUTH_TOKEN`.
4. **First publish of each scoped package is public.** Each package now carries
   `"publishConfig": { "access": "public" }`, and the workflow also passes
   `--access public`, so no manual flag is needed.

## How CI publishing works

Workflow: [`.github/workflows/miniapp-sdk-release.yml`](../.github/workflows/miniapp-sdk-release.yml).

- **Trigger:** push to `main` / `staging` / `dev` that touches any of the three
  package dirs (or the workflow/script itself). Also `workflow_dispatch`.
- **Gate:** a package publishes **only when the `version` field in its
  `package.json` changes** on that push (detected by
  [`.github/scripts/miniapp-sdk-release-info.mjs`](../.github/scripts/miniapp-sdk-release-info.mjs),
  which diffs the version against the push's before-SHA). Bumping one package
  does not republish the others.
- **Idempotent:** before publishing it runs `npm view <pkg>@<version>` and skips
  if that exact version already exists. Re-running a workflow is safe.
- **Ordered:** packages publish sequentially in dependency order
  (`@mentra/miniapp` → `@mentra/miniapp-cli` → `create-mentra-miniapp` →
  `@mentra/auth` → `@mentra/cli`) so downstream pins resolve once their base lands
  (the scaffolder's template pins, and `@mentra/cli`'s dep on `@mentra/miniapp-cli`).
- **`file:` rewrite:** before packing, [`rewrite-file-deps.mjs`](../.github/scripts/rewrite-file-deps.mjs)
  rewrites any workspace `file:` dependency to the referenced package's **exact**
  version. Today only `@mentra/cli` has one (`@mentra/miniapp-cli`), which is a
  `file:` link in-repo but must be a real version in the published tarball. The
  rewrite touches only the checkout that gets packed — it is never committed, so
  local dev keeps the `file:` link. An exact pin is dist-tag-agnostic; the
  tradeoff is that a base bump needs the wrapper republished to pick it up.
- **Template stamp:** also before packing, [`stamp-template-versions.mjs`](../.github/scripts/stamp-template-versions.mjs)
  rewrites `create-mentra-miniapp`'s `template/package.json` `@mentra/*` pins to
  the **exact versions being published this run** (prerelease → exact, stable →
  caret). This is why a project scaffolded from *any* channel installs — see
  below. No-op for packages without a `template/`; never committed.
- **Guardrail:** a plain (non-prerelease) version resolves to the `latest`
  dist-tag — the workflow refuses to publish that from any branch other than
  `main`, so a `-dev` build can never accidentally become what `npm install`
  hands every developer.
- **Dry run:** `workflow_dispatch` defaults to `dry_run: true`, which builds and
  `npm pack --dry-run`s without publishing. Use it to validate the tarball
  contents before a real release.

### Cutting a release

1. On the channel branch, bump `version` in the package(s) you're shipping:
   - dev: `0.4.0-dev.1`, `0.4.0-dev.2`, …
   - staging: `0.4.0-beta.1`, …
   - production: `0.4.0`
2. Merge to the branch. CI publishes the changed packages at the matching tag.
3. Promotion is a version bump, not a re-tag: land `0.4.0-beta.1` on `staging`,
   then land `0.4.0` on `main`.

## Publish order & the template stamp

`create-mentra-miniapp` bundles `template/package.json`, which pins
`@mentra/miniapp` and `@mentra/miniapp-cli`. In the repo these stay as friendly
caret ranges (`^0.3.0`) for readability — but a caret **excludes prereleases**,
so a project scaffolded from a dev/beta build (where only `0.3.0-dev.0` exists on
npm, no stable `0.3.0`) could never `bun install`.

The publish job fixes this automatically: `stamp-template-versions.mjs` rewrites
those pins to the **exact versions being published in the same run** before
packing. So `create-mentra-miniapp@dev` ships a template pinned to
`@mentra/miniapp@0.3.0-dev.0` (exact — installs regardless of dist-tag), and the
`latest` scaffolder ships `^<stable>`. Each channel's scaffolder is
self-consistent, and you never hand-edit the template for a release. The matrix
still publishes in dependency order so the pinned versions exist by the time a
scaffolded project installs them.

This is the publish-time-stamp pattern (à la `create-vite`): deterministic,
offline-safe, and no runtime registry call during scaffolding.

## The CLIs are Bun-only (settled)

`@mentra/miniapp-cli`, `create-mentra-miniapp`, and `@mentra/cli` ship **raw
`.ts` bins with `#!/usr/bin/env bun` shebangs** — there is no compile-to-JS step.
They run under `bun` / `bunx`, **not** `npx`/Node:

```bash
bunx create-mentra-miniapp my-app    # works
npx create-mentra-miniapp my-app     # fails — no Bun

bun add -g @mentra/cli@alpha         # works
npm i -g @mentra/cli                  # installs, but `mentra` needs Bun to run
```

This is a deliberate decision — the SDK/CLI stack is Bun-first, so the CLIs stay
Bun-only rather than adding a Node-compatible build. `@mentra/cli` declares
`"engines": { "bun": ">=1.0.0" }` to make the requirement explicit. Only the two
runtime/library packages are Node-compatible: `@mentra/miniapp` (compiled JS +
types) and `@mentra/auth` (compiled `dist/`). **Published docs must say `bunx` /
`bun` for anything that invokes a CLI.**

## ⚠️ `@mentra/cli` version collision (1.x latest vs 2.x alpha)

`@mentra/cli@1.0.3` already sits on the `latest` tag on npm — that's the v1 CLI
(same maintainers, so we own the name). The Cloud V2 rewrite in
`cloud-v2/packages/cli` is `2.0.0-alpha.*` and, because of its prerelease label,
publishes to the **`alpha`** tag. So:

- `npm i @mentra/cli` (or `bun add`) still resolves the old `1.0.3`.
- `bun add @mentra/cli@alpha` gets the Cloud V2 CLI.

This is intentional during the alpha. **Do not** ship a bare `2.0.0` (no
prerelease) until the team decides to promote v2 to `latest` — that would replace
what every plain install resolves. When ready, that promotion is just a version
bump to `2.0.0` merged to `main` (the workflow's `latest`-only-on-`main` guardrail
still applies).

## Manual publishing (fallback)

CI is the supported path. If you must publish by hand:

```bash
# 1. @mentra/miniapp  (build emits dist/)
cd mobile && bun install
cd modules/miniapp && bun run build
npm publish --tag <latest|beta|dev> --access public

# 2. @mentra/miniapp-cli
cd ../../../sdk && bun install
cd miniapp-cli
npm publish --tag <latest|beta|dev> --access public

# 3. create-mentra-miniapp  (after the two above are live)
cd ../create-mentra-miniapp
npm publish --tag <latest|beta|dev> --access public

# 4. @mentra/auth  (independent; compiled dist/)
cd ../../cloud-v2 && bun install
cd packages/auth && bun run build
npm publish --tag <alpha|dev|beta|latest> --access public

# 5. @mentra/cli  (LAST — after @mentra/miniapp-cli is live)
#    Rewrite its file: dep to the published miniapp-cli version first.
cd ../cli
node ../../../.github/scripts/rewrite-file-deps.mjs .
npm publish --tag alpha --access public   # keep on alpha; do NOT publish a bare 2.0.0
git checkout -- package.json               # undo the rewrite locally
```

You need `npm login` (or `NPM_TOKEN` in `~/.npmrc`) with `@mentra` publish
rights, and `bun` on PATH (the CLIs' bins run under Bun).
