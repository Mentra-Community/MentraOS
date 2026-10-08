#!/usr/bin/env bun

import { Command } from "commander";
import {
  buildProduction as buildMiniappProduction,
  createAndSavePackageSigningKey,
  dev as devMiniapp,
  exportPackageSigningKey,
  importPackageSigningKey,
  loadPackageSigningKey,
  pack as packMiniapp,
  publisherKeyFingerprint,
} from "@mentra/miniapp-cli";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  createApp,
  createRelease,
  createWorkspace,
  deleteApp,
  getAdminMe,
  getConsoleSession,
  listApps,
  listReleases,
  pollLoginToken,
  publishRelease,
  readPublishingProfile,
  refreshLoginToken,
  resolveWorkspaceId,
  setPackagePrefix,
  startLogin,
  submitRelease,
  type CliWorkspace,
  type ConsoleSessionResponse,
} from "./api";
import { getConfig } from "./config";
import { clearCredentials, loadCredentials, saveCredentials, type CliCredentials } from "./credentials";
import { openBrowser } from "./open-browser";
import { verifyPackedBundle } from "./validate-bundle";
import { registerStoreCommands } from "./store-commands";

const program = new Command();
const CLI_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

program.name("mentra").description("Mentra developer CLI").version(CLI_VERSION)
  .option("--store-url <url>", "use an explicit local or self-hosted Store")
  .hook("preAction", command => {
    const storeUrl = command.opts().storeUrl;
    if (storeUrl) process.env.MENTRA_STORE_URL = storeUrl;
  });

program
  .command("login")
  .description("Sign in to Mentra Developer Console")
  .option("--no-open", "print the login URL without opening a browser")
  .action(async (options: { open: boolean }) => {
    const config = getConfig();
    let challenge;
    try {
      challenge = await startLogin(config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }

    console.log("Sign in to Mentra Developer Console");
    console.log("");
    console.log(`Open: ${challenge.verification_uri_complete}`);
    console.log(`Code: ${challenge.user_code}`);
    console.log("");

    if (options.open) {
      const opened = await openBrowser(challenge.verification_uri_complete);
      if (!opened) console.log("Could not open a browser automatically.");
    }

    const deadline = Date.now() + challenge.expires_in * 1000;
    process.stdout.write("Waiting for browser approval");

    while (Date.now() < deadline) {
      const token = await pollLoginToken(config, challenge.device_code);
      if ("status" in token) {
        if (token.status === "slow_down") {
          await sleep(challenge.interval * 1000);
        }
      } else {
        process.stdout.write("\n");
        const storedAt = new Date();
        const expiresAt =
          typeof token.expires_in === "number"
            ? new Date(storedAt.getTime() + token.expires_in * 1000)
            : expiresAtFromToken(token.access_token)
              ? new Date(expiresAtFromToken(token.access_token)! * 1000)
              : undefined;
        const credentials: CliCredentials = {
          token: token.access_token,
          refreshToken: token.refresh_token,
          workosUserId: token.user.id,
          email: token.user.email,
          organizationId: token.organization_id,
          authenticationMethod: token.authentication_method,
          storeUrl: config.storeUrl,
          storedAt: storedAt.toISOString(),
          expiresAt: expiresAt?.toISOString(),
        };
        let availableWorkspaceCount = 0;
        try {
          const session = await getConsoleSession(credentials);
          availableWorkspaceCount = session.workspaces.length;
          credentials.workspaceId =
            session.activeWorkspaceId ?? (session.workspaces.length === 1 ? session.workspaces[0]!.workspaceId : null);
        } catch {
          // Authentication still succeeded. The first Store command will report
          // any connectivity or workspace-selection problem explicitly.
        }
        const storage = await saveCredentials(credentials);
        console.log(`Signed in as ${token.user.email}`);
        if (token.organization_id) console.log(`WorkOS organization: ${token.organization_id}`);
        if (credentials.workspaceId) console.log(`Workspace: ${credentials.workspaceId}`);
        if (availableWorkspaceCount > 1 && !credentials.workspaceId) {
          console.log("Multiple workspaces are available. Run `mentra workspace list`, then `mentra workspace use <id>`.");
        }
        console.log(`Credentials stored in ${storage === "keychain" ? "OS keychain" : "~/.mentra/cli-v2"}`);
        return;
      }

      process.stdout.write(".");
      await sleep(challenge.interval * 1000);
    }

    process.stdout.write("\n");
    console.error("Login timed out. Run `mentra login` to try again.");
    process.exitCode = 1;
  });

program
  .command("whoami")
  .description("Show the current CLI login")
  .action(async () => {
    const config = getConfig();
    const creds = await loadFreshCredentials(config);
    if (!creds) {
      console.error("Not signed in. Run `mentra login`.");
      process.exitCode = 1;
      return;
    }

    console.log(`Email: ${creds.email}`);
    console.log(`WorkOS user: ${creds.workosUserId}`);
    if (creds.organizationId) console.log(`WorkOS organization: ${creds.organizationId}`);
    if (creds.workspaceId) console.log(`Workspace: ${creds.workspaceId}`);
    console.log(`Store: ${creds.storeUrl}`);
    if (creds.expiresAt) console.log(`Expires: ${new Date(creds.expiresAt).toLocaleString()}`);
  });

const workspace = program.command("workspace").description("Manage the active workspace");

workspace
  .command("list")
  .description("List workspaces available to this account")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const session = await getConsoleSession(creds);
      if (session.workspaces.length === 0) {
        console.log("No workspaces yet. Create one with `mentra workspace create <name>`.");
        return;
      }
      const activeId = creds.workspaceId ?? session.activeWorkspaceId;
      for (const entry of session.workspaces) {
        console.log(`${entry.workspaceId === activeId ? "*" : " "} ${entry.workspaceId}\t${entry.name}\t${entry.membership.role}`);
      }
    } catch (error) {
      fail(error);
    }
  });

