// services/logging/betterstack-query.service.ts
// Query cloud logs from BetterStack using their SQL-based Query API

import { logger as rootLogger } from "./pino-logger";

const logger = rootLogger.child({ service: "betterstack-query" });

// BetterStack SQL Query API credentials (create via AI SRE → MCP and API in dashboard)
const BETTERSTACK_USERNAME = process.env.BETTERSTACK_USERNAME;
const BETTERSTACK_PASSWORD = process.env.BETTERSTACK_PASSWORD;
const BETTERSTACK_SOURCE = process.env.BETTERSTACK_SOURCE; // e.g., "t123456_cloud_logs"

export interface CloudLogEntry {
  timestamp: string;
  level: string;
  message: string;
  service?: string;
  userId?: string;
}

/**
 * Query cloud logs from BetterStack for a specific user within a time window.
 *
 * @param userId - User identifier (email)
 * @param windowMs - Time window in milliseconds (e.g., 10 minutes = 600000)
 * @returns Array of cloud log entries
 */
export async function queryBetterStackLogs(
  userId: string,
  windowMs: number,
): Promise<CloudLogEntry[]> {
  // Check if BetterStack is configured
  if (!BETTERSTACK_USERNAME || !BETTERSTACK_PASSWORD || !BETTERSTACK_SOURCE) {
    logger.warn(
      {
        hasUsername: !!BETTERSTACK_USERNAME,
        hasPassword: !!BETTERSTACK_PASSWORD,
        hasSource: !!BETTERSTACK_SOURCE,
      },
      "BetterStack not configured - skipping cloud log query",
    );
    return [];
  }

  const now = Math.floor(Date.now() / 1000);
  const since = now - Math.floor(windowMs / 1000);

  // BetterStack uses SQL queries with JSONExtract for filtering JSON fields
  // Note: userId field is logged via Pino child logger context in auth middleware
  const query = `
    SELECT dt, raw
    FROM remote(${BETTERSTACK_SOURCE})
    WHERE dt BETWEEN toDateTime64(${since}, 0, 'UTC') AND toDateTime64(${now}, 0, 'UTC')
      AND JSONExtract(raw, 'userId', 'Nullable(String)') = '${escapeSQL(userId)}'
    ORDER BY dt DESC
    LIMIT 1000
    FORMAT JSONEachRow
  `;

  try {
    const response = await fetch(
      "https://eu-nbg-2-connect.betterstackdata.com?output_format_pretty_row_numbers=0",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Authorization":
            "Basic " + Buffer.from(`${BETTERSTACK_USERNAME}:${BETTERSTACK_PASSWORD}`).toString("base64"),
        },
        body: query,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          userId,
        },
        "BetterStack query failed",
      );
      return [];
    }

    const text = await response.text();

    // JSONEachRow format: one JSON object per line
    const lines = text.trim().split("\n").filter(Boolean);

    const logs: CloudLogEntry[] = lines.map((line) => {
      try {
        const { dt, raw } = JSON.parse(line);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

        return {
          timestamp: dt,
          level: parsed.level || "info",
          message: parsed.msg || parsed.message || JSON.stringify(parsed),
          service: parsed.service || "cloud",
          userId: parsed.userId,
        };
      } catch {
        // If parsing fails, return raw as message
        return {
          timestamp: new Date().toISOString(),
          level: "info",
          message: line,
        };
      }
    });

    logger.info(
      {
        userId,
        windowMs,
        logCount: logs.length,
      },
      "Retrieved cloud logs from BetterStack",
    );

    return logs;
  } catch (err) {
    logger.error(
      {
        error: err instanceof Error ? err.message : String(err),
        userId,
      },
      "Failed to query BetterStack logs",
    );
    return [];
  }
}

/**
 * Escape SQL string to prevent injection.
 */
function escapeSQL(str: string): string {
  return str.replace(/'/g, "''");
}
