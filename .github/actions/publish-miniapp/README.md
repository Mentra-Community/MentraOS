# First-party miniapp Store publication

`.github/workflows/miniapp-store-publish.yml` uses this action to publish the
first-party miniapps kept in `miniapps/` to the Mentra Miniapp Store.

1. Each miniapp's production pack runs (`NODE_ENV=production bun run pack`).
2. `operation: prepare` checks the bundle and rewrites it with canonical ZIP
   metadata, so a retry uploads identical bytes. Signed bundles are rejected.
3. The bundle is saved as a workflow artifact.
4. On a push to `dev`, `operation: publish` downloads that same artifact and
   publishes it with the miniapp's app-restricted publishing key.

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

Each miniapp has its own key, issued by a Store administrator and restricted to
that package, in a repository secret named
`MENTRA_STORE_PUBLISH_TOKEN_<MINIAPP>`. Revoking one key does not affect the
others. Never use a developer login, an organization-wide key, or a Core
credential here.

The publishing tools are isolated from the miniapps' SDK.
`tooling/vendor/manifest.json` records the MentraOS commit and archive hashes of
the pinned `@mentra/cli` and `@mentra/miniapp-cli` packages. Replace them only
when intentionally upgrading the CLI.
