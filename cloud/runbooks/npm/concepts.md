# NPM: Concepts and Prerequisites

Read this first if you are new to npm publishing. Operational
procedures live in [README.md](README.md), [sdk.md](sdk.md), and [react-sdk.md](react-sdk.md).

The summary: we publish a handful of `@mentra/*` packages to
the public npm registry. They install via `npm install`
(or `bun add`). Today every publish is manual; CI/CD is on the
roadmap.

If terms below are unfamiliar, the rest of this doc explains
each one.

## The npm registry

npmjs.com is the public registry that hosts JavaScript
packages. When someone runs `npm install foo`, npm looks up
`foo` in the registry, downloads the tarball, extracts it
into `node_modules/`. Same for Bun, Yarn, pnpm.

We publish to the public registry. There is one of these by
default; alternative registries (private, GitHub Packages,
self-hosted) exist but we do not use them for `@mentra/*`.

## Packages and versions

A package is a named bundle of code with a version. Each
publish creates a new immutable version. Once `1.2.3` is
published, you cannot republish `1.2.3` with different
contents (you can only deprecate it and publish `1.2.4`).

Multiple versions of the same package can exist on the
registry simultaneously. `npm install foo` resolves to one of
them based on the version range in `package.json` and the
package's dist-tags (see below).

## Scoped packages (`@scope/name`)

A "scope" is a namespace prefix. `@mentra/sdk` is in the
`@mentra` scope. Scopes are owned by an npm user or an npm
organization. Only members of the `@mentra` org can publish
under `@mentra/*`.

Scoped packages can be public or private. Ours are public
(visible to anyone, free to install). The `publishConfig` in
`package.json` controls this:

```json
{
  "name": "@mentra/react",
  "publishConfig": { "access": "public" }
}
```

## Org membership

The `@mentra` org has a list of members on npmjs.com. Only
members can publish. Adding someone is done from the org
admin page; we ask Isaiah or Israelov to add a new member.

Verify your membership:

```bash
npm whoami            # confirms logged in
npm org ls @mentra    # lists members
```

If `npm whoami` errors, run `npm login` first. The org
requires accounts with 2FA enabled (npm enforces this for
publishing).

## Semver