workspace
  .command("use")
  .argument("<workspaceId>", "workspace id from `mentra workspace list`")
  .description("Select the workspace used by future CLI commands")
  .action(async (workspaceId: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const session = await getConsoleSession(creds);
      const selected = session.workspaces.find(candidate => candidate.workspaceId === workspaceId);
      if (!selected) throw new Error("You do not have access to that workspace");
      await saveCredentials({...creds, workspaceId: selected.workspaceId});
      console.log(`Using ${selected.name} (${selected.workspaceId})`);
    } catch (error) {
      fail(error);
    }
  });

workspace
  .command("show")
  .description("Show the active workspace and its publishing profile")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const session = await getConsoleSession(creds);
      const active = activeWorkspace(creds, session);
      if (!active) {
        if (creds.workspaceId) {
          throw new Error(`Workspace ${creds.workspaceId} is not available to this account. Run \`mentra workspace list\`, then \`mentra workspace use <id>\`.`);
        }
        console.log("No workspace selected. Run `mentra workspace list`, then `mentra workspace use <id>`, or create one with `mentra workspace create <name>`.");
        return;
      }

      console.log(`Workspace: ${active.name} (${active.workspaceId})`);
      console.log(`Role: ${active.membership.role}`);
      const profile = await readPublishingProfile({...creds, workspaceId: active.workspaceId});
      if (profile.state === "hidden") {
        console.log("Package prefix: not visible to your role");
      } else if (profile.state === "not_set" || !profile.profile.packagePrefix) {
        console.log("Package prefix: not set");
        console.log(
          "Set one with `mentra workspace set-prefix <prefix>` (for example com.example) or in the Developer Console.",
        );
      } else {
        console.log(`Package prefix: ${profile.profile.packagePrefix}`);
        console.log(`Prefix status: ${profile.profile.packagePrefixStatus}`);
      }
    } catch (error) {
      fail(error);
    }
  });

workspace
  .command("set-prefix")
  .argument("<prefix>", "package prefix for the workspace's miniapps, e.g. com.example")
  .description("Set the package prefix of the active workspace")
  .action(async (prefix: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const workspaceId = await resolveWorkspaceId(creds);
      const profile = await setPackagePrefix({...creds, workspaceId}, prefix);
      console.log(`Package prefix: ${profile.packagePrefix} (${profile.packagePrefixStatus})`);
    } catch (error) {
      fail(error);
    }
  });

