# @mentra/cli

The Mentra developer CLI — the `mentra` command. Build, publish, and manage
Mentra miniapps against the independently deployed Mentra Miniapp Store.

It wraps [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli)
(the `dev` / `build` / `pack` author flow) and adds account and store operations:
`login`, `whoami`, `workspace`, `miniapps`, `releases`, and `publish`.

> **Bun-only.** This CLI ships as TypeScript and runs under [Bun](https://bun.sh)
> (`#!/usr/bin/env bun`). Use `bun` / `bunx`, not `npx`/Node.

## Install

```bash
bun add -g @mentra/cli@dev
mentra --help
```

Or run without installing:

```bash
bunx @mentra/cli@dev --help
```

## Common commands

```bash
mentra login              # sign in to the Mentra Developer Console
mentra dev                # local dev server; the phone runs it as the manifest package
mentra build              # build the current miniapp
mentra pack               # build and pack locally (use --sign to sign)
mentra publish --no-submit # build and upload an unsigned draft
mentra miniapps list      # miniapps owned by your workspace
mentra releases submit    # submit an uploaded release for review
```

The CLI keeps publishing scoped to one workspace: a group of people who share
miniapps, credentials, and a package prefix. `mentra login` selects your workspace
automatically when you belong to only one. When an account belongs to more than
one, select it explicitly:

```bash
mentra workspace list          # * marks the active workspace
mentra workspace use ws_...
mentra workspace show          # the active workspace and its package prefix
```

Without a selection, a command that needs a workspace stops and asks you to run
`mentra workspace use <id>`, listing the ids you can choose from.

To create another workspace, optionally with its package prefix:

```bash
mentra workspace create "Your Team" --package-prefix com.example
```

The new workspace becomes the active one. To set or change the package prefix of
the active workspace later (or in the Developer Console):

```bash
mentra workspace set-prefix com.example
```

`mentra workspace show` says "not set" while a workspace has no prefix, and "not
visible to your role" to a member, who cannot publish. `MENTRA_CLI_WORKSPACE_ID` selects a
workspace for a run that authenticates with `MENTRA_CLI_TOKEN`. A workspace
credential (`msk_...`) already carries its workspace, so CI that publishes with
one needs no selection.

## Optional publisher signatures

`mentra publish` builds and uploads an unsigned bundle. It does not create or
read publisher keys, including keys configured through environment variables.
The Store accepts unsigned bundles and verifies any signature included in an
existing archive supplied with `--no-pack`.

To opt into publisher signatures explicitly, create and back up a durable
Ed25519 key, sign with `pack`, and upload those exact bytes:

```bash
mentra miniapps keys create --package com.example.myminiapp
mentra miniapps keys export --package com.example.myminiapp ./publisher-key.json
mentra pack --sign
mentra publish --no-build --no-pack
```

The CLI stores publisher keys in the OS keychain when available and otherwise
uses mode-`0600` files beneath `~/.mentra/cli-v2/signing-keys/`. Import the same
key on another machine with
`mentra miniapps keys import --package com.example.myminiapp <path>`. Losing it
prevents a later release from updating the established package identity.

For an explicitly signed `pack`, CI may pass `--signing-key <path>`, set
`MENTRA_MINIAPP_SIGNING_KEY_FILE`, or provide the exported JSON through
`MENTRA_MINIAPP_SIGNING_KEY_JSON`; these inputs are used without persisting the
key. `publish --no-pack` accepts either signed or unsigned ZIPs and uploads
without changing them. `publish` has no signing-key option.

Phones that already installed a signed release retain its publisher pin and
require that same key for future release updates. Accepting unsigned uploads
in the Store does not clear existing device pins. Store-side publisher records
also remain intact; an optional signed upload must match its recorded key.

Phones apply the same rule to development builds. `mentra dev` serves unsigned
code under the manifest package name, so a phone runs it in place of an unsigned
install of that package (or when none is installed) and refuses it while the
package is installed with a publisher signature. Uninstall the signed miniapp
from the phone first; uninstalling clears its recorded key. A dev build needs no
login: the phone requests the miniapp's `session.auth` token for that package
exactly as it does for an installed one.

## Stable and beta releases

Release tracks are independent of the selected Core environment. `stable` is
the default; use `beta` for an opt-in preview release:

```bash
mentra publish --track beta
mentra releases list com.example.myminiapp
```

Each upload is permanently assigned to one track. Admin review publishes it to
that track's independent active slot. Store users remain on stable unless they
opt into beta for that miniapp. If no beta is currently published, the Store serves
stable without discarding their beta preference.

The CLI targets one production Store, currently at
`https://store.dev.us-west-2.mentraglass.com`. The hostname is temporary;
`@dev` and `@beta` npm tags describe tool release channels, not Store catalogs.
Changing `MENTRA_CORE_URL` does not change the Store or its login.

For an explicitly local or self-hosted Store:

```sh
mentra --store-url http://localhost:3003 login
mentra --store-url http://localhost:3003 publish --no-submit
```

`MENTRA_STORE_URL` is the equivalent environment setting. Logins are scoped to
the selected Store; changing it requires that Store's own login. This release
requires signing in again after the older Core-scoped CLI. Publisher signing
keys remain in their existing package-scoped keychain/file storage.
The CLI discovers the selected Store's public WorkOS client id automatically.
Only `MENTRA_WORKOS_CLIENT_ID` explicitly overrides it; generic Core WorkOS
settings are ignored. Repository `bun run mentra` uses this same default. The
older `mentra:dev`, `mentra:staging`, and `mentra:prod` shortcuts are aliases for
that command; `mentra:local` explicitly selects localhost:3003. No Doppler session
is needed to run the developer CLI.

Upload builds an unsigned bundle, then `--no-submit` keeps it as a draft. Edit
its listing through the CLI or Developer Console. Public releases require staff approval
and a separate publication action; private distribution publishes upon submission
after automated validation. Use `--no-submit` when preparing either kind.

## Manage a Store listing from the terminal

The Developer Console is optional. Keep listing text in a JSON file, then apply
it to the active workspace's miniapp:

```json
{
  "subtitle": "A short introduction",
  "longDescription": "Your full description.\n\nA second paragraph.",
  "categories": ["productivity"],
  "privacyPolicyUrl": "https://example.com/privacy",
  "supportUrl": "https://example.com/contact",
  "websiteUrl": "https://example.com"
}
```

```sh
mentra listing show com.example.myminiapp
mentra listing update com.example.myminiapp --file store/listing.json
mentra listing assets upload com.example.myminiapp icon.png --role store_icon --skip-existing
mentra listing assets upload com.example.myminiapp cover.webp --role store_cover --skip-existing
mentra listing assets upload com.example.myminiapp screenshot.png --role gallery_screenshot
mentra listing assets remove com.example.myminiapp ASSET_ID
```

Updates change only the supplied fields; `null` clears a nullable field. Artwork
upload selects the new icon/cover or appends a screenshot. The JSON returned by
`listing show` includes asset IDs. Listing edits become public with the next
reviewed release; they do not alter an already published listing snapshot.

## CI publication

Ordinary developer credentials can upload/submit and publish an already approved
release. Store administrators can grant automatic approval to one miniapp's CI:

```sh
# Store administrator; the secret is written with mode 0600, never printed.
mentra admin publishing-token com.example.myminiapp --name "GitHub Actions main" --output ./store-token
gh secret set MENTRA_STORE_PUBLISH_TOKEN --repo OWNER/REPO < ./store-token
rm ./store-token
```

This credential can only manage that miniapp's listing and releases. It cannot
manage the workspace, access other miniapps, issue credentials, change app
visibility, or use administrator endpoints. Grant it only to a repository whose
production branch is trusted to approve releases. Revoke it with
`mentra tokens list` and `mentra tokens revoke CREDENTIAL_ID` using a workspace
owner/admin login. Ordinary workspace credentials are created with
`mentra tokens create --name NAME --output ./token`; add `--package PACKAGE`
(repeatable) to limit one to specific miniapps and `--expires 2030-01-01T00:00:00Z`
to make it expire. The secret is written to the new file and never printed.

In CI, pass the secret as `MENTRA_CLI_TOKEN` and explicitly set `MENTRA_STORE_URL`.
Build/check the production ZIP first, then run:

```sh
mentra publish --cwd miniapp --no-build --no-pack --skip-existing --publish --json
```

`--skip-existing` skips a version already published on the selected track. It
resumes a draft/submitted/accepted version from the existing local ZIP without
rebuilding or repacking, and only when its hash matches; a
conflicting bundle, rejected release, or suspended release fails. `--publish`
requests publication after submission. Ordinary keys still require staff review;
administrator-issued app publishing tokens may approve and publish automatically.
Developer publication rejects versions older than or equal to the active release.
Every bundle stays unsigned unless the supplied prebuilt ZIP was explicitly signed.

Store staff can also review entirely through the CLI:

```sh
mentra admin approve RELEASE_ID --notes "Reviewed"
mentra admin reject RELEASE_ID --notes "Reason"
mentra admin publish RELEASE_ID
mentra releases publish com.example.myminiapp RELEASE_ID
```

The source in PR #3743 requires new npm releases: `@mentra/miniapp-cli` base
`0.1.0-dev.2` and `@mentra/cli` base `2.0.0-dev.1`. The existing Developer Tools
release workflow publishes them in dependency order after the PR lands; older
npm versions do not implement this Store routing and unsigned publishing flow.

Run `mentra <command> --help` for the full option set.
