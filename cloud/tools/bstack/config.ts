/**
 * BetterStack CLI Configuration
 *
 * All source IDs, table names, collector IDs, and endpoint configuration
 * for the bstack CLI tool. This is the single source of truth for
 * "where is our data in BetterStack?"
 *
 * See: cloud/issues/064-bstack-cli/spike.md
 * See: cloud/tools/bstack/inventory.md (moved to cloud/issues/097-porter-mini-app-cleanup/inventory.md)
 */

// ---------------------------------------------------------------------------
// Credentials (from environment)
// ---------------------------------------------------------------------------

export const SQL_USERNAME = process.env.BETTERSTACK_SQL_USERNAME || process.env.BETTERSTACK_USERNAME || "";
export const SQL_PASSWORD = process.env.BETTERSTACK_SQL_PASSWORD || process.env.BETTERSTACK_PASSWORD || "";
export const API_TOKEN = process.env.BETTERSTACK_API_TOKEN || "";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** BetterStack ClickHouse SQL API — read-only HTTP endpoint for log/metric queries */
export const SQL_ENDPOINT = "https://eu-nbg-2-connect.betterstackdata.com";

/** BetterStack Uptime API */
export const UPTIME_API = "https://uptime.betterstack.com/api/v2";

/** BetterStack Telemetry API (management — sources, collectors, dashboards) */
export const TELEMETRY_API = "https://telemetry.betterstack.com/api/v1";

// ---------------------------------------------------------------------------
// Log Sources
// ---------------------------------------------------------------------------

export interface LogSource {
  id: number;
  name: string;
  description: string;
  /** Recent logs (hot storage) */
  logsTable: string;
  /** Historical logs (cold/S3 storage). Use with `WHERE _row_type = 1` for logs. */
  historicalTable: string;
  /** Metrics (aggregated time-series from this source) */
  metricsTable: string;
}

export const LOG_SOURCES: Record<string, LogSource> = {
  prod: {
    id: 2324289,
    name: "MentraCloud - Prod",
    description:
      "Production and staging logs. Receives from US Central, US West, US East (and France/East Asia after next redeploy).",
    logsTable: "remote(t373499_mentracloud_prod_logs)",
    historicalTable: "s3Cluster(primary, t373499_mentracloud_prod_s3)",
    metricsTable: "remote(t373499_mentracloud_prod_metrics)",
  },
  dev: {
    id: 1311181,
    name: "AugmentOS (dev/local/legacy)",
    description:
      "Dev, local, debug, and legacy prod logs. France and East Asia still send here until they redeploy with the new BETTERSTACK_SOURCE_TOKEN.",
    logsTable: "remote(t373499_augmentos_logs)",
    historicalTable: "s3Cluster(primary, t373499_augmentos_s3)",
    metricsTable: "remote(t373499_augmentos_metrics)",
  },
};

/** Default source for prod queries */
export const DEFAULT_PROD_SOURCE = LOG_SOURCES.prod;

/** Default source for dev/debug queries */
export const DEFAULT_DEV_SOURCE = LOG_SOURCES.dev;

// ---------------------------------------------------------------------------
// Collector Sources (infrastructure metrics from each cluster)
// ---------------------------------------------------------------------------

export interface CollectorSource {
  collectorId: number;
  sourceId: number;
  name: string;
  region: string;
  clusterId: number;
  metricsTable: string;
}

export const COLLECTORS: Record<string, CollectorSource> = {
  "us-central": {
    collectorId: 60277,
    sourceId: 2321796,
    name: "mentra-us-central",
    region: "us-central",
    clusterId: 4689,
    metricsTable: "remote(t373499_mentra_us_central_metrics)",
  },
  "france": {
    collectorId: 60500,
    sourceId: 2326580,
    name: "mentra-france",
    region: "france",
    clusterId: 4696,
    metricsTable: "remote(t373499_mentra_france_metrics)",
  },
  "east-asia": {
    collectorId: 60501,
    sourceId: 2326583,
    name: "mentra-east-asia",
    region: "east-asia",
    clusterId: 4754,
    metricsTable: "remote(t373499_mentra_east_asia_metrics)",
  },
  "us-west": {
    collectorId: 60502,
    sourceId: 2326586,
    name: "mentra-us-west",
    region: "us-west",
    clusterId: 4965,
    metricsTable: "remote(t373499_mentra_us_west_metrics)",
  },
  "us-east": {
    collectorId: 60503,
    sourceId: 2326589,
    name: "mentra-us-east",
    region: "us-east",
    clusterId: 4977,
    metricsTable: "remote(t373499_mentra_us_east_metrics)",
  },
};

