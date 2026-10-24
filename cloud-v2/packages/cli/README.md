# @mentra/cli

The Mentra developer CLI, the `mentra` command. Run, build and pack Mentra
miniapps, and sign in to Mentra.

It wraps [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli)
(the `dev` / `build` / `pack` author flow) and adds `login`, `whoami`,
`workspace` and `logout`.

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
mentra dev                 # local dev server; the phone runs it as the manifest package
mentra build               # build the current miniapp
mentra pack                # build and write build/, ready to upload to your miniapp's URL (use --sign to sign)
mentra login               # sign in to Mentra in your browser
mentra whoami              # who you are signed in as, and where
mentra workspace show      # your workspace and your role in it
mentra logout              # sign out on this computer
```

Run `mentra <command> --help` for the full option set.

## Publishing a miniapp

A miniapp is published at its own URL. `mentra pack` writes `build/`: the
served `miniapp.json`, the icon and the bundle ZIP. Upload that folder to your
miniapp's URL, as is; the Mentra App installs and updates the miniapp from
there. To list it in the Mentra Miniapp Store's directory, submit its URL at
[apps.mentraglass.com](https://apps.mentraglass.com). Neither needs this CLI to
be signed in.

## Sign in

```bash
mentra login
```

`mentra login` opens your browser at Mentra's sign-in page. When you have
signed in, the browser returns to the CLI on this computer, which listens on
`http://127.0.0.1:53682` (or 53683 or 53684 when that port is busy) only while
it waits. The CLI always prints the sign-in URL too, so you can open it yourself.

The CLI keeps your login in the OS keychain. Where there is no keychain, it uses
a file only you can read (mode `0600`) in `~/.mentra/cli-v2`, or in
`MENTRA_CLI_HOME` when set. It renews the login as you use it, and at once when
Core refuses its current access token. When Mentra's sign-in server no longer
accepts the login, for example after you signed out everywhere from your Mentra
account, the next command prints ``Session expired. Run `mentra login`.`` and
the CLI forgets the login.

```bash
mentra whoami   # email, Core user ID, sign-in server, Core, expiry
mentra logout
```

`mentra logout` ends this login at Mentra's sign-in server and deletes it from
this computer. It prints `Signed out`, or `Signed out locally; server sign-out
not confirmed` when the sign-in server could not confirm it; the login is
deleted from this computer either way. It ends only this login: your other CLI
logins and Mentra sign-ins stay signed in.

### Without a local browser

On a machine without a browser, for example over SSH, run:

```bash
mentra login --no-browser
```

The CLI prints the sign-in URL and the loopback port it is waiting on. Open the
URL in a browser on a computer that can reach that port. Over SSH, forward the
port when you connect, then open the URL in your local browser:

```bash
ssh -L 53682:127.0.0.1:53682 you@build-server
```

If the CLI reports another port (53683 or 53684), forward that one instead.

## Which Core

The CLI signs in to production Core, `https://core.mentraglass.com`. To use
another Core, for example a Mentra Private Cloud's or one running locally:

```sh
mentra --core-url https://mentra.example.com login
mentra --core-url https://mentra.example.com workspace show
```

`MENTRA_CORE_URL` is the equivalent environment setting. Each Core has its own
login; switching Core never sends another Core's tokens.

The CLI asks Core which Mentra sign-in server and CLI client to use
(`/api/cli/config`). To set them yourself, set both `MENTRA_CLI_OIDC_ISSUER` and
`MENTRA_CLI_CLIENT_ID`.

| Setting | Meaning |
| --- | --- |
| `--core-url`, `MENTRA_CORE_URL` | The Core. Default `https://core.mentraglass.com`. |
| `MENTRA_CLI_OIDC_ISSUER`, `MENTRA_CLI_CLIENT_ID` | The sign-in server and CLI client, instead of asking Core. |
| `MENTRA_CLI_HOME` | Where the CLI keeps files. Default `~/.mentra/cli-v2`. |

URLs must be HTTPS; plain HTTP is accepted only for `127.0.0.1`, `localhost`
and `[::1]`.

In the MentraOS repository, `bun run mentra` runs this CLI against production
Core. `bun run mentra:dev` uses the development Core, `bun run mentra:staging`
the staging Core and `bun run mentra:local` a Core on `localhost:3000`.

## Workspaces

A person belongs to one workspace. Administer it (members, invitations, roles)
in Mentra Portal.

```bash
mentra workspace show                  # your workspace and your role in it
mentra workspace create "Your Team"    # create your workspace when you have none
```

If an account still belongs to more than one, which Mentra no longer allows,
`mentra workspace show` lists them and says to contact Mentra support to bring
the account down to one.

## Optional publisher signatures

`mentra pack` writes an unsigned bundle. It does not create or read publisher
keys, including keys configured through environment variables.

To opt into publisher signatures explicitly, create and back up a durable
Ed25519 key, then sign with `pack`:

```bash
mentra miniapps keys create --package com.example.myminiapp
mentra miniapps keys export --package com.example.myminiapp ./publisher-key.json
mentra pack --sign
```

The CLI stores publisher keys in the OS keychain when available and otherwise
uses mode-`0600` files beneath `~/.mentra/cli-v2/signing-keys/`. Import the same
key on another machine with
`mentra miniapps keys import --package com.example.myminiapp <path>`. Losing it
prevents a later release from updating the established package identity.

For an explicitly signed `pack`, CI may pass `--signing-key <path>`, set
`MENTRA_MINIAPP_SIGNING_KEY_FILE`, or provide the exported JSON through
`MENTRA_MINIAPP_SIGNING_KEY_JSON`; these inputs are used without persisting the
key.

Phones that already installed a signed release retain its publisher pin and
require that same key for future updates.

Phones apply the same rule to development builds. `mentra dev` serves unsigned
code under the manifest package name, so a phone runs it in place of an unsigned
install of that package (or when none is installed) and refuses it while the
package is installed with a publisher signature. Uninstall the signed miniapp
from the phone first; uninstalling clears its recorded key. A dev build needs no
login: the phone requests the miniapp's `session.auth` token for that package
exactly as it does for an installed one.
