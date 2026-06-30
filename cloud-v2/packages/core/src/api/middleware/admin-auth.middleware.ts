import { createMiddleware } from "hono/factory";
import { authenticateConsoleSession } from "../console/cli-auth.api";
import type { AppEnv } from "../../types/hono.types";

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await authenticateConsoleSession(c);
  if (!auth.authenticated) {
    return c.json({ error: "unauthorized", error_description: "Mentra login required" }, 401);
  }

  if (!isAdminEmail(auth.user.email)) {
    return c.json({ error: "forbidden", error_description: "admin access required" }, 403);
  }

  c.set("isAdmin", true);
  c.set("developer", {
    developerId: auth.user.id,
    email: auth.user.email,
  });
  return next();
});

function isAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const emails = parseList(process.env.CLOUD_CORE_ADMIN_EMAILS).map(value => value.toLowerCase());
  if (emails.includes(normalized)) return true;

  const configuredDomains = parseList(process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS);
  const domains = configuredDomains.length > 0 ? configuredDomains : ["mentraglass.com"];
  return domains
    .map(domain => domain.toLowerCase().replace(/^@/, ""))
    .some(domain => normalized.endsWith(`@${domain}`));
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}
