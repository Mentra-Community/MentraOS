# First-party miniapp Store publication

`.github/workflows/miniapp-store-publish.yml` uses this action to publish the
first-party miniapps kept in `miniapps/` to the Mentra Miniapp Stores. Each
branch publishes only to its own Store:

| Branch    | Store                                           | GitHub environment (deployable from that branch only) |
| --------- | ----------------------------------------------- | ----------------------------------------------------- |
| `dev`     | `https://api.apps.dev.mentraglass.com`          | `miniapp-store-dev`                                   |
| `staging` | `https://api.apps.staging.mentraglass.com`      | `miniapp-store-staging`                               |
| `main`    | `https://api.apps.mentraglass.com` (production) | `miniapp-store-production`                            |

Staging is off until the repository variable `MENTRA_STAGING_STORE_PUBLISHING`
is `true`. The setup script below sets it once staging's keys exist.

1. Each miniapp's production pack runs (`NODE_ENV=production bun run pack`).
2. `operation: prepare` checks the bundle and rewrites it with canonical ZIP
   metadata, so a retry uploads identical bytes. Signed bundles are rejected.
3. The bundle is saved as a workflow artifact.
4. On a push to `dev`, `staging` or `main`, `operation: publish` downloads that
   same artifact and publishes it to that branch's Store with the miniapp's
   app-restricted publishing key for that Store.

The workflow first checks the Store's public catalog and publishes nothing,
with no key needed, when the Store's current release already has this version.
The action then checks again with the key: it skips a version the Store has
already published, before touching the listing, and skips a run whose commit
is no longer the tip of its branch. Bump `miniapp.json` to publish a new
release or listing change.

Each miniapp keeps `store/listing.json` (the `mentra listing update --file`
fields) and `store/artwork.json` (an array of
`{"role": "store_icon" | "store_cover" | "gallery_screenshot", "path": "..."}`).
Paths are relative to the miniapp directory.

## Keys

Each miniapp has its own key for each Store, issued by that Store's
administrators and restricted to that package. Revoking one key does not affect
the others. Never use a developer login, an organization-wide key, or a Core
credential here.

| Store      | Keys, in that Store's environment              |
| ---------- | ---------------------------------------------- |
| Dev        | `MENTRA_DEV_STORE_PUBLISH_TOKEN_<MINIAPP>`     |
| Staging    | `MENTRA_STAGING_STORE_PUBLISH_TOKEN_<MINIAPP>` |
| Production | `MENTRA_STORE_PUBLISH_TOKEN_<MINIAPP>`         |

`<MINIAPP>` is `CAPTIONS`, `TRANSLATION`, `TELEPROMPTER`, `MAPS` (navigation) or
`RECORDER`. A Store's keys live only in its environment, so no other branch can
read them, and a missing key fails the run instead of falling back to another
Store's.

## First-party miniapps in their own repositories

Call, Notes, AI, Livestreamer and Merge publish the same way from their own
repositories, with the Store's shared publishing action
(`Mentra-Community/miniapp-store/.github/actions/publish-miniapp`, pinned to a
commit) and their own `.github/workflows/miniapp-store-publish.yml`. They have
`dev` and `main` but no `staging`, so `dev` publishes to the dev Store and
`main` publishes to the staging and production Stores, after the production
backend deploys. Their keys have no `_<MINIAPP>` suffix:
`MENTRA_DEV_STORE_PUBLISH_TOKEN` in `miniapp-store-dev` (deployable from `dev`),
and `MENTRA_STAGING_STORE_PUBLISH_TOKEN` and `MENTRA_STORE_PUBLISH_TOKEN` in
`miniapp-store-staging` and `miniapp-store-production` (deployable from `main`).
A repository with only `main` would publish to all three Stores from `main`.

`REPOSITORIES` in `.github/scripts/setup-store-publishing.mjs` lists every
repository, its branches and its package. Adding a repository there makes it
part of every setup run.

## Setting up a Store

`.github/scripts/setup-store-publishing.mjs` sets up a Store for every repository
in `REPOSITORIES`, or the ones named with `--repo`. As that Store's staff account
it creates or finds the "Mentra" workspace, claims `com.mentra`, creates the
miniapps the Store lacks, creates each repository's environment for the Store
(deployable only from the branch that publishes to it), and stores a key for
each miniapp whose key is missing. It is safe to run again and never prints a
key:

```bash
doppler run --project cloud-v2 --config dev_aws -- node .github/scripts/setup-store-publishing.mjs dev
doppler run --project cloud-v2 --config dev_aws -- node .github/scripts/setup-store-publishing.mjs dev --repo Mentra-Call
```

- `--dry-run` reports what it would do.
- `--reissue` issues new keys and revokes the ones they replace.
- `--publish` then runs each repository's publish workflow on the branch that
  publishes to that Store, so the current versions go up without waiting for a
  push.
- `--environments-only` only creates the environments and their branch rules,
  without signing in, and reports keys that are missing or still repository
  secrets.

### Staging, after `dev` is merged to `staging`

That merge gives staging Core its sign-in server and workspace API, and gives
MentraOS's `staging` branch this workflow. Then one command sets up every
repository, turns staging publishing on, and publishes the current versions:

```bash
doppler run --project cloud-v2 --config staging -- node .github/scripts/setup-store-publishing.mjs staging --publish
```

It runs MentraOS's workflow on `staging`, and every other repository's on
`main`, where publishing to production skips the version production already
has. Nothing is deployed.

### Production

Production publishing happens only from `main`. The production Store still
signs in with WorkOS, so the script cannot sign in there yet. Until it can,
Store staff issue each production key with their own sign-in and store it in
`miniapp-store-production`; MentraOS has none yet, so a new version of its
miniapps stops at the "Require the publishing key" step on `main`. Once the
production Store signs in through Core, the same command works for it:

```bash
doppler run --project cloud-v2 --config prod -- node .github/scripts/setup-store-publishing.mjs prod
```

The publishing tools are isolated from the miniapps' SDK.
`tooling/vendor/manifest.json` records the MentraOS commit and archive hashes of
the pinned `@mentra/cli` and `@mentra/miniapp-cli` packages. Replace them only
when intentionally upgrading the CLI.
