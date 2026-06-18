#!/usr/bin/env bun

import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  createApp,
  createRelease,
  deleteApp,
  listApps,
  listReleases,
  pollLoginToken,
  startLogin,
  submitRelease,
} from "./api";
import { getConfig } from "./config";
import { clearCredentials, loadCredentials, saveCredentials, type CliCredentials } from "./credentials";
import { openBrowser } from "./open-browser";

const program = new Command();

program
  .name("mentra")
  .description("Mentra developer CLI")
  .version("2.0.0-alpha.0");

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
            : undefined;
        const storage = await saveCredentials({
          token: token.access_token,
          refreshToken: token.refresh_token,
          workosUserId: token.user.id,
          email: token.user.email,
          organizationId: token.organization_id,
          authenticationMethod: token.authentication_method,
          coreUrl: config.coreUrl,
          storedAt: storedAt.toISOString(),
          expiresAt: expiresAt?.toISOString(),
        });
        console.log(`Signed in as ${token.user.email}`);
        if (token.organization_id) console.log(`Organization: ${token.organization_id}`);
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
    const creds = await loadCredentials();
    if (!creds) {
      console.error("Not signed in. Run `mentra login`.");
      process.exitCode = 1;
      return;
    }

    console.log(`Email: ${creds.email}`);
    console.log(`WorkOS user: ${creds.workosUserId}`);
    if (creds.organizationId) console.log(`Organization: ${creds.organizationId}`);
    console.log(`Core: ${creds.coreUrl}`);
    if (creds.expiresAt) console.log(`Expires: ${new Date(creds.expiresAt).toLocaleString()}`);
  });

const miniapps = program.command("miniapps").description("Manage miniapp package records");

miniapps
  .command("list")
  .description("List miniapps owned by the current developer org")
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
  .action(async (packageName: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { releases: releaseList } = await listReleases(creds, packageName);
      if (releaseList.length === 0) {
        console.log("No releases yet.");
        return;
      }

      for (const release of releaseList) {
        const size = release.bundleSizeBytes ? `${Math.round(release.bundleSizeBytes / 1024)} KB` : "no bundle";
        console.log(`${release.version}\t${release.status}\t${size}\t${release.bundleSha256 ?? "no hash"}`);
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
      console.log(`Submitted ${packageName}@${release.version} for review`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("publish")
  .description("Build, pack, and upload the current miniapp release bundle")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .option("--no-build", "skip running bun run build before packing")
  .option("--no-pack", "skip running bun run pack and upload the existing build zip")
  .action(async (options: { cwd: string; build: boolean; pack: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    const cwd = resolve(options.cwd);
    try {
      const manifest = readManifest(cwd);
      const packageName = stringField(manifest, "packageName");
      const version = stringField(manifest, "version");
      const name = stringField(manifest, "name") || packageName;
      const description = typeof manifest.description === "string" ? manifest.description : null;

      await createApp(creds, { packageName, displayName: name, description });

      if (options.build) await runScript(cwd, "build");
      if (options.pack) await runScript(cwd, "pack");

      const zipPath = join(cwd, "build", `${packageName}-${version}.zip`);
      if (!existsSync(zipPath)) {
        throw new Error(`Release bundle not found: ${zipPath}`);
      }
      const bundle = readFileSync(zipPath);
      const { release } = await createRelease(creds, {
        packageName,
        version,
        manifest,
        bundleBase64: bundle.toString("base64"),
        fileName: basename(zipPath),
      });
      const submitted = await submitRelease(creds, {
        packageName,
        releaseId: release.id,
      });
      const sizeKb = Math.round(statSync(zipPath).size / 1024);
      console.log(`Published ${packageName}@${release.version}`);
      console.log(`Release: ${submitted.release.status}`);
      console.log(`Bundle: ${basename(zipPath)} (${sizeKb} KB)`);
      if (release.bundleSha256) console.log(`SHA-256: ${release.bundleSha256}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("logout")
  .description("Clear the current CLI login")
  .action(async () => {
    await clearCredentials();
    console.log("Logged out");
  });

program.parse();

async function requireCredentials(): Promise<CliCredentials | null> {
  const creds = await loadCredentials();
  if (!creds) {
    console.error("Not signed in. Run `mentra login`.");
    process.exitCode = 1;
    return null;
  }
  return creds;
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

async function runScript(cwd: string, script: "build" | "pack"): Promise<void> {
  const proc = Bun.spawn(["bun", "run", script], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`bun run ${script} failed with exit code ${exitCode}`);
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
