import { spawnSync } from "node:child_process";

const environments = ["dev", "staging", "prod"] as const;
const sites = {
  console: "mentra-console2",
  admin: "mentra-admin",
  portal: "mentra-enterprise-portal",
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

const selectedSites = requestedSite && requestedSite !== "all" ? [requestedSite] : Object.keys(sites) as Site[];
const coreUrls: Record<Environment, string> = {
  dev: "https://core.dev.us-west-2.mentraglass.com",
  staging: "https://core.staging.us-west-2.mentraglass.com",
  prod: "https://core.mentraglass.com",
};
const storeUrls: Record<Environment, string> = {
  dev: "https://store.dev.us-west-2.mentraglass.com",
  staging: "https://store.staging.us-west-2.mentraglass.com",
  prod: "https://store.mentraglass.com",
};

for (const site of selectedSites) {
  const project = `${sites[site]}-${env}`;
  run(["bun", "--cwd", `websites/${site}`, "build"]);
  if (site === "portal") {
    run([
      "bunx", "wrangler", "pages", "secret", "put", "CORE_URL", "--project-name", project,
    ], { cwd: `websites/${site}`, input: coreUrls[env] });
  }
  if (site !== "portal") {
    run([
      "bunx", "wrangler", "pages", "secret", "put", "STORE_URL", "--project-name", project,
    ], { cwd: `websites/${site}`, input: storeUrls[env] });
  }
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

function run(command: string[], options: { cwd?: string; input?: string } = {}) {
  console.log(`$ ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    stdio: options.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    env: process.env,
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
