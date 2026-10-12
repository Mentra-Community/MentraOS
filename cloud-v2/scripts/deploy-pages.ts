import { spawnSync } from "node:child_process";

const environments = ["dev", "staging", "prod"] as const;
const sites = {
  admin: "mentra-admin",
  portal: "mentra-enterprise-portal",
  account: "mentra-account",
} as const;

type Environment = typeof environments[number];
type Site = keyof typeof sites;

const env = process.argv[2] as Environment | undefined;
const requestedSite = process.argv[3] as Site | "all" | undefined;

if (!env || !environments.includes(env)) {
  fail(`Usage: bun scripts/deploy-pages.ts <${environments.join("|")}> [${Object.keys(sites).join("|")}|all]`);
}

if (requestedSite && requestedSite !== "all" && !(requestedSite in sites)) {
  fail(`Unknown site "${requestedSite}"`);
}

const coreUrls: Record<Environment, string> = {
  dev: "https://core.dev.us-west-2.mentraglass.com",
  staging: "https://core.staging.us-west-2.mentraglass.com",
  prod: "https://core.mentraglass.com",
};

// Each environment has its own sign-in site, the issuer of its Core's sign-in
// server: account.dev.mentraglass.com, account.staging.mentraglass.com and
// account.mentraglass.com. Each is the same static sign-in page, with a Pages
// Function that relays the provider's routes to that environment's Core
// (CORE_URL), and the shared Supabase project's public values:
//   ACCOUNT_SUPABASE_URL             the Supabase project URL
//   ACCOUNT_SUPABASE_PUBLISHABLE_KEY the project's publishable key
// Prod's project keeps its original name, mentra-account.
const accountProjects: Record<Environment, string> = {
  dev: "mentra-account-dev",
  staging: "mentra-account-staging",
  prod: "mentra-account",
};
const accountConfig = {
  SUPABASE_URL: process.env.ACCOUNT_SUPABASE_URL?.trim() ?? "",
  SUPABASE_ANON_KEY: process.env.ACCOUNT_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "",
};
const accountConfigured = Object.values(accountConfig).every(Boolean);

const selectedSites: Site[] = [];
if (requestedSite && requestedSite !== "all") {
  selectedSites.push(requestedSite);
} else {
  selectedSites.push("admin", "portal");
  if (accountConfigured) selectedSites.push("account");
  else console.log("Skipping the account site: its ACCOUNT_* configuration is not set.");
}

for (const site of selectedSites) {
  const project = site === "account" ? accountProjects[env] : `${sites[site]}-${env}`;
  if (site === "account") {
    if (!accountConfigured) fail("The account site needs ACCOUNT_SUPABASE_URL and ACCOUNT_SUPABASE_PUBLISHABLE_KEY.");
    run(["bun", "--cwd", "websites/account", "build"], { env: accountConfig });
  } else {
    run(["bun", "--cwd", `websites/${site}`, "build"]);
  }
  run([
    "bunx",
    "wrangler",
    "pages",
    "secret",
    "put",
    "CORE_URL",
    "--project-name",
    project,
  ], { cwd: `websites/${site}`, input: coreUrls[env] });
  deploy(site, project);
}

function deploy(site: Site, project: string) {
  run([
    "bunx",
    "wrangler",
    "pages",
    "deploy",
    "dist",
    "--project-name",
    project,
    "--branch",
    "main",
    "--commit-dirty=true",
  ], { cwd: `websites/${site}` });
}

function run(command: string[], options: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  console.log(`$ ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    env: { ...process.env, ...options.env },
    input: options.input === undefined ? undefined : `${options.input}\n`,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
