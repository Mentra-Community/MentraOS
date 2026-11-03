#!/usr/bin/env bun

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
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createWorkspace,
  ensureOidcClient,
  listWorkspaces,
  SessionExpiredError,
  type CoreCredentials,
} from "./api";
import { getConfig, type CliConfig } from "./config";
import { cliHome, type CliCredentials } from "./credentials";
import { loopbackLogin } from "./loopback-login";
import { openBrowser } from "./open-browser";
import { loadFreshCredentials, renewRefusedLogin, signOut, storeLogin } from "./session";

const program = new Command();
const CLI_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

program
  .name("mentra")
  .description("Mentra developer CLI")
  .version(CLI_VERSION)
  .option("--core-url <url>", "use this Core, such as a Mentra Private Cloud's (MENTRA_CORE_URL)")
  .hook("preAction", (command) => {
    const { coreUrl } = command.opts<{ coreUrl?: string }>();
    // A flag replaces the environment's choice for this run.
    if (coreUrl) process.env.MENTRA_CORE_URL = coreUrl;
  });

program
  .command("login")
  .description("Sign in to Mentra in your browser")
  .option("--no-browser", "print the sign-in URL instead of opening a browser (for SSH, forward the port it names)")
  .addOption(new Option("--no-open", "same as --no-browser").hideHelp())
  .action(async (options: { browser: boolean; open: boolean }) => {
    try {
      const config = getConfig();
      const oidc = await ensureOidcClient(config);
      const result = await loopbackLogin(oidc, {
        openBrowser: options.browser && options.open ? openBrowser : async () => false,
        print: (line) => console.log(line),
      });
      const credentials: CliCredentials = {
        token: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: new Date(result.expiresAt).toISOString(),
        mentraUserId: result.subject,
        email: result.email,
        issuer: oidc.serverMetadata().issuer,
        clientId: oidc.clientMetadata().client_id,
        coreUrl: config.coreUrl,
        storedAt: new Date().toISOString(),
      };
      const storage = await storeLogin(credentials);
      console.log(`Signed in as ${result.email ?? result.subject}`);
      console.log(`Core: ${config.coreUrl}`);
      console.log(`Credentials stored in ${storage === "keychain" ? "the OS keychain" : cliHome()}`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("whoami")
  .description("Show the current sign-in")
  .action(async () => {
    try {
      const config = getConfig();
      const creds = await loadSession(config.coreUrl);
      if (!creds) return;
      console.log(`Email: ${creds.email ?? "unknown"}`);
      console.log(`Core user: ${creds.mentraUserId}`);
      console.log(`Issuer: ${creds.issuer}`);
      console.log(`Core: ${config.coreUrl}`);
      console.log(`Expires: ${new Date(creds.expiresAt).toLocaleString()}`);
    } catch (error) {
      fail(error);
    }
  });

const workspace = program.command("workspace").description("Show or create your workspace (an account belongs to one)");

workspace
  .command("show")
  .description("Show your workspace and your role in it")
  .action(async () => {
    const creds = await requireCoreCredentials();
    if (!creds) return;

    try {
      const workspaces = await listWorkspaces(creds);
      if (workspaces.length === 0) {
        console.log("This account has no workspace. Create one with `mentra workspace create <name>`.");
        return;
      }
      if (workspaces.length > 1) {
        // Nothing to pick among: a person belongs to one workspace, so this is for Mentra support to fix.
        console.log("This account is in more than one workspace, which Mentra no longer allows. Contact Mentra support to bring it down to one.");
        for (const each of workspaces) console.log(`  ${each.workspaceId}\t${each.name}`);
        return;
      }
      const [only] = workspaces;
      console.log(`Workspace: ${only!.name} (${only!.workspaceId})`);
      console.log(`Role: ${only!.membership.role}`);
    } catch (error) {
      fail(error);
    }
  });

workspace
  .command("create")
  .argument("<name>", "workspace name")
  .description("Create your workspace (Core refuses a second one)")
  .action(async (name: string) => {
    const creds = await requireCoreCredentials();
    if (!creds) return;

    try {
      const created = await createWorkspace(creds, name);
      console.log(`Workspace created: ${created.name} (${created.workspaceId})`);
    } catch (error) {
      fail(error);
    }
  });

const miniapps = program.command("miniapps").description("Miniapp tools");

const miniappKeys = miniapps.command("keys").description("Manage durable publisher signing keys (for `mentra pack --sign`)");

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
  .description("Pack the current miniapp into build/, ready to upload to its URL")
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
  .command("logout")
  .description("Sign out: revoke this login at the sign-in server and delete it from this computer")
  .action(async () => {
    try {
      // After any refresh another command is running; deleted even when the sign-in server cannot be reached.
      const { signedIn, confirmed } = await signOut(getConfig().coreUrl);
      if (!signedIn) console.log("Not signed in");
      else console.log(confirmed ? "Signed out" : "Signed out locally; server sign-out not confirmed");
    } catch (error) {
      fail(error);
    }
  });

await program.parseAsync();

/**
 * The login for the Core at `coreUrl`, refreshed when needed. Prints why and
 * sets a failing exit code when there is none.
 */
async function loadSession(coreUrl: string): Promise<CliCredentials | null> {
  try {
    const creds = await loadFreshCredentials(coreUrl);
    if (creds) return creds;
    console.error("Not signed in. Run `mentra login`.");
  } catch (error) {
    console.error(error instanceof SessionExpiredError ? error.message : message(error));
  }
  process.exitCode = 1;
  return null;
}

/** Credentials for a command that asks Core, renewed once when Core refuses the access token. */
async function requireCoreCredentials(): Promise<CoreCredentials | null> {
  let config: CliConfig;
  try {
    config = getConfig();
  } catch (error) {
    fail(error);
    return null;
  }
  const creds = await loadSession(config.coreUrl);
  if (!creds) return null;
  return {
    token: creds.token,
    coreUrl: config.coreUrl,
    renewToken: async (refused) => (await renewRefusedLogin(config.coreUrl, creds.mentraUserId, refused))?.token ?? null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown): void {
  console.error(message(error));
  process.exitCode = 1;
}
