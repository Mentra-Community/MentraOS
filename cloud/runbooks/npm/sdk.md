# Publish `@mentra/sdk`

Path: `cloud/packages/sdk`
Current version line: `3.0.0-alpha.<N>`
Tag: `alpha` only.

## Why never `latest`

`@mentra/sdk` v3 was designed before the local SDK was on the
roadmap. It contains breaking changes from v2. We are moving the
miniapp programming model to the local SDK
(`@mentra/miniapp` in `sdk/miniapp`) within the next quarter or
so, and the local SDK will change the public API again.

Promoting v3 to `latest` would force every miniapp developer to
refactor against an API that we plan to break a second time
within weeks. We avoid that by keeping v3 on `alpha` until either
the local SDK ships and supersedes it, or we decide to promote a
v3.x to `latest` after the dust settles.

Internal apps (live-captions, Mentra-AI, etc.) install with
`npm install @mentra/sdk@alpha`. External developers who want to
try v3 do the same.

## Prereqs

1. You are a member of `@mentra` on npm. See [README.md](README.md) in this
   folder.
2. You are on the branch that has the changes you want to
   publish. Usually a feature branch off `dev`.
3. The package builds clean: `cd cloud/packages/sdk && bun run build`.
4. Working tree is clean. `npm version` refuses to run if it is
   not.

## Publish

```bash
cd cloud/packages/sdk

# Build (also runs automatically via the `prepare` script, but
# running it manually surfaces errors before the version bump).
bun run build

# Bump the prerelease number. Today's pattern is 3.0.0-alpha.<N>;
# this increments N.
npm version prerelease --preid=alpha
# package.json is now e.g. 3.0.0-alpha.4 and a git commit + tag
# (v3.0.0-alpha.4) was created.

# Publish under the alpha tag.
# DO NOT omit --tag; the default is latest.
npm publish --tag alpha
```

## Verify

```bash
npm view @mentra/sdk versions --json | tail -5
npm view @mentra/sdk dist-tags
# Expect:
#   alpha:  3.0.0-alpha.<N>     <- new
#   latest: <some old v2 version, untouched>
```

A clean install from a tmp dir is a good sanity check the first
time you publish:

```bash
mkdir /tmp/sdk-smoke && cd /tmp/sdk-smoke
npm init -y
npm install @mentra/sdk@alpha
node -e "console.log(Object.keys(require('@mentra/sdk')).slice(0,5))"
```

## After publishing

- Push the version commit and tag: `git push && git push --tags`.
- If internal apps depend on this version, bump them to it on a
  separate PR and verify they boot.
- If the publish introduces a breaking change, post a heads-up
  in the team channel with the version number and what changed.

## Bundled types

`@mentra/sdk` ships with `@mentra/types` bundled into the package.
If your changes touched `cloud/packages/types`, publish that first,
then update the SDK to depend on the new types version, then
publish the SDK.

```bash
# 1. Publish @mentra/types
cd cloud/packages/types
bun run build
npm version prerelease --preid=beta
npm publish --tag beta
# note the version printed, e.g. 1.0.0-beta.3

# 2. Bump the SDK's @mentra/types dependency range to match
#    Edit cloud/packages/sdk/package.json:
#      "dependencies": {
#        "@mentra/types": "^1.0.0-beta.3"
#      }

# 3. Rebuild the SDK so the bundle picks up the new types
cd ../sdk
bun install      # refreshes the lock file
bun run build

# 4. Bump and publish the SDK as usual
npm version prerelease --preid=alpha
npm publish --tag alpha
```

The `--tag beta` for types is intentional. `@mentra/types` has
its own version line and tag policy independent of the SDK.

## Rollback

If a published `alpha` is broken, point the `alpha` tag back at
the previous version:

```bash
npm view @mentra/sdk versions --json | tail -5
npm dist-tag add @mentra/sdk@<last-good-version> alpha
npm deprecate @mentra/sdk@<bad-version> "Broken; use <last-good-version>."
```

Then fix the underlying issue and publish a new version. See the
folder [README.md](README.md) for the general pattern.

## Hotfix

Same flow, smaller bump:

```bash
cd cloud/packages/sdk
bun run build
npm version prerelease --preid=alpha
npm publish --tag alpha
```

`npm version prerelease` always increments the trailing number.
For hotfixes on alpha, stay on the same `3.0.0-alpha` line.
