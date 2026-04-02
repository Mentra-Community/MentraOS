import { createClient, resolveConfig, type IncidentMeta } from "../client";
import { formatIncidentTable } from "../format";

const USAGE = `
Usage: bun run incidents list [options]

Options:
  --limit <n>     Number of results (default: 20, max: 500)
  --user <email>  Filter by user email (client-side)
  --json          Output raw JSON
  --help          Show this help
`.trim();

export async function listCommand(_args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const limit = Math.min(parseInt(String(flags.limit || "20"), 10), 500);
  const userFilter = flags.user ? String(flags.user).toLowerCase() : null;

  const client = createClient(resolveConfig());

  // If filtering by user, fetch max and filter client-side
  const fetchLimit = userFilter ? 500 : limit;
  const res = await client.listIncidents(fetchLimit, 0);

  let incidents: IncidentMeta[] = res.data;

  if (userFilter) {
    incidents = incidents.filter((i) => i.userId?.toLowerCase().includes(userFilter));
    incidents = incidents.slice(0, limit);
  }

  if (flags.json) {
    console.log(JSON.stringify(incidents, null, 2));
    return;
  }

  if (incidents.length === 0) {
    console.log("No incidents found.");
    return;
  }

  console.log(formatIncidentTable(incidents));
  console.log(`\n${incidents.length} incidents${res.pagination.hasMore ? ` (${res.pagination.total} total)` : ""}`);
}