workspace
  .command("create")
  .argument("<name>", "workspace name")
  .option("--package-prefix <prefix>", "package prefix for the workspace's miniapps, e.g. com.example")
  .description("Create a workspace and make it the active one")
  .action(async (name: string, options: { packagePrefix?: string }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const created = await createWorkspace(creds, name);
      // Selected before the prefix is set, so a refused prefix still leaves the new workspace active.
      const next = {...creds, workspaceId: created.workspaceId};
      await saveCredentials(next);
      console.log(`Workspace created: ${created.name} (${created.workspaceId})`);
      if (options.packagePrefix) {
        try {
          const profile = await setPackagePrefix(next, options.packagePrefix);
          console.log(`Package prefix: ${profile.packagePrefix} (${profile.packagePrefixStatus})`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`The workspace was created and selected, but its package prefix was not set: ${reason}`);
        }
      }
    } catch (error) {
      fail(error);
    }
  });

const miniapps = program.command("miniapps").description("Manage miniapp package records");

const miniappKeys = miniapps.command("keys").description("Manage durable publisher signing keys");

miniappKeys
  .command("create")
  .requiredOption("--package <packageName>", "package name")
  .description("Create a package-scoped publisher signing key")
  .action(async (options: { package: string }) => {
    try {
      const { key, storage } = await createAndSavePackageSigningKey(options.package);
      console.log(`Publisher key: ${publisherKeyFingerprint(key.publicKeyJwk)}`);
      console.log(`Stored in: ${storage === "keychain" ? "OS keychain" : "~/.mentra/cli-v2"}`);
      console.log("Back this key up before publishing. Losing it prevents future updates.");
    } catch (error) {
      fail(error);
    }
  });

miniappKeys
  .command("show")
  .requiredOption("--package <packageName>", "package name")
  .description("Show the package publisher key fingerprint")
  .action(async (options: { package: string }) => {
    try {
      const key = await loadPackageSigningKey(options.package);
      if (!key) throw new Error(`No publisher signing key exists for ${options.package}`);
      console.log(publisherKeyFingerprint(key.publicKeyJwk));
    } catch (error) {
      fail(error);
    }
  });

miniappKeys
  .command("import")
  .argument("<path>", "publisher key backup")
  .requiredOption("--package <packageName>", "package name")
  .option("--replace", "replace a different locally stored key")
  .description("Import a package publisher signing key")
  .action(async (path: string, options: { package: string; replace?: boolean }) => {
    try {
      const { key, storage } = await importPackageSigningKey(options.package, path, { overwrite: options.replace });
      console.log(`Imported ${publisherKeyFingerprint(key.publicKeyJwk)} into ${storage}`);
    } catch (error) {
      fail(error);
    }
  });

miniappKeys
  .command("export")
  .argument("<path>", "new backup file path")
  .requiredOption("--package <packageName>", "package name")
  .description("Export a package publisher signing key backup")
  .action(async (path: string, options: { package: string }) => {
    try {
      console.log(`Exported private publisher key to ${await exportPackageSigningKey(options.package, path)}`);
      console.log("Keep this file secret and store it in your organization's secure backup system.");
    } catch (error) {
      fail(error);
    }
  });

miniapps
  .command("list")
  .description("List miniapps owned by the active workspace")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { apps: appList } = await listApps(creds);
      if (appList.length === 0) {
        console.log("No miniapps yet.");
        return;
      }

      for (const app of appList) {
        const release = app.activeRelease ?? app.latestRelease;
        const releaseLabel = release ? `${release.version} (${release.status})` : "no releases";
        console.log(`${app.packageName}\t${app.name}\t${app.status}\t${releaseLabel}`);
      }
    } catch (error) {
      fail(error);
    }
  });

miniapps
  .command("create")
  .argument("<packageName>", "stable package name, e.g. com.mentra.myminiapp")
  .requiredOption("--name <name>", "display name")
  .option("--description <description>", "short miniapp description")
  .description("Reserve a miniapp package name")
  .action(async (packageName: string, options: { name: string; description?: string }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { app } = await createApp(creds, {
        packageName,
        displayName: options.name,
        description: options.description ?? null,
      });
      console.log(`Miniapp ready: ${app.packageName} (${app.name})`);
    } catch (error) {
      fail(error);
    }
  });

