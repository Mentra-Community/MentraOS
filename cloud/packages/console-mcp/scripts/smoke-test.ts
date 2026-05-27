#!/usr/bin/env bun
/**
 * Integration smoke test for mentra-console MCP HTTP clients.
 * Run with cloud API up and credentials in the environment.
 *
 * Usage:
 *   export MENTRA_API_HOST=http://localhost:8002
 *   export MENTRA_CLI_TOKEN=...
 *   export MENTRA_AGENT_API_KEY=...  # must match cloud .env
 *   bun run scripts/smoke-test.ts
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "../src/config.ts";
import { createCliClient } from "../src/http/cli-client.ts";
import { createAgentClient } from "../src/http/agent-client.ts";
import { createAdminClient } from "../src/http/admin-client.ts";
import { resolveIncidentId } from "../src/utils/id-resolution.ts";
import { collectLogEntries, filterLogEntries } from "../src/utils/incident-filter.ts";
import { requireConfirm } from "../src/tools/helpers.ts";

function loadCloudDotenv(): void {
  const paths = [
    resolve(import.meta.dir, "../../../.env"),
    resolve(import.meta.dir, "../../../../cloud/.env"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i === -1) continue;
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
      break;
    } catch {
      /* skip */
    }
  }
}

type Result = { name: string; ok: boolean; detail?: string };

const results: Result[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

function skip(name: string, reason: string) {
  results.push({ name, ok: true, detail: `SKIP: ${reason}` });
  console.log(`  ○ ${name} — SKIP (${reason})`);
}

async function main(): Promise<void> {
  loadCloudDotenv();
  const config = loadConfig();

  console.log("\nMentra Console MCP — smoke test\n");
  console.log(`Host: ${config.host}`);
  console.log(
    `Capabilities: developer=${config.capabilities.developer} incidents=${config.capabilities.incidents} admin=${config.capabilities.admin}\n`,
  );

  // Reachability
  try {
    const res = await fetch(`${config.host}/api/admin/debug`);
    if (res.ok) pass("API reachable", `${config.host}`);
    else fail("API reachable", `HTTP ${res.status}`);
  } catch (e) {
    fail("API reachable", e instanceof Error ? e.message : String(e));
    console.log("\nStart cloud first: cd cloud && bun run dev\n");
    printSummary();
    process.exit(1);
  }

  // Developer / CLI
  if (config.capabilities.developer) {
    const cli = createCliClient(config);
    try {
      const apps = await cli.listApps();
      const list = (apps as { data?: unknown[] }).data ?? apps;
      pass("CLI app_list", Array.isArray(list) ? `${list.length} apps` : "ok");
    } catch (e) {
      fail("CLI app_list", e instanceof Error ? e.message : String(e));
    }

    try {
      await cli.listOrgs();
      pass("CLI org_list");
    } catch (e) {
      fail("CLI org_list", e instanceof Error ? e.message : String(e));
    }

    try {
      requireConfirm(undefined, "app_delete");
      fail("confirm gate", "should have thrown without confirm");
    } catch {
      pass("confirm gate (app_delete without confirm)");
    }
  } else {
    skip("CLI tests", "MENTRA_CLI_TOKEN not set");
  }

  // Incidents / agent
  if (config.capabilities.incidents) {
    const agent = createAgentClient(config);
    try {
      const res = await agent.listIncidents(5, 0);
      pass("Agent incident_list", `${res.data.length} incidents`);
      if (res.data.length > 0) {
        const short = res.data[0].incidentId.slice(0, 8);
        const full = await resolveIncidentId(agent, short);
        pass("Agent incident short-id resolve", full.slice(0, 8) + "…");

        const logsRes = await agent.getIncidentLogs(full);
        const data = logsRes.data;
        const collected = collectLogEntries(data, "phone");
        const { entries, truncated } = filterLogEntries(collected, { limit: 10 });
        pass(
          "Agent incident_get_logs + filter",
          `${entries.length} lines${truncated ? " (truncated)" : ""}`,
        );
      }
    } catch (e) {
      fail("Agent incident_list", e instanceof Error ? e.message : String(e));
    }
  } else {
    skip("Agent tests", "MENTRA_AGENT_API_KEY not set");
  }

  // Admin
  if (config.capabilities.admin) {
    const admin = createAdminClient(config);
    try {
      const check = await admin.check();
      pass("Admin admin_check", check.email);
    } catch (e) {
      fail("Admin admin_check", e instanceof Error ? e.message : String(e));
    }
  } else {
    skip("Admin tests", "MENTRA_ADMIN_JWT / MENTRA_ADMIN_TOKEN not set");
  }

  printSummary();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

function printSummary(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log("");
}

main();
