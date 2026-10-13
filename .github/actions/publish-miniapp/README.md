# First-party miniapp Store publication

`.github/workflows/miniapp-store-publish.yml` uses this action to publish the
first-party miniapps kept in `miniapps/` to each Mentra Miniapp Store: production
(`https://api.apps.mentraglass.com`) and the dev Store
(`https://api.apps.dev.mentraglass.com`). The staging Store
(`https://api.apps.staging.mentraglass.com`) is listed in the workflow but turned
off until its keys exist.

1. Each miniapp's production pack runs (`NODE_ENV=production bun run pack`).
2. `operation: prepare` checks the bundle and rewrites it with canonical ZIP
   metadata, so a retry uploads identical bytes. Signed bundles are rejected.
3. The bundle is saved as a workflow artifact.
4. On a push to `dev`, `operation: publish` downloads that same artifact and
   publishes it to every Store with the miniapp's app-restricted publishing key
   for that Store.

The workflow first checks the Store's public catalog and publishes nothing,
with no key needed, when the Store's current release already has this version.
The action then checks again with the key: it skips a version the Store has
already published, before touching the listing, and skips a run whose commit
is no longer the tip of `dev`. Bump
`miniapp.json` to publish a new release or listing change.

Each miniapp keeps `store/listing.json` (the `mentra listing update --file`
fields) and `store/artwork.json` (an array of
`{"role": "store_icon" | "store_cover" | "gallery_screenshot", "path": "..."}`).
Paths are relative to the miniapp directory.

Each miniapp has its own key for each Store, issued by that Store's
administrators and restricted to that package. Revoking one key does not affect
the others. Never use a developer login, an organization-wide key, or a Core
credential here.

| Store | Where its keys are |
| --- | --- |
| Production | Repository secrets `MENTRA_STORE_PUBLISH_TOKEN_<MINIAPP>` |
| Dev | GitHub environment `miniapp-store-dev`: `MENTRA_DEV_STORE_PUBLISH_TOKEN_<MINIAPP>` |
| Staging | GitHub environment `miniapp-store-staging`: `MENTRA_STAGING_STORE_PUBLISH_TOKEN_<MINIAPP>` |

`<MINIAPP>` is `CAPTIONS`, `TRANSLATION`, `TELEPROMPTER`, `MAPS` (navigation) or
`RECORDER`. A non-production Store keeps its keys under its own names, so a
missing key fails the run instead of falling back to production's. Only `dev`
may deploy to those environments.

`.github/scripts/setup-store-publishing.mjs` sets up a dev or staging Store:
as that Store's staff account it creates or finds the "Mentra" workspace,
claims `com.mentra`, creates the miniapps the Store lacks, and stores a key for
each miniapp whose key is missing in the Store's environment. It is safe to run
again and never prints a key:

```bash
doppler run --project cloud-v2 --config dev_aws -- node .github/scripts/setup-store-publishing.mjs dev
doppler run --project cloud-v2 --config staging -- node .github/scripts/setup-store-publishing.mjs staging
```

To publish to staging, run it for staging (after `dev` is merged to `staging`,
which gives staging Core its workspaces and sign-in server), then uncomment the
staging entry in the workflow's `store` matrix.

The publishing tools are isolated from the miniapps' SDK.
`tooling/vendor/manifest.json` records the MentraOS commit and archive hashes of
the pinned `@mentra/cli` and `@mentra/miniapp-cli` packages. Replace them only
when intentionally upgrading the CLI.
