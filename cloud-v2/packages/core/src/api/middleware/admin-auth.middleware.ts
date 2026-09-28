import { createMiddleware } from "hono/factory";
import { authenticateConsoleSession } from "../console/cli-auth.api";
import { isAdminEmail } from "../../services/admin-email-policy";
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
