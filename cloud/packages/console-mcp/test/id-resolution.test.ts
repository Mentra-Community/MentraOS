import { describe, expect, test } from "bun:test";
import { resolveIncidentId } from "../src/utils/id-resolution.ts";
import type { AgentClient } from "../src/http/agent-client.ts";

function mockClient(
  incidents: { incidentId: string }[],
  options?: { pageSize?: number },
): AgentClient {
  const pageSize = options?.pageSize ?? 500;
  return {
    listIncidents: async (_limit: number, offset: number) => {
      const page = incidents.slice(offset, offset + pageSize);
      return {
        success: true,
        data: page as never,
        pagination: {
          total: incidents.length,
          limit: pageSize,
          offset,
          hasMore: offset + page.length < incidents.length,
        },
      };
    },
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

  test("paginates past first page to resolve prefix", async () => {
    const target = "deadbeef-0000-0000-0000-000000000001";
    const filler = Array.from({ length: 500 }, (_, i) => ({
      incidentId: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`,
    }));
    const client = mockClient([...filler, { incidentId: target }], { pageSize: 500 });
    expect(await resolveIncidentId(client, "deadbeef")).toBe(target);
  });
});
