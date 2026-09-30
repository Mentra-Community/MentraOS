import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReportTools } from "../src/tools/reports";

const requests: URL[] = [];
const api = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer test-admin-token");
    requests.push(new URL(request.url));
    return Response.json({ reports: [{ reportId: "rep_fixture", kind: "bug" }] });
  },
});
const server = new McpServer({ name: "report-list-test", version: "1.0.0" });
const client = new Client({ name: "report-list-test-client", version: "1.0.0" });

beforeAll(async () => {
  registerReportTools(server, { coreUrl: api.url.origin, adminToken: "test-admin-token", capabilities: { reports: true } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});
beforeEach(() => { requests.length = 0; });
afterAll(async () => {
  await client.close();
  await server.close();
  api.stop(true);
});

test("MCP exposes stored kinds and exclusive categories as separate filters", async () => {
  const { tools } = await client.listTools();
  expect(tools.find(tool => tool.name === "report_list")?.inputSchema.properties).toMatchObject({
    kind: { enum: ["bug", "feedback", "automatic"] },
    category: { enum: ["bug", "feedback", "internal", "testing", "automatic"] },
  });
});

test("MCP forwards legacy kind, new category and combined queries without rewriting them", async () => {
  for (const filter of [{ kind: "bug" }, { kind: "feedback" }, { kind: "automatic" },
    { category: "internal" }, { category: "testing" }, { kind: "bug", category: "internal" }]) {
    const result = await client.callTool({ name: "report_list", arguments: { ...filter, full: true } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify([{ reportId: "rep_fixture", kind: "bug" }], null, 2) }]);
    expect(requests.at(-1)?.pathname).toBe("/api/admin/reports");
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({ ...filter, limit: "25" });
  }
});

test("MCP rejects invalid filter values before contacting the report API", async () => {
  for (const filter of [{ kind: "internal" }, { category: "unknown" }]) {
    const result = await client.callTool({ name: "report_list", arguments: filter });
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});
