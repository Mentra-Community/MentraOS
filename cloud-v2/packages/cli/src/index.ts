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
import {
  createApp,
  createRelease,
  deleteApp,
  getAdminMe,
  getConsoleSession,
  getOrg,
  listApps,
  listReleases,
  pollLoginToken,
  refreshLoginToken,
  startLogin,
  submitRelease,
  upsertOrg,
} from "./api";
import { getConfig } from "./config";
import { clearCredentials, loadCredentials, saveCredentials, type CliCredentials } from "./credentials";
import { openBrowser } from "./open-browser";
import { encodeDevAttestation, ensureSigningKey, signDevAttestation } from "./signing";
import { verifyPackedBundle } from "./validate-bundle";

const program = new Command();
const CLI_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

program.name("mentra").description("Mentra developer CLI").version(CLI_VERSION);

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
          coreUrl: config.coreUrl,
          storeUrl: config.storeUrl,
          storedAt: storedAt.toISOString(),
          expiresAt: expiresAt?.toISOString(),
        };
        let availableOrgCount = 0;
        try {
          const session = await getConsoleSession(credentials);
          availableOrgCount = session.organizations.length;
          credentials.developerOrgId = session.organizationId ?? session.organizations[0]?.id ?? null;
          if (session.organizations.length > 1 && !session.organizationId) credentials.developerOrgId = null;
        } catch {
          // Authentication still succeeded. The first Core command will report
          // any connectivity or organization-selection problem explicitly.
        }
        const storage = await saveCredentials(credentials);
        console.log(`Signed in as ${token.user.email}`);
        if (token.organization_id) console.log(`Organization: ${token.organization_id}`);
        if (credentials.developerOrgId) console.log(`Developer org: ${credentials.developerOrgId}`);
        if (availableOrgCount > 1 && !credentials.developerOrgId) {
          console.log("Multiple developer orgs are available. Run `mentra org list`, then `mentra org use <org-id>`.");
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
    if (creds.organizationId) console.log(`Organization: ${creds.organizationId}`);
    if (creds.developerOrgId) console.log(`Developer org: ${creds.developerOrgId}`);
    console.log(`Core: ${config.coreUrl}`);
    console.log(`Store: ${config.storeUrl}`);
    if (creds.expiresAt) console.log(`Expires: ${new Date(creds.expiresAt).toLocaleString()}`);
  });

const org = program.command("org").description("Manage the current developer organization");

org
  .command("list")
  .description("List developer organizations available to this account")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const session = await getConsoleSession(creds);
      if (session.organizations.length === 0) {
        console.log("No developer organizations yet.");
        return;
      }
      for (const developerOrg of session.organizations) {
        const selected = developerOrg.id === creds.developerOrgId || developerOrg.id === session.organizationId;
        console.log(`${selected ? "*" : " "} ${developerOrg.id}\t${developerOrg.name}\t${developerOrg.packagePrefix}`);
      }
    } catch (error) {
      fail(error);
    }
  });

org
  .command("use")
  .argument("<organizationId>", "developer organization id from `mentra org list`")
  .description("Select the developer organization used by future CLI commands")
  .action(async (organizationId: string) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const session = await getConsoleSession(creds);
      const developerOrg = session.organizations.find(candidate => candidate.id === organizationId);
      if (!developerOrg) throw new Error("You do not have access to that developer organization");
      await saveCredentials({...creds, developerOrgId: developerOrg.id});
      console.log(`Using ${developerOrg.name} (${developerOrg.id})`);
    } catch (error) {
      fail(error);
    }
  });

org
  .command("show")
  .description("Show the current developer organization")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { org: developerOrg } = await getOrg(creds);
      if (!developerOrg) {
        console.log('No developer org selected. Run `mentra org list`, or create one with `mentra org init --new`.');
        return;
      }

      console.log(`Name: ${developerOrg.name}`);
      console.log(`Package prefix: ${developerOrg.packagePrefix}`);
      console.log(`Prefix status: ${developerOrg.packagePrefixStatus}`);
      if (developerOrg.workosOrgId) console.log(`WorkOS org: ${developerOrg.workosOrgId}`);
    } catch (error) {
      fail(error);
    }
  });

