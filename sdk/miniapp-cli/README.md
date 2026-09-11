# @mentra/miniapp-cli (`mentra-miniapp`)

Author-facing CLI for MentraOS miniapps. Pairs with [`@mentra/miniapp`](../miniapp).

```
mentra-miniapp <command>
```

## Commands at a glance

| Command                                           | What it does                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| [`dev`](#dev)                                     | Starts the dev server with hot reload, prints a QR to load it on a phone  |
| [`release`](#release)                             | Builds, packs, and serves a QR to install the release on a phone over LAN |
| [`pack`](#pack)                                   | Validates the manifest and zips `dist/` into `<pkg>-<version>.zip`        |
| [`manifest`](#manifest)                           | Interactive top-level wizard for editing `miniapp.json`                   |
| [`permission list \| add \| remove`](#permission) | Object-verb manifest edits for permissions                                |
| [`hardware list \| add \| remove`](#hardware)     | Object-verb manifest edits for hardware requirements                      |
| [`schema print`](#schema)                         | Prints the canonical `miniapp.json` JSON Schema to stdout                 |

Run with no args to print the same usage table.

---

## `dev`

```bash
mentra-miniapp dev
```

What it does:

1. Reads + validates `miniapp.json` (hard-fails on bad permissions / hardware types so you don't have to debug it on the phone).
2. Runs the project's `build.ts` so `dist/background/index.js` and `dist/ui/*` are current.
3. Picks the first free adjacent port pair starting at `port`: one for static files and the next for the dev sidecar.
4. Starts a static server that serves `miniapp.json`, `icon.png`, and project files.
5. Starts a **dev sidecar** on `port + 1` — a WebSocket the phone connects to for live reload + console-log forwarding back to your terminal. Failure here is non-fatal; the miniapp still runs without live reload.
6. Detects the LAN IP, builds a `miniapp://dev?url=…&name=…&package=…&dev=<sidecarPort>` URL, and prints a terminal QR + the raw URL.
7. Watches for LAN-IP changes (Wi-Fi switch) every 10s and reprints the QR.

Default `port` is `3000`; override the starting point with a `"port": <n>` field in `miniapp.json`. If that port or its sidecar neighbor is busy, `dev` scans upward until it finds a free adjacent pair.

**On the phone:** open the Mentra App → **Settings → Developer settings → Mini App Development → Scan Mini App QR Code**. Phone and laptop must be on the same Wi-Fi.

`dev` is live and temporary. Keep the CLI and computer running because the
Mentra App loads the runtime bundle from that LAN server. Dev miniapps are keyed
by their manifest package name, so you can scan and test several side by side;
rescanning the same package updates only that entry. The Mentra App caches each
entry's name and icon. Use `bun run release` when you need an installed miniapp
that works without the computer.

`Ctrl+C` stops the server, the sidecar, and the IP watcher.

---

## `release`

```bash
mentra-miniapp release
mentra-miniapp release --no-cache    # force rebuild even if cache is fresh
```

The all-in-one verb: build a release, pack it, and serve it behind a QR so you can install on as many phones as you like.

Flow:

1. Validates `miniapp.json`.
2. **Build cache.** Looks for `build/<packageName>-<version>.zip`. If it exists and every project source file (excluding `node_modules`, `dist`, `build`, `.git`) is older than the zip, reuses it. Otherwise rebuilds.
3. **Build.** Detects your package manager (`bun.lock` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, else `npm`) and runs `<pm> run build`. Your `package.json` must define a `build` script that produces `dist/`.
4. **Pack.** Calls the same logic as `mentra-miniapp pack` — validates the manifest, copies `miniapp.json` + `icon.png` into `dist/`, zips to `build/<packageName>-<version>.zip`. Prints size + duration.
5. **Serve.** Picks a free port between 6789 and 6798. Hosts the bundle, manifest, and icon over HTTP on `0.0.0.0`:
   - `GET /miniapp.json`
   - `GET /icon.png`
   - `GET /bundle.zip`
   - `GET /__mentra_release/health`
6. Prints a `miniapp://release?url=<lan-base>&package=…&version=…&name=…` URL + QR.
7. Stays up so multiple devices can install. Each `/bundle.zip` fetch logs `✓ Install #N — <name>@<version> → <remote>`.

`Ctrl+C` to stop the server.

**On the phone:** the Mentra App's QR scanner branches on `miniapp://release` and uses the dev composer to download + install the bundle. The miniapp lands in `lmas/<package>/<version>/` and behaves like any installed local miniapp — runs offline, persists across restarts, no laptop required after install.

> **Why "release" and not "install":** `install` collides with package managers (`bun run install` is reserved). Naming the action after the artifact you're producing avoids that collision and matches Android's `installRelease` mental model.

---

## `pack`

```bash
mentra-miniapp pack
mentra-miniapp pack --no-build    # zip dist/ as-is, skip the build
```

Produces a distributable ZIP. Use this when you want the artifact only — `release` calls `pack` internally.

Steps:

1. Runs `<pm> run build` with `NODE_ENV=production` (same as `release`), so the zip always contains a production bundle — never a stale dev build left behind by `dev`. Pass `--no-build` to skip this and zip whatever is already in `dist/`.
2. Verifies `dist/` exists.
3. Validates `miniapp.json`.
4. Copies `miniapp.json` and `icon.png` into `dist/`.
5. Runs the system `zip -r` command to produce `build/<packageName>-<version>.zip` and prints the absolute path.

`build/` is self-ignoring — the CLI writes a `.gitignore` containing `*` into it on creation, so packed zips stay out of version control in any repo without touching the project's own `.gitignore`.

The resulting ZIP is the artifact you'd upload to the miniapp store.

> Requires the `zip` binary on `PATH` (preinstalled on macOS and most Linux distros). On Windows, install `zip` via WSL or use a Unix-like shell.

---

## `manifest`

```bash
mentra-miniapp manifest
```

Interactive top-level wizard for `miniapp.json` (Clack-based). Loop:

- **Edit permissions** — add, remove
- **Edit hardware requirements** — add, remove
- **Show current manifest** — pretty-prints the JSON
- **Done** — exits

Persists after every confirmed change, so `Ctrl+C` never loses a saved edit.

The wizard shares its mutation backend (`manifest-mutate.ts`) with the object-verb commands below — behavior and validation are identical.

---

## `permission`

```bash
mentra-miniapp permission list
mentra-miniapp permission add [TYPE]
mentra-miniapp permission remove [TYPE]
```

`add` / `remove` are interactive when called without `TYPE` (Clack select prompts) and non-interactive when `TYPE` is provided.

Allowed `TYPE` values: `MICROPHONE`, `CAMERA`, `CALENDAR`, `LOCATION`, `BACKGROUND_LOCATION`, `READ_NOTIFICATIONS`, `POST_NOTIFICATIONS`.

Adding a permission interactively prompts for an optional human-readable description (shown in the OS prompt when the user is asked to grant the permission).

---

## `hardware`

```bash
mentra-miniapp hardware list
mentra-miniapp hardware add [TYPE] [LEVEL]
mentra-miniapp hardware remove [TYPE]
```

Allowed `TYPE` values: `CAMERA`, `DISPLAY`, `MICROPHONE`, `SPEAKER`, `IMU`, `BUTTON`, `LIGHT`, `WIFI`.
Allowed `LEVEL` values: `REQUIRED`, `OPTIONAL`.

- `REQUIRED` — glasses without this hardware can't run the app (hidden in the store / launcher on incompatible devices).
- `OPTIONAL` — glasses without this hardware still run the app, in a degraded state.

Add is interactive when called without `TYPE` / `LEVEL`. Non-interactive form requires both.

> The `EXIST` hardware type is injected by the phone at runtime (every miniapp implicitly requires that glasses are present). It's intentionally not in the allowed-types list — don't declare it.

---

## `schema`

```bash
mentra-miniapp schema print
```

Prints the canonical `miniapp.json` JSON Schema to stdout. Useful for piping into IDE config or for validation in CI.

The schema is generated from the same constants the validator uses (`ALLOWED_PERMISSIONS`, `ALLOWED_HARDWARE_TYPES`, `ALLOWED_HARDWARE_LEVELS`), so it can never drift from validation behavior.

The published schema file ships at `node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json` for editors that read `$schema` from `miniapp.json`. The scaffolder (`create-mentra-miniapp`) injects this `$schema` line into new projects automatically.

> `mentra-miniapp schema regenerate` exists too but is a CLI-internal command — it rewrites the published schema file from the in-source allowed-values lists. Authors don't need it.

---

## `miniapp.json` shape

```json
{
  "$schema": "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
  "packageName": "com.mentra.example",
  "version": "1.0.0",
  "name": "Mentra Example",
  "description": "…",
  "icon": "icon.png",
  "port": 3000,
  "permissions": [{"type": "MICROPHONE", "description": "Listen for what to caption."}],
  "hardwareRequirements": [
    {"type": "DISPLAY", "level": "REQUIRED"},
    {"type": "MICROPHONE", "level": "REQUIRED"}
  ]
}
```

Required: `packageName`, `version`, `name`, `hardwareRequirements`. Everything else is optional.

`packageName` must be reverse-DNS (`^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$`).

`port` defaults to `3000` for `dev` and is ignored by `release` (which picks its own free port). For `dev`, this is the starting port; if the port or its sidecar neighbor is busy, the CLI scans upward until it finds a free adjacent pair.

The CLI's allowed-value lists are mirrored by hand from `@mentra/engine` and `@mentra/miniapp` to keep the CLI dependency-light so `bunx mentra-miniapp` stays fast. Drift is caught at validation time, not import time.

---

## File map

- Subcommand handlers: `src/{dev,release,pack,permission,hardware,schema,manifest-wizard}.ts`
- Manifest validation + allowed-value lists: `src/manifest.ts`
- Manifest mutation backend (shared by wizard + object-verb commands): `src/manifest-mutate.ts`
- Manifest read/write helpers: `src/manifest-format.ts`
- Permission/hardware human-readable hints: `src/permission-hints.ts`
- Dev sidecar WebSocket server: `src/dev-server.ts`
- QR rendering: `src/qr.ts`
- Generated JSON Schema: `schema/miniapp.schema.json` (regenerated via `schema regenerate`)
