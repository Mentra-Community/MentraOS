/** Public, build-time configuration. build.ts injects the values. */
export interface AccountConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface RawAccountConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function createAccountConfig(raw: RawAccountConfig): AccountConfig {
  return {
    supabaseUrl: normalizeSupabaseUrl(raw.supabaseUrl),
    supabaseAnonKey: (raw.supabaseAnonKey ?? "").trim(),
  };
}

/**
 * Reads the values build.ts substitutes with `define`. Each `process.env.X`
 * below is replaced by a string literal in the browser bundle.
 */
export function readBuildConfig(): AccountConfig {
  return createAccountConfig({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}

export function isConfigured(config: AccountConfig): boolean {
  return config.supabaseUrl !== "" && config.supabaseAnonKey !== "";
}

function normalizeSupabaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return trimmed.replace(/\/+$/, "");
  } catch {
    return "";
  }
}
