# create-mentra-miniapp

Scaffold a new [MentraOS](https://github.com/Mentra-Community/MentraOS)
miniapp project — the `bun create` starter for apps that run on MentraOS
smart glasses.

## Usage

```sh
bun create mentra-miniapp my-app
cd my-app
bun install
bun run dev
```

> **Bun-only.** The scaffolder and the generated project's tooling run under
> [Bun](https://bun.sh) — use `bun` / `bunx`, not `npx`.

The generated project comes wired with
[`@mentra/miniapp`](https://www.npmjs.com/package/@mentra/miniapp) (the SDK
runtime) and [`@mentra/miniapp-cli`](https://www.npmjs.com/package/@mentra/miniapp-cli)
(the `dev` / `build` / `pack` author flow), a `miniapp.json` manifest, and a
TypeScript setup. Dependency pins are stamped at publish time to the exact
SDK versions this scaffolder shipped with, so a generated project installs
on any release channel.

It also includes an `AGENTS.md` (imported by `CLAUDE.md`) with the rules a
coding agent needs to build a miniapp that fits the Mentra App: safe areas and
the capsule menu, light and dark colors, back navigation, the icon, and when to
use `dev` vs. `release`.

To publish a finished miniapp, pack it (`mentra pack`, from
[`@mentra/cli`](https://www.npmjs.com/package/@mentra/cli)) and upload `build/`
to the miniapp's URL; to list it in the Mentra Miniapp Store's directory, submit
that URL there.

## Part of MentraOS

Source lives in the [MentraOS monorepo](https://github.com/Mentra-Community/MentraOS)
under `sdk/create-mentra-miniapp`. Issues and contributions welcome there.
