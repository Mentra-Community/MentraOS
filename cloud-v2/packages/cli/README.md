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
mentra pack               # zip dist/ into a submittable release
mentra publish            # upload + publish a release
mentra miniapps list      # miniapps owned by your org
mentra releases submit    # submit an uploaded release for review
```

Run `mentra <command> --help` for the full option set.
