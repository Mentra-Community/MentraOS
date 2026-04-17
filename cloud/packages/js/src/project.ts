/**
 * @mentra/js — project discovery & bootstrap
 *
 * Shared helpers for `mentra dev` / `mentra build` that figure out what
 * lives in a MentraOS app project:
 *
 *   my-app/
 *     mentra.config.ts   — config (required)
 *     client/            — on-device code (optional but typical)
 *     webview/           — React UI (optional)
 *     server/            — optional Hono app for cloud/on-device server code
 *     shared/            — shared types
 *
 * We keep this logic out of `dev.ts` so `build.ts` can reuse it and so
 * it's easier to unit-test later.
 */

import { existsSync, writeFileSync, readFileSync } from "fs";
import { join, relative } from "path";

export interface MentraConfig {
  packageName: string;
  name: string;
  version?: string;
  permissions?: string[];
  server?: { env?: string[] };
  /**
   * Runtime selection (optional).
   *
   *   "auto"  - default. Cloud if MENTRAOS_API_KEY is set, otherwise
   *             simulated glasses. Almost always what you want.
   *   "cloud" - explicit: require cloud + API key. Fail loud if absent.
   *   "sim"   - explicit: simulated glasses in-process. Never hits cloud.
   *
   * You rarely need to set this. Set it when you want to prevent
   * accidental cloud dependencies (pin to "sim") or when you want a
   * CI failure instead of a silent downgrade (pin to "cloud").
   */
  runtime?: "auto" | "cloud" | "sim";
}

export interface ProjectLayout {
  root: string;
  configPath: string;
  config: MentraConfig;
  clientEntry: string | null;
  webviewHtml: string | null;
  serverEntry: string | null;
}

/**
 * Discover the layout of the project rooted at `root`. Returns `null` if
 * there's no `mentra.config.ts` so the caller can render a friendly error.
 */
export async function loadProject(root: string): Promise<ProjectLayout | null> {
  const configPath = join(root, "mentra.config.ts");
  if (!existsSync(configPath)) return null;

  const mod = await import(configPath);
  const config: MentraConfig = mod.default;

  const clientEntry = pickEntry(root, ["client/index.ts", "client/index.tsx"]);
  const webviewHtml = pickEntry(root, ["webview/index.html"]);
  const serverEntry = pickEntry(root, ["server/index.ts", "server/index.tsx"]);

  return { root, configPath, config, clientEntry, webviewHtml, serverEntry };
}

function pickEntry(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Ensure a `bunfig.toml` exists in the project root that loads
 * `@mentra/js/dedupe-plugin`. Bun's fullstack dev server only accepts
 * bundler plugins through `[serve.static] plugins`, so we write this
 * file on first run (non-destructively — if one exists and already
 * references the plugin we leave it alone).
 *
 * The plugin pins `react` / `react-dom` to the project root's copy so
 * the webview and `@mentra/js/react` end up sharing one React instance.
 */
export function ensureBunfig(root: string): { written: boolean; path: string } {
  const bunfigPath = join(root, "bunfig.toml");
  const pluginRef = "@mentra/js/dedupe-plugin";
  const pluginsLine = `plugins = ["${pluginRef}"]`;

  if (!existsSync(bunfigPath)) {
    const contents = [
      "# Managed by @mentra/js — feel free to add your own keys.",
      "# The serve.static.plugins array is required for React dedupe in",
      "# the webview bundle (see @mentra/js/src/dedupe-plugin.ts).",
      "",
      "[serve.static]",
      pluginsLine,
      "",
    ].join("\n");
    writeFileSync(bunfigPath, contents);
    return { written: true, path: bunfigPath };
  }

  // Update existing bunfig.toml. We look for three states:
  //   1. Plugin already listed → nothing to do.
  //   2. [serve.static] has a plugins = [...] array → merge into it.
  //   3. [serve.static] exists but no plugins line → append one.
  //   4. No [serve.static] section → add one.
  //
  // We don't fully parse TOML — narrow regex manipulation is enough
  // and avoids taking a TOML dependency. If a user's bunfig is
  // complex enough to confuse this, they can manually add the plugin.
  const existing = readFileSync(bunfigPath, "utf-8");
  if (existing.includes(pluginRef)) {
    return { written: false, path: bunfigPath };
  }

  // Case 2: existing `plugins = ["..."]` under [serve.static]. Merge.
  const pluginsArrayRe = /(\[serve\.static\][\s\S]*?\bplugins\s*=\s*)\[([^\]]*)\]/;
  const match = existing.match(pluginsArrayRe);
  if (match) {
    const [full, prefix, inner] = match;
    const trimmedInner = inner.trim();
    const merged = trimmedInner.length > 0 ? `${prefix}[${trimmedInner}, "${pluginRef}"]` : `${prefix}["${pluginRef}"]`;
    const updated = existing.replace(full, merged);
    writeFileSync(bunfigPath, updated);
    return { written: true, path: bunfigPath };
  }

  // Case 3 / Case 4: no existing plugins array.
  const needsSection = !/\[serve\.static\]/.test(existing);
  const addition = needsSection
    ? `\n\n[serve.static]\n${pluginsLine}\n`
    : `\n# Added by @mentra/js — ensure this stays inside [serve.static].\n${pluginsLine}\n`;

  writeFileSync(bunfigPath, existing.trimEnd() + addition);
  return { written: true, path: bunfigPath };
}

export function rel(root: string, p: string): string {
  return relative(root, p) || ".";
}
