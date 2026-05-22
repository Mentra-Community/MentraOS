import type { AgentClient } from "../http/agent-client.ts";

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

  const res = await client.listIncidents(500, 0);
  const matches = res.data.filter((i) => i.incidentId.startsWith(shortId));

  if (matches.length === 0) {
    throw new Error(`No incident found matching prefix "${shortId}"`);
  }
  if (matches.length > 1) {
    const ids = matches.map((i) => i.incidentId.slice(0, 8)).join(", ");
    throw new Error(
      `Ambiguous prefix "${shortId}" — matches ${matches.length} incidents: ${ids}`,
    );
  }

  return matches[0].incidentId;
}
