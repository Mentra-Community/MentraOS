# Publish `@mentra/react`

Path: `cloud/packages/react-sdk`
Current version line: `2.x.x`
Tag policy: `latest` for stable, `beta` for changes that have not
been thoroughly tested on real apps.

## When to use which tag

- **`latest`**: the change has been built, type-checked, and
  smoke-tested in a real consumer app (Mentra-AI, the dev
  console, or a similar app). External developers default to
  this.
- **`beta`**: the change compiles and passes whatever local tests
  exist, but has not been exercised in a real app. Publish under
  `beta`, install in an internal app, verify, then promote to
  `latest`.

Unlike `@mentra/sdk`, this package's API is stable across our
local-SDK transition (it handles webview auth via tokens, which
is independent of the miniapp programming model). Promoting to
`latest` is the normal path.

## Prereqs

1. You are a member of `@mentra` on npm. See [README.md](README.md) in this
   folder.
2. You are on the branch with your changes. Stable releases
   usually go from `main`; beta releases usually go from a
   feature branch off `dev`.
3. `cd cloud/packages/react-sdk && bun run build` is clean.
4. Working tree is clean.

## Publish a beta

For changes that need real-app testing first:

```bash
cd cloud/packages/react-sdk

bun run build

# Bump as a prerelease on the beta channel.
npm version prerelease --preid=beta
# e.g. 2.1.2 becomes 2.1.3-beta.0

npm publish --tag beta
```

Install in a consumer app to verify:

```bash
cd <consumer-app>
bun add @mentra/react@beta     # or npm install @mentra/react@beta
# run the app, exercise the auth flow, verify nothing regressed
```

## Promote a beta to latest

Once the beta has been validated in at least one real app:

```bash
cd cloud/packages/react-sdk

# Drop the prerelease suffix. If the current is 2.1.3-beta.2,
# this bumps to 2.1.3.
npm version patch
# Use minor or major if the changes warrant it.

npm publish --tag latest
```

The `latest` tag is the default, but we still pass `--tag latest`
explicitly to make intent obvious.

## Publish a stable directly

For a small, well-tested change you are publishing straight from
`main`:

```bash
cd cloud/packages/react-sdk

bun run build

# Choose the bump that fits the change
npm version <patch | minor | major>

npm publish --tag latest
```

## Verify

```bash
npm view @mentra/react versions --json | tail -5
npm view @mentra/react dist-tags
# Expect latest to point at the new version (or the old one if
# this was a beta-only publish).
```

Smoke check from tmp:

```bash
mkdir /tmp/react-smoke && cd /tmp/react-smoke
npm init -y
npm install react react-dom @mentra/react
node -e "console.log(Object.keys(require('@mentra/react')))"
```

## After publishing

- Push the version commit and tag: `git push && git push --tags`.
- Bump consumer apps that pin a specific version on a separate
  PR. Apps using `^` ranges pick it up automatically on next
  install.

## Rollback

If a published `latest` is broken:

```bash
# Find the last known good version
npm view @mentra/react versions --json | tail -10

# Repoint latest at it
npm dist-tag add @mentra/react@<last-good-version> latest

# Deprecate the bad version
npm deprecate @mentra/react@<bad-version> "Use <last-good-version>; <reason>."
```

Then publish a fix as a new patch version. Do not republish the
deprecated version.

## When changes affect both `@mentra/react` and `@mentra/sdk`

`@mentra/react` does not depend on `@mentra/sdk` directly, but
some webview flows interact with both. If your change spans both
packages, publish each one independently following its own
runbook. Verify the combination in a consumer app before
promoting either one to its stable tag.
