export interface CliConfig {
  coreUrl: string;
  consoleUrl: string;
  workosClientId: string;
  workosApiBaseUrl: string;
}

export function getConfig(): CliConfig {
  const workosClientId = process.env.MENTRA_WORKOS_CLIENT_ID || process.env.WORKOS_CLIENT_ID || "";
  return {
    coreUrl: normalizeUrl(process.env.MENTRA_CORE_URL || "https://core.mentraglass.com"),
    consoleUrl: normalizeUrl(process.env.MENTRA_CONSOLE_URL || "https://console2.mentraglass.com"),
    workosClientId,
    workosApiBaseUrl: normalizeUrl(process.env.WORKOS_API_BASE_URL || "https://api.workos.com"),
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
