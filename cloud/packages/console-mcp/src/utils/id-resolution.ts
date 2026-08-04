import type { AgentClient } from "../http/agent-client.ts";

const PAGE_SIZE = 500;

/**
 * Resolve a short incident ID prefix to a full UUID via agent list API.
 */
export async function resolveIncidentId(
  client: AgentClient,
  shortId: string,
): Promise<string> {
  if (shortId.length > 8) {
    return shortId;
  }

  const matches: { incidentId: string }[] = [];
  let offset = 0;

  while (true) {
    const res = await client.listIncidents(PAGE_SIZE, offset);
    matches.push(...res.data.filter((i) => i.incidentId.startsWith(shortId)));

    if (matches.length > 1) {
      const ids = matches.map((i) => i.incidentId.slice(0, 8)).join(", ");
      throw new Error(
        `Ambiguous prefix "${shortId}" — matches ${matches.length} incidents: ${ids}`,
      );
    }
    if (matches.length === 1 && !res.pagination.hasMore) {
      return matches[0].incidentId;
    }
    if (!res.pagination.hasMore) {
      break;
    }
    offset += PAGE_SIZE;
  }

  throw new Error(`No incident found matching prefix "${shortId}"`);
}
