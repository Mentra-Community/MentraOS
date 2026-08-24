#!/usr/bin/env bun

import { Command } from "commander";
import { buildProduction as buildMiniappProduction, dev as devMiniapp, pack as packMiniapp } from "@mentra/miniapp-cli";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  createAdminRegistryRevision,
  createApp,
  createRelease,
  deleteApp,
  ensureAdminRegistry,
  getAdminMe,
  getOrg,
  listAdminPreinstallReleases,
  listAdminRegistries,
  listAdminRegistryRevisions,
  listApps,
  listReleases,
  promoteAdminRegistryRevision,
  pollLoginToken,
  refreshLoginToken,
  startLogin,
  submitRelease,
  upsertOrg,
  type AdminReleaseSummary,
  type AdminRegistry,
  type PreinstallEnvironment,
  type PreinstallPolicy,
} from "./api";
import { getConfig } from "./config";
import { clearCredentials, loadCredentials, saveCredentials, type CliCredentials } from "./credentials";
import { openBrowser } from "./open-browser";
import { encodeDevAttestation, ensureSigningKey, signBundleMetadata, signDevAttestation } from "./signing";
import { validatePackedBundle } from "./validate-bundle";

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
    console.log(`Core: ${config.coreUrl}`);
    if (creds.expiresAt) console.log(`Expires: ${new Date(creds.expiresAt).toLocaleString()}`);
  });

const org = program.command("org").description("Manage the current developer organization");