miniapps
  .command("delete")
  .argument("<packageName>", "package name to archive")
  .description("Archive a miniapp package record")
  .action(async (packageName: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      await deleteApp(creds, packageName);
      console.log(`Archived ${packageName}`);
    } catch (error) {
      fail(error);
    }
  });

const releases = program.command("releases").description("Inspect miniapp releases");

releases
  .command("list")
  .argument("<packageName>", "package name")
  .description("List releases for a miniapp")
  .option("--json", "print machine-readable JSON")
  .action(async (packageName: string, options: { json?: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { releases: releaseList } = await listReleases(creds, packageName);
      if (options.json) {
        console.log(JSON.stringify({ releases: releaseList }, null, 2));
        return;
      }
      if (releaseList.length === 0) {
        console.log("No releases yet.");
        return;
      }

      for (const release of releaseList) {
        const size = release.bundleSizeBytes ? `${Math.round(release.bundleSizeBytes / 1024)} KB` : "no bundle";
        console.log(`${release.version}\t${release.releaseTrack}\t${release.status}\t${size}\t${release.bundleSha256 ?? "no hash"}`);
        if (release.reviewNotes) console.log(`  Review: ${release.reviewNotes}`);
      }
    } catch (error) {
      fail(error);
    }
  });

releases
  .command("status")
  .argument("<packageName>", "package name")
  .argument("[releaseId]", "release id; defaults to the latest release")
  .option("--json", "print machine-readable JSON")
  .description("Show release state and review feedback")
  .action(async (packageName: string, releaseId: string | undefined, options: { json?: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;
    try {
      const { releases: releaseList } = await listReleases(creds, packageName);
      const release = releaseId ? releaseList.find(item => item.id === releaseId) : releaseList[0];
      if (!release) throw new Error(releaseId ? `Release not found: ${releaseId}` : `No releases for ${packageName}`);
      if (options.json) console.log(JSON.stringify({ release }, null, 2));
      else {
        console.log(`${packageName}@${release.version}`);
        console.log(`Status: ${release.status}`);
        console.log(`Track: ${release.releaseTrack}`);
        console.log(`Release: ${release.id}`);
        if (release.reviewNotes) console.log(`Review: ${release.reviewNotes}`);
        if (release.bundleSha256) console.log(`Bundle SHA-256: ${release.bundleSha256}`);
        if (release.manifestSha256) console.log(`Manifest SHA-256: ${release.manifestSha256}`);
      }
    } catch (error) {
      fail(error);
    }
  });

releases
  .command("submit")
  .argument("<packageName>", "package name")
  .argument("<releaseId>", "release id")
  .description("Submit an uploaded release for admin review")
  .action(async (packageName: string, releaseId: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { release } = await submitRelease(creds, { packageName, releaseId });
      console.log(`Submitted ${packageName}@${release.version} (${release.releaseTrack}) for review`);
    } catch (error) {
      fail(error);
    }
  });

const admin = program.command("admin").description("Internal Mentra admin operations");

