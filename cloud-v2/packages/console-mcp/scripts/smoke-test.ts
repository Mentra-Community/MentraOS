#!/usr/bin/env bun
/**
 * Integration smoke test for the mentra-console MCP admin reports client.
 * Hits a live Cloud V2 core; needs MENTRA_ADMIN_TOKEN (and MENTRA_CORE_URL
 * or MENTRA_ENV to pick a deployment — defaults to prod).
 *
 * Usage:
 *   export MENTRA_ADMIN_TOKEN=msk_...
 *   export MENTRA_ENV=dev            # or MENTRA_CORE_URL=http://localhost:3000
 *   bun run scripts/smoke-test.ts
 */

import { loadConfig } from "../src/config";
import { createAdminReportsClient } from "../src/http/admin-reports-client";
import { resolveReport } from "../src/utils/id-resolution";
import {
  filterLogEntries,
  mergeLogBundles,
  parseLogBundle,
} from "../src/utils/report-logs";

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
  const config = loadConfig();

  console.log("\nMentra Console MCP (Cloud V2) — smoke test\n");
  console.log(`Core URL: ${config.coreUrl}`);
  console.log(`Capabilities: reports=${config.capabilities.reports}\n`);

  // Reachability — /api/admin/health sits before the adminAuth gate.
  try {
    const res = await fetch(`${config.coreUrl}/api/admin/health`);
    if (res.ok) pass("core reachable", config.coreUrl);
    else fail("core reachable", `HTTP ${res.status}`);
  } catch (e) {
    fail("core reachable", e instanceof Error ? e.message : String(e));
    printSummary();
    process.exit(1);
  }

  if (!config.capabilities.reports) {
    skip("admin reports tests", "MENTRA_ADMIN_TOKEN not set");
    printSummary();
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
  }

  const client = createAdminReportsClient(config);

  try {
    const me = await client.me();
    pass("admin /me", JSON.stringify(me.user ?? {}));
  } catch (e) {
    fail("admin /me", e instanceof Error ? e.message : String(e));
  }

  try {
    const { reports } = await client.listReports({ limit: 5 });
    pass("report_list", `${reports.length} reports`);

    if (reports.length > 0) {
      const first = reports[0];
      const short = first.reportId.slice(0, 12);
      const { report } = await resolveReport(client, short);
      pass("report short-id resolve", `${short} → ${report.reportId}`);

      const logArtifacts = report.artifacts.filter((a) => a.type === "logs");
      if (logArtifacts.length > 0) {
        const bundles = await Promise.all(
          logArtifacts.map(async (artifact) => ({
            artifact,
            entries: parseLogBundle(
              (await client.getArtifact(report.reportId, artifact.artifactId)).bytes,
            ),
          })),
        );
        const merged = mergeLogBundles(bundles);
        const { entries, truncated } = filterLogEntries(merged, { limit: 10 });
        pass(
          "report_get_logs + filter",
          `${entries.length} lines${truncated ? " (truncated)" : ""}`,
        );
      } else {
        skip("report_get_logs", `report ${report.reportId} has no logs artifacts`);
      }
    }
  } catch (e) {
    fail("report_list", e instanceof Error ? e.message : String(e));
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
