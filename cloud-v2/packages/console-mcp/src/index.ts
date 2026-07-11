#!/usr/bin/env bun
/**
 * Mentra Console MCP Server (Cloud V2) — stdio transport for Cursor and
 * other MCP clients.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("mentra-console-mcp failed:", err);
  process.exit(1);
});