admin
  .command("me")
  .description("Show the current admin identity")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const me = await getAdminMe(creds);
      console.log(`Admin: ${me.user?.email ?? "unknown"}`);
      console.log(`Store: ${creds.storeUrl}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("dev")
  .description("Start the local miniapp dev server; the phone runs it under the manifest package name")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .option("--usb", "reach the phone over USB via adb reverse instead of the LAN (Android only)")
  .option("--device <serial>", "target a specific adb device serial (use with --usb)")
  .action(async (options: { cwd: string; usb?: boolean; device?: string }) => {
    try {
      // Local only: the phone treats the build as its package, refuses it over
      // an install signed by a publisher, and requests miniapp tokens itself.
      await devMiniapp({ cwd: resolve(options.cwd), usb: options.usb, device: options.device });
    } catch (error) {
      fail(error);
    }
  });

program
  .command("build")
  .description("Build the current miniapp")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .action(async (options: { cwd: string }) => {
    try {
      await buildMiniappProduction(resolve(options.cwd));
    } catch (error) {
      fail(error);
    }
  });

program
  .command("pack")
  .description("Pack the current miniapp into build/<packageName>-<version>.zip")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .option("--no-build", "skip production build before packing")
  .option("--sign", "sign with the stored publisher key (unsigned by default)")
  .option("--signing-key <path>", "publisher signing key file (CI/non-persistent use)")
  .action(async (options: { cwd: string; build: boolean; sign?: boolean; signingKey?: string }) => {
    try {
      await packMiniapp({
        cwd: resolve(options.cwd),
        build: options.build,
        sign: options.sign,
        signingKeyPath: options.signingKey,
      });
    } catch (error) {
      fail(error);
    }
  });

program
  .command("publish")
  .description("Build and upload the current miniapp release bundle to the Store without signing")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .option("--no-build", "skip running bun run build before packing")
  .option("--no-pack", "skip running bun run pack and upload the existing build zip")
  .option("--no-submit", "upload as draft without submitting for review")
  .option("--publish", "also publish; requires an approved release or an app publishing token")
  .option("--skip-existing", "skip published versions and safely resume matching unfinished uploads")
  .option("--track <track>", "release track: stable or beta", "stable")
  .option("--json", "print machine-readable JSON")
  .action(async (options: {
    cwd: string;
    build: boolean;
    pack: boolean;
    submit: boolean;
    publish?: boolean;
    skipExisting?: boolean;
    track: string;
    json?: boolean;
  }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    const cwd = resolve(options.cwd);
    try {
      if (options.track !== "stable" && options.track !== "beta") {
        throw new Error("--track must be either stable or beta");
      }
      if (options.publish && !options.submit) throw new Error("--publish cannot be combined with --no-submit");
      const manifest = readManifest(cwd);
      const packageName = stringField(manifest, "packageName");
      const version = stringField(manifest, "version");
      const name = stringField(manifest, "name") || packageName;
      const description = typeof manifest.description === "string" ? manifest.description : null;

      await ensureMiniappRecord(creds, { packageName, displayName: name, description });

      const existing = options.skipExisting
        ? (await listReleases(creds, packageName)).releases.find(release => release.version === version && release.releaseTrack === options.track)
        : undefined;
      if (existing?.status === "published") {
        if (options.json) console.log(JSON.stringify({release: existing, skipped: true}, null, 2));
        else console.log(`Skipped ${packageName}@${version}: already published`);
        return;
      }
      if (existing && !["draft", "submitted", "in_review", "accepted"].includes(existing.status)) {
        throw new Error(`Existing release is ${existing.status}; resolve it before retrying or bump the version`);
      }

      // An unfinished immutable release must resume from its original ZIP.
      // Repacking first can destroy the only local copy of those exact bytes.
      if (!existing && options.pack) {
        await packMiniapp({
          cwd,
          build: options.build,
          silent: options.json,
          sign: false,
        });
      } else if (!existing && options.build) {
        await buildMiniappProduction(cwd, { silent: options.json });
      }

      const zipPath = join(cwd, "build", `${packageName}-${version}.zip`);
      if (!existsSync(zipPath)) {
        throw new Error(`Release bundle not found: ${zipPath}`);
      }
      const bundle = readFileSync(zipPath);
      const verifiedBundle = await verifyPackedBundle(bundle, manifest);
      if (existing && existing.bundleSha256 !== createHash("sha256").update(bundle).digest("hex")) {
        throw new Error("This version already has different bundle bytes. Retry with the original ZIP or bump miniapp.json version.");
      }
      const { release } = existing ? {release: existing} : await createRelease(creds, {
        packageName,
        version,
        releaseTrack: options.track,
        manifest,
        bundle,
        fileName: basename(zipPath),
      });
      let submitted = options.submit && release.status === "draft"
        ? await submitRelease(creds, { packageName, releaseId: release.id })
        : { release };
      if (options.publish && submitted.release.status !== "published") {
        submitted = await publishRelease(creds, packageName, release.id);
      }
      const sizeKb = Math.round(statSync(zipPath).size / 1024);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              release: submitted.release,
              bundle: basename(zipPath),
              publisherKeyFingerprint: verifiedBundle.publisherKeyFingerprint ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Uploaded ${packageName}@${release.version}`);
      console.log(`Status: ${submitted.release.status}`);
      console.log(`Track: ${submitted.release.releaseTrack}`);
      console.log(`Bundle: ${basename(zipPath)} (${sizeKb} KB)`);
      console.log(`Publisher key: ${verifiedBundle.publisherKeyFingerprint ?? "unsigned"}`);
      if (release.bundleSha256) console.log(`SHA-256: ${release.bundleSha256}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("logout")
  .description("Clear the current CLI login")
  .action(async () => {
    await clearCredentials(getConfig().storeUrl);
    console.log("Logged out");
  });

registerStoreCommands(program, requireCredentials);
await program.parseAsync();

async function requireCredentials(): Promise<CliCredentials | null> {
  const config = getConfig();
  const creds = await loadFreshCredentials(config);
  if (!creds) {
    console.error("Not signed in. Run `mentra login`.");
    process.exitCode = 1;
    return null;
  }
  return creds;
}

async function loadFreshCredentials(config = getConfig()): Promise<CliCredentials | null> {
  const creds = await loadCredentials(config.storeUrl);
  if (!creds) return null;
  if (!shouldRefresh(creds)) return creds;

  if (!creds.refreshToken) {
    console.error("Session expired. Run `mentra login`.");
    process.exitCode = 1;
    return null;
  }

  try {
    const refreshed = await refreshLoginToken(
      {...config, storeUrl: creds.storeUrl},
      creds.refreshToken,
      creds.organizationId,
    );
    const storedAt = new Date();
    const expiresAt =
      typeof refreshed.expires_in === "number"
        ? new Date(storedAt.getTime() + refreshed.expires_in * 1000)
        : expiresAtFromToken(refreshed.access_token)
          ? new Date(expiresAtFromToken(refreshed.access_token)! * 1000)
          : undefined;
    const nextCredentials: CliCredentials = {
      token: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? creds.refreshToken,
      workosUserId: refreshed.user.id,
      email: refreshed.user.email,
      organizationId: refreshed.organization_id,
      workspaceId: creds.workspaceId,
      authenticationMethod: refreshed.authentication_method ?? creds.authenticationMethod,
      storeUrl: creds.storeUrl,
      storedAt: storedAt.toISOString(),
      expiresAt: expiresAt?.toISOString(),
    };
    await saveCredentials(nextCredentials);
    return {...nextCredentials, storeUrl: creds.storeUrl};
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return null;
  }
}

function shouldRefresh(creds: CliCredentials): boolean {
  const expiresAtMs = creds.expiresAt ? Date.parse(creds.expiresAt) : expiresAtFromToken(creds.token) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return false;
  return expiresAtMs - Date.now() < 60_000;
}

function expiresAtFromToken(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

function readManifest(cwd: string): Record<string, unknown> {
  const path = join(cwd, "miniapp.json");
  if (!existsSync(path)) throw new Error(`miniapp.json not found in ${cwd}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("miniapp.json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(manifest: Record<string, unknown>, field: string): string {
  const value = manifest[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`miniapp.json is missing string field "${field}"`);
  }
  return value.trim();
}

async function ensureMiniappRecord(
  creds: CliCredentials,
  input: { packageName: string; displayName: string; description?: string | null },
): Promise<void> {
  try {
    await createApp(creds, input);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("package name is already claimed")) {
      throw error;
    }
  }

  const { apps } = await listApps(creds);
  const existing = apps.find(app => app.packageName === input.packageName && app.status !== "archived");
  if (!existing) {
    throw new Error(`Package ${input.packageName} is already claimed by another workspace.`);
  }
}

/** The workspace commands act in: the saved selection, else the Store's active one, else the account's only one. */
function activeWorkspace(creds: CliCredentials, session: ConsoleSessionResponse): CliWorkspace | null {
  const id =
    creds.workspaceId ??
    session.activeWorkspaceId ??
    (session.workspaces.length === 1 ? session.workspaces[0]!.workspaceId : null);
  return session.workspaces.find(candidate => candidate.workspaceId === id) ?? null;
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
