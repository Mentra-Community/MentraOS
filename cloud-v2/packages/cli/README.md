# @mentra/cli

The Mentra developer CLI — the `mentra` command. Build, publish, and manage
Mentra miniapps against the independently deployed Mentra Miniapp Store.

It wraps [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli)
(the `dev` / `build` / `pack` author flow) and adds account and store operations:
`login`, `whoami`, `org`, `miniapps`, `releases`, and `publish`.

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
mentra dev                # local dev server with a signed Cloud V2 identity
mentra build              # build the current miniapp
mentra pack               # build and pack locally (use --sign to sign)
mentra publish --no-submit # build and upload an unsigned draft
mentra miniapps list      # miniapps owned by your org
mentra releases submit    # submit an uploaded release for review
```

The CLI keeps publishing scoped to one developer organization. When an account
belongs to more than one, select it explicitly:

```bash
mentra org list
mentra org use dorg_...
```

To create an additional publisher organization after joining an existing team,
use:

```bash
mentra org init --new --name "Your Org" --prefix com.example
```

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
its listing in the Developer Console. Public releases require staff approval
and a separate publication action; private distribution publishes upon submission
after automated validation. Use `--no-submit` when preparing either kind.

The source in PR #3743 requires new npm releases: `@mentra/miniapp-cli` base
`0.1.0-dev.2` and `@mentra/cli` base `2.0.0-dev.1`. The existing Developer Tools
release workflow publishes them in dependency order after the PR lands; older
npm versions do not implement this Store routing and unsigned publishing flow.

Run `mentra <command> --help` for the full option set.