// ---------------------------------------------------------------------------
// Uptime Monitors
// ---------------------------------------------------------------------------

export interface UptimeMonitor {
  id: number;
  name: string;
  url: string;
  description: string;
}

export const UPTIME_MONITORS: Record<string, UptimeMonitor> = {
  prod: {
    id: 3355604,
    name: "prod.augmentos.cloud/health",
    url: "https://prod.augmentos.cloud/health",
    description: "Main prod health check — goes through Cloudflare LB, hits one region.",
  },
  global: {
    id: 3355611,
    name: "global.augmentos.cloud/health",
    url: "https://global.augmentos.cloud/health",
    description: "Global health check.",
  },
  mira: {
    id: 3355637,
    name: "mira.augmentos.cloud/health",
    url: "https://mira.augmentos.cloud/health",
    description: "Mira app health check.",
  },
  liveCaptions: {
    id: 3355638,
    name: "Live captions global",
    url: "https://live-captions-8841-4a24a192-ds5kfgs4.onporter.run/health",
    description: "Live captions standalone health.",
  },
  dashboard: {
    id: 3355643,
    name: "dashboard health",
    url: "https://dashboard-9520-4a24a192-1a62k0ue.onporter.run/health",
    description: "Dashboard app health.",
  },
  devTranscription: {
    id: 3510587,
    name: "Dev Server Transcription",
    url: "https://cloud-uptime-tracker-10676-4a24a192-d81v3ir2.onporter.run/health",
    description: "Dev transcription uptime tracker. Currently DOWN (SSL cert issue).",
  },
  prodTranscription: {
    id: 3514682,
    name: "Prod Server Transcription",
    url: "https://cloud-uptime-tracker-10698-4a24a192-r2am9o43.onporter.run/health",
    description: "Prod transcription uptime tracker. Currently DOWN (SSL cert issue).",
  },
};

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export interface Dashboard {
  id: number;
  name: string;
  sourceId: number;
  description: string;
  url: string;
}

export const DASHBOARDS: Record<string, Dashboard> = {
  sreUsCentral: {
    id: 973977,
    name: "MentraCloud SRE — US Central",
    sourceId: 2321796,
    description:
      "10 charts: RSS memory, CPU, restarts, OOM kills, HTTP rate, TCP connections. Uses US Central collector metrics.",
    url: "https://telemetry.betterstack.com/team/t329093/dashboards/973977",
  },
  crashInvestigation: {
    id: 971353,
    name: "Cloud-Prod Health & Crash Investigation",
    sourceId: 1311181,
    description:
      "Legacy dashboard from 057 investigation. Log-based charts — mostly broken because dashboard {{source}} resolves to metrics table. Superseded by SRE dashboard.",
    url: "https://telemetry.betterstack.com/team/t329093/dashboards/971353",
  },
};

// ---------------------------------------------------------------------------
// Region Configuration
// ---------------------------------------------------------------------------

export interface Region {
  name: string;
  clusterId: number;
  healthUrl: string;
  dopplerConfig: string;
  porterEnvGroup: string;
}