org
  .command("show")
  .description("Show the current developer organization")
  .action(async () => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { org: developerOrg } = await getOrg(creds);
      if (!developerOrg) {
        console.log('No developer org yet. Run `mentra org init --name "Your Org" --prefix com.example`.');
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
  .action(async (options: { name: string; prefix: string }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const { org: developerOrg } = await upsertOrg(creds, {
        displayName: options.name,
        packagePrefix: options.prefix,
      });
      console.log(`Developer org ready: ${developerOrg.name}`);
      console.log(`Package prefix: ${developerOrg.packagePrefix} (${developerOrg.packagePrefixStatus})`);
      if (developerOrg.workosOrgId) console.log(`WorkOS org: ${developerOrg.workosOrgId}`);
    } catch (error) {
      fail(error);
    }
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
        console.log(`${release.version}\t${release.status}\t${size}\t${release.bundleSha256 ?? "no hash"}`);
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
      console.log(`Submitted ${packageName}@${release.version} for review`);
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

const preinstall = admin.command("preinstall").description("Manage the internal preinstalled miniapp registry");

preinstall
  .command("releases")
  .description("List releases eligible for preinstall")
  .option("-e, --environment <environment>", "target registry environment")
  .option("--verbose", "include release ids")
  .action(async (options: { environment?: string; verbose?: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const environment = options.environment ? parseEnvironment(options.environment) : inferEnvironment(creds.coreUrl);
      const { releases: releaseList } = await listAdminPreinstallReleases(creds);
      if (releaseList.length === 0) {
        console.log("No publishable releases.");
        return;
      }
      const activeReleaseIds = await activePreinstallReleaseIds(creds, environment);
      const groups = groupAdminReleases(releaseList, activeReleaseIds);
      console.log(`Publishable miniapps for ${environment} preinstall:`);
      for (const group of groups) {
        console.log(formatAdminReleaseGroup(group));
        if (options.verbose) {
          for (const release of group.releases) {
            const marker = release.id === group.current?.id ? "*" : " ";
            console.log(`  ${marker} ${release.version}\t${release.status}\t${release.id}`);
          }
        }
      }
      console.log("");
      console.log("Publish with:");
      console.log(
        `  ${commandNameForCoreUrl(creds.coreUrl)} admin preinstall publish --release ${groups[0]?.packageName}@${groups[0]?.latest.version} --environment ${environment}`,
      );
    } catch (error) {
      fail(error);
    }
  });

preinstall
  .command("status")
  .description("Show the active preinstall registry for an environment")
  .option("-e, --environment <environment>", "target registry environment")
  .action(async (options: { environment?: string }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const environment = options.environment ? parseEnvironment(options.environment) : inferEnvironment(creds.coreUrl);
      const { registries } = await listAdminRegistries(creds);
      const registry = registries.find(item => item.environment === environment && item.name === "default");
      if (!registry) {
        console.log(`No active ${environment} preinstall registry.`);
        return;
      }

      console.log(`${environment} preinstall registry`);
      console.log(`Registry: ${registry.id}`);
      console.log(`Status: ${registry.status}`);
      if (!registry.activeRevisionId) {
        console.log("Active revision: none");
        return;
      }

      const { revisions } = await listAdminRegistryRevisions(creds, registry.id);
      const active = revisions.find(revision => revision.id === registry.activeRevisionId);
      console.log(`Active revision: ${registry.activeRevisionId}`);
      if (!active || active.entries.length === 0) {
        console.log("No preinstalled releases.");
        return;
      }

      const { releases: releaseList } = await listAdminPreinstallReleases(creds);
      const byId = new Map(releaseList.map(release => [release.id, release]));
      for (const entry of active.entries) {
        const release = byId.get(entry.releaseId);
        const label = release ? `${release.packageName}@${release.version}` : entry.releaseId;
        console.log(`- ${label}\t${entry.installPolicy}\trequired=${entry.required}`);
      }
    } catch (error) {
      fail(error);
    }
  });

preinstall
  .command("registries")
  .description("List preinstall registries and active revisions")
  .option("-e, --environment <environment>", "filter by environment")
  .action(async (options: { environment?: string }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    try {
      const environment = options.environment ? parseEnvironment(options.environment) : null;
      const { registries } = await listAdminRegistries(creds);
      const filtered = environment ? registries.filter(registry => registry.environment === environment) : registries;
      if (filtered.length === 0) {
        console.log("No preinstall registries.");
        return;
      }

      for (const registry of filtered) {
        console.log(formatRegistry(registry));
        if (registry.activeRevisionId) {
          const { revisions } = await listAdminRegistryRevisions(creds, registry.id);
          const active = revisions.find(revision => revision.id === registry.activeRevisionId);
          if (active) {
            console.log(`  active revision: ${active.id}`);
            for (const entry of active.entries) {
              console.log(`  - ${entry.releaseId}\t${entry.installPolicy}\trequired=${entry.required}`);
            }
          }
        }
      }
    } catch (error) {
      fail(error);
    }
  });

preinstall
  .command("publish")
  .description("Replace the active preinstalled miniapp list with selected releases")
  .requiredOption("-r, --release <release>", "release id or package@version; repeat for multiple releases", collect, [])
  .option("-e, --environment <environment>", "target registry environment")
  .option("--policy <policy>", "install policy for all entries", "keep_updated")
  .option("--required", "mark entries required")
  .option("--reason <reason>", "audit reason")
  .option("--yes", "confirm prod registry replacement")
  .action(
    async (options: {
      release: string[];
      environment?: string;
      policy: string;
      required?: boolean;
      reason?: string;
      yes?: boolean;
    }) => {
      const creds = await requireCredentials();
      if (!creds) return;

      try {
        const environment = options.environment
          ? parseEnvironment(options.environment)
          : inferEnvironment(creds.coreUrl);
        const installPolicy = parsePolicy(options.policy);
        if (environment === "prod" && !options.yes) {
          throw new Error("prod preinstall publish requires --yes");
        }

        const { releases: releaseList } = await listAdminPreinstallReleases(creds);
        const selected = resolveReleaseRefs(options.release, releaseList);
        const { registry } = await ensureAdminRegistry(creds, { environment });
        const { revision } = await createAdminRegistryRevision(creds, registry.id, {
          reason: options.reason ?? `Admin preinstall registry publish for ${environment}`,
          entries: selected.map((release, index) => ({
            releaseId: release.id,
            required: Boolean(options.required),
            installPolicy,
            priority: index,
          })),
        });
        const promoted = await promoteAdminRegistryRevision(creds, registry.id, revision.id);

        console.log(`Published ${selected.length} release(s) to ${environment} preinstall registry.`);
        console.log(`Registry: ${promoted.registry.id}`);
        console.log(`Revision: ${promoted.revision.id}`);
        for (const release of selected) {
          console.log(`- ${release.packageName}@${release.version}\t${release.id}`);
        }
      } catch (error) {
        fail(error);
      }
    },
  );

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
  .action(async (options: { cwd: string; build: boolean }) => {
    try {
      await packMiniapp({ cwd: resolve(options.cwd), build: options.build });
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
  .option("--json", "print machine-readable JSON")
  .action(async (options: { cwd: string; build: boolean; pack: boolean; submit: boolean; json?: boolean }) => {
    const creds = await requireCredentials();
    if (!creds) return;

    const cwd = resolve(options.cwd);
    try {
      const manifest = readManifest(cwd);
      const packageName = stringField(manifest, "packageName");
      const version = stringField(manifest, "version");
      const name = stringField(manifest, "name") || packageName;
      const description = typeof manifest.description === "string" ? manifest.description : null;

      await ensureMiniappRecord(creds, { packageName, displayName: name, description });

      if (options.pack) {
        await packMiniapp({ cwd, build: options.build, silent: options.json });
      } else if (options.build) {
        await buildMiniappProduction(cwd, { silent: options.json });
      }

      const zipPath = join(cwd, "build", `${packageName}-${version}.zip`);
      if (!existsSync(zipPath)) {
        throw new Error(`Release bundle not found: ${zipPath}`);
      }
      const bundle = readFileSync(zipPath);
      await validatePackedBundle(bundle, manifest);
      const signingKey = await ensureSigningKey(creds);
      const signedBundle = signBundleMetadata({
        signingKey,
        packageName,
        version,
        manifest,
        bundle,
      });
      const { release } = await createRelease(creds, {
        packageName,
        version,
        manifest,
        bundle,
        fileName: basename(zipPath),
        signedBundle,
      });
      const submitted = options.submit
        ? await submitRelease(creds, { packageName, releaseId: release.id })
        : { release };
      const sizeKb = Math.round(statSync(zipPath).size / 1024);
      if (options.json) {
        console.log(
          JSON.stringify(
            { release: submitted.release, bundle: basename(zipPath), signingKeyId: signedBundle.signingKeyId },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Uploaded ${packageName}@${release.version}`);
      console.log(`Status: ${submitted.release.status}`);
      console.log(`Bundle: ${basename(zipPath)} (${sizeKb} KB)`);
      console.log(`Signing key: ${signedBundle.signingKeyId}`);
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
      authenticationMethod: refreshed.authentication_method ?? creds.authenticationMethod,
      coreUrl: config.coreUrl,
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

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvironment(value: string): PreinstallEnvironment {
  const normalized = value.trim().toLowerCase();
  if (["debug", "dev", "staging", "prod"].includes(normalized)) {
    return normalized as PreinstallEnvironment;
  }
  throw new Error("environment must be debug, dev, staging, or prod");
}

function inferEnvironment(coreUrl: string): PreinstallEnvironment {
  const host = new URL(coreUrl).hostname;
  if (host.includes(".debug.")) return "debug";
  if (host.includes(".dev.")) return "dev";
  if (host.includes(".staging.")) return "staging";
  if (host === "localhost" || host === "127.0.0.1") return "dev";
  return "prod";
}

function parsePolicy(value: string): PreinstallPolicy {
  const normalized = value.trim().toLowerCase();
  if (["install_once", "keep_updated", "mandatory"].includes(normalized)) {
    return normalized as PreinstallPolicy;
  }
  throw new Error("policy must be install_once, keep_updated, or mandatory");
}

function resolveReleaseRefs(refs: string[], releases: AdminReleaseSummary[]): AdminReleaseSummary[] {
  const selected = refs.map(ref => {
    const trimmed = ref.trim();
    const byId = releases.find(release => release.id === trimmed);
    if (byId) return byId;

    const atIndex = trimmed.lastIndexOf("@");
    if (atIndex > 0) {
      const packageName = trimmed.slice(0, atIndex);
      const version = trimmed.slice(atIndex + 1);
      const matches = releases.filter(release => release.packageName === packageName && release.version === version);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`release ref ${trimmed} matched more than one release`);
    }

    throw new Error(`release not found or not publishable: ${trimmed}`);
  });

  const seen = new Set<string>();
  const seenPackages = new Map<string, string>();
  for (const release of selected) {
    if (seen.has(release.id)) throw new Error(`duplicate release: ${release.id}`);
    seen.add(release.id);

    const previous = seenPackages.get(release.packageName);
    if (previous) {
      throw new Error(
        `preinstall registry can only include one release per miniapp; ${release.packageName} selected as ${previous} and ${release.version}`,
      );
    }
    seenPackages.set(release.packageName, release.version);
  }
  return selected;
}

async function activePreinstallReleaseIds(
  credentials: CliCredentials,
  environment: PreinstallEnvironment,
): Promise<Set<string>> {
  const { registries } = await listAdminRegistries(credentials);
  const registry = registries.find(item => item.environment === environment && item.name === "default");
  if (!registry?.activeRevisionId) return new Set();
  const { revisions } = await listAdminRegistryRevisions(credentials, registry.id);
  const active = revisions.find(revision => revision.id === registry.activeRevisionId);
  return new Set(active?.entries.map(entry => entry.releaseId) ?? []);
}

interface AdminReleaseGroup {
  packageName: string;
  displayName: string;
  latest: AdminReleaseSummary;
  current: AdminReleaseSummary | null;
  releases: AdminReleaseSummary[];
}

function groupAdminReleases(releases: AdminReleaseSummary[], activeReleaseIds: Set<string>): AdminReleaseGroup[] {
  const groups = new Map<string, AdminReleaseSummary[]>();
  for (const release of releases) {
    groups.set(release.packageName, [...(groups.get(release.packageName) ?? []), release]);
  }

  return [...groups.values()]
    .map(groupReleases => {
      const sorted = [...groupReleases].sort(compareReleaseRecency);
      return {
        packageName: sorted[0]!.packageName,
        displayName: sorted[0]!.displayName,
        latest: sorted[0]!,
        current: sorted.find(release => activeReleaseIds.has(release.id)) ?? null,
        releases: sorted,
      };
    })
    .sort((a, b) => {
      if (a.current && !b.current) return -1;
      if (!a.current && b.current) return 1;
      return a.packageName.localeCompare(b.packageName);
    });
}

function compareReleaseRecency(a: AdminReleaseSummary, b: AdminReleaseSummary): number {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
  if (aTime !== bTime) return bTime - aTime;
  return b.version.localeCompare(a.version, undefined, { numeric: true, sensitivity: "base" });
}

function formatAdminReleaseGroup(group: AdminReleaseGroup): string {
  const marker = group.current ? "ACTIVE" : "      ";
  const current = group.current?.version ?? "none";
  const latest = group.latest.version;
  const label =
    group.displayName && group.displayName !== group.packageName
      ? `${group.displayName} (${group.packageName})`
      : group.packageName;
  return `${marker} ${label}\tcurrent=${current}\tlatest=${latest}\tversions=${group.releases.length}`;
}

function formatRegistry(registry: AdminRegistry): string {
  const active = registry.activeRevisionId ? `active=${registry.activeRevisionId}` : "no active revision";
  return `${registry.id}\t${registry.environment}\t${registry.name}\t${registry.status}\t${active}`;
}

function commandNameForCoreUrl(coreUrl: string): string {
  const environment = inferEnvironment(coreUrl);
  const host = new URL(coreUrl).hostname;
  if (host === "localhost" || host === "127.0.0.1") return "mentra:local";
  if (environment === "prod") return "mentra:prod";
  return `mentra:${environment}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
