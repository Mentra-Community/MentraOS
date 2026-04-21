# Spike: `mentra docs` CLI Command

## Overview

**What this doc covers:** A CLI command that lets developers (and LLMs) browse, search, and download MentraOS SDK documentation directly from the terminal.
**Why this doc exists:** AI coding assistants waste context window searching for docs through file trees. A single `mentra docs <page>` command gives them (and humans) instant access to the right content.
**Who should read this:** CLI developers, SDK team.

## Background

When an LLM helps a developer build a MentraOS mini app, it needs to know the API surface. Today that means grepping through `.mdx` files, reading `docs.json` to find paths, and parsing Mintlify frontmatter. This is slow, error-prone, and wastes context.

The `mentra` CLI already exists at `cloud/packages/cli/`. Adding a `docs` subcommand gives both humans and LLMs a fast path to documentation.

## Proposed Commands

### `mentra docs`

Lists all available documentation pages with their slug and description.

```
$ mentra docs

v3 (SDK 3.x)
  mini-app-server          MiniAppServer (Hono, Bun, webhooks)
  webviews                 Webviews (Bun fullstack dev server, auth, bridge)
  session                  MentraSession (per-user session, 14 managers)
  device                   Device (buttons, gestures, state, capabilities)
  display                  Display (AR text layouts)
  transcription            Transcription (speech to text)
  translation              Translation (real-time translation)
  speaker                  Speaker (TTS, audio playback, streaming)
  microphone               Microphone (raw audio chunks, VAD)
  camera                   Camera (photos, video streaming)
  dashboard                Dashboard (persistent overlay text)
  permissions              Permissions (check and monitor)
  storage                  Storage (key-value store)
  led                      LED (color control)
  location                 Location (GPS coordinates)
  phone                    Phone (notifications, calendar)
  time                     Time (timezone, formatting)
```

### `mentra docs <page>`

Prints the full content of a documentation page as readable text in the terminal. Strips Mintlify frontmatter and MDX components. Renders markdown if the terminal supports it (Bun's markdown rendering), otherwise prints raw markdown.

```
$ mentra docs device

# Device

Buttons, gestures, head position, device state, and hardware events.

`session.device` gives you access to everything about the physical glasses...
(full page content)
```

Sub-pages work with slashes or dots:

```
$ mentra docs camera/streaming
$ mentra docs camera.streaming
```

### `mentra docs search <query>`

Searches across all pages for a query string. Returns matching snippets with page names.

```
$ mentra docs search "button press"

device (Device):
  session.device.onButtonPress(handler)
  handler receives: { button: string, action: string, timestamp: number }
  Buttons: "forward", "back", "select"
  Actions: "press", "long_press"

camera/photo-capture (Photo Capture):
  // Capture on button press
  session.device.onButtonPress(async (data) => {
    if (data.button === "select") {
      const photo = await session.camera.takePhoto();
```

### `mentra docs download`

Downloads all documentation pages to a local directory for offline access. LLMs can then grep or read files directly without running CLI commands for each lookup.

```
$ mentra docs download

Downloaded 20 pages to ~/.mentra/docs/
  ~/.mentra/docs/mini-app-server.md
  ~/.mentra/docs/session.md
  ~/.mentra/docs/device.md
  ~/.mentra/docs/device/hardware-capabilities.md
  ...

$ mentra docs path
/Users/dev/.mentra/docs/
```

After download, an LLM can read files directly:
```
$ cat ~/.mentra/docs/device.md
$ grep -r "onButtonPress" ~/.mentra/docs/
```

### `mentra docs update`

Refreshes the local copy. Pulls the latest versions from the docs source.

```
$ mentra docs update

Updated 3 pages (17 unchanged)
  device.md (modified)
  phone.md (modified)
  time.md (new)
```

## Data Source

The docs content comes from the `.mdx` files in the `docs/` directory of the repo. At CLI build/publish time, the MDX files are processed:

1. Strip Mintlify frontmatter (`---` blocks)
2. Strip MDX components (`<Card>`, `<Tabs>`, `<Warning>`, etc.) but keep their text content
3. Keep all markdown (headings, code blocks, tables, lists)
4. Keep all code examples verbatim
5. Bundle into a JSON manifest: `{ pages: [{ slug, title, description, content }] }`

The manifest can be:
- **Baked into the CLI package** at npm publish time (zero network needed for `mentra docs <page>`)
- **Hosted on a CDN** and fetched on first use (smaller CLI package, always up to date)
- **Downloaded locally** via `mentra docs download` (offline access for LLMs)

Recommendation: bake into the CLI package. Docs change with SDK versions, and the CLI is already versioned. A developer on `@mentra/sdk@3.0.0-alpha.1` should get docs that match that version, not the latest.

## Implementation Location

`cloud/packages/cli/src/commands/docs.ts`

The CLI already uses a command pattern (`app.ts`, etc.). The `docs` command follows the same structure.

## What This Does NOT Cover

- Serving docs as a local web server (use `mintlify dev` for that)
- Editing docs from the CLI
- Auto-generating docs from source code (separate effort)
- MCP server integration (could be a future extension)

## Open Questions

1. **Baked vs fetched:** Should the docs content ship inside the CLI npm package, or should `mentra docs` fetch from a CDN on first use? Baking in keeps it versioned and offline-ready. Fetching keeps the package small.

2. **Storage location for download:** `~/.mentra/docs/` (global) vs `.mentra/docs/` (per-project)? Global is simpler. Per-project lets different projects pin different doc versions.

3. **Bun markdown rendering:** Bun has been working on terminal markdown rendering. If available, use it for `mentra docs <page>`. If not, print raw markdown (still readable, just no colors/formatting).

## Next Steps

Write spec defining the exact CLI interface, output format, and data pipeline from MDX to bundled content.