org
  .command("init")
  .description("Create or update the current developer organization")
  .requiredOption("--name <name>", "organization display name")
  .requiredOption("--prefix <prefix>", "package prefix, e.g. com.example")
  .option("--new", "create another organization instead of updating the selected organization")
  .action(async (options: { name: string; prefix: string; new?: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { org: developerOrg } = await upsertOrg(creds, {
        displayName: options.name,
        packagePrefix: options.prefix,
        createNew: options.new === true,
      });
      await saveCredentials({...creds, developerOrgId: developerOrg.id});
      console.log(`Developer org ready: ${developerOrg.name}`);
      console.log(`Package prefix: ${developerOrg.packagePrefix} (${developerOrg.packagePrefixStatus})`);
      if (developerOrg.workosOrgId) console.log(`WorkOS org: ${developerOrg.workosOrgId}`);
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
      console.log(`Core: ${creds.coreUrl}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("dev")
  .description("Start the local miniapp dev server with signed Cloud V2 identity when logged in")
  .option("--cwd <path>", "miniapp project directory", process.cwd())
  .option("--auth", "require signed dev auto-auth setup before starting")
  .action(async (options: { cwd: string; auth?: boolean }) => {
    const cwd = resolve(options.cwd);
    try {
      const manifest = readManifest(cwd);
      const packageName = stringField(manifest, "packageName");
      const name = stringField(manifest, "name") || packageName;
      const description = typeof manifest.description === "string" ? manifest.description : null;
      const creds = await loadFreshCredentials(getConfig());
      let signer: ((input: { packageName: string; devServerUrl: string }) => string) | undefined;

      if (creds) {
        await ensureMiniappRecord(creds, { packageName, displayName: name, description });
        const signingKey = await ensureSigningKey(creds);
        signer = ({ packageName: signedPackageName, devServerUrl }) =>
          encodeDevAttestation(
            signDevAttestation({
              signingKey,
              packageName: signedPackageName,
              devServerUrl,
            }),
          );
        console.log(`Dev auto-auth enabled for ${packageName}`);
      } else if (options.auth) {
        throw new Error("Not signed in. Run `mentra login` before `mentra dev --auth`.");
      } else {
        console.log("Dev auto-auth disabled. Run `mentra login` if this miniapp uses session.auth.");
      }

      await devMiniapp({ cwd, signDevAttestation: signer });
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
  .option("--signing-key <path>", "publisher signing key file (CI/non-persistent use)")
  .action(async (options: { cwd: string; build: boolean; signingKey?: string }) => {
    try {
      await packMiniapp({ cwd: resolve(options.cwd), build: options.build, signingKeyPath: options.signingKey });
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
  .option("--no-submit", "upload as draft without submitting for review")
  .option("--track <track>", "release track: stable or beta", "stable")
  .option("--signing-key <path>", "publisher signing key file (CI/non-persistent use)")
  .option("--json", "print machine-readable JSON")
  .action(async (options: {
    cwd: string;
    build: boolean;
    pack: boolean;
    submit: boolean;
    track: string;
    signingKey?: string;
    json?: boolean;
  }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    const cwd = resolve(options.cwd);
    try {
      if (options.track !== "stable" && options.track !== "beta") {
        throw new Error("--track must be either stable or beta");
      }
      const manifest = readManifest(cwd);
      const packageName = stringField(manifest, "packageName");
      const version = stringField(manifest, "version");
      const name = stringField(manifest, "name") || packageName;
      const description = typeof manifest.description === "string" ? manifest.description : null;

      await ensureMiniappRecord(creds, { packageName, displayName: name, description });

      if (options.pack) {
        await packMiniapp({
          cwd,
          build: options.build,
          silent: options.json,
          signingKeyPath: options.signingKey,
        });
      } else if (options.build) {
        await buildMiniappProduction(cwd, { silent: options.json });
      }

      const zipPath = join(cwd, "build", `${packageName}-${version}.zip`);
      if (!existsSync(zipPath)) {
        throw new Error(`Release bundle not found: ${zipPath}`);
      }
      const bundle = readFileSync(zipPath);
      const signedBundle = await verifyPackedBundle(bundle, manifest);
      const { release } = await createRelease(creds, {
        packageName,
        version,
        releaseTrack: options.track,
        manifest,
        bundle,
        fileName: basename(zipPath),
      });
      const submitted = options.submit
        ? await submitRelease(creds, { packageName, releaseId: release.id })
        : { release };
      const sizeKb = Math.round(statSync(zipPath).size / 1024);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              release: submitted.release,
              bundle: basename(zipPath),
              publisherKeyFingerprint: signedBundle.publisherKeyFingerprint,
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
      console.log(`Publisher key: ${signedBundle.publisherKeyFingerprint}`);
      if (release.bundleSha256) console.log(`SHA-256: ${release.bundleSha256}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("logout")
  .description("Clear the current CLI login")
  .action(async () => {
    await clearCredentials(getConfig().coreUrl);
    console.log("Logged out");
  });

program.parse();

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
  const creds = await loadCredentials(config.coreUrl);
  if (!creds) return null;
  if (!shouldRefresh(creds)) return creds;

  if (!creds.refreshToken) {
    console.error("Session expired. Run `mentra login`.");
    process.exitCode = 1;
    return null;
  }

  try {
    const refreshed = await refreshLoginToken(config, creds.refreshToken, creds.organizationId);
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
      developerOrgId: creds.developerOrgId,
      authenticationMethod: refreshed.authentication_method ?? creds.authenticationMethod,
      coreUrl: config.coreUrl,
      storeUrl: config.storeUrl,
      storedAt: storedAt.toISOString(),
      expiresAt: expiresAt?.toISOString(),
    };
    await saveCredentials(nextCredentials);
    return nextCredentials;
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
    throw new Error(`Package ${input.packageName} is already claimed by another developer org.`);
  }
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
