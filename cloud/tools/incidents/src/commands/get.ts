import { createClient, resolveConfig, resolveIncidentId } from "../client";
import { formatIncidentDetail } from "../format";

const USAGE = `
Usage: bun run incidents get <id> [options]

Arguments:
  id              Incident ID (full UUID or first 8 chars)

Options:
  --json          Output raw JSON
  --help          Show this help
`.trim();

export async function getCommand(args: string[], flags: Record<string, string | boolean>) {
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const shortId = args[0];
  if (!shortId) {
    console.error("Error: incident ID required.\n");
    console.log(USAGE);
    process.exit(1);
  }

  const client = createClient(resolveConfig());
  const fullId = await resolveIncidentId(client, shortId);

  // Fetch both metadata and logs in parallel (they're independent)
  const [meta, logs] = await Promise.all([client.getIncident(fullId), client.getIncidentLogs(fullId)]);

  if (flags.json) {
    console.log(JSON.stringify({ incident: meta.data, logs: logs.data }, null, 2));
    return;
  }

  console.log(formatIncidentDetail(meta.data, logs.data));
}