`@mentra/*` packages follow [Semantic Versioning](https://semver.org/)
(semver):

```
MAJOR.MINOR.PATCH[-prerelease]
```

- **Major**: breaking change. `2.x.x -> 3.0.0`. Existing
  consumers will break unless they migrate.
- **Minor**: new feature, backward compatible. `3.0.0 ->
  3.1.0`. Existing code keeps working.
- **Patch**: bug fix only. `3.1.0 -> 3.1.1`. No new features,
  no behavior change beyond the fix.
- **Prerelease suffix**: a version that is not yet stable.
  `3.0.0-alpha.4`, `3.0.0-beta.2`, `3.0.0-rc.1`.

The version range a consumer specifies controls which versions
they accept on `npm install`:

- `"^1.2.3"`: any `1.x.x` at or above `1.2.3`. Most common.
- `"~1.2.3"`: any `1.2.x` at or above `1.2.3`. Stricter.
- `"1.2.3"`: only that exact version.

Prereleases are excluded from `^` and `~` ranges by default.
You only get them with explicit pinning (`"3.0.0-alpha.4"`)
or by installing via a dist-tag (see below).

## Dist-tags (npm distribution channels)

A dist-tag is a label that points at a specific version. The
default tag is `latest`. When you run `npm install foo` with
no version specified, npm resolves `foo@latest`.

Multiple tags can exist simultaneously:

```bash
npm view @mentra/sdk dist-tags
# {
#   latest: "2.5.3",
#   alpha:  "3.0.0-alpha.4",
#   beta:   "3.0.0-beta.1"
# }
```

Consumers opt into non-default tags explicitly:

```bash
npm install @mentra/sdk          # gets latest (2.5.3)
npm install @mentra/sdk@alpha    # gets alpha   (3.0.0-alpha.4)
npm install @mentra/sdk@beta     # gets beta    (3.0.0-beta.1)
```

We use this to keep unstable code accessible without breaking
consumers who default to `latest`. Today's policy:

- `latest`: stable, production-ready. The default. Must work
  for everyone.
- `alpha`: experimental. Used by `@mentra/sdk` v3 because we
  are migrating to the local SDK; we do not want to force
  developers to refactor against an API that will change again
  soon.
- `beta`: pre-release of something we plan to promote. Used
  for `@mentra/react` when changes have not been thoroughly
  tested.

Dist-tags are mutable. You can repoint `latest` at an older
version via `npm dist-tag add`. This is how you roll back a
bad publish.

## `npm version` vs editing package.json

You can bump a version by editing `package.json` directly, but
`npm version` does it cleanly:

```bash
npm version patch              # 1.2.3 -> 1.2.4
npm version minor              # 1.2.3 -> 1.3.0
npm version major              # 1.2.3 -> 2.0.0
npm version prerelease --preid=alpha   # 3.0.0-alpha.3 -> 3.0.0-alpha.4
```

`npm version`:

1. Bumps the version in `package.json`.
2. Stages and commits the change.
3. Creates a git tag (e.g. `v1.2.4`).
4. Refuses to run if the working tree is dirty (which is the
   right behavior).

After `npm version`, push the commit and the tag:

```bash
git push && git push --tags
```

## `npm publish`

The actual publish step. Reads `package.json`, packs `files:`
into a tarball, uploads to the registry under the package name
and version.

```bash
npm publish --tag latest      # default tag is latest
npm publish --tag alpha       # publish under the alpha tag
```

Always pass `--tag` explicitly. Forgetting it defaults to
`latest`, which is how alpha or beta versions accidentally end
up promoted. See the rollback procedure in [README.md](README.md).

## Workspace dependencies (monorepo)

Our repo is a monorepo with multiple `cloud/packages/*`. Some
of those packages depend on each other. Bun and npm both
support a `"workspace:*"` protocol that points at the local
copy:

```json
{
  "name": "@mentra/cloud",
  "dependencies": {
    "@mentra/types": "workspace:*"
  }
}
```

`workspace:*` works during local dev (Bun resolves to the
sibling package). It does NOT work in published packages: the
registry has no concept of a workspace.

When publishing, packages either:

1. Use real version ranges (`"@mentra/types": "^1.0.0-beta.3"`)
   so consumers fetch types from the registry as a normal
   dependency.
2. Bundle the dependency into their own tarball using
   `bundledDependencies`. The consumer gets a vendored copy
   inside `node_modules/@mentra/sdk/node_modules/@mentra/types`.

`@mentra/sdk` uses option 2 for `@mentra/types`: the published
SDK ships its own copy. This avoids the consumer needing to
install `@mentra/types` separately.

Coordinating publishes: if `@mentra/types` changes, publish
`types` first, bump the SDK's dependency range, rebuild the
SDK, then publish the SDK. See [sdk.md](sdk.md).

## `prepare` script

A package can have a `"prepare"` script that runs before
`npm publish`:

```json
{
  "scripts": {
    "prepare": "bun run build"
  }
}
```

Most of our packages use this to ensure `dist/` is built from
the latest source before the tarball gets packed. You can
still run `bun run build` manually before publish (and the
runbook recommends it, to surface errors before the version
bump), but `prepare` is the safety net.

## Deprecating a version

Once a version is published you cannot un-publish it without
breaking installs for anyone who already cached it. Instead,
deprecate it:

```bash
npm deprecate @mentra/sdk@3.0.0-alpha.3 \
  "Has a critical bug; use 3.0.0-alpha.4."
```

Future installs print a warning but still succeed. This is the
correct way to flag a bad version.

## Two-factor authentication

The `@mentra` org requires 2FA on accounts that publish. When
you `npm publish`, npm prompts for an OTP. Have your
authenticator app handy.

If you set up automation tokens later (for CI publishing),
those bypass 2FA. Until then, every publish requires the OTP.
