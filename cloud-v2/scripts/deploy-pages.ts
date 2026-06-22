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

for (const site of selectedSites) {
  const project = `${sites[site]}-${env}`;
  run(["bun", "--cwd", `websites/${site}`, "build"]);
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

function run(command: string[], options: { cwd?: string } = {}) {
  console.log(`$ ${command.join(" ")}`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
