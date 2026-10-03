# MentraOS Miniapp SDK — developer guide

This is the workspace for building **and developing** the MentraOS miniapp SDK.
If you just want to *use* the SDK to write a miniapp, you don't need this folder —
run `bunx create-mentra-miniapp` and read [`docs/`](./docs/README.md). This guide
is for engineers working **on** the SDK itself or running the in-repo example.

## Documentation map

| If you want to… | Read |
| --- | --- |
| **Use the SDK** to build a miniapp (API, session, modules, React hooks) | [`../mobile/modules/miniapp/README.md`](../mobile/modules/miniapp/README.md) — the package reference |
| **Per-module deep dives** (return shapes, events, error codes) | [`docs/`](./docs/README.md) — start with [`two-layer.md`](./docs/two-layer.md) |
| **Use the CLI** (`dev` / `release` / `pack` / `manifest` / …) | [`miniapp-cli/README.md`](./miniapp-cli/README.md) |
| **Architecture / status walkthrough** | [`../agents/miniapp-sdk-overview.md`](../agents/miniapp-sdk-overview.md) |
| **Develop the SDK / run the example from a fresh clone** | this file (below) |

## Layout

This `sdk/` folder is a standalone [Bun workspace](https://bun.sh/docs/install/workspaces)
(`sdk/package.json` → `workspaces`). Note that **the SDK source does not live in
`sdk/`** — it's pulled in from the mobile module:

| Path | What it is |
| --- | --- |
| `../mobile/modules/miniapp` | **The actual `@mentra/miniapp` SDK source** (a workspace member, despite living outside `sdk/`). |
| `sdk/miniapp-cli` | `@mentra/miniapp-cli` — the `mentra-miniapp` author CLI (`dev`, `release`, `pack`, …). |
| `sdk/example-miniapp` | Reference miniapp that consumes both via `workspace:*`. The thing you run to see the SDK work. |
| `sdk/create-mentra-miniapp` | The `bunx create-mentra-miniapp` scaffolder + template. The template pins published versions, **not** `workspace:*`. |
| `sdk/docs` | Per-module SDK reference (`session.<module>`). |

Because `example-miniapp` depends on `@mentra/miniapp` via `workspace:*`, it
resolves to the **source** package — which means that package must be **built
to `dist/`** before the example can import it.

## First-time setup

```bash
cd sdk
bun install
```

`bun install` runs a `postinstall` that builds `@mentra/miniapp` for you, so
`dist/` exists from the start. (If that build fails for any reason it only
*warns* — install still succeeds — and you can build it by hand:
`cd ../mobile/modules/miniapp && bun run build`.)

## Running the example

```bash
cd sdk/example-miniapp
bun run dev
```

This validates `miniapp.json`, builds the example's `dist/`, serves it over your
LAN, and prints a QR code. On your phone: **Mentra app → Settings → Developer
settings → Mini App Development → Scan Mini App QR Code** (phone and laptop must
be on the same Wi-Fi, or run `bun run dev --usb` to go over the USB cable
instead). See [`miniapp-cli/README.md`](./miniapp-cli/README.md) for
`dev` / `release` / `pack` details.

## Developing the SDK itself

The example bundles `@mentra/miniapp` from the SDK's compiled `dist/` (it is
bundled *in*, not externalised — see `example-miniapp/build.ts`). So when you
change SDK source, you must recompile `dist/` for the example to pick it up.

**The normal loop — rebuild after a change:**

```bash
# 1. edit  ../mobile/modules/miniapp/src/...
# 2. rebuild the SDK
cd ../mobile/modules/miniapp && bun run build
# 3. rebuild the example bundle (or rely on `bun run dev`'s file watcher,
#    which rebuilds the example on save and hot-reloads the phone)
```

`bun run dev` in the example already watches the *example's* files and rebuilds
+ reloads on save — but it does **not** watch the SDK source. After an SDK
change, rebuild the SDK (`bun run build` in `mobile/modules/miniapp`); the
example's watcher then picks up the new `dist/` on its next rebuild.

**Optional — auto-recompile the SDK on save:** run the SDK's watch mode in a
second terminal so you don't rerun `build` manually:

```bash
cd mobile/modules/miniapp
bun run dev        # tsc --watch — re-emits dist/ on every save
```

We keep these two steps explicit rather than chaining the watchers together:
interleaved watcher output and racey rebuilds (the example bundling a
half-written `dist/`) cost more in confusion than the manual `build` saves.

## Useful scripts

From `sdk/`:

| Command | Does |
| --- | --- |
| `bun run build` | Build the `@mentra/miniapp` SDK (alias for the mobile-module build). |
| `bun run test` | Run the SDK's test suite. |

From `mobile/modules/miniapp/`:

| Command | Does |
| --- | --- |
| `bun run build` | One-shot compile to `dist/`. |
| `bun run dev` | `tsc --watch` — recompile `dist/` on save. |
| `bun run typecheck` | Type-check without emitting. |
| `bun run test` | Run SDK tests. |

## Troubleshooting

**`Cannot find module '@mentra/miniapp/background'` / "couldn't find background"
when running the example.**
The SDK's `dist/` hasn't been built. The `./background` (and `./ui`, `./react`)
subpath exports resolve to `dist/...`, which is gitignored — a fresh clone has
no `dist/` until it's compiled. Fix:

```bash
cd mobile/modules/miniapp && bun run build
```

`bun install` from `sdk/` does this automatically; you only hit this if the SDK
was edited/cleaned and not rebuilt.

**`workspace:*` won't resolve / `@mentra/miniapp` not found at install time.**
Run `bun install` from `sdk/` (the workspace root where `bun.lock` lives), not
from inside `example-miniapp/`. The workspace includes `../mobile/modules/miniapp`,
so that path must be present in your checkout (no sparse clone).

**Using `npm` instead of Bun.** This workspace is Bun-only: `workspace:*` is a
Bun/pnpm/yarn protocol, the CLI bin is a raw `.ts` file, and the builds use
`Bun.build`. Use `bun`.
