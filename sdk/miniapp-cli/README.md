# @mentra/miniapp-cli (`mentra-miniapp`)

Author-facing CLI for MentraOS miniapps. Pairs with [`@mentra/miniapp`](../miniapp).

```
mentra-miniapp <command>
```

## Commands at a glance

| Command                                           | What it does                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| [`dev`](#dev)                                     | Starts the dev server (hot reload unless `--no-hot-reload`), prints a QR to load it on a phone. With [`--production`](#dev---production), serves the production build instead |
| [`pack`](#pack)                                   | Writes `build/`, ready to upload to your miniapp's URL                    |
| [`manifest`](#manifest)                           | Interactive top-level wizard for editing `miniapp.json`                   |
| [`permission list \| add \| remove`](#permission) | Object-verb manifest edits for permissions                                |
| [`hardware list \| add \| remove`](#hardware)     | Object-verb manifest edits for hardware requirements                      |
| [`schema print`](#schema)                         | Prints the canonical `miniapp.json` JSON Schema to stdout                 |

Run with no args to print the same usage table.

---

## `dev`

```bash
mentra-miniapp dev
mentra-miniapp dev --no-hot-reload          # serve + logs only; no remount on save
mentra-miniapp dev --usb                    # reach the phone over USB, no shared Wi-Fi
mentra-miniapp dev --usb --device <serial>  # pick one of several attached devices
mentra-miniapp dev --production             # serve the production build; see below
```

What it does:

1. Reads + validates `miniapp.json` (hard-fails on bad permissions / hardware types so you don't have to debug it on the phone).
2. Runs the project's `build.ts` so `dist/background/index.js` and `dist/ui/*` are current.
3. Picks the first free adjacent port pair starting at `port`: one for static files and the next for the dev sidecar.
4. Starts a static server at the miniapp URL. It serves `miniapp.json` the way any miniapp URL does, as the project's `miniapp.json` plus `bundle: {url: "<packageName>-<version>-<hash>.zip", sha256}`, and adds a `development` field, `{reload: "ws://<host>:<port + 1>/__mentra_dev", mdns: "<name>.local"}`, which the Mentra App reads only from a local-network URL. It serves that ZIP, built from the current `dist/`, plus `icon.png` and the project files. `<hash>` is the first 8 hex digits of the ZIP's SHA-256, so every build has its own file name, and a phone or a proxy never takes an earlier download for the new build. The same files always make the same ZIP, so the name and the hash hold until a rebuild changes them. The latest build is also at `bundle.zip`, where released Mentra Apps ask for it. The served `miniapp.json` has no `versions`; only [`pack`](#pack) writes that list.
5. Starts a **dev sidecar** on `port + 1` — a WebSocket the phone connects to for live reload + console-log forwarding back to your terminal. Failure here is non-fatal; the miniapp still runs without live reload. `--no-hot-reload` keeps the log bridge and the ZIP but skips the filesystem watcher, so saves no longer remount the WebView or respawn the background JSContext.
6. Detects the LAN IP (or sets up USB tunnels with `--usb`) and prints the miniapp URL, `http://<lan-ip>:<port>/`, and its terminal QR. The Mentra App installs it like any other miniapp URL, as a local-network miniapp: it isn't registered, keeps its own data, and its tokens say it is a local build.
7. Watches for LAN-IP changes (Wi-Fi switch) every 2s and reprints the QR. Skipped under `--usb`, where the QR host is a fixed loopback address.

Default `port` is `3000`; override the starting point with a `"port": <n>` field in `miniapp.json`. If that port or its sidecar neighbor is busy, `dev` scans upward until it finds a free adjacent pair.

**On the phone:** open the Mentra App → **Settings → Miniapp Developer Settings → Scan Miniapp QR Code**. Phone and laptop must be on the same Wi-Fi, unless you use `--usb` (below).

`dev` runs your miniapp the way an installed one runs. The Mentra App downloads
the ZIP and runs it from the phone: the background from the bundle, the
screen from the origin the app serves an installed bundle's screen from, with the
miniapp's own files (such as `photo.url`) under it. Your screen can't load files
from the LAN server by relative URL, just as an installed one can't. Each saved
change downloads the new ZIP, when its SHA-256 changed, and reopens the
screen from it.

`dev` is live and temporary. Keep the CLI and computer running for hot reload;
the phone keeps the last bundle it downloaded, so the miniapp still opens from it
while the computer is away. Dev miniapps are keyed
by their manifest package name, so you can scan and test several side by side;
rescanning the same package updates only that entry. The Mentra App caches each
entry's name and icon. Use [`dev --production`](#dev---production) to try the
build users will get.

`Ctrl+C` stops the server, the sidecar, the IP watcher, and any USB tunnels.

### `dev --production`

```bash
mentra-miniapp dev --production
mentra-miniapp dev --production --sign                    # sign with the package's stored publisher key
mentra-miniapp dev --production --signing-key key.json    # sign with a key file (not stored)
mentra-miniapp dev --production --usb                     # over USB, as with dev
```

Serves the production build from this computer: how you try what users will get
before you upload it.

1. Builds as [`pack`](#pack) builds: `<pm> run build` with `NODE_ENV=production`, then the same ZIP, with the same checks. `--sign` and `--signing-key` sign it as they do for `pack`. It is unsigned unless you ask.
2. Serves it at the same kind of miniapp URL as `dev`, on the same ports, and prints the same plain-URL QR. `miniapp.json` names the ZIP `pack` would write, `<packageName>-<version>-<hash>.zip`, and its SHA-256. The server serves what a host holding `pack`'s folder serves: `miniapp.json`, the ZIP and the icon. It serves no other project file.
3. Watches nothing. A saved change neither rebuilds nor reloads; the sidecar only forwards the console. After a change, stop it and run it again. The Mentra App takes the new build from the same URL the next time it opens the miniapp, so you scan again only when the address changed.

It writes nothing to `build/` and lists no `versions`. The phone keeps the build
it downloaded, so the miniapp opens with this computer away.

### `release`

`mentra-miniapp release` is the former name of `dev --production`. It still runs
for one more release of the CLI: it prints one line saying so, then does what
`dev --production` does. Its flags still work (`--sign`, `--signing-key`,
`--qr-output`; `--no-cache` has nothing left to skip, since the production build
always runs). It prints a plain-URL QR code, where it printed a
`miniapp://release?…` one before, and serves on `dev`'s ports, not on 6789. Change scripts
that call `release` to `dev --production`.

### `--usb` — no shared Wi-Fi required

`--usb` runs `adb reverse` for the static port and the sidecar port, which
publishes them on the phone's own loopback address over the USB cable. The QR
then advertises `http://127.0.0.1:<port>/` instead of a LAN IP, so the phone and
the laptop no longer need to share a network. This is the fix when you're on
guest Wi-Fi, on a network with AP client isolation, or on no Wi-Fi at all.

Everything else behaves the same: live reload and console forwarding ride the
same tunnel, and the served `miniapp.json` still names the mDNS name as a fallback.

Notes:

- **Android only.** iOS has no `adb`, so `--usb` can't work there.
- Requires `adb` on `PATH` (Android platform-tools) and USB debugging accepted
  on the device.
- With several devices attached, `dev` refuses to guess and lists the serials —
  pass `--device <serial>`. Mentra Live glasses (`0123456789ABCDEF`) are skipped
  automatically so a phone + glasses pair does not need `--device`.
- If the tunnel can't be established, `dev` falls back to the LAN address and
  says so. With no LAN address either, it exits.
- Reverse mappings die on unplug, on `adb kill-server`, and on device reboot.
  `dev` re-checks every 5s and re-asserts them, logging only the transitions.
- Teardown removes only the ports it opened, so a Metro `tcp:8081` mapping you
  set up separately survives.

---

## `pack`

```bash
mentra-miniapp pack
mentra-miniapp pack --no-build                # zip dist/ as-is, skip the build
mentra-miniapp pack --sign                    # sign with the package's stored publisher key
mentra-miniapp pack --signing-key key.json    # sign with a key file (not stored)
mentra-miniapp pack --url https://notes.example.com/   # keep the versions published there; use it in CI
```

Writes `build/`, a folder ready to upload as is to your miniapp's URL. [`dev --production`](#dev---production) serves the same ZIP from your computer.

Steps:

1. Runs `<pm> run build` with `NODE_ENV=production` (same as `dev --production`), so the zip always contains a production bundle — never a stale dev build left behind by `dev`. Pass `--no-build` to skip this and zip whatever is already in `dist/`.
2. Verifies `dist/` exists.
3. Validates `miniapp.json`. It must not declare `bundle` or `versions`; `pack` fills those in.
4. Copies `miniapp.json` and `icon.png` into `dist/`.
5. Zips `dist/` to `build/<packageName>-<version>-<hash>.zip`, signed with `--sign` or `--signing-key`, and prints its path and SHA-256. `<hash>` is the first 8 hex digits of that SHA-256. The same files always make the same ZIP: entries are in name order and carry one fixed date and the same permissions, so neither the time nor the machine reaches it, and the same key signs it to the same bytes.
6. Writes the icon and `miniapp.json` beside the ZIP.

`build/` then holds what your miniapp's URL serves:

| File                            | What it is                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `miniapp.json`                  | Your `miniapp.json` plus `bundle: {url: "<packageName>-<version>-<hash>.zip", sha256}`, naming the ZIP, and [`versions`](#versions) |
| `<packageName>-<version>-<hash>.zip` | The bundle. ZIPs of earlier builds stay beside it, and no build replaces another's file. |
| the icon, such as `icon.png`    | The file `miniapp.json`'s `icon` names, taken from the ZIP. An icon URL on another host is left to that host. |

Upload the folder to any static host, such as GitHub Pages, Cloudflare Pages or R2, or S3, at your miniapp's URL. For each release, upload the ZIP before `miniapp.json`, so the URL never names a ZIP that isn't there yet. The Mentra App updates an installed miniapp when the ZIP's SHA-256 differs from the one it has, whatever the two versions are: a change reaches phones with or without a new `version`, and uploading an earlier build again rolls back to it.

### `versions`

`versions` lists the versions a phone can be pinned to. A workspace can hold its
phones on one version of your miniapp; a pinned phone finds that version's ZIP in
this list. A miniapp without the list can't be pinned, and nothing else about it
changes.

```json
"bundle": {"url": "com.example.notes-0.3.5-9f2c0e1a.zip", "sha256": "9f2c0e1a…"},
"versions": [
  {"version": "0.3.5", "url": "com.example.notes-0.3.5-9f2c0e1a.zip", "sha256": "9f2c0e1a…"},
  {"version": "0.3.4", "url": "com.example.notes-0.3.4-41ab77c3.zip", "sha256": "41ab77c3…"}
]
```

- **One entry per version.** `pack` adds the version it packed. Packing other bytes under a version already listed replaces that version's entry with the new hash; a phone pinned to that version then keeps the build it has, and its pin shows as one that can't be met. Give a version you want pinnable for good a number you don't reuse.
- **Highest version first,** by semantic version: `1.10.0` is above `1.9.3`, and a prerelease is below its release (`1.1.0-beta.2` is below `1.1.0` and above `1.0.9`). `bundle` is the build packed last, whatever its version.
- **At most 50.** Past that the lowest versions leave the list. The version just packed always stays.
- **`url` is relative to your miniapp URL,** as `bundle.url` is: the ZIP's file name. An entry kept from the published list keeps the URL it was published with.
- **Where the earlier versions come from.** With `--url <your miniapp URL>`, `pack` reads the `miniapp.json` published there and keeps the versions it lists. Without `--url`, it keeps the ones in `build/miniapp.json` from the last pack whose ZIPs are still in `build/`, and warns about any it drops.
- **Use `--url` in CI.** A clean checkout has no `build/`, so without `--url` it would write a list with one version, and uploading that would drop every other version from your URL. With `--url`, a URL that can't be reached, isn't your package's `miniapp.json` or has a list `pack` can't read stops the pack. Only an answer of `404`, nothing published yet, starts a new list.
- **Keep the old ZIPs online.** A listed version is only pinnable while its ZIP is still at your URL. If your host replaces the whole site on each deploy, keep `build/` between packs and upload all of it.
- A `miniapp.json` published before the list existed gains one on the next pack, starting with the build it serves.
- A `version` that isn't a semantic version is packed and not listed.

`build/` is self-ignoring — the CLI writes a `.gitignore` containing `*` into it on creation, so packed zips stay out of version control in any repo without touching the project's own `.gitignore`. Leave that `.gitignore` out if you deploy the folder by committing it to git.

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

`port` defaults to `3000` for `dev`, with or without `--production`. It is the starting port; if the port or its sidecar neighbor is busy, the CLI scans upward until it finds a free adjacent pair.

The CLI's allowed-value lists are mirrored by hand from `@mentra/engine` and `@mentra/miniapp` to keep the CLI dependency-light so `bunx mentra-miniapp` stays fast. Drift is caught at validation time, not import time.

---

## File map

- Subcommand handlers: `src/{dev,pack,permission,hardware,schema,manifest-wizard}.ts`
- The `versions` list `pack` keeps: `src/versions.ts`
- Manifest validation + allowed-value lists: `src/manifest.ts`
- Manifest mutation backend (shared by wizard + object-verb commands): `src/manifest-mutate.ts`
- Manifest read/write helpers: `src/manifest-format.ts`
- Permission/hardware human-readable hints: `src/permission-hints.ts`
- Dev sidecar WebSocket server: `src/dev-server.ts`
- QR rendering: `src/qr.ts`
- Generated JSON Schema: `schema/miniapp.schema.json` (regenerated via `schema regenerate`)

## Try a packed miniapp during routine authoring

With the Mentra App already signed in and its existing **Super Mode** enabled, build and pack the modified miniapp normally.
For a fresh local authoring build, set `EXPO_PUBLIC_SUPER_MODE=true` when building
the Mentra App. This defaults the existing setting on without UI clicks; normal
builds default it off. An explicitly saved setting still takes precedence. This
is a local build option, not a change to the requested CI artifact.

From the MentraOS checkout, load the resulting ZIP without navigating developer settings:

```bash
MENTRA_MAC_APP=/absolute/path/Mentra.app bun scripts/load-authoring-miniapp.mjs /absolute/path/com.mentra.notes-1.0.27.zip --mac
bun scripts/load-authoring-miniapp.mjs /absolute/path/com.mentra.notes-1.0.27.zip --android R5CW22Z3GDZ
```

The command serves only that ZIP on loopback; Android uses an owned `adb reverse`
tunnel. It sends `com.mentra://test/load-miniapp?url=...&package=...&version=...`.
The app validates the ZIP into an isolated dev snapshot using the existing
installer, checks deployment authorization and existing permissions, then stops
and opens the named miniapp through
the normal miniapp lifecycle. No Mentra App rebuild, sign-out or routine restart is
needed after installing a host build that includes this handler. New permissions
must already be granted. This does not change production bundles or routine replay
configuration. Repacking the same version creates a fresh dev snapshot and UI;
managed release files stay intact. Failed replacement restores the previous
selection and running state.

Keep the command running until the app opens the miniapp, then press Ctrl+C to
stop its server and remove its USB tunnel. App logs emit `MINIAPP_LOAD_RESULT`
with `opened` or `failed`; URL delivery alone does not prove installation or UI
readiness. Verify the changed step in the held authoring session.

Incident submission uses the same cross-platform transport:

```bash
MENTRA_MAC_APP=/absolute/path/Mentra.app bun scripts/submit-test-incident.mjs --mac alert_id=authoring-1 failure_code=search_failed 'failure_message=Search did not filter the notes'
bun scripts/submit-test-incident.mjs --android R5CW22Z3GDZ alert_id=authoring-2 failure_code=search_failed 'failure_message=Search did not filter the notes'
```

Both send `com.mentra://test/submit-incident-report`. The existing incident modal
keeps the current screen underneath and shows upload status and the report ID.
The packed snapshot becomes the selected source, even if this package previously
used a scanned development server. A later scan selects that server again. Failed
replacement restores the previous source.

For an Android build variant, set `MENTRA_HOST_PACKAGE` to its exact application
ID (for example `com.mentra.mentra.china`) when running either script. The default
is `com.mentra.mentra`.

For Mac, both scripts require `MENTRA_MAC_APP` to identify the exact installed
`.app`, so another Mentra App build cannot receive the URL by mistake. The live
word monitor accepts the Android variant through `--app-package`.

Both script entry points require Super Mode. The old Android incident broadcast
has been removed; automated-testing callers use this shared URL. Normal user
feedback remains available without Super Mode.
