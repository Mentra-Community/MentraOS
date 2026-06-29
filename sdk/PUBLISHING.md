# Publishing the Miniapp SDK to npm

The miniapp SDK ships as three npm packages:

| Package | Source | What it is |
| --- | --- | --- |
| [`@mentra/miniapp`](https://www.npmjs.com/package/@mentra/miniapp) | `mobile/modules/miniapp` | The SDK runtime (`MiniappSession`, modules, `/background`, `/ui`, `/react`). Ships compiled JS + types. |
| [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli) | `sdk/miniapp-cli` | The `mentra-miniapp` author CLI (`dev` / `release` / `pack` / `manifest`). |
| [`create-mentra-miniapp`](https://www.npmjs.com/package/create-mentra-miniapp) | `sdk/create-mentra-miniapp` | The `bunx create-mentra-miniapp` scaffolder + template. |

None of the three are on npm yet — this doc is how they get there and stay there.

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
  (`@mentra/miniapp` → `@mentra/miniapp-cli` → `create-mentra-miniapp`) so the
  scaffolder's template pins resolve once it lands.
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

## Publish order & the template pin

`create-mentra-miniapp` bundles `template/package.json`, which pins
`@mentra/miniapp` and `@mentra/miniapp-cli`. The scaffolder itself publishes
fine regardless (npm doesn't validate template contents), but a **scaffolded
project's `bun install` only works once those pinned versions exist on npm**.
The workflow's ordering handles this within a run; when you bump the SDK to a
version the template's caret range can't reach (e.g. a major), update
`sdk/create-mentra-miniapp/template/package.json` in the same change.

## ⚠️ Decision flag: the two CLIs are Bun-only

`@mentra/miniapp-cli` and `create-mentra-miniapp` ship **raw `.ts` bins with
`#!/usr/bin/env bun` shebangs** — there is no compile-to-JS step. They run under
`bunx`, **not** `npx`/Node:

```bash
bunx create-mentra-miniapp my-app    # works
npx create-mentra-miniapp my-app     # fails — no Bun
```

`@mentra/miniapp` (the runtime) is normal compiled JS and works under Node/any
bundler — only the two CLIs are Bun-only. This is consistent with the SDK being
Bun-only today, but it means we should **document `bunx` everywhere** and decide
whether to add a Node-compatible build (`bun build --compile` or tsc + a `node`
shebang) before a wide launch. Until then, the published docs must say `bunx`.

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

# 3. create-mentra-miniapp  (LAST — after the two above are live)
cd ../create-mentra-miniapp
npm publish --tag <latest|beta|dev> --access public
```

You need `npm login` (or `NPM_TOKEN` in `~/.npmrc`) with `@mentra` publish
rights, and `bun` on PATH (the CLI's `prepare` script runs under Bun).
