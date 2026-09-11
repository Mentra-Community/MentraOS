# Publishing Mentra Developer Tools

`@mentra/miniapp` is part of the coordinated Mentra release family. It is
published by `.github/workflows/coordinated-release.yml` alongside MentraOS,
Mentra Engine, and Bluetooth SDK.

The following developer tools intentionally keep independent versions and are
published by `.github/workflows/developer-tools-release.yml`:

| Package                 | Source                      |
| ----------------------- | --------------------------- |
| `@mentra/miniapp-cli`   | `sdk/miniapp-cli`           |
| `create-mentra-miniapp` | `sdk/create-mentra-miniapp` |
| `@mentra/auth`          | `cloud-v2/packages/auth`    |
| `@mentra/cli`           | `cloud-v2/packages/cli`     |

## Channels

Each tool keeps a prerelease source version such as `0.2.0-dev.3`. The branch
selects its published channel:

| Branch    | Published version | npm tag  |
| --------- | ----------------- | -------- |
| `dev`     | `0.2.0-dev.3`     | `dev`    |
| `staging` | `0.2.0-beta.3`    | `beta`   |
| `main`    | `0.2.0`           | `latest` |

The workflow is manually dispatched on the selected branch after that channel's
coordinated `@mentra/miniapp` version is publicly readable. This prevents the
scaffolder from racing the coordinated publisher and capturing a stale template
pin. The workflow is registry-state driven and idempotent: it publishes only
versions that are absent from npm, in dependency order. First-time package
publication requires `force_release=true`. Beta and stable versions use npm's
staged-publishing queue and require approval there.

`create-mentra-miniapp` resolves the current published `@mentra/miniapp` version
for the same channel before packing its template. It consumes the coordinated
package; it does not publish it.

## Required Setup

The workflow requires the repository secret `NPM_TOKEN` with publish access to
the `@mentra` organization. Every public package must also have public npm access
configured. Use a dry-run dispatch to inspect package contents before
publication:

```bash
gh workflow run developer-tools-release.yml --ref dev \
  -f dry_run=true -f force_release=false
```

To bootstrap a package that has never existed on npm, rerun deliberately with
`dry_run=false` and `force_release=true` after reviewing the dry run.

For an ordinary release, rerun with `dry_run=false` and
`force_release=false`. Do not dispatch until `npm view @mentra/miniapp
dist-tags.<dev|beta|latest>` resolves to the coordinated version expected by the
selected branch.
