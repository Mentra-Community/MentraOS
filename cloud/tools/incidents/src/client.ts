export interface ClientConfig {
  apiKey: string;
  host: string; // e.g. "https://api.mentra.glass"
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface SingleResponse<T> {
  success: boolean;
  data: T;
}

export interface IncidentMeta {
  incidentId: string;
  userId: string;
  status: string;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
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
  attachments?: { filename: string; timestamp: string }[];
}

export function createClient(config: ClientConfig) {
  const { apiKey, host } = config;

  async function request<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(path, host);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: { "X-Agent-Key": apiKey },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  return {
    async listIncidents(limit: number, offset: number): Promise<PaginatedResponse<IncidentMeta>> {
      return request("/api/agent/incidents", {
        limit: String(limit),
        offset: String(offset),
      });
    },

    async getIncident(id: string): Promise<SingleResponse<IncidentMeta>> {
      return request(`/api/agent/incidents/${id}`);
    },

    async getIncidentLogs(id: string): Promise<SingleResponse<IncidentLogs>> {
      return request(`/api/agent/incidents/${id}/logs`);
    },
  };
}

export type Client = ReturnType<typeof createClient>;

export function resolveConfig(): ClientConfig {
  const apiKey = process.env.MENTRA_AGENT_API_KEY;
  if (!apiKey) {
    console.error("Error: MENTRA_AGENT_API_KEY environment variable is not set.");
    console.error("Set it in cloud/.env or export it in your shell.");
    process.exit(1);
  }

  const host = process.env.MENTRA_API_HOST || "https://api.mentra.glass";

  return { apiKey, host };
}

export async function resolveIncidentId(client: Client, shortId: string): Promise<string> {
  // If it looks like a full UUID, use it directly
  if (shortId.length > 8) {
    return shortId;
  }

  // Fetch recent incidents and match prefix
  const res = await client.listIncidents(500, 0);
  const matches = res.data.filter((i) => i.incidentId.startsWith(shortId));

  if (matches.length === 0) {
    throw new Error(`No incident found matching prefix "${shortId}"`);
  }
  if (matches.length > 1) {
    const ids = matches.map((i) => i.incidentId.slice(0, 8)).join(", ");
    throw new Error(`Ambiguous prefix "${shortId}" — matches ${matches.length} incidents: ${ids}`);
  }

  return matches[0].incidentId;
}
