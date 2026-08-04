// Channel promotion: how a base version in git becomes a published version.
//
// Git holds ONE version per package, only ever edited on dev, always a
// prerelease: X.Y.Z-<label>.N. CI derives the published version from the
// branch, so merging a branch up the chain IS the promotion — no source edits
// ride dev -> staging -> main:
//
//   dev      -> X.Y.Z-dev.N   (dist-tag dev)
//   staging  -> X.Y.Z-beta.N  (dist-tag beta)
//   main     -> X.Y.Z         (dist-tag latest, npm's default install)
//
// The prerelease NUMBER is preserved across channels (0.1.0-dev.3 promotes to
// 0.1.0-beta.3) so a beta is traceable to the dev build it came from. After a
// plain X.Y.Z ships from main, cutting a new release means bumping the base on
// dev (X.Y.(Z+1)-dev.0) — the derived plain version already existing on npm is
// how the pipeline knows a base is spent.
//
// This module is shared by the release detect scripts and the publish-time
// manifest stamp so version derivation can never drift between them.
import {execFileSync} from "node:child_process";

// Every package the miniapp/engine pipelines publish under the channel scheme,
// name -> manifest path. EXPLICIT list, not a glob: the workspace also holds
// private packages (cloud-runtime, cloud-shared) that must never be
// channel-derived. @mentra/bluetooth-sdk follows the same channel derivation
// but through its OWN pipeline (bluetooth-sdk-release.yml, prod branch
// main-bluetooth-sdk) and nothing here ranges on it (the engine peers it at
// "*"), so it stays out of this map.
export const CHANNEL_MANIFESTS = {
  "@mentra/miniapp": "mobile/modules/miniapp/package.json",
  "@mentra/miniapp-cli": "sdk/miniapp-cli/package.json",
  "create-mentra-miniapp": "sdk/create-mentra-miniapp/package.json",
  "@mentra/auth": "cloud-v2/packages/auth/package.json",
  "@mentra/cli": "cloud-v2/packages/cli/package.json",
  "@mentra/jspolyfill": "mobile/modules/jspolyfill/package.json",
  "@mentra/crust": "mobile/modules/crust/package.json",
  "@mentra/cloud-protocol": "cloud-v2/packages/protocol/package.json",
  "@mentra/cloud-client": "cloud-v2/packages/cloud-client/package.json",
  "@mentra/engine": "mobile/modules/engine/package.json",
};

const CHANNELS = {
  dev: {label: "dev", tag: "dev"},
  staging: {label: "beta", tag: "beta"},
  main: {label: null, tag: "latest"},
};

// The Bluetooth SDK promotes through its OWN prod branch instead of main, so
// SDK public releases trigger independently of the monorepo's main promotions.
// A separate map (not an extra entry in CHANNELS) so the miniapp/engine
// pipelines keep REJECTING a stray dispatch on main-bluetooth-sdk — and the
// SDK pipeline rejects one on main.
export const BLUETOOTH_SDK_CHANNELS = {
  dev: CHANNELS.dev,
  staging: CHANNELS.staging,
  "main-bluetooth-sdk": {label: null, tag: "latest"},
};

const BASE_RE = /^(\d+\.\d+\.\d+)-[0-9a-z]+\.(\d+)$/i;

export function channelFor(branch, channels = CHANNELS) {
  const channel = channels[branch];
  if (!channel) {
    throw new Error(
      `No npm release channel for branch "${branch}" — this pipeline releases from: ${Object.keys(channels).join(", ")}.`,
    );
  }
  return channel;
}

// 0.1.0-dev.3 on staging -> 0.1.0-beta.3; on main -> 0.1.0.
export function deriveVersion(baseVersion, branch, channels = CHANNELS) {
  const match = BASE_RE.exec(baseVersion);
  if (!match) {
    throw new Error(
      `Base version "${baseVersion}" must be a X.Y.Z-<label>.N prerelease — the branch decides ` +
        `the published label (dev/beta/none), git only holds the base.`,
    );
  }
  const [, core, n] = match;
  const {label} = channelFor(branch, channels);
  return label ? `${core}-${label}.${n}` : core;
}

// The range a sibling package's manifest should carry for `name` on this
// channel. Caret over the derived version: on main that floats patches
// (^0.1.0); on prerelease channels it pins the exact tuple (prerelease carets
// only match their own patch tuple), which is what makes the published set
// self-consistent.
export function deriveRange(baseVersion, branch, channels = CHANNELS) {
  return `^${deriveVersion(baseVersion, branch, channels)}`;
}

// Registry state, E404-strict: a 404 is the ONLY signal that a package is
// absent; any other npm failure (5xx, network, auth) throws rather than being
// read as "absent". Returns null when the package does not exist, else the
// array of published versions.
export function publishedVersions(name) {
  let out;
  try {
    out = execFileSync(
      "npm",
      ["view", name, "versions", "--json", "--registry=https://registry.npmjs.org"],
      {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]},
    );
  } catch (err) {
    const text = `${err.stdout || ""}${err.stderr || ""}`;
    if (/"code": *"E404"/.test(text) || /code E404/.test(text)) return null;
    throw new Error(`npm view ${name} failed with a non-404 error — refusing to guess registry state:\n${text}`);
  }
  const parsed = JSON.parse(out);
  // npm view returns a bare string when exactly one version exists.
  return Array.isArray(parsed) ? parsed : [parsed];
}
