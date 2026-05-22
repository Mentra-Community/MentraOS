import { describe, expect, test } from "bun:test";
import { resolveIncidentId } from "../src/utils/id-resolution.ts";
import type { AgentClient } from "../src/http/agent-client.ts";

function mockClient(incidents: { incidentId: string }[]): AgentClient {
  return {
    listIncidents: async () => ({
      success: true,
      data: incidents as AgentClient extends { listIncidents: infer R } ? never : never,
      pagination: { total: incidents.length, limit: 500, offset: 0, hasMore: false },
    }),
    getIncident: async () => ({ success: true, data: incidents[0] as never }),
    getIncidentLogs: async () => ({ success: true, data: {} as never }),
  } as unknown as AgentClient;
}

describe("resolveIncidentId", () => {
  test("returns full UUID as-is", async () => {
    const full = "550e8400-e29b-41d4-a716-446655440000";
    const client = mockClient([{ incidentId: full }]);
    expect(await resolveIncidentId(client, full)).toBe(full);
  });

  test("resolves unique prefix", async () => {
    const full = "c3f3e699-43fa-45e2-a6d3-09c64ab64980";
    const client = mockClient([{ incidentId: full }]);
    expect(await resolveIncidentId(client, "c3f3e699")).toBe(full);
  });

  test("throws on ambiguous prefix", async () => {
    const client = mockClient([
      { incidentId: "c3f3e699-aaaa-bbbb-cccc-dddddddddddd" },
      { incidentId: "c3f3e699-1111-2222-3333-444444444444" },
    ]);
    await expect(resolveIncidentId(client, "c3f3e699")).rejects.toThrow(/Ambiguous/);
  });
});
