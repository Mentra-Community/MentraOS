# @mentra/cli

The Mentra developer CLI — the `mentra` command. Build, publish, and manage
Mentra miniapps against the Cloud V2 developer console.

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
mentra pack               # sign dist/ into a submittable release ZIP
mentra publish            # upload + publish a release
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

## Publisher keys and signed bundles

Every production ZIP is signed by a durable Ed25519 key scoped to its package.
Create and back up the key before the first `pack` or `publish`:

```bash
mentra miniapps keys create --package com.example.myminiapp
mentra miniapps keys export --package com.example.myminiapp ./publisher-key.json
mentra publish
```

The CLI stores publisher keys in the OS keychain when available and otherwise
uses mode-`0600` files beneath `~/.mentra/cli-v2/signing-keys/`. Import the same
key on another machine with
`mentra miniapps keys import --package com.example.myminiapp <path>`. Losing it
prevents a later release from updating the established package identity.

CI may pass `--signing-key <path>`, set
`MENTRA_MINIAPP_SIGNING_KEY_FILE`, or provide the exported JSON through
`MENTRA_MINIAPP_SIGNING_KEY_JSON`; these inputs are used without persisting the
key. `--no-pack` accepts only an already signed ZIP and never silently signs it
during upload.

## Stable and beta releases

Release tracks are independent of the selected Core environment. `stable` is
the default; use `beta` for an opt-in preview release:

```bash
mentra publish --track beta
mentra releases list com.example.myminiapp
```

Each upload is permanently assigned to one track. Admin review publishes it to
that track's independent active slot. Store users remain on stable unless they
opt into beta for that miniapp. If no beta is currently published, Core serves
stable without discarding their beta preference.

The published CLI targets production by default. Set `MENTRA_CORE_URL` and
`MENTRA_CONSOLE_URL` to use a local, development, staging, or self-hosted Core;
the CLI discovers that Core's public WorkOS client id automatically.

Run `mentra <command> --help` for the full option set.
