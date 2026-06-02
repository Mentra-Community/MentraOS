import type { ConsoleMcpConfig } from "../config.ts";
import { parseJsonResponse } from "./errors.ts";

export interface IncidentMeta {
  incidentId: string;
  userId: string;
  status: string;
  summary?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  submissionMode?: string;
  triggerArea?: string;
  triggerReason?: string;
  sourceAppletPackageName?: string;
  sourceAppletName?: string;
}

export interface LogEntry {
  timestamp: number | string;
  level: string;
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface IncidentLogs {
  incidentId: string;
  createdAt: string;
  feedback: Record<string, unknown>;
  phoneState: Record<string, unknown>;
  phoneLogs: LogEntry[];
  cloudLogs: LogEntry[];
  glassesLogs: LogEntry[];
  glassesFirmwareLogs: LogEntry[];
  appTelemetryLogs: Record<string, LogEntry[]>;
}

export interface PaginatedIncidents {
  success: boolean;
  data: IncidentMeta[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export function createAgentClient(config: ConsoleMcpConfig) {
  const apiKey = config.agentApiKey;
  if (!apiKey) {
    throw new Error("Agent client requires MENTRA_AGENT_API_KEY");
  }

  async function request<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, config.host);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { "X-Agent-Key": apiKey },
    });
    return parseJsonResponse<T>(res);
  }

  return {
    listIncidents: (limit: number, offset: number) =>
      request<PaginatedIncidents>("/api/agent/incidents", {
        limit: String(limit),
        offset: String(offset),
      }),

    getIncident: (incidentId: string) =>
      request<{ success: boolean; data: IncidentMeta }>(
        `/api/agent/incidents/${encodeURIComponent(incidentId)}`,
      ),

    getIncidentLogs: (incidentId: string) =>
      request<{ success: boolean; data: IncidentLogs }>(
        `/api/agent/incidents/${encodeURIComponent(incidentId)}/logs`,
      ),
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
