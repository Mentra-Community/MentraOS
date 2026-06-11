/**
 * Health and readiness endpoint factory.
 *
 * `/healthz` — liveness. Returns 200 if the event loop is responsive
 *   (which it is by definition if we're answering). K8s liveness probe
 *   uses this; a failure triggers pod restart.
 *
 * `/ready` — readiness. Returns 200 only if every configured readiness
 *   check passes. Otherwise 503 with the failing checks listed in the
 *   response body. K8s readiness probe uses this; a failure removes the
 *   pod from the Service's load balancer rotation but does NOT restart
 *   it. Useful for transient dependency outages (Mongo briefly down,
 *   etc.) where restarting wouldn't help.
 *
 * Each package wires its own readiness checks (Redis ping, Mongo ping,
 * worker pool alive, etc.).
 */

import { Hono } from "hono";

export type ReadinessCheck = {
  name: string;
  /** Return true if healthy. Throw or return false to fail. */
  check: () => Promise<boolean> | boolean;
};

export type HealthAppOptions = {
  /** Which cloud-v2 package this is. Echoed in responses for debugging. */
  packageName: string;
  /** Optional readiness checks evaluated on every /ready hit. */
  readinessChecks?: ReadinessCheck[];
};

type CheckResult = {
  name: string;
  ok: boolean;
  error?: string;
};

export function createHealthApp(opts: HealthAppOptions): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({ status: "ok", package: opts.packageName }),
  );

  app.get("/ready", async (c) => {
    const checks = opts.readinessChecks ?? [];
    const results: CheckResult[] = [];

    for (const rc of checks) {
      try {
        const ok = await rc.check();
        results.push({ name: rc.name, ok });
      } catch (err) {
        console.error("readiness check failed", {
          packageName: opts.packageName,
          check: rc.name,
          err,
        });
        results.push({
          name: rc.name,
          ok: false,
          error: "readiness check failed",
        });
      }
    }

    const allOk = results.every((r) => r.ok);
    return c.json(
      {
        status: allOk ? "ok" : "not_ready",
        package: opts.packageName,
        checks: results,
      },
      allOk ? 200 : 503,
    );
  });

  return app;
}