export const REGIONS: Record<string, Region> = {
  "us-central": {
    name: "US Central",
    clusterId: 4689,
    healthUrl: "https://uscentralapi.mentra.glass/health",
    dopplerConfig: "prod_central-us",
    porterEnvGroup: "cloud-prod-central-us",
  },
  "france": {
    name: "France",
    clusterId: 4696,
    healthUrl: "https://franceapi.mentra.glass/health",
    dopplerConfig: "prod_france",
    porterEnvGroup: "cloud-prod-france",
  },
  "east-asia": {
    name: "East Asia",
    clusterId: 4754,
    healthUrl: "https://asiaeastapi.mentraglass.com/health",
    dopplerConfig: "prod_east-asia",
    porterEnvGroup: "cloud-prod-east-asia",
  },
  "us-west": {
    name: "US West",
    clusterId: 4965,
    healthUrl: "https://uswestapi.mentraglass.com/health",
    dopplerConfig: "prod_us-west",
    porterEnvGroup: "cloud-prod-us-west",
  },
  "us-east": {
    name: "US East",
    clusterId: 4977,
    healthUrl: "https://useastapi.mentraglass.com/health",
    dopplerConfig: "prod_us-east",
    porterEnvGroup: "cloud-prod-us-east",
  },
};

// ---------------------------------------------------------------------------
// Diagnostic Log Features (what our instrumentation emits)
// ---------------------------------------------------------------------------

/** Features logged by our instrumentation, queryable in BetterStack */
export const DIAGNOSTIC_FEATURES = [
  "gc-probe",
  "gc-after-disconnect",
  "event-loop-gap",
  "system-vitals",
  "slow-query",
  "app-cache",
  "health-timing",
  "soniox-timing",
  "event-loop-lag",
] as const;

export type DiagnosticFeature = (typeof DIAGNOSTIC_FEATURES)[number];

// ---------------------------------------------------------------------------
// Key Collector Metrics (for dashboard queries)
// ---------------------------------------------------------------------------

/** Container-level metrics from BetterStack collectors */
export const COLLECTOR_METRICS = {
  /** Container RSS memory in bytes — THE crash signal */
  memoryRss: "container_resources_memory_rss_bytes",
  /** Container memory limit */
  memoryLimit: "container_resources_memory_limit_bytes",
  /** Container CPU usage (use avgMerge(rate_avg)) */
  cpuUsage: "container_resources_cpu_usage_seconds_total",
  /** CPU throttling */
  cpuThrottled: "container_resources_cpu_throttled_seconds_total",
  /** Container restart count (NOT deploys — only involuntary restarts) */
  restarts: "container_restarts_total",
  /** OOM kills */
  oomKills: "container_oom_kills_total",
  /** HTTP request count */
  httpRequests: "container_http_requests_total",
  /** TCP active connections */
  tcpConnections: "container_net_tcp_active_connections",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the logs table for a given environment.
 * Defaults to prod. Pass "dev" or "debug" for the dev source.
 */
export function getLogsTable(env: "prod" | "dev" = "prod"): string {
  return env === "prod" ? LOG_SOURCES.prod.logsTable : LOG_SOURCES.dev.logsTable;
}

/**
 * Get the collector metrics table for a given region.
 * Returns undefined if the region doesn't have a collector.
 */
export function getCollectorTable(region: string): string | undefined {
  return COLLECTORS[region]?.metricsTable;
}

/**
 * Get the health URL for a region.
 */
export function getHealthUrl(region: string): string | undefined {
  return REGIONS[region]?.healthUrl;
}

/**
 * All region names.
 */
export function getAllRegions(): string[] {
  return Object.keys(REGIONS);
}

/**
 * Validate that SQL credentials are configured.
 */
export function validateSqlCredentials(): void {
  if (!SQL_USERNAME || !SQL_PASSWORD) {
    console.error("❌ BetterStack SQL credentials not set.");
    console.error(
      "   Set BETTERSTACK_SQL_USERNAME and BETTERSTACK_SQL_PASSWORD (or BETTERSTACK_USERNAME / BETTERSTACK_PASSWORD).",
    );
    console.error(
      "   These are the ClickHouse HTTP API credentials from BetterStack Integrations → Connect ClickHouse HTTP client.",
    );
    process.exit(1);
  }
}

/**
 * Validate that the management API token is configured.
 */
export function validateApiToken(): void {
  if (!API_TOKEN) {
    throw new Error(
      "BETTERSTACK_API_TOKEN not set. This is the management API token from BetterStack → Integrations → API.",
    );
  }
}
