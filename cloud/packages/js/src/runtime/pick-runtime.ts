/**
 * pick-runtime — automatic runtime detection
 *
 * No env vars. No mode flags. Just:
 *   "what can actually run right now, and what does the developer want?"
 *
 * Precedence (highest → lowest):
 *   1. `mentra.config.ts` → `runtime: "cloud" | "sim"` (explicit override)
 *   2. `MENTRAOS_API_KEY` is set → cloud
 *   3. default → sim (simulated glasses, in-process, zero cloud)
 *
 * The `runtime: "auto"` value is the same as omitting the field — it
 * means "let the framework pick." We never silently fall back from
 * cloud → sim; if the developer said `runtime: "cloud"` and there's
 * no API key, we error loudly rather than boot a different mode than
 * they asked for.
 *
 * This file stays pure — no side effects, no global mutation. `dev.ts`
 * handles the install into `globalThis.__mentraRuntime`.
 */

import type { MentraRuntime } from "./contract";
import { CloudAdapter } from "./adapters/cloud-adapter";
import { SimAdapter } from "./adapters/sim-adapter";

export type RuntimePreference = "auto" | "cloud" | "sim";

export interface PickedRuntime {
  /** The constructed adapter — already usable, but cloud needs `.bind(session)` and sim needs `.start()`. */
  runtime: MentraRuntime;
  /** Why this adapter was picked. Single short line, surfaced on `mentra dev` boot. */
  reason: string;
  /** Whether we also need to boot a MiniAppServer. True only for cloud. */
  needsMiniAppServer: boolean;
}

export interface PickRuntimeOptions {
  /** Explicit preference from `mentra.config.ts`. Defaults to `"auto"`. */
  preference?: RuntimePreference;
  /** Whether a MentraOS API key is present in the environment. */
  hasApiKey: boolean;
}

export async function pickRuntime(opts: PickRuntimeOptions): Promise<PickedRuntime> {
  const pref: RuntimePreference = opts.preference ?? "auto";

  // Explicit cloud request. Never silently downgrade.
  if (pref === "cloud") {
    if (!opts.hasApiKey) {
      throw new Error(
        [
          '[mentra/js] runtime: "cloud" requires MENTRAOS_API_KEY.',
          "",
          "Either set MENTRAOS_API_KEY in your environment / .env file,",
          'or change `runtime` in mentra.config.ts to "auto" or "sim".',
        ].join("\n"),
      );
    }
    return {
      runtime: new CloudAdapter(),
      reason: "explicit (mentra.config.ts: runtime: 'cloud')",
      needsMiniAppServer: true,
    };
  }

  // Explicit sim request.
  if (pref === "sim") {
    const sim = await buildSimAdapter();
    return {
      runtime: sim,
      reason: "explicit (mentra.config.ts: runtime: 'sim')",
      needsMiniAppServer: false,
    };
  }

  // Auto. API key present → cloud. Otherwise → sim.
  if (opts.hasApiKey) {
    return {
      runtime: new CloudAdapter(),
      reason: "auto (MENTRAOS_API_KEY detected)",
      needsMiniAppServer: true,
    };
  }

  const sim = await buildSimAdapter();
  return {
    runtime: sim,
    reason: "auto (no API key → simulated glasses)",
    needsMiniAppServer: false,
  };
}

/**
 * Build the sim adapter lazily so a cloud-mode project that doesn't
 * have `@mentra/client` / `@mentra/simulated-glasses` installed
 * doesn't fail at import time. Only projects that actually want the
 * sim adapter pay the import cost.
 */
async function buildSimAdapter(): Promise<SimAdapter> {
  let MentraClient: any, SimulatedGlasses: any;
  try {
    ({ MentraClient } = await import("@mentra/client"));
    ({ SimulatedGlasses } = await import("@mentra/simulated-glasses"));
  } catch (err) {
    throw new Error(
      [
        "[mentra/js] Can't start the simulated-glasses runtime.",
        "",
        "Install the required peer dependencies:",
        "  bun add @mentra/client @mentra/simulated-glasses",
        "",
        "Or set MENTRAOS_API_KEY in your environment to use the cloud runtime.",
        "",
        `Underlying error: ${(err as Error).message}`,
      ].join("\n"),
    );
  }

  const client = new MentraClient();
  const glasses = SimulatedGlasses.G1();
  const adapter = new SimAdapter({
    client,
    glasses,
    userId: "local-user",
  });
  adapter.start();
  return adapter;
}
