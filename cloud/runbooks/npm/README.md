# NPM Publishing

We publish a handful of `@mentra/*` packages to npmjs.com. Today
all publishes are manual. CI/CD is on the roadmap; this runbook
will be updated when it lands.

If you have not published an `@mentra/*` package before, read
[concepts.md](concepts.md) first. It covers scoped packages, dist-tags,
semver, monorepo workspace dependencies, and 2FA setup.

## Org access

Packages are published under the `@mentra` npm org. To publish
you need to be added to the org. Ask Isaiah or Israelov to add
your npm username.

Verify access:

```bash
npm whoami                       # confirms you are logged in
npm org ls @mentra               # lists members of the @mentra org
```

If `npm whoami` fails, run `npm login` and follow the prompts.
The `@mentra` org requires an npm account with 2FA enabled.

## What we publish

| Package | Path | Tag policy |
| --- | --- | --- |
| `@mentra/sdk` | `cloud/packages/sdk` | `alpha` only. Never `latest`. See [sdk.md](sdk.md). |
| `@mentra/react` | `cloud/packages/react-sdk` | `latest` for stable, `beta` for untested. See [react-sdk.md](react-sdk.md). |
| `@mentra/types` | `cloud/packages/types` | Coupled to `@mentra/sdk` (bundled). Bump together. |
| `@mentra/cli` | `cloud/packages/cli` | `latest` once tested. |
| `@mentra/display-utils` | `cloud/packages/display-utils` | `latest`. |

This list is not exhaustive. Treat per-package files as the
source of truth for the packages they cover; add a new file in
the same shape when you publish a new package for the first time.

## Tag policy at a glance

`latest` is what `npm install <pkg>` resolves to by default.
Anything else requires explicit opt-in (`npm install <pkg>@beta`).

- **`latest`**: stable, production-ready, fully tested. Default
  install target.
- **`alpha`**: experimental or in-progress. Used today by
  `@mentra/sdk` because we are migrating to the local SDK. We do
  not want existing miniapp developers to refactor against an API
  that will change again soon. See [sdk.md](sdk.md) for the full reasoning.
- **`beta`**: pre-release of something we plan to promote to
  `latest`. Use this for `@mentra/react` when changes have not
  been thoroughly tested on real apps yet, then promote to
  `latest` after testing.
- **Named experimental tags** (`hono`, `local-runtime`, etc.):
  short-lived. Created for a specific spike, deleted when the
  spike merges or is abandoned. Document what they are in the
  related issue folder.

## Generic publish flow

The mechanics are the same for every package. Per-package files
list the small differences (which path, which tag, what to bump).

```bash
# 1. Be on the branch you want to publish from. For untested
#    changes that is a feature branch with a beta or alpha tag.
#    For stable releases that is main or dev (depending on the
#    package's policy).
git checkout <branch>
git pull

# 2. cd into the package
cd cloud/packages/<package>

# 3. Build
bun run build

# 4. Bump the version. Use `npm version` so package.json and the
#    git tag stay in sync.
npm version <patch | minor | major | prerelease --preid=alpha>

# 5. Publish under the right tag.
#    Forgetting --tag defaults to latest. Always pass --tag.
npm publish --tag <alpha | beta | latest>

# 6. Verify
npm view @mentra/<package> versions --json | tail -10
npm view @mentra/<package> dist-tags

# 7. Push the version bump commit and tag
git push && git push --tags
```

## Common mistakes

- **Publishing without `--tag`.** Defaults to `latest`. If the
  package should be on `alpha` or `beta`, this is a regression
  for every consumer who runs `npm install`. See "Rollback" below.
- **Forgetting to build first.** Most packages have `prepare`
  scripts that build automatically, but not all. If you skip the
  build, the published `dist/` is stale.
- **Publishing from the wrong branch.** Anything published from a
  feature branch should never go to `latest`. Use a named tag.
- **Bumping the version without committing.** `npm version`
  creates a git commit and tag. Push them after publishing so the
  source of truth matches what is on npm.
- **Publishing while the working tree is dirty.** `npm version`
  refuses to run if the working tree has uncommitted changes.
  Either commit them or stash them first.

## Rollback

We do not `npm unpublish`. It breaks installs for anyone who has
already cached the bad version. Instead, point the dist-tag at
the previous good version:

```bash
# Find the last few versions
npm view @mentra/<package> versions --json | tail -10

# Repoint the tag at the last good version
npm dist-tag add @mentra/<package>@<good-version> <tag>
# e.g. npm dist-tag add @mentra/sdk@3.0.0-alpha.3 alpha

# Optionally deprecate the bad version with a warning message
npm deprecate @mentra/<package>@<bad-version> "Use <good-version>; <reason>."
```

After rolling back, fix the underlying cause and publish a new
version. Do not re-use the version number that was just
deprecated; npm enforces that anyway.

## Wrong-tag recovery

If you published to the wrong tag (e.g. published an alpha to
`latest`):

```bash
# Repoint latest back to the correct stable version
npm dist-tag add @mentra/<package>@<correct-stable-version> latest

# Move the just-published version to the tag it should have been
npm dist-tag add @mentra/<package>@<just-published-version> alpha
```

Order matters: fix `latest` first so consumers stop getting the
wrong package on their next `npm install`, then label the
just-published version correctly.

## Coordinated publishes

`@mentra/sdk` bundles `@mentra/types`. If your changes touched
both packages, publish `types` first, bump the SDK's dependency
range, rebuild the SDK, then publish the SDK. See
[sdk.md](sdk.md) for the exact sequence.